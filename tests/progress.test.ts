/**
 * Tests: live main-session progress — pure progress model/formatter
 * (core/progress.ts), the EventLog observer seam, and the runtime progress
 * callbacks (runGraph onJobUpdate, waitJobs onPoll). No pi subprocesses.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { EventLog } from "../core/events.ts";
import {
	buildSnapshot,
	collectMembershipJobIds,
	ProgressTracker,
	progressStatusText,
	PROGRESS_MEMBERSHIP_ENTRY_TYPE,
	renderProgress,
	shortJobId,
	shortLabel,
	stateForJobStatus,
	stateFromEventType,
	type ProgressTask,
} from "../core/progress.ts";
import { statusIsTerminal } from "../core/storage.ts";
import { DEFAULT_RETRY, emptyValidation, type JobRecord, type JobStatus } from "../core/types.ts";
import { makeAgent, makeHarness, outcome, tmpRoot, writingWorker } from "./helpers.ts";

function mkJob(over: Partial<JobRecord> & { jobId: string; status: JobStatus }): JobRecord {
	return {
		schemaVersion: 1,
		objective: "obj",
		agent: "worker",
		dependsOn: [],
		createdAt: 0,
		updatedAt: 0,
		cwd: "/tmp",
		retry: DEFAULT_RETRY,
		attemptCount: 1,
		...over,
	};
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

// ── Pure model: state mapping, ids, labels ───────────────────────────────────

describe("progress state mapping", () => {
	it("maps every persisted JobStatus to exactly one of six display states", () => {
		const statuses: JobStatus[] = ["queued", "blocked", "ready", "running", "waiting", "success", "failed", "cancelled", "interrupted"];
		const allowed = new Set(["queued", "blocked", "running", "done", "failed", "cancelled"]);
		for (const s of statuses) {
			assert.ok(allowed.has(stateForJobStatus(s)), `unmapped state for ${s}`);
		}
	});

	it("never renders waiting/ready/blocked jobs as running", () => {
		assert.equal(stateForJobStatus("waiting"), "queued"); // retry pending, not running
		assert.equal(stateForJobStatus("ready"), "queued");
		assert.equal(stateForJobStatus("blocked"), "blocked");
		assert.equal(stateForJobStatus("running"), "running");
		assert.equal(stateForJobStatus("success"), "done");
		assert.equal(stateForJobStatus("failed"), "failed");
		assert.equal(stateForJobStatus("interrupted"), "failed");
		assert.equal(stateForJobStatus("cancelled"), "cancelled");
		assert.equal(stateForJobStatus("queued"), "queued");
	});
});

describe("progress labels & ids", () => {
	it("derives a short single-line label from the reused objective", () => {
		const label = shortLabel("# Implement the thing\n\nsecond line ignored\n- bullet");
		assert.equal(label, "Implement the thing");
		assert.ok(!label.includes("\n"));
	});

	it("truncates long objectives with an ellipsis", () => {
		const label = shortLabel("x".repeat(100));
		assert.equal(label.length, 48);
		assert.ok(label.endsWith("…"));
	});

	it("extracts the meaningful slug from auto-generated job ids and keeps explicit ids intact", () => {
		assert.equal(shortJobId("coder--fix-login-redirect--m5abcd"), "fix-login-redirect");
		assert.equal(shortJobId("auth"), "auth");
	});
});

// ── Pure formatter ───────────────────────────────────────────────────────────

describe("renderProgress", () => {
	it("returns no lines for an empty snapshot (widget cleared)", () => {
		assert.deepEqual(renderProgress([]), []);
		assert.equal(progressStatusText([]), "");
	});

	it("renders Plan header, Now line, distinct state icons and a counts footer", () => {
		const tasks = buildSnapshot([
			mkJob({ jobId: "worker--gamma--z", status: "success", objective: "Ship gamma", createdAt: 3, updatedAt: 6 }),
			mkJob({ jobId: "worker--alpha--x", status: "running", objective: "Implement alpha feature", createdAt: 1, updatedAt: 5 }),
			mkJob({ jobId: "worker--beta--y", status: "queued", objective: "Write beta docs", createdAt: 2, updatedAt: 4 }),
		]);
		const lines = renderProgress(tasks);
		assert.equal(lines[0], "Plan");
		assert.equal(lines[1], "Now: #alpha");
		assert.ok(lines.some((l) => l.startsWith("▶ #alpha Implement alpha feature")));
		assert.ok(lines.some((l) => l.startsWith("○ #beta Write beta docs")));
		assert.ok(lines.some((l) => l.startsWith("✓ #gamma Ship gamma")));
		assert.ok(lines.some((l) => l === "1/3 done"));
		assert.equal(progressStatusText(tasks), "1 running · 1 pending · 1/3 done");
	});

	it("names every actually-running task on the Now line (parallel jobs)", () => {
		const tasks = buildSnapshot([
			mkJob({ jobId: "a", status: "running", createdAt: 1, updatedAt: 1 }),
			mkJob({ jobId: "b", status: "running", createdAt: 2, updatedAt: 2 }),
		]);
		assert.equal(renderProgress(tasks)[1], "Now: #a, #b");
	});

	it("dependency-blocked jobs show ⊘ and never appear on the Now line", () => {
		const tasks = buildSnapshot([
			mkJob({ jobId: "a", status: "running", createdAt: 1, updatedAt: 1 }),
			mkJob({ jobId: "b", status: "blocked", dependsOn: ["c"], createdAt: 2, updatedAt: 2 }),
		]);
		const lines = renderProgress(tasks);
		assert.equal(lines[1], "Now: #a");
		assert.ok(lines.some((l) => l.startsWith("⊘ #b")));
	});

	it("cancelled and failed states are distinct from done", () => {
		const tasks = buildSnapshot([
			mkJob({ jobId: "a", status: "cancelled", createdAt: 1, updatedAt: 1 }),
			mkJob({ jobId: "b", status: "failed", createdAt: 2, updatedAt: 2 }),
			mkJob({ jobId: "c", status: "success", createdAt: 3, updatedAt: 3 }),
		]);
		const lines = renderProgress(tasks);
		assert.ok(lines.some((l) => l.startsWith("× #a")));
		assert.ok(lines.some((l) => l.startsWith("✗ #b")));
		assert.ok(lines.some((l) => l.startsWith("✓ #c")));
		assert.ok(lines.some((l) => l === "1/3 done · 1 failed"));
	});

	it("shows a truthful retry indicator (↻N) after reactivation", () => {
		const tasks = buildSnapshot([mkJob({ jobId: "a", status: "running", attemptCount: 2, createdAt: 1, updatedAt: 3 })]);
		assert.ok(renderProgress(tasks).some((l) => l.startsWith("▶ #a") && l.endsWith("↻2")));
	});

	it("caps finished rows and reports truthful overflow; active rows always visible", () => {
		const active = [
			mkJob({ jobId: "run-1", status: "running", createdAt: 1, updatedAt: 1 }),
			mkJob({ jobId: "run-2", status: "queued", createdAt: 2, updatedAt: 2 }),
			mkJob({ jobId: "run-3", status: "blocked", createdAt: 3, updatedAt: 3 }),
		];
		const finished = Array.from({ length: 10 }, (_, i) =>
			mkJob({ jobId: `done-${i}`, status: "success", createdAt: 10 + i, updatedAt: 100 - i }),
		);
		const lines = renderProgress(buildSnapshot([...active, ...finished]), { maxTasks: 9 });
		const overflow = lines.find((l) => l.startsWith("… +"));
		assert.ok(overflow, "missing overflow line");
		assert.equal(overflow, "… +4 finished earlier");
		for (const a of active) assert.ok(lines.some((l) => l.includes(`#${a.jobId}`)), `active ${a.jobId} dropped`);
		assert.equal(lines.filter((l) => l.startsWith("✓ #done-")).length, 6);
	});

	it("shows readable state words for queued/blocked/failed/cancelled rows", () => {
		const tasks = buildSnapshot([
			mkJob({ jobId: "a", status: "queued", createdAt: 1, updatedAt: 1 }),
			mkJob({ jobId: "b", status: "blocked", createdAt: 2, updatedAt: 2 }),
			mkJob({ jobId: "c", status: "cancelled", createdAt: 3, updatedAt: 3 }),
			mkJob({ jobId: "d", status: "failed", createdAt: 4, updatedAt: 4 }),
		]);
		const lines = renderProgress(tasks);
		assert.ok(lines.some((l) => l.includes("#a") && l.includes("· queued")));
		assert.ok(lines.some((l) => l.includes("#b") && l.includes("· blocked")));
		assert.ok(lines.some((l) => l.includes("#c") && l.includes("· cancelled")));
		assert.ok(lines.some((l) => l.includes("#d") && l.includes("· failed")));
	});

	it("caps active rows and the Now line with truthful overflow for 16 active jobs", () => {
		const active = Array.from({ length: 16 }, (_, i) =>
			mkJob({ jobId: `act-${i}`, status: i < 5 ? "running" : "queued", createdAt: i, updatedAt: i }),
		);
		const lines = renderProgress(buildSnapshot(active), { maxTasks: 9 });
		const taskRows = lines.filter((l) => /^[▶○⊘✓✗×] #/.test(l));
		assert.equal(taskRows.length, 9, "task rows must be capped");
		assert.equal(lines[1], "Now: #act-0, #act-1, #act-2 +2 more", "Now line must be capped");
		assert.ok(lines.includes("… +7 active hidden (5 running)"), `truthful active overflow missing: ${lines.join(" | ")}`);
	});

	it("applies the paint callback to task rows only", () => {
		const tasks = buildSnapshot([mkJob({ jobId: "a", status: "running", createdAt: 1, updatedAt: 1 })]);
		const lines = renderProgress(tasks, { paint: (t: ProgressTask, line: string) => `<${t.state}>${line}` });
		assert.ok(lines.some((l) => l.startsWith("<running>▶ #a")));
		assert.equal(lines[0], "Plan");
	});

	it("stateFromEventType never claims running before the scheduler confirms it", () => {
		assert.equal(stateFromEventType("job.created"), "queued");
		assert.equal(stateFromEventType("job.ready"), "queued");
		assert.equal(stateFromEventType("attempt.started"), "running"); // only real start
		assert.equal(stateFromEventType("provider.requested"), null); // transport ≠ running
		assert.equal(stateFromEventType("validation.started"), null);
		assert.equal(stateFromEventType("job.completed"), null); // terminal truth via final report
		assert.equal(stateFromEventType("job.failed"), null);
	});
});

// ── Tracker: stable ordering, evolution, pruning ────────────────────────────

describe("ProgressTracker", () => {
	it("keeps stable first-seen order as tasks are added and updated", () => {
		const tracker = new ProgressTracker();
		tracker.sync([mkJob({ jobId: "b", status: "queued", createdAt: 2 }), mkJob({ jobId: "a", status: "queued", createdAt: 1 })]);
		tracker.sync([mkJob({ jobId: "a", status: "running", createdAt: 1, updatedAt: 9 })]);
		assert.deepEqual(tracker.snapshot().map((t) => t.jobId), ["b", "a"]);
		assert.equal(tracker.snapshot()[1]!.state, "running");
	});

	it("reports no change when nothing changed", () => {
		const tracker = new ProgressTracker();
		const job = mkJob({ jobId: "a", status: "queued" });
		assert.equal(tracker.sync([job]), true);
		assert.equal(tracker.sync([mkJob({ jobId: "a", status: "queued", updatedAt: 0 })]), false);
	});

	it("follows the full lifecycle: queued → running → done, with retry reactivation", () => {
		const tracker = new ProgressTracker();
		tracker.sync([mkJob({ jobId: "a", status: "queued", createdAt: 1 })]);
		assert.equal(tracker.snapshot()[0]!.state, "queued");
		tracker.sync([mkJob({ jobId: "a", status: "waiting", attemptCount: 1, updatedAt: 2 })]);
		assert.equal(tracker.snapshot()[0]!.state, "queued"); // between attempts ≠ running
		tracker.sync([mkJob({ jobId: "a", status: "running", attemptCount: 2, updatedAt: 3 })]);
		assert.equal(tracker.snapshot()[0]!.state, "running");
		assert.equal(tracker.snapshot()[0]!.attempts, 2);
		tracker.sync([mkJob({ jobId: "a", status: "success", attemptCount: 2, updatedAt: 4 })]);
		assert.equal(tracker.snapshot()[0]!.state, "done");
	});

	it("prunes oldest finished tasks first and never drops active ones", () => {
		const tracker = new ProgressTracker(5);
		const active = [
			mkJob({ jobId: "act-1", status: "running", createdAt: 1, updatedAt: 1 }),
			mkJob({ jobId: "act-2", status: "queued", createdAt: 2, updatedAt: 2 }),
		];
		const finished = Array.from({ length: 5 }, (_, i) =>
			mkJob({ jobId: `fin-${i}`, status: "success", createdAt: 10 + i, updatedAt: 10 + i }),
		);
		tracker.sync([...active, ...finished]);
		assert.equal(tracker.size, 5);
		const ids = tracker.snapshot().map((t) => t.jobId);
		for (const a of active) assert.ok(ids.includes(a.jobId), `active ${a.jobId} was pruned`);
		assert.ok(!ids.includes("fin-0"), "oldest finished task should have been pruned first");
	});

	it("never silently drops active tasks beyond its cap (>48 active)", () => {
		const tracker = new ProgressTracker(48);
		const active = Array.from({ length: 60 }, (_, i) =>
			mkJob({ jobId: `act-${i}`, status: "queued", createdAt: i, updatedAt: i }),
		);
		assert.equal(tracker.sync(active), true);
		assert.equal(tracker.size, 60, "all active tasks stay tracked even beyond the cap");
		assert.equal(tracker.snapshot().length, 60);
		// widget remains bounded even when tracking grows
		assert.ok(renderProgress(tracker.snapshot(), { maxTasks: 9 }).length <= 13);
	});

	it("has() reflects tracked jobs only", () => {
		const tracker = new ProgressTracker();
		tracker.sync([mkJob({ jobId: "a", status: "queued" })]);
		assert.equal(tracker.has("a"), true);
		assert.equal(tracker.has("nope"), false);
	});
});

// ── EventLog observer seam ───────────────────────────────────────────────────

describe("EventLog onEvent seam", () => {
	it("notifies listeners on append and supports unsubscribe", () => {
		const log = new EventLog(path.join(tmpRoot(), "jobs"));
		const seen: string[] = [];
		const un = log.onEvent((e) => seen.push(e.type));
		log.append("j1", "job.created");
		un();
		log.append("j1", "job.started");
		assert.deepEqual(seen, ["job.created"]);
	});

	it("isolates listener exceptions from the append path and other listeners", () => {
		const log = new EventLog(path.join(tmpRoot(), "jobs"));
		log.onEvent(() => {
			throw new Error("observer boom");
		});
		const seen: string[] = [];
		log.onEvent((e) => seen.push(e.type));
		assert.doesNotThrow(() => log.append("j2", "job.completed"));
		assert.deepEqual(seen, ["job.completed"]);
	});
});

// ── Runtime progress callbacks (fake worker harness) ─────────────────────────

/** Fake worker that gates on a promise, then writes a success result.json. */
function gatedSuccessWorker(gate: Promise<void>, gatedJobId: string) {
	return async (req: { jobId: string; attemptDir: string }) => {
		if (req.jobId === gatedJobId) await gate;
		const full = {
			schemaVersion: 1,
			jobId: req.jobId,
			attemptId: "",
			status: "success",
			summary: "ok",
			findings: [],
			changes: [],
			validation: emptyValidation(),
			artifacts: [],
			blockers: [],
			followUps: [],
			metrics: {},
		};
		fs.writeFileSync(path.join(req.attemptDir, "result.json"), JSON.stringify(full, null, 2));
		return outcome({ status: "success", summary: "ok" });
	};
}

