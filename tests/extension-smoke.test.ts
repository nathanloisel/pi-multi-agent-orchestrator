/**
 * Extension smoke test — loads the REAL index.ts extension against a mock
 * pi ExtensionAPI in a hermetic sandbox:
 *
 *   - PI_CODING_AGENT_DIR is redirected into a temp dir, so agent discovery
 *     (~/.pi/agents) and the orchestrator root (~/.pi/orchestrator) both live
 *     in the sandbox — no machine state is read or written.
 *   - Jobs are executed by a deterministic fake worker subprocess instead of
 *     a real pi: getPiInvocation() prefers process.argv[1] as the child
 *     script, so we point argv[1] at a tiny .mjs that emits pi `--mode json`
 *     lines and writes a valid result.json. No network, no provider spend.
 *
 * Covers end-to-end what the pure-helper suites cannot: session_start →
 * delegate lifecycle, batch (DAG) partial updates, session isolation, branch
 * restore, and stale-widget clearing on branch navigation.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shortJobId } from "../core/progress.ts";

// ── Hermetic sandbox (created BEFORE the extension module is imported) ──────

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orch-ext-smoke-"));
const agentDir = path.join(sandbox, "pi-agent");
const agentsRoot = path.join(sandbox, "agents");
const orchRoot = path.join(sandbox, "orchestrator");
const projectDir = path.join(sandbox, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;
// This suite may itself run inside an orchestrator worker (which exports
// PI_ORCHESTRATOR_SUBAGENT=1); the extension's worker guard must not trip.
delete process.env.PI_ORCHESTRATOR_SUBAGENT;
for (const dir of [path.join(agentsRoot, "worker"), orchRoot, projectDir]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(
	path.join(agentsRoot, "worker", "AGENT.md"),
	[
		"---",
		"name: worker",
		"description: Deterministic smoke-test worker.",
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
		"Smoke worker body.",
		"",
	].join("\n"),
);

fs.writeFileSync(
	path.join(orchRoot, "models.yaml"),
	["models:", "  worker-cheap:", "    provider: fake", "    model: fake/cheap", "defaults:", "  worker: worker-cheap", ""].join("\n"),
);

// Fake worker: speaks pi's --mode json event stream, writes a valid result.json.
const fakeWorkerPath = path.join(sandbox, "fake-worker.mjs");
fs.writeFileSync(
	fakeWorkerPath,
	[
		"import * as fs from 'node:fs';",
		"const result = {",
		"  schemaVersion: 1,",
		"  jobId: process.env.PI_ORCHESTRATOR_JOB_ID ?? 'unknown',",
		"  attemptId: process.env.PI_ORCHESTRATOR_ATTEMPT_ID ?? 'unknown',",
		"  status: 'success',",
		"  summary: 'smoke worker finished successfully',",
		"  findings: [],",
		"  changes: [],",
		"  validation: { status: 'skipped', checks: [] },",
		"  artifacts: [],",
		"  blockers: [],",
		"  followUps: [],",
		"  metrics: {},",
		"};",
		"if (process.env.PI_ORCHESTRATOR_RESULT_PATH) {",
		"  fs.writeFileSync(process.env.PI_ORCHESTRATOR_RESULT_PATH, JSON.stringify(result, null, 2));",
		"}",
		"const line = (o) => console.log(JSON.stringify(o));",
		"line({ type: 'session_start', sessionId: 'fake-worker-session' });",
		"line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } });",
		"line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'smoke: done' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 2 }, stopReason: 'stop' } });",
		"",
	].join("\n"),
);

// getPiInvocation() spawns [process.execPath, process.argv[1], ...args] when
// argv[1] is an existing file. Point it at the fake worker for the duration of
// this file's tests (restored in after()). The extension itself only reads
// argv for --model flags in the (inactive) main-lockdown path.
const realArgv1 = process.argv[1];
process.argv[1] = fakeWorkerPath;

after(() => {
	process.argv[1] = realArgv1;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

// ── Mocks ────────────────────────────────────────────────────────────────────

type Update = { content: { type: "text"; text: string }[]; details?: unknown };

interface MockPi {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>;
	tools: Map<string, { execute: (id: string, params: unknown, signal: unknown, onUpdate: ((u: Update) => void) | undefined, ctx: unknown) => Promise<unknown> }>;
	entries: { customType: string; data: unknown }[];
}

function makeMockPi(): MockPi {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: unknown, onUpdate: ((u: Update) => void) | undefined, ctx: unknown) => Promise<unknown> }>();
	const entries: { customType: string; data: unknown }[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: ((u: Update) => void) | undefined, ctx: unknown) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		registerCommand: () => {},
		registerProvider: () => {},
		getAllTools: () => [],
		setActiveTools: () => {},
		setModel: async () => {},
		setThinkingLevel: () => {},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
		},
		events: { emit: () => {} },
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools, entries };
}

function makeCtx(branch: unknown[] = []): { ctx: ExtensionContext; widgets: Map<string, string[] | undefined>; statuses: Map<string, string | undefined> } {
	const widgets = new Map<string, string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		cwd: projectDir,
		hasUI: true,
		ui: {
			setWidget: (key: string, content: string[] | undefined) => {
				widgets.set(key, content);
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			notify: () => {},
			theme: undefined,
		},
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "smoke-session",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	return { ctx, widgets, statuses };
}

/** Membership entries as a real pi session branch would store them. */
function branchEntries(entries: { customType: string; data: unknown }[]): unknown[] {
	return entries.filter((e) => e.customType === "orchestrator.progress-jobs").map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
}

