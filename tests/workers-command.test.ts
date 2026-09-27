/**
 * tests/workers-command.test.ts — real registered /workers command integration.
 *
 * Loads the REAL index.ts extension against a mock pi ExtensionAPI and drives
 * the ACTUAL registered /workers handler through a fake ctx.ui.custom factory
 * (the overlay factory seam used by real TUI sessions). Workers run as fake RPC
 * children over the argv[1] seam (extension-smoke/messaging-phase2 pattern) so
 * the full path is exercised: fake runner events → core/spawn req.onEvent →
 * workerFeed → the WorkersFeedBackend adapter → pane render.
 *
 * Covers: non-TUI guards (RPC/no-UI never call custom()), initial-id
 * validation feedback, duplicate-command focus (no leaked controllers), ACK-
 * gated prompt routing with pending ACK / success / rejection (drafts preserved,
 * no completion claim from a delivery ACK), finished and stale workers blocked,
 * width/height resize (grid wrap + pagination), deterministic burst counting
 * (10k worker deltas cause NO job-store reads and coalesced renders), bounded
 * metadata retention under many-job churn, Esc/session_shutdown/session_tree
 * cleanup idempotency, and ask_user_question FIFO + dashboard focus restore.
 *
 * No network, no model credentials, no live TUI process.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JobStore } from "../core/storage.ts";

// ── Hermetic sandbox (created BEFORE the extension module is imported) ──────

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orch-workers-cmd-"));
const agentDir = path.join(sandbox, "pi-agent");
const agentsRoot = path.join(sandbox, "agents");
const configDir = path.join(sandbox, "config");
const orchRoot = path.join(sandbox, "orchestrator");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CONFIG_DIR = configDir;
delete process.env.PI_ORCHESTRATOR_SUBAGENT;
for (const dir of [agentsRoot, configDir, path.join(agentsRoot, "worker"), orchRoot]) {
	fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(
	path.join(agentsRoot, "worker", "AGENT.md"),
	[
		"---",
		"name: worker",
		"description: Deterministic workers-dashboard test worker.",
		"role: sub",
		"runtime: {}",
		"limits:",
		"  timeoutSeconds: 60",
		"context:",
		"  mode: none",
		"workspace:",
		"  strategy: cwd",
		"  cleanup: keep",
		"validation:",
		"  commands: []",
		"retry:",
		"  maxAttempts: 1",
		"hooks:",
		"  enabled: false",
		"---",
		"",
		"Workers dashboard test worker body.",
		"",
	].join("\n"),
);
fs.writeFileSync(
	path.join(orchRoot, "models.yaml"),
	["models:", "  worker-cheap:", "    provider: fake", "    model: fake/cheap", "defaults:", "  worker: worker-cheap", ""].join("\n"),
);

// Fake RPC child: replays PI_CONFIG_DIR/workers-fake-spec.json behaviors keyed
// by the spawned job id. Supports prompt ACK, steer ACK/delayed ACK/rejection,
// scripted stdout events (incl. 10k-delta bursts) gated on a trigger file,
// settle or keep-alive lifecycles.
const fakeChildPath = path.join(sandbox, "workers-fake-child.mjs");
fs.writeFileSync(
	fakeChildPath,
	[
		"import * as fs from 'node:fs';",
		"import * as path from 'node:path';",
		"const cfg = process.env.PI_CONFIG_DIR ?? '';",
		"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
		"const spec = JSON.parse(fs.readFileSync(path.join(cfg, 'workers-fake-spec.json'), 'utf8'));",
		"const behavior = (spec.jobs ?? {})[process.env.PI_ORCHESTRATOR_JOB_ID ?? ''] ?? {};",
		"const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
		"const waitFile = async (f) => { while (!fs.existsSync(f)) await sleep(5); };",
		"if (process.env.PI_ORCHESTRATOR_RESULT_PATH) {",
		"  fs.writeFileSync(process.env.PI_ORCHESTRATOR_RESULT_PATH, JSON.stringify({",
		"    schemaVersion: 1,",
		"    jobId: process.env.PI_ORCHESTRATOR_JOB_ID,",
		"    attemptId: process.env.PI_ORCHESTRATOR_ATTEMPT_ID,",
		"    status: behavior.resultStatus ?? 'success',",
		"    summary: behavior.summary ?? 'workers fake done',",
		"    findings: [], changes: [], validation: { status: 'skipped', checks: [] },",
		"    artifacts: [], blockers: [], followUps: [], metrics: {},",
		"  }, null, 2));",
		"}",
		"out({ type: 'session_start', sessionId: 'workers-fake' });",
		"let steered = 0;",
		"let buf = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => {",
		"  buf += chunk;",
		"  let i;",
		"  while ((i = buf.indexOf('\\n')) !== -1) {",
		"    let line = buf.slice(0, i);",
		"    buf = buf.slice(i + 1);",
		"    if (line.endsWith('\\r')) line = line.slice(0, -1);",
		"    if (!line.trim()) continue;",
		"    let cmd; try { cmd = JSON.parse(line); } catch { continue; }",
		"    if (cmd.type === 'prompt') {",
		"      out({ id: cmd.id, type: 'response', command: 'prompt', success: true });",
		"      void (async () => {",
		"        if (behavior.eventsWaitFile) await waitFile(behavior.eventsWaitFile);",
		"        for (const e of behavior.events ?? []) out(e);",
		"        if (behavior.settle) out({ type: 'agent_settled' });",
		"      })();",
		"    } else if (cmd.type === 'steer') {",
		"      const mode = behavior.steerModes?.[steered] ?? behavior.steerMode ?? 'ack';",
		"      steered++;",
		"      void (async () => {",
		"        if (mode === 'wait') await waitFile(behavior.steerWaitFile);",
		"        if (mode === 'reject') out({ id: cmd.id, type: 'response', command: 'steer', success: false, error: behavior.steerError ?? 'steer refused' });",
		"        else out({ id: cmd.id, type: 'response', command: 'steer', success: true });",
		"      })();",
		"    }",
		"  }",
		"});",
		"if (behavior.keepAlive) setInterval(() => {}, 1000);",
		"process.stdin.on('end', () => process.exit(0));",
		"",
	].join("\n"),
);
const realArgv1 = process.argv[1];
process.argv[1] = fakeChildPath;
after(() => {
	process.argv[1] = realArgv1;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CONFIG_DIR;
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

interface FakeBehavior {
	events?: unknown[];
	eventsWaitFile?: string;
	settle?: boolean;
	keepAlive?: boolean;
	steerMode?: "ack" | "reject" | "wait";
	steerModes?: Array<"ack" | "reject" | "wait">;
	steerWaitFile?: string;
	steerError?: string;
	resultStatus?: string;
	summary?: string;
}

function writeSpec(jobs: Record<string, FakeBehavior>): void {
	fs.writeFileSync(path.join(configDir, "workers-fake-spec.json"), JSON.stringify({ jobs }));
}

// ── Mock pi + fake ctx.ui.custom overlay factory ─────────────────────────────

type AnyComponent = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
};

interface CapturedOverlay {
	component: AnyComponent;
	options: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void } | undefined;
	done: (value?: unknown) => void;
	closed: boolean;
	doneCalls: number;
	focusCalls: number;
	hideCalls: number;
	result?: unknown;
}

interface MockPi {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>;
	tools: Map<string, { execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }>;
	commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
}

function makeMockPi(): MockPi {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }>();
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) => handlers.set(event, handler),
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, def: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, def.handler);
		},
		registerProvider: () => {},
		getAllTools: () => [],
		setActiveTools: () => {},
		setModel: async () => {},
		setThinkingLevel: () => {},
		appendEntry: () => {},
		events: { emit: () => {} },
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools, commands };
}

function makeExtCtx(overrides: { mode?: string; hasUI?: boolean; rows?: number; columns?: number } = {}) {
	const overlays: CapturedOverlay[] = [];
	const notify: { message: string; type: string }[] = [];
	let requestedRenders = 0;
	const tui = {
		requestRender: () => {
			requestedRenders++;
		},
		terminal: { rows: overrides.rows ?? 40, columns: overrides.columns ?? 124 },
	};
	const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
	const ctx = {
		cwd: sandbox,
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value?: unknown) => void) => unknown, options: CapturedOverlay["options"]) => {
				let resolveFn!: (value: unknown) => void;
				const promise = new Promise((resolve) => {
					resolveFn = resolve;
				});
				const entry: CapturedOverlay = {
					component: undefined as unknown as AnyComponent,
					options,
					closed: false,
					doneCalls: 0,
					focusCalls: 0,
					hideCalls: 0,
					done: () => {},
				};
				// Mirrors real pi showExtensionCustom: idempotent done, resolve the
				// promise, then dispose the component.
				entry.done = (value?: unknown) => {
					if (entry.closed) return;
					entry.closed = true;
					entry.doneCalls++;
					entry.result = value;
					resolveFn(value);
					try {
						entry.component?.dispose?.();
					} catch {
						/* ignore */
					}
				};
				entry.component = factory(tui, theme, undefined, entry.done) as AnyComponent;
				overlays.push(entry);
				options?.onHandle?.({
					hide: () => {
						entry.hideCalls++;
					},
					setHidden: () => {},
					isHidden: () => false,
					focus: () => {
						entry.focusCalls++;
					},
					unfocus: () => {},
					isFocused: () => true,
					getBounds: () => undefined,
				});
				return promise;
			},
			notify: (message: string, type: string) => {
				notify.push({ message, type });
			},
			setStatus: () => {},
			setWidget: () => {},
			select: async (_t: string, labels: string[]) => labels[0],
			input: async () => undefined,
			theme: undefined,
		},
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "workers-cmd-session",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		overlays,
		notify,
		tui,
		renders: () => requestedRenders,
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, timeoutMs = 15000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 15));
	}
}

