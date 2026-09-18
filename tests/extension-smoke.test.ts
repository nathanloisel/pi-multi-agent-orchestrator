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

function makeCtx(branch: unknown[] = []): {
	ctx: ExtensionContext;
	widgets: Map<string, string[] | undefined>;
	statuses: Map<string, string | undefined>;
	widgetCalls: { key: string; content: string[] | undefined }[];
} {
	const widgets = new Map<string, string[] | undefined>();
	const statuses = new Map<string, string | undefined>();
	const widgetCalls: { key: string; content: string[] | undefined }[] = [];
	const ctx = {
		cwd: projectDir,
		hasUI: true,
		ui: {
			setWidget: (key: string, content: string[] | undefined) => {
				widgetCalls.push({ key, content });
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
	return { ctx, widgets, statuses, widgetCalls };
}

/** Membership and plan entries as a real pi session branch would store them. */
function branchEntries(entries: { customType: string; data: unknown }[]): unknown[] {
	return entries
		.filter((e) => e.customType === "orchestrator.progress-jobs" || e.customType === "orchestrator.plan")
		.map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
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

		// The removed above-editor Plan widget is never populated; the compact
		// footer still reports live progress.
		assert.equal(widgets.get("orchestrator-progress"), undefined, "no above-editor Plan widget payload");
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

		assert.equal(widgets.get("orchestrator-progress"), undefined, "no above-editor Plan widget payload");
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
		assert.equal(widgets.get("orchestrator-progress"), undefined);
	});
});

describe("extension smoke: session isolation, restore, branch navigation", () => {
	it("a second session in the same cwd never inherits the first session's jobs", async () => {
		const mockA = makeMockPi();
		extension(mockA.pi);
		const ctxA = makeCtx();
		await mockA.handlers.get("session_start")!({}, ctxA.ctx);
		await mockA.tools.get("delegate")!.execute("call-4", { agent: "worker", task: "Session A job", id: "iso-a" }, undefined, undefined, { cwd: projectDir });
		assert.equal(ctxA.widgets.get("orchestrator-progress"), undefined);
		assert.equal(ctxA.statuses.get("orchestrator"), "1/1 done", "session A footer still reports its own job");

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
		assert.equal(ctxB.widgets.get("orchestrator-progress"), undefined, "restore never renders the removed widget");
		assert.equal(ctxB.statuses.get("orchestrator"), "1/1 done", "restored job still reflected in the footer");

		// Branch navigation (/tree) to a branch with no membership entries → the
		// previously displayed task must be CLEARED from the footer, not left stale.
		const { ctx: ctxTree, widgets, statuses } = makeCtx();
		await mockB.handlers.get("session_tree")!({}, ctxTree);
		assert.equal(widgets.get("orchestrator-progress"), undefined, "stale widget must be cleared on branch navigation");
		assert.equal(statuses.get("orchestrator"), undefined, "stale status text must be cleared on branch navigation");
	});
});

// ── Structured plan (jobs action=plan) ──────────────────────────────────────

interface PlanToolResult {
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
	isError?: boolean;
}

interface PlanEntryData {
	revision: number;
	planId: string;
	steps: { id: string; title: string; jobIds: string[]; dependsOn?: string[]; status: string }[];
}

interface MembershipEntryData {
	jobIds: string[];
	bindings?: { jobId: string; stepId: string }[];
}

function planEntries(mock: MockPi): PlanEntryData[] {
	return mock.entries.filter((e) => e.customType === "orchestrator.plan").map((e) => e.data as PlanEntryData);
}

function membershipEntries(mock: MockPi): MembershipEntryData[] {
	return mock.entries.filter((e) => e.customType === "orchestrator.progress-jobs").map((e) => e.data as MembershipEntryData);
}

async function runPlan(mock: MockPi, params: Record<string, unknown>): Promise<PlanToolResult> {
	return (await mock.tools.get("jobs")!.execute("call-plan", { action: "plan", ...params }, undefined, undefined, { cwd: projectDir })) as PlanToolResult;
}

