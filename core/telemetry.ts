import * as path from "node:path";
import { atomicWriteJson, readJson } from "./storage.ts";
import type { UsageInfo } from "./types.ts";

export interface PlannerTelemetryRecord {
	schemaVersion: 1;
	runId: string;
	sessionId?: string;
	sessionPath?: string;
	provider: string;
	model: string;
	startedAt: number;
	completedAt: number;
	durationMs: number;
	usage: UsageInfo;
}

export interface PlannerMetrics {
	runs: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	wallTimeMs: number;
	byModel: Array<{
		provider: string;
		model: string;
		runs: number;
		promptTokens: number;
		completionTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		costUsd: number;
		wallTimeMs: number;
	}>;
}

export class PlannerTelemetryStore {
	readonly file: string;

	constructor(root: string) {
		this.file = path.join(root, "planner-metrics.json");
	}

	read(): PlannerTelemetryRecord[] {
		return readJson<PlannerTelemetryRecord[]>(this.file) ?? [];
	}

	append(record: PlannerTelemetryRecord): void {
		atomicWriteJson(this.file, [...this.read(), record]);
	}

	metrics(): PlannerMetrics {
		return aggregatePlannerMetrics(this.read());
	}
}

interface AssistantUsage {
	provider: string;
	model: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { total: number };
	};
}

export class PlannerTelemetryCollector {
	private active?: {
		runId: string;
		startedAt: number;
		provider: string;
		model: string;
		usage: UsageInfo;
	};
	private sequence = 0;

	constructor(
		private readonly store: PlannerTelemetryStore,
		private readonly now: () => number = Date.now,
	) {}

	start(provider: string, model: string): void {
		// agent_start can repeat for Pi's automatic retry/compaction cycle before
		// one agent_settled. Keep one accounting span and all finalized messages.
		if (this.active) return;
		const startedAt = this.now();
		this.active = {
			runId: `planner-${startedAt}-${++this.sequence}`,
			startedAt,
			provider,
			model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, turns: 0 },
		};
	}

	addAssistant(message: AssistantUsage): void {
		if (!this.active) return;
		this.active.provider = message.provider;
		this.active.model = message.model;
		this.active.usage.input += message.usage.input;
		this.active.usage.output += message.usage.output;
		this.active.usage.cacheRead += message.usage.cacheRead;
		this.active.usage.cacheWrite += message.usage.cacheWrite;
		this.active.usage.costUsd += message.usage.cost.total;
		this.active.usage.contextTokens = message.usage.totalTokens;
		this.active.usage.turns++;
	}

	finish(session?: { id?: string; path?: string }): PlannerTelemetryRecord | undefined {
		if (!this.active) return undefined;
		const completedAt = this.now();
		const record: PlannerTelemetryRecord = {
			schemaVersion: 1,
			runId: this.active.runId,
			provider: this.active.provider,
			model: this.active.model,
			startedAt: this.active.startedAt,
			completedAt,
			durationMs: Math.max(0, completedAt - this.active.startedAt),
			usage: { ...this.active.usage },
			...(session?.id ? { sessionId: session.id } : {}),
			...(session?.path ? { sessionPath: session.path } : {}),
		};
		this.active = undefined;
		this.store.append(record);
		return record;
	}
}

export function aggregatePlannerMetrics(records: PlannerTelemetryRecord[]): PlannerMetrics {
	const total: PlannerMetrics = {
		runs: 0,
		promptTokens: 0,
		completionTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		wallTimeMs: 0,
		byModel: [],
	};
	const models = new Map<string, PlannerMetrics["byModel"][number]>();
	for (const record of records) {
		total.runs++;
		total.promptTokens += record.usage.input;
		total.completionTokens += record.usage.output;
		total.cacheReadTokens += record.usage.cacheRead;
		total.cacheWriteTokens += record.usage.cacheWrite;
		total.costUsd += record.usage.costUsd;
		total.wallTimeMs += record.durationMs;
		const key = `${record.provider}/${record.model}`;
		let model = models.get(key);
		if (!model) {
			model = { provider: record.provider, model: record.model, runs: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, wallTimeMs: 0 };
			models.set(key, model);
		}
		model.runs++;
		model.promptTokens += record.usage.input;
		model.completionTokens += record.usage.output;
		model.cacheReadTokens += record.usage.cacheRead;
		model.cacheWriteTokens += record.usage.cacheWrite;
		model.costUsd += record.usage.costUsd;
		model.wallTimeMs += record.durationMs;
	}
	total.byModel = [...models.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
	return total;
}