describe("runtime progress callbacks", () => {
	it("runGraph streams onJobUpdate as each parallel job settles", async () => {
		const h = makeHarness();
		let slowId = "";
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		h.setWorker((req) => gatedSuccessWorker(gate, slowId)(req as { jobId: string; attemptDir: string }));
		const fast = h.orch.createJob({ agent: "worker", task: "fast job" }, h.agents);
		const slow = h.orch.createJob({ agent: "worker", task: "slow job" }, h.agents);
		slowId = slow.jobId;

		const updates: string[] = [];
		const done = h.orch.runGraph(h.agents, {
			jobIds: [fast.jobId, slow.jobId],
			onJobUpdate: (r) => updates.push(`${r.jobId}:${r.status}`),
		});
		await waitFor(() => updates.length === 1);
		assert.ok(updates[0]!.startsWith(fast.jobId), "fast job should settle while slow is still gated");
		release();
		const reports = await done;
		assert.equal(reports.length, 2);
		assert.deepEqual(updates, [`${fast.jobId}:success`, `${slow.jobId}:success`]);
		h.cleanup();
	});

	it("runGraph onJobUpdate exceptions never change job outcome", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome({ status: "success", summary: "ok" })));
		const job = h.orch.createJob({ agent: "worker", task: "x" }, h.agents);
		const reports = await h.orch.runGraph(h.agents, {
			jobIds: [job.jobId],
			onJobUpdate: () => {
				throw new Error("observer boom");
			},
		});
		assert.equal(reports[0]!.status, "success");
		assert.equal(h.orch.readJob(job.jobId)!.status, "success");
		h.cleanup();
	});

	it("waitJobs fires onPoll once per status change (no polling spam)", async () => {
		const h = makeHarness();
		const job = h.orch.createJob({ agent: "worker", task: "idle job" }, h.agents);
		const calls: number[] = [];
		const jobs = await h.orch.waitJobs([job.jobId], 700, undefined, (snapshot) => calls.push(snapshot.length));
		assert.equal(jobs[0]!.status, "queued");
		assert.equal(calls.length, 1, "status never changed → exactly the initial onPoll");
		h.cleanup();
	});

	it("the EventLog seam drives a queued → running → done widget projection", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome({ status: "success", summary: "ok" })));
		const tracker = new ProgressTracker();
		const job = h.orch.createJob({ agent: "worker", task: "Implement feature X." }, h.agents);
		const fresh = h.orch.readJob(job.jobId)!;
		tracker.sync([fresh]);
		const states: string[] = [tracker.snapshot()[0]!.state];
		const un = h.orch.events.onEvent(() => {
			const j = h.orch.store.readJob(job.jobId); // raw state — no crash recovery
			if (j && tracker.sync([j])) states.push(tracker.snapshot().find((t) => t.jobId === job.jobId)!.state);
		});
		try {
			await h.orch.runJob(job, h.agents);
		} finally {
			un();
		}
		assert.deepEqual(states, ["queued", "running", "done"]);
		h.cleanup();
	});

	it("terminal persisted statuses map off the active plan (restore filter sanity)", () => {
		for (const s of ["success", "failed", "cancelled"] as JobStatus[]) {
			assert.equal(statusIsTerminal(s), true);
		}
		assert.equal(statusIsTerminal("queued"), false);
		assert.equal(statusIsTerminal("waiting"), false);
		assert.equal(statusIsTerminal("running"), false);
	});

	it("runGraph reports dependency-gated failures through onJobUpdate and converges persisted state", async () => {
		const h = makeHarness({ agents: [makeAgent({ name: "worker", retry: { maxAttempts: 1, ladder: [] } })] });
		h.setWorker(
			writingWorker((_dir, jobId) =>
				jobId === "job-a" ? outcome({ status: "failure", summary: "nope", blockers: ["boom"] }) : outcome({ status: "success", summary: "ok" }),
			),
		);
		const a = h.orch.createJob({ agent: "worker", task: "root job", jobId: "job-a" }, h.agents);
		const b = h.orch.createJob({ agent: "worker", task: "dependent job", jobId: "job-b", dependsOn: ["job-a"] }, h.agents);
		const updates: string[] = [];
		const reports = await h.orch.runGraph(h.agents, {
			jobIds: [a.jobId, b.jobId],
			onJobUpdate: (r) => updates.push(`${r.jobId}:${r.status}`),
		});
		assert.ok(updates.includes("job-a:failed"));
		assert.ok(updates.includes("job-b:failed"), "dependency-gated failure must reach partial reports");
		assert.equal(h.orch.store.readJob("job-b")!.status, "failed", "persisted state must converge, not stay blocked");
		assert.ok(!h.workerCalls.some((c) => c.jobId === "job-b"), "gated job must never spawn a worker");
		assert.deepEqual(reports.map((r) => r.jobId), ["job-a"]);
		h.cleanup();
	});
});

