/**
 * Orchestrator worker hooks — loaded INSIDE each sub agent process
 * (via `pi -e worker.ts`). Never loads into the main process.
 *
 * Responsibilities:
 *  1. Enforce the sub agent's dedicated tool policy (from AGENT.md `tools:`),
 *     as a hard block on top of the `--tools` allowlist.
 *  2. Prevent recursion: a sub agent can never call delegate/jobs.
 *  3. Apply the agent's dedicated tool allowlist passed via env.
 *  4. Register the live-messaging tools (message_main / ask_main /
 *     ask_user_question) that talk to the orchestrator main agent over pi's
 *     RPC extension-UI subprotocol (see core/messaging.ts). These are ALWAYS
 *     available to workers — they are unioned into `--tools`, activated at
 *     session_start, and allowed by the tool_call guard — while the role's
 *     ordinary tool allowlist keeps restricting every other tool.
 *
 * Report-contract enforcement (missing ```report block) is handled by the
 * runner in the main process via one deterministic follow-up nudge.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	MESSAGING_TOOL_NAMES,
	clampRequestTimeoutSeconds,
	decodeReplyValue,
	encodeMessageEnvelope,
	encodeRequestEnvelope,
	formatReplyForModel,
	type WorkerReply,
	type WorkerRequest,
} from "./core/messaging.ts";

const ORCHESTRATOR_TOOLS = new Set(["delegate", "jobs", "subagent"]);
/** Messaging tools are always allowed for workers, regardless of the role allowlist. */
const MESSAGING_TOOLS = new Set<string>(MESSAGING_TOOL_NAMES);

const OUTSIDE_RPC_REASON =
	"live messaging is only available to orchestrator workers spawned in RPC mode by the orchestrator main agent; there is no transport to answer here";

function toolText(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * Run one blocking request over the RPC extension-UI dialog subprotocol.
 * Distinguishes timeout from cancellation with our own timer + AbortSignal
 * (pi resolves a dismissed/aborted dialog to undefined either way).
 */
async function performAsk(ctx: ExtensionContext, request: WorkerRequest, toolSignal: AbortSignal | undefined): Promise<WorkerReply> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, (request.timeoutSeconds ?? 300) * 1000);
	const onToolAbort = () => controller.abort();
	toolSignal?.addEventListener("abort", onToolAbort, { once: true });
	try {
		// The encoded title is the request envelope; the native RPC request id
		// correlates the dialog, and the reply arrives as the response value.
		const value = await ctx.ui.input(encodeRequestEnvelope(request), undefined, { signal: controller.signal });
		if (value === undefined) return timedOut ? { status: "timeout" } : { status: "cancelled" };
		return decodeReplyValue(value);
	} finally {
		clearTimeout(timer);
		toolSignal?.removeEventListener("abort", onToolAbort);
	}
}

export default function (pi: ExtensionAPI) {
	if (!process.env.PI_ORCHESTRATOR_SUBAGENT) return; // main process: do nothing

	const allowed = (process.env.PI_ORCHESTRATOR_ALLOWED_TOOLS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const allowSet = new Set(allowed);

	pi.on("session_start", async (_event, ctx) => {
		// Union the messaging tools into the active set: the role allowlist
		// still governs every other tool.
		const active = pi.getActiveTools().filter(
			(name) => !ORCHESTRATOR_TOOLS.has(name) && (allowSet.size === 0 || allowSet.has(name) || MESSAGING_TOOLS.has(name)),
		);
		pi.setActiveTools(active);
		ctx.ui.setStatus?.("orchestrator-worker", `job:${process.env.PI_ORCHESTRATOR_JOB_ID ?? "?"}`);
	});

	pi.on("tool_call", async (event) => {
		if (ORCHESTRATOR_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Recursion blocked: sub agents cannot delegate. Complete the task yourself and report back via the report contract.",
			};
		}
		if (MESSAGING_TOOLS.has(event.toolName)) return; // always allowed for workers
		if (allowSet.size > 0 && !allowSet.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool "${event.toolName}" is not allowed for this agent. Allowed tools: ${[...allowSet].join(", ")}.`,
			};
		}
	});

	// ── Live messaging tools ─────────────────────────────────────────────────

	pi.registerTool({
		name: "message_main",
		label: "Message main",
		description:
			"Send a one-way message (progress notes, findings, decisions) to the orchestrator main agent. No answer comes back. Use this for status the main agent should see while you keep working; do NOT use it for questions.",
		promptSnippet: "Send a one-way progress note or finding to the orchestrator main agent",
		promptGuidelines: [
			"Use message_main to report progress, findings, or decisions to the orchestrator main agent while continuing to work; it never returns an answer.",
		],
		parameters: Type.Object({
			message: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "rpc") return toolText(formatReplyForModel({ status: "unavailable", reason: OUTSIDE_RPC_REASON }));
			ctx.ui.notify(encodeMessageEnvelope(params.message), "info");
			return toolText("delivered: message sent to the orchestrator main agent (no answer is expected)");
		},
	});

	pi.registerTool({
		name: "ask_main",
		label: "Ask main",
		description:
			"Ask the orchestrator main agent ONE blocking question and wait for its answer. Invoke ONLY when you are genuinely blocked and cannot make progress without an answer; for anything else use message_main. Returns the answer, or an explicit cancelled/timeout/unavailable/error result — never a fabricated answer.",
		promptSnippet: "Ask the orchestrator main agent a single blocking question (blockers only)",
		promptGuidelines: [
			"Use ask_main only when blocked and unable to proceed; it pauses your work until the orchestrator main agent answers.",
		],
		parameters: Type.Object({
			question: Type.String(),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "rpc") return toolText(formatReplyForModel({ status: "unavailable", reason: OUTSIDE_RPC_REASON }));
			const request: WorkerRequest = {
				kind: "ask_main",
				question: params.question,
				timeoutSeconds: clampRequestTimeoutSeconds(params.timeoutSeconds),
			};
			const reply = await performAsk(ctx, request, signal);
			return toolText(formatReplyForModel(reply));
		},
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "Ask user question",
		description:
			"Route ONE question to the human user via the orchestrator. Provide 2-8 named options (each with an optional description) or omit options for free text; allowCustom (default true) controls whether free-text answers are accepted on top of the options. Returns the user's answer, or an explicit cancelled/timeout/unavailable/error result — never a fabricated answer.",
		promptSnippet: "Route a single question to the human user through the orchestrator",
		promptGuidelines: [
			"Use ask_user_question when only the human user can decide something; include 2-8 named options with clear labels.",
		],
		parameters: Type.Object({
			question: Type.String(),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String(),
						description: Type.Optional(Type.String()),
					}),
				),
			),
			allowCustom: Type.Optional(Type.Boolean()),
			timeoutSeconds: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "rpc") return toolText(formatReplyForModel({ status: "unavailable", reason: OUTSIDE_RPC_REASON }));
			if (params.options !== undefined && (params.options.length < 2 || params.options.length > 8)) {
				throw new Error(`options must contain 2..8 entries when present (got ${params.options.length}); omit options for free text`);
			}
			const request: WorkerRequest = {
				kind: "ask_user_question",
				question: params.question,
				...(params.options !== undefined ? { options: params.options } : {}),
				allowCustom: params.allowCustom ?? true,
				timeoutSeconds: clampRequestTimeoutSeconds(params.timeoutSeconds),
			};
			const reply = await performAsk(ctx, request, signal);
			return toolText(formatReplyForModel(reply));
		},
	});
}
