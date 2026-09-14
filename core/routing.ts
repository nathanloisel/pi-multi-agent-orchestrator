/**
 * core/routing.ts — model routing independent from orchestration (§9, §20, §21, §22).
 *
 * Rule-based for V1. Rules speak ONLY in logical aliases; the ModelRegistry
 * resolves physical backends. Experiments are alias pairs (worker-cheap-a /
 * worker-cheap-b) in the registry — no experiment logic in agents or prompts.
 *
 * Default cheap-first escalation ladder (§16, §20):
 *   attempt 1: agent default (worker-cheap)
 *   attempt 2: worker-cheap, fresh context + deterministic failure feedback
 *   attempt 3: worker-best, fresh
 *   attempt 4: frontier, fresh
 */

export type { RoutingRule } from "./types.ts";
import type { AttemptRecord, JobRecord, ResolvedModel, RetryRung, RoutingRule } from "./types.ts";
import type { ModelRegistry } from "./models.ts";

export interface RoutingDecision {
	alias: string | undefined; // logical alias (undefined → agent/session default)
	resolved: ResolvedModel;
	strategy: "resume" | "fresh";
	reason: string;
	rule?: RoutingRule;
}

export interface RouterInputs {
	job: JobRecord;
	attemptNumber: number; // 1-based attempt about to run
	previousAttempts: AttemptRecord[];
	explicitModel?: string; // retry(delegate) override — always wins
	explicitStrategy?: "resume" | "fresh";
	agentDefaultModel?: string; // agent runtime.model (logical alias)
	fallbackConcrete?: { provider?: string; model?: string; effort?: string };
}

export class Router {
	constructor(
		private registry: ModelRegistry,
		private rules: RoutingRule[] = [],
	) {}

	setRules(rules: RoutingRule[]): void {
		this.rules = rules;
	}

	/** Decide the model for the next attempt of a job. */
	decide(input: RouterInputs): RoutingDecision {
		const { job, attemptNumber, previousAttempts, explicitModel, explicitStrategy } = input;
		const lastFailure = previousAttempts.length > 0 ? previousAttempts[previousAttempts.length - 1] : undefined;
		const lastExit = lastFailure?.exitReason;

		// 1. explicit override (jobs.retry model=..., delegate model=...)
		if (explicitModel) {
			const resolved = this.registry.resolve(explicitModel, { fallbackConcrete: input.fallbackConcrete });
			return {
				alias: resolved.alias,
				resolved,
				strategy: explicitStrategy ?? "fresh",
				reason: `explicit model override → ${explicitModel}`,
			};
		}

		// 2. follow-up/resume on a successful or still-open attempt keeps the model
		if (attemptNumber === previousAttempts.length + 1 && previousAttempts.length > 0 && explicitStrategy === "resume") {
			const prev = previousAttempts[previousAttempts.length - 1];
			const ref = prev.logicalModel && this.registry.has(prev.logicalModel) ? prev.logicalModel : prev.resolvedModel;
			const resolved = this.registry.resolve(ref, { fallbackConcrete: input.fallbackConcrete });
			return { alias: resolved.alias, resolved, strategy: "resume", reason: `resume attempt ${prev.attemptId}` };
		}

		// 3. configured rules (kind/tag/attempt/failure-trigger based)
		const trigger: "initial" | "validation_failed" | "any_failure" =
			attemptNumber === 1 ? "initial" : lastExit === "validation_failed" ? "validation_failed" : "any_failure";
		for (const rule of this.rules) {
			if (rule.kind && rule.kind !== job.kind) continue;
			if (rule.tag && !(job.tags ?? []).includes(rule.tag)) continue;
			if (rule.attempt !== undefined && rule.attempt !== attemptNumber) continue;
			if (rule.on && rule.on !== trigger) continue;
			const resolved = this.registry.resolve(rule.model, { fallbackConcrete: input.fallbackConcrete });
			return {
				alias: resolved.alias,
				resolved,
				strategy: attemptNumber === 1 ? "fresh" : "fresh", // rule-driven escalations always fresh (§20)
				reason: `routing rule (${JSON.stringify(rule)})`,
				rule,
			};
		}

		// 4. job retry ladder (per-job/agent configurable)
		const rung: RetryRung | undefined = job.retry.ladder[attemptNumber - 2]; // ladder covers attempts 2..N
		if (attemptNumber >= 2 && rung) {
			const ref = rung.model ?? this.previousAliasOrDefault(previousAttempts, input);
			const resolved = this.registry.resolve(ref, { fallbackConcrete: input.fallbackConcrete });
			return {
				alias: resolved.alias,
				resolved,
				strategy: rung.strategy,
				reason: `ladder rung ${attemptNumber - 1}${rung.model ? ` → ${rung.model}` : " (same model)"}`,
			};
		}

		// 5. default: agent's logical model (or registry default worker)
		const resolved = this.registry.resolve(input.agentDefaultModel, { fallbackConcrete: input.fallbackConcrete });
		return {
			alias: resolved.alias,
			resolved,
			strategy: explicitStrategy ?? "fresh",
			reason: attemptNumber === 1 ? "initial (agent default)" : "repeat (agent default)",
		};
	}