describe("extension smoke: structured plan (jobs action=plan)", () => {
	it("registers the plan schema and publishes a branch-scoped snapshot", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		const tool = mock.tools.get("jobs") as unknown as { parameters?: { properties?: Record<string, unknown> } };
		const props = tool.parameters?.properties ?? {};
		assert.ok(props.action, "jobs schema exposes action");
		assert.ok(props.steps, "jobs schema exposes steps");
		assert.ok(props.planId, "jobs schema exposes planId");
		assert.match(JSON.stringify(props), /"plan"/, "action enum includes plan");

		const result = await runPlan(mock, {
			steps: [
				{ id: "parse-j1", title: "Add YAML parser to core/config.ts", agent: "worker" },
				{ id: "tests-j2", title: "Parser unit tests", dependsOn: ["parse-j1"] },
			],
		});
		assert.notEqual(result.isError, true);
		assert.match(result.content[0]!.text, /plan "plan" revision 1: 2 steps/);

		const plans = planEntries(mock);
		assert.equal(plans.length, 1);
		assert.equal(plans[0]!.revision, 1);
		assert.equal(plans[0]!.planId, "plan");
		assert.deepEqual(plans[0]!.steps.map((s) => s.id), ["parse-j1", "tests-j2"]);
		assert.deepEqual(plans[0]!.steps[1]!.jobIds, []);
		assert.equal(plans[0]!.steps[1]!.status, "planned");
	});

	it("rejects an invalid plan atomically: no entry appended, revision unchanged", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		await runPlan(mock, { steps: [{ id: "s1", title: "One" }] });

		const bad = await runPlan(mock, { steps: [{ id: "s1", title: "a" }, { id: "s1", title: "b" }] });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0]!.text, /duplicate step id/);
		assert.equal(planEntries(mock).length, 1, "invalid plan must not append");

		const badCycle = await runPlan(mock, { steps: [{ id: "x", title: "x", dependsOn: ["y"] }, { id: "y", title: "y", dependsOn: ["x"] }] });
		assert.equal(badCycle.isError, true);
		assert.equal(planEntries(mock).length, 1, "cycle must not append");
	});

	it("retains omitted steps across revisions and continues after a branch reload", async () => {
		const mockA = makeMockPi();
		extension(mockA.pi);
		const ctxA = makeCtx();
		await mockA.handlers.get("session_start")!({}, ctxA.ctx);
		await runPlan(mockA, { steps: [{ id: "s1", title: "One" }, { id: "s2", title: "Two" }] });
		const rev2 = await runPlan(mockA, { steps: [{ id: "s2", title: "Two updated", status: "completed" }] });
		assert.match(rev2.content[0]!.text, /revision 2/);
		const plansA = planEntries(mockA);
		assert.deepEqual(plansA[1]!.steps.map((s) => s.id), ["s1", "s2"]);
		assert.equal(plansA[1]!.steps[0]!.title, "One", "omitted step retained");
		assert.equal(plansA[1]!.steps[1]!.status, "completed");

		// Reload in a new extension instance with session A's branch: the plan is
		// re-derived from branch entries and the next revision continues at 3.
		const mockB = makeMockPi();
		extension(mockB.pi);
		const ctxB = makeCtx(branchEntries(mockA.entries));
		await mockB.handlers.get("session_start")!({}, ctxB.ctx);
		const rev3 = await runPlan(mockB, { steps: [{ id: "s3", title: "Three" }] });
		assert.match(rev3.content[0]!.text, /revision 3/);
		assert.deepEqual(planEntries(mockB)[0]!.steps.map((s) => s.id), ["s1", "s2", "s3"]);
	});

	it("binds a delegate alias (step id === job id) into the membership entry", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		await runPlan(mock, { steps: [{ id: "alias-job", title: "Bound step", agent: "worker" }] });

		await mock.tools.get("delegate")!.execute("call-bind", { agent: "worker", task: "Do it", id: "alias-job" }, undefined, undefined, { cwd: projectDir });
		const membership = membershipEntries(mock);
		assert.deepEqual(
			membership.flatMap((m) => m.bindings ?? []),
			[{ jobId: "alias-job", stepId: "alias-job" }],
		);
		assert.ok(membership.some((m) => m.jobIds.includes("alias-job")));
	});

	it("records an explicit jobIds binding even when the job does not exist yet", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		await runPlan(mock, { steps: [{ id: "step-a", title: "Linked step", jobIds: ["existing-job"] }] });
		const membership = membershipEntries(mock);
		assert.deepEqual(membership[0]!.bindings, [{ jobId: "existing-job", stepId: "step-a" }]);
		assert.deepEqual(membership[0]!.jobIds, ["existing-job"]);
	});

	it("shows effective live job state in the summary while the snapshot stays declared-only", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		await runPlan(mock, { steps: [{ id: "live-job", title: "Live step", agent: "worker" }] });
		await mock.tools.get("delegate")!.execute("call-live", { agent: "worker", task: "Do it", id: "live-job" }, undefined, undefined, { cwd: projectDir });
		const withJob = await runPlan(mock, { steps: [{ id: "live-job", title: "Live step", status: "completed" }] });
		assert.match(withJob.content[0]!.text, /live-job=success/);
		assert.equal(planEntries(mock).at(-1)!.steps[0]!.status, "completed", "snapshot carries declared status only");
	});
});

