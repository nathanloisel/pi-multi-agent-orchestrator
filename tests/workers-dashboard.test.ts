/**
 * tests/workers-dashboard.test.ts — /workers overlay dashboard UI tests.
 *
 * Exercises the real component handleInput()/render() against a fake
 * WorkerDashboardBackend and injected scheduler/wrapper (no pi TUI runtime):
 * adaptive grid (4 side-by-side -> 2x2 -> 1-column), pagination + tiny
 * terminals, Unicode/ANSI bounds, focus/open/close + draft preservation,
 * ACK-gated submission semantics, coalesced burst rendering, wrap caching,
 * offscreen panes, and disposal invariants.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	computeDashboardLayout,
	defaultOpenJobIds,
	inputAvailability,
	sanitizeWorkerText,
	utf8ByteLength,
	type DashboardEntry,
	type DashboardJob,
	type DashboardSnapshot,
	type WorkerDashboardBackend,
} from "../workers-dashboard-model.ts";
import {
	createWorkersDashboard,
	type DashboardTheme,
	type WorkersDashboardOptions,
} from "../workers-dashboard.ts";

// ── fakes ───────────────────────────────────────────────────────────────────

const identityTheme: DashboardTheme = { fg: (_color, text) => text };

class FakeBackend implements WorkerDashboardBackend {
	jobs: DashboardJob[] = [];
	snapshots = new Map<string, DashboardSnapshot>();
	listeners = new Set<() => void>();
	sendCalls: { jobId: string; text: string }[] = [];
	readCalls: string[] = [];
	sendImpl: (jobId: string, text: string) => Promise<void> = () => Promise.resolve();

	list(): DashboardJob[] {
		return [...this.jobs];
	}
	read(jobId: string): DashboardSnapshot {
		this.readCalls.push(jobId);
		return this.snapshots.get(jobId) ?? { jobId, revision: 0, entries: [], truncated: false };
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	send(jobId: string, text: string): Promise<void> {
		this.sendCalls.push({ jobId, text });
		return this.sendImpl(jobId, text);
	}
	emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

class FakeScheduler {
	scheduleCount = 0;
	pending: { cb: () => void; ms: number; cancelled: boolean } | null = null;
	/** Last scheduled callback, retained even after cancellation (late fire). */
	lastCb: (() => void) | null = null;
	lastMs = -1;

	schedule = (cb: () => void, ms: number): (() => void) => {
		this.scheduleCount++;
		const entry = { cb, ms, cancelled: false };
		this.pending = entry;
		this.lastCb = cb;
		this.lastMs = ms;
		return () => {
			entry.cancelled = true;
			if (this.pending === entry) this.pending = null;
		};
	};

	fire(): void {
		const entry = this.pending;
		this.pending = null;
		if (entry && !entry.cancelled) entry.cb();
	}
}

class FakeHost {
	renders = 0;
	closes = 0;
	height = 40;
	requestRender = (): void => {
		this.renders++;
	};
	close = (): void => {
		this.closes++;
	};
	getHeight = (): number => this.height;
}

function makeJob(id: string, over: Partial<DashboardJob> = {}): DashboardJob {
	return { id, title: `title-${id}`, status: "running", agent: `agent-${id}`, model: "m", attemptId: "att", canSend: true, ...over };
}

function makeEntry(id: string, text: string, over: Partial<DashboardEntry> = {}): DashboardEntry {
	return { id, role: "assistant", text, at: 0, ...over };
}

function setSnapshot(backend: FakeBackend, jobId: string, entries: DashboardEntry[], revision: number, truncated = false): void {
	backend.snapshots.set(jobId, { jobId, revision, entries, truncated });
}

interface Ctx {
	backend: FakeBackend;
	host: FakeHost;
	scheduler: FakeScheduler;
	wrapCalls: { text: string; width: number }[];
	dash: ReturnType<typeof createWorkersDashboard>;
}

