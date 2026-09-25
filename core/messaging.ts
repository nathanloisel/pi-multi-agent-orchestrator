/**
 * core/messaging.ts — live main<->worker messaging protocol (phase 1).
 *
 * Shared, dependency-free wire protocol for worker communication tools
 * (worker.ts) and the parent-side RPC transport (core/spawn.ts). No tmux, no
 * IPC sockets, no mailboxes: everything rides on pi's native RPC extension-UI
 * subprotocol.
 *
 * Transport mapping (pi RPC mode, docs/rpc.md "Extension UI Protocol"):
 *   - one-way worker message  -> ctx.ui.notify(message)  -> stdout
 *       `extension_ui_request {method:"notify", message}` (fire-and-forget)
 *   - worker request          -> ctx.ui.input(title)     -> stdout
 *       `extension_ui_request {method:"input", title}`   (dialog, blocks the
 *       worker until the parent sends `extension_ui_response {id, value}` or
 *       `{id, cancelled:true}`; the native RPC request id provides
 *       correlation and is bound to the active attempt parent-side)
 *
 * Envelopes are `<MESSAGING_PREFIX><JSON>` where the JSON is a versioned,
 * validated object. Decoding NEVER interprets or executes embedded text: it
 * only validates shape and bounds, so a hostile or buggy worker can never make
 * the parent run anything.
 *
 * Bounds (bytes, UTF-8):
 *   - single text/question/answer field: 16 KiB (MESSAGING_TEXT_MAX_BYTES)
 *   - whole envelope: 64 KiB (MESSAGING_ENVELOPE_MAX_BYTES)
 */

/** Versioned prefix marking orchestrator messaging envelopes. */
export const MESSAGING_PREFIX = "PI-ORCH-MSG:v1:";
/** Envelope protocol version carried in every envelope. */
export const MESSAGING_PROTOCOL_VERSION = 1;

/** Names of the worker communication tools (always allowed for workers). */
export const MESSAGING_TOOL_NAMES = ["message_main", "ask_main", "ask_user_question"] as const;
export type MessagingToolName = (typeof MESSAGING_TOOL_NAMES)[number];

/** Maximum size of a single text/question/answer field, in UTF-8 bytes. */
export const MESSAGING_TEXT_MAX_BYTES = 16 * 1024;
/** Maximum size of a whole encoded envelope, in UTF-8 bytes. */
export const MESSAGING_ENVELOPE_MAX_BYTES = 64 * 1024;
/** Maximum size of an option label / description, in UTF-8 bytes. */
export const MESSAGING_LABEL_MAX_BYTES = 256;
export const MESSAGING_DESCRIPTION_MAX_BYTES = 2048;

/** ask_user_question option count bounds (options are optional; if present: 2..8). */
export const MESSAGING_OPTIONS_MIN = 2;
export const MESSAGING_OPTIONS_MAX = 8;

/** Request timeout defaults and bounds (seconds). */
export const REQUEST_TIMEOUT_DEFAULT_SECONDS = 300;
export const REQUEST_TIMEOUT_MIN_SECONDS = 1;
export const REQUEST_TIMEOUT_MAX_SECONDS = 900;

// ── Types ────────────────────────────────────────────────────────────────────

/** One-way worker -> main message (no answer expected). */
export interface WorkerMessage {
	kind: "message";
	/** Free-form text for the main agent (never interpreted as a command). */
	text: string;
}

export type WorkerRequestKind = "ask_main" | "ask_user_question";

/** A named option for ask_user_question. */
export interface WorkerQuestionOption {
	label: string;
	description?: string;
}

/** Worker -> main blocking request (ask_main or ask_user_question). */
export interface WorkerRequest {
	kind: WorkerRequestKind;
	/** The single question to ask. */
	question: string;
	/** ask_user_question only: 2..8 named options; absent means free text. */
	options?: WorkerQuestionOption[];
	/** ask_user_question only: whether free-text answers are accepted (default true). */
	allowCustom?: boolean;
	/** How long the worker waits, in seconds (default 300, bounded 1..900). */
	timeoutSeconds?: number;
}

/** Discriminated main -> worker reply for a WorkerRequest. */
export type WorkerReply =
	| { status: "answered"; answer: string }
	| { status: "cancelled" }
	| { status: "timeout" }
	| { status: "unavailable"; reason: string }
	| { status: "error"; reason: string };

export type WorkerReplyStatus = WorkerReply["status"];

// ── Validation helpers ───────────────────────────────────────────────────────

function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf-8");
}

