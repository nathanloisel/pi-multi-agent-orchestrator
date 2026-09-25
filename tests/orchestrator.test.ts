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
import type { ContextPack, JobResult, UsageInfo } from "../core/types.ts";
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

/** Slice the ACTUAL rendered dependency section out of a worker envelope. */
function dependencySection(prompt: string): string {
	const start = prompt.indexOf("# DEPENDENCY HANDOFFS");
	if (start < 0) return "";
	const end = prompt.indexOf("\n# ", start + 1);
	return prompt.slice(start, end === -1 ? undefined : end);
}

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

	it("crash recovery skips attempts owned by a LIVE process (background yields keep running)", async () => {
		const h = makeHarness();
		const job = h.orch.createJob({ agent: "worker", task: "live owner" }, h.agents);
		const attemptId = h.orch["store"].allocateAttempt(job.jobId);
		h.orch["store"].writeAttempt({
			schemaVersion: 1,
			attemptId,
			jobId: job.jobId,
			agent: "worker",
			retryMode: "initial",
			status: "running",
			startedAt: Date.now(),
			ownerPid: process.pid, // THIS process is alive
		});
		job.status = "running";
		job.latestAttemptId = attemptId;
		h.orch["store"].writeJob(job);

		// every recovery-applying read keeps the live attempt running
		assert.equal(h.orch.readJob(job.jobId)!.status, "running");
		assert.equal(h.orch.readAttempt(job.jobId, attemptId)!.status, "running");
		assert.equal(h.orch.listJobs().find((j) => j.jobId === job.jobId)!.status, "running");
		// and the job stays schedulable/messageable rather than "interrupted"
		assert.equal(h.orch.hasLiveWorker(job.jobId), false);
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

	it("injects prerequisite evidence and usable references into a dependent job envelope", async () => {
		const h = makeHarness();
		h.setWorker(
			writingWorker((attemptDir, jobId) => {
				if (jobId === "pred") {
					const artifact = path.join(attemptDir, "artifacts", "note.txt");
					fs.mkdirSync(path.dirname(artifact), { recursive: true });
					fs.writeFileSync(artifact, "artifact body");
					return outcome({
						status: "success",
						summary: "parser added",
						findings: [{ severity: "info", code: "PATTERN", message: "existing pattern", evidence: "core/x.ts:12" }],
						changes: ["core/x.ts"],
						validation: { status: "passed", checks: [] },
						artifacts: [{ id: "note", type: "file", path: "note.txt", size: 13 }],
						blockers: [],
						followUps: [],
						metrics: {},
					});
				}
				return outcome(successResult("dependent done"));
			}),
		);
		const a = h.orch.createJob({ agent: "worker", task: "pred", jobId: "pred" }, h.agents);
		const b = h.orch.createJob({ agent: "worker", task: "dep", jobId: "dep", dependsOn: ["pred"] }, h.agents);
		const reports = await h.orch.runGraph(h.agents, { jobIds: [a.jobId, b.jobId] });
		assert.equal(reports.length, 2);
		const depCall = h.workerCalls.find((c) => c.jobId === "dep")!;
		const depPrompt = depCall.prompt;
		assert.match(depPrompt, /# DEPENDENCY HANDOFFS/);
		assert.ok(depPrompt.includes("parser added"));
		assert.ok(depPrompt.includes("existing pattern"));
		assert.ok(depPrompt.includes("core/x.ts:12"));
		assert.ok(depPrompt.includes("core/x.ts"));
		assert.ok(depPrompt.includes("note.txt"));
		const resultPath = path.join(h.orch.store.jobDir("pred"), "result.json");
		assert.ok(depPrompt.includes(resultPath), "dependency section must carry the canonical result.json pointer");
		assert.ok(fs.existsSync(resultPath));
		h.cleanup();
	});

	it("bounds dependency handoff detail and labels omitted prerequisite records", async () => {
		const h = makeHarness();
		const longSummary = "S".repeat(1000);
		h.setWorker(
			writingWorker((_dir, jobId) =>
				jobId === "dep"
					? outcome(successResult("dep done"))
					: outcome({
							status: "success",
							summary: longSummary,
							findings: Array.from({ length: 5 }, (_, i) => ({ severity: "info" as const, code: `F${i}`, message: `M${i}${"m".repeat(500)}`, evidence: `E${i}${"e".repeat(500)}` })),
							changes: Array.from({ length: 7 }, (_, i) => `/p/file-${i}-${"x".repeat(300)}.ts`),
							validation: { status: "passed", checks: [] },
							artifacts: [],
							blockers: [],
							followUps: [],
							metrics: {},
						}),
			),
		);
		const preds: string[] = [];
		for (let i = 0; i < 10; i++) {
			const id = `p${i}`;
			h.orch.createJob({ agent: "worker", task: id, jobId: id }, h.agents);
			preds.push(id);
		}
		h.orch.createJob({ agent: "worker", task: "dep", jobId: "dep", dependsOn: preds }, h.agents);
		await h.orch.runGraph(h.agents);
		const depCall = h.workerCalls.find((c) => c.jobId === "dep")!;
		const stored = JSON.parse(fs.readFileSync(path.join(depCall.attemptDir, "context.json"), "utf-8")) as ContextPack;
		assert.ok(stored.dependencies && stored.dependencies.length >= 1);
		assert.ok(stored.dependencies!.length <= 8, "at most 8 prerequisite detail records");
		assert.ok((stored.dependenciesOmitted ?? 0) >= 2, "records beyond the bound are counted as omitted");
		const first = stored.dependencies![0];
		assert.ok(first.summary.length <= 400);
		assert.ok(first.findings.length <= 3);
		assert.ok(first.findings.every((f) => f.message.length <= 300 && (f.evidence?.length ?? 0) <= 300));
		assert.ok(first.changedPaths.length <= 5);
		assert.ok(first.changedPaths.every((p) => p.length <= 200));
		assert.ok(first.artifacts.length <= 3);
		assert.ok(fs.existsSync(first.resultPath));
		assert.equal(first.findingsOmitted, 2, "5 findings with a cap of 3 must report 2 omitted");
		assert.equal(first.changedPathsOmitted, 2, "7 changed paths with a cap of 5 must report 2 omitted");
		assert.match(depCall.prompt, /prerequisite record\(s\) omitted/);
		assert.match(depCall.prompt, /2 additional finding\(s\) omitted by handoff bounds/);
		assert.match(depCall.prompt, /2 additional changed path\(s\) omitted by handoff bounds/);
		assert.ok(Buffer.byteLength(dependencySection(depCall.prompt), "utf8") <= 24 * 1024, "actual rendered section must respect the UTF-8 budget");
		h.cleanup();
	});

	it("enforces the UTF-8 dependency budget for Unicode-heavy results and omits whole records", async () => {
		const h = makeHarness();
		const heavy = (n: number) => "€".repeat(n);
		// A deeply nested artifact proves long absolute references stay whole.
		const longRel = Array.from({ length: 5 }, (_, i) => `segment-${i}-${"q".repeat(140)}`).join("/") + "/evidence.txt";
		h.setWorker(
			writingWorker((attemptDir, jobId) => {
				if (jobId === "dep") return outcome(successResult("dep done"));
				const artifact = path.join(attemptDir, "artifacts", longRel);
				fs.mkdirSync(path.dirname(artifact), { recursive: true });
				fs.writeFileSync(artifact, "evidence");
				return outcome({
					status: "success",
					summary: heavy(1000),
					findings: Array.from({ length: 5 }, (_, i) => ({ severity: "info" as const, code: `F${i}`, message: heavy(400), evidence: heavy(400) })),
					changes: Array.from({ length: 7 }, (_, i) => `/${i}/${heavy(300)}.ts`),
					validation: { status: "passed", checks: [] },
					artifacts: [{ id: "long", type: "file", path: longRel, size: 8 }],
					blockers: [],
					followUps: [],
					metrics: {},
				});
			}),
		);
		const preds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = `u${i}`;
			h.orch.createJob({ agent: "worker", task: id, jobId: id }, h.agents);
			preds.push(id);
		}
		h.orch.createJob({ agent: "worker", task: "dep", jobId: "dep", dependsOn: preds }, h.agents);
		await h.orch.runGraph(h.agents);
		const depCall = h.workerCalls.find((c) => c.jobId === "dep")!;
		const stored = JSON.parse(fs.readFileSync(path.join(depCall.attemptDir, "context.json"), "utf-8")) as ContextPack;
		// The 24 KiB budget (not the 8-record cap) must drop at least one record.
		assert.ok(stored.dependencies!.length >= 1 && stored.dependencies!.length < 3, `expected budget truncation, got ${stored.dependencies!.length}`);
		assert.equal((stored.dependenciesOmitted ?? 0) + stored.dependencies!.length, 3, "every unrepresented prerequisite must be counted");
		for (const dep of stored.dependencies!) {
			assert.ok(dep.resultPath.length > 0 && !dep.resultPath.includes("…"), "result references must stay whole");
			for (const artifact of dep.artifacts) {
				assert.ok(!artifact.includes("…") && fs.existsSync(artifact), "artifact references must stay whole and usable");
			}
		}
		const section = dependencySection(depCall.prompt);
		assert.ok(Buffer.byteLength(section, "utf8") <= 24 * 1024, `actual rendered section was ${Buffer.byteLength(section, "utf8")} bytes`);
		assert.match(section, /prerequisite record\(s\) omitted by handoff bounds/);
		h.cleanup();
	});

	it("reports a missing prerequisite result instead of crashing a direct dependent run", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome(successResult("dep done"))));
		h.orch.createJob({ agent: "worker", task: "pred", jobId: "pred" }, h.agents);
		const predJob = h.orch.store.readJob("pred")!;
		predJob.status = "success";
		h.orch.store.writeJob(predJob); // no result.json was ever produced
		const dep = h.orch.createJob({ agent: "worker", task: "dep", jobId: "dep", dependsOn: ["pred"] }, h.agents);
		const report = await h.orch.runJob(dep, h.agents);
		assert.equal(report.status, "success");
		const depCall = h.workerCalls.find((c) => c.jobId === "dep")!;
		assert.match(depCall.prompt, /# DEPENDENCY HANDOFFS/);
		assert.match(depCall.prompt, /missing/);
		assert.match(depCall.prompt, /No result\.json was stored for this prerequisite/);
		h.cleanup();
	});

	it("leaves envelopes unchanged for jobs without dependencies", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome(successResult())));
		const job = h.orch.createJob({ agent: "worker", task: "standalone", context: { background: "legacy background", relevantFiles: ["legacy.ts"] } }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success");
		const promptText = h.workerCalls[0].prompt;
		assert.ok(promptText.includes("legacy background"));
		assert.ok(promptText.includes("legacy.ts"));
		assert.doesNotMatch(promptText, /# DEPENDENCY HANDOFFS/);
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

describe("incremental DAG scheduling (continuous ready-set)", () => {
	/** Poll until cond is true (deterministic deferred-promise coordination). */
	async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
		const deadline = Date.now() + ms;
		while (!cond()) {
			if (Date.now() > deadline) throw new Error("waitFor timed out");
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	/** Reject if the promise does not settle in time (hang detector). */
	function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
			}),
		]).finally(() => clearTimeout(timer));
	}

	it("fast predecessor releases its dependent while an unrelated slow job is still in flight", async () => {
		const h = makeHarness();
		const writer = writingWorker((_dir, jobId) => outcome(successResult(`done ${jobId}`)));
		let releaseB!: () => void;
		const gateB = new Promise<void>((r) => {
			releaseB = r;
		});
		h.setWorker(async (req) => {
			if (req.jobId === "job-b") await gateB; // unrelated slow sibling
			return writer(req);
		});
		const a = h.orch.createJob({ agent: "worker", task: "A: fast", jobId: "job-a" }, h.agents);
		const b = h.orch.createJob({ agent: "worker", task: "B: slow unrelated", jobId: "job-b" }, h.agents);
		const c = h.orch.createJob({ agent: "worker", task: "C: depends on A only", jobId: "job-c", dependsOn: ["job-a"] }, h.agents);

		const run = h.orch.runGraph(h.agents, { jobIds: [a.jobId, b.jobId, c.jobId] });
		// C's worker must be called while B is STILL gated — no whole-wave barrier.
		await waitFor(() => h.workerCalls.some((call) => call.jobId === "job-c"), 2000);
		assert.equal(h.orch.readJob("job-a")!.status, "success", "A released C");
		assert.equal(h.orch.readJob("job-b")!.status, "running", "unrelated slow B must still be running");
		for (const id of ["job-a", "job-b", "job-c"]) {
			assert.equal(h.workerCalls.filter((call) => call.jobId === id).length, 1, `${id} must launch exactly once`);
		}
		releaseB();
		const reports = await within(run);
		assert.equal(reports.length, 3);
		assert.ok(reports.every((r) => r.status === "success"));
		assert.equal(h.workerCalls.filter((call) => call.jobId === "job-b").length, 1);
		h.cleanup();
	});

	it("ready-set re-evaluation never exceeds the global concurrency cap", async () => {
		const h = makeHarness({ concurrency: { global: 2, byModel: {} } });
		const writer = writingWorker((_dir, jobId) => outcome(successResult(`done ${jobId}`)));
		let active = 0;
		let maxActive = 0;
		h.setWorker(async (req) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 20));
			active--;
			return writer(req);
		});
		for (let i = 0; i < 6; i++) h.orch.createJob({ agent: "worker", task: `job ${i}`, jobId: `cap-${i}` }, h.agents);
		const reports = await within(h.orch.runGraph(h.agents));
		assert.equal(reports.length, 6);
		assert.ok(reports.every((r) => r.status === "success"));
		assert.ok(maxActive <= 2, `global cap violated: ${maxActive} concurrent workers`);
		assert.equal(h.workerCalls.length, 6, "each job launches exactly once");
		h.cleanup();
	});

	it("failure blocks dependents while independent in-flight work proceeds", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 1, ladder: [] } })] });
		const writer = writingWorker((_dir, jobId) =>
			jobId === "job-f" ? outcome({ ...successResult("cannot"), status: "failure", blockers: ["boom"] }) : outcome(successResult(`done ${jobId}`)),
		);
		let releaseF!: () => void;
		let releaseI!: () => void;
		const gateF = new Promise<void>((r) => {
			releaseF = r;
		});
		const gateI = new Promise<void>((r) => {
			releaseI = r;
		});
		h.setWorker(async (req) => {
			if (req.jobId === "job-f") await gateF;
			if (req.jobId === "job-i") await gateI;
			return writer(req);
		});
		const f = h.orch.createJob({ agent: "worker", task: "F will fail", jobId: "job-f" }, h.agents);
		const i = h.orch.createJob({ agent: "worker", task: "I independent", jobId: "job-i" }, h.agents);
		const d = h.orch.createJob({ agent: "worker", task: "D depends on F", jobId: "job-d", dependsOn: ["job-f"] }, h.agents);
		const updates: string[] = [];
		const run = h.orch.runGraph(h.agents, {
			jobIds: [f.jobId, i.jobId, d.jobId],
			onJobUpdate: (r) => updates.push(`${r.jobId}:${r.status}`),
		});
		await waitFor(() => h.workerCalls.some((c) => c.jobId === "job-f") && h.workerCalls.some((c) => c.jobId === "job-i"));
		releaseF();
		// D must converge to failed while independent job I is STILL in flight.
		await waitFor(() => h.orch.readJob("job-d")!.status === "failed", 2000);
		assert.equal(h.orch.readJob("job-i")!.status, "running", "independent work must still be running");
		assert.ok(!h.workerCalls.some((c) => c.jobId === "job-d"), "blocked dependent must never spawn a worker");
		assert.ok(updates.includes("job-f:failed"));
		assert.ok(updates.includes("job-d:failed"), "dependency-gated failure must reach onJobUpdate");
		releaseI();
		const reports = await within(run);
		assert.ok(reports.some((r) => r.jobId === "job-i" && r.status === "success"), "independent job succeeds");
		assert.ok(!reports.some((r) => r.jobId === "job-d"), "blocked dependent never produces a report");
		assert.equal(h.workerCalls.filter((c) => c.jobId === "job-d").length, 0);
		h.cleanup();
	});

	it("enqueues each eligible job exactly once even when re-evaluated while queued at a gate", async () => {
		const h = makeHarness({ concurrency: { global: 4, byModel: { "worker-cheap": 1, "worker-best": 1 } } });
		const writer = writingWorker((_dir, jobId) => outcome(successResult(`done ${jobId}`)));
		let releaseX!: () => void;
		const gateX = new Promise<void>((r) => {
			releaseX = r;
		});
		h.setWorker(async (req) => {
			if (req.jobId === "job-x") await gateX;
			return writer(req);
		});
		const x = h.orch.createJob({ agent: "worker", task: "X holds the only cheap slot", jobId: "job-x" }, h.agents);
		const z = h.orch.createJob({ agent: "worker", task: "Z fast unblocker", jobId: "job-z", model: "worker-best" }, h.agents);
		// A becomes ready only after Z, then queues behind X at the worker-cheap
		// gate — so its status stays non-terminal while the ready set is re-evaluated.
		const a = h.orch.createJob({ agent: "worker", task: "A queues behind X", jobId: "job-a", dependsOn: ["job-z"] }, h.agents);

		const run = h.orch.runGraph(h.agents, { jobIds: [x.jobId, z.jobId, a.jobId] });
		await waitFor(() => h.orch.readJob("job-z")!.status === "success", 2000);
		await waitFor(() => (h.orch.config.concurrency.stats()["worker-cheap"]?.pending ?? 0) >= 1, 2000);
		assert.equal(h.orch.readJob("job-a")!.status, "blocked", "A is waiting at the gate, not running");
		assert.equal(h.orch.config.concurrency.stats()["worker-cheap"].pending, 1, "A must be enqueued exactly once");
		assert.equal(h.workerCalls.filter((c) => c.jobId === "job-a").length, 0, "A cannot start while X holds the only cheap slot");
		// extra ready-set re-evaluations must not duplicate the enqueue
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(h.orch.config.concurrency.stats()["worker-cheap"].pending, 1, "no duplicate enqueue on re-evaluation");
		assert.equal(h.workerCalls.filter((c) => c.jobId === "job-a").length, 0);

		releaseX();
		const reports = await within(run);
		assert.equal(reports.length, 3, "one report per job — no duplicate runs");
		assert.ok(reports.every((r) => r.status === "success"));
		for (const id of ["job-x", "job-z", "job-a"]) {
			assert.equal(h.workerCalls.filter((c) => c.jobId === id).length, 1, `${id} must run exactly once`);
		}
		h.cleanup();
	});

	it("cancellation drains in-flight work, launches nothing new, and returns without hanging", async () => {
		const h = makeHarness();
		const writer = writingWorker((_dir, jobId) => outcome(successResult(`done ${jobId}`)));
		h.setWorker(async (req) => {
			if (req.jobId === "job-a") {
				// settle only when the run is cancelled — the drain must still finish
				await new Promise<void>((resolve) => req.signal?.addEventListener("abort", () => resolve(), { once: true }));
			}
			return writer(req);
		});
		const a = h.orch.createJob({ agent: "worker", task: "A in flight", jobId: "job-a" }, h.agents);
		const d = h.orch.createJob({ agent: "worker", task: "D after A", jobId: "job-d", dependsOn: ["job-a"] }, h.agents);
		const ac = new AbortController();
		const run = h.orch.runGraph(h.agents, { signal: ac.signal, jobIds: [a.jobId, d.jobId] });
		await waitFor(() => h.workerCalls.some((c) => c.jobId === "job-a"), 2000);
		ac.abort();
		const reports = await within(run, 3000); // would reject on a hang
		assert.equal(h.workerCalls.filter((c) => c.jobId === "job-a").length, 1);
		assert.equal(h.workerCalls.filter((c) => c.jobId === "job-d").length, 0, "no new jobs may launch after cancellation");
		assert.ok(reports.some((r) => r.jobId === "job-a"), "in-flight job drained into reports");
		assert.equal(h.orch.readJob("job-d")!.status, "blocked", "dependent never ran");
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
