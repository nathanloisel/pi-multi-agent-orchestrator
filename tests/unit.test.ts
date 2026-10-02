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
import { fitDependencyHandoffs } from "../core/orchestrator.ts";
import { renderDependencySection } from "../core/prompts.ts";
import { PlannerTelemetryCollector, PlannerTelemetryStore } from "../core/telemetry.ts";
import { DEFAULT_RETRY, normalizeJobResult, type AttemptRecord, type DependencyHandoff, type JobRecord } from "../core/types.ts";
import { makeAgent, makeHarness, outcome, TEST_MODELS_YAML, tmpRoot, writeRegistry } from "./helpers.ts";

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

	it("listJobs preserves running attempts owned by this live process — no interruption, no event", () => {
		const root = tmpRoot();
		const store = new JobStore(root);
		store.createJobDir("j-live");
		const attemptId = store.allocateAttempt("j-live");
		store.writeAttempt(mkAttempt({ jobId: "j-live", attemptId, status: "running", ownerPid: process.pid }));
		store.writeJob(mkJob({ jobId: "j-live", status: "running", latestAttemptId: attemptId }));
		let recoveries = 0;
		store.setRecoveryHandler(() => {
			recoveries++;
		});
		for (let i = 0; i < 2; i++) {
			const listed = store.listJobs().find((j) => j.jobId === "j-live");
			assert.equal(listed?.status, "running");
			assert.equal(store.readAttempt("j-live", attemptId)?.status, "running");
		}
		assert.equal(recoveries, 0);
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

// ── Owner-liveness orphan recovery (§29) ─────────────────────────────────────────

describe("owner-liveness protection in recoverInterrupted", () => {
	/** Temporarily replace process.kill for the duration of fn (tests run sequentially). */
	function withMockedKill<T>(impl: () => boolean, fn: () => T): T {
		const original = process.kill;
		(process as unknown as { kill: () => boolean }).kill = impl;
		try {
			return fn();
		} finally {
			(process as unknown as { kill: typeof original }).kill = original;
		}
	}

	function errno(code: string): NodeJS.ErrnoException {
		const e = new Error(code) as NodeJS.ErrnoException;
		e.code = code;
		return e;
	}

	function makeRunningStore(ownerPid: number | undefined, suffix: string) {
		const root = tmpRoot();
		const store = new JobStore(root);
		const jobId = `j-owner-${suffix}`;
		store.createJobDir(jobId);
		const attemptId = store.allocateAttempt(jobId);
		store.writeAttempt(mkAttempt({ jobId, attemptId, status: "running", ownerPid }));
		store.writeJob(mkJob({ jobId, status: "running", latestAttemptId: attemptId }));
		return { store, jobId, attemptId };
	}

	it("dead owner (ESRCH) is recovered exactly once, idempotently", () => {
		const { store, jobId, attemptId } = makeRunningStore(424242, "dead");
		let recoveries = 0;
		store.setRecoveryHandler(() => {
			recoveries++;
		});
		withMockedKill(
			() => {
				throw errno("ESRCH");
			},
			() => {
				const recovered = store.recoverInterrupted(store.readJob(jobId)!);
				assert.equal(recovered.status, "interrupted");
			},
		);
		assert.equal(store.readAttempt(jobId, attemptId)?.status, "interrupted");
		assert.equal(store.readAttempt(jobId, attemptId)?.exitReason, "crashed");
		assert.equal(recoveries, 1);
		// a later scan (record no longer running) never recovers or re-emits
		withMockedKill(
			() => {
				throw errno("ESRCH");
			},
			() => {
				store.recoverInterrupted(store.readJob(jobId)!);
				store.listJobs();
			},
		);
		assert.equal(recoveries, 1);
	});

	it("EPERM (owner exists but is not signalable by us) is protected", () => {
		const { store, jobId, attemptId } = makeRunningStore(424242, "eperm");
		withMockedKill(
			() => {
				throw errno("EPERM");
			},
			() => {
				assert.equal(store.recoverInterrupted(store.readJob(jobId)!).status, "running");
				assert.equal(store.listJobs().find((j) => j.jobId === jobId)?.status, "running");
			},
		);
		assert.equal(store.readAttempt(jobId, attemptId)?.status, "running");
	});

	it("uncertain probe errors are protected (conservative)", () => {
		const { store, jobId, attemptId } = makeRunningStore(424242, "uncertain");
		withMockedKill(
			() => {
				throw errno("EINVAL");
			},
			() => {
				assert.equal(store.recoverInterrupted(store.readJob(jobId)!).status, "running");
			},
		);
		withMockedKill(
			() => {
				throw new Error("probe exploded without an errno");
			},
			() => {
				assert.equal(store.recoverInterrupted(store.readJob(jobId)!).status, "running");
			},
		);
		assert.equal(store.readAttempt(jobId, attemptId)?.status, "running");
	});

	it("invalid ownerPid values are rejected WITHOUT probing (no group/self signals)", () => {
		for (const [i, pid] of [0, -1, 1.5, Number.NaN].entries()) {
			const { store, jobId, attemptId } = makeRunningStore(pid, `invalid-${i}`);
			// the mock throws if ANY probe happens; recovery must proceed anyway
			withMockedKill(
				() => {
					throw new Error("probe must not run for invalid pids");
				},
				() => {
					assert.equal(store.recoverInterrupted(store.readJob(jobId)!).status, "interrupted", `pid ${pid} should recover unprobed`);
				},
			);
			assert.equal(store.readAttempt(jobId, attemptId)?.status, "interrupted");
		}
	});

	it("legacy records without ownerPid keep owner-agnostic recovery, exactly once", () => {
		const { store, jobId, attemptId } = makeRunningStore(undefined, "legacy");
		let recoveries = 0;
		store.setRecoveryHandler(() => {
			recoveries++;
		});
		assert.equal(store.recoverInterrupted(store.readJob(jobId)!).status, "interrupted");
		assert.equal(recoveries, 1);
		store.recoverInterrupted(store.readJob(jobId)!);
		store.listJobs();
		assert.equal(recoveries, 1);
		assert.equal(store.readAttempt(jobId, attemptId)?.status, "interrupted");
	});

	it("orchestrator-level: listJobs on a live owner emits no job.interrupted event", () => {
		const h = makeHarness();
		const job = h.orch.createJob({ agent: "worker", task: "live owner" }, h.agents);
		const attemptId = h.orch.store.allocateAttempt(job.jobId);
		h.orch.store.writeAttempt({
			schemaVersion: 1,
			attemptId,
			jobId: job.jobId,
			agent: "worker",
			retryMode: "initial",
			status: "running",
			startedAt: Date.now(),
			ownerPid: process.pid,
		});
		job.status = "running";
		job.latestAttemptId = attemptId;
		h.orch.store.writeJob(job);
		assert.equal(
			h.orch.listJobs().find((j) => j.jobId === job.jobId)?.status,
			"running",
		);
		assert.equal(h.orch.readAttempt(job.jobId, attemptId)?.status, "running");
		assert.equal(h.orch.events.read(job.jobId).filter((e) => e.type === "job.interrupted").length, 0);
		h.cleanup();
	});
});

// ── Read-only follow-up delivery end-to-end (FENCED_FOLLOWUP_STALE_RESULT) ──

describe("read-only follow-up extracts fresh fenced results (stale canonical guard)", () => {
	const fenced = (jobId: string, attemptId: string, summary: string, metrics: Record<string, unknown> = {}) =>
		`Refined result.\n\`\`\`json\n${JSON.stringify({
			schemaVersion: 1,
			jobId,
			attemptId,
			status: "success",
			summary,
			findings: [],
			changes: [],
			validation: { status: "skipped", checks: [] },
			artifacts: [],
			blockers: [],
			followUps: [],
			metrics,
		}, null, 2)}\n\`\`\``;

	it("follow-up summary B replaces stale A persisted in the reused attempt dir; malformed follow-up fails instead of reusing A", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "ro-worker", capabilities: ["read", "bash"] })] });
		try {
			const job = h.orch.createJob({ agent: "ro-worker", task: "investigate" }, h.agents);
			const attemptId = "attempt-001"; // follow-up resumes the SAME attempt dir

			// 1) first run: fenced summary A (no file written by the worker; the
			//    orchestrator persists the canonical result.json from the fenced block)
			h.setWorker(() => outcome({ status: "success", summary: "first summary A" }, { writeResultFile: false, finalText: fenced(job.jobId, attemptId, "first summary A") }));
			const run1 = await h.orch.runJob(job, h.agents);
			assert.equal(run1.status, "success");
			const attemptDir = h.orch.store.attemptDir(job.jobId, attemptId);
			assert.ok(fs.existsSync(path.join(attemptDir, "result.json")), "stale canonical A must be present for the follow-up");
			assert.equal(h.orch.readResult(job.jobId)?.summary, "first summary A");

			// 2) follow-up: fresh fenced B must win over stale persisted A
			h.setWorker(() => outcome({ status: "success", summary: "second summary B" }, { writeResultFile: false, finalText: fenced(job.jobId, attemptId, "second summary B", { run: 2 }) }));
			const run2 = await h.orch.followupJob(job.jobId, "refine the answer", h.agents);
			assert.equal(run2.status, "success");
			assert.equal(h.orch.readResult(job.jobId)?.summary, "second summary B");
			assert.equal(h.orch.readAttempt(job.jobId, attemptId)?.status, "success");

			// 3) malformed follow-up: must FAIL (malformed_result), never reuse A or B
			h.setWorker(() => outcome({ status: "success", summary: "prose" }, { writeResultFile: false, finalText: "Sorry, no structured output this time." }));
			const run3 = await h.orch.followupJob(job.jobId, "again, structured please", h.agents);
			assert.equal(run3.status, "waiting"); // failed follow-up → job waiting (retry pending), never stale success
			const final = h.orch.readResult(job.jobId);
			assert.equal(final?.status, "failure");
			assert.notEqual(final?.summary, "first summary A");
			assert.notEqual(final?.summary, "second summary B");
			const attempt = h.orch.readAttempt(job.jobId, attemptId);
			assert.equal(attempt?.status, "failed");
			assert.equal(attempt?.exitReason, "malformed_result");
		} finally {
			h.cleanup();
		}
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

	it("accepts a complete schema-valid fenced result when result.json is absent (read-only delivery)", () => {
		const dir = tmpRoot(); // no result.json — the worker could not write files
		const full = {
			schemaVersion: 1,
			jobId: "j",
			attemptId: "attempt-001",
			status: "success",
			summary: "read-only research complete",
			findings: [{ severity: "info", code: "FOUND", message: "decisive fact", evidence: "core/x.ts:12" }],
			changes: [],
			validation: { status: "skipped", checks: [] },
			artifacts: [],
			blockers: [],
			followUps: [],
			metrics: { sources: 3 },
		};
		const ex = extractResult({ attemptDir: dir, finalText: `Research done.\n\`\`\`json\n${JSON.stringify(full, null, 2)}\n\`\`\`\n`, ...base });
		assert.equal(ex.source, "json-block");
		assert.deepEqual(ex.repairs, []); // schema-valid: no repairs needed
		assert.equal(ex.result.status, "success");
		assert.equal(ex.result.jobId, "j");
		assert.equal(ex.result.attemptId, "attempt-001");
		assert.equal(ex.result.summary, "read-only research complete");
		assert.deepEqual(ex.result.findings[0], full.findings[0]);
		assert.deepEqual(ex.result.metrics, { sources: 3 });
		assert.equal(ex.result.validation.status, "skipped");
	});

	it("rejects a fenced json block that does not parse (synthetic failure, not silent acceptance)", () => {
		const dir = tmpRoot();
		const ex = extractResult({ attemptDir: dir, finalText: "done\n```json\n{ this is not json }\n```", ...base });
		assert.equal(ex.source, "synthetic");
		assert.equal(ex.result.status, "failure");
		assert.ok(ex.repairs.some((r) => r.includes("not parseable")));
		assert.ok(ex.result.blockers.some((b) => b.includes("did not follow the output contract")));
	});

	it("rejects prose-only output with no fenced block (malformed_result)", () => {
		const dir = tmpRoot();
		const ex = extractResult({ attemptDir: dir, finalText: "I looked around and things seem fine. No structured output here.", ...base });
		assert.equal(ex.source, "synthetic");
		assert.equal(ex.result.status, "failure");
		assert.ok(ex.repairs.some((r) => r.includes("no machine-readable result")));
	});

	it("fenced-message delivery: fresh fenced B wins over a stale persisted A (follow-up reuse)", () => {
		const dir = tmpRoot();
		// canonical result.json persisted by a PREVIOUS run of this attempt
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({ schemaVersion: 1, ...base, status: "success", summary: "first summary A", findings: [], changes: [], validation: { status: "skipped", checks: [] }, artifacts: [], blockers: [], followUps: [], metrics: {} }),
		);
		const freshB = { schemaVersion: 1, ...base, status: "success", summary: "second summary B", findings: [], changes: [], validation: { status: "skipped", checks: [] }, artifacts: [], blockers: [], followUps: [], metrics: { run: 2 } };
		const ex = extractResult({
			attemptDir: dir,
			finalText: `Refined.\n\`\`\`json\n${JSON.stringify(freshB)}\n\`\`\``,
			...base,
			delivery: "fenced-message",
		});
		assert.equal(ex.source, "json-block");
		assert.equal(ex.result.summary, "second summary B");
		assert.deepEqual(ex.result.metrics, { run: 2 });
		assert.ok(ex.repairs.some((r) => r.includes("persisted result.json ignored")));
	});

	it("fenced-message delivery: malformed fresh output FAILS instead of reusing stale A", () => {
		const dir = tmpRoot();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({ schemaVersion: 1, ...base, status: "success", summary: "first summary A", findings: [], changes: [], validation: { status: "skipped", checks: [] }, artifacts: [], blockers: [], followUps: [], metrics: {} }),
		);
		const ex = extractResult({ attemptDir: dir, finalText: "Sorry, no structured output this time.", ...base, delivery: "fenced-message" });
		assert.equal(ex.source, "synthetic");
		assert.equal(ex.result.status, "failure");
		assert.notEqual(ex.result.summary, "first summary A");
		assert.ok(ex.repairs.some((r) => r.includes("persisted result.json ignored")));
		// the stale file itself is never deleted before a successful extraction
		assert.ok(fs.existsSync(path.join(dir, "result.json")));
	});

	it("file delivery (default and explicit) keeps file-first behavior unchanged", () => {
		const dir = tmpRoot();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({ schemaVersion: 1, ...base, status: "success", summary: "from file", findings: [], changes: [], validation: { status: "skipped", checks: [] }, artifacts: [], blockers: [], followUps: [], metrics: {} }),
		);
		for (const delivery of [undefined, "file" as const]) {
			const ex = extractResult({ attemptDir: dir, finalText: "```json\n{\"status\":\"failure\",\"summary\":\"message\"}\n```", ...base, delivery });
			assert.equal(ex.source, "file");
			assert.equal(ex.result.summary, "from file");
		}
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

	it("passes optional dependency handoffs through unchanged", () => {
		const dependencies: DependencyHandoff[] = [
			{
				jobId: "pred",
				agent: "coder",
				status: "success",
				summary: "did a thing",
				findings: [{ message: "f", evidence: "a.ts:1" }],
				changedPaths: ["a.ts"],
				validation: "passed",
				artifacts: ["/root/jobs/pred/artifacts/diff.patch"],
				resultPath: "/root/jobs/pred/result.json",
			},
		];
		const built = buildContextPack({
			objective: "dependent",
			context: { dependencies, dependenciesOmitted: 2 },
			agentContext: { mode: "none" },
			workspaceDir: tmpRoot(),
		});
		assert.deepEqual(built.pack.dependencies, dependencies);
		assert.equal(built.pack.dependenciesOmitted, 2);
	});

	it("leaves dependency fields undefined for legacy context without them", () => {
		const built = buildContextPack({ objective: "legacy", context: { background: "old" }, agentContext: { mode: "none" }, workspaceDir: tmpRoot() });
		assert.equal(built.pack.dependencies, undefined);
		assert.equal(built.pack.dependenciesOmitted, undefined);
		assert.equal(built.pack.background, "old");
	});
});