	private previousAliasOrDefault(previousAttempts: AttemptRecord[], input: RouterInputs): string | undefined {
		const prev = previousAttempts[previousAttempts.length - 1];
		if (prev?.logicalModel && this.registry.has(prev.logicalModel)) return prev.logicalModel;
		return input.agentDefaultModel;
	}
}

/**
 * Aggregate attempt history into per-role/per-model empirical metrics (§21).
 * Feeds future routing optimization and A/B comparison (§22) — collection
 * only; no learned router in V1.
 */
export interface ModelMetrics {
	agent: string;
	alias: string;
	concreteModel: string;
	provider: string;
	attempts: number;
	successes: number;
	failures: number;
	validationPassed: number;
	validationFailed: number;
	firstAttemptSuccesses: number;
	promptTokens: number;
	completionTokens: number;
	costUsd: number;
	wallTimeMs: number;
	transportErrors: number;
}

export function aggregateMetrics(attempts: AttemptRecord[], agentOfJob: (jobId: string) => string): ModelMetrics[] {
	const byKey = new Map<string, ModelMetrics>();
	for (const a of attempts) {
		if (a.status === "interrupted" || a.exitReason === "transport_error") {
			// transport failures don't judge the model's task capability (§29)
			const k0 = `${agentOfJob(a.jobId)}|${a.logicalModel ?? "?"}`;
			const m0 = ensure(byKey, k0, a, agentOfJob);
			m0.transportErrors++;
			if (a.status === "interrupted") continue;
		}
		if (!a.logicalModel || a.status === "running") continue;
		const key = `${agentOfJob(a.jobId)}|${a.logicalModel}`;
		const m = ensure(byKey, key, a, agentOfJob);
		m.attempts++;
		if (a.status === "success") m.successes++;
		if (a.status === "failed") m.failures++;
		if (a.validation?.status === "passed") m.validationPassed++;
		if (a.validation?.status === "failed") m.validationFailed++;
		if (a.attemptId === "attempt-001" && a.status === "success") m.firstAttemptSuccesses++;
		m.promptTokens += a.usage?.input ?? 0;
		m.completionTokens += a.usage?.output ?? 0;
		m.costUsd += a.usage?.costUsd ?? 0;
		m.wallTimeMs += a.latencyMs ?? 0;
	}
	return [...byKey.values()];
}

function ensure(map: Map<string, ModelMetrics>, key: string, a: AttemptRecord, agentOfJob: (jobId: string) => string): ModelMetrics {
	let m = map.get(key);
	if (!m) {
		m = {
			agent: agentOfJob(a.jobId),
			alias: a.logicalModel ?? "?",
			concreteModel: a.resolvedModel ?? "?",
			provider: a.provider ?? "?",
			attempts: 0,
			successes: 0,
			failures: 0,
			validationPassed: 0,
			validationFailed: 0,
			firstAttemptSuccesses: 0,
			promptTokens: 0,
			completionTokens: 0,
			costUsd: 0,
			wallTimeMs: 0,
			transportErrors: 0,
		};
		map.set(key, m);
	}
	return m;
}