function renderAll(overlay: CapturedOverlay, width = 118): string {
	return overlay.component.render(width).join("\n");
}

function typeInto(overlay: CapturedOverlay, text: string): void {
	for (const ch of text) overlay.component.handleInput?.(ch);
}

function seedJob(jobId: string, over: Record<string, unknown> = {}): void {
	const dir = path.join(orchRoot, "jobs", jobId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "job.json"),
		JSON.stringify({
			schemaVersion: 1,
			jobId,
			objective: `seeded ${jobId}`,
			agent: "worker",
			dependsOn: [],
			status: "running",
			createdAt: Date.now() - 60_000,
			updatedAt: Date.now() - 60_000,
			cwd: sandbox,
			retry: { maxAttempts: 1, ladder: [] },
			attemptCount: 0,
			...over,
		}),
	);
}

const extension = (await import("../index.ts")).default;

async function bootWithJobs(seeded: Array<[string, Record<string, unknown>?]> = []): Promise<{
	mock: MockPi;
	ext: ReturnType<typeof makeExtCtx>;
	run: (args: string) => Promise<void>;
}> {
	for (const [id, over] of seeded) seedJob(id, over);
	const mock = makeMockPi();
	extension(mock.pi);
	const ext = makeExtCtx();
	await mock.handlers.get("session_start")!({}, ext.ctx);
	const workers = mock.commands.get("workers");
	assert.ok(workers, "the /workers command must be registered");
	const run = (args: string) => workers!(args, ext.ctx as unknown as ExtensionCommandContext);
	return { mock, ext, run };
}

