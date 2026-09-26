/**
 * workers-dashboard-model.ts — structural backend contract + pure layout model
 * for the /workers overlay dashboard (workers-dashboard.ts).
 *
 * This module is intentionally independent of core/ so the dashboard UI can be
 * built and unit-tested in parallel with the transport work: the backend shape
 * below is the ONLY seam the UI needs. The integration layer supplies a real
 * implementation (job listing, transcript snapshots, ACK-gated sends) and the
 * overlay wiring; nothing here registers commands or touches transports.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

// ── Fixed structural backend contract ───────────────────────────────────────

export interface DashboardJob {
	id: string;
	title: string;
	status: string;
	agent?: string;
	model?: string;
	attemptId?: string;
	canSend: boolean;
}

export type DashboardRole = "assistant" | "tool" | "system" | "user";

export interface DashboardEntry {
	id: string;
	role: DashboardRole;
	text: string;
	at: number;
	streaming?: boolean;
}

export interface DashboardSnapshot {
	jobId: string;
	attemptId?: string;
	revision: number;
	entries: readonly DashboardEntry[];
	truncated: boolean;
}

export interface WorkerDashboardBackend {
	list(): DashboardJob[];
	read(jobId: string): DashboardSnapshot;
	subscribe(listener: () => void): () => void;
	send(jobId: string, text: string): Promise<void>;
}

// ── Layout / input constants ────────────────────────────────────────────────

/** Minimum useful pane width in terminal columns. */
export const MIN_PANE_WIDTH = 40;
/** Gap between adjacent panes, in columns. */
export const PANE_GAP = 1;
/** Minimum pane height in rows (header + transcript + prompt + border). */
export const MIN_PANE_HEIGHT = 7;
/** Hard cap on simultaneously open panes. */
export const MAX_OPEN_PANES = 8;
/** Default number of panes opened on startup. */
export const DEFAULT_OPEN_PANES = 4;
/** Maximum prompt body size, in UTF-8 bytes. */
export const MAX_BODY_BYTES = 4096;
/** Backend-event render coalescing window (ms). */
export const COALESCE_MS = 33;
/** Fixed toolbar lines (key hints + notice/counts row). */
export const TOOLBAR_LINES = 2;

/**
 * Statuses that mean the worker cannot accept a prompt and is not live.
 * Unknown statuses are treated as live/active (the `canSend` flag from the
 * backend stays the authoritative gate for submissions).
 */
export const UNAVAILABLE_STATUSES: ReadonlySet<string> = new Set([
	"done",
	"finished",
	"completed",
	"success",
	"succeeded",
	"failed",
	"error",
	"crashed",
	"cancelled",
	"canceled",
	"interrupted",
	"timeout",
	"timed_out",
	"expired",
	"offline",
	"waiting",
	"idle",
	"queued",
	"blocked",
	"ready",
	"pending",
	"dead",
	"killed",
	"aborted",
	"missing",
]);

function normalizeStatus(status: string): string {
	return (status ?? "").trim().toLowerCase();
}

/** A job is live when its status does not mean terminal/waiting/idle. */
export function isJobLive(job: DashboardJob): boolean {
	return !UNAVAILABLE_STATUSES.has(normalizeStatus(job.status));
}

/** A job is active when it is live (the `canSend` flag gates actual sends). */
export function isJobActive(job: DashboardJob): boolean {
	return isJobLive(job);
}

export interface InputAvailability {
	ok: boolean;
	reason: string;
}

/**
 * Whether the prompt input may submit to this job. Returns an explanation the
 * pane shows inline so finished/waiting/offline views stay readable.
 */
export function inputAvailability(job: DashboardJob): InputAvailability {
	if (!isJobActive(job)) {
		return { ok: false, reason: `status ${job.status} — input disabled` };
	}
	if (!job.canSend) {
		return { ok: false, reason: `worker not accepting input (status ${job.status})` };
	}
	return { ok: true, reason: "" };
}

