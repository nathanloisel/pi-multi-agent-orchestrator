/**
 * core/broker.ts — parent-side live agent messaging broker (phase 2).
 *
 * Owns everything the orchestrator main agent needs to exchange live messages
 * with running workers (phase 1 transport in core/spawn.ts + core/messaging.ts):
 *
 *   - live worker controls, keyed by jobId+attemptId (steering = jobs message)
 *   - pending worker requests, keyed by jobId+attemptId+rpc.id, validated for
 *     source ownership and settled EXACTLY ONCE (late/duplicate answers are
 *     discarded, never revived)
 *   - a bounded per-job inbox (latest INBOX_MAX_PER_JOB items) recording both
 *     worker→main messages and main→worker steers, plus full request lifecycle
 *   - attention subscription/consumption: only NEW unconsumed attention yields
 *     a blocking delegate/jobs.wait call, so handled history never spins
 *   - per-request deadlines (default from the envelope, 1..900s): the parent
 *     aborts the pending UI/answer at the deadline and settles "timeout"
 *   - a human-question seam for ask_user_question (core never imports the TUI;
 *     the extension registers the UI handler)
 *
 * Persistence model: messages and request lifecycle are durable events in the
 * existing EventLog. Pending promises, timers, and control handles are
 * in-memory ONLY — a request from an old process/restart is stale forever and
 * any late reply to it is rejected as unknown/expired.
 */

import { OrchestratorError } from "./errors.ts";
import type { EventLog } from "./events.ts";
import {
	MESSAGING_TEXT_MAX_BYTES,
	clampRequestTimeoutSeconds,
	type WorkerMessage,
	type WorkerReply,
	type WorkerRequest,
	type WorkerRequestKind,
} from "./messaging.ts";
import type { WorkerControl } from "./spawn.ts";

/** Bounded inbox history per job (latest items kept). */
export const INBOX_MAX_PER_JOB = 100;
/** Hard byte bound for any inbox text (matches the wire protocol). */
export const INBOX_TEXT_MAX_BYTES = MESSAGING_TEXT_MAX_BYTES;

export type RequestItemStatus = "pending" | "answered" | "cancelled" | "timeout" | "unavailable" | "error";

/** A one-way message in a job's inbox (worker→main or main→worker steer). */
export interface InboxMessage {
	type: "message";
	/** Unique inbox item id (attention dedupe key). */
	id: string;
	direction: "worker" | "main";
	jobId: string;
	attemptId: string;
	text: string;
	createdAt: number;
	/** main→worker only: set once the steer was ACKed by the worker. */
	delivered?: boolean;
	consumed: boolean;
}

/** A worker request and its lifecycle in a job's inbox. */
export interface InboxRequest {
	type: "request";
	id: string;
	jobId: string;
	attemptId: string;
	/** The native RPC dialog id — the correlation key for jobs reply. */
	requestId: string;
	agent: string;
	kind: WorkerRequestKind;
	question: string;
	options?: WorkerRequest["options"];
	allowCustom?: boolean;
	timeoutSeconds: number;
	status: RequestItemStatus;
	answer?: string;
	createdAt: number;
	resolvedAt?: number;
	consumed: boolean;
}

export type InboxItem = InboxMessage | InboxRequest;

/** A new unconsumed attention item (worker message or blocking ask_main). */
export interface AttentionItem {
	id: string;
	jobId: string;
	kind: "message" | "request";
	message?: InboxMessage;
	request?: InboxRequest;
}

/** An ask_user_question routed to the human-question seam (UI owned outside core). */
export interface RoutedQuestion {
	jobId: string;
	attemptId: string;
	requestId: string;
	agent: string;
	request: WorkerRequest;
}

/** Seam contract: resolves the user's decision for one routed question. */
export type HumanQuestionHandler = (routed: RoutedQuestion, rpc: { id: string; signal: AbortSignal }) => Promise<WorkerReply>;

function boundedInboxText(text: string, field: string): string {
	const value = (text ?? "").trim();
	if (!value) throw new OrchestratorError("unknown", `${field} must be a non-empty string`);
	if (Buffer.byteLength(value, "utf-8") > INBOX_TEXT_MAX_BYTES) {
		throw new OrchestratorError("unknown", `${field} exceeds ${INBOX_TEXT_MAX_BYTES} bytes`);
	}
	return value;
}

function replyStatus(reply: WorkerReply): RequestItemStatus {
	return reply.status === "answered" ? "answered" : reply.status === "cancelled" ? "cancelled" : reply.status === "timeout" ? "timeout" : reply.status === "unavailable" ? "unavailable" : "error";
}