/** Kick off a delegate run WITHOUT awaiting (the job stays live until cleaned up). */
function startJob(mock: MockPi, jobId: string): Promise<unknown> {
	return mock.tools.get("delegate")!.execute(`c-${jobId}`, { agent: "worker", task: `work on ${jobId}`, id: jobId }, undefined, undefined, {
		cwd: sandbox,
		model: undefined,
	});
}

async function cancelJob(mock: MockPi, jobId: string, run: Promise<unknown>): Promise<void> {
	await mock.tools.get("jobs")!.execute(`cancel-${jobId}`, { action: "cancel", jobId }, undefined, undefined, { cwd: sandbox });
	await run;
}

function countChar(text: string, ch: string): number {
	return text.split(ch).length - 1;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("workers command: mode guards and lifecycle", () => {
	it("RPC and headless sessions report clearly and never open a custom overlay", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const rpc = makeExtCtx({ mode: "rpc" });
		await mock.handlers.get("session_start")!({}, rpc.ctx);
		await mock.commands.get("workers")!("", rpc.ctx as unknown as ExtensionCommandContext);
		assert.equal(rpc.overlays.length, 0, "RPC mode must never call ctx.ui.custom");
		assert.ok(rpc.notify.some((n) => n.message.includes("requires the interactive TUI")), `mode feedback: ${JSON.stringify(rpc.notify)}`);

		const headless = makeExtCtx({ hasUI: false });
		await mock.commands.get("workers")!("", headless.ctx as unknown as ExtensionCommandContext);
		assert.equal(headless.overlays.length, 0, "headless must never call ctx.ui.custom");
		assert.ok(headless.notify.some((n) => n.message.includes("requires the interactive TUI")));
	});

	it("opens ONE overlay via the real handler and validates initial job ids with clear feedback", async () => {
		const { ext, run } = await bootWithJobs([["seed-a"], ["seed-b"]]);
		await run("seed-a ghost-id");
		assert.equal(ext.overlays.length, 1, "exactly one ctx.ui.custom overlay");
		assert.equal(ext.overlays[0]!.options?.overlay, true, "top-level bounded overlay");
		const opts = ext.overlays[0]!.options?.overlayOptions as { width?: string; maxHeight?: string; margin?: number; anchor?: string };
		assert.equal(opts?.width, "100%", "width100%");
		assert.equal(opts?.maxHeight, "100%");
		assert.equal(opts?.margin, 1, "margins declared so getHeight must subtract them");
		assert.ok(ext.notify.some((n) => n.message.includes("unknown job id(s) ignored") && n.message.includes("ghost-id")), `clear feedback: ${JSON.stringify(ext.notify)}`);
		const text = renderAll(ext.overlays[0]!);
		assert.ok(text.includes("seed-a"), `validated id opens a pane: ${text.slice(0, 200)}`);
		assert.ok(!text.includes("ghost"), "unknown ids never open panes");
		// getHeight matches overlay usable rows (terminal rows - both margins).
		assert.ok(text.split("\n").length <= 40 - 2, "render is bounded by usable rows, not raw terminal rows");
	});

	it("duplicate command focuses the open dashboard and never creates a second controller", async () => {
		const { ext, run } = await bootWithJobs([["dup-1"]]);
		await run("dup-1");
		assert.equal(ext.overlays.length, 1);
		await run("");
		assert.equal(ext.overlays.length, 1, "no leaked duplicate controllers");
		assert.ok(ext.overlays[0]!.focusCalls >= 1, "the open dashboard is focused");
		assert.ok(ext.notify.some((n) => n.message.includes("already open")));
	});

	it("Esc closes with full cleanup, close is idempotent, reopen works", async () => {
		const { ext, run } = await bootWithJobs([["esc-1"]]);
		await run("esc-1");
		const first = ext.overlays[0]!;
		const rendersBeforeClose = ext.renders();
		first.component.handleInput?.("\x1b"); // Esc closes
		assert.equal(first.doneCalls, 1, "done() called exactly once on close");
		assert.equal(first.closed, true);
		// Late input after close is a no-op and no render tasks keep firing.
		first.component.handleInput?.("x");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(ext.renders(), rendersBeforeClose, "no leaked pending render tasks after close");
		await run("esc-1"); // reopen
		assert.equal(ext.overlays.length, 2, "reopening after close creates a fresh controller");
		assert.equal(ext.overlays[1]!.closed, false);
	});

	it("session_shutdown and session_tree close the open dashboard idempotently", async () => {
		const { mock, ext, run } = await bootWithJobs([["shut-1"]]);
		await run("shut-1");
		const open = ext.overlays[0]!;
		await mock.handlers.get("session_shutdown")!({}, ext.ctx);
		assert.equal(open.doneCalls, 1, "session_shutdown closes the overlay exactly once");
		assert.equal(open.closed, true);
		await mock.handlers.get("session_shutdown")!({}, ext.ctx);
		assert.equal(open.doneCalls, 1, "shutdown cleanup is idempotent");

		await run("shut-2-unknown"); // default selection; reopen after shutdown
		assert.equal(ext.overlays.length, 2);
		await mock.handlers.get("session_tree")!({}, ext.ctx);
		assert.equal(ext.overlays[1]!.closed, true, "session_tree closes the dashboard bound to the old branch");
	});
});

