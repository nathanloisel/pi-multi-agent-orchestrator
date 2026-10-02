/**
 * core/worker-feed.ts — bounded, event-driven transcript feed for the
 * approved /workers main-session dashboard.
 *
 * The feed consumes the ALREADY-PARSED RPC event objects handed to
 * SpawnRequest.onEvent (core/spawn.ts). It never polls disk and never re-reads
 * attempt stream.jsonl: every byte shown comes from the live event stream.
 *
 * Semantics:
 *   - one buffer per job (LRU-capped); beginAttempt opens the LATEST-attempt
 *     view (a new attemptId resets it), so stale events from older attempts
 *     are ignored; finishAttempt closes the run (late events dropped)
 *   - assistant text streams in as delta segments (appended as bounded chunks,
 *     never re-joined per token) and is reconciled against the authoritative
 *     message_end text exactly once per message — so streamed content is
 *     preserved WITHOUT duplicating the final full text
 *   - tool lifecycles render as bounded name/status summaries (arguments and
 *     results are never serialized into the feed); hidden reasoning/thinking
 *     blocks are omitted entirely
 *
 * Hard retention bounds (memory is always bounded):
 *   - <= 200 entries and <= 64 KiB text per job (oldest dropped first; huge
 *     deltas are truncated on the fly without allocating unbounded arrays)
 *   - <= 48 job buffers via LRU; eviction leaves a truthful tombstone so
 *     read() reports truncated=true instead of silently losing history
 *
 * Snapshots are materialized once per revision and cached until the next
 * mutation (read is cheap and returns the cached object while unchanged).
 * Listener callbacks receive only the jobId, and are exception-isolated.
 */

/** Hard cap on entries retained per job (oldest dropped first). */
export const MAX_FEED_ENTRIES = 200;
/** Hard cap on total entry text per job, UTF-8 bytes. */
export const MAX_FEED_TEXT_BYTES = 64 * 1024;
/** Hard cap on job buffers held simultaneously (LRU). */
export const MAX_JOB_BUFFERS = 48;
/** Hard cap on a single prompt entry appended via appendPrompt, UTF-8 bytes. */
export const MAX_PROMPT_BYTES = 4096;
/** Bound for tool names rendered into lifecycle summaries, UTF-8 bytes. */
const MAX_TOOL_NAME_BYTES = 96;
/** Bound for tool call ids used as correlation keys, characters. */
const MAX_TOOL_CALL_ID_CHARS = 128;
/** Bound for message contentIndex values (adversarial events). */
const MAX_CONTENT_INDEX = 100_000;
/** Streaming segments are coalesced once this many accumulate on one entry. */
const MAX_ENTRY_PARTS = 64;
/** Eviction tombstones kept after LRU eviction (memory-bounded truthfulness). */
const MAX_TOMBSTONES = 48;

export interface WorkerFeedEntry {
	id: string;
	role: "assistant" | "tool" | "system" | "user";
	text: string;
	at: number;
	/** Present (true) only while the entry is still streaming. */
	streaming?: boolean;
}

export interface WorkerFeedSnapshot {
	jobId: string;
	attemptId?: string;
	revision: number;
	entries: readonly WorkerFeedEntry[];
	/** Truthful loss marker: entries/text were dropped by retention caps or LRU eviction. */
	truncated: boolean;
}

/** Raw RPC event shape as passed to SpawnRequest.onEvent (already JSON.parsed). */
export type WorkerFeedEvent = { type: string; [key: string]: unknown };

interface FeedEntryInternal {
	id: string;
	role: "assistant" | "tool" | "system" | "user";
	at: number;
	/** Bounded append segments; coalesced to stay short. Joined once per read. */
	parts: string[];
	bytes: number;
	streaming: boolean;
	toolName?: string;
}

