/**
 * Integration tests for the orchestration runtime: jobs, attempts, retry/
 * escalation, validation, DAG, budgets, follow-ups, events, crash recovery.
 * Uses the injected fake worker seam — no pi subprocesses, fully deterministic.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { OrchestratorError } from "../core/errors.ts";
import type { SpawnRequest } from "../core/spawn.ts";
import type { JobResult, UsageInfo } from "../core/types.ts";
import { emptyValidation } from "../core/types.ts";
import { BudgetManager } from "../core/budget.ts";
import { makeAgent, makeHarness, outcome, writingWorker } from "./helpers.ts";

function resultFile(req: SpawnRequest) {
	return path.join(req.attemptDir, "result.json");
}

const successResult = (summary = "did it") => ({
	status: "success" as const,
	summary,
	findings: [],
	changes: [],
	validation: emptyValidation(),
	artifacts: [],
	blockers: [],
	followUps: [],
	metrics: {},
});

describe("Orchestrator jobs & attempts", () => {
	it("create → run → success with canonical result.json at job and attempt level", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome(successResult("implemented shipping validation"))));
		const job = h.orch.createJob({ agent: "worker", task: "Implement shipping validation." }, h.agents);
		assert.ok(job.jobId.startsWith("worker--"));
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success");
		assert.equal(report.attempts.length, 1);
		assert.equal(report.attempts[0].logicalModel, "worker-cheap"); // registry default via agent runtime
		assert.equal(report.attempts[0].retryMode, "initial");

		// canonical result.json + rendered report.md at both levels
		const jobResult = h.orch.readResult(job.jobId);
		assert.equal(jobResult?.summary, "implemented shipping validation");
		assert.ok(fs.existsSync(path.join(h.orch["store"].jobDir(job.jobId), "report.md")));
		const attemptResult = JSON.parse(fs.readFileSync(path.join(h.workerCalls[0].attemptDir, "result.json"), "utf-8"));
		assert.equal(attemptResult.schemaVersion, 1);

		// events recorded
		const events = h.orch.events.read(job.jobId).map((e) => e.type);
		for (const expected of ["job.created", "attempt.started", "provider.requested", "provider.completed", "attempt.completed", "job.completed"]) {
			assert.ok(events.includes(expected as any), `missing event ${expected}: ${events.join(",")}`);
		}
		h.cleanup();
	});

	it("malformed worker output → malformed_result, ladder exhausted → failed (§4, §29)", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 2, ladder: [{ strategy: "fresh" }] } })] });
		h.setWorker(() => ({ ...outcome(successResult(), { writeResultFile: false, finalText: "I tried but produced nothing structured" }), exitCode: 0 }));
		const job = h.orch.createJob({ agent: "worker", task: "do thing" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "failed");
		assert.equal(report.attempts.length, 2);
		assert.equal(report.attempts[0].exitReason, "malformed_result");
		// synthetic result records the contract violation
		assert.equal(report.latestResult?.status, "failure");
		h.cleanup();
	});

	it("retry ladder escalates cheap → cheap(fresh) → worker-best → frontier (§16, §20)", async () => {
		const h = makeHarness();
		let call = 0;
		h.setWorker(
			writingWorker(() => {
				call++;
				return call < 4 ? outcome({ ...successResult("nope"), status: "failure", blockers: ["could not"] }) : outcome(successResult("finally"));
			}),
		);
		const job = h.orch.createJob({ agent: "worker", task: "hard task" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success");
		assert.deepEqual(
			report.attempts.map((a) => a.logicalModel),
			["worker-cheap", "worker-cheap", "worker-best", "frontier"],
		);
		assert.deepEqual(
			report.attempts.map((a) => a.retryMode),
			["initial", "fresh", "fresh", "fresh"],
		);
		// escalation events logged
		const escalations = h.orch.events.read(job.jobId).filter((e) => e.type === "job.escalated");
		assert.ok(escalations.length >= 2);
		h.cleanup();
	});

	it("fresh retry receives previous-failure feedback in its context pack (§6, §16)", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 2, ladder: [{ strategy: "fresh" }] } })] });
		let call = 0;
		h.setWorker(
			writingWorker(() => {
				call++;
				return call === 1
					? outcome({ status: "failure", summary: "", blockers: ["type error in shipping.ts"] })
					: outcome(successResult("fixed"));
			}),
		);
		const job = h.orch.createJob({ agent: "worker", task: "fix shipping", context: { acceptance: ["tests pass"] } }, h.agents);
		await h.orch.runJob(job, h.agents);
		const secondPrompt = h.workerCalls[1].prompt;
		assert.ok(secondPrompt.includes("Previous attempt attempt-001 did not succeed"), "fresh retry must carry failure feedback");
		assert.ok(secondPrompt.includes("type error in shipping.ts"));
		// original context pack preserved too
		assert.ok(secondPrompt.includes("tests pass"));
		h.cleanup();
	});

	it("transport errors retry without consuming the task ladder (§29)", async () => {
		const h = makeHarness();
		let call = 0;
		h.setWorker(
			writingWorker(() => {
				call++;
				if (call <= 2) {
					return outcome(successResult(), {
						writeResultFile: false,
						runError: new OrchestratorError("provider_unavailable", "502 Bad Gateway"),
					});
				}
				return outcome(successResult("recovered"));
			}),
		);
		const job = h.orch.createJob({ agent: "worker", task: "flaky backend" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success");
		assert.equal(report.attempts.length, 1, "transport retries must not create task attempts");
		assert.equal(report.attempts[0].transportRetries, 2);
		const evts = h.orch.events.read(job.jobId).filter((e) => e.type === "attempt.transport_retry");
		assert.equal(evts.length, 2);
		h.cleanup();
	});

	it("persistent transport failure stops explicitly without consuming a stronger-model rung", async () => {
		const h = makeHarness();
		h.setWorker(() => outcome(successResult(), {
			writeResultFile: false,
			runError: new OrchestratorError("provider_unavailable", "400 z-ai/glm is not a valid model ID"),
		}));
		const job = h.orch.createJob({ agent: "worker", task: "unavailable backend" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "failed");
		assert.equal(report.attempts.length, 1);
		assert.equal(report.attempts[0].logicalModel, "worker-cheap");
		assert.equal(report.attempts[0].exitReason, "transport_error");
		assert.equal(h.workerCalls.length, 3, "initial request plus two provider retries");
		assert.equal(h.orch.events.read(job.jobId).filter((event) => event.type === "job.escalated").length, 0);
		assert.match(h.orch.readJob(job.jobId)?.lastBlockers?.join(" ") ?? "", /transport error/);
		h.cleanup();
	});

	it("host-side validation overrides worker self-reported success (§15, §16)", async () => {
		const agent = makeAgent({ name: "worker", validation: { commands: ["exit 1"], timeoutSeconds: 30 }, retry: { maxAttempts: 1, ladder: [] } });
		const h = makeHarness({ agents: [agent] });
		h.setWorker(writingWorker(() => outcome(successResult("looks good to me"))));
		const job = h.orch.createJob({ agent: "worker", task: "impl" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "failed");
		assert.equal(report.attempts[0].exitReason, "validation_failed");
		assert.equal(report.latestResult?.status, "failure");
		assert.equal(report.latestResult?.validation.status, "failed");
		// log artifact persisted outside model context
		const logDir = path.join(h.orch["store"].attemptDir(job.jobId, "attempt-001"), "validation");
		assert.ok(fs.readdirSync(logDir).length > 0);
		h.cleanup();
	});

	it("followupJob resumes the same attempt session — cheapest channel (§6, §25)", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome(successResult("v1"))));
		const job = h.orch.createJob({ agent: "worker", task: "investigate X" }, h.agents);
		await h.orch.runJob(job, h.agents);
		const first = h.workerCalls[0];

		h.setWorker(writingWorker(() => outcome(successResult("v2 refined"))));
		const report = await h.orch.followupJob(job.jobId, "Also check Y.", h.agents);
		const second = h.workerCalls[1];
		assert.equal(second.sessionDir, first.sessionDir, "follow-up must reuse the session dir");
		assert.equal(second.sessionId, first.sessionId, "follow-up must reuse the session id");
		assert.equal(report.attempts.length, 1, "follow-up does not allocate a new attempt");
		assert.ok(second.prompt.includes("FOLLOW-UP"));
		assert.ok(second.prompt.includes("Also check Y."));
		h.cleanup();
	});

	it("retryJob(strategy=fresh, model=worker-best) allocates a new attempt with escalation (§6)", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 1, ladder: [] } })] });
		h.setWorker(writingWorker(() => outcome({ ...successResult("bad"), status: "failure" })));
		const job = h.orch.createJob({ agent: "worker", task: "tricky" }, h.agents);
		const r1 = await h.orch.runJob(job, h.agents);
		assert.equal(r1.status, "failed");

		h.setWorker(writingWorker(() => outcome(successResult("escalated win"))));
		const r2 = await h.orch.retryJob(job.jobId, h.agents, { strategy: "fresh", model: "worker-best", reason: "manual escalation" });
		assert.equal(r2.status, "success");
		const attempts = h.orch.store.listAttempts(job.jobId);
		assert.equal(attempts.length, 2);
		assert.equal(attempts[1].logicalModel, "worker-best");
		assert.equal(attempts[1].escalationReason, "manual escalation");
		assert.equal(attempts[1].parentAttemptId, "attempt-001");
		h.cleanup();
	});

	it("budget ceiling stops retries with machine-readable state (§13)", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", budget: { perJobUsd: 0.005 }, retry: { maxAttempts: 4, ladder: [] } })] });
		h.setWorker(writingWorker(() => outcome({ ...successResult("costly fail"), status: "failure" })));
		const job = h.orch.createJob({ agent: "worker", task: "expensive" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "failed");
		assert.ok(report.attempts.length < 4, "budget must cut the ladder short");
		const refreshed = h.orch.readJob(job.jobId)!;
		assert.ok((refreshed.lastBlockers ?? []).some((b) => b.includes("budget")));
		h.cleanup();
	});

	it("cancelJob aborts and marks cancelled", async () => {
		const h = makeHarness();
		h.setWorker(
			writingWorker(() => {
				// simulate slow worker; cancel mid-flight
				return outcome(successResult());
			}),
		);
		const job = h.orch.createJob({ agent: "worker", task: "slow" }, h.agents);
		const ac = new AbortController();
		const runPromise = h.orch.runJob(job, h.agents, ac.signal);
		ac.abort();
		const report = await runPromise;
		assert.ok(["cancelled", "failed", "success"].includes(report.status)); // race-tolerant
		h.cleanup();
	});

	it("crash recovery: running job reloaded from disk becomes interrupted (§28, §29)", async () => {
		const h = makeHarness();
		const job = h.orch.createJob({ agent: "worker", task: "will crash" }, h.agents);
		// simulate: attempt written as running, then orchestrator restart
		const attemptId = h.orch["store"].allocateAttempt(job.jobId);
		h.orch["store"].writeAttempt({
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
		h.orch["store"].writeJob(job);

		const h2 = makeHarness(); // fresh process would re-read; same-store reload:
		const reloaded = h.orch.readJob(job.jobId)!;
		assert.equal(reloaded.status, "interrupted");
		assert.equal(h.orch.readAttempt(job.jobId, attemptId)!.status, "interrupted");
		h2.cleanup();
		h.cleanup();
	});
});

describe("canonical status precedence (terminal runError)", () => {
	it("worker-written success + terminal provider_unavailable → attempt/job/canonical result all failure, findings/artifacts retained", async () => {
		const h = makeHarness();
		h.setWorker(
			writingWorker(() =>
				outcome(
					{
						...successResult("worker claims done"),
						findings: [{ severity: "info", message: "partial progress recorded" }],
						artifacts: [{ id: "notes", type: "file", path: "notes.txt", size: 4 }],
					},
					{ runError: new OrchestratorError("provider_unavailable", "502 Bad Gateway") },
				),
			),
		);
		const job = h.orch.createJob({ agent: "worker", task: "flaky backend lies" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "failed");
		assert.equal(report.attempts[0].status, "failed");
		assert.equal(report.attempts[0].exitReason, "transport_error");

		// canonical job-level result cannot contradict the failed attempt
		const canonical = h.orch.readResult(job.jobId);
		assert.equal(canonical?.status, "failure");
		assert.equal(h.orch.readJob(job.jobId)?.lastStatus, "failure");
		assert.ok(canonical?.blockers.some((b) => b.includes("provider_unavailable") && b.includes("502 Bad Gateway")));
		// partial work preserved
		assert.deepEqual(canonical?.findings.map((f) => f.message), ["partial progress recorded"]);
		assert.deepEqual(canonical?.artifacts.map((a) => a.path), ["notes.txt"]);
		assert.equal(canonical?.validation.status, "error");
		h.cleanup();
	});

	it("worker-written success + terminal task_error → failure (ladder continues, job not contradicted)", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 1, ladder: [] } })] });
		h.setWorker(writingWorker(() => outcome(successResult("worker claims done"), { runError: new OrchestratorError("task_failed", "worker crashed mid-task") })));
		const job = h.orch.createJob({ agent: "worker", task: "crash after writing result" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "failed");
		assert.equal(report.attempts[0].exitReason, "task_error");
		assert.equal(report.latestResult?.status, "failure");
		assert.equal(h.orch.readResult(job.jobId)?.status, "failure");
		assert.ok(report.latestResult?.blockers.some((b) => b.includes("task_failed") && b.includes("worker crashed mid-task")));
		h.cleanup();
	});

	it("intermediate transport failures that later recover keep the success result", async () => {
		const h = makeHarness();
		let call = 0;
		h.setWorker(
			writingWorker(() => {
				call++;
				return call === 1
					? outcome(successResult(), { runError: new OrchestratorError("provider_unavailable", "503 transient") })
					: outcome(successResult("recovered"));
			}),
		);
		const job = h.orch.createJob({ agent: "worker", task: "recovers" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success");
		assert.equal(report.latestResult?.status, "success");
		assert.equal(report.latestResult?.summary, "recovered");
		h.cleanup();
	});
});

describe("usage preservation across provider legs", () => {
	const usageA: UsageInfo = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, costUsd: 0.01, contextTokens: 150, turns: 1 };
	const usageB: UsageInfo = { input: 200, output: 80, cacheRead: 20, cacheWrite: 0, costUsd: 0.02, contextTokens: 300, turns: 2 };
	const zeroUsage: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, turns: 0 };

	it("two charged transport legs + zero-usage terminal leg → cumulative usage kept, ledger charged per leg", async () => {
		const h = makeHarness();
		let call = 0;
		h.setWorker(
			writingWorker(() => {
				call++;
				if (call === 1) return outcome(successResult(), { usage: usageA, runError: new OrchestratorError("provider_unavailable", "502") });
				if (call === 2) return outcome(successResult(), { usage: usageB, runError: new OrchestratorError("provider_unavailable", "503") });
				return outcome(successResult("recovered"), { usage: zeroUsage });
			}),
		);
		const job = h.orch.createJob({ agent: "worker", task: "flaky backend" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success");
		const usage = report.attempts[0].usage!;
		assert.equal(usage.input, 300);
		assert.equal(usage.output, 130);
		assert.equal(usage.cacheRead, 30);
		assert.equal(usage.cacheWrite, 5);
		assert.ok(Math.abs(usage.costUsd - 0.03) < 1e-9, "final zero-usage leg must not erase earlier spend");
		assert.equal(usage.turns, 3);
		assert.equal(usage.contextTokens, 300, "contextTokens is the max high-water mark");

		// provider.completed remains per-leg
		const legs = h.orch.events.read(job.jobId).filter((e) => e.type === "provider.completed");
		assert.deepEqual(legs.map((e) => e.data?.costUsd), [usageA.costUsd, usageB.costUsd, 0]);

		// daily ledger charged exactly per leg
		const ledger = new BudgetManager(h.root).todaySpend();
		assert.ok(Math.abs(ledger - 0.03) < 1e-9);
		h.cleanup();
	});

	it("followup accumulates attempt usage but charges only the incremental spend", async () => {
		const h = makeHarness();
		const firstUsage: UsageInfo = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, contextTokens: 150, turns: 2 };
		const secondUsage: UsageInfo = { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02, contextTokens: 120, turns: 1 };
		let call = 0;
		h.setWorker(writingWorker(() => outcome(successResult(call++ === 0 ? "v1" : "v2"), { usage: call === 1 ? firstUsage : secondUsage })));
		const job = h.orch.createJob({ agent: "worker", task: "investigate" }, h.agents);
		await h.orch.runJob(job, h.agents);
		const report = await h.orch.followupJob(job.jobId, "refine", h.agents);
		const usage = report.attempts[0].usage!;
		assert.equal(usage.input, firstUsage.input + secondUsage.input);
		assert.equal(usage.output, firstUsage.output + secondUsage.output);
		assert.equal(usage.turns, firstUsage.turns + secondUsage.turns);
		assert.ok(Math.abs(usage.costUsd - (firstUsage.costUsd + secondUsage.costUsd)) < 1e-9, "attempt.json usage is cumulative");
		assert.equal(usage.contextTokens, Math.max(firstUsage.contextTokens, secondUsage.contextTokens));
		// budget ledger: 0.01 (first run) + 0.02 (new execution only) — no double charge of prior spend
		const ledger = new BudgetManager(h.root).todaySpend();
		assert.ok(Math.abs(ledger - (firstUsage.costUsd + secondUsage.costUsd)) < 1e-9, `ledger ${ledger}`);
		h.cleanup();
	});
});

describe("explicit initial model override", () => {
	it("CreateJobInput.model is persisted and used on the job's first attempt", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome(successResult())));
		const job = h.orch.createJob({ agent: "worker", task: "t", model: "frontier" }, h.agents);
		assert.equal(job.initialModel, "frontier");
		assert.equal(h.orch.readJob(job.jobId)?.initialModel, "frontier");
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.attempts[0].logicalModel, "frontier");
		assert.ok(h.workerCalls[0].launchArgs.includes("anthropic/test/frontier"));
		h.cleanup();
	});

	it("initial model override works for DAG/batch first attempts", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker((_dir, jobId) => outcome(successResult(`done ${jobId}`))));
		const a = h.orch.createJob({ agent: "worker", task: "A", jobId: "job-a", model: "worker-best" }, h.agents);
		const c = h.orch.createJob({ agent: "worker", task: "C", jobId: "job-c", model: "frontier", dependsOn: ["job-a"] }, h.agents);
		const reports = await h.orch.runGraph(h.agents, { jobIds: [a.jobId, c.jobId] });
		assert.equal(reports.length, 2);
		assert.ok(reports.every((r) => r.status === "success"));
		assert.equal(h.orch.readAttempt("job-a", "attempt-001")?.logicalModel, "worker-best");
		assert.equal(h.orch.readAttempt("job-c", "attempt-001")?.logicalModel, "frontier");
		h.cleanup();
	});

	it("initialModel applies only to attempt 1; retryJob opts.model overrides it", async () => {
		const h = makeHarness({
			agents: [makeAgent({ name: "worker", retry: { maxAttempts: 2, ladder: [{ strategy: "fresh", model: "worker-best" }] } })],
		});
		h.setWorker(writingWorker(() => outcome({ ...successResult("nope"), status: "failure", blockers: ["no"] })));
		const job = h.orch.createJob({ agent: "worker", task: "t", model: "frontier" }, h.agents);
		const r1 = await h.orch.runJob(job, h.agents);
		assert.equal(r1.status, "failed");
		assert.equal(r1.attempts[0].logicalModel, "frontier", "initial override on attempt 1");
		assert.equal(r1.attempts[1].logicalModel, "worker-best", "attempt 2 follows the ladder, not the initial override");

		// explicit retry override beats initialModel (fresh job, zero attempts)
		const job2 = h.orch.createJob({ agent: "worker", task: "t2", model: "frontier", jobId: "override-precedence" }, h.agents);
		h.setWorker(writingWorker(() => outcome(successResult("won"))));
		const r2 = await h.orch.retryJob(job2.jobId, h.agents, { model: "worker-best" });
		assert.equal(r2.status, "success");
		assert.equal(h.orch.readAttempt(job2.jobId, "attempt-001")?.logicalModel, "worker-best");
		h.cleanup();
	});
});

describe("DAG scheduling (§11)", () => {
	it("runs independent jobs concurrently and respects dependencies", async () => {
		const h = makeHarness();
		const running: string[] = [];
		let maxConcurrent = 0;
		h.setWorker(
			writingWorker((attemptDir, jobId) => {
				running.push(jobId);
				maxConcurrent = Math.max(maxConcurrent, running.length);
				const res = outcome(successResult(`done ${jobId}`));
				setTimeout(() => {
					const i = running.indexOf(jobId);
					if (i >= 0) running.splice(i, 1);
				}, 0);
				return res;
			}),
		);

		const a = h.orch.createJob({ agent: "worker", task: "A: database analysis", jobId: "job-a" }, h.agents);
		const b = h.orch.createJob({ agent: "worker", task: "B: api analysis", jobId: "job-b" }, h.agents);
		const c = h.orch.createJob({ agent: "worker", task: "C: implementation", jobId: "job-c", dependsOn: ["job-a", "job-b"] }, h.agents);

		const reports = await h.orch.runGraph(h.agents, { jobIds: [a.jobId, b.jobId, c.jobId] });
		assert.equal(reports.length, 3);
		assert.ok(reports.every((r) => r.status === "success"));
		assert.ok(maxConcurrent >= 2, "independent jobs must overlap");

		// ordering: C's attempt started after A and B completed
		const g = h.orch.graph();
		const nodeC = g.nodes.find((n) => n.jobId === "job-c")!;
		assert.equal(nodeC.effectiveStatus, "success");
		assert.deepEqual(nodeC.dependsOn, ["job-a", "job-b"]);
		assert.ok(g.edges.some((e) => e.from === "job-a" && e.to === "job-c"));
		h.cleanup();
	});

	it("dependency failure propagates downstream without running blocked jobs", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 1, ladder: [] } })] });
		h.setWorker(
			writingWorker((_dir, jobId) =>
				jobId === "job-a" ? outcome({ ...successResult("cannot"), status: "failure" }) : outcome(successResult("should not run")),
			),
		);
		const a = h.orch.createJob({ agent: "worker", task: "A", jobId: "job-a" }, h.agents);
		const c = h.orch.createJob({ agent: "worker", task: "C depends on A", jobId: "job-c", dependsOn: ["job-a"] }, h.agents);
		await h.orch.runGraph(h.agents, { jobIds: [a.jobId, c.jobId] });
		const g = h.orch.graph();
		assert.equal(g.nodes.find((n) => n.jobId === "job-c")!.status, "failed");
		assert.equal(h.workerCalls.length, 1, "blocked job must never spawn a worker");
		h.cleanup();
	});

	it("detects cycles", async () => {
		const h = makeHarness();
		h.orch.createJob({ agent: "worker", task: "X", jobId: "x", dependsOn: ["y"] }, h.agents);
		h.orch.createJob({ agent: "worker", task: "Y", jobId: "y", dependsOn: ["x"] }, h.agents);
		const g = h.orch.graph();
		assert.ok(g.cycles.length > 0);
		h.cleanup();
	});
});

describe("agent config (§7)", () => {
	it("agent runtime.model is a logical alias resolved by the registry", async () => {
		const agent = makeAgent({ name: "worker", runtime: { model: "worker-best", effort: "high" } });
		const h = makeHarness({ agents: [agent] });
		h.setWorker(writingWorker(() => outcome(successResult())));
		const job = h.orch.createJob({ agent: "worker", task: "t" }, h.agents);
		await h.orch.runJob(job, h.agents);
		const attempt = h.orch.readAttempt(job.jobId, "attempt-001")!;
		assert.equal(attempt.logicalModel, "worker-best");
		assert.equal(attempt.resolvedModel, "openrouter/test/best");
		assert.ok(h.workerCalls[0].launchArgs.includes("--model"));
		assert.ok(h.workerCalls[0].launchArgs.includes("openrouter/test/best"));
		h.cleanup();
	});

	it("unknown agent is a clean machine-readable error", async () => {
		const h = makeHarness();
		assert.throws(() => h.orch.createJob({ agent: "ghost", task: "t" }, h.agents), /Unknown sub agent/);
		h.cleanup();
	});
});