describe("workers command: responsive grid and resize", () => {
	it("wraps panes to the width and paginates on short heights through the real render path", async () => {
		const { ext, run } = await bootWithJobs([["size-1"], ["size-2"], ["size-3"]]);
		await run("size-1 size-2 size-3");
		const overlay = ext.overlays[0]!;

		// Wide (>= 3 columns): one row of 3 panes.
		const wide = overlay.component.render(122).join("\n");
		assert.equal(countChar(wide.split("\n").find((l) => l.includes("╭")) ?? "", "╭"), 3, `3 side-by-side panes at width 122: ${wide.split("\n").find((l) => l.includes("╭"))}`);

		// Narrower (2 columns): first pane row has 2 panes, third wraps below.
		const narrow = overlay.component.render(82).join("\n");
		const firstRow = narrow.split("\n").find((l) => l.includes("╭")) ?? "";
		assert.equal(countChar(firstRow, "╭"), 2, `2 columns at width 82: ${firstRow}`);
		assert.equal(countChar(narrow, "╭"), 3, "all 3 panes still render across rows");

		// Short height: rows paginate with an explicit window notice; the host
		// height seam reads the fake terminal minus both overlay margins.
		ext.tui.terminal.rows = 12;
		const short = overlay.component.render(82).join("\n");
		assert.ok(short.includes("panes 1-2 of 3"), `short height paginates: ${short.slice(0, 300)}`);
		ext.tui.terminal.rows = 40;
		const tall = overlay.component.render(82).join("\n");
		assert.ok(!tall.includes("panes 1-2 of 3"), "tall terminal shows every pane");
	});
});

