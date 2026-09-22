/**
 * Shared test harness: builds an Orchestrator backed by a temp root, a stub
 * agent set, and an injectable fake worker runner (no pi subprocesses).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BudgetManager } from "../core/budget.ts";
import { ConcurrencyManager } from "../core/concurrency.ts";
import { EventLog } from "../core/events.ts";
import { ModelRegistry } from "../core/models.ts";
import { Orchestrator, type OrchestratorConfig } from "../core/orchestrator.ts";
import { Router, type RoutingRule } from "../core/routing.ts";
import type { SpawnOutcome, SpawnRequest } from "../core/spawn.ts";
import { JobStore } from "../core/storage.ts";
import type { AgentConfig, JobResult, UsageInfo } from "../core/types.ts";
import { DEFAULT_RETRY, emptyValidation } from "../core/types.ts";

/** Temp roots created by this harness; removed on process exit even when an
 * individual test forgets cleanup() (guards against /tmp/orch-test-* leaks). */
const liveRoots = new Set<string>();

export function tmpRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
	liveRoots.add(root);
	return root;
}

/** Mark a temp root as explicitly cleaned (so exit cleanup skips it). */
export function releaseRoot(root: string): void {
	liveRoots.delete(root);
}

function cleanupLiveRoots(): void {
	for (const root of liveRoots) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	liveRoots.clear();
	if (agentDirsBase) cleanupAgentDirs();
}
process.on("exit", cleanupLiveRoots);

/** Harness-owned base dir for fake agent dirs (never touches /tmp/agents). */
let agentDirsBase: string | null = null;
function agentDirsRoot(): string {
	if (!agentDirsBase) agentDirsBase = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-agents-"));
	return agentDirsBase;
}
export function cleanupAgentDirs(): void {
	if (agentDirsBase) {
		fs.rmSync(agentDirsBase, { recursive: true, force: true });
		agentDirsBase = null;
	}
}

export function makeAgent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
	const dir = overrides.dir ?? path.join(agentDirsRoot(), overrides.name);
	return {
		description: `${overrides.name} test agent`,
		role: "sub",
		runtime: {},
		limits: { timeoutSeconds: 60 },
		context: { mode: "selective" },
		workspace: { strategy: "cwd", cleanup: "keep" },
		validation: {},
		retry: DEFAULT_RETRY,
		hooks: { enabled: false },
		systemPrompt: `You are ${overrides.name}.`,
		filePath: path.join(dir, "AGENT.md"),
		source: "user",
		hookPaths: [],
		mainHookPaths: [],
		schema: "v2",
		...overrides,
		dir,
	} as AgentConfig;
}

export function writeRegistry(root: string, modelsYaml: string): void {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "models.yaml"), modelsYaml);
}

export const TEST_MODELS_YAML = `
models:
  worker-cheap:
    provider: openrouter
    model: test/cheap
  worker-best:
    provider: openrouter
    model: test/best
  frontier:
    provider: anthropic
    model: test/frontier
defaults:
  worker: worker-cheap
`;

export interface Harness {
	root: string;
	orch: Orchestrator;
	registry: ModelRegistry;
	agents: AgentConfig[];
	workerCalls: SpawnRequest[];
	setWorker(fn: (req: SpawnRequest, callIndex: number) => Promise<SpawnOutcome> | SpawnOutcome): void;
	cleanup(): void;
}

export function makeHarness(opts: { root?: string; rules?: RoutingRule[]; agents?: AgentConfig[]; concurrency?: { global: number; byModel: Record<string, number> } } = {}): Harness {
	const root = opts.root ?? tmpRoot();
	writeRegistry(root, TEST_MODELS_YAML);
	const registry = new ModelRegistry(root);
	const store = new JobStore(root);
	const agents = opts.agents ?? [makeAgent({ name: "worker" }), makeAgent({ name: "coder" })];
	const calls: SpawnRequest[] = [];
	let workerFn: (req: SpawnRequest, i: number) => Promise<SpawnOutcome> | SpawnOutcome = () =>
		outcome({ status: "success", summary: "stub" });

	const config: OrchestratorConfig = {
		root,
		workerExtensionPath: path.join(root, "worker.ts"),
		agentsRoot: path.join(root, "agents"),
		registry,
		router: new Router(registry, opts.rules ?? []),
		concurrency: new ConcurrencyManager(opts.concurrency ?? { global: 4, byModel: {} }),
		budgets: new BudgetManager(root),
		events: new EventLog(store.jobsDir()),
		store,
		defaults: { budget: {}, concurrency: { global: 4, byModel: {} } },
		workerRunner: async (req) => {
			calls.push(req);
			return workerFn(req, calls.length - 1);
		},
	};

	return {
		root,
		orch: new Orchestrator(config),
		registry,
		agents,
		workerCalls: calls,
		setWorker(fn) {
			workerFn = fn;
		},
		cleanup() {
			cleanupAgentDirs();
			fs.rmSync(root, { recursive: true, force: true });
			releaseRoot(root);
		},
	};
}

export function emptyUsage(): UsageInfo {
	return { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, contextTokens: 150, turns: 2 };
}

/** A successful worker outcome that writes result.json like a real worker. */
export function outcome(result: Partial<JobResult> & { status: JobResult["status"]; summary: string }, opts: { writeResultFile?: boolean; finalText?: string; runError?: SpawnOutcome["runError"]; usage?: UsageInfo } = {}): SpawnOutcome {
	const writeResultFile = opts.writeResultFile ?? true;
	return {
		exitCode: opts.runError ? 1 : 0,
		messages: [],
		finalText: opts.finalText ?? `${result.status}: ${result.summary}`,
		usage: opts.usage ?? emptyUsage(),
		stderrTail: "",
		runError: opts.runError,
		// the fake worker writes result.json through the seam below
		__result: writeResultFile ? result : undefined,
	} as SpawnOutcome & { __result?: Partial<JobResult> };
}

/** Wrap a fake outcome so result.json lands in the attempt dir (like a real worker). */
export function writingWorker(make: (attemptDir: string, jobId: string, attemptId: string) => SpawnOutcome): (req: SpawnRequest) => SpawnOutcome {
	return (req) => {
		const o = make(req.attemptDir, req.jobId, req.attemptId);
		const r = (o as any).__result as Partial<JobResult> | undefined;
		if (r) {
			const full: JobResult = {
				schemaVersion: 1,
				jobId: req.jobId,
				attemptId: req.attemptId,
				findings: [],
				changes: [],
				validation: emptyValidation(),
				artifacts: [],
				blockers: [],
				followUps: [],
				metrics: {},
				...r,
			} as JobResult;
			fs.writeFileSync(path.join(req.attemptDir, "result.json"), JSON.stringify(full, null, 2));
		}
		return o;
	};
}
