import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson, atomicWriteText, readJson } from "./storage.ts";
import type { AttemptRecord, JobRecord } from "./types.ts";

/** Export files hold session metadata/transcripts: keep them private. */
function makePrivate(file: string): void {
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		/* best effort (platforms without POSIX modes) */
	}
}

/** Project directories group session files: keep them private too. */
function makePrivateDir(dir: string): void {
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* best effort (platforms without POSIX modes) */
	}
}

export interface AgentsViewExportOptions {
	enabled: boolean;
	exportDir: string;
}

export interface AgentsViewExportRecord {
	schemaVersion: 1;
	jobId: string;
	attemptId: string;
	agent: string;
	model?: string;
	provider?: string;
	status: string;
	startedAt: number;
	completedAt?: number;
	sessionPath: string;
	sourceSessionPath?: string;
}

/**
 * Projects attempts onto AgentsView's supported Pi JSONL contract. AgentsView
 * does not support registering arbitrary agent kinds, so these appear as Pi
 * sessions; the session title and manifest retain the subagent identity.
 */
export class AgentsViewExporter {
	constructor(private readonly options: AgentsViewExportOptions) {}

	export(job: JobRecord, attempt: AttemptRecord): AgentsViewExportRecord | undefined {
		if (!this.options.enabled) return undefined;
		// AgentsView's installed parser (DirectoryJSONLSourceSet) only indexes
		// <root>/<project>/<session>.jsonl paths — root-level files are rejected.
		const projectDir = path.join(this.options.exportDir, "orchestrator");
		fs.mkdirSync(projectDir, { recursive: true });
		makePrivateDir(projectDir);
		const safeName = `${safe(job.jobId)}--${safe(attempt.attemptId)}.jsonl`;
		const destination = path.join(projectDir, safeName);
		const legacyFlat = path.join(this.options.exportDir, safeName);
		const source = attempt.sessionDir ? findSession(attempt.sessionDir) : undefined;
		const title = `${attempt.agent} · ${job.jobId}/${attempt.attemptId} · ${attempt.status}`;
		const lines = source ? projectedSource(source, title, job, attempt) : metadataProjection(title, job, attempt);
		atomicWriteText(destination, `${lines.join("\n")}\n`);
		makePrivate(destination);
		// Legacy flat layout: remove only after the nested write succeeded so a
		// failed export never loses the previously visible session.
		if (fs.existsSync(legacyFlat)) {
			try {
				fs.rmSync(legacyFlat, { force: true });
			} catch {
				/* best effort; startup backfill retries */
			}
		}

		const record: AgentsViewExportRecord = {
			schemaVersion: 1,
			jobId: job.jobId,
			attemptId: attempt.attemptId,
			agent: attempt.agent,
			status: attempt.status,
			startedAt: attempt.startedAt,
			sessionPath: destination,
			...(attempt.resolvedModel ? { model: attempt.resolvedModel } : {}),
			...(attempt.provider ? { provider: attempt.provider } : {}),
			...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
			...(source ? { sourceSessionPath: source } : {}),
		};
		const manifestPath = path.join(this.options.exportDir, "orchestrator-sessions.json");
		const current = readJson<AgentsViewExportRecord[]>(manifestPath) ?? [];
		const next = current.filter((item) => !(item.jobId === job.jobId && item.attemptId === attempt.attemptId));
		next.push(record);
		next.sort((a, b) => `${a.jobId}/${a.attemptId}`.localeCompare(`${b.jobId}/${b.attemptId}`));
		atomicWriteJson(manifestPath, next);
		makePrivate(manifestPath);
		return record;
	}
}

function safe(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function findSession(dir: string): string | undefined {
	if (!fs.existsSync(dir)) return undefined;
	const pending = [dir];
	while (pending.length) {
		const current = pending.shift();
		if (!current) break;
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) pending.push(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl") && isPiSession(full)) return full;
		}
	}
	return undefined;
}

function isPiSession(file: string): boolean {
	try {
		const first = fs.readFileSync(file, "utf-8").split("\n").find((line) => line.trim());
		if (!first) return false;
		const parsed = JSON.parse(first) as { type?: unknown };
		return parsed.type === "session";
	} catch {
		return false;
	}
}

function projectedSource(source: string, title: string, job: JobRecord, attempt: AttemptRecord): string[] {
	const lines = fs.readFileSync(source, "utf-8").split("\n").filter((line) => line.trim());
	const header = JSON.parse(lines[0]!) as Record<string, unknown>;
	header.title = title;
	header.orchestrator = metadata(job, attempt, source);
	lines[0] = JSON.stringify(header);
	return lines;
}

function metadataProjection(title: string, job: JobRecord, attempt: AttemptRecord): string[] {
	const timestamp = new Date(attempt.startedAt).toISOString();
	const id = `orchestrator-${safe(job.jobId)}-${safe(attempt.attemptId)}`;
	return [
		JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: job.cwd, title, orchestrator: metadata(job, attempt) }),
		JSON.stringify({
			type: "message",
			id: "objective",
			parentId: null,
			timestamp,
			message: { role: "user", content: job.objective, timestamp: attempt.startedAt },
		}),
	];
}

function metadata(job: JobRecord, attempt: AttemptRecord, sourceSessionPath?: string): Record<string, unknown> {
	return {
		jobId: job.jobId,
		attemptId: attempt.attemptId,
		agent: attempt.agent,
		model: attempt.resolvedModel,
		provider: attempt.provider,
		status: attempt.status,
		startedAt: attempt.startedAt,
		completedAt: attempt.completedAt,
		sourceSessionPath,
	};
}