function setup(jobs: DashboardJob[], options: WorkersDashboardOptions = {}, height = 40): Ctx {
	const backend = new FakeBackend();
	backend.jobs = jobs;
	const host = new FakeHost();
	host.height = height;
	const scheduler = new FakeScheduler();
	const wrapCalls: { text: string; width: number }[] = [];
	const dash = createWorkersDashboard(
		backend,
		host,
		{ theme: identityTheme, schedule: scheduler.schedule, wrap: (text, width) => {
			wrapCalls.push({ text, width });
			return wrapTextWithAnsi(text, width);
		}, ...options },
	);
	return { backend, host, scheduler, wrapCalls, dash };
}

function typeText(dash: Ctx["dash"], text: string): void {
	for (const ch of text) dash.handleInput(ch);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function countPaneTops(lines: string[]): number[] {
	return lines.map((line) => (line.match(/╭/g) ?? []).length).filter((n) => n > 0);
}

function paneTopRows(lines: string[]): number {
	return lines.filter((line) => line.includes("╭")).length;
}

function assertBounded(lines: string[], width: number, height: number, label: string): void {
	assert.ok(lines.length <= height, `${label}: rendered ${lines.length} lines > height ${height}`);
	for (const line of lines) {
		const w = visibleWidth(line);
		assert.ok(w <= width, `${label}: line width ${w} > ${width}: ${JSON.stringify(line)}`);
	}
}

// ── pure model sanity (also pinned for the integration worker) ──────────────

describe("workers-dashboard model", () => {
	it("computes columns = min(openCount, max(1, floor((width+1)/41))) and paginates", () => {
		const wide = computeDashboardLayout({ openCount: 4, width: 200, height: 40, focusIndex: 0 });
		assert.equal(wide.columns, 4);
		assert.equal(wide.rows, 1);
		const grid = computeDashboardLayout({ openCount: 4, width: 100, height: 40, focusIndex: 0 });
		assert.equal(grid.columns, 2);
		assert.equal(grid.rows, 2);
		const stack = computeDashboardLayout({ openCount: 4, width: 60, height: 40, focusIndex: 0 });
		assert.equal(stack.columns, 1);
		assert.equal(stack.rows, 4);
		const paginated = computeDashboardLayout({ openCount: 8, width: 60, height: 20, focusIndex: 0 });
		assert.equal(paginated.pageRows, 2);
		assert.equal(paginated.visibleCount, 2);
		assert.equal(paginated.paneHeight, 9);
		const tiny = computeDashboardLayout({ openCount: 4, width: 10, height: 3, focusIndex: 0 });
		assert.equal(tiny.tooSmall, true);
	});

	it("defaults to first live workers, filled with other jobs", () => {
		const jobs = [
			makeJob("d1", { status: "done" }),
			makeJob("r1"),
			makeJob("r2"),
			makeJob("w1", { status: "waiting" }),
			makeJob("r3"),
			makeJob("r4"),
		];
		assert.deepEqual(defaultOpenJobIds(jobs, 4), ["r1", "r2", "r3", "r4"]);
		assert.deepEqual(defaultOpenJobIds(jobs.filter((j) => j.id !== "r4"), 4), ["r1", "r2", "r3", "d1"]);
	});

	it("explains unavailable input and gates on canSend", () => {
		assert.equal(inputAvailability(makeJob("j", { status: "waiting", canSend: false })).ok, false);
		assert.equal(inputAvailability(makeJob("j", { status: "done", canSend: true })).ok, false);
		assert.equal(inputAvailability(makeJob("j", { canSend: false })).ok, false);
		assert.equal(inputAvailability(makeJob("j", { status: "offline", canSend: false })).ok, false);
		assert.equal(inputAvailability(makeJob("j")).ok, true);
	});

	it("sanitizes terminal escapes/control bytes and measures UTF-8 bytes", () => {
		const dirty = "hi\x1b[31mred\x1b[0m\x1b]8;;http://x\x07link\x1b]8;;\x07\x07\x00\x1b_end";
		const clean = sanitizeWorkerText(dirty);
		assert.ok(!clean.includes("\x1b"));
		assert.ok(!clean.includes("\x07"));
		assert.ok(!clean.includes("\x00"));
		assert.ok(clean.includes("hi") && clean.includes("red"), "visible text is kept");
		assert.equal(utf8ByteLength("héllo"), 6);
	});
});

// ── adaptive grid ───────────────────────────────────────────────────────────

describe("adaptive grid", () => {
	const jobs = [1, 2, 3, 4].map((n) => makeJob(`j${n}`));

	it("renders 4 side-by-side -> 2x2 -> 1-column within bounds", () => {
		const wide = setup(jobs);
		const lines = wide.dash.render(200);
		assertBounded(lines, 200, 40, "wide");
		assert.deepEqual(countPaneTops(lines), [4]); // single row of 4
		for (const job of jobs) assert.ok(lines.join("\n").includes(job.id), `wide: ${job.id} missing`);

		const grid = setup(jobs);
		const glines = grid.dash.render(100);
		assertBounded(glines, 100, 40, "2x2");
		assert.deepEqual(countPaneTops(glines), [2, 2]); // two rows of 2

		const stack = setup(jobs);
		const slines = stack.dash.render(60);
		assertBounded(slines, 60, 40, "stack");
		assert.deepEqual(countPaneTops(slines), [1, 1, 1, 1]); // four stacked rows
	});

	it("keeps all output bounded at tiny widths and heights", () => {
		for (const width of [1, 2, 3, 5, 10, 20, 39, 40, 41, 45]) {
			for (const height of [1, 2, 3, 5, 7, 8, 12, 20]) {
				const ctx = setup(jobs, {}, height);
				const lines = ctx.dash.render(width);
				assertBounded(lines, width, height, `w=${width} h=${height}`);
			}
		}
	});

	it("bounds Unicode (CJK/emoji) transcripts and sanitizes injected escapes", () => {
		const dirty = "attack \x1b[31mEVIL\x1b[0m now \x1b]8;;http://evil\x07click\x1b]8;;\x07 \x07\x00\x1b]";
		const ctx = setup([makeJob("u1")]);
		setSnapshot(ctx.backend, "u1", [
			makeEntry("e1", "日本語のとても長いテキスト".repeat(4)),
			makeEntry("e2", "emoji 👩‍💻🚀🎉 wide"),
			makeEntry("e3", dirty),
		], 1);
		for (const width of [20, 40, 61, 80]) {
			const lines = ctx.dash.render(width);
			assertBounded(lines, width, 40, `unicode w=${width}`);
		}
		const joined = ctx.dash.render(80).join("\n");
		assert.ok(!joined.includes("\x1b[31m"), "worker ANSI must be stripped");
		assert.ok(!joined.includes("\x1b]8;"), "worker OSC-8 must be stripped");
		assert.ok(joined.includes("EVIL"), "visible text is kept");
		assert.ok(!joined.includes("\x00"), "NUL must be stripped");
	});
});

// ── pagination and overflow ─────────────────────────────────────────────────

describe("pagination and overflow", () => {
	const jobs = Array.from({ length: 12 }, (_, i) => makeJob(`j${i + 1}`));

	it("paginates panes when height is short and reports visible/total counts", () => {
		const ctx = setup(jobs, { initialJobIds: jobs.slice(0, 8).map((j) => j.id) }, 20);
		const lines = ctx.dash.render(60);
		assertBounded(lines, 60, 20, "paginated");
		assert.ok(lines[1].includes("panes 1-2 of 8"), `notice line: ${JSON.stringify(lines[1])}`);
		assert.ok(lines.join("\n").includes("j1"));
		assert.ok(lines.join("\n").includes("j2"));
		assert.ok(!lines.join("\n").includes("j3"), "offscreen pane not rendered");
	});

	it("keeps the focused pane visible while paginating", () => {
		const ctx = setup(jobs, { initialJobIds: jobs.slice(0, 8).map((j) => j.id) }, 20);
		ctx.dash.handleInput("\t");
		ctx.dash.handleInput("\t");
		ctx.dash.handleInput("\t"); // focus j4
		const lines = ctx.dash.render(60);
		assertBounded(lines, 60, 20, "focused page");
		assert.ok(lines[1].includes("panes 3-4 of 8"), `notice line: ${JSON.stringify(lines[1])}`);
		assert.ok(lines.join("\n").includes("j4"));
		assert.ok(!lines.join("\n").includes("j1"), "page 1 scrolled away");
	});

	it("caps at 8 panes with a truthful overflow notice", () => {
		const ctx = setup(jobs, { initialJobIds: jobs.slice(0, 8).map((j) => j.id) }, 40);
		const before = ctx.dash.render(200);
		assert.ok(before[1].includes("4 jobs not open"), `overflow notice: ${JSON.stringify(before[1])}`);
		assert.deepEqual(countPaneTops(before), [4, 4], "8 panes in a 4x2 grid");
		// attempt a 9th pane via the picker: jump to j9 and press Enter
		ctx.dash.handleInput("\x0f"); // Ctrl+O
		for (let i = 0; i < 8; i++) ctx.dash.handleInput("\x1b[B"); // down to j9
		ctx.dash.handleInput("\r"); // 9th attempt rejected
		const withPicker = ctx.dash.render(200);
		assert.ok(withPicker[1].includes("Pane limit reached (8 panes)"), `limit notice: ${JSON.stringify(withPicker[1])}`);
		assert.ok(withPicker[1].includes("4 jobs not open"), "overflow count stays truthful");
		assertBounded(withPicker, 200, 40, "cap");
		ctx.dash.handleInput("\x1b"); // cancel picker
		const lines = ctx.dash.render(200);
		assert.deepEqual(countPaneTops(lines), [4, 4], "still exactly 8 open panes");
		assert.equal(lines.filter((l) => l.includes("j9")).length, 0, "9th pane never opened");
	});
});

// ── focus, open/close, drafts ───────────────────────────────────────────────

describe("focus, open/close, drafts", () => {
	const jobs = [makeJob("a1"), makeJob("a2"), makeJob("a3"), makeJob("a4"), makeJob("a5"), makeJob("a6", { status: "done", canSend: false })];

	it("opens first 4 live workers by default and supports explicit initialJobIds", () => {
		const ctx = setup(jobs);
		const joined = ctx.dash.render(200).join("\n");
		for (const id of ["a1", "a2", "a3", "a4"]) assert.ok(joined.includes(id), `${id} should be open`);
		assert.ok(!joined.includes("a5"), "a5 not open by default");

		const explicit = setup(jobs, { initialJobIds: ["a6", "a2"] });
		const ej = explicit.dash.render(200).join("\n");
		assert.ok(ej.includes("a6"));
		assert.ok(ej.includes("a2"));
		assert.ok(!ej.includes("a3"));
	});

	it("cycles focus with Tab/Shift+Tab and preserves drafts across panes and resize", () => {
		const ctx = setup(jobs);
		typeText(ctx.dash, "alpha");
		ctx.dash.handleInput("\t");
		typeText(ctx.dash, "beta");
		ctx.dash.handleInput("\x1b[Z"); // Shift+Tab back to a1
		let lines = ctx.dash.render(200);
		const joined = lines.join("\n");
		assert.ok(joined.includes("alpha"), "pane a1 draft preserved");
		assert.ok(joined.includes("beta"), "pane a2 draft preserved");
		assert.ok(lines.join("\n").includes(CURSOR_MARKER), "focused input shows the cursor marker");
		// resize keeps draft + focus
		lines = ctx.dash.render(60);
		assertBounded(lines, 60, 40, "resize");
		assert.ok(lines.join("\n").includes("alpha"), "draft survives resize");
		assert.ok(lines.join("\n").includes("beta"), "draft survives resize (2)");
	});

	it("closes the focused pane with Ctrl+W and reopens others via the picker", () => {
		const ctx = setup(jobs);
		ctx.dash.handleInput("\x17"); // Ctrl+W closes a1
		let joined = ctx.dash.render(200).join("\n");
		assert.ok(!joined.includes("a1"), "a1 closed");
		assert.ok(joined.includes("a2"));
		// picker: open a5
		ctx.dash.handleInput("\x0f"); // Ctrl+O
		joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("Open workers"), "picker is visible");
		assert.ok(joined.includes("a5"), "picker lists closed jobs");
		ctx.dash.handleInput("\x1b[B"); // down to a3
		ctx.dash.handleInput("\x1b[B"); // down to a4
		ctx.dash.handleInput("\x1b[B"); // down to a5
		ctx.dash.handleInput("\r"); // open a5
		joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("a5"), "a5 opened from picker");
		assert.ok(!joined.includes("Open workers"), "picker closed after open");
	});

	it("Escape cancels the picker without closing the dashboard; Escape outside closes", () => {
		const ctx = setup(jobs);
		ctx.dash.handleInput("\x0f");
		ctx.dash.handleInput("\x1b"); // cancel picker
		assert.equal(ctx.host.closes, 0, "dashboard stays open");
		const joined = ctx.dash.render(200).join("\n");
		assert.ok(!joined.includes("Open workers"), "picker cancelled");
		ctx.dash.handleInput("\x1b"); // close dashboard
		assert.equal(ctx.host.closes, 1, "host.close() called");
		assert.equal(ctx.backend.listeners.size, 0, "unsubscribed on close");
	});
});