/** UTF-8 byte length of a prompt body. */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Strip terminal escape/control sequences from worker-supplied content to
 * avoid terminal injection: ANSI/OSC/APC sequences first, then remaining C0
 * control bytes (newlines and tabs are kept).
 */
export function sanitizeWorkerText(text: string): string {
	const stripped = stripTerminalSequences(String(text ?? ""));
	// eslint-disable-next-line no-control-regex
	return stripped.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
}

// ── Default pane selection ──────────────────────────────────────────────────

/**
 * Default open set: the first `limit` live workers, filled with other (recent)
 * jobs when fewer than `limit` live workers exist. `jobs` order is treated as
 * recency order (most recent first).
 */
export function defaultOpenJobIds(jobs: readonly DashboardJob[], limit: number = DEFAULT_OPEN_PANES): string[] {
	const live = jobs.filter((job) => isJobLive(job));
	const other = jobs.filter((job) => !isJobLive(job));
	return [...live, ...other]
		.slice(0, Math.max(0, limit))
		.map((job) => job.id);
}

// ── Adaptive grid + pagination layout ───────────────────────────────────────

export interface DashboardLayout {
	/** Grid columns: min(openCount, max(1, floor((width + 1) / 41))). */
	columns: number;
	/** Grid rows for all open panes. */
	rows: number;
	/** Pane width in columns (gap included between panes). */
	paneWidth: number;
	/** Pane height in rows (>= MIN_PANE_HEIGHT when not tooSmall). */
	paneHeight: number;
	/** Rows shown per page at the current height. */
	pageRows: number;
	/** Index of the first visible pane (kept aligned to full grid rows). */
	pageStart: number;
	/** Number of panes visible on the current page. */
	visibleCount: number;
	/** True when the body area cannot fit even one minimum pane. */
	tooSmall: boolean;
}

/**
 * Compute the adaptive grid/pagination layout. Total rendered height is
 * TOOLBAR_LINES + the pane rows and never exceeds `height`; panes paginate when
 * the height cannot hold every row at MIN_PANE_HEIGHT.
 */
export function computeDashboardLayout(params: {
	openCount: number;
	width: number;
	height: number;
	focusIndex: number;
}): DashboardLayout {
	const openCount = Math.max(0, Math.floor(params.openCount));
	const width = Math.max(1, Math.floor(params.width));
	const height = Math.max(0, Math.floor(params.height));
	const focusIndex = Math.max(0, Math.floor(params.focusIndex || 0));
	const bodyHeight = height - TOOLBAR_LINES;
	const maxRows = Math.floor(bodyHeight / MIN_PANE_HEIGHT);
	const tooSmall = maxRows < 1;
	const columns = openCount === 0 ? 1 : Math.min(openCount, Math.max(1, Math.floor((width + 1) / (MIN_PANE_WIDTH + 1))));
	const rows = Math.max(1, Math.ceil(openCount / columns));
	const paneWidth = Math.max(1, Math.floor((width - (columns - 1) * PANE_GAP) / columns));
	if (openCount === 0 || tooSmall) {
		return {
			columns,
			rows,
			paneWidth,
			paneHeight: tooSmall ? 0 : Math.max(1, bodyHeight),
			pageRows: 0,
			pageStart: 0,
			visibleCount: 0,
			tooSmall,
		};
	}
	const pageRows = Math.min(rows, maxRows);
	const paneHeight = Math.max(MIN_PANE_HEIGHT, Math.floor(bodyHeight / pageRows));
	const perPage = pageRows * columns;
	const pageStart = Math.min(openCount - 1, Math.floor(focusIndex / perPage) * perPage);
	const visibleCount = Math.min(openCount - pageStart, perPage);
	return { columns, rows, paneWidth, paneHeight, pageRows, pageStart, visibleCount, tooSmall: false };
}

/** Clamp helper used by transcript scrolling. */
export function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	const v = Math.floor(value);
	if (max < min) return min;
	return Math.min(Math.max(v, min), max);
}
