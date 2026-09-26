/**
 * workers-dashboard.ts — the /workers overlay dashboard UI (standalone).
 *
 * A single keyboard-operable Component showing multiple worker panes
 * (header + bounded transcript viewport + per-pane Input prompt) in an adaptive
 * grid that wraps to side-by-side, 2x2, and single-column layouts as width
 * allows, and paginates rows when the terminal height cannot hold every pane.
 *
 * Kept independent of core/ by design: createWorkersDashboard() receives a
 * structural WorkerDashboardBackend (see workers-dashboard-model.ts) and a
 * tiny host seam. The integration layer wires it into `ctx.ui.custom()`:
 *
 *   const dashboard = createWorkersDashboard(backend, {
 *     requestRender: () => tui.requestRender(),
 *     close: () => done(),
 *     getHeight: () => tui.terminal.rows,
 *   }, { theme, initialJobIds });
 *   return dashboard; // Component & { dispose() }
 *
 * Keybindings (handled here; no command registration in this module):
 *   Ctrl+O       open in-overlay job picker (arrows/Enter open, Esc cancels)
 *   Ctrl+W       close the focused pane
 *   Tab/Shift+Tab cycle pane focus
 *   PgUp/PgDn    scroll the focused transcript
 *   End          follow latest output in the focused pane
 *   Escape       close the dashboard (outside the picker)
 *   Enter        send the prompt to the focused ACTIVE canSend worker
 *
 * Rendering is event-driven: backend bursts coalesce into one <=33ms scheduled
 * render (injectable for tests), transcript wrapping is cached per
 * jobId/revision/width, and only visible panes are read/wrapped. dispose()
 * cancels scheduled renders, unsubscribes, and guards late send completions.
 */

import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import {
	COALESCE_MS,
	DEFAULT_OPEN_PANES,
	MAX_BODY_BYTES,
	MAX_OPEN_PANES,
	MIN_PANE_HEIGHT,
	PANE_GAP,
	TOOLBAR_LINES,
	clampInt,
	computeDashboardLayout,
	defaultOpenJobIds,
	inputAvailability,
	sanitizeWorkerText,
	utf8ByteLength,
	type DashboardEntry,
	type DashboardJob,
	type DashboardSnapshot,
	type WorkerDashboardBackend,
} from "./workers-dashboard-model.ts";

// ── Public types ────────────────────────────────────────────────────────────

export type DashboardThemeColor = "accent" | "border" | "success" | "error" | "warning" | "muted" | "dim" | "text";

/** Structural theme seam (pi's Theme satisfies it). */
export interface DashboardTheme {
	fg(color: DashboardThemeColor, text: string): string;
}

/** Host seam supplied by the integration layer. */
export interface WorkersDashboardHost {
	requestRender(): void;
	close(): void;
	getHeight(): number;
}

/** Injectable scheduler: runs `callback` after `delayMs`, returns a cancel fn. */
export type DashboardScheduler = (callback: () => void, delayMs: number) => () => void;

export interface WorkersDashboardOptions {
	/** Styling seam; defaults to an identity theme. */
	theme?: DashboardTheme;
	/** Explicit panes to open on startup (deduped, capped at MAX_OPEN_PANES). */
	initialJobIds?: string[];
	/** Injected scheduler for deterministic tests (default: setTimeout). */
	schedule?: DashboardScheduler;
	/** Injected transcript wrapper for deterministic tests (default: wrapTextWithAnsi). */
	wrap?: (text: string, width: number) => string[];
}

export interface WorkersDashboardHandle extends Component, Focusable {
	handleInput(data: string): void;
	dispose(): void;
}

// ── Internal state ──────────────────────────────────────────────────────────

interface PaneScroll {
	offset: number;
	follow: boolean;
}

interface PaneNotice {
	kind: "ok" | "error" | "info";
	text: string;
}

interface WrapCacheEntry {
	revision: number;
	width: number;
	lines: string[];
}

const IDENTITY_THEME: DashboardTheme = {
	fg(_color, text) {
		return text;
	},
};

const defaultSchedule: DashboardScheduler = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
};

const ROLE_LABEL: Record<DashboardEntry["role"], string> = {
	assistant: "assistant",
	tool: "tool",
	system: "system",
	user: "user",
};

const ROLE_COLOR: Record<DashboardEntry["role"], DashboardThemeColor> = {
	assistant: "text",
	tool: "muted",
	system: "dim",
	user: "accent",
};