// ── submission semantics ────────────────────────────────────────────────────

describe("prompt submission (ACK-gated)", () => {
	const jobs = [makeJob("s1"), makeJob("s2"), makeJob("s3", { status: "waiting", canSend: false }), makeJob("s4", { status: "done", canSend: false })];

	it("routes Enter to the focused worker only, shows pending, clears on ACK", async () => {
		const ctx = setup(jobs);
		let resolveSend: () => void = () => {};
		ctx.backend.sendImpl = () => new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		ctx.dash.handleInput("\t"); // focus s2
		typeText(ctx.dash, "hello");
		ctx.dash.handleInput("\r");
		assert.deepEqual(ctx.backend.sendCalls, [{ jobId: "s2", text: "hello" }], "routed to focused s2 only");
		assert.ok(ctx.dash.render(200).join("\n").includes("sending"), "pending shown while awaiting ACK");
		// duplicate submission while pending is prevented
		ctx.dash.handleInput("\r");
		assert.equal(ctx.backend.sendCalls.length, 1, "no duplicate submission while pending");
		resolveSend();
		await flush();
		const joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("delivered"), "delivered shown on success");
		assert.ok(!joined.includes("hello"), "draft cleared only on success");
	});

	it("keeps the draft on ACK failure and allows retry", async () => {
		const ctx = setup(jobs);
		ctx.backend.sendImpl = () => Promise.reject(new Error("nope"));
		typeText(ctx.dash, "retry me");
		ctx.dash.handleInput("\r");
		await flush();
		const joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("send failed"), "failure surfaced");
		assert.ok(joined.includes("retry me"), "draft kept on failure");
		ctx.backend.sendImpl = () => Promise.resolve();
		ctx.dash.handleInput("\r");
		await flush();
		assert.equal(ctx.backend.sendCalls.length, 2, "retry allowed after failure");
		assert.ok(!ctx.dash.render(200).join("\n").includes("retry me"), "draft cleared after successful retry");
	});

	it("refuses submission to finished/waiting/offline workers and explains why", async () => {
		const ctx = setup(jobs);
		ctx.dash.handleInput("\t");
		ctx.dash.handleInput("\t"); // focus s3 (waiting, canSend false)
		typeText(ctx.dash, "hello");
		ctx.dash.handleInput("\r");
		assert.equal(ctx.backend.sendCalls.length, 0, "no send to waiting worker");
		const joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("input disabled"), "unavailable input explained");
		assert.ok(joined.includes("hello"), "draft kept");
		// s4: done + canSend false via picker
		ctx.dash.handleInput("\x0f");
		ctx.dash.handleInput("\x1b[B");
		ctx.dash.handleInput("\x1b[B");
		ctx.dash.handleInput("\x1b[B");
		ctx.dash.handleInput("\r");
		ctx.dash.handleInput("\r"); // Enter on done worker
		assert.equal(ctx.backend.sendCalls.length, 0, "no send to done worker");
		assert.ok(ctx.dash.render(200).join("\n").includes("input disabled"));
	});

	it("ignores empty submit and enforces the 4096 UTF-8 byte limit", async () => {
		const ctx = setup(jobs);
		ctx.dash.handleInput("\r"); // empty
		assert.equal(ctx.backend.sendCalls.length, 0, "empty submit ignored");
		const big = "x".repeat(4097);
		// single bracketed paste keeps the test fast
		ctx.dash.handleInput(`\x1b[200~${big}\x1b[201~`);
		ctx.dash.handleInput("\r");
		assert.equal(ctx.backend.sendCalls.length, 0, "oversized body not sent");
		const joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("too large"), "size limit explained");
		assert.ok(joined.includes("4097"), "actual byte count shown");
		// trimmed-down body sends fine
		ctx.dash.handleInput("\x15"); // ctrl+u delete-to-line-start
		typeText(ctx.dash, "ok");
		ctx.dash.handleInput("\r");
		await flush();
		assert.deepEqual(ctx.backend.sendCalls.map((c) => c.text), ["ok"]);
	});

	it("transmits the exact body bytes (UTF-8) to the right job", async () => {
		const ctx = setup(jobs);
		ctx.dash.handleInput("\t");
		typeText(ctx.dash, "héllo 👋");
		ctx.dash.handleInput("\r");
		await flush();
		assert.deepEqual(ctx.backend.sendCalls, [{ jobId: "s2", text: "héllo 👋" }]);
	});
});