describe("bounded dependency handoff budget", () => {
	it("omits one oversized record and still counts it when no detail record fits", () => {
		const oversized: DependencyHandoff = {
			jobId: "pred",
			agent: "worker",
			status: "success",
			summary: "s",
			findings: [],
			changedPaths: [],
			validation: "passed",
			artifacts: [`/${"a".repeat(20_000)}`],
			resultPath: `/root/${"r".repeat(20_000)}/result.json`,
		};
		const fit = fitDependencyHandoffs([oversized], 1);
		assert.equal(fit.dependencies.length, 0);
		assert.equal(fit.omitted, 1);
		const section = renderDependencySection(fit.dependencies, fit.omitted);
		assert.ok(Buffer.byteLength(section, "utf8") <= 24 * 1024, "omitted-only section must still fit");
		assert.match(section, /1 prerequisite record\(s\) omitted/);
	});

	it("keeps whole records with whole references when they fit", () => {
		const record: DependencyHandoff = {
			jobId: "pred",
			agent: "worker",
			status: "success",
			summary: "ok",
			findings: [{ message: "f", evidence: "a.ts:1" }],
			changedPaths: ["a.ts"],
			validation: "passed",
			artifacts: ["/root/jobs/pred/artifacts/diff.patch"],
			resultPath: "/root/jobs/pred/result.json",
		};
		const fit = fitDependencyHandoffs([record], 2);
		assert.equal(fit.dependencies.length, 1);
		assert.equal(fit.omitted, 1);
		assert.match(renderDependencySection(fit.dependencies, fit.omitted), /\/root\/jobs\/pred\/result\.json/);
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