interface LiveChild {
	jobId: string;
	attemptId: string;
	control: WorkerControl;
	since: number;
}

interface PendingRequest {
	key: string;
	item: InboxRequest;
	childSignal: AbortSignal;
	/** Combined child-exit + parent-deadline signal handed to the UI seam. */
	ui: AbortController;
	timer: ReturnType<typeof setTimeout> | undefined;
	onChildAbort: () => void;
	settled: boolean;
	resolve: (reply: WorkerReply) => void;
	promise: Promise<WorkerReply>;
}

export class MessageBroker {
	private controls = new Map<string, LiveChild>(); // `${jobId}\u0000${attemptId}`
	private requests = new Map<string, PendingRequest>(); // `${jobId}\u0000${attemptId}\u0000${requestId}`
	private inbox = new Map<string, InboxItem[]>();
	private attentionListeners = new Set<(attention: AttentionItem) => void>();
	private humanHandler: HumanQuestionHandler | undefined;
	private seq = 0;
	private disposed = false;

	constructor(private readonly events: EventLog) {}

	// ── Live worker controls ────────────────────────────────────────────────

	/** Register the control handle for a freshly spawned worker (attempt). */
	attachChild(jobId: string, attemptId: string, control: WorkerControl): void {
		this.controls.set(`${jobId}\u0000${attemptId}`, { jobId, attemptId, control, since: Date.now() });
	}

	/** Remove the control handle (worker exited); pending requests are settled cancelled. */
	detachChild(jobId: string, attemptId: string): void {
		this.controls.delete(`${jobId}\u0000${attemptId}`);
	}

	/** True while a spawned worker for this job is still alive. */
	hasActiveChild(jobId: string): boolean {
		for (const child of this.controls.values()) if (child.jobId === jobId) return true;
		return false;
	}

	/** The live child for a job (single flight per job), or undefined. */
	activeChild(jobId: string): LiveChild | undefined {
		for (const child of this.controls.values()) if (child.jobId === jobId) return child;
		return undefined;
	}

	/**
	 * Deliver a main→worker message by steering the live child. Resolves only
	 * once the worker ACKs the steer (never claims delivery before that);
	 * rejects with an explicit error when there is no live worker or the
	 * worker refuses. On ACK the message is recorded in the inbox.
	 */
	async steerJob(jobId: string, text: string): Promise<void> {
		const child = this.activeChild(jobId);
		if (!child) {
			throw new OrchestratorError("unknown", `Job ${jobId} has no live worker to receive a message (it must be running; use delegate or jobs followup instead)`);
		}
		const message = boundedInboxText(text, "message");
		await child.control.steer(message); // rejects on RPC error/exit: no delivery claim
		this.pushInbox({
			type: "message",
			id: this.nextId(jobId),
			direction: "main",
			jobId,
			attemptId: child.attemptId,
			text: message,
			createdAt: Date.now(),
			delivered: true,
			consumed: false,
		});
		this.events.append(jobId, "message.main", { attemptId: child.attemptId, bytes: Buffer.byteLength(message, "utf-8") }, child.attemptId);
	}

	// ── Worker → main (spawn hooks) ─────────────────────────────────────────

	/** One-way worker message (message_main): inbox + durable event + attention. */
	handleWorkerMessage(jobId: string, attemptId: string, message: WorkerMessage): void {
		if (this.disposed) return;
		const item: InboxMessage = {
			type: "message",
			id: this.nextId(jobId),
			direction: "worker",
			jobId,
			attemptId,
			text: boundedInboxText(message.text, "worker message"),
			createdAt: Date.now(),
			consumed: false,
		};
		this.pushInbox(item);
		this.events.append(jobId, "message.worker", { attemptId, bytes: Buffer.byteLength(item.text, "utf-8") }, attemptId);
		this.emitAttention({ id: item.id, jobId, kind: "message", message: item });
	}

