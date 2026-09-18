/**
 * Cross-contract integration test: real orchestrator extension (`jobs
 * action=plan` producer) → real branch custom-entry shape + persisted job.json
 * → frozen pi-session-desk consumer contract (tests/fixtures/desk-plan-consumer.ts).
 *
 * No cross-repo dependency and no provider calls: the worker subprocess is a
 * deterministic fake, exactly like tests/extension-smoke.test.ts.
 *
 * The consumer fixture is a faithful local mirror of the sibling
 * pi-workspace/src/plan.ts validators; if the producer wire shape drifts, these
 * tests fail even though the producer's own tests pass.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	collectMembershipBindings as deskBindings,
	collectMembershipJobIds as deskJobIds,
	deriveWorkspaceModel,
	PLAN_ENTRY_TYPE,
	PROGRESS_MEMBERSHIP_ENTRY_TYPE,
	readLatestPlan as deskReadLatestPlan,
	type DeskJobLike,
} from "./fixtures/desk-plan-consumer.ts";

// ── Hermetic sandbox (before importing the extension) ──────────────────────

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "plan-contract-"));
const agentDir = path.join(sandbox, "pi-agent");
const agentsRoot = path.join(sandbox, "agents");
const orchRoot = path.join(sandbox, "orchestrator");
const projectDir = path.join(sandbox, "project");
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_ORCHESTRATOR_SUBAGENT;
for (const dir of [path.join(agentsRoot, "worker"), orchRoot, projectDir]) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(
	path.join(agentsRoot, "worker", "AGENT.md"),
	[
		"---",
		"name: worker",
		"description: Deterministic contract-test worker.",
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
		"  maxAttempts: 4",
		"hooks:",
		"  enabled: false",
		"---",
		"",
		"Contract worker body.",
		"",
	].join("\n"),
);

fs.writeFileSync(
	path.join(orchRoot, "models.yaml"),
	["models:", "  worker-cheap:", "    provider: fake", "    model: fake/cheap", "defaults:", "  worker: worker-cheap", ""].join("\n"),
);

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
		"  summary: 'contract worker finished',",
		"  findings: [], changes: [],",
		"  validation: { status: 'passed', checks: [] },",
		"  artifacts: [], blockers: [], followUps: [], metrics: {},",
		"};",
		"if (process.env.PI_ORCHESTRATOR_RESULT_PATH) fs.writeFileSync(process.env.PI_ORCHESTRATOR_RESULT_PATH, JSON.stringify(result));",
		"const line = (o) => console.log(JSON.stringify(o));",
		"line({ type: 'session_start', sessionId: 'fake-worker-session' });",
		"line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 2 }, stopReason: 'stop' } });",
		"",
	].join("\n"),
);

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
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => handlers.set(event, handler),
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: ((u: Update) => void) | undefined, ctx: unknown) => Promise<unknown> }) => tools.set(tool.name, tool),
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

function makeCtx(branch: unknown[] = []): ExtensionContext {
	return {
		cwd: projectDir,
		hasUI: true,
		ui: { setWidget: () => {}, setStatus: () => {}, notify: () => {}, theme: undefined },
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: { getBranch: () => branch, getSessionId: () => "contract-session", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
}

/** Real pi custom-entry shape: `{ type: "custom", customType, data }`. */
function realBranch(entries: { customType: string; data: unknown }[]): unknown[] {
	return entries
		.filter((e) => e.customType === PLAN_ENTRY_TYPE || e.customType === PROGRESS_MEMBERSHIP_ENTRY_TYPE)
		.map((e) => ({ type: "custom", customType: e.customType, data: e.data }));
}

const extension = (await import("../index.ts")).default;

async function startSession(mock: MockPi, branch: unknown[] = []): Promise<ExtensionContext> {
	const ctx = makeCtx(branch);
	await mock.handlers.get("session_start")!({}, ctx);
	return ctx;
}

async function runJobs(mock: MockPi, ctx: ExtensionContext, params: Record<string, unknown>): Promise<{ content: { text: string }[]; isError?: boolean; details: Record<string, unknown> }> {
	return (await mock.tools.get("jobs")!.execute("call", { ...params }, undefined, undefined, ctx)) as {
		content: { text: string }[];
		isError?: boolean;
		details: Record<string, unknown>;
	};
}

async function runDelegate(mock: MockPi, ctx: ExtensionContext, params: Record<string, unknown>): Promise<void> {
	await mock.tools.get("delegate")!.execute("call", params, undefined, undefined, ctx);
}