const extension = (await import("../index.ts")).default;

// ── Tests (sequential; each scenario uses a fresh extension instance) ───────

describe("extension smoke: session_start → delegate lifecycle", () => {
	it("single delegate: queued → running → success updates, widget projection, membership entry", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx, widgets, statuses } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		// No tracked jobs on a fresh branch → widget must be explicitly cleared.
		assert.equal(widgets.get("orchestrator-progress"), undefined);

		const updates: Update[] = [];
		const result = (await mock.tools.get("delegate")!.execute("call-1", { agent: "worker", task: "Do a thing" }, undefined, (u) => updates.push(u), { cwd: projectDir })) as {
			content: { text: string }[];
			details: { reports: { jobId: string; status: string }[] };
		};
		const jobId = (updates[0]?.details as { jobId?: string })?.jobId ?? "";
		assert.ok(jobId.length > 0, "first update must carry the jobId");
		const texts = updates.map((u) => u.content[0]!.text);
		assert.ok(texts[0]!.includes(`job ${jobId}`) && texts[0]!.includes("— queued"), `baseline update: ${texts[0]}`);
		assert.ok(texts.some((t) => t === `job ${jobId}: running`), `real transition streamed: ${texts.join(" | ")}`);
		assert.equal(texts[texts.length - 1], `job ${jobId}: success`);
		assert.equal(result.details.reports[0]!.status, "success");
		assert.ok(result.content[0]!.text.includes("success"), `tool result reports success: ${result.content[0]!.text.slice(0, 120)}`);

		// Widget projects the finished job; status line shows the count.
		const lines = widgets.get("orchestrator-progress")!;
		assert.equal(lines![0], "Plan");
		assert.ok(lines!.some((l) => l.startsWith(`✓ #${shortJobId(jobId)}`)), `done row: ${lines!.join(" | ")}`);
		assert.ok(lines!.includes("1/1 done"));
		assert.equal(statuses.get("orchestrator"), "1/1 done");

		// Membership persisted for THIS branch (session-entry custom type).
		assert.deepEqual(
			mock.entries.filter((e) => e.customType === "orchestrator.progress-jobs").map((e) => (e.data as { jobIds: string[] }).jobIds),
			[[jobId]],
		);
	});

	it("batch DAG: partial updates stream as each job settles, before the batch completes", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx, widgets, statuses } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		const updates: Update[] = [];
		const result = (await mock.tools.get("delegate")!.execute(
			"call-2",
			{ jobs: [{ agent: "worker", task: "Root job", id: "smoke-root" }, { agent: "worker", task: "Dependent job", id: "smoke-dep", dependsOn: ["smoke-root"] }] },
			undefined,
			(u) => updates.push(u),
			{ cwd: projectDir },
		)) as { details: { reports: { jobId: string; status: string }[] } };

		const texts = updates.map((u) => u.content[0]!.text);
		const first = texts.findIndex((t) => t.includes("DAG progress: 1/2") && t.includes("smoke-root: success"));
		const second = texts.findIndex((t) => t.includes("DAG progress: 2/2") && t.includes("smoke-dep: success"));
		assert.ok(first >= 0, `partial update for smoke-root missing: ${texts.join(" | ")}`);
		assert.ok(second > first, "1/2 partial update must precede the 2/2 update");
		const firstDetails = updates[first]!.details as { reports: unknown[] };
		assert.equal(firstDetails.reports.length, 1, "partial update carries only the settled report so far");
		assert.equal(result.details.reports.length, 2);

		const lines = widgets.get("orchestrator-progress")!;
		assert.ok(lines!.some((l) => l.startsWith("✓ #smoke-root")));
		assert.ok(lines!.some((l) => l.startsWith("✓ #smoke-dep")));
		assert.ok(lines!.includes("2/2 done"));
		assert.equal(statuses.get("orchestrator"), "2/2 done");

		assert.deepEqual(
			mock.entries.filter((e) => e.customType === "orchestrator.progress-jobs").map((e) => (e.data as { jobIds: string[] }).jobIds),
			[["smoke-root", "smoke-dep"]],
		);
	});

	it("a throwing onUpdate never affects the job outcome", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx, widgets } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const result = (await mock.tools.get("delegate")!.execute(
			"call-3",
			{ agent: "worker", task: "Observer-hostile caller" },
			undefined,
			() => {
				throw new Error("observer boom");
			},
			{ cwd: projectDir },
		)) as { details: { reports: { status: string }[] } };
		assert.equal(result.details.reports[0]!.status, "success");
		assert.ok(widgets.get("orchestrator-progress")!.some((l) => l.startsWith("✓ #")));
	});
});

