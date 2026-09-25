import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { test } from "node:test";
import { makeHarness, outcome, tmpRoot, writingWorker } from "./helpers.ts";
import { emptyValidation } from "../core/types.ts";

const successResult = {
	status: "success" as const,
	summary: "fresh retry recovered",
	findings: [],
	changes: [],
	validation: emptyValidation(),
	artifacts: [],
	blockers: [],
	followUps: [],
	metrics: {},
};

/** Spawn tests/fixtures/recovery-child.ts (writes a running attempt owned by
 * its own pid) and resolve once it prints READY <pid>. Never leaks: callers
 * must kill the child in a finally block. */
async function spawnRecoveryChild(root: string): Promise<{ child: ChildProcess; pid: string; stderr: () => string }> {
	const fixture = path.join(process.cwd(), "tests", "fixtures", "recovery-child.ts");
	const child = spawn(process.execPath, ["--import", "tsx", fixture, root], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	// Buffer child stdout BY LINES so READY is only matched on complete lines.
	let lineBuffer = "";
	const ready = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`child readiness timeout; stderr: ${stderr.slice(-1000)}`)), 10_000);
		const onLine = (line: string) => {
			const match = line.match(/^READY (\d+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(match[1]);
		};
		child.once("exit", (code, signal) => {
			// fail fast: child died before printing READY
			clearTimeout(timer);
			reject(new Error(`child exited before READY (code=${code} signal=${signal}); stderr: ${stderr.slice(-1000)}`));
		});
		child.stdout!.on("data", (chunk: Buffer) => {
			lineBuffer += chunk.toString();
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) onLine(line.trim());
			}
		});
	});

	let pid: string;
	try {
		pid = await ready;
	} catch (e) {
		// READY timed out / child errored before the handle was returned:
		// kill and await cleanup here so no child process leaks.
		await killChild(child);
		throw e;
	}
	return { child, pid, stderr: () => stderr };
}

/** SIGKILL the child (if it can still run) and await its exit — never leaks. */
async function killChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return; // already gone
	try {
		child.kill("SIGKILL");
	} catch {
		/* already gone or never spawned */
	}
	if (child.pid === undefined) return; // spawn failed — no process to await
	await once(child, "exit");
}

test("OS-killed attempt is recovered and a fresh retry succeeds", async () => {
	const root = tmpRoot();
	const { child, pid } = await spawnRecoveryChild(root);

	const h = makeHarness({ root });
	try {
		assert.match(pid, /^\d+$/);
		child.kill("SIGKILL");
		await once(child, "exit");

		const recovered = h.orch.readJob("killed-child-job");
		assert.equal(recovered?.status, "interrupted");
		const interrupted = h.orch.readAttempt("killed-child-job", "attempt-001");
		assert.equal(interrupted?.status, "interrupted");
		assert.equal(interrupted?.exitReason, "crashed");
		assert.ok(interrupted?.ownerPid);
		const recoveryEvents = h.orch.events.read("killed-child-job").filter((event) => event.type === "job.interrupted");
		assert.equal(recoveryEvents.length, 1);
		assert.equal(recoveryEvents[0]?.data?.reason, "orchestrator_process_terminated");

		h.setWorker(writingWorker(() => outcome(successResult)));
		const report = await h.orch.retryJob("killed-child-job", h.agents, { strategy: "fresh" });
		assert.equal(report.status, "success");
		assert.deepEqual(report.attempts.map((attempt) => attempt.attemptId), ["attempt-001", "attempt-002"]);
	} finally {
		await killChild(child);
		h.cleanup();
	}
});

test("live owner (separate process) survives listJobs; dead owner recovers exactly once", async () => {
	const root = tmpRoot();
	const { child, pid } = await spawnRecoveryChild(root);

	const h = makeHarness({ root });
	try {
		assert.equal(Number(pid), child.pid);

		// Owner (the child) is alive and this test process is NOT the owner:
		// repeated listJobs must preserve the running job and emit no event.
		for (let i = 0; i < 2; i++) {
			const listed = h.orch.listJobs().find((job) => job.jobId === "killed-child-job");
			assert.equal(listed?.status, "running", `listJobs #${i + 1} must not interrupt a live owner`);
			assert.equal(h.orch.readAttempt("killed-child-job", "attempt-001")?.status, "running");
			assert.equal(h.orch.readJob("killed-child-job")?.status, "running");
		}
		assert.equal(h.orch.events.read("killed-child-job").filter((event) => event.type === "job.interrupted").length, 0);

		// Owner dies → the next scan recovers the orphan.
		child.kill("SIGKILL");
		await once(child, "exit");

		h.orch.listJobs();
		assert.equal(h.orch.readJob("killed-child-job")?.status, "interrupted");
		const recovered = h.orch.readAttempt("killed-child-job", "attempt-001");
		assert.equal(recovered?.status, "interrupted");
		assert.equal(recovered?.exitReason, "crashed");
		let recoveryEvents = h.orch.events.read("killed-child-job").filter((event) => event.type === "job.interrupted");
		assert.equal(recoveryEvents.length, 1);
		assert.equal(recoveryEvents[0]?.data?.reason, "orchestrator_process_terminated");

		// Exactly-once: further scans never re-recover or double-emit.
		h.orch.listJobs();
		h.orch.readJob("killed-child-job");
		h.orch.listJobs();
		recoveryEvents = h.orch.events.read("killed-child-job").filter((event) => event.type === "job.interrupted");
		assert.equal(recoveryEvents.length, 1);
		assert.equal(h.orch.readAttempt("killed-child-job", "attempt-001")?.status, "interrupted");
	} finally {
		await killChild(child);
		h.cleanup();
	}
});
