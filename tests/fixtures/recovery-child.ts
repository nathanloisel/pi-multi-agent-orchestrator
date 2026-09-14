import { JobStore } from "../../core/storage.ts";
import type { AttemptRecord, JobRecord } from "../../core/types.ts";

const root = process.argv[2];
if (!root) throw new Error("root argument required");
const store = new JobStore(root);
const now = Date.now();
const job: JobRecord = {
	schemaVersion: 1,
	jobId: "killed-child-job",
	objective: "recover after process termination",
	agent: "worker",
	dependsOn: [],
	status: "running",
	createdAt: now,
	updatedAt: now,
	startedAt: now,
	cwd: process.cwd(),
	retry: { maxAttempts: 3, ladder: [{ strategy: "fresh" }] },
	latestAttemptId: "attempt-001",
	attemptCount: 1,
};
store.createJobDir(job.jobId);
const attemptId = store.allocateAttempt(job.jobId);
const attempt: AttemptRecord = {
	schemaVersion: 1,
	attemptId,
	jobId: job.jobId,
	agent: job.agent,
	logicalModel: "worker-cheap",
	resolvedModel: "openrouter/test/cheap",
	provider: "openrouter",
	retryMode: "initial",
	status: "running",
	startedAt: now,
	ownerPid: process.pid,
	sessionDir: store.sessionDir(job.jobId, attemptId),
};
store.writeAttempt(attempt);
store.writeJob(job);
process.stdout.write(`READY ${process.pid}\n`);
setInterval(() => {}, 60_000);
