/**
 * core/events.ts — append-only per-job event log (§23).
 *
 * One JSON object per line in jobs/<jobId>/events.jsonl. Used for debugging,
 * audit, future web/mobile UIs. NOT full event sourcing — job.json/attempt.json
 * remain the source of truth for state.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type EventType =
	| "job.created"
	| "job.ready"
	| "job.blocked"
	| "job.started"
	| "job.escalated"
	| "job.completed"
	| "job.failed"
	| "job.cancelled"
	| "job.interrupted"
	| "attempt.started"
	| "attempt.transport_retry"
	| "attempt.completed"
	| "attempt.failed"
	| "provider.requested"
	| "provider.completed"
	| "provider.error"
	| "artifact.created"
	| "validation.started"
	| "validation.completed"
	| "validation.failed"
	| "budget.checked"
	| "budget.exceeded";

export interface OrchestratorEvent {
	t: number; // epoch ms
	type: EventType;
	jobId: string;
	attemptId?: string;
	data?: Record<string, unknown>;
}

export class EventLog {
	constructor(private readonly jobsDir: string) {}

	private file(jobId: string): string {
		return path.join(this.jobsDir, jobId, "events.jsonl");
	}

	append(jobId: string, type: EventType, data?: Record<string, unknown>, attemptId?: string): void {
		const event: OrchestratorEvent = { t: Date.now(), type, jobId, attemptId, data };
		try {
			fs.mkdirSync(path.dirname(this.file(jobId)), { recursive: true });
			fs.appendFileSync(this.file(jobId), `${JSON.stringify(event)}\n`);
		} catch {
			/* never fail a job because of the audit log */
		}
	}

	read(jobId: string, limit = 200): OrchestratorEvent[] {
		try {
			const lines = fs.readFileSync(this.file(jobId), "utf-8").split("\n").filter(Boolean);
			return lines
				.slice(-limit)
				.map((l) => {
					try {
						return JSON.parse(l) as OrchestratorEvent;
					} catch {
						return null;
					}
				})
				.filter((e): e is OrchestratorEvent => e !== null);
		} catch {
			return [];
		}
	}
}