// ── Session membership restore (branch-scoped, side-effect-free) ────────────

describe("session membership restore", () => {
	const entry = (jobIds: string[]) => ({ type: "custom", customType: PROGRESS_MEMBERSHIP_ENTRY_TYPE, data: { jobIds } });

	it("collects job ids from membership entries only, deduped in first-seen order", () => {
		const entries = [
			entry(["a", "b"]),
			{ type: "custom", customType: "unrelated-plugin", data: { jobIds: ["x"] } },
			{ type: "message" },
			entry(["b", "c"]),
			{ type: "custom", customType: PROGRESS_MEMBERSHIP_ENTRY_TYPE, data: {} },
		];
		assert.deepEqual(collectMembershipJobIds(entries), ["a", "b", "c"]);
	});

	it("two main sessions in the same cwd never inherit each other's jobs", () => {
		const sessionABranch = [entry(["a-job"]), entry(["a2-job"])];
		const sessionBBranch = [entry(["b-job"])];
		const a = collectMembershipJobIds(sessionABranch);
		const b = collectMembershipJobIds(sessionBBranch);
		assert.ok(!a.includes("b-job"), "session A must not see session B's jobs");
		assert.ok(!b.includes("a-job") && !b.includes("a2-job"), "session B must not see session A's jobs");
	});

	it("restore re-projects membership ids from raw store reads, finished included", async () => {
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome({ status: "success", summary: "ok" })));
		const done = h.orch.createJob({ agent: "worker", task: "finished job", jobId: "done-job" }, h.agents);
		const pending = h.orch.createJob({ agent: "worker", task: "queued job", jobId: "pending-job" }, h.agents);
		await h.orch.runJob(done, h.agents); // leaves done-job success on disk
		const tracker = new ProgressTracker();
		// what restoreProgressFromBranch does: collect ids → raw store.readJob → sync
		const ids = collectMembershipJobIds([entry(["done-job", "pending-job", "never-existed"])]);
		const jobs = ids.map((id) => h.orch.store.readJob(id)).filter((j): j is JobRecord => Boolean(j));
		tracker.sync(jobs);
		const snap = tracker.snapshot();
		assert.deepEqual(
			snap.map((t) => [t.jobId, t.state]),
			[
				["done-job", "done"],
				["pending-job", "queued"],
			],
		);
		assert.ok(snap.some((t) => t.jobId === "done-job"), "finished referenced jobs reappear within display budget");
		h.cleanup();
	});
});