	/**
	 * Blocking worker request (ask_main / ask_user_question). The returned
	 * promise settles exactly once: answered by reply(), timeout at the
	 * deadline, cancelled when the worker exits, or unavailable when no human
	 * handler is attached for ask_user_question.
	 */
	handleWorkerRequest(jobId: string, attemptId: string, agent: string, request: WorkerRequest, rpc: { id: string; signal: AbortSignal }): Promise<WorkerReply> {
		if (this.disposed) return Promise.resolve({ status: "unavailable", reason: "the orchestrator session that owned this request is gone" });
		const requestId = rpc.id;
		const timeoutSeconds = clampRequestTimeoutSeconds(request.timeoutSeconds);
		const item: InboxRequest = {
			type: "request",
			id: this.nextId(jobId),
			jobId,
			attemptId,
			requestId,
			agent,
			kind: request.kind,
			question: request.question,
			options: request.kind === "ask_user_question" ? request.options : undefined,
			allowCustom: request.kind === "ask_user_question" ? (request.allowCustom ?? true) : undefined,
			timeoutSeconds,
			status: "pending",
			createdAt: Date.now(),
			consumed: false,
		};
		this.pushInbox(item);
		this.events.append(jobId, "request.received", { attemptId, requestId, kind: request.kind, question: request.question.slice(0, 200) }, attemptId);

		let resolve!: (reply: WorkerReply) => void;
		const promise = new Promise<WorkerReply>((res) => {
			resolve = res;
		});
		const pending: PendingRequest = {
			key: `${jobId}\u0000${attemptId}\u0000${requestId}`,
			item,
			childSignal: rpc.signal,
			ui: new AbortController(),
			timer: undefined,
			onChildAbort: () => {
				this.settle(pending, { status: "cancelled" });
				this.events.append(jobId, "request.expired", { attemptId, requestId, reason: "worker exited before answering" }, attemptId);
			},
			settled: false,
			resolve,
			promise,
		};
		this.requests.set(pending.key, pending);
		rpc.signal.addEventListener("abort", pending.onChildAbort, { once: true });
		// Parent-owned deadline: aborts the pending UI and settles timeout.
		pending.timer = setTimeout(() => {
			if (pending.settled) return;
			pending.ui.abort();
			this.settle(pending, { status: "timeout" });
			this.events.append(jobId, "request.expired", { attemptId, requestId, reason: "deadline exceeded" }, attemptId);
		}, timeoutSeconds * 1000);

		if (request.kind === "ask_main") {
			// Main model answers via reply(); attention wakes a blocking tool.
			this.emitAttention({ id: item.id, jobId, kind: "request", request: item });
			return promise;
		}
		// ask_user_question: resolved solely by the human-question seam.
		const handler = this.humanHandler;
		if (!handler) {
			this.settle(pending, { status: "unavailable", reason: "no user interface is attached to the orchestrator main session" });
			return promise;
		}
		void handler({ jobId, attemptId, requestId, agent, request }, { id: requestId, signal: pending.ui.signal }).then(
			(reply) => this.settle(pending, reply),
			(err) =>
				this.settle(pending, {
					status: "error",
					reason: `question UI failed: ${err instanceof Error ? err.message : String(err)}`,
				}),
		);
		return promise;
	}

	// ── Main → worker: reply / inbox / attention ─────────────────────────────

	/**
	 * Answer a pending ask_main request. Exact correlation: the requestId must
	 * belong to this job and still be pending; duplicate, expired, cross-job,
	 * and stale (old process) replies are all rejected explicitly.
	 */
	reply(jobId: string, requestId: string, answer: string): void {
		const text = boundedInboxText(answer, "answer");
		const matches: PendingRequest[] = [];
		for (const pending of this.requests.values()) {
			if (pending.item.requestId === requestId) matches.push(pending);
		}
		if (matches.length === 0) {
			const known = this.findInboxRequest(requestId);
			if (known) {
				throw new OrchestratorError(
					"unknown",
					`Request ${requestId} is ${known.status === "pending" ? "not answerable" : `already ${known.status}`}; replies must target a PENDING ask_main request exactly once`,
				);
			}
			throw new OrchestratorError("unknown", `Unknown request ${requestId} (it expired, was cancelled, or belongs to an old orchestrator process)`);
		}
		if (matches.length > 1) throw new OrchestratorError("unknown", `Request id ${requestId} is ambiguous across jobs`);
		const pending = matches[0];
		if (pending.item.jobId !== jobId) {
			throw new OrchestratorError("unknown", `Request ${requestId} belongs to job ${pending.item.jobId}, not ${jobId} (cross-job replies are rejected)`);
		}
		if (pending.item.kind !== "ask_main") {
			throw new OrchestratorError("unknown", `Request ${requestId} is an ${pending.item.kind}; only ask_main requests are answered by the main agent (user questions are answered in the UI)`);
		}
		this.settle(pending, { status: "answered", answer: text });
	}