// ── Automatic structured-plan fallback (delegate without jobs action=plan) ──

describe("extension smoke: automatic structured plan publication", () => {
	it("auto-publishes a single-job plan with a derived first-sentence title", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		const updates: Update[] = [];
		const result = (await mock.tools.get("delegate")!.execute(
			"call-auto-single",
			{ agent: "worker", task: "Implement the YAML parser. Then run the tests.", id: "auto-single" },
			undefined,
			(u) => updates.push(u),
			{ cwd: projectDir },
		)) as { details: { reports: { status: string; jobId: string }[] } };

		assert.equal(result.details.reports[0]!.status, "success");
		const plans = planEntries(mock);
		assert.equal(plans.length, 1, "delegation without jobs action=plan must auto-publish");
		assert.equal(plans[0]!.revision, 1);
		assert.equal(plans[0]!.steps.length, 1);
		assert.equal(plans[0]!.steps[0]!.id, "auto-single");
		assert.equal(plans[0]!.steps[0]!.title, "Implement the YAML parser.", "objective first sentence");
		assert.deepEqual(plans[0]!.steps[0]!.jobIds, ["auto-single"]);

		// Alias convention / jobIds produce a membership binding for the job.
		const bound = membershipEntries(mock).flatMap((m) => m.bindings ?? []).filter((b) => b.jobId === "auto-single");
		assert.deepEqual(bound, [{ jobId: "auto-single", stepId: "auto-single" }]);
	});

	it("honours an explicit delegate title over the objective", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		await mock.tools.get("delegate")!.execute("call-auto-title", { agent: "worker", task: "Some long objective sentence. More detail.", id: "auto-titled", title: "Explicit plan title" }, undefined, undefined, { cwd: projectDir });
		assert.equal(planEntries(mock)[0]!.steps[0]!.title, "Explicit plan title");
	});

	it("batch: publishes the whole DAG before the first job runs, with dependencies and jobIds", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		let planAtFirstUpdate = -1;
		const result = (await mock.tools.get("delegate")!.execute(
			"call-auto-batch",
			{
				jobs: [
					{ agent: "worker", task: "Parse config", id: "auto-batch-root" },
					{ agent: "worker", task: "Test parser", id: "auto-batch-dep", dependsOn: ["auto-batch-root"] },
				],
			},
			undefined,
			() => {
				if (planAtFirstUpdate < 0) planAtFirstUpdate = planEntries(mock).length;
			},
			{ cwd: projectDir },
		)) as { details: { reports: { status: string }[] } };

		assert.equal(result.details.reports.length, 2);
		assert.equal(planAtFirstUpdate, 1, "plan must exist before the first run/update");
		const plans = planEntries(mock);
		assert.equal(plans.length, 1);
		assert.deepEqual(plans[0]!.steps.map((s) => s.id), ["auto-batch-root", "auto-batch-dep"]);
		assert.deepEqual(plans[0]!.steps[1]!.jobIds, ["auto-batch-dep"]);
	});

	it("subsequent delegations append missing steps without clobbering earlier ones", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		await mock.tools.get("delegate")!.execute("d1", { agent: "worker", task: "First auto job", id: "auto-add-a" }, undefined, undefined, { cwd: projectDir });
		await mock.tools.get("delegate")!.execute("d2", { agent: "worker", task: "Second auto job", id: "auto-add-b" }, undefined, undefined, { cwd: projectDir });
		await mock.tools.get("delegate")!.execute("d3", { agent: "worker", task: "Third auto job", id: "auto-add-c", dependsOn: ["auto-add-a"] }, undefined, undefined, { cwd: projectDir });

		const plans = planEntries(mock);
		assert.deepEqual(plans.map((p) => p.revision), [1, 2, 3]);
		assert.deepEqual(plans[1]!.steps.map((s) => s.id), ["auto-add-a", "auto-add-b"], "second delegate adds a step");
		assert.deepEqual(plans[2]!.steps.map((s) => s.id), ["auto-add-a", "auto-add-b", "auto-add-c"]);
		assert.deepEqual(plans[2]!.steps[2]!.dependsOn, ["auto-add-a"], "dependency on a prior auto step is retained");
		assert.equal(plans[0]!.steps[0]!.title, plans[2]!.steps[0]!.title, "earlier steps are untouched");
	});

	it("explicit plan steps win: titles/statuses are preserved and only missing steps append", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		await runPlan(mock, { steps: [{ id: "preserve-a", title: "Explicit title", agent: "worker", status: "running" }] });
		await mock.tools.get("delegate")!.execute("p1", { agent: "worker", task: "Should not replace", id: "preserve-a", title: "Auto title" }, undefined, undefined, { cwd: projectDir });
		assert.equal(planEntries(mock).length, 1, "an already-planned job must not append a revision");
		assert.equal(planEntries(mock)[0]!.steps[0]!.title, "Explicit title");
		assert.equal(planEntries(mock)[0]!.steps[0]!.status, "running");

		await mock.tools.get("delegate")!.execute("p2", { agent: "worker", task: "New auto step", id: "preserve-b" }, undefined, undefined, { cwd: projectDir });
		const rev2 = planEntries(mock);
		assert.equal(rev2.length, 2);
		assert.deepEqual(rev2[1]!.steps.map((s) => s.id), ["preserve-a", "preserve-b"]);
		assert.equal(rev2[1]!.steps[0]!.title, "Explicit title", "explicit step retained verbatim");
		assert.equal(rev2[1]!.steps[0]!.status, "running");

		// A dependency outside the batch resolves against the prior explicit step.
		await mock.tools.get("delegate")!.execute(
			"p3",
			{ jobs: [{ agent: "worker", task: "Depends on explicit", id: "preserve-c", dependsOn: ["preserve-a"] }, { agent: "worker", task: "Independent", id: "preserve-d" }] },
			undefined,
			undefined,
			{ cwd: projectDir },
		);
		const rev3 = planEntries(mock);
		assert.equal(rev3.length, 3);
		assert.deepEqual(rev3[2]!.steps.map((s) => s.id), ["preserve-a", "preserve-b", "preserve-c", "preserve-d"]);
		assert.deepEqual(rev3[2]!.steps[2]!.dependsOn, ["preserve-a"]);
	});

	it("reload/branch scope: a fresh instance continues the restored auto plan revision", async () => {
		const mockA = makeMockPi();
		extension(mockA.pi);
		const ctxA = makeCtx();
		await mockA.handlers.get("session_start")!({}, ctxA.ctx);
		await mockA.tools.get("delegate")!.execute("b1", { agent: "worker", task: "Branch first", id: "branch-auto-a" }, undefined, undefined, { cwd: projectDir });
		assert.equal(planEntries(mockA).length, 1);

		const mockB = makeMockPi();
		extension(mockB.pi);
		const ctxB = makeCtx(branchEntries(mockA.entries));
		await mockB.handlers.get("session_start")!({}, ctxB.ctx);
		await mockB.tools.get("delegate")!.execute("b2", { agent: "worker", task: "Branch second", id: "branch-auto-b" }, undefined, undefined, { cwd: projectDir });
		const plansB = planEntries(mockB);
		assert.equal(plansB.length, 1, "restored plan already contains the first step");
		assert.equal(plansB[0]!.revision, 2, "revision continues from the branch snapshot");
		assert.deepEqual(plansB[0]!.steps.map((s) => s.id), ["branch-auto-a", "branch-auto-b"]);
	});

	it("malformed historical plan entries are skipped, then auto publication starts cleanly", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx(branchEntries([{ customType: "orchestrator.plan", data: { version: 1, planId: "plan", revision: "bad", steps: [] } }]));
		await mock.handlers.get("session_start")!({}, ctx);
		await mock.tools.get("delegate")!.execute("m1", { agent: "worker", task: "Recover from malformed history", id: "malformed-recover" }, undefined, undefined, { cwd: projectDir });
		const plans = planEntries(mock);
		assert.equal(plans.length, 1);
		assert.equal(plans[0]!.revision, 1);
		assert.deepEqual(plans[0]!.steps.map((s) => s.id), ["malformed-recover"]);
	});

	it("an unsafe auto plan (over-long step id) never fails delegation and surfaces a diagnosis", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx } = makeCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		const updates: Update[] = [];
		const result = (await mock.tools.get("delegate")!.execute(
			"bad-plan",
			{ agent: "worker", task: "Unsafe plan", id: "z".repeat(81) },
			undefined,
			(u) => updates.push(u),
			{ cwd: projectDir },
		)) as { details: { reports: { status: string }[] } };

		assert.equal(result.details.reports[0]!.status, "success", "delegation must still run");
		assert.equal(planEntries(mock).length, 0, "no invalid plan entry is written");
		assert.ok(updates.some((u) => /structured plan auto-publication skipped/.test(u.content[0]!.text)), `diagnosis surfaced: ${updates.map((u) => u.content[0]!.text).join(" | ")}`);
	});
});