describe("workers command: ACK-gated prompt routing", () => {
	it("sends a direct prompt to a live worker; the prompt lands in the feed ONLY after the ACK", async () => {
		const steerFile = path.join(sandbox, "steer-ack-1.flag");
		writeSpec({ "ack-1": { steerMode: "wait", steerWaitFile: steerFile, keepAlive: true } });
		const { mock, ext, run } = await bootWithJobs();
		const runPromise = startJob(mock, "ack-1");
		await waitFor(() => fs.existsSync(path.join(orchRoot, "jobs", "ack-1", "job.json")));
		await run("ack-1");
		const overlay = ext.overlays[0]!;
		await waitFor(() => renderAll(overlay).includes("Enter send"), 20000); // canSend: live active job

		typeInto(overlay, "hello worker");
		overlay.component.handleInput?.("\r"); // Enter sends
		let text = renderAll(overlay);
		assert.ok(text.includes("sending…"), `pending ACK state: ${text.slice(-300)}`);
		assert.ok(text.includes("hello worker"), "the draft is visible while the ACK is pending");
		assert.ok(!text.includes("[user]"), "no delivery claim before the worker ACKs");
		assert.ok(!text.includes("delivered"));

		fs.writeFileSync(steerFile, "1"); // worker now ACKs the steer
		await waitFor(() => {
			const t = renderAll(overlay);
			return t.includes("✓ delivered") && t.includes("[user] hello worker");
		});
		text = renderAll(overlay);
		assert.ok(text.includes("✓ delivered"), "success notice only after ACK");
		await cancelJob(mock, "ack-1", runPromise);
	});

	it("a rejected steer keeps the draft and never claims completion", async () => {
		writeSpec({ "rej-1": { steerMode: "reject", steerError: "steer refused", keepAlive: true } });
		const { mock, ext, run } = await bootWithJobs();
		const runPromise = startJob(mock, "rej-1");
		await waitFor(() => fs.existsSync(path.join(orchRoot, "jobs", "rej-1", "job.json")));
		await run("rej-1");
		const overlay = ext.overlays[0]!;
		await waitFor(() => renderAll(overlay).includes("Enter send"), 20000);

		typeInto(overlay, "retry me");
		overlay.component.handleInput?.("\r");
		await waitFor(() => renderAll(overlay).includes("✗ send failed"));
		const text = renderAll(overlay);
		assert.ok(text.includes("steer rejected: steer refused"), `explicit rejection error: ${text.slice(-300)}`);
		assert.ok(text.includes("retry me"), "the draft survives a failed send");
		assert.ok(!text.includes("[user]"), "a rejected send never records the prompt");
		assert.ok(!text.includes("✓ delivered"), "no completion/delivery claim on rejection");
		await cancelJob(mock, "rej-1", runPromise);
	});
});