describe("extension smoke: session isolation, restore, branch navigation", () => {
	it("a second session in the same cwd never inherits the first session's jobs", async () => {
		const mockA = makeMockPi();
		extension(mockA.pi);
		const ctxA = makeCtx();
		await mockA.handlers.get("session_start")!({}, ctxA.ctx);
		await mockA.tools.get("delegate")!.execute("call-4", { agent: "worker", task: "Session A job", id: "iso-a" }, undefined, undefined, { cwd: projectDir });
		assert.ok(ctxA.widgets.get("orchestrator-progress")!.some((l) => l.startsWith("✓ #iso-a")));

		// Session B: same cwd + same orchestrator root, but its OWN (empty) branch.
		const mockB = makeMockPi();
		extension(mockB.pi);
		const ctxB = makeCtx();
		await mockB.handlers.get("session_start")!({}, ctxB.ctx);
		assert.equal(ctxB.widgets.get("orchestrator-progress"), undefined, "session B must not see session A's jobs");
		assert.equal(ctxB.statuses.get("orchestrator"), undefined);
	});

	it("restore re-projects the branch's membership entries; navigating to a jobless branch clears stale widget lines", async () => {
		const mockA = makeMockPi();
		extension(mockA.pi);
		const ctxA = makeCtx();
		await mockA.handlers.get("session_start")!({}, ctxA.ctx);
		await mockA.tools.get("delegate")!.execute("call-5", { agent: "worker", task: "Restored job", id: "restore-a" }, undefined, undefined, { cwd: projectDir });

		// New session (same process semantics as /resume) with session A's branch.
		const mockB = makeMockPi();
		extension(mockB.pi);
		const ctxB = makeCtx(branchEntries(mockA.entries));
		await mockB.handlers.get("session_start")!({}, ctxB.ctx);
		const restored = ctxB.widgets.get("orchestrator-progress")!;
		assert.ok(restored.some((l) => l.startsWith("✓ #restore-a")), `restored job visible: ${restored.join(" | ")}`);
		assert.ok(restored.includes("1/1 done"));

		// Branch navigation (/tree) to a branch with no membership entries → the
		// previously displayed tasks must be CLEARED, not left stale.
		const { ctx: ctxTree, widgets, statuses } = makeCtx();
		await mockB.handlers.get("session_tree")!({}, ctxTree);
		assert.equal(widgets.get("orchestrator-progress"), undefined, "stale widget lines must be cleared on branch navigation");
		assert.equal(statuses.get("orchestrator"), undefined, "stale status text must be cleared on branch navigation");
	});
});
