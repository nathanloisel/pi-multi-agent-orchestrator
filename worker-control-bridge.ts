/**
 * worker-control-bridge.ts — narrow in-process pi.events bridge (extension
 * layer only; no TUI, no IPC transport, no main-LLM relay).
 *
 * The native sidebar extension (pi-session-desk) drives ACTIVE workers
 * through the shared host EventBus (`pi.events`) with a fixed v1 protocol:
 *
 *   request  channel: "orchestrator:worker-control:request:v1"
 *   response channel: "orchestrator:worker-control:response:v1"
 *
 *   Request  { version: 1, requestId, operation: "status" | "steer",
 *              jobsRoot, jobId, attemptId?, text? }
 *   Response { version: 1, requestId, operation, jobsRoot, jobId, ok,
 *              canSend?, attemptId?, accepted?, error? }
 *
 * Guarantees:
 *   - Canonical scoping: `jobsRoot` must be absolute and resolve to the
 *     CURRENT runtime's `store.jobsDir()` (shared default
 *     ~/.pi/orchestrator/jobs); anything else is rejected before any job
 *     read. `jobId`/`requestId` are safe ids (1–128 chars of [A-Za-z0-9._:-],
 *     first char alnum) so a jobId can never escape the jobs root.
 *   - Status: ok=true iff the job is known; canSend iff
 *     job.status === "running" && runtime.hasLiveWorker(jobId); the latest
 *     attemptId is included when one exists. Unknown jobs reply ok=false;
 *     non-sending states carry a clear error alongside canSend=false.
 *   - Steer: `text` must be nonempty and ≤ 4096 UTF-8 bytes; a supplied
 *     attemptId must equal the job's latest attempt (stale rejected); the
 *     worker must actually be live. `await runtime.messageJob()` is the final
 *     guard AND the broker ACK — only after it resolves does the bridge
 *     appendPrompt on runtime.workerFeed and reply { ok, accepted: true }.
 *     Errors reply with accepted=false and bounded text; nothing here ever
 *     claims task completion.
 *   - Never throws into the bus: malformed/unknown event data (bad version,
 *     operation, requestId) is dropped; correlatable failures become bounded
 *     error responses.
 *   - Bounds: ≤32 concurrent in-flight requests; dedup keyed by requestId and
 *     scoped to jobsRoot+jobId+operation (+attemptId/text payload — a reuse
 *     with a different payload is rejected), reusing the in-flight promise or
 *     a bounded 128-entry completion cache. Runtime replacement (reset) and
 *     shutdown (dispose) clear the dedup lifecycle; a steer whose ACK lands
 *     after a reset/dispose replies NOT-confirmed — late old-runtime replies
 *     never claim a successful new delivery.
 */

import * as path from "node:path";

/** Fixed v1 channels (exact strings; do not vary across repos). */
export const WORKER_CONTROL_REQUEST_CHANNEL = "orchestrator:worker-control:request:v1";
export const WORKER_CONTROL_RESPONSE_CHANNEL = "orchestrator:worker-control:response:v1";

/** Envelope version: exactly 1 for both directions. */
export const WORKER_CONTROL_VERSION = 1;

export type WorkerControlOperation = "status" | "steer";

/** Request envelope (v1). attemptId is steer-only; text is steer-only. */
export interface WorkerControlRequest {
	version: typeof WORKER_CONTROL_VERSION;
	requestId: string;
	operation: WorkerControlOperation;
	jobsRoot: string;
	jobId: string;
	attemptId?: string;
	text?: string;
}

/** Response envelope (v1). Exactly one response is emitted per handled request. */
export interface WorkerControlResponse {
	version: typeof WORKER_CONTROL_VERSION;
	requestId: string;
	operation: WorkerControlOperation;
	jobsRoot: string;
	jobId: string;
	ok: boolean;
	canSend?: boolean;
	attemptId?: string;
	accepted?: boolean;
	error?: string;
}

/** Structural view of the host EventBus (`pi.events` from either SDK). */
export interface WorkerControlEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Minimal runtime surface the bridge drives (the real Orchestrator satisfies it). */
export interface WorkerControlRuntime {
	readonly store: {
		jobsDir(): string;
		/** RAW store read (never crash-recovery: a sidebar status poll must not mutate state). */
		readJob(jobId: string): { readonly status: string; readonly latestAttemptId?: string } | null;
	};
	hasLiveWorker(jobId: string): boolean;
	/** Final guard + broker ACK: resolves only once the live worker ACKs the steer. */
	messageJob(jobId: string, text: string): Promise<void>;
	readonly workerFeed: {
		appendPrompt(jobId: string, text: string): void;
	};
}