describe("workers command: finished and stale workers are blocked", () => {
	it("a finished worker is blocked with clear feedback and no send", async () => {
		writeSpec({ "done-1": { settle: true } });
		const { mock, ext, run } = await bootWithJobs();
		await startJob(mock, "done-1");
		await waitFor(() => {
			try {
				return JSON.parse(fs.readFileSync(path.join(orchRoot, "jobs", "done-1", "job.json"), "utf8")).status === "success";
			} catch {
				return false;
			}
		});
		await run("done-1");
		const overlay = ext.overlays[0]!;
		let text = renderAll(overlay);
		assert.ok(text.includes("input disabled"), `finished worker input disabled: ${text.slice(0, 400)}`);
		typeInto(overlay, "hi");
		overlay.component.handleInput?.("\r");
		text = renderAll(overlay);
		assert.ok(text.includes("input disabled — status success — input disabled"), `blocked submit explains why: ${text.slice(-300)}`);
		assert.ok(text.includes("hi"), "the unsent draft is preserved");
		assert.ok(!text.includes("[user]"), "nothing was delivered to a finished worker");
	});

	it("a stale running id without a live worker and canceled spellings both reject sends", async () => {
		seedJob("stale-run-1", { status: "running" });
		seedJob("canceled-1", { status: "canceled" });
		const { ext, run } = await bootWithJobs();
		await run("stale-run-1 canceled-1");
		const overlay = ext.overlays[0]!;
		// Wide render so the full status lines fit inside both panes.
		let text = overlay.component.render(200).join("\n");
		assert.ok(text.includes("worker not accepting input (status running)"), `stale id: ${text.slice(0, 500)}`);
		assert.ok(text.includes("status canceled — input disabled"), `US spelling guarded: ${text.slice(0, 500)}`);
		typeInto(overlay, "hi");
		overlay.component.handleInput?.("\r");
		text = overlay.component.render(200).join("\n");
		assert.ok(text.includes("input disabled"), "stale id submit is rejected");
		assert.ok(!text.includes("[user]"), "no prompt reaches a stale id");
	});
});