interface JobBuffer {
	jobId: string;
	attemptId?: string;
	active: boolean;
	revision: number;
	seq: number;
	entries: FeedEntryInternal[];
	bytes: number;
	truncated: boolean;
	/** Current assistant message: contentIndex -> streamed text entry. */
	textByIndex: Map<number, FeedEntryInternal>;
	/** Current tool lifecycles: toolCallId -> tool entry. */
	toolById: Map<string, FeedEntryInternal>;
	cached?: WorkerFeedSnapshot;
	lastUsed: number;
}

/**
 * Deterministic UTF-8 truncation to at most maxBytes bytes without allocating
 * the full buffer: walks code units, accounts exact UTF-8 widths (including
 * surrogate pairs), and never splits a character.
 */
function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let bytes = 0;
	let i = 0;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		let width = 1;
		let n = 1;
		if (code < 0x80) n = 1;
		else if (code < 0x800) n = 2;
		else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				width = 2;
				n = 4;
			} else n = 3;
		} else n = 3;
		if (bytes + n > maxBytes) return text.slice(0, i);
		bytes += n;
		i += width;
	}
	return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asContentIndex(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_CONTENT_INDEX ? value : undefined;
}

function asId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOOL_CALL_ID_CHARS) return undefined;
	return value;
}

function toolNameOf(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "tool";
	const name = truncateUtf8(value, MAX_TOOL_NAME_BYTES).trim();
	return name.length > 0 ? name : "tool";
}

export class WorkerFeed {
	private readonly buffers = new Map<string, JobBuffer>();
	/** Truthful tombstones for LRU-evicted jobs (read() reports truncated). */
	private readonly tombstones = new Map<string, WorkerFeedSnapshot>();
	private readonly listeners = new Set<(jobId: string) => void>();
	private useClock = 0;
	private disposed = false;

	// ── Attempt lifecycle ─────────────────────────────────────────────────────

	/**
	 * Open the latest-attempt view for a job. A different attemptId (retry or
	 * fresh run) resets the view so stale older-attempt events can never leak
	 * in; resuming the SAME attempt (follow-up) continues the transcript.
	 */
	beginAttempt(jobId: string, attemptId: string): void {
		if (this.disposed) return;
		if (typeof jobId !== "string" || jobId.length === 0 || typeof attemptId !== "string" || attemptId.length === 0) return;
		let buffer = this.buffers.get(jobId);
		if (!buffer) buffer = this.createBuffer(jobId);
		buffer.lastUsed = ++this.useClock;
		this.tombstones.delete(jobId);
		const revisionBefore = buffer.revision;
		if (buffer.attemptId !== attemptId) {
			buffer.entries = [];
			buffer.bytes = 0;
			buffer.truncated = false;
			buffer.attemptId = attemptId;
			this.bump(buffer);
		}
		// In-flight per-message state never spans runs.
		buffer.textByIndex.clear();
		buffer.toolById.clear();
		buffer.active = true;
		if (buffer.revision !== revisionBefore) this.notify(jobId);
	}

	/** Close an attempt run: late events are ignored, still-streaming entries settle. */
	finishAttempt(jobId: string, attemptId: string): void {
		if (this.disposed) return;
		if (typeof jobId !== "string" || typeof attemptId !== "string") return;
		const buffer = this.buffers.get(jobId);
		if (!buffer || buffer.attemptId !== attemptId) return;
		buffer.lastUsed = ++this.useClock;
		const revisionBefore = buffer.revision;
		buffer.active = false;
		this.finalizeStreaming(buffer, "all");
		// The closed run's in-flight message/tool state is dead; a resumed run
		// starts fresh blocks while keeping the transcript entries.
		buffer.textByIndex.clear();
		buffer.toolById.clear();
		if (buffer.revision !== revisionBefore) this.notify(jobId);
	}

	// ── Ingestion ─────────────────────────────────────────────────────────────

