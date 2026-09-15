/**
 * Tests: model registry (§1, §2, §10), routing (§9, §20), budgets (§13),
 * concurrency (§12), errors (§29), storage (§28), result extraction (§4),
 * context packs (§19).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { once } from "node:events";
import { BudgetManager } from "../core/budget.ts";
import { ConcurrencyManager, Gate } from "../core/concurrency.ts";
import { classifyRunFailure, OrchestratorError } from "../core/errors.ts";
import { ModelRegistry, minimalYaml } from "../core/models.ts";
import { extractResult, renderReportMd } from "../core/result.ts";
import { Router } from "../core/routing.ts";
import { atomicWriteJson, JobStore, readJson } from "../core/storage.ts";
import { buildContextPack } from "../core/context.ts";
import { PlannerTelemetryCollector, PlannerTelemetryStore } from "../core/telemetry.ts";
import { DEFAULT_RETRY, normalizeJobResult, type AttemptRecord, type JobRecord } from "../core/types.ts";
import { makeHarness, TEST_MODELS_YAML, tmpRoot, writeRegistry } from "./helpers.ts";

// ── Model registry ──────────────────────────────────────────────────────────

describe("ModelRegistry", () => {
	it("resolves logical aliases to concrete backends", () => {
		const root = tmpRoot();
		writeRegistry(root, TEST_MODELS_YAML);
		const reg = new ModelRegistry(root);
		const r = reg.resolve("worker-cheap");
		assert.equal(r.concrete.provider, "openrouter");
		assert.equal(r.concrete.model, "test/cheap");
		assert.equal(r.source, "registry");
	});

	it("falls back to the default worker alias when no ref given", () => {
		const root = tmpRoot();
		writeRegistry(root, TEST_MODELS_YAML);
		const reg = new ModelRegistry(root);
		assert.equal(reg.resolve(undefined).alias, "worker-cheap");
	});

	it("accepts explicit concrete provider/model overrides", () => {
		const root = tmpRoot();
		writeRegistry(root, TEST_MODELS_YAML);
		const reg = new ModelRegistry(root);
		const r = reg.resolve("anthropic/claude-opus-4-8:high");
		assert.equal(r.concrete.provider, "anthropic");
		assert.equal(r.concrete.model, "claude-opus-4-8");
		assert.equal(r.concrete.effort, "high");
		assert.equal(r.source, "override");
	});

	it("throws on unknown alias with a helpful message", () => {
		const root = tmpRoot();
		writeRegistry(root, TEST_MODELS_YAML);
		const reg = new ModelRegistry(root);
		assert.throws(() => reg.resolve("worker-nonexistent"), /Unknown model alias/);
	});

	it("produces pi launch config (--model/--thinking) — provider swap is config-only", () => {
		const root = tmpRoot();
		writeRegistry(root, TEST_MODELS_YAML);
		const reg = new ModelRegistry(root);
		const cfg = reg.toLaunchConfig(reg.resolve("worker-best"), "medium");
		assert.deepEqual(cfg.args, ["--model", "openrouter/test/best", "--thinking", "medium"]);

		// Future local backend: same code path, different registry file (§10, §34).
		writeRegistry(root, `models:\n  worker-cheap:\n    provider: local-openai-compatible\n    model: swift-qwen-27b\n    baseUrl: http://gpu:8080/v1\n    apiKeyEnv: LOCAL_LLM_KEY\n`);
		const reg2 = new ModelRegistry(root);
		const cfg2 = reg2.toLaunchConfig(reg2.resolve("worker-cheap"));
		assert.deepEqual(cfg2.args, ["--model", "local-openai-compatible/swift-qwen-27b"]);
		assert.ok(reg2.providerRegistrations !== undefined);
	});

	it("supports alias experiments (worker-cheap-a/b) without touching agents (§22)", () => {
		const root = tmpRoot();
		writeRegistry(
			root,
			`models:\n  worker-cheap-a:\n    provider: openrouter\n    model: test/a\n  worker-cheap-b:\n    provider: openrouter\n    model: test/b\n`,
		);
		const reg = new ModelRegistry(root);
		assert.equal(reg.resolve("worker-cheap-a").concrete.model, "test/a");
		assert.equal(reg.resolve("worker-cheap-b").concrete.model, "test/b");
	});

	it("minimalYaml parses the nested registry subset", () => {
		const parsed = minimalYaml("models:\n  worker-cheap:\n    provider: openrouter\n    model: test/cheap\n") as any;
		assert.equal(parsed.models["worker-cheap"].provider, "openrouter");
	});
});

// ── Routing ─────────────────────────────────────────────────────────────────

function mkJob(over: Partial<JobRecord> = {}): JobRecord {
	return {
		schemaVersion: 1,
		jobId: "j1",
		objective: "obj",
		agent: "worker",
		dependsOn: [],
		status: "queued",
		createdAt: 0,
		updatedAt: 0,
		cwd: "/tmp",
		retry: DEFAULT_RETRY,
		attemptCount: 0,
		...over,
	};
}

function mkAttempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
	return {
		schemaVersion: 1,
		attemptId: "attempt-001",
		jobId: "j1",
		agent: "worker",
		retryMode: "initial",
		status: "failed",
		startedAt: 0,
		...over,
	};
}

describe("Router", () => {
	const root = tmpRoot();
	writeRegistry(root, TEST_MODELS_YAML);
	const reg = new ModelRegistry(root);

	it("attempt 1 uses the agent default alias", () => {
		const router = new Router(reg);
		const d = router.decide({ job: mkJob(), attemptNumber: 1, previousAttempts: [], agentDefaultModel: "worker-cheap" });
		assert.equal(d.alias, "worker-cheap");
		assert.equal(d.reason.includes("initial"), true);
	});

	it("ladder: cheap fresh retry → worker-best → frontier (§16, §20)", () => {
		const router = new Router(reg);
		const attempts = [mkAttempt({ logicalModel: "worker-cheap", status: "failed", exitReason: "validation_failed" })];
		const d2 = router.decide({ job: mkJob(), attemptNumber: 2, previousAttempts: attempts, agentDefaultModel: "worker-cheap" });
		assert.equal(d2.alias, "worker-cheap");
		assert.equal(d2.strategy, "fresh");

		attempts.push(mkAttempt({ attemptId: "attempt-002", logicalModel: "worker-cheap", status: "failed" }));
		const d3 = router.decide({ job: mkJob(), attemptNumber: 3, previousAttempts: attempts, agentDefaultModel: "worker-cheap" });
		assert.equal(d3.alias, "worker-best");

		attempts.push(mkAttempt({ attemptId: "attempt-003", logicalModel: "worker-best", status: "failed" }));
		const d4 = router.decide({ job: mkJob(), attemptNumber: 4, previousAttempts: attempts, agentDefaultModel: "worker-cheap" });
		assert.equal(d4.alias, "frontier");
	});

	it("explicit model override wins", () => {
		const router = new Router(reg);
		const d = router.decide({ job: mkJob(), attemptNumber: 2, previousAttempts: [mkAttempt()], explicitModel: "frontier", agentDefaultModel: "worker-cheap" });
		assert.equal(d.alias, "frontier");
	});

	it("rules match on kind/tag/attempt without concrete models (§9)", () => {
		const router = new Router(reg, [
			{ kind: "review", tag: "critical", model: "frontier" },
			{ kind: "debugging", attempt: 3, model: "worker-best" },
		]);
		const d = router.decide({ job: mkJob({ kind: "review", tags: ["critical"] }), attemptNumber: 1, previousAttempts: [], agentDefaultModel: "worker-cheap" });
		assert.equal(d.alias, "frontier");
		const d2 = router.decide({
			job: mkJob({ kind: "debugging" }),
			attemptNumber: 3,
			previousAttempts: [mkAttempt(), mkAttempt({ attemptId: "attempt-002" })],
			agentDefaultModel: "worker-cheap",
		});
		assert.equal(d2.alias, "worker-best");
	});
});

// ── Errors (§29) ────────────────────────────────────────────────────────────

describe("error classification", () => {
	it("separates transport failures from task failures", () => {
		assert.equal(classifyRunFailure(1, "error", "502 Bad Gateway").kind, "provider_unavailable");
		assert.equal(classifyRunFailure(1, undefined, "400 z-ai/glm-5.3-flash is not a valid model ID").kind, "provider_unavailable");
		assert.equal(classifyRunFailure(1, undefined, "rate limit exceeded (429)").kind, "rate_limited");
		assert.equal(classifyRunFailure(1, undefined, "You're out of extra usage").kind, "auth");
		assert.equal(classifyRunFailure(1, "aborted", "Aborted by orchestrator").kind, "aborted");
		const taskErr = classifyRunFailure(1, "end", "worker said no");
		assert.equal(taskErr.isTransport, false);
		assert.ok(classifyRunFailure(1, "error", "429").isTransport);
	});
	it("OrchestratorError exposes isTransport", () => {
		assert.equal(new OrchestratorError("rate_limited", "x").isTransport, true);
		assert.equal(new OrchestratorError("task_failed", "x").isTransport, false);
	});
});

// ── Budgets (§13) ───────────────────────────────────────────────────────────

describe("BudgetManager", () => {
	it("enforces per-job, daily, attempt ceilings and max attempts", () => {
		const root = tmpRoot();
		const bm = new BudgetManager(root);
		const job = mkJob({ budget: { perJobUsd: 0.05 } });
		const attempts = [mkAttempt({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.06, contextTokens: 0, turns: 5 } })];
		const check = bm.check(job, attempts, undefined);
		assert.equal(check.ok, false);
		assert.ok(check.violations.some((v) => v.startsWith("perJobUsd")));

		// daily ledger
		bm.recordSpend(2.5);
		const daily = bm.check(mkJob(), [], { dailyUsd: 1.0 });
		assert.ok(!daily.ok && daily.violations.some((v) => v.startsWith("dailyUsd")));

		// attempt ceilings
		const post = bm.checkAttempt(mkAttempt({ usage: { input: 0, output: 99999, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, turns: 100 }, latencyMs: 5000 }), {
			maxTurns: 10,
			maxOutputTokens: 1000,
			timeoutSeconds: 1,
		});
		assert.deepEqual(post.violations.sort(), ["maxOutputTokens:1000", "maxTurns:10", "timeoutSeconds:1"].sort());

		// max attempts
		const bm2 = new BudgetManager(tmpRoot());
		const maxA = bm2.check(mkJob(), [mkAttempt()], { maxAttempts: 1 });
		assert.ok(maxA.violations.some((v) => v.startsWith("maxAttempts")));
	});
});

// ── Concurrency (§12) ───────────────────────────────────────────────────────

describe("ConcurrencyManager", () => {
	it("gates global and per-model slots", async () => {
		const cm = new ConcurrencyManager({ global: 2, byModel: { "worker-cheap": 1 } });
		const order: string[] = [];
		const r1 = await cm.acquire("worker-cheap");
		order.push("a");
		const p2 = cm.acquire("worker-cheap").then((rel) => {
			order.push("b");
			rel();
		});
		await new Promise((r) => setTimeout(r, 30));
		assert.deepEqual(order, ["a"]); // b blocked by per-model gate
		r1();
		await p2;
		assert.deepEqual(order, ["a", "b"]);
	});

	it("Gate honors aborts while queued", async () => {
		const gate = new Gate(1);
		const rel = await gate.acquire();
		const ac = new AbortController();
		const pending = gate.acquire(ac.signal);
		ac.abort();
		await assert.rejects(pending, /aborted/);
		rel();
	});
});

// ── Storage (§28) ───────────────────────────────────────────────────────────

describe("JobStore", () => {
	it("writes atomically and allocates attempts without collision", () => {
		const root = tmpRoot();
		const store = new JobStore(root);
		store.createJobDir("j1");
		atomicWriteJson(path.join(store.jobDir("j1"), "job.json"), { a: 1 });
		assert.deepEqual(readJson(path.join(store.jobDir("j1"), "job.json")), { a: 1 });
		assert.equal(store.allocateAttempt("j1"), "attempt-001");
		assert.equal(store.allocateAttempt("j1"), "attempt-002");
		// no temp files left behind
		assert.equal(fs.readdirSync(store.jobDir("j1")).filter((f) => f.endsWith(".tmp")).length, 0);
	});

	it("recovers interrupted jobs/attempts after a crash (§29)", () => {
		const root = tmpRoot();
		const store = new JobStore(root);
		store.createJobDir("j2");
		const attemptId = store.allocateAttempt("j2");
		store.writeAttempt(mkAttempt({ jobId: "j2", attemptId, status: "running" }));
		store.writeJob(mkJob({ jobId: "j2", status: "running", latestAttemptId: attemptId }));
		const recovered = store.recoverInterrupted(store.readJob("j2")!);
		assert.equal(recovered.status, "interrupted");
		assert.equal(store.readAttempt("j2", attemptId)!.status, "interrupted");
	});

	it("protects against artifact path traversal (§30)", () => {
		const root = tmpRoot();
		const store = new JobStore(root);
		store.createJobDir("j3");
		fs.writeFileSync(path.join(store.jobArtifactsDir("j3"), "ok.txt"), "x");
		assert.ok(store.resolveArtifact(store.jobArtifactsDir("j3"), "ok.txt"));
		assert.equal(store.resolveArtifact(store.jobArtifactsDir("j3"), "../../models.yaml"), null);
		assert.equal(store.resolveArtifact(store.jobArtifactsDir("j3"), "/etc/passwd"), null);
	});

	it("builds an artifact manifest with sizes and hashes (§17)", () => {
		const root = tmpRoot();
		const store = new JobStore(root);
		store.createJobDir("j4");
		const dir = store.jobArtifactsDir("j4");
		fs.writeFileSync(path.join(dir, "notes.log"), "hello");
		const manifest = store.buildManifest(dir);
		assert.equal(manifest.length, 1);
		assert.equal(manifest[0].id, "notes.log");
		assert.equal(manifest[0].type, "log");
		assert.equal(manifest[0].size, 5);
		assert.equal(manifest[0].sha256!.length, 64);
	});
});

// ── Result extraction (§4) ──────────────────────────────────────────────────

describe("extractResult", () => {
	const base = { jobId: "j", attemptId: "attempt-001" };

	it("prefers worker-written result.json", () => {
		const dir = tmpRoot();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({ schemaVersion: 1, ...base, status: "success", summary: "from file", findings: [], changes: [], validation: { status: "skipped", checks: [] }, artifacts: [], blockers: [], followUps: [], metrics: {} }),
		);
		const ex = extractResult({ attemptDir: dir, finalText: "done", ...base });
		assert.equal(ex.source, "file");
		assert.equal(ex.result.summary, "from file");
	});

	it("falls back to fenced json blocks", () => {
		const dir = tmpRoot();
		const ex = extractResult({
			attemptDir: dir,
			finalText: 'work done\n```json\n{"schemaVersion":1,"status":"partial","summary":"halfway","blockers":["need X"]}\n```',
			...base,
		});
		assert.equal(ex.source, "json-block");
		assert.equal(ex.result.status, "partial");
		assert.deepEqual(ex.result.blockers, ["need X"]);
	});

	it("maps legacy markdown reports (backward compat)", () => {
		const dir = tmpRoot();
		const ex = extractResult({
			attemptDir: dir,
			finalText: "```report\nstatus: success\nsummary: legacy path\nfindings:\n- found a thing\n```",
			...base,
		});
		assert.equal(ex.source, "legacy-report");
		assert.equal(ex.result.status, "success");
		assert.equal(ex.result.findings[0].message, "found a thing");
	});

	it("degrades to synthetic failure on garbage output, never throws", () => {
		const dir = tmpRoot();
		const ex = extractResult({ attemptDir: dir, finalText: "sorry I could not", ...base });
		assert.equal(ex.source, "synthetic");
		assert.equal(ex.result.status, "failure");
		assert.ok(ex.result.blockers.length > 0);
	});

	it("normalizeJobResult repairs malformed fields", () => {
		const { result, repairs } = normalizeJobResult({ status: "weird", findings: "nope", artifacts: [{ path: "" }, { id: "a", type: "log", path: "a.log", size: 3 }] }, "j", "a1");
		assert.equal(result.status, "failure");
		assert.deepEqual(result.findings, []);
		assert.equal(result.artifacts.length, 1); // empty-path entry dropped
		assert.ok(repairs.length >= 2);
	});

	it("renders report.md from result.json", () => {
		const { result } = normalizeJobResult({ status: "success", summary: "s", changes: ["a.ts"], validation: { status: "passed", checks: [{ name: "tests", status: "passed", command: "pnpm test" }] } }, "j", "a1");
		const md = renderReportMd(result);
		assert.ok(md.includes("**status:** success"));
		assert.ok(md.includes("pnpm test"));
		assert.ok(md.includes("a.ts"));
	});
});

// ── Context packs (§19) ─────────────────────────────────────────────────────

describe("planner telemetry", () => {
	it("persists deterministic lifecycle usage including cache and cost", () => {
		const root = tmpRoot();
		const times = [1000, 1450];
		const store = new PlannerTelemetryStore(root);
		const collector = new PlannerTelemetryCollector(store, () => times.shift() ?? 1450);
		collector.start("openai-codex", "gpt-5.6-sol");
		collector.addAssistant({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 5, totalTokens: 235, cost: { total: 0.42 } },
		});
		const record = collector.finish({ id: "session-1", path: "/tmp/session.jsonl" });
		assert.equal(record?.durationMs, 450);
		assert.deepEqual(store.metrics(), {
			runs: 1,
			promptTokens: 120,
			completionTokens: 30,
			cacheReadTokens: 80,
			cacheWriteTokens: 5,
			costUsd: 0.42,
			wallTimeMs: 450,
			byModel: [{ provider: "openai-codex", model: "gpt-5.6-sol", runs: 1, promptTokens: 120, completionTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 5, costUsd: 0.42, wallTimeMs: 450 }],
		});
	});
});

describe("interrupted-attempt recovery", () => {
	it("recovery of an interrupted attempt appends a job.interrupted event", async () => {
		const h = makeHarness();
		const job = h.orch.createJob({ agent: "worker", task: "will crash" }, h.agents);
		const attemptId = h.orch.store.allocateAttempt(job.jobId);
		h.orch.store.writeAttempt({
			schemaVersion: 1,
			attemptId,
			jobId: job.jobId,
			agent: "worker",
			retryMode: "initial",
			status: "running",
			startedAt: Date.now(),
		});
		job.status = "running";
		job.latestAttemptId = attemptId;
		h.orch.store.writeJob(job);

		const reloaded = h.orch.readJob(job.jobId);
		assert.equal(reloaded?.status, "interrupted");
		const events = h.orch.events.read(job.jobId, 100);
		assert.ok(events.some((e) => e.type === "job.interrupted"));
		h.cleanup();
	});
});

// ── Context packs (§19) ─────────────────────────────────────────────────────

describe("buildContextPack", () => {
	it("inlines small agent-declared files and guards traversal", () => {
		const ws = tmpRoot();
		fs.mkdirSync(path.join(ws, "docs"));
		fs.writeFileSync(path.join(ws, "docs/frontend.md"), "# FE guide");
		fs.writeFileSync(path.join(ws, "big.md"), "x".repeat(200_000));
		const built = buildContextPack({
			objective: "fix x",
			agentContext: { mode: "selective", files: ["docs/frontend.md", "big.md", "../../etc/passwd"] },
			workspaceDir: ws,
		});
		assert.equal(built.inlinedFiles.length, 1); // big.md too large, traversal skipped
		assert.equal(built.inlinedFiles[0].path, "docs/frontend.md");
		assert.equal(built.pack.objective, "fix x");
	});
});

// ── Test-harness temp-root hygiene ──────────────────────────────────────────

describe("test harness temp-root hygiene", () => {
	it("removes harness temp roots at process exit even when tests skip cleanup()", async () => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", path.join(process.cwd(), "tests", "fixtures", "tmp-root-exit-child.ts")],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		const [code] = await once(child, "exit");
		assert.equal(code, 0);
		const created = stdout.trim().split("\n").filter(Boolean);
		assert.ok(created.length > 0, "child reported the temp root it created");
		for (const dir of created) {
			assert.match(path.basename(dir), /^orch-test-/);
			assert.equal(fs.existsSync(dir), false, "exit-time cleanup registry removed the leaked root");
		}
	});
});
