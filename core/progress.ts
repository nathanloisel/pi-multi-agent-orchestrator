/**
 * core/progress.ts — pure live-progress model + formatter for the main
 * session widget (Plan / Now / counts). No I/O, no theming, fully
 * deterministic: tests assert on plain strings.
 *
 * The display is a PROJECTION of persisted job state (JobRecord) — it never
 * owns a second copy of runtime truth. Tasks map to six distinct display
 * states; "waiting" (retry pending) and "ready" render as queued, never as
 * running, so dependency-blocked or between-attempts jobs can't fake progress.
 */

import type { EventType } from "./events.ts";
import type { JobRecord, JobStatus } from "./types.ts";

/** Custom session-entry type used to persist which job ids the CURRENT main
 * session branch owns/references. Membership only — never a second copy of
 * job state (job.json stays the sole source of truth). */
export const PROGRESS_MEMBERSHIP_ENTRY_TYPE = "orchestrator.progress-jobs";

/** Pure: collect tracked job ids from branch session entries (first-seen
 * order, deduped). Only this branch's entries are passed in by the caller, so
 * a second main session in the same cwd can never inherit another session's
 * jobs. */
export function collectMembershipJobIds(entries: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		const e = entry as { type?: string; customType?: string; data?: { jobIds?: unknown } } | null;
		if (!e || e.type !== "custom" || e.customType !== PROGRESS_MEMBERSHIP_ENTRY_TYPE) continue;
		const raw = e.data?.jobIds;
		if (!Array.isArray(raw)) continue;
		for (const id of raw) {
			if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}

/** Map a runtime event type to the tool-visible progress state it confirms.
 * Returns null for events that do NOT confirm a state (provider/validation/
 * budget internals, terminal states — terminal truth arrives via the final
 * tool report, never a pre-claim)."running" is ONLY returned for
 * attempt.started: a scheduler/validation phase before it is not running. */
export function stateFromEventType(type: EventType): "queued" | "running" | null {
	switch (type) {
		case "job.created":
		case "job.ready":
		case "job.blocked":
			return "queued";
		case "attempt.started":
			return "running";
		default:
			return null;
	}
}

export type ProgressTaskState = "queued" | "blocked" | "running" | "done" | "failed" | "cancelled";

export interface ProgressTask {
	jobId: string;
	shortId: string;
	agent: string;
	label: string;
	state: ProgressTaskState;
	attempts: number;
	createdAt: number;
	updatedAt: number;
}

const STATE_ICONS: Record<ProgressTaskState, string> = {
	queued: "○",
	blocked: "⊘",
	running: "▶",
	done: "✓",
	failed: "✗",
	cancelled: "×",
};

export function isActiveState(state: ProgressTaskState): boolean {
	return state === "queued" || state === "blocked" || state === "running";
}

/** Map persisted JobStatus → one of the six display states. */
export function stateForJobStatus(status: JobStatus): ProgressTaskState {
	switch (status) {
		case "running":
			return "running";
		case "blocked":
			return "blocked";
		case "success":
			return "done";
		case "failed":
		case "interrupted":
			return "failed";
		case "cancelled":
			return "cancelled";
		default:
			// queued | ready | waiting → not running (waiting = retry pending)
			return "queued";
	}
}

/** Stable short display id: the meaningful slug between the auto-generated
 * `agent--…--suffix` markers, or the whole id (explicit ids pass through). */
export function shortJobId(jobId: string, max = 18): string {
	const parts = jobId.split("--");
	const core = parts.length >= 3 ? parts.slice(1, -1).join("--") : jobId;
	const id = core || jobId;
	return id.length > max ? `${id.slice(0, Math.max(1, max - 1))}…` : id;
}

/** First meaningful line of the objective as a short single-line label. */
export function shortLabel(objective: string, max = 48): string {
	const first = objective.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	const clean = first
		.replace(/^#+\s*/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/\s+/g, " ");
	return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

export function taskFromJob(job: JobRecord): ProgressTask {
	return {
		jobId: job.jobId,
		shortId: shortJobId(job.jobId),
		agent: job.agent,
		label: shortLabel(job.objective),
		state: stateForJobStatus(job.status),
		attempts: job.attemptCount,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
	};
}

/** Pure snapshot from persisted jobs, in stable creation order. */
export function buildSnapshot(jobs: JobRecord[]): ProgressTask[] {
	return [...jobs].sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId)).map(taskFromJob);
}

export interface RenderOptions {
	/** Max task rows; both active and finished rows are capped, with truthful
	 * overflow lines for whatever is hidden. */
	maxTasks?: number;
	/** Max job ids named on the Now line (default 3). */
	maxNow?: number;
	/** Optional colorizer applied to task rows only (pure in, styled out). */
	paint?: (task: ProgressTask, line: string) => string;
}

/**
 * Render widget lines: "Plan" header, a "Now:" line (capped) naming actually
 * running tasks, capped task rows in stable order (active first, then most
 * recently finished), truthful overflow lines for hidden ACTIVE and finished
 * work, and a counts footer. Readable state words accompany ambiguous icons.
 */
export function renderProgress(tasks: ProgressTask[], opts: RenderOptions = {}): string[] {
	if (tasks.length === 0) return [];
	const maxTasks = Math.max(1, opts.maxTasks ?? 9);
	const maxNow = Math.max(1, opts.maxNow ?? 3);
	const active = tasks.filter((t) => isActiveState(t.state));
	const finished = tasks
		.filter((t) => !isActiveState(t.state))
		.sort((a, b) => b.updatedAt - a.updatedAt || a.jobId.localeCompare(b.jobId));
	const shownActive = active.slice(0, maxTasks);
	const shownFinished = finished.slice(0, Math.max(0, maxTasks - shownActive.length));

	const STATE_WORDS: Partial<Record<ProgressTaskState, string>> = {
		queued: "queued",
		blocked: "blocked",
		failed: "failed",
		cancelled: "cancelled",
	};
	const row = (t: ProgressTask) => {
		const attempts = t.attempts > 1 ? ` ↻${t.attempts}` : "";
		const word = STATE_WORDS[t.state] ? ` · ${STATE_WORDS[t.state]}` : "";
		const line = `${STATE_ICONS[t.state]} #${t.shortId} ${t.label}${attempts}${word}`;
		return opts.paint ? opts.paint(t, line) : line;
	};

	const lines = ["Plan"];
	const running = active.filter((t) => t.state === "running");
	if (running.length > 0) {
		const shown = running.slice(0, maxNow).map((t) => `#${t.shortId}`);
		const hidden = running.length - shown.length;
		lines.push(`Now: ${shown.join(", ")}${hidden > 0 ? ` +${hidden} more` : ""}`);
	}
	for (const t of shownActive) lines.push(row(t));
	for (const t of shownFinished) lines.push(row(t));
	const hiddenActive = active.length - shownActive.length;
	if (hiddenActive > 0) {
		const r = active.filter((t) => t.state === "running").length;
		lines.push(`… +${hiddenActive} active hidden (${r} running)`);
	}
	const hiddenFinished = finished.length - shownFinished.length;
	if (hiddenFinished > 0) lines.push(`… +${hiddenFinished} finished earlier`);
	const done = finished.filter((t) => t.state === "done").length;
	const failed = finished.filter((t) => t.state === "failed").length;
	lines.push(`${done}/${tasks.length} done${failed > 0 ? ` · ${failed} failed` : ""}`);
	return lines;
}

/** Compact footer status text ("2 running · 1 pending · 3/6 done"). */
export function progressStatusText(tasks: ProgressTask[]): string {
	if (tasks.length === 0) return "";
	const running = tasks.filter((t) => t.state === "running").length;
	const pending = tasks.filter((t) => t.state === "queued" || t.state === "blocked").length;
	const done = tasks.filter((t) => t.state === "done").length;
	const failed = tasks.filter((t) => t.state === "failed").length;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (pending > 0) parts.push(`${pending} pending`);
	parts.push(`${done}/${tasks.length} done`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.join(" · ");
}

/** In-memory projection used by the extension: syncs from persisted JobRecords,
 * keeps stable first-seen order, and prunes oldest FINISHED tasks first so
 * active work is never dropped and history can't grow unbounded. */
export class ProgressTracker {
	private order: string[] = [];
	private tasks = new Map<string, ProgressTask>();

	constructor(private readonly maxTracked = 48) {}

	get size(): number {
		return this.order.length;
	}

	has(jobId: string): boolean {
		return this.tasks.has(jobId);
	}

	/** Upsert from persisted job records; returns true when the display changed. */
	sync(jobs: JobRecord[]): boolean {
		let changed = false;
		for (const job of jobs) {
			const task = taskFromJob(job);
			const prev = this.tasks.get(job.jobId);
			if (prev && sameTask(prev, task)) continue;
			if (!prev) this.order.push(job.jobId);
			this.tasks.set(job.jobId, task);
			changed = true;
		}
		if (this.order.length > this.maxTracked) this.prune();
		return changed;
	}

	snapshot(): ProgressTask[] {
		return this.order.map((id) => this.tasks.get(id)).filter((t): t is ProgressTask => Boolean(t));
	}

	clear(): void {
		this.order = [];
		this.tasks.clear();
	}

	/** Shrink history by dropping oldest FINISHED tasks only. Active work is
	 * NEVER silently dropped — the tracker may exceed maxTracked while active
	 * tasks outnumber the cap. */
	private prune(): void {
		while (this.order.length > this.maxTracked) {
			const candidate = this.order.find((id) => {
				const t = this.tasks.get(id);
				return t && !isActiveState(t.state);
			});
			if (!candidate) break;
			this.order = this.order.filter((id) => id !== candidate);
			this.tasks.delete(candidate);
		}
	}
}

function sameTask(a: ProgressTask, b: ProgressTask): boolean {
	return (
		a.state === b.state &&
		a.label === b.label &&
		a.shortId === b.shortId &&
		a.agent === b.agent &&
		a.attempts === b.attempts &&
		a.updatedAt === b.updatedAt
	);
}