	/**
	 * Ingest one already-parsed RPC event. Validated field-by-field before use;
	 * events for other attempts, inactive attempts, or unknown jobs are ignored.
	 * Never throws.
	 */
	ingest(jobId: string, attemptId: string, event: WorkerFeedEvent): void {
		if (this.disposed) return;
		if (typeof jobId !== "string" || typeof attemptId !== "string") return;
		if (!isRecord(event) || typeof event.type !== "string") return;
		const buffer = this.buffers.get(jobId);
		if (!buffer || !buffer.active || buffer.attemptId !== attemptId) return;
		buffer.lastUsed = ++this.useClock;
		const revisionBefore = buffer.revision;
		switch (event.type) {
			case "message_start":
			case "message_end":
				this.handleMessage(buffer, event.type, event);
				break;
			case "message_update":
				this.handleUpdate(buffer, event);
				break;
			case "tool_execution_start":
				this.handleToolStart(buffer, event);
				break;
			case "tool_execution_end":
				this.handleToolEnd(buffer, event);
				break;
			// tool_execution_update: partial results/args are intentionally never
			// serialized into the feed (bounded tool summaries only).
			default:
				break;
		}
		if (buffer.revision !== revisionBefore) this.notify(jobId);
	}

	/**
	 * Append the user prompt entry for a job (called by integration only after
	 * the messageJob ACK). Text is capped to MAX_PROMPT_BYTES UTF-8 bytes with
	 * a trailing ellipsis when cut.
	 */
	appendPrompt(jobId: string, text: string): void {
		if (this.disposed) return;
		if (typeof jobId !== "string" || jobId.length === 0 || typeof text !== "string" || text.length === 0) return;
		let buffer = this.buffers.get(jobId);
		if (!buffer) buffer = this.createBuffer(jobId);
		buffer.lastUsed = ++this.useClock;
		this.tombstones.delete(jobId);
		const revisionBefore = buffer.revision;
		let display = text;
		if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
			display = `${truncateUtf8(text, MAX_PROMPT_BYTES - 3)}…`;
		}
		this.addEntry(buffer, "user", display);
		if (buffer.revision !== revisionBefore) this.notify(jobId);
	}

	// ── Reads / subscriptions ─────────────────────────────────────────────────

	/**
	 * Read the current snapshot. Materialized and cached by revision: repeated
	 * reads without intervening mutations return the SAME object.
	 */
	read(jobId: string): WorkerFeedSnapshot {
		if (this.disposed || typeof jobId !== "string" || jobId.length === 0) {
			return { jobId: typeof jobId === "string" ? jobId : "", revision: 0, entries: [], truncated: false };
		}
		const buffer = this.buffers.get(jobId);
		if (!buffer) return this.tombstones.get(jobId) ?? { jobId, revision: 0, entries: [], truncated: false };
		buffer.lastUsed = ++this.useClock;
		if (buffer.cached && buffer.cached.revision === buffer.revision) return buffer.cached;
		const entries = buffer.entries.map((entry): WorkerFeedEntry => ({
			id: entry.id,
			role: entry.role,
			text: entry.parts.join(""),
			at: entry.at,
			...(entry.streaming ? { streaming: true } : {}),
		}));
		const snapshot: WorkerFeedSnapshot = {
			jobId: buffer.jobId,
			attemptId: buffer.attemptId,
			revision: buffer.revision,
			entries: Object.freeze(entries),
			truncated: buffer.truncated,
		};
		buffer.cached = snapshot;
		return snapshot;
	}

	/** Subscribe to feed changes; the listener receives only the jobId. Cheap and exception-isolated. */
	subscribe(listener: (jobId: string) => void): () => void {
		if (this.disposed || typeof listener !== "function") return () => {};
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Drop all buffers and listeners. All further calls are no-ops. */
	dispose(): void {
		this.disposed = true;
		this.buffers.clear();
		this.tombstones.clear();
		this.listeners.clear();
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	/** message_start opens a fresh assistant message; message_end reconciles it. */
	private handleMessage(buffer: JobBuffer, kind: "message_start" | "message_end", event: Record<string, unknown>): void {
		const message = event.message;
		if (!isRecord(message) || message.role !== "assistant") return; // prompts arrive via appendPrompt
		const content = message.content;
		if (!Array.isArray(content)) return;
		if (kind === "message_start") {
			// A new assistant message supersedes any streamed state of the prior one.
			this.finalizeStreaming(buffer, "assistant");
			buffer.textByIndex.clear();
			return;
		}
		// message_end: the authoritative final message. Reconcile per content
		// block (contentIndex === content array index): streamed entries are
		// replaced with the authoritative text — never duplicated — and blocks
		// that were never streamed become entries here (message_end fallback).
		const claimed = new Set<FeedEntryInternal>();
		for (let i = 0; i < content.length; i++) {
			const part = content[i];
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
			const text = part.text;
			let entry = buffer.textByIndex.get(i);
			if (entry && claimed.has(entry)) entry = undefined;
			if (!entry) {
				// Dedup guard for drifted block indexes: claim a streamed entry
				// whose reconstructed text already equals the authoritative text.
				for (const candidate of buffer.textByIndex.values()) {
					if (!claimed.has(candidate) && candidate.parts.join("") === text) {
						entry = candidate;
						break;
					}
				}
			}
			if (!entry) {
				entry = this.addEntry(buffer, "assistant");
				buffer.textByIndex.set(i, entry);
			}
			claimed.add(entry);
			this.replaceEntryText(buffer, entry, text);
			if (entry.streaming) {
				entry.streaming = false;
				this.bump(buffer);
			}
		}
		// Streamed blocks absent from the final message are superseded partials.
		for (const [index, entry] of [...buffer.textByIndex]) {
			if (claimed.has(entry)) continue;
			const at = buffer.entries.indexOf(entry);
			if (at !== -1) {
				buffer.entries.splice(at, 1);
				buffer.bytes -= entry.bytes;
				this.bump(buffer);
			}
			buffer.textByIndex.delete(index);
		}
		// The message is closed: its block state must not leak into the next one.
		buffer.textByIndex.clear();
	}

	/** message_update: delta-only assistant content blocks (thinking omitted). */
	private handleUpdate(buffer: JobBuffer, event: Record<string, unknown>): void {
		const inner = event.assistantMessageEvent;
		if (!isRecord(inner) || typeof inner.type !== "string") return;
		if (inner.type !== "text_start" && inner.type !== "text_delta" && inner.type !== "text_end") return;
		// thinking_* (hidden reasoning) and toolcall_* (rendered via bounded
		// tool_execution_* lifecycle summaries) are intentionally omitted.
		const index = asContentIndex(inner.contentIndex);
		if (index === undefined) return;
		if (inner.type === "text_start") {
			// A later block starting implies any earlier streamed block completed.
			if (!buffer.textByIndex.has(index)) this.finalizeStreaming(buffer, "assistant");
			return;
		}
		if (inner.type === "text_delta") {
			const delta = inner.delta;
			if (typeof delta !== "string" || delta.length === 0) return;
			let entry = buffer.textByIndex.get(index);
			if (!entry) {
				this.finalizeStreaming(buffer, "assistant");
				entry = this.addEntry(buffer, "assistant");
				entry.streaming = true;
				this.bump(buffer);
				buffer.textByIndex.set(index, entry);
			} else if (!entry.streaming) {
				entry.streaming = true;
				this.bump(buffer);
			}
			this.appendDelta(buffer, entry, delta);
			return;
		}
		// text_end: authoritative content for this block replaces streamed data.
		const content = inner.content;
		if (typeof content !== "string") return;
		let entry = buffer.textByIndex.get(index);
		if (!entry) {
			entry = this.addEntry(buffer, "assistant");
			buffer.textByIndex.set(index, entry);
		}
		this.replaceEntryText(buffer, entry, content);
		if (entry.streaming) {
			entry.streaming = false;
			this.bump(buffer);
		}
	}

	/** tool_execution_start: bounded name/status summary entry (args never serialized). */
	private handleToolStart(buffer: JobBuffer, event: Record<string, unknown>): void {
		const callId = asId(event.toolCallId);
		if (!callId) return;
		const name = toolNameOf(event.toolName);
		const existing = buffer.toolById.get(callId);
		if (existing) {
			// Duplicate start: reuse the same lifecycle entry, never duplicate it.
			existing.toolName = name;
			this.replaceEntryText(buffer, existing, `${name} · running`);
			if (!existing.streaming) {
				existing.streaming = true;
				this.bump(buffer);
			}
			return;
		}
		const entry = this.addEntry(buffer, "tool", `${name} · running`);
		entry.toolName = name;
		entry.streaming = true;
		this.bump(buffer);
		buffer.toolById.set(callId, entry);
	}

	/** tool_execution_end: finalize the lifecycle summary with done/failed status. */
	private handleToolEnd(buffer: JobBuffer, event: Record<string, unknown>): void {
		const callId = asId(event.toolCallId);
		if (!callId) return;
		const status = event.isError === true ? "failed" : "done";
		const existing = buffer.toolById.get(callId);
		const name = typeof event.toolName === "string" && event.toolName.length > 0 ? toolNameOf(event.toolName) : existing?.toolName ?? "tool";
		const summary = `${name} · ${status}`;
		if (!existing) {
			// End without start (adversarial/gapped stream): bounded summary entry.
			const entry = this.addEntry(buffer, "tool", summary);
			entry.toolName = name;
			buffer.toolById.set(callId, entry);
			return;
		}
		existing.toolName = name;
		this.replaceEntryText(buffer, existing, summary);
		if (existing.streaming) {
			existing.streaming = false;
			this.bump(buffer);
		}
	}

	// ── Bounded entry/text bookkeeping ────────────────────────────────────────

	private bump(buffer: JobBuffer): void {
		buffer.revision++;
		buffer.cached = undefined;
	}

	private notify(jobId: string): void {
		for (const listener of this.listeners) {
			try {
				listener(jobId);
			} catch {
				/* observer isolation: a bad listener never affects the feed */
			}
		}
	}

	private addEntry(buffer: JobBuffer, role: FeedEntryInternal["role"], text?: string): FeedEntryInternal {
		const entry: FeedEntryInternal = {
			id: `${buffer.jobId}#${++buffer.seq}`,
			role,
			at: Date.now(),
			parts: [],
			bytes: 0,
			streaming: false,
		};
		buffer.entries.push(entry);
		while (buffer.entries.length > MAX_FEED_ENTRIES) {
			const dropped = buffer.entries.shift();
			if (!dropped) break;
			buffer.bytes -= dropped.bytes;
			buffer.truncated = true;
			this.purgeRefs(buffer, dropped);
		}
		this.bump(buffer);
		if (text !== undefined) this.replaceEntryText(buffer, entry, text);
		return entry;
	}

	/** Replace an entry's text with authoritative content (bounded, dedup-safe). */
	private replaceEntryText(buffer: JobBuffer, entry: FeedEntryInternal, text: string): void {
		if (entry.parts.length === 1 && entry.bytes === Buffer.byteLength(text, "utf8") && entry.parts[0] === text) return;
		buffer.bytes -= entry.bytes;
		entry.parts = [];
		entry.bytes = 0;
		const bytes = Buffer.byteLength(text, "utf8");
		while (buffer.bytes + bytes > MAX_FEED_TEXT_BYTES && this.dropOldestExcluding(buffer, entry)) {
			/* make room by dropping older entries first (live feed keeps newest) */
		}
		const room = MAX_FEED_TEXT_BYTES - buffer.bytes;
		let finalText = text;
		let finalBytes = bytes;
		if (finalBytes > room) {
			finalText = truncateUtf8(text, room);
			finalBytes = Buffer.byteLength(finalText, "utf8");
			buffer.truncated = true;
		}
		if (finalBytes > 0) {
			entry.parts = [finalText];
			entry.bytes = finalBytes;
			buffer.bytes += finalBytes;
		}
		this.bump(buffer);
	}

	/** Append one bounded delta segment to a streaming entry (never re-joins per token). */
	private appendDelta(buffer: JobBuffer, entry: FeedEntryInternal, delta: string): void {
		let deltaBytes = Buffer.byteLength(delta, "utf8");
		if (deltaBytes === 0) return;
		while (buffer.bytes + deltaBytes > MAX_FEED_TEXT_BYTES && this.dropOldestExcluding(buffer, entry)) {
			/* keep the newest streaming content alive by dropping older entries */
		}
		const room = MAX_FEED_TEXT_BYTES - buffer.bytes;
		if (deltaBytes > room) {
			const clipped = truncateUtf8(delta, room);
			deltaBytes = Buffer.byteLength(clipped, "utf8");
			buffer.truncated = true;
			if (deltaBytes === 0) return;
			entry.parts.push(clipped);
		} else {
			entry.parts.push(delta);
		}
		entry.bytes += deltaBytes;
		buffer.bytes += deltaBytes;
		if (entry.parts.length >= MAX_ENTRY_PARTS) entry.parts = [entry.parts.join("")];
		this.bump(buffer);
	}

	/** Drop the oldest entry that is not `keep`; marks truncation. */
	private dropOldestExcluding(buffer: JobBuffer, keep: FeedEntryInternal): boolean {
		for (let i = 0; i < buffer.entries.length; i++) {
			const dropped = buffer.entries[i];
			if (dropped === keep) continue;
			buffer.entries.splice(i, 1);
			buffer.bytes -= dropped.bytes;
			buffer.truncated = true;
			this.purgeRefs(buffer, dropped);
			this.bump(buffer);
			return true;
		}
		return false;
	}

	/** Remove any map references to a dropped entry. */
	private purgeRefs(buffer: JobBuffer, entry: FeedEntryInternal): void {
		for (const [index, ref] of buffer.textByIndex) if (ref === entry) buffer.textByIndex.delete(index);
		for (const [id, ref] of buffer.toolById) if (ref === entry) buffer.toolById.delete(id);
	}

	/**
	 * Mark still-streaming entries as settled. Assistant text blocks settle on
	 * message boundaries; tool entries settle only at tool end or run end
	 * (`all`), so a mid-flight tool is never falsely finalized.
	 */
	private finalizeStreaming(buffer: JobBuffer, scope: "assistant" | "all" = "assistant"): void {
		let changed = false;
		for (const entry of buffer.entries) {
			if (entry.streaming && (scope === "all" || entry.role === "assistant")) {
				entry.streaming = false;
				changed = true;
			}
		}
		if (changed) this.bump(buffer);
	}

	// ── LRU capacity ──────────────────────────────────────────────────────────

	private createBuffer(jobId: string): JobBuffer {
		if (this.buffers.size >= MAX_JOB_BUFFERS) {
			// Victim: least-recently-used, preferring finished buffers over active runs.
			let victim: string | undefined;
			let victimRank = Number.POSITIVE_INFINITY;
			for (const [id, buffer] of this.buffers) {
				const rank = (buffer.active ? 1e15 : 0) + buffer.lastUsed;
				if (rank < victimRank) {
					victimRank = rank;
					victim = id;
				}
			}
			if (victim !== undefined) {
				const evicted = this.buffers.get(victim)!;
				this.buffers.delete(victim);
				// Truthful tombstone: reads for this job report truncated (history gone).
				this.tombstones.set(victim, { jobId: victim, attemptId: evicted.attemptId, revision: evicted.revision + 1, entries: [], truncated: true });
				while (this.tombstones.size > MAX_TOMBSTONES) {
					const oldest = this.tombstones.keys().next().value;
					if (oldest === undefined) break;
					this.tombstones.delete(oldest);
				}
			}
		}
		const buffer: JobBuffer = {
			jobId,
			active: false,
			revision: 0,
			seq: 0,
			entries: [],
			bytes: 0,
			truncated: false,
			textByIndex: new Map(),
			toolById: new Map(),
			lastUsed: ++this.useClock,
		};
		this.buffers.set(jobId, buffer);
		return buffer;
	}
}