/** Project a persisted JobRecord the way pi-desk projects job.json → DeskJob. */
function deskJobFromRecord(record: Record<string, unknown>): DeskJobLike {
	const status = String(record.status ?? "unknown");
	const state: DeskJobLike["state"] =
		status === "success"
			? "done"
			: status === "running"
				? "running"
				: status === "failed"
					? "failed"
					: status === "cancelled"
						? "cancelled"
						: status === "interrupted"
							? "interrupted"
							: status === "blocked"
								? "blocked"
								: "queued";
	return {
		jobId: String(record.jobId),
		label: String(record.objective ?? "").split("\n")[0]!.slice(0, 48),
		status,
		state,
		agent: String(record.agent ?? "unknown"),
		lastValidation: typeof record.lastValidation === "string" ? record.lastValidation : undefined,
		latestAttemptId: typeof record.latestAttemptId === "string" ? record.latestAttemptId : undefined,
	};
}

function readPersistedJob(jobId: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(orchRoot, "jobs", jobId, "job.json"), "utf8")) as Record<string, unknown>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("plan producer → pi-workspace consumer contract", () => {
	it("accepts the plan before any job exists and shows unlinked planned steps", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const ctx = await startSession(mock);

		await runJobs(mock, ctx, {
			action: "plan",
			steps: [
				{ id: "parse-j1", title: "Parse config", agent: "worker" },
				{ id: "tests-j2", title: "Test parser", agent: "worker", dependsOn: ["parse-j1"] },
			],
		});

		const branch = realBranch(mock.entries);
		const plan = deskReadLatestPlan(branch);
		assert.ok(plan, "consumer must accept a plan published before any job exists");
		assert.equal(plan.revision, 1);
		assert.deepEqual(
			plan.steps.map((s) => [s.id, s.title, s.agent, s.status, s.dependsOn.join(",")]),
			[
				["parse-j1", "Parse config", "worker", "planned", ""],
				["tests-j2", "Test parser", "worker", "planned", "parse-j1"],
			],
		);

		const model = deriveWorkspaceModel({ plan, jobs: [], bindings: deskBindings(branch), requestedJobIds: deskJobIds(branch), missingJobIds: [] });
		assert.equal(model.planMissing, false);
		assert.deepEqual(model.steps.map((s) => `${s.id}=${s.state}`), ["parse-j1=planned", "tests-j2=planned"]);
		assert.ok(model.steps.every((s) => s.unlinked), "no jobs yet → unlinked steps");
	});

	it("binds a delegated alias job and derives completed live state for the desk", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const ctx = await startSession(mock);

		await runJobs(mock, ctx, {
			action: "plan",
			steps: [
				{ id: "parse-j1", title: "Parse config", agent: "worker" },
				{ id: "tests-j2", title: "Test parser", agent: "worker", dependsOn: ["parse-j1"] },
			],
		});
		await runDelegate(mock, ctx, { agent: "worker", task: "Do parse", id: "parse-j1" });

		const branch = realBranch(mock.entries);
		const plan = deskReadLatestPlan(branch);
		assert.ok(plan);
		const bindings = deskBindings(branch);
		assert.deepEqual(bindings, [{ jobId: "parse-j1", stepId: "parse-j1" }], "alias binding recorded in the membership entry");
		assert.deepEqual(deskJobIds(branch), ["parse-j1"]);

		const job = deskJobFromRecord(readPersistedJob("parse-j1"));
		const model = deriveWorkspaceModel({ plan, jobs: [job], bindings, requestedJobIds: deskJobIds(branch), missingJobIds: [] });
		assert.equal(model.steps.find((s) => s.id === "parse-j1")!.state, "completed");
		assert.equal(model.steps.find((s) => s.id === "parse-j1")!.executingAgent, "worker");
		assert.equal(model.steps.find((s) => s.id === "tests-j2")!.state, "planned");
		assert.equal(model.otherJobs.length, 0, "a linked job must not leak into otherJobs");
	});

	it("retains omitted steps across a revision and the consumer reads the latest revision", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const ctx = await startSession(mock);
		await runJobs(mock, ctx, { action: "plan", steps: [{ id: "s1", title: "One" }, { id: "s2", title: "Two", status: "running" }] });
		const rev2 = await runJobs(mock, ctx, { action: "plan", steps: [{ id: "s2", title: "Two", status: "completed" }] });
		assert.match(rev2.content[0]!.text, /revision 2/);

		const plan = deskReadLatestPlan(realBranch(mock.entries));
		assert.ok(plan);
		assert.equal(plan.revision, 2);
		assert.deepEqual(plan.steps.map((s) => `${s.id}:${s.status}`), ["s1:planned", "s2:completed"], "omitted step retained verbatim");
	});

	it("writes nothing for invalid input; the consumer keeps the last valid revision", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const ctx = await startSession(mock);
		await runJobs(mock, ctx, { action: "plan", steps: [{ id: "s1", title: "One" }] });

		const bad = await runJobs(mock, ctx, { action: "plan", steps: [{ id: "s1", title: "a" }, { id: "s1", title: "b" }] });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0]!.text, /duplicate step id/);
		assert.equal(mock.entries.filter((e) => e.customType === PLAN_ENTRY_TYPE).length, 1, "invalid plan must not append an entry");

		const plan = deskReadLatestPlan(realBranch(mock.entries));
		assert.ok(plan);
		assert.equal(plan.revision, 1, "consumer still sees exactly the last valid revision");
	});

	it("preserves membership bindings across followup/retry and does not duplicate them after a reload", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const ctx = await startSession(mock);
		await runJobs(mock, ctx, { action: "plan", steps: [{ id: "alias-job", title: "Bound", agent: "worker" }] });
		await runDelegate(mock, ctx, { agent: "worker", task: "Do it", id: "alias-job" });

		const membershipCount = () => mock.entries.filter((e) => e.customType === PROGRESS_MEMBERSHIP_ENTRY_TYPE).length;
		const bindings = () => deskBindings(realBranch(mock.entries));
		assert.deepEqual(bindings(), [{ jobId: "alias-job", stepId: "alias-job" }]);

		await runJobs(mock, ctx, { action: "followup", jobId: "alias-job", message: "more" });
		assert.deepEqual(bindings(), [{ jobId: "alias-job", stepId: "alias-job" }], "followup keeps the binding");
		const afterFollowup = membershipCount();

		await runJobs(mock, ctx, { action: "retry", jobId: "alias-job" });
		assert.deepEqual(bindings(), [{ jobId: "alias-job", stepId: "alias-job" }], "retry keeps the binding");
		assert.equal(membershipCount(), afterFollowup, "no duplicate binding entry within the session");

		// Reload: a fresh extension instance restores from the branch, then a
		// retry must not re-append an already-persisted binding.
		const reloaded = makeMockPi();
		extension(reloaded.pi);
		const ctx2 = await startSession(reloaded, realBranch(mock.entries));
		await runJobs(reloaded, ctx2, { action: "retry", jobId: "alias-job" });
		const newMembership = reloaded.entries.filter((e) => e.customType === PROGRESS_MEMBERSHIP_ENTRY_TYPE);
		assert.equal(newMembership.length, 0, "restored binding dedupe state prevents a redundant membership entry");
		assert.deepEqual(deskBindings(realBranch([...mock.entries, ...reloaded.entries])), [{ jobId: "alias-job", stepId: "alias-job" }]);
	});

	it("auto-publishes a consumer-valid plan when the model omits jobs action=plan", async () => {
		const mock = makeMockPi();
		extension(mock.pi);
		const ctx = await startSession(mock);

		// No jobs action=plan: delegation alone must produce a structured plan.
		await runDelegate(mock, ctx, { agent: "worker", task: "Parse config. Then validate.", id: "auto-contract-a" });
		await runDelegate(mock, ctx, { agent: "worker", task: "Follow-up job", id: "auto-contract-b", dependsOn: ["auto-contract-a"] });

		const branch = realBranch(mock.entries);
		const plan = deskReadLatestPlan(branch);
		assert.ok(plan, "consumer must see an auto-published plan");
		assert.deepEqual(
			plan.steps.map((s) => [s.id, s.title, s.dependsOn.join(",")]),
			[
				["auto-contract-a", "Parse config.", ""],
				["auto-contract-b", "Follow-up job", "auto-contract-a"],
			],
		);
		const jobs = [deskJobFromRecord(readPersistedJob("auto-contract-a")), deskJobFromRecord(readPersistedJob("auto-contract-b"))];
		const model = deriveWorkspaceModel({ plan, jobs, bindings: deskBindings(branch), requestedJobIds: deskJobIds(branch), missingJobIds: [] });
		assert.equal(model.planMissing, false);
		assert.equal(model.steps.find((s) => s.id === "auto-contract-a")!.state, "completed");
		assert.equal(model.steps.find((s) => s.id === "auto-contract-b")!.state, "completed");
	});
});

describe("plan producer default jobs root parity with the desk reader", () => {
	it("orchestratorRoot()/jobs equals the desk default `~/.pi/orchestrator/jobs`", async () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		try {
			const { orchestratorRoot } = await import("../discovery.ts");
			const producerJobsRoot = path.join(orchestratorRoot(), "jobs");
			const deskDefaultJobsRoot = path.join(os.homedir(), ".pi", "orchestrator", "jobs");
			assert.equal(producerJobsRoot, deskDefaultJobsRoot);
			assert.match(producerJobsRoot, /[/\\]\.pi[/\\]orchestrator[/\\]jobs$/);
		} finally {
			if (saved !== undefined) process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});