export interface WorkerControlBridgeOptions {
	events: WorkerControlEventBus;
	/** Always returns the CURRENT runtime (null before the session runtime exists). */
	getRuntime: () => WorkerControlRuntime | null;
}

export interface WorkerControlBridgeStats {
	/** Request channel subscription active. */
	subscribed: boolean;
	disposed: boolean;
	generation: number;
	inflight: number;
	pending: number;
	completed: number;
}

export interface WorkerControlBridge {
	/** Idempotent: subscribe to the request channel (extension startup / session start). */
	start(): void;
	/** Idempotent: unsubscribe, fail in-flight work, clear dedup state (session shutdown / reload). */
	dispose(): void;
	/** Runtime replacement: clear dedup lifecycle; in-flight steers can no longer claim delivery. */
	reset(): void;
	stats(): WorkerControlBridgeStats;
}

// ── Bounds (§ contract) ──────────────────────────────────────────────────────

/** requestId/jobId: 1–128 chars, first alnum, rest [A-Za-z0-9._:-] (no path separators). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEXT_BYTES = 4096;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_COMPLETED_CACHE = 128;
const MAX_ERROR_BYTES = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounded single-line error text (UTF-8 byte cap; never splits a code point). */
function boundError(raw: unknown): string {
	const text = String(raw ?? "").replace(/\s+/g, " ").trim() || "unknown error";
	if (Buffer.byteLength(text, "utf8") <= MAX_ERROR_BYTES) return text;
	let out = "";
	let bytes = 0;
	for (const ch of text) {
		const n = Buffer.byteLength(ch, "utf8");
		if (bytes + n > MAX_ERROR_BYTES - 1) break;
		out += ch;
		bytes += n;
	}
	return `${out}…`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Correlation fields echoed on every response (validated before emitting). */
interface Echo {
	requestId: string;
	operation: WorkerControlOperation;
	jobsRoot: string;
	jobId: string;
}

interface DedupEntry {
	fingerprint: string;
	promise: Promise<WorkerControlResponse>;
}

class WorkerControlBridgeImpl implements WorkerControlBridge {
	private unsubscribe: (() => void) | null = null;
	private disposed = false;
	private generation = 0;
	private inflight = 0;
	private readonly pending = new Map<string, DedupEntry>();
	private readonly completed = new Map<string, DedupEntry>();

	constructor(
		private readonly bus: WorkerControlEventBus,
		private readonly getRuntime: () => WorkerControlRuntime | null,
	) {}

	start(): void {
		if (this.unsubscribe) return;
		this.disposed = false;
		try {
			this.unsubscribe = this.bus.on(WORKER_CONTROL_REQUEST_CHANNEL, this.onRequest);
		} catch {
			this.unsubscribe = () => {};
		}
	}

	dispose(): void {
		this.disposed = true;
		this.generation++; // in-flight steers must not claim delivery past this point
		this.pending.clear();
		this.completed.clear();
		const unsub = this.unsubscribe;
		this.unsubscribe = null;
		try {
			unsub?.();
		} catch {
			/* idempotent cleanup */
		}
	}

	reset(): void {
		this.generation++; // runtime replacement: late old-runtime ACKs never claim success
		this.pending.clear();
		this.completed.clear();
	}

	stats(): WorkerControlBridgeStats {
		return {
			subscribed: this.unsubscribe !== null,
			disposed: this.disposed,
			generation: this.generation,
			inflight: this.inflight,
			pending: this.pending.size,
			completed: this.completed.size,
		};
	}

	/** Bus entry point: never throws, never floats a rejecting promise. */
	private readonly onRequest = (data: unknown): void => {
		try {
			void this.handle(data);
		} catch {
			/* never throw into the EventBus */
		}
	};

	private emitResponse(response: WorkerControlResponse): void {
		try {
			this.bus.emit(WORKER_CONTROL_RESPONSE_CHANNEL, response);
		} catch {
			/* never throw into the EventBus */
		}
	}

	private error(echo: Echo, message: string): WorkerControlResponse {
		const response: WorkerControlResponse = {
			version: WORKER_CONTROL_VERSION,
			requestId: echo.requestId,
			operation: echo.operation,
			jobsRoot: echo.jobsRoot,
			jobId: echo.jobId,
			ok: false,
			error: boundError(message),
		};
		if (echo.operation === "status") response.canSend = false;
		else response.accepted = false;
		return response;
	}

	private async handle(raw: unknown): Promise<void> {
		try {
			// ── Correlation: drop what cannot produce a contract-valid response ──
			if (!isRecord(raw)) return;
			if (raw.version !== WORKER_CONTROL_VERSION) return; // unknown protocol version
			const requestId = raw.requestId;
			if (typeof requestId !== "string" || !SAFE_ID.test(requestId)) return; // cannot correlate safely
			const operation = raw.operation;
			if (operation !== "status" && operation !== "steer") return; // response.operation is fixed to these two
			const echo: Echo = {
				requestId,
				operation,
				jobsRoot: typeof raw.jobsRoot === "string" ? raw.jobsRoot : "",
				jobId: typeof raw.jobId === "string" ? raw.jobId : "",
			};
			const attemptId = typeof raw.attemptId === "string" ? raw.attemptId : undefined;
			const text = typeof raw.text === "string" ? raw.text : undefined;

			// ── Dedup: requestId scoped to jobsRoot+jobId+operation + payload ──
			const dedupable =
				typeof raw.jobsRoot === "string" &&
				SAFE_ID.test(echo.jobId) &&
				(raw.attemptId === undefined || typeof raw.attemptId === "string") &&
				(raw.text === undefined || typeof raw.text === "string");
			// JSON keeps absent (undefined) distinct from "" so e.g. text:"" and a
			// missing text are different payloads for the same requestId.
			const fingerprint = JSON.stringify([echo.jobsRoot, echo.jobId, operation, attemptId, text]);
			const generation = this.generation;

			if (dedupable) {
				const existing = this.pending.get(requestId) ?? this.completed.get(requestId);
				if (existing) {
					if (existing.fingerprint !== fingerprint) {
						// Same requestId, different payload/scope: reject WITHOUT
						// touching the original entry (its in-flight work continues).
						this.emitResponse(this.error(echo, "requestId already used with a different request payload (dedup scope: jobsRoot+jobId+operation)"));
						return;
					}
					const replay = await existing.promise; // reuse in-flight or completed result
					this.emitResponse(replay);
					return;
				}
			}

			// ── Concurrency cap (new work only; dedup replays bypass it) ──
			if (this.inflight >= MAX_CONCURRENT_REQUESTS) {
				this.emitResponse(this.error(echo, `too many concurrent worker-control requests (limit ${MAX_CONCURRENT_REQUESTS}); retry shortly`));
				return;
			}

			this.inflight++;
			const entry: DedupEntry = { fingerprint, promise: undefined as unknown as Promise<WorkerControlResponse> };
			entry.promise = this.process(echo, generation, attemptId, text)
				.catch((err) => this.error(echo, `internal error: ${errorText(err)}`))
				.then((response) => {
					this.inflight--;
					// Track completions only while the dedup lifecycle is the same one
					// the request started under (never repopulate after reset/dispose).
					if (dedupable && generation === this.generation) {
						this.pending.delete(requestId);
						this.completed.set(requestId, entry);
						while (this.completed.size > MAX_COMPLETED_CACHE) {
							const oldest = this.completed.keys().next();
							if (oldest.done) break;
							this.completed.delete(oldest.value);
						}
					}
					return response;
				});
			if (dedupable) this.pending.set(requestId, entry);

			const response = await entry.promise;
			this.emitResponse(response);
		} catch {
			/* a handler must never reject */
		}
	}

	/** Full validation + dispatch for one correlated request; never throws to callers it cannot answer. */
	private async process(echo: Echo, generation: number, attemptId: string | undefined, text: string | undefined): Promise<WorkerControlResponse> {
		if (this.disposed || generation !== this.generation) {
			return this.error(echo, "worker-control unavailable: bridge closed before the request was processed");
		}
		const runtime = this.getRuntime();
		if (!runtime) {
			return this.error(echo, "worker-control unavailable: orchestrator runtime is not ready");
		}

		// ── Canonical scoping: absolute jobsRoot matching this runtime's jobs dir ──
		if (echo.jobsRoot.length === 0 || !path.isAbsolute(echo.jobsRoot)) {
			return this.error(echo, "jobsRoot must be an absolute path");
		}
		let canonical: string;
		try {
			canonical = runtime.store.jobsDir();
		} catch (err) {
			return this.error(echo, `worker-control unavailable: cannot resolve the canonical jobs root (${errorText(err)})`);
		}
		if (path.resolve(echo.jobsRoot) !== path.resolve(canonical)) {
			return this.error(echo, "jobsRoot does not match the canonical jobs root of the current runtime (cross-root requests are rejected)");
		}
		if (!SAFE_ID.test(echo.jobId)) {
			return this.error(echo, "jobId must be a safe id: 1-128 chars of [A-Za-z0-9._:-], starting alphanumeric");
		}

		return echo.operation === "status" ? this.processStatus(runtime, echo) : this.processSteer(runtime, echo, generation, attemptId, text);
	}

	private processStatus(runtime: WorkerControlRuntime, echo: Echo): WorkerControlResponse {
		const base = { version: WORKER_CONTROL_VERSION, requestId: echo.requestId, operation: echo.operation, jobsRoot: echo.jobsRoot, jobId: echo.jobId } as const;
		const job = runtime.store.readJob(echo.jobId);
		if (!job) {
			return this.error(echo, `unknown job: ${echo.jobId}`);
		}
		const latest = typeof job.latestAttemptId === "string" ? job.latestAttemptId : undefined;
		const attempt = latest ? { attemptId: latest } : {};
		const canSend = job.status === "running" && runtime.hasLiveWorker(echo.jobId);
		if (canSend) {
			return { ...base, ok: true, canSend: true, ...attempt };
		}
		const why =
			job.status === "running"
				? "job is running but its worker is offline (no live worker attached)"
				: `job is ${job.status}; only running jobs have a live worker to steer`;
		return { ...base, ok: true, canSend: false, ...attempt, error: why };
	}

	private async processSteer(runtime: WorkerControlRuntime, echo: Echo, generation: number, attemptId: string | undefined, text: string | undefined): Promise<WorkerControlResponse> {
		if (text === undefined) return this.error(echo, "text is required for operation 'steer'");
		if (text.length === 0) return this.error(echo, "text must be nonempty for operation 'steer'");
		if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
			return this.error(echo, `text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
		}

		const job = runtime.store.readJob(echo.jobId);
		if (!job) return this.error(echo, `unknown job: ${echo.jobId}`);
		if (job.status !== "running") {
			// Finished/queued/… jobs are rejected: no dispatch, no feed prompt.
			return this.error(echo, `job is ${job.status}; only running jobs have a live worker to steer`);
		}
		const latest = typeof job.latestAttemptId === "string" ? job.latestAttemptId : undefined;
		if (attemptId !== undefined) {
			if (!SAFE_ID.test(attemptId)) {
				return this.error(echo, "attemptId must be a safe id: 1-128 chars of [A-Za-z0-9._:-], starting alphanumeric");
			}
			if (!latest) return this.error(echo, `stale attemptId ${attemptId}: job has no attempts`);
			if (attemptId !== latest) return this.error(echo, `stale attemptId ${attemptId}: latest attempt is ${latest}`);
		}
		if (!runtime.hasLiveWorker(echo.jobId)) {
			return this.error(echo, "job has no live worker (offline); steer not dispatched");
		}

		// Final guard + broker ACK: resolves only on the live worker's steer ACK.
		try {
			await runtime.messageJob(echo.jobId, text);
		} catch (err) {
			return this.error(echo, `steer rejected: ${errorText(err)}`);
		}

		// ACK received — but a shutdown/runtime replacement during the wait means
		// this reply must NOT claim a successful delivery through the current session.
		if (this.disposed || generation !== this.generation) {
			return this.error(echo, "runtime/session was replaced before the worker ACK; delivery not confirmed");
		}

		try {
			runtime.workerFeed.appendPrompt(echo.jobId, text); // transcript note, only after ACK
		} catch {
			/* feed is best effort; the ACK itself already succeeded */
		}
		return {
			version: WORKER_CONTROL_VERSION,
			requestId: echo.requestId,
			operation: echo.operation,
			jobsRoot: echo.jobsRoot,
			jobId: echo.jobId,
			ok: true,
			accepted: true,
			...(latest ? { attemptId: latest } : {}),
		};
	}
}

/**
 * Create the bridge for one extension instance. Call `start()` to subscribe
 * (extension factory / session_start), `dispose()` on session_shutdown, and
 * `reset()` whenever the runtime is replaced.
 */
export function createWorkerControlBridge(options: WorkerControlBridgeOptions): WorkerControlBridge {
	return new WorkerControlBridgeImpl(options.events, options.getRuntime);
}