/** Validate a non-empty bounded string field. Throws on violation. */
function boundedString(value: unknown, maxBytes: number, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	if (!value.trim()) throw new Error(`${field} must not be blank (whitespace-only text is rejected)`);
	if (byteLength(value) > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes`);
	return value;
}

/** Validate timeoutSeconds: integer within bounds (undefined allowed). */
function validTimeoutSeconds(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < REQUEST_TIMEOUT_MIN_SECONDS || value > REQUEST_TIMEOUT_MAX_SECONDS) {
		throw new Error(`${field} must be an integer between ${REQUEST_TIMEOUT_MIN_SECONDS} and ${REQUEST_TIMEOUT_MAX_SECONDS}`);
	}
	return value;
}

/** Validate a WorkerQuestionOption. */
function validOption(value: unknown, field: string): WorkerQuestionOption {
	if (!value || typeof value !== "object") throw new Error(`${field} must be an object`);
	const option = value as { label?: unknown; description?: unknown };
	const label = boundedString(option.label, MESSAGING_LABEL_MAX_BYTES, `${field}.label`);
	if (option.description !== undefined) {
		const description = boundedString(option.description, MESSAGING_DESCRIPTION_MAX_BYTES, `${field}.description`);
		return { label, description };
	}
	return { label };
}

/** Validate a full WorkerRequest. Throws on any violation. */
function validateRequest(request: WorkerRequest): void {
	boundedString(request.question, MESSAGING_TEXT_MAX_BYTES, "question");
	validTimeoutSeconds(request.timeoutSeconds, "timeoutSeconds");
	if (request.kind === "ask_main") {
		if (request.options !== undefined) throw new Error('ask_main requests must not carry "options"');
		if (request.allowCustom !== undefined) throw new Error('ask_main requests must not carry "allowCustom"');
		return;
	}
	if (request.kind !== "ask_user_question") throw new Error(`unknown request kind: ${String(request.kind)}`);
	if (request.options !== undefined) {
		if (!Array.isArray(request.options)) throw new Error('"options" must be an array');
		if (request.options.length < MESSAGING_OPTIONS_MIN || request.options.length > MESSAGING_OPTIONS_MAX) {
			throw new Error(`"options" must contain ${MESSAGING_OPTIONS_MIN}..${MESSAGING_OPTIONS_MAX} entries when present`);
		}
		request.options.forEach((option, i) => validOption(option, `options[${i}]`));
	}
	if (request.allowCustom !== undefined && typeof request.allowCustom !== "boolean") {
		throw new Error('"allowCustom" must be a boolean');
	}
}

/** Validate a full WorkerReply. Throws on any violation. */
function validateReply(reply: WorkerReply): void {
	switch (reply.status) {
		case "answered":
			boundedString(reply.answer, MESSAGING_TEXT_MAX_BYTES, "answer");
			return;
		case "cancelled":
		case "timeout":
			return;
		case "unavailable":
		case "error":
			boundedString(reply.reason, MESSAGING_DESCRIPTION_MAX_BYTES, "reason");
			return;
		default:
			throw new Error(`unknown reply status: ${String((reply as { status?: unknown }).status)}`);
	}
}

/** Bound-check a fully encoded envelope (prefix included). */
function assertEnvelopeBound(envelope: string): void {
	if (byteLength(envelope) > MESSAGING_ENVELOPE_MAX_BYTES) {
		throw new Error(`messaging envelope exceeds ${MESSAGING_ENVELOPE_MAX_BYTES} bytes`);
	}
}

// ── Encoding (worker side; throws on invalid input) ─────────────────────────

/** Encode a one-way worker message into a notify payload. */
export function encodeMessageEnvelope(text: string): string {
	boundedString(text, MESSAGING_TEXT_MAX_BYTES, "message");
	const envelope = `${MESSAGING_PREFIX}${JSON.stringify({ v: MESSAGING_PROTOCOL_VERSION, kind: "message", text })}`;
	assertEnvelopeBound(envelope);
	return envelope;
}

/** Encode a blocking worker request into a ctx.ui.input title. */
export function encodeRequestEnvelope(request: WorkerRequest): string {
	validateRequest(request);
	const envelope: Record<string, unknown> = {
		v: MESSAGING_PROTOCOL_VERSION,
		kind: request.kind,
		question: request.question,
	};
	if (request.timeoutSeconds !== undefined) envelope.timeoutSeconds = request.timeoutSeconds;
	if (request.kind === "ask_user_question") {
		if (request.options !== undefined) envelope.options = request.options;
		if (request.allowCustom !== undefined) envelope.allowCustom = request.allowCustom;
	}
	const encoded = `${MESSAGING_PREFIX}${JSON.stringify(envelope)}`;
	assertEnvelopeBound(encoded);
	return encoded;
}

/** Encode a reply into the `value` of an extension_ui_response. */
export function encodeReplyValue(reply: WorkerReply): string {
	validateReply(reply);
	const encoded = JSON.stringify(reply);
	if (byteLength(encoded) > MESSAGING_ENVELOPE_MAX_BYTES) throw new Error("messaging reply exceeds envelope bound");
	return encoded;
}

// ── Decoding (parent/worker side; never throws on wire input) ───────────────

/** True when a payload string carries our versioned messaging prefix. */
export function isMessagingEnvelope(payload: unknown): payload is string {
	return typeof payload === "string" && payload.startsWith(MESSAGING_PREFIX);
}

/** Parse the JSON body after the prefix; undefined on any malformation. */
function parseEnvelopeBody(payload: string): Record<string, unknown> | undefined {
	if (byteLength(payload) > MESSAGING_ENVELOPE_MAX_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload.slice(MESSAGING_PREFIX.length));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	return parsed as Record<string, unknown>;
}

/**
 * Decode a one-way message envelope (notify payload).
 * Returns undefined unless the payload is a valid, bounded WorkerMessage.
 * Malformed envelopes are dropped, never executed.
 */
export function decodeMessageEnvelope(payload: string): WorkerMessage | undefined {
	if (!isMessagingEnvelope(payload)) return undefined;
	const body = parseEnvelopeBody(payload);
	if (!body) return undefined;
	if (body.v !== MESSAGING_PROTOCOL_VERSION || body.kind !== "message") return undefined;
	try {
		const text = boundedString(body.text, MESSAGING_TEXT_MAX_BYTES, "text");
		return { kind: "message", text };
	} catch {
		return undefined;
	}
}

export type DecodedRequest = { ok: true; request: WorkerRequest } | { ok: false; error: string };

/**
 * Decode a request envelope (ctx.ui.input title). Never throws: an envelope
 * that carries our prefix but fails validation decodes to an error so the
 * parent can answer the dialog explicitly instead of leaving the worker
 * hanging until its own timeout.
 */
export function decodeRequestEnvelope(title: string): DecodedRequest {
	if (!isMessagingEnvelope(title)) return { ok: false, error: "not a messaging envelope" };
	const body = parseEnvelopeBody(title);
	if (!body) return { ok: false, error: "malformed messaging envelope" };
	if (body.v !== MESSAGING_PROTOCOL_VERSION) return { ok: false, error: `unsupported envelope version: ${String(body.v)}` };
	if (body.kind !== "ask_main" && body.kind !== "ask_user_question") {
		return { ok: false, error: `unknown request kind: ${String(body.kind)}` };
	}
	const request: WorkerRequest = { kind: body.kind, question: "" };
	try {
		request.question = boundedString(body.question, MESSAGING_TEXT_MAX_BYTES, "question");
		request.timeoutSeconds = validTimeoutSeconds(body.timeoutSeconds, "timeoutSeconds");
		if (body.kind === "ask_user_question") {
			if (body.options !== undefined) {
				if (!Array.isArray(body.options)) throw new Error('"options" must be an array');
				if (body.options.length < MESSAGING_OPTIONS_MIN || body.options.length > MESSAGING_OPTIONS_MAX) {
					throw new Error(`"options" must contain ${MESSAGING_OPTIONS_MIN}..${MESSAGING_OPTIONS_MAX} entries when present`);
				}
				request.options = body.options.map((option, i) => validOption(option, `options[${i}]`));
			}
			if (body.allowCustom !== undefined) {
				if (typeof body.allowCustom !== "boolean") throw new Error('"allowCustom" must be a boolean');
				request.allowCustom = body.allowCustom;
			}
		} else if (body.options !== undefined || body.allowCustom !== undefined) {
			throw new Error('ask_main requests must not carry "options" or "allowCustom"');
		}
		// Re-validate the assembled request through the strict encoder contract.
		validateRequest(request);
		return { ok: true, request };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Decode a reply `value` from an extension_ui_response. Never throws: any
 * malformed, unknown, or out-of-bounds value decodes to an explicit error
 * reply so the worker never fabricates an answer.
 */
export function decodeReplyValue(value: string): WorkerReply {
	try {
		if (typeof value !== "string" || value.length === 0) throw new Error("empty reply value");
		if (byteLength(value) > MESSAGING_ENVELOPE_MAX_BYTES) throw new Error("reply exceeds envelope bound");
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("reply is not an object");
		const reply = parsed as WorkerReply;
		validateReply(reply);
		return reply;
	} catch (err) {
		return { status: "error", reason: `invalid reply from orchestrator: ${err instanceof Error ? err.message : String(err)}` };
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Clamp a caller-supplied timeout (seconds) into the protocol bounds. */
export function clampRequestTimeoutSeconds(seconds: number | undefined): number {
	if (seconds === undefined || !Number.isFinite(seconds)) return REQUEST_TIMEOUT_DEFAULT_SECONDS;
	return Math.min(REQUEST_TIMEOUT_MAX_SECONDS, Math.max(REQUEST_TIMEOUT_MIN_SECONDS, Math.round(seconds)));
}

/** Render a reply as the tool result text the worker LLM sees. */
export function formatReplyForModel(reply: WorkerReply): string {
	switch (reply.status) {
		case "answered":
			return `answered: ${reply.answer}`;
		case "cancelled":
			return "cancelled: the request was dismissed without an answer";
		case "timeout":
			return "timeout: no answer arrived in time";
		case "unavailable":
			return `unavailable: ${reply.reason}`;
		case "error":
			return `error: ${reply.reason}`;
	}
}