const KEY_HINTS = "Ctrl+O picker · Ctrl+W close pane · Tab/Shift+Tab focus · PgUp/PgDn scroll · End follow · Enter send · Esc close";

// ── Component ───────────────────────────────────────────────────────────────

class WorkersDashboard implements WorkersDashboardHandle {
	// Focusable: the focused pane's Input emits the CURSOR_MARKER through us.
	focused = false;

	private readonly backend: WorkerDashboardBackend;
	private readonly host: WorkersDashboardHost;
	private readonly theme: DashboardTheme;
	private readonly schedule: DashboardScheduler;
	private readonly wrapFn: (text: string, width: number) => string[];

	private openJobIds: string[];
	private focusIndex: number;
	private readonly inputs = new Map<string, Input>();
	private readonly scrolls = new Map<string, PaneScroll>();
	private readonly pending = new Set<string>();
	private readonly notices = new Map<string, PaneNotice>();
	private readonly wrapCache = new Map<string, WrapCacheEntry>();
	private readonly lastViewport = new Map<string, number>();
	private globalNotice: string | null = null;
	private pickerOpen = false;
	private pickerIndex = 0;

	private disposed = false;
	private cancelScheduled: (() => void) | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(backend: WorkerDashboardBackend, host: WorkersDashboardHost, options: WorkersDashboardOptions = {}) {
		this.backend = backend;
		this.host = host;
		this.theme = options.theme ?? IDENTITY_THEME;
		this.schedule = options.schedule ?? defaultSchedule;
		this.wrapFn = options.wrap ?? ((text, width) => wrapTextWithAnsi(text, width));

		if (options.initialJobIds !== undefined) {
			const seen = new Set<string>();
			const ids: string[] = [];
			for (const id of options.initialJobIds) {
				if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
				seen.add(id);
				ids.push(id);
			}
			this.openJobIds = ids.slice(0, MAX_OPEN_PANES);
			if (ids.length > MAX_OPEN_PANES) {
				this.globalNotice = `${ids.length - MAX_OPEN_PANES} initial panes over the ${MAX_OPEN_PANES}-pane limit were not opened — Ctrl+O to pick`;
			}
		} else {
			this.openJobIds = defaultOpenJobIds(this.safeList(), DEFAULT_OPEN_PANES);
		}
		this.focusIndex = this.openJobIds.length > 0 ? 0 : -1;
		this.unsubscribe = this.backend.subscribe(this.onBackendEvent);
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.cancelScheduled) {
			const cancel = this.cancelScheduled;
			this.cancelScheduled = null;
			cancel();
		}
		if (this.unsubscribe) {
			const unsubscribe = this.unsubscribe;
			this.unsubscribe = null;
			unsubscribe();
		}
		this.wrapCache.clear();
	}

	invalidate(): void {
		// Theme or full-state rebuild: cached wrapped transcripts may be stale.
		this.wrapCache.clear();
	}

	private closeDashboard(): void {
		this.dispose();
		this.host.close();
	}

	// ── backend events ──────────────────────────────────────────────────────

	private readonly onBackendEvent = (): void => {
		if (this.disposed) return;
		if (this.cancelScheduled) return; // one pending scheduled render per burst
		this.cancelScheduled = this.schedule(() => {
			this.cancelScheduled = null;
			if (this.disposed) return;
			this.host.requestRender();
		}, COALESCE_MS);
	};

	// ── input handling ──────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.pickerOpen) {
			this.handlePickerInput(data);
			this.host.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("o"))) {
			this.openPicker();
		} else if (matchesKey(data, Key.ctrl("w"))) {
			this.closeFocusedPane();
		} else if (matchesKey(data, Key.tab)) {
			this.cycleFocus(1);
		} else if (matchesKey(data, "shift+tab")) {
			this.cycleFocus(-1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollFocused(-1);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollFocused(1);
		} else if (matchesKey(data, Key.end)) {
			this.followLatest();
		} else if (matchesKey(data, Key.escape)) {
			this.closeDashboard();
			return;
		} else {
			const jobId = this.focusedJobId();
			if (jobId !== null) {
				const input = this.inputFor(jobId);
				this.notices.delete(jobId);
				input.handleInput(data);
			}
		}
		this.host.requestRender();
	}

	private handlePickerInput(data: string): void {
		const jobs = this.safeList();
		if (matchesKey(data, Key.escape)) {
			this.pickerOpen = false;
			this.globalNotice = null;
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.pickerIndex = clampInt(this.pickerIndex - 1, 0, Math.max(0, jobs.length - 1));
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.pickerIndex = clampInt(this.pickerIndex + 1, 0, Math.max(0, jobs.length - 1));
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const job = jobs[this.pickerIndex];
			if (job) this.openJob(job.id);
		}
	}

	private openPicker(): void {
		const jobs = this.safeList();
		this.pickerOpen = true;
		const focused = this.focusedJobId();
		const at = focused === null ? -1 : jobs.findIndex((job) => job.id === focused);
		this.pickerIndex = clampInt(at >= 0 ? at : 0, 0, Math.max(0, jobs.length - 1));
	}

	private openJob(jobId: string): void {
		const existing = this.openJobIds.indexOf(jobId);
		if (existing >= 0) {
			this.focusIndex = existing;
			this.pickerOpen = false;
			this.globalNotice = null;
			return;
		}
		if (this.openJobIds.length >= MAX_OPEN_PANES) {
			this.globalNotice = `Pane limit reached (${MAX_OPEN_PANES} panes) — close one first (Ctrl+W)`;
			return;
		}
		this.openJobIds.push(jobId);
		this.focusIndex = this.openJobIds.length - 1;
		this.pickerOpen = false;
		this.globalNotice = null;
	}

	private closeFocusedPane(): void {
		if (this.focusIndex < 0 || this.focusIndex >= this.openJobIds.length) return;
		this.openJobIds.splice(this.focusIndex, 1);
		if (this.openJobIds.length === 0) {
			this.focusIndex = -1;
		} else {
			this.focusIndex = Math.min(this.focusIndex, this.openJobIds.length - 1);
		}
		this.globalNotice = null;
	}

	private cycleFocus(direction: 1 | -1): void {
		const n = this.openJobIds.length;
		if (n === 0) return;
		this.focusIndex = ((this.focusIndex + direction) % n + n) % n;
	}

	private focusedJobId(): string | null {
		if (this.focusIndex < 0 || this.focusIndex >= this.openJobIds.length) return null;
		return this.openJobIds[this.focusIndex] ?? null;
	}

	private scrollState(jobId: string): PaneScroll {
		let scroll = this.scrolls.get(jobId);
		if (!scroll) {
			scroll = { offset: 0, follow: true };
			this.scrolls.set(jobId, scroll);
		}
		return scroll;
	}

	/** Page step: one viewport worth of wrapped lines (normalized by direction). */
	private scrollFocused(direction: 1 | -1): void {
		const jobId = this.focusedJobId();
		if (jobId === null) return;
		const scroll = this.scrollState(jobId);
		const vt = Math.max(1, this.lastViewport.get(jobId) ?? MIN_PANE_HEIGHT);
		const total = this.wrapCache.get(jobId)?.lines.length ?? 0;
		const maxOffset = Math.max(0, total - vt);
		scroll.follow = false;
		scroll.offset = clampInt(scroll.offset + direction * vt, 0, maxOffset);
	}

	private followLatest(): void {
		const jobId = this.focusedJobId();
		if (jobId === null) return;
		const scroll = this.scrollState(jobId);
		scroll.follow = true;
		scroll.offset = 0;
	}

	// ── prompt submission (ACK-gated) ───────────────────────────────────────

	private inputFor(jobId: string): Input {
		let input = this.inputs.get(jobId);
		if (!input) {
			input = new Input({ prompt: "> ", placeholder: "message worker… (Enter sends)" });
			input.onSubmit = (value: string) => this.submit(jobId, value);
			this.inputs.set(jobId, input);
		}
		return input;
	}

	private submit(jobId: string, value: string): void {
		if (this.disposed) return;
		const job = this.safeList().find((candidate) => candidate.id === jobId) ?? {
			id: jobId,
			title: jobId,
			status: "unknown",
			canSend: false,
		};
		// Terminal/waiting/offline workers never receive prompts; explain inline.
		const availability = inputAvailability(job);
		if (!availability.ok) {
			this.notices.set(jobId, { kind: "info", text: `input disabled — ${availability.reason}` });
			this.host.requestRender();
			return;
		}
		// Prevent duplicate submissions while an ACK is pending.
		if (this.pending.has(jobId)) {
			this.notices.set(jobId, { kind: "info", text: "still sending — waiting for ACK" });
			this.host.requestRender();
			return;
		}
		// Empty submit is ignored.
		if (value.trim().length === 0) return;
		const bytes = utf8ByteLength(value);
		if (bytes > MAX_BODY_BYTES) {
			this.notices.set(jobId, { kind: "error", text: `message too large (${bytes} B, max ${MAX_BODY_BYTES} B)` });
			this.host.requestRender();
			return;
		}
		this.pending.add(jobId);
		this.notices.set(jobId, { kind: "info", text: "sending…" });
		this.host.requestRender();
		let send: Promise<void>;
		try {
			send = this.backend.send(jobId, value);
		} catch (err) {
			this.settleSend(jobId, null, err);
			return;
		}
		void send.then(
			() => this.settleSend(jobId, true, null),
			(err: unknown) => this.settleSend(jobId, false, err),
		);
	}

	private settleSend(jobId: string, ok: boolean | null, err: unknown): void {
		// Guard late completions after dispose: no state churn, no render.
		if (this.disposed) return;
		this.pending.delete(jobId);
		if (ok === true) {
			// Clear the draft and show "delivered" ONLY on ACK success.
			this.inputs.get(jobId)?.setValue("");
			this.notices.set(jobId, { kind: "ok", text: "✓ delivered" });
		} else {
			// Keep the draft on failure (or synchronous throw).
			const message = err instanceof Error ? err.message : String(err);
			this.notices.set(jobId, { kind: "error", text: `✗ send failed: ${message}` });
		}
		this.host.requestRender();
	}

	// ── rendering ───────────────────────────────────────────────────────────

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(this.host.getHeight()));
		const jobs = this.safeList();
		const jobMap = new Map(jobs.map((job) => [job.id, job]));
		const lines: string[] = [];
		lines.push(this.renderHintBar(w));
		lines.push(this.renderNoticeBar(w, jobs));
		const bodyHeight = Math.max(0, h - TOOLBAR_LINES);
		const body = this.pickerOpen ? this.renderPicker(w, bodyHeight, jobs) : this.renderPanes(w, bodyHeight, jobMap);
		lines.push(...body);
		// Bounded output: never exceed the host height, never exceed the width.
		return lines.slice(0, h).map((line) => (visibleWidth(line) > w ? truncateToWidth(line, w) : line));
	}

	private renderHintBar(w: number): string {
		return truncateToWidth(this.theme.fg("muted", KEY_HINTS), w);
	}

	private renderNoticeBar(w: number, jobs: readonly DashboardJob[]): string {
		const parts: string[] = [];
		if (this.globalNotice) parts.push(this.globalNotice);
		if (!this.pickerOpen) {
			const openCount = this.openJobIds.length;
			const bodyHeight = Math.max(0, Math.floor(this.host.getHeight()) - TOOLBAR_LINES);
			const layout = computeDashboardLayout({ openCount, width: w, height: bodyHeight + TOOLBAR_LINES, focusIndex: this.focusIndex });
			if (!layout.tooSmall && layout.visibleCount < openCount) {
				parts.push(`panes ${layout.pageStart + 1}-${layout.pageStart + layout.visibleCount} of ${openCount}`);
			}
		}
		if (jobs.length > this.openJobIds.length) {
			parts.push(`${jobs.length - this.openJobIds.length} jobs not open (max ${MAX_OPEN_PANES} panes) — Ctrl+O picker`);
		}
		if (parts.length === 0) return "";
		return truncateToWidth(this.theme.fg("warning", parts.join("  ·  ")), w);
	}

	private renderPanes(w: number, bodyHeight: number, jobMap: ReadonlyMap<string, DashboardJob>): string[] {
		const openCount = this.openJobIds.length;
		if (openCount === 0) {
			return [truncateToWidth(this.theme.fg("muted", "No worker panes open — Ctrl+O opens the job picker"), w)];
		}
		const layout = computeDashboardLayout({ openCount, width: w, height: bodyHeight + TOOLBAR_LINES, focusIndex: this.focusIndex });
		if (layout.tooSmall) {
			return [truncateToWidth(this.theme.fg("warning", "Terminal too small for panes — resize, or Esc to close"), w)];
		}
		const lines: string[] = [];
		const rowsOnPage = Math.ceil(layout.visibleCount / layout.columns);
		for (let row = 0; row < rowsOnPage; row++) {
			const panes: string[][] = [];
			for (let col = 0; col < layout.columns; col++) {
				const index = layout.pageStart + row * layout.columns + col;
				if (index >= layout.pageStart + layout.visibleCount) break;
				const jobId = this.openJobIds[index];
				if (jobId === undefined) break;
				const job = jobMap.get(jobId) ?? { id: jobId, title: jobId, status: "unknown", canSend: false };
				panes.push(this.renderPane(job, index === this.focusIndex, layout.paneWidth, layout.paneHeight));
			}
			if (panes.length === 0) break;
			for (let li = 0; li < layout.paneHeight; li++) {
				lines.push(panes.map((pane) => pane[li] ?? " ".repeat(layout.paneWidth)).join(" ".repeat(PANE_GAP)));
			}
		}
		return lines;
	}

	private renderPane(job: DashboardJob, focused: boolean, paneW: number, paneH: number): string[] {
		// Tiny panes degrade to plain truncated lines (bounded, never crash).
		if (paneW < 4 || paneH < MIN_PANE_HEIGHT) {
			return this.renderTinyPane(job, paneW, paneH);
		}
		const th = this.theme;
		const innerW = paneW - 2;
		const border = (text: string) => th.fg(focused ? "accent" : "border", text);
		const lines: string[] = [];

		// Top border with id + scroll/follow marker.
		const marker = this.scrollState(job.id).follow ? "•" : "↑";
		const topLabel = sanitizeWorkerText(job.id) || job.id;
		const label = truncateToWidth(` ${topLabel} ${marker} `, innerW, "", true);
		const pad = Math.max(0, innerW - visibleWidth(label));
		lines.push(border("╭") + th.fg(focused ? "accent" : "muted", label) + border(`${"─".repeat(pad)}╮`));

		// Header: title + status tag; then id/agent/model/attempt as fits.
		const statusColor: DashboardThemeColor = inputAvailability(job).ok ? "success" : "muted";
		const title = truncateToWidth(sanitizeWorkerText(job.title) || job.id, Math.max(1, innerW - 4), "…");
		lines.push(border("│") + truncateToWidth(`${th.fg("text", title)} ${th.fg(statusColor, `[${sanitizeWorkerText(job.status)}]`)}`, innerW, "", true) + border("│"));
		const showMeta = paneH >= MIN_PANE_HEIGHT + 1;
		if (showMeta) {
			const parts = [job.id, job.agent, job.model, job.attemptId].filter((part): part is string => typeof part === "string" && part.length > 0);
			lines.push(border("│") + truncateToWidth(th.fg("muted", sanitizeWorkerText(parts.join(" · "))), innerW, "", true) + border("│"));
		}

		// Bounded transcript viewport (wrapped lines cached per jobId/revision/width).
		const viewport = Math.max(1, paneH - (showMeta ? 6 : 5));
		this.lastViewport.set(job.id, viewport);
		const wrapped = this.wrappedTranscript(job.id, innerW);
		const scroll = this.scrollState(job.id);
		const maxOffset = Math.max(0, wrapped.length - viewport);
		if (scroll.follow) scroll.offset = maxOffset;
		else scroll.offset = clampInt(scroll.offset, 0, maxOffset);
		for (let i = 0; i < viewport; i++) {
			const line = wrapped[scroll.offset + i] ?? "";
			lines.push(border("│") + truncateToWidth(line, innerW, "", true) + border("│"));
		}

		// Prompt input (only the focused pane shows the cursor).
		const input = this.inputFor(job.id);
		input.focused = focused && !this.pickerOpen;
		const [inputLine = ""] = input.render(innerW);
		lines.push(border("│") + truncateToWidth(inputLine, innerW, "", true) + border("│"));

		// Status / hint line.
		lines.push(border("│") + truncateToWidth(this.renderStatusLine(job, focused, wrapped.length, viewport, scroll), innerW, "", true) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines.map((line) => truncateToWidth(line, paneW, "", true));
	}

	private renderStatusLine(job: DashboardJob, focused: boolean, total: number, viewport: number, scroll: PaneScroll): string {
		const th = this.theme;
		const notice = this.notices.get(job.id);
		const indicators: string[] = [];
		if (!scroll.follow && scroll.offset > 0) indicators.push(`↑${scroll.offset}`);
		if (scroll.offset + viewport < total) indicators.push(`↓${total - scroll.offset - viewport}`);
		const indicator = indicators.length > 0 ? `${th.fg("warning", indicators.join(" "))} ` : "";
		if (notice) {
			const color: DashboardThemeColor = notice.kind === "error" ? "error" : notice.kind === "ok" ? "success" : "muted";
			return indicator + th.fg(color, notice.text);
		}
		const availability = inputAvailability(job);
		if (!availability.ok) {
			return indicator + th.fg("warning", `input disabled — ${availability.reason}`);
		}
		return indicator + th.fg("dim", focused ? "Enter send · PgUp/PgDn scroll · End follow" : "Tab to focus · type to draft");
	}

	private renderTinyPane(job: DashboardJob, paneW: number, paneH: number): string[] {
		const jobId = job.id;
		const viewport = Math.max(1, paneH - 2);
		const wrapped = this.wrappedTranscript(jobId, Math.max(1, paneW));
		const scroll = this.scrollState(jobId);
		const maxOffset = Math.max(0, wrapped.length - viewport);
		if (scroll.follow) scroll.offset = maxOffset;
		else scroll.offset = clampInt(scroll.offset, 0, maxOffset);
		const raw: string[] = [sanitizeWorkerText(job.id) || job.id];
		for (let i = 0; i < viewport; i++) raw.push(wrapped[scroll.offset + i] ?? "");
		raw.push(this.inputFor(jobId).getValue());
		return raw.slice(0, paneH).map((line) => truncateToWidth(line, paneW, "", true));
	}

	private renderPicker(w: number, bodyHeight: number, jobs: readonly DashboardJob[]): string[] {
		const th = this.theme;
		const lines: string[] = [];
		lines.push(truncateToWidth(th.fg("accent", "Open workers — ↑/↓ select · Enter open · Esc cancel"), w));
		const available = Math.max(0, bodyHeight - 2);
		this.pickerIndex = clampInt(this.pickerIndex, 0, Math.max(0, jobs.length - 1));
		const start = clampInt(this.pickerIndex - Math.floor(available / 2), 0, Math.max(0, jobs.length - available));
		for (let i = start; i < Math.min(jobs.length, start + available); i++) {
			const job = jobs[i]!;
			const selected = i === this.pickerIndex;
			const open = this.openJobIds.includes(job.id);
			const text = `${open ? "●" : "○"} ${sanitizeWorkerText(job.id)}  ${sanitizeWorkerText(job.title)}  [${sanitizeWorkerText(job.status)}]${job.agent ? `  ${sanitizeWorkerText(job.agent)}` : ""}`;
			lines.push(truncateToWidth(`${selected ? th.fg("accent", "> ") : "  "}${selected ? th.fg("text", text) : th.fg("muted", text)}`, w));
		}
		lines.push(truncateToWidth(th.fg("muted", `${jobs.length} jobs · ${this.openJobIds.length}/${MAX_OPEN_PANES} panes open`), w));
		return lines;
	}

	// ── transcript wrapping cache ───────────────────────────────────────────

	private wrappedTranscript(jobId: string, width: number): string[] {
		const cached = this.wrapCache.get(jobId);
		// Only visible panes reach this point; unchanged revision/width is a hit.
		let snapshot: DashboardSnapshot;
		try {
			snapshot = this.backend.read(jobId);
		} catch {
			snapshot = { jobId, revision: -1, entries: [], truncated: false };
		}
		if (cached && cached.revision === snapshot.revision && cached.width === width) {
			return cached.lines;
		}
		const th = this.theme;
		const chunks: string[] = [];
		if (snapshot.truncated) chunks.push(th.fg("dim", "… transcript truncated"));
		for (const entry of snapshot.entries) {
			const label = ROLE_LABEL[entry.role] ?? entry.role;
			const streaming = entry.streaming ? th.fg("accent", " ▍") : "";
			chunks.push(th.fg(ROLE_COLOR[entry.role] ?? "text", `[${label}] ${sanitizeWorkerText(entry.text)}`) + streaming);
		}
		const lines = this.wrapFn(chunks.join("\n"), Math.max(1, width));
		this.wrapCache.set(jobId, { revision: snapshot.revision, width, lines });
		return lines;
	}

	// ── helpers ─────────────────────────────────────────────────────────────

	private safeList(): readonly DashboardJob[] {
		try {
			return this.backend.list() ?? [];
		} catch {
			return [];
		}
	}
}

/**
 * Create the /workers dashboard component. Returns the Component to hand to
 * `ctx.ui.custom()` plus an idempotent dispose(). Closing the dashboard
 * (Escape) calls host.close() and disposes; the integration's `done()` maps to
 * host.close().
 */
export function createWorkersDashboard(
	backend: WorkerDashboardBackend,
	host: WorkersDashboardHost,
	options: WorkersDashboardOptions = {},
): WorkersDashboardHandle {
	return new WorkersDashboard(backend, host, options);
}