// ── Regression: removed inline Plan widget ───────────────────────────────────

describe("extension smoke: removed above-editor Plan widget", () => {
	it("never emits a non-empty orchestrator-progress payload across the whole lifecycle, leaves other widgets untouched, and keeps the footer", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const { ctx, widgets, statuses, widgetCalls } = makeCtx();

		// Seed an unrelated widget BEFORE session_start: every orchestrator lifecycle
		// event must leave it untouched.
		ctx.ui.setWidget("unrelated-sidebar", ["keep me"]);

		await mock.handlers.get("session_start")!({}, ctx);
		// Empty fresh branch clears the footer, and no widget payload is written.
		assert.equal(widgets.get("orchestrator-progress"), undefined);
		assert.equal(statuses.get("orchestrator"), undefined, "empty branch clears footer");
		assert.deepEqual(widgets.get("unrelated-sidebar"), ["keep me"]);

		// Single delegate: footer reflects live progress, widget stays absent.
		await mock.tools.get("delegate")!.execute("reg-single", { agent: "worker", task: "Regression single", id: "reg-single-job" }, undefined, undefined, { cwd: projectDir });
		assert.equal(statuses.get("orchestrator"), "1/1 done");
		assert.equal(widgets.get("orchestrator-progress"), undefined);

		// Batch delegate: footer counts still accumulate.
		await mock.tools.get("delegate")!.execute("reg-batch", { jobs: [{ agent: "worker", task: "Regression batch", id: "reg-batch-job" }] }, undefined, undefined, { cwd: projectDir });
		assert.equal(statuses.get("orchestrator"), "2/2 done");
		assert.equal(widgets.get("orchestrator-progress"), undefined);

		// jobs followup + retry may stream state and refresh the footer, but must
		// never resurrect the removed widget.
		await mock.tools.get("jobs")!.execute("reg-followup", { action: "followup", jobId: "reg-single-job", message: "one more pass" }, undefined, undefined, { cwd: projectDir });
		await mock.tools.get("jobs")!.execute("reg-retry", { action: "retry", jobId: "reg-single-job", strategy: "fresh" }, undefined, undefined, { cwd: projectDir });
		assert.equal(widgets.get("orchestrator-progress"), undefined);

		// Branch navigation to an empty branch clears the footer; shutdown too.
		await mock.handlers.get("session_tree")!({}, ctx);
		assert.equal(statuses.get("orchestrator"), undefined, "empty branch clears footer");
		await mock.handlers.get("session_shutdown")!({}, ctx);
		assert.equal(statuses.get("orchestrator"), undefined);

		// The removed key is only ever cleared (undefined) — never a non-empty payload.
		const progressCalls = widgetCalls.filter((c) => c.key === "orchestrator-progress");
		assert.ok(progressCalls.length > 0, "stale-widget cleanup ran at least once");
		assert.ok(
			progressCalls.every((c) => c.content === undefined),
			`unexpected non-empty orchestrator-progress payload: ${JSON.stringify(progressCalls.filter((c) => c.content !== undefined))}`,
		);
		assert.equal(widgets.get("orchestrator-progress"), undefined);
		// The unrelated widget survived every lifecycle event.
		assert.deepEqual(widgets.get("unrelated-sidebar"), ["keep me"]);
	});
});