// ── performance invariants ──────────────────────────────────────────────────

describe("coalescing, caching, offscreen, disposal", () => {
	const jobs = Array.from({ length: 8 }, (_, i) => makeJob(`p${i + 1}`));

	it("coalesces a 10k-update burst into ONE scheduled render", () => {
		const ctx = setup(jobs);
		ctx.dash.render(200); // prime
		for (let i = 0; i < 10_000; i++) ctx.backend.emit();
		assert.equal(ctx.scheduler.scheduleCount, 1, "one scheduled callback per burst");
		assert.equal(ctx.scheduler.lastMs <= 33, true, "coalescing delay <= 33ms");
		ctx.scheduler.fire();
		assert.equal(ctx.host.renders, 1, "one render for the burst");
		ctx.backend.emit();
		assert.equal(ctx.scheduler.scheduleCount, 2, "next burst schedules again");
	});

	it("avoids re-wrapping when revision/width are unchanged and wraps on change", () => {
		const ctx = setup([makeJob("c1")]);
		setSnapshot(ctx.backend, "c1", [makeEntry("e1", "line one ".repeat(20))], 5);
		ctx.dash.render(80);
		const first = ctx.wrapCalls.length;
		assert.ok(first > 0, "initial wrap happened");
		ctx.dash.render(80);
		ctx.dash.render(80);
		assert.equal(ctx.wrapCalls.length, first, "unchanged revision/width avoids wrapping");
		// revision bump wraps again
		setSnapshot(ctx.backend, "c1", [makeEntry("e1", "line one ".repeat(20)), makeEntry("e2", "delta")], 6);
		ctx.backend.emit();
		ctx.scheduler.fire();
		ctx.dash.render(80);
		assert.equal(ctx.wrapCalls.length, first + 1, "revision change re-wraps once");
		// width change wraps again
		ctx.dash.render(60);
		assert.equal(ctx.wrapCalls.length, first + 2, "width change re-wraps once");
	});

	it("does not wrap or read offscreen panes; keeps their drafts untouched", () => {
		const ctx = setup(jobs, {}, 20); // 2 panes visible at width 60
		typeText(ctx.dash, "draft-one");
		ctx.wrapCalls.length = 0;
		ctx.backend.readCalls.length = 0;
		ctx.dash.render(60);
		assert.deepEqual(ctx.wrapCalls.length, 2, "only visible panes wrap");
		const readJobs = new Set(ctx.backend.readCalls);
		assert.deepEqual([...readJobs].sort(), ["p1", "p2"], "only visible panes read");
		assert.ok(ctx.dash.render(60).join("\n").includes("draft-one"), "focused draft intact");
		// backend burst + rerender must not touch offscreen panes
		ctx.backend.readCalls.length = 0;
		ctx.backend.emit();
		ctx.scheduler.fire();
		ctx.dash.render(60);
		assert.deepEqual([...new Set(ctx.backend.readCalls)].sort(), ["p1", "p2"]);
	});

	it("incoming output never steals focus or drafts", () => {
		const ctx = setup(jobs);
		typeText(ctx.dash, "quiet");
		setSnapshot(ctx.backend, "p2", [makeEntry("e1", "new output arriving")], 1);
		ctx.backend.emit();
		ctx.scheduler.fire();
		const joined = ctx.dash.render(200).join("\n");
		assert.ok(joined.includes("quiet"), "draft intact after output");
		assert.ok(joined.includes("new output arriving"), "output rendered");
		assert.ok(joined.includes(CURSOR_MARKER), "focus unchanged (still on p1 input)");
	});

	it("dispose cancels the scheduled callback/unsubscribes and guards late work", async () => {
		const ctx = setup(jobs);
		ctx.backend.emit();
		assert.equal(ctx.scheduler.scheduleCount, 1);
		const lateCb = ctx.scheduler.lastCb!;
		ctx.dash.dispose();
		assert.equal(ctx.scheduler.pending, null, "scheduled callback cancelled");
		assert.equal(ctx.backend.listeners.size, 0, "unsubscribed");
		lateCb(); // late timer fire must be inert
		assert.equal(ctx.host.renders, 0, "no post-dispose render");
		ctx.backend.emit();
		assert.equal(ctx.scheduler.scheduleCount, 1, "no rescheduling after dispose");

		// late send completion after dispose is inert
		const ctx2 = setup(jobs);
		let resolveSend: () => void = () => {};
		ctx2.backend.sendImpl = () => new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		typeText(ctx2.dash, "late");
		ctx2.dash.handleInput("\r");
		const rendersBefore = ctx2.host.renders;
		ctx2.dash.dispose();
		resolveSend();
		await flush();
		assert.equal(ctx2.host.renders, rendersBefore, "late ACK does not render");
		// dispose is idempotent
		ctx2.dash.dispose();
		ctx2.dash.dispose();
	});
});

// ── scrolling ───────────────────────────────────────────────────────────────

describe("transcript scrolling", () => {
	it("PageUp/PageDown scroll the focused transcript and End follows latest", () => {
		const ctx = setup([makeJob("sc1")]);
		setSnapshot(ctx.backend, "sc1", Array.from({ length: 60 }, (_, i) => makeEntry(`e${i}`, `line ${i}`)), 1);
		let lines = ctx.dash.render(80);
		assert.ok(lines.join("\n").includes("line 59"), "follows latest by default");
		ctx.dash.handleInput("\x1b[5~"); // PageUp
		lines = ctx.dash.render(80);
		const joined = lines.join("\n");
		assert.ok(joined.includes("↑"), "scroll-up indicator shown");
		assert.ok(!joined.includes("line 59"), "scrolled away from the tail");
		ctx.dash.handleInput("\x1b[6~"); // PageDown
		ctx.dash.handleInput("\x1b[F"); // End -> follow latest
		lines = ctx.dash.render(80);
		assert.ok(lines.join("\n").includes("line 59"), "back at the tail");
		assert.ok(!lines.join("\n").includes("↑"), "no scroll indicator while following");
	});
});
