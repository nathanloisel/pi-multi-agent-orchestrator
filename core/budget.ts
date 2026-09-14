/**
 * core/budget.ts — spend/effort protection (§13).
 *
 * Provider-agnostic: works with API costs (OpenRouter today) and with pure
 * effort budgets (turns/tokens/time) which remain meaningful for local
 * inference where API cost is zero. Violations are machine-readable states,
 * never silent continuation. Daily spend is tracked in a small JSON ledger so
 * it survives orchestrator restarts.
 */

import * as path from "node:path";
import type { AttemptRecord, BudgetConfig, BudgetCheck, JobRecord } from "./types.ts";
import { atomicWriteJson, readJson } from "./storage.ts";

interface DailyLedger {
	[date: string]: number; // yyyy-mm-dd → usd spent
}

export class BudgetManager {
	private ledgerFile: string;

	constructor(orchestratorDir: string) {
		this.ledgerFile = path.join(orchestratorDir, "budget-ledger.json");
	}

	private ledger(): DailyLedger {
		return readJson<DailyLedger>(this.ledgerFile) ?? {};
	}

	recordSpend(usd: number, when = new Date()): void {
		if (!usd || usd <= 0) return;
		const ledger = this.ledger();
		const key = when.toISOString().slice(0, 10);
		ledger[key] = (ledger[key] ?? 0) + usd;
		atomicWriteJson(this.ledgerFile, ledger);
	}

	todaySpend(when = new Date()): number {
		return this.ledger()[when.toISOString().slice(0, 10)] ?? 0;
	}

	jobSpend(job: JobRecord, attempts: AttemptRecord[]): number {
		return attempts.reduce((sum, a) => sum + (a.usage?.costUsd ?? 0), 0);
	}

	/** Pre-flight check before starting a new attempt. */
	check(job: JobRecord, attempts: AttemptRecord[], limits: BudgetConfig | undefined, defaults?: BudgetConfig): BudgetCheck {
		const cfg: BudgetConfig = { ...defaults, ...job.budget, ...limits };
		const violations: string[] = [];
		const jobSpend = this.jobSpend(job, attempts);
		const todaySpend = this.todaySpend();

		if (cfg.perJobUsd !== undefined && jobSpend >= cfg.perJobUsd) violations.push(`perJobUsd:${cfg.perJobUsd}`);
		if (cfg.dailyUsd !== undefined && todaySpend >= cfg.dailyUsd) violations.push(`dailyUsd:${cfg.dailyUsd}`);
		// max attempts (explicit ceiling; the retry ladder is governed by job.retry)
		const maxAttempts = cfg.maxAttempts;
		if (maxAttempts !== undefined && attempts.length >= maxAttempts) violations.push(`maxAttempts:${maxAttempts}`);

		return { ok: violations.length === 0, violations };
	}

	/** Post-flight check on a completed attempt (turns/tokens/cost ceilings). */
	checkAttempt(attempt: AttemptRecord, limits: BudgetConfig | undefined, defaults?: BudgetConfig): BudgetCheck {
		const cfg: BudgetConfig = { ...defaults, ...limits };
		const violations: string[] = [];
		const u = attempt.usage;
		if (u) {
			if (cfg.perAttemptUsd !== undefined && u.costUsd >= cfg.perAttemptUsd) violations.push(`perAttemptUsd:${cfg.perAttemptUsd}`);
			if (cfg.maxTurns !== undefined && u.turns > cfg.maxTurns) violations.push(`maxTurns:${cfg.maxTurns}`);
			if (cfg.maxOutputTokens !== undefined && u.output > cfg.maxOutputTokens) violations.push(`maxOutputTokens:${cfg.maxOutputTokens}`);
		}
		if (cfg.timeoutSeconds !== undefined && (attempt.latencyMs ?? 0) > cfg.timeoutSeconds * 1000) {
			violations.push(`timeoutSeconds:${cfg.timeoutSeconds}`);
		}
		return { ok: violations.length === 0, violations };
	}
}