	/**
	 * Read the bounded inbox (optionally one job). Reading CONSUMES attention:
	 * returned items are marked consumed so a blocking delegate/wait does not
	 * yield again on already-handled history.
	 */
	readInbox(jobId?: string): InboxItem[] {
		const items: InboxItem[] = [];
		if (jobId !== undefined) {
			for (const item of this.inbox.get(jobId) ?? []) items.push({ ...item });
		} else {
			for (const list of this.inbox.values()) for (const item of list) items.push({ ...item });
		}
		items.sort((a, b) => a.createdAt - b.createdAt);
		const bounded = items.slice(-INBOX_MAX_PER_JOB);
		for (const copy of bounded) {
			const list = this.inbox.get(copy.jobId);
			const original = list?.find((item) => item.id === copy.id);
			if (original) original.consumed = true;
		}
		return bounded;
	}

	/** Pending ask_main requests (optionally one job) — what the main model can still answer. */
	pendingRequests(jobId?: string): InboxRequest[] {
		return this.readInbox(jobId).filter((item): item is InboxRequest => item.type === "request" && item.status === "pending" && item.kind === "ask_main");
	}

	/** True when the job has unconsumed attention (new worker message or pending ask_main). */
	hasUnconsumedAttention(jobId?: string): boolean {
		const lists = jobId !== undefined ? [this.inbox.get(jobId) ?? []] : [...this.inbox.values()];
		for (const list of lists) {
			for (const item of list) {
				if (item.type === "message" && !item.consumed) return true;
				if (item.type === "request" && !item.consumed && item.kind === "ask_main" && item.status === "pending") return true;
			}
		}
		return false;
	}

	/** Subscribe to NEW attention (unconsumed worker messages + ask_main requests). */
	onAttention(listener: (attention: AttentionItem) => void): () => void {
		this.attentionListeners.add(listener);
		return () => {
			this.attentionListeners.delete(listener);
		};
	}

	/** Register the human-question seam (ask_user_question). */
	setHumanQuestionHandler(handler: HumanQuestionHandler | undefined): void {
		this.humanHandler = handler;
	}

	/**
	 * Session teardown: settle everything as cancelled, clear timers and
	 * listeners. Pending worker requests must never hang a shutting-down main
	 * session, and stale requests from an old process are never revived.
	 */
	dispose(): void {
		this.disposed = true;
		for (const pending of [...this.requests.values()]) {
			this.settle(pending, { status: "cancelled" });
		}
		this.requests.clear();
		this.controls.clear();
		this.attentionListeners.clear();
		this.humanHandler = undefined;
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private nextId(jobId: string): string {
		return `${jobId}:${++this.seq}`;
	}

	private pushInbox(item: InboxItem): void {
		let list = this.inbox.get(item.jobId);
		if (!list) {
			list = [];
			this.inbox.set(item.jobId, list);
		}
		list.push(item);
		if (list.length > INBOX_MAX_PER_JOB) list.splice(0, list.length - INBOX_MAX_PER_JOB);
	}

	private findInboxRequest(requestId: string): InboxRequest | undefined {
		for (const list of this.inbox.values()) {
			for (const item of list) {
				if (item.type === "request" && item.requestId === requestId) return item;
			}
		}
		return undefined;
	}

	private emitAttention(attention: AttentionItem): void {
		for (const listener of this.attentionListeners) {
			try {
				listener(attention);
			} catch {
				/* attention observers must never affect jobs */
			}
		}
	}

	/** Settle a pending request exactly once; late results are discarded. */
	private settle(pending: PendingRequest, reply: WorkerReply): void {
		if (pending.settled) return; // exactly once
		pending.settled = true;
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		pending.childSignal.removeEventListener("abort", pending.onChildAbort);
		if (!pending.ui.signal.aborted && (reply.status === "cancelled" || reply.status === "timeout" || reply.status === "unavailable" || reply.status === "error")) {
			// close any pending UI dialog so it cannot linger past the request
			try {
				pending.ui.abort();
			} catch {
				/* ignore */
			}
		}
		this.requests.delete(pending.key);
		pending.item.status = replyStatus(reply);
		if (reply.status === "answered") pending.item.answer = reply.answer;
		pending.item.resolvedAt = Date.now();
		this.events.append(
			pending.item.jobId,
			"request.resolved",
			{ attemptId: pending.item.attemptId, requestId: pending.item.requestId, status: reply.status },
			pending.item.attemptId,
		);
		pending.resolve(reply);
	}
}
