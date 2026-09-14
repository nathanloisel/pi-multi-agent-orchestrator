/**
 * core/storage.ts — job/attempt persistence with atomic writes.
 *
 * Layout (v2):
 *   <root>/jobs/<jobId>/
 *   ├── job.json          # JobRecord (source of truth for job state)
 *   ├── task.md           # rendered job envelope of the initial attempt
 *   ├── context.json      # ContextPack of the initial attempt
 *   ├── events.jsonl      # append-only event log
 *   ├── result.json       # canonical validated result (copied from latest attempt)
 *   ├── report.md         # human rendering of result.json
 *   ├── artifacts/        # job-level artifacts + manifest.json
 *   └── attempts/attempt-NNN/
 *       ├── attempt.json  # AttemptRecord
 *       ├── result.json   # validated result for this attempt
 *       ├── raw-output.txt# original final worker message (debugging)
 *       ├── report.md
 *       ├── SYSTEM.md     # rendered sub-agent instructions
 *       ├── env.json      # non-secret env actually passed (audit)
 *       ├── artifacts/    # attempt artifacts + manifest.json
 *       ├── validation/   # deterministic check logs
 *       └── session/      # persistent pi session dir (resume channel)
 *
 * Safety (§28): every JSON write goes through a temp file + rename in the same
 * directory (atomic on POSIX). Attempt allocation uses mkdir (atomic) so two
 * schedulers can never claim the same attempt number. A crash leaves at worst
 * an attempt.json with status "running" — recoverInterrupted() marks those
 * "interrupted" at load time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ArtifactRecord, AttemptRecord, JobRecord, JobStatus } from "./types.ts";

export function atomicWriteJson(file: string, data: unknown): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}

export function atomicWriteText(file: string, text: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

export function sha256File(file: string): string | undefined {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return undefined;
	}
}

// ── Path helpers ────────────────────────────────────────────────────────────

export class JobStore {
	private recoveryHandler?: (job: JobRecord, attempt: AttemptRecord) => void;

	constructor(public readonly root: string) {}

	setRecoveryHandler(handler: (job: JobRecord, attempt: AttemptRecord) => void): void {
		this.recoveryHandler = handler;
	}

	jobsDir(): string {
		return path.join(this.root, "jobs");
	}
	jobDir(jobId: string): string {
		return path.join(this.jobsDir(), jobId);
	}
	attemptsDir(jobId: string): string {
		return path.join(this.jobDir(jobId), "attempts");
	}
	attemptDir(jobId: string, attemptId: string): string {
		return path.join(this.attemptsDir(jobId), attemptId);
	}
	jobArtifactsDir(jobId: string): string {
		return path.join(this.jobDir(jobId), "artifacts");
	}
	attemptArtifactsDir(jobId: string, attemptId: string): string {
		return path.join(this.attemptDir(jobId, attemptId), "artifacts");
	}
	validationDir(jobId: string, attemptId: string): string {
		return path.join(this.attemptDir(jobId, attemptId), "validation");
	}
	sessionDir(jobId: string, attemptId: string): string {
		return path.join(this.attemptDir(jobId, attemptId), "session");
	}

	// ── Jobs ────────────────────────────────────────────────────────────────

	createJobDir(jobId: string): void {
		fs.mkdirSync(this.jobDir(jobId), { recursive: true });
		fs.mkdirSync(this.jobArtifactsDir(jobId), { recursive: true });
		fs.mkdirSync(this.attemptsDir(jobId), { recursive: true });
	}

	readJob(jobId: string): JobRecord | null {
		return readJson<JobRecord>(path.join(this.jobDir(jobId), "job.json"));
	}

	writeJob(job: JobRecord): void {
		job.updatedAt = Date.now();
		atomicWriteJson(path.join(this.jobDir(job.jobId), "job.json"), job);
	}

	listJobs(): JobRecord[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.jobsDir());
		} catch {
			return [];
		}
		const jobs: JobRecord[] = [];
		for (const entry of entries) {
			const job = this.readJob(entry);
			if (job) jobs.push(this.recoverInterrupted(job));
		}
		return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Mark attempts left "running" by a crash as interrupted (§29). */
	recoverInterrupted(job: JobRecord): JobRecord {
		const attempt = job.latestAttemptId ? this.readAttempt(job.jobId, job.latestAttemptId) : null;
		if (attempt && attempt.status === "running") {
			attempt.status = "interrupted";
			attempt.exitReason = "crashed";
			attempt.completedAt = Date.now();
			this.writeAttempt(attempt);
			if (job.status === "running") {
				job.status = "interrupted";
				this.writeJob(job);
			}
			this.recoveryHandler?.(job, attempt);
		}
		return job;
	}

	newJobId(agent: string, objective: string): string {
		const slug = objective
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		return `${agent}--${slug || "job"}--${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	}

	// ── Attempts ─────────────────────────────────────────────────────────────

	/** Atomically allocate the next attempt directory (mkdir is atomic). */
	allocateAttempt(jobId: string): string {
		fs.mkdirSync(this.attemptsDir(jobId), { recursive: true });
		for (let n = 1; n < 1000; n++) {
			const id = `attempt-${String(n).padStart(3, "0")}`;
			const dir = this.attemptDir(jobId, id);
			try {
				fs.mkdirSync(dir); // fails if exists → next
				fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
				fs.mkdirSync(path.join(dir, "validation"), { recursive: true });
				fs.mkdirSync(path.join(dir, "session"), { recursive: true });
				return id;
			} catch {
				continue;
			}
		}
		throw new Error(`Cannot allocate attempt for job ${jobId}: too many attempts`);
	}

	readAttempt(jobId: string, attemptId: string): AttemptRecord | null {
		return readJson<AttemptRecord>(path.join(this.attemptDir(jobId, attemptId), "attempt.json"));
	}

	writeAttempt(attempt: AttemptRecord): void {
		atomicWriteJson(path.join(this.attemptDir(attempt.jobId, attempt.attemptId), "attempt.json"), attempt);
	}

	listAttempts(jobId: string): AttemptRecord[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.attemptsDir(jobId));
		} catch {
			return [];
		}
		const attempts: AttemptRecord[] = [];
		for (const entry of entries.sort()) {
			const a = this.readAttempt(jobId, entry);
			if (a) attempts.push(a);
		}
		return attempts;
	}

	// ── Artifacts (§17) ──────────────────────────────────────────────────────

	buildManifest(artifactsDir: string): ArtifactRecord[] {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(artifactsDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const manifest: ArtifactRecord[] = [];
		const walk = (dir: string, prefix: string) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				if (e.name.startsWith(".")) continue;
				const full = path.join(dir, e.name);
				const rel = `${prefix}${e.name}`;
				if (e.isDirectory()) walk(full, `${rel}/`);
				else {
					let size = 0;
					try {
						size = fs.statSync(full).size;
					} catch {
						/* skip */
					}
					manifest.push({
						id: rel.replace(/\//g, "_"),
						type: rel.endsWith(".patch") || rel.endsWith(".diff") ? "git-diff" : rel.endsWith(".log") ? "log" : "file",
						path: rel,
						size,
						sha256: sha256File(full),
					});
				}
			}
		};
		walk(artifactsDir, "");
		// merge worker-declared entries keep manifest deterministic
		manifest.sort((a, b) => a.path.localeCompare(b.path));
		try {
			atomicWriteJson(path.join(artifactsDir, "manifest.json"), manifest.filter((m) => m.path !== "manifest.json"));
		} catch {
			/* best effort */
		}
		return manifest.filter((m) => m.path !== "manifest.json");
	}

	/** Safe artifact read: resolves within artifactsDir or returns null (§30). */
	resolveArtifact(artifactsDir: string, relPath: string): string | null {
		const cleaned = relPath.replace(/^[/@]+/, "");
		const full = path.resolve(artifactsDir, cleaned);
		const root = path.resolve(artifactsDir);
		if (!full.startsWith(root + path.sep) && full !== root) return null;
		return fs.existsSync(full) ? full : null;
	}
}

export function statusIsTerminal(status: JobStatus): boolean {
	return status === "success" || status === "failed" || status === "cancelled";
}