describe("workers command: performance invariants", () => {
	it("10k worker deltas cause zero job-store reads and coalesced renders", async () => {
		const trigger = path.join(sandbox, "burst-1.trigger");
		const deltas: unknown[] = [];
		for (let i = 0; i < 10000; i++) {
			deltas.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } });
		}
		deltas.push({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${"x".repeat(10000)} burst-complete` }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 2 },
				stopReason: "stop",
			},
		});
		writeSpec({ "burst-1": { events: deltas, eventsWaitFile: trigger, keepAlive: true } });

		// Deterministic counting: wrap JobStore.readJob before anything runs.
		const origReadJob = JobStore.prototype.readJob;
		let readJobCalls = 0;
		JobStore.prototype.readJob = function (this: JobStore, jobId: string) {
			readJobCalls++;
			return origReadJob.call(this, jobId);
		};
		try {
			const { mock, ext, run } = await bootWithJobs();
			const runPromise = startJob(mock, "burst-1");
			await waitFor(() => fs.existsSync(path.join(orchRoot, "jobs", "burst-1", "job.json")));
			await run("burst-1");
			const overlay = ext.overlays[0]!;
			await waitFor(() => renderAll(overlay).includes("Enter send"), 20000);

			const readsBefore = readJobCalls;
			const rendersBefore = ext.renders();
			fs.writeFileSync(trigger, "1"); // release the 10k-delta burst
			await waitFor(() => renderAll(overlay).includes("burst-complete"), 30000);

			const readsDuring = readJobCalls - readsBefore;
			const rendersDuring = ext.renders() - rendersBefore;
			assert.ok(readsDuring < 50, `10k deltas must not hit the job store per delta (reads=${readsDuring})`);
			assert.ok(rendersDuring >= 1 && rendersDuring < 1000, `renders must coalesce to <=33ms flushes (renders=${rendersDuring})`);
			const text = renderAll(overlay);
			assert.ok(text.includes("xxxxxxxxxx"), `streamed deltas reach the pane render: ${text.slice(0, 300)}`);
			await cancelJob(mock, "burst-1", runPromise);
		} finally {
			JobStore.prototype.readJob = origReadJob;
		}
	});

	it("many-job churn stays bounded: metadata cache caps at 48 buffered jobs", async () => {
		for (let i = 0; i < 60; i++) {
			seedJob(`churn-${String(i).padStart(3, "0")}`, { status: "running", updatedAt: Date.now() - 60_000 + i });
		}
		const { ext, run } = await bootWithJobs();
		await run("");
		const overlay = ext.overlays[0]!;
		overlay.component.handleInput?.("\x0f"); // Ctrl+O picker
		const text = renderAll(overlay);
		assert.ok(/48 jobs ·/.test(text), `bounded job list in the picker: ${text.slice(-300)}`);
	});
});

describe("workers command: ask_user_question integration", () => {
	it("question overlays keep FIFO semantics and restore dashboard focus", async () => {
		const { mock, ext, run } = await bootWithJobs([["fifo-1"]]);
		await run("fifo-1");
		const dashboard = ext.overlays[0]!;
		const focusBefore = dashboard.focusCalls;

		const ask = mock.tools.get("ask_user_question")!;
		const askCtx = ext.ctx;
		const p1 = ask.execute("q1", { question: "First question?", options: [{ label: "alpha" }, { label: "beta" }] }, undefined, undefined, askCtx) as Promise<{ content: { text: string }[] }>;
		const p2 = ask.execute("q2", { question: "Second question?", options: [{ label: "gamma" }, { label: "delta" }] }, undefined, undefined, askCtx) as Promise<{ content: { text: string }[] }>;

		await waitFor(() => ext.overlays.length === 2);
		assert.equal(ext.overlays.length, 2, "FIFO: only ONE question dialog while the first is open");
		ext.overlays[1]!.component.handleInput?.("\r"); // answer "alpha"
		const r1 = await p1;
		assert.ok(r1.content[0]!.text.includes("User answered: alpha"), r1.content[0]!.text);
		assert.ok(dashboard.focusCalls > focusBefore, "dashboard focus is restored after the question closes");

		await waitFor(() => ext.overlays.length === 3);
		ext.overlays[2]!.component.handleInput?.("\r"); // answer "gamma"
		const r2 = await p2;
		assert.ok(r2.content[0]!.text.includes("User answered: gamma"), r2.content[0]!.text);
		assert.ok(dashboard.focusCalls > focusBefore + 1, "focus restored after every question");
		assert.equal(dashboard.closed, false, "the dashboard stays open across questions");
	});
});
