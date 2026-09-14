import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("OS-killed attempt is recovered and a fresh retry succeeds", async () => {
	const root = tmpRoot();
	const fixture = path.join(process.cwd(), "tests", "fixtures", "recovery-child.ts");
	const child = spawn(process.execPath, ["--import", "tsx", fixture, root], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

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
		child.stdout.on("data", (chunk: Buffer) => {
			lineBuffer += chunk.toString();
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() || "";
			for (const line of lines) {
				if (line.trim()) onLine(line.trim());
			}
		});
	});

	const h = makeHarness({ root });
	try {
		const pid = await ready;
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
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await once(child, "exit");
		}
		h.cleanup();
	}
});
