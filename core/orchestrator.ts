/**
 * core/orchestrator.ts — the orchestration runtime (§5, §6, §11, §16, §24, §28, §29).
 *
 * UI-independent primitives (future web/mobile/CI reuse the same surface):
 *   createJob, listJobs, readJob, readAttempt, runJob, runGraph, followupJob,
 *   retryJob, cancelJob, readArtifact, graph, waitJobs, events
 *
 * Job = persistent objective. Attempt = one execution (agent/model/session/
 * workspace/validation). Retries: resume (same session) vs fresh (new context
 * pack with selected failure feedback). Escalation via the retry ladder +
 * router; transport errors retry without consuming task-ladder rungs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AgentsViewExporter } from "./agentsview.ts";
import { BudgetManager } from "./budget.ts";
import { ConcurrencyManager } from "./concurrency.ts";
import { EventLog, type EventType } from "./events.ts";
import { OrchestratorError } from "./errors.ts";
import { ModelRegistry, type LaunchConfig } from "./models.ts";
import { renderEnvelope, type EnvelopeInput } from "./prompts.ts";
import { extractResult, persistAttemptResult, renderReportMd, resultSummaryForOrchestrator } from "./result.ts";
import { Router, type RoutingDecision } from "./routing.ts";
import { runWorker, type SpawnOutcome, type SpawnRequest } from "./spawn.ts";
import { atomicWriteJson, atomicWriteText, JobStore, readJson, statusIsTerminal } from "./storage.ts";
import { buildContextPack, type BuildContextOpts } from "./context.ts";
import { runValidation, validationFeedback } from "./validation.ts";
import { captureDiffArtifact, cleanupWorkspace, createWorkspace } from "./workspace.ts";
import { aggregateMetrics, type ModelMetrics } from "./routing.ts";
import { PlannerTelemetryStore, type PlannerMetrics } from "./telemetry.ts";
import {
	DEFAULT_RETRY,
	type AgentConfig,
	type AttemptRecord,
	type ContextPack,
	type JobRecord,
	type JobResult,
	type JobStatus,
	type ResolvedModel,
	type RetrySpec,
	type UsageInfo,
	type ValidationOutcome,
} from "./types.ts";

export interface OrchestratorConfig {
	root: string; // ~/.pi/orchestrator
	agentsRoot: string;
	workerExtensionPath: string;
	registry: ModelRegistry;
	router: Router;
	concurrency: ConcurrencyManager;
	budgets: BudgetManager;
	events: EventLog;
	store: JobStore;
	defaults: {
		model?: { provider?: string; model?: string; effort?: string }; // inherited from main session
		budget?: { perAttemptUsd?: number; perJobUsd?: number; dailyUsd?: number };
		concurrency: { global: number; byModel: Record<string, number> };
	};
	/** Worker execution seam — tests inject a fake runner; default spawns pi. */
	workerRunner?: (req: SpawnRequest) => Promise<SpawnOutcome>;
	agentsViewExporter?: AgentsViewExporter;
	plannerTelemetry?: PlannerTelemetryStore;
}

export interface CreateJobInput {
	agent: string;
	task: string;
	context?: Partial<ContextPack>;
	constraints?: string[];
	kind?: string;
	dependsOn?: string[];
	cwd?: string;
	jobId?: string;
	retry?: Partial<RetrySpec>;
	priority?: number;
	tags?: string[];
	model?: string; // explicit logical alias override for attempt 1
	autoRun?: boolean; // default true
	signal?: AbortSignal;
}

export interface RunReport {
	jobId: string;
	status: JobStatus;
	attempts: AttemptRecord[];
	latestResult?: JobResult;
	summaryForOrchestrator: string;
}

export class Orchestrator {
	readonly store: JobStore;
	readonly events: EventLog;
	private cancels = new Map<string, AbortController>();

	constructor(public config: OrchestratorConfig) {
		this.store = config.store;
		this.events = config.events;
		this.store.setRecoveryHandler((job, attempt) => {
			this.events.append(job.jobId, "job.interrupted", { reason: "orchestrator_process_terminated" }, attempt.attemptId);
			this.config.agentsViewExporter?.export(job, attempt);
		});
	}

	/** UI-independent metrics snapshot. Existing worker metrics retain their shape. */
	metrics(): { workers: ModelMetrics[]; planner: PlannerMetrics } {
		const jobs = this.listJobs();
		const agentOf = new Map(jobs.map((job) => [job.jobId, job.agent]));
		return {
			workers: aggregateMetrics(jobs.flatMap((job) => this.store.listAttempts(job.jobId)), (id) => agentOf.get(id) ?? "?"),
			planner: this.config.plannerTelemetry?.metrics() ?? {
				runs: 0,
				promptTokens: 0,
				completionTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
				wallTimeMs: 0,
				byModel: [],
			},
		};
	}

	/** AgentsView backfill: export attempts that predate exporter activation
	 * (e.g. the bridge was enabled after jobs already ran). Safe + idempotent —
	 * the exporter replaces existing job/attempt manifest entries. */
	backfillAgentsView(): number {
		const exporter = this.config.agentsViewExporter;
		if (!exporter) return 0;
		let exported = 0;
		for (const job of this.store.listJobs()) {
			for (const attempt of this.store.listAttempts(job.jobId)) {
				if (exporter.export(job, attempt)) exported++;
			}
		}
		return exported;
	}

	private agentByName(agents: AgentConfig[], name: string): AgentConfig {
		const agent = agents.find((a) => a.name === name && a.role === "sub");
		if (!agent) throw new OrchestratorError("unknown", `Unknown sub agent "${name}"`, { available: agents.filter((a) => a.role === "sub").map((a) => a.name) });
		return agent;
	}

	// ── Job lifecycle ────────────────────────────────────────────────────────

	createJob(input: CreateJobInput, agents: AgentConfig[]): JobRecord {
		const agent = this.agentByName(agents, input.agent);
		const store = this.store;
		const jobId = input.jobId && !store.readJob(input.jobId) ? input.jobId : store.newJobId(agent.name, input.task);
		if (store.readJob(jobId)) throw new OrchestratorError("unknown", `Job ${jobId} already exists`);
		store.createJobDir(jobId);
		const retry: RetrySpec = { ...DEFAULT_RETRY, ...agent.retry, ...(input.retry ?? {}) };
		const job: JobRecord = {
			schemaVersion: 1,
			jobId,
			objective: input.task,
			agent: agent.name,
			dependsOn: input.dependsOn ?? [],
			status: (input.dependsOn?.length ?? 0) > 0 ? "blocked" : "queued",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			cwd: input.cwd ?? process.cwd(),
			kind: input.kind,
			retry,
			attemptCount: 0,
			budget: { ...this.config.defaults.budget, ...agent.budget },
			priority: input.priority,
			tags: input.tags,
			initialModel: input.model,
		};
		store.writeJob(job);
		atomicWriteText(path.join(store.jobDir(jobId), "task.md"), `# Job ${jobId}\nagent: ${agent.name}\n\n${input.task}\n`);
		if (input.context) atomicWriteJson(path.join(store.jobDir(jobId), "context.json"), input.context);
		this.events.append(jobId, "job.created", { agent: agent.name, dependsOn: job.dependsOn, kind: job.kind });
		return job;
	}

	listJobs(): JobRecord[] {
		return this.store.listJobs();
	}

	readJob(jobId: string): JobRecord | null {
		const job = this.store.readJob(jobId);
		return job ? this.store.recoverInterrupted(job) : null;
	}

	readAttempt(jobId: string, attemptId: string): AttemptRecord | null {
		return this.store.readAttempt(jobId, attemptId);
	}

	readResult(jobId: string): JobResult | null {
		return readJson<JobResult>(path.join(this.store.jobDir(jobId), "result.json"));
	}

	readArtifact(jobId: string, relPath: string, attemptId?: string): { path: string; content: string } | null {
		const base = attemptId ? this.store.attemptArtifactsDir(jobId, attemptId) : this.store.jobArtifactsDir(jobId);
		const resolved = this.store.resolveArtifact(base, relPath);
		if (!resolved) {
			// fall back to attempt artifacts when job-level lookup misses
			if (!attemptId) {
				for (const a of this.store.listAttempts(jobId).reverse()) {
					const r = this.store.resolveArtifact(this.store.attemptArtifactsDir(jobId, a.attemptId), relPath);
					if (r) return { path: r, content: fs.readFileSync(r, "utf-8") };
				}
			}
			return null;
		}
		return { path: resolved, content: fs.readFileSync(resolved, "utf-8") };
	}

	/** Dependency graph + computed states (§11). Self-healing: persists
	 * dependency-failure propagation so stored state always converges. */
	graph(): { nodes: { jobId: string; agent: string; status: JobStatus; effectiveStatus: JobStatus; dependsOn: string[]; summary?: string }[]; edges: { from: string; to: string }[]; cycles: string[][] } {
		const jobs = this.store.listJobs().filter((j) => !statusIsTerminal(j.status) || Date.now() - j.updatedAt < 7 * 24 * 3600 * 1000);
		const byId = new Map(jobs.map((j) => [j.jobId, j]));
		const cycles = detectCycles(jobs);
		for (const j of jobs) {
			if (statusIsTerminal(j.status) || j.status === "running") continue;
			const eff = effectiveStatus(j, byId);
			if (eff === "failed" && j.status !== "failed") {
				j.status = "failed";
				j.lastBlockers = [...(j.lastBlockers ?? []), `dependency failed: ${j.dependsOn.join(", ")}`];
				j.completedAt = Date.now();
				this.store.writeJob(j);
				byId.set(j.jobId, j);
				this.events.append(j.jobId, "job.failed", { reason: "dependency_failed" });
			} else if (eff === "ready" && j.status === "blocked") {
				j.status = "ready";
				this.store.writeJob(j);
				byId.set(j.jobId, j);
				this.events.append(j.jobId, "job.ready");
			}
		}
		const nodes = jobs.map((j) => ({
			jobId: j.jobId,
			agent: j.agent,
			status: j.status,
			effectiveStatus: effectiveStatus(j, byId),
			dependsOn: j.dependsOn,
			summary: j.lastSummary,
		}));
		const edges: { from: string; to: string }[] = [];
		for (const j of jobs) for (const dep of j.dependsOn) edges.push({ from: dep, to: j.jobId });
		return { nodes, edges, cycles };
	}

	cancelJob(jobId: string): boolean {
		const controller = this.cancels.get(jobId);
		if (controller) controller.abort();
		const job = this.store.readJob(jobId);
		if (!job || statusIsTerminal(job.status)) return false;
		job.status = "cancelled";
		job.completedAt = Date.now();
		this.store.writeJob(job);
		this.events.append(jobId, "job.cancelled");
		return true;
	}

	// ── Running ──────────────────────────────────────────────────────────────

	/** Follow-up: resume the job's latest attempt session (cheapest channel). */
	async followupJob(jobId: string, message: string, agents: AgentConfig[], signal?: AbortSignal): Promise<RunReport> {
		const job = this.requireJob(jobId);
		const lastAttempt = job.latestAttemptId ? this.store.readAttempt(jobId, job.latestAttemptId) : null;
		if (!lastAttempt) throw new OrchestratorError("unknown", `Job ${jobId} has no attempts to follow up`);
		const agent = this.agentByName(agents, job.agent);
		const release = await this.config.concurrency.acquire(lastAttempt.logicalModel, signal);
		try {
			return await this.runAttemptGated(job, agent, {
				alias: lastAttempt.logicalModel,
				resolved: this.config.registry.resolve(
					lastAttempt.logicalModel && this.config.registry.has(lastAttempt.logicalModel) ? lastAttempt.logicalModel : lastAttempt.resolvedModel,
					{ fallbackConcrete: this.config.defaults.model },
				),
				strategy: "resume",
				reason: `follow-up on ${lastAttempt.attemptId}`,
			}, this.store.listAttempts(jobId).length, this.store.listAttempts(jobId), {
				resumeAttempt: lastAttempt,
				taskOverride: message,
				signal,
			});
		} finally {
			release();
		}
	}

	/** Explicit retry (§6): resume | fresh, optional model alias escalation. */
	async retryJob(
		jobId: string,
		agents: AgentConfig[],
		opts: { strategy?: "resume" | "fresh"; model?: string; reason?: string; signal?: AbortSignal } = {},
	): Promise<RunReport> {
		const job = this.requireJob(jobId);
		if (job.status === "running") throw new OrchestratorError("unknown", `Job ${jobId} is running; cancel or wait first`);
		job.status = "ready";
		this.store.writeJob(job);
		return this.runJobInternal(job, agents, {
			explicitModel: opts.model,
			explicitStrategy: opts.strategy,
			escalationReason: opts.reason ?? "manual retry",
			signal: opts.signal,
			// A manual retry gets its own small run budget; ladder position still
			// escalates because attempt numbering continues from history.
			maxAttemptsThisRun: opts.strategy === "resume" ? 1 : Math.min(2, job.retry.maxAttempts),
		});
	}

	/** Create (optionally) and run a job through its full ladder. */
	async runJob(input: CreateJobInput | JobRecord, agents: AgentConfig[], signal?: AbortSignal): Promise<RunReport> {
		const isRecord = typeof (input as JobRecord).schemaVersion === "number";
		const job = isRecord ? (input as JobRecord) : this.createJob(input as CreateJobInput, agents);
		return this.runJobInternal(job, agents, { signal });
	}

	/**
	 * DAG execution (§11): run all non-terminal jobs whose dependencies are
	 * satisfied; independent jobs execute concurrently under the concurrency
	 * gates. Failed/cancelled dependencies propagate "failed" downstream.
	 *
	 * onJobUpdate fires once per job as it settles — even inside a parallel
	 * batch — so callers can stream partial tool results. Observer exceptions
	 * are isolated and never affect job outcomes.
	 */
	async runGraph(agents: AgentConfig[], opts: { signal?: AbortSignal; jobIds?: string[]; onJobUpdate?: (report: RunReport) => void } = {}): Promise<RunReport[]> {
		const reports: RunReport[] = [];
		for (;;) {
			const jobs = this.store.listJobs().map((j) => this.store.recoverInterrupted(j));
			const byId = new Map(jobs.map((j) => [j.jobId, j]));
			let scope: Set<string> | null = null;
			if (opts.jobIds) {
				// Expand scope transitively: non-terminal dependencies (upstream, so
				// the subgraph can progress) and non-terminal dependents (downstream,
				// so unblocked jobs in the requested batch actually run).
				scope = new Set(opts.jobIds);
				let added = true;
				while (added) {
					added = false;
					for (const j of jobs) {
						if (statusIsTerminal(j.status)) continue;
						// upstream: pull in dependencies of scoped jobs
						if (scope.has(j.jobId)) {
							for (const dep of j.dependsOn) {
								const d = byId.get(dep);
								if (d && !scope.has(dep) && !statusIsTerminal(d.status)) {
									scope.add(dep);
									added = true;
								}
							}
						}
						// downstream: pull in jobs that depend on scoped jobs
						if (!scope.has(j.jobId) && j.dependsOn.some((d) => scope!.has(d))) {
							scope.add(j.jobId);
							added = true;
						}
					}
				}
			}
			const runnable = jobs.filter((j) => {
				// Scoped runs execute only the requested subgraph + transitively
				// pulled-in dependencies; unscoped runs execute everything ready.
				if (scope && !scope.has(j.jobId)) return false;
				if (statusIsTerminal(j.status) || j.status === "running" || j.status === "interrupted") return false;
				return effectiveStatus(j, byId) === "ready";
			});

			// mark blocked-with-failed-deps as failed (propagation) — runs even on
			// the final pass so persisted state converges (matches graph() self-
			// healing) and dependency-gated failures reach progress observers.
			const propagated: JobRecord[] = [];
			for (const j of jobs) {
				if (statusIsTerminal(j.status)) continue;
				const depFailed = j.dependsOn.some((d) => {
					const dep = byId.get(d);
					return dep && (dep.status === "failed" || dep.status === "cancelled");
				});
				if (depFailed && j.status !== "failed") {
					j.status = "failed";
					j.lastBlockers = [`dependency failed: ${j.dependsOn.filter((d) => byId.get(d)?.status === "failed" || byId.get(d)?.status === "cancelled").join(", ")}`];
					j.completedAt = Date.now();
					this.store.writeJob(j);
					byId.set(j.jobId, j); // propagate transitively within this pass
					propagated.push(j);
					this.events.append(j.jobId, "job.failed", { reason: "dependency_failed" });
				}
			}
			// dependency-gated failures never execute an attempt, but they ARE
			// transitions: report them so partial results stay truthful.
			if (opts.onJobUpdate) {
				for (const j of propagated) {
					try {
						opts.onJobUpdate(this.derivedReport(j));
					} catch {
						/* progress observers must never affect job outcomes */
					}
				}
			}
			if (runnable.length === 0) {
				// nothing to execute; loop only if propagation changed state so its
				// own downstream effects are resolved (then terminate)
				if (propagated.length === 0) break;
				continue;
			}

			const batch = await Promise.allSettled(
				runnable.map(async (job) => {
					const controller = new AbortController();
					this.cancels.set(job.jobId, controller);
					const combined = combineSignals(controller.signal, opts.signal);
					try {
						const report = await this.runJobInternal(job, agents, { signal: combined });
						if (opts.onJobUpdate) {
							try {
								opts.onJobUpdate(report);
							} catch {
								/* progress observers must never affect job outcomes */
							}
						}
						return report;
					} finally {
						this.cancels.delete(job.jobId);
					}
				}),
			);
			for (const r of batch) {
				if (r.status === "fulfilled") reports.push(r.value);
			}
		}
		return reports;
	}

	/** Poll persisted job state until every id is terminal (or timeout). If
	 * onPoll is given it fires on every STATUS CHANGE (including once upfront)
	 * so callers can stream progress; observer exceptions are isolated. */
	async waitJobs(jobIds: string[], timeoutMs = 300000, signal?: AbortSignal, onPoll?: (jobs: JobRecord[]) => void): Promise<JobRecord[]> {
		const deadline = Date.now() + timeoutMs;
		let lastSig = "";
		for (;;) {
			const jobs = jobIds.map((id) => this.readJob(id)).filter((j): j is JobRecord => Boolean(j));
			if (onPoll) {
				const sig = jobs.map((j) => `${j.jobId}:${j.status}`).join(",");
				if (sig !== lastSig) {
					lastSig = sig;
					try {
						onPoll(jobs);
					} catch {
						/* progress observers must never affect waiting */
					}
				}
			}
			if (jobs.every((j) => statusIsTerminal(j.status) || j.status === "interrupted" || j.status === "waiting")) return jobs;
			if (Date.now() > deadline) return jobs;
			await sleep(500, signal);
		}
	}

	// ── Internals ────────────────────────────────────────────────────────────

	/** A RunReport derived purely from persisted state (no attempt executed) —
	 * used to report dependency-gated transitions to progress observers. */
	private derivedReport(job: JobRecord): RunReport {
		return {
			jobId: job.jobId,
			status: job.status,
			attempts: this.store.listAttempts(job.jobId),
			summaryForOrchestrator: `job: ${job.jobId}\njobStatus: ${job.status}\n${(job.lastBlockers ?? []).join("; ")}`.trimEnd(),
		};
	}

	private requireJob(jobId: string): JobRecord {
		const job = this.readJob(jobId);
		if (!job) throw new OrchestratorError("unknown", `Unknown job ${jobId}`);
		return job;
	}

	/** Full ladder loop: attempts until success / exhaustion / budget / cancel. */
	private async runJobInternal(
		job: JobRecord,
		agents: AgentConfig[],
		opts: { explicitModel?: string; explicitStrategy?: "resume" | "fresh"; escalationReason?: string; signal?: AbortSignal; maxAttemptsThisRun?: number } = {},
	): Promise<RunReport> {
		const agent = this.agentByName(agents, job.agent);
		const attemptsSoFar = this.store.listAttempts(job.jobId);
		// Automatic runs are capped by the job's lifetime maxAttempts; explicit
		// manual retries get their own bounded run budget (the caller decides).
		const hardCap = opts.maxAttemptsThisRun ? Number.POSITIVE_INFINITY : job.retry.maxAttempts;
		const runCap = opts.maxAttemptsThisRun ? attemptsSoFar.length + opts.maxAttemptsThisRun : job.retry.maxAttempts;
		let report: RunReport | undefined;
		let attemptNumber = attemptsSoFar.length;

		for (;;) {
			if (opts.signal?.aborted) break;
			// exhaustion is decided on ACTUAL attempt count, before spending more
			if (this.store.listAttempts(job.jobId).length >= runCap || this.store.listAttempts(job.jobId).length >= hardCap) {
				this.failJob(job, "retry ladder exhausted");
				break;
			}
			attemptNumber++;
			const budgetCheck = this.config.budgets.check(job, this.store.listAttempts(job.jobId), agent.budget, this.config.defaults.budget);
			if (!budgetCheck.ok) {
				this.events.append(job.jobId, "budget.exceeded", { violations: budgetCheck.violations });
				job.status = "failed";
				job.lastBlockers = [`budget exceeded: ${budgetCheck.violations.join(", ")}`];
				job.completedAt = Date.now();
				this.store.writeJob(job);
				this.events.append(job.jobId, "job.failed", { reason: "budget", violations: budgetCheck.violations });
				break;
			}

			report = await this.executeAttempt(job, agents, {
				attemptNumber,
				explicitModel:
					attemptNumber === attemptsSoFar.length + 1
						? (opts.explicitModel ?? (attemptsSoFar.length === 0 ? job.initialModel : undefined))
						: undefined,
				explicitStrategy: attemptNumber === (attemptsSoFar.length + 1) ? opts.explicitStrategy : undefined,
				escalationReason: opts.escalationReason,
				manual: opts.maxAttemptsThisRun !== undefined,
				signal: opts.signal,
			});

			const last = report.attempts[report.attempts.length - 1];
			if (report.status === "success") break;
			if (last?.exitReason === "aborted") {
				this.failJob(job, "aborted");
				break;
			}
			if (last?.exitReason === "budget_exceeded") {
				this.failJob(job, `budget exceeded`);
				break;
			}
			// Transport retries are exhausted inside executeAttempt. Fail explicitly
			// without creating another task attempt or consuming an escalation rung.
			if (last?.exitReason === "transport_error") {
				job.status = "failed";
				job.completedAt = Date.now();
				job.lastBlockers = [`transport error: ${last.error ?? "provider unavailable"}`];
				this.store.writeJob(job);
				this.events.append(job.jobId, "job.failed", { reason: "transport_unavailable", error: last.error });
				break;
			}
			// otherwise loop: next attempt uses ladder/router escalation
		}

		const attempts = this.store.listAttempts(job.jobId);
		const fresh = this.readJob(job.jobId) ?? job;
		const latest = fresh.latestAttemptId ? readJson<JobResult>(path.join(this.store.attemptDir(job.jobId, fresh.latestAttemptId), "result.json")) : undefined;
		return {
			jobId: job.jobId,
			status: fresh.status,
			attempts,
			latestResult: latest ?? report?.latestResult,
			summaryForOrchestrator: report?.summaryForOrchestrator ?? fresh.lastSummary ?? "",
		};
	}

	/** Execute ONE attempt: route → gate → workspace → context → spawn → validate → persist. */
	private async executeAttempt(
		job: JobRecord,
		agents: AgentConfig[],
		opts: {
			attemptNumber?: number;
			strategy?: "resume" | "fresh";
			resumeAttempt?: AttemptRecord;
			taskOverride?: string;
			explicitModel?: string;
			explicitStrategy?: "resume" | "fresh";
			escalationReason?: string;
			manual?: boolean;
			signal?: AbortSignal;
		},
	): Promise<RunReport> {
		const agent = this.agentByName(agents, job.agent);
		const previousAttempts = this.store.listAttempts(job.jobId);
		const attemptNumber = opts.attemptNumber ?? previousAttempts.length + 1;

		// ── routing (§9) — aliases only; registry resolves backends
		let decision: RoutingDecision;
		if (opts.resumeAttempt) {
			const prev = opts.resumeAttempt;
			const ref = prev.logicalModel && this.config.registry.has(prev.logicalModel) ? prev.logicalModel : prev.resolvedModel;
			const resolved = this.config.registry.resolve(ref, { fallbackConcrete: this.config.defaults.model });
			decision = { alias: resolved.alias, resolved, strategy: "resume", reason: `follow-up on ${prev.attemptId}` };
		} else {
			decision = this.config.router.decide({
				job,
				attemptNumber,
				previousAttempts,
				explicitModel: opts.explicitModel,
				explicitStrategy: opts.explicitStrategy ?? opts.strategy,
				agentDefaultModel: agent.runtime.model ?? (agent.runtime.provider ? `${agent.runtime.provider}/${agent.runtime.model ?? ""}` : undefined),
				fallbackConcrete: this.config.defaults.model,
			});
		}
		if (attemptNumber > 1 && decision.resolved.alias !== previousAttempts[previousAttempts.length - 1]?.logicalModel) {
			this.events.append(job.jobId, "job.escalated", { to: decision.resolved.alias, reason: decision.reason });
		}

		// ── concurrency gate (§12)
		const release = await this.config.concurrency.acquire(decision.alias, opts.signal);
		try {
			return await this.runAttemptGated(job, agent, decision, attemptNumber, previousAttempts, opts);
		} finally {
			release();
		}
	}

	private async runAttemptGated(
		job: JobRecord,
		agent: AgentConfig,
		decision: RoutingDecision,
		attemptNumber: number,
		previousAttempts: AttemptRecord[],
		opts: { resumeAttempt?: AttemptRecord; taskOverride?: string; escalationReason?: string; manual?: boolean; signal?: AbortSignal },
	): Promise<RunReport> {
		const store = this.store;
		const isResume = decision.strategy === "resume" && (opts.resumeAttempt ?? previousAttempts[previousAttempts.length - 1]);
		const resumeOf = opts.resumeAttempt ?? (isResume ? previousAttempts[previousAttempts.length - 1] : undefined);

		// Follow-ups reuse the SAME attempt dir/session (that's what makes them cheap).
		const attemptId = resumeOf && decision.strategy === "resume" ? resumeOf.attemptId : store.allocateAttempt(job.jobId);
		const attemptDir = store.attemptDir(job.jobId, attemptId);
		const sessionDir = store.sessionDir(job.jobId, attemptId);
		const artifactsDir = store.attemptArtifactsDir(job.jobId, attemptId);

		const attempt: AttemptRecord = resumeOf && attemptId === resumeOf.attemptId
			? { ...resumeOf, status: "running", retryMode: "resume", startedAt: Date.now(), completedAt: undefined, exitReason: undefined }
			: {
					schemaVersion: 1,
					attemptId,
					jobId: job.jobId,
					agent: agent.name,
					parentAttemptId: previousAttempts[previousAttempts.length - 1]?.attemptId,
					logicalModel: decision.alias,
					resolvedModel: `${decision.resolved.concrete.provider}/${decision.resolved.concrete.model}`,
					provider: decision.resolved.concrete.provider,
					effort: decision.resolved.concrete.effort ?? agent.runtime.effort,
					retryMode: attemptNumber === 1 ? "initial" : decision.strategy === "resume" ? "resume" : "fresh",
					escalationReason: opts.escalationReason ?? (attemptNumber > 1 ? decision.reason : undefined),
					status: "running",
					startedAt: Date.now(),
				};
		attempt.sessionDir = sessionDir;
		attempt.ownerPid = process.pid;
		store.writeAttempt(attempt);
		job.latestAttemptId = attemptId;
		job.attemptCount = store.listAttempts(job.jobId).length;
		job.status = "running";
		job.startedAt = job.startedAt ?? Date.now();
		store.writeJob(job);
		this.events.append(job.jobId, "attempt.started", { agent: agent.name, model: decision.alias, resolved: attempt.resolvedModel, strategy: decision.strategy, reason: decision.reason }, attemptId);
		this.config.agentsViewExporter?.export(job, attempt);

		// ── workspace (§14)
		let workspace = attempt.workspace;
		if (!workspace) {
			workspace = createWorkspace({ strategy: agent.workspace.strategy, jobId: job.jobId, cwd: job.cwd });
			attempt.workspace = workspace;
			store.writeAttempt(attempt);
		}

		// ── context pack + envelope (§18, §19)
		const storedPack = readJson<Partial<ContextPack>>(path.join(store.jobDir(job.jobId), "context.json"));
		const lastFailed = previousAttempts.filter((a) => a.status === "failed").pop();
		const lastResult = lastFailed ? readJson<JobResult>(path.join(store.attemptDir(job.jobId, lastFailed.attemptId), "result.json")) : null;
		const packInput: Partial<ContextPack> = { ...(storedPack ?? {}) };
		if (decision.strategy === "fresh" && lastResult) {
			packInput.previousFailure = {
				attemptId: lastFailed!.attemptId,
				summary: lastResult.summary || lastResult.blockers.join("; ") || "previous attempt failed",
				validation: lastResult.validation,
				selectedArtifacts: lastResult.artifacts.map((a) => a.path).slice(0, 5),
			};
		}
		const built = buildContextPack({
			objective: job.objective,
			context: packInput,
			agentContext: agent.context,
			workspaceDir: workspace.path,
		} as BuildContextOpts);
		if (!resumeOf) atomicWriteJson(path.join(attemptDir, "context.json"), built.pack);

		const envelope = renderEnvelope({
			jobId: job.jobId,
			attemptId,
			agent,
			task: opts.taskOverride ?? job.objective,
			pack: built.pack,
			inlinedFiles: built.inlinedFiles,
			workspaceDir: workspace.path,
			attemptDir,
			artifactsDir,
			validationCommands: agent.validation.commands ?? [],
			isFollowUp: Boolean(resumeOf),
			resultPath: path.join(attemptDir, "result.json"),
		} satisfies EnvelopeInput);
		if (!resumeOf) atomicWriteText(path.join(store.jobDir(job.jobId), "task.md"), envelope);

		// ── spawn (with transport-level retries, §29)
		const launch: LaunchConfig = this.config.registry.toLaunchConfig(decision.resolved, agent.runtime.effort);
		const maxTransportRetries = attemptNumber === 1 ? 2 : job.retry.ladder[attemptNumber - 2]?.maxTransportRetries ?? 1;
		let outcome: SpawnOutcome | undefined;
		// Aggregate usage across ALL provider legs of this invocation (transport
		// retries included); contextTokens keeps the max high-water mark so a final
		// zero-usage leg can never erase earlier spend.
		const legUsage: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, turns: 0 };
		for (let t = 0; ; t++) {
			this.events.append(job.jobId, "provider.requested", { provider: decision.resolved.concrete.provider, model: decision.resolved.concrete.model }, attemptId);
			const spawnReq = {
				agent,
				resolved: decision.resolved,
				prompt: envelope,
				cwd: workspace.path,
				jobId: job.jobId,
				attemptId,
				attemptDir,
				sessionDir,
				sessionId: `${job.jobId}-${attemptId}`,
				workerExtensionPath: this.config.workerExtensionPath,
				timeoutSeconds: agent.limits.timeoutSeconds ?? 1800,
				signal: opts.signal,
				launchArgs: launch.args,
				launchEnv: launch.env,
			};
			outcome = this.config.workerRunner
				? await this.config.workerRunner(spawnReq)
				: await runWorker(spawnReq);
			accumulateUsage(legUsage, outcome.usage);
			this.events.append(job.jobId, "provider.completed", { exitCode: outcome.exitCode, turns: outcome.usage.turns, costUsd: outcome.usage.costUsd }, attemptId);
			if (outcome.runError?.isTransport && t < maxTransportRetries && !opts.signal?.aborted) {
				this.events.append(job.jobId, "attempt.transport_retry", { n: t + 1, kind: outcome.runError.kind, message: outcome.runError.message }, attemptId);
				attempt.transportRetries = t + 1;
				store.writeAttempt(attempt);
				await sleep(1000 * 2 ** t, opts.signal);
				continue;
			}
			break;
		}

		// ── result extraction + deterministic validation (§4, §15)
		const extracted = extractResult({ attemptDir, finalText: outcome.finalText, jobId: job.jobId, attemptId });
		// Canonical status precedence (§4): a terminal runError is authoritative.
		// If the transport-retry loop ENDED with a run failure, a worker-written
		// success result must never surface as canonical success. Findings/changes/
		// artifacts are preserved; a concise blocker records the cause. Intermediate
		// transport failures that later recover never reach this point.
		if (outcome.runError) {
			extracted.result.status = "failure";
			extracted.result.validation = { ...extracted.result.validation, status: "error" };
			const blocker = `run failed (${outcome.runError.kind}): ${outcome.runError.message}`.slice(0, 300);
			if (!extracted.result.blockers.includes(blocker)) extracted.result.blockers.push(blocker);
		}
		let validation: ValidationOutcome | undefined;
		if (!outcome.runError && (agent.validation.commands?.length ?? 0) > 0 && extracted.result.status !== "blocked") {
			this.events.append(job.jobId, "validation.started", { commands: agent.validation.commands }, attemptId);
			validation = await runValidation({
				commands: agent.validation.commands!,
				cwd: workspace.path,
				validationDir: store.validationDir(job.jobId, attemptId),
				timeoutSeconds: agent.validation.timeoutSeconds,
				signal: opts.signal,
			});
			this.events.append(job.jobId, validation.status === "passed" ? "validation.completed" : "validation.failed", { status: validation.status }, attemptId);
			// Deterministic checks override worker self-report; a worker claiming
			// success while validation fails is a failed attempt (§16).
			if (validation.status === "failed" && extracted.result.status === "success") {
				extracted.result.status = "failure";
				extracted.result.blockers.push("host-side validation failed despite worker-reported success");
			}
		}
		const result = persistAttemptResult(attemptDir, extracted, validation);

		// promote attempt artifacts (+ diff) to job level manifest
		if (workspace.strategy === "git-worktree") captureDiffArtifact(workspace, artifactsDir);
		const attemptManifest = store.buildManifest(artifactsDir);
		for (const a of attemptManifest) {
			try {
				const dest = path.join(store.jobArtifactsDir(job.jobId), `${attemptId}--${a.path}`);
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.copyFileSync(path.join(artifactsDir, a.path), dest);
			} catch {
				/* best effort */
			}
		}
		store.buildManifest(store.jobArtifactsDir(job.jobId));

		// ── attempt record finalization
		// Follow-up/resume of the SAME attempt accumulates onto the prior
		// persisted usage; only the NEWLY incurred execution cost is charged to
		// the daily budget ledger (prior spend was already recorded).
		const resumedSameAttempt = Boolean(resumeOf) && attemptId === resumeOf?.attemptId;
		const cumulativeUsage: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, turns: 0 };
		if (resumedSameAttempt) accumulateUsage(cumulativeUsage, resumeOf?.usage);
		accumulateUsage(cumulativeUsage, legUsage);
		attempt.completedAt = Date.now();
		attempt.latencyMs = attempt.completedAt - attempt.startedAt;
		attempt.usage = cumulativeUsage;
		attempt.sessionId = outcome.sessionId;
		attempt.validation = result.validation;
		attempt.resultPath = path.join(attemptDir, "result.json");
		attempt.rawOutputPath = path.join(attemptDir, "raw-output.txt");
		this.config.budgets.recordSpend(legUsage.costUsd);

		const budgetPost = this.config.budgets.checkAttempt(attempt, agent.budget, this.config.defaults.budget);
		if (outcome.runError) {
			attempt.status = outcome.runError.kind === "aborted" ? "cancelled" : "failed";
			attempt.exitReason = outcome.runError.isTransport ? "transport_error" : outcome.runError.kind === "timeout" ? "timeout" : outcome.runError.kind === "malformed_output" ? "malformed_result" : outcome.runError.kind === "budget_exceeded" ? "budget_exceeded" : outcome.runError.kind === "aborted" ? "aborted" : "task_error";
			attempt.error = outcome.runError.message;
			this.events.append(job.jobId, "provider.error", { kind: outcome.runError.kind, message: outcome.runError.message }, attemptId);
		} else if (result.status === "success" && (validation?.status ?? "passed") !== "failed") {
			attempt.status = "success";
			attempt.exitReason = "completed";
		} else if (extracted.source === "synthetic") {
			attempt.status = "failed";
			attempt.exitReason = "malformed_result";
		} else if (validation?.status === "failed") {
			attempt.status = "failed";
			attempt.exitReason = "validation_failed";
		} else {
			attempt.status = "failed";
			attempt.exitReason = "task_error";
		}
		if (!budgetPost.ok && attempt.status === "success") {
			// success stands, but record the violation; job-level ceiling may stop retries
			this.events.append(job.jobId, "budget.checked", { violations: budgetPost.violations }, attemptId);
		}
		store.writeAttempt(attempt);
		this.events.append(job.jobId, attempt.status === "success" ? "attempt.completed" : "attempt.failed", { exitReason: attempt.exitReason, usage: attempt.usage }, attemptId);

		// ── job state + canonical job-level copies
		atomicWriteJson(path.join(store.jobDir(job.jobId), "result.json"), result);
		atomicWriteText(path.join(store.jobDir(job.jobId), "report.md"), renderReportMd(result));
		job.lastStatus = result.status;
		job.lastSummary = result.summary.slice(0, 300);
		job.lastValidation = result.validation.status;
		job.lastBlockers = result.blockers;
		job.needsFollowUp = result.status === "partial" || result.status === "blocked" || result.followUps.length > 0;
		if (attempt.status === "success") {
			job.status = "success";
			job.completedAt = Date.now();
			cleanupWorkspace(workspace, agent.workspace.cleanup ?? "keep", true);
			// persist BEFORE the event so event observers always read final truth
			this.store.writeJob(job);
			this.events.append(job.jobId, "job.completed", { attempts: job.attemptCount });
		} else if (attempt.status === "cancelled") {
			job.status = "cancelled";
			job.completedAt = Date.now();
			this.store.writeJob(job);
			this.events.append(job.jobId, "job.cancelled");
		} else {
			// Non-terminal here on purpose: the ladder loop (runJobInternal) owns
			// the failed/waiting decision so a stale JobRecord instance can never
			// overwrite a terminal state it didn't observe.
			job.status = "waiting";
			this.store.writeJob(job);
		}

		this.config.agentsViewExporter?.export(job, attempt);
		const attempts = store.listAttempts(job.jobId);
		return {
			jobId: job.jobId,
			status: job.status,
			attempts,
			latestResult: result,
			summaryForOrchestrator: [
				`job: ${job.jobId}`,
				`agent: ${agent.name} | model: ${decision.alias ?? "?"} (${attempt.resolvedModel}) | attempt: ${attemptId}/${job.retry.maxAttempts} | strategy: ${attempt.retryMode}`,
				`jobStatus: ${job.status}`,
				resultSummaryForOrchestrator(result, attempt),
				job.status === "waiting" ? `recommendation: ${result.blockers.length ? "resolve blockers, then jobs.retry" : "jobs.retry (ladder escalates automatically) or jobs.followup for small corrections"}` : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	}

	private failJob(job: JobRecord, reason: string): void {
		job.status = "failed";
		job.completedAt = Date.now();
		job.lastBlockers = [...(job.lastBlockers ?? []), reason];
		this.store.writeJob(job);
		this.events.append(job.jobId, "job.failed", { reason });
	}
}

// ── DAG helpers ──────────────────────────────────────────────────────────────

export function effectiveStatus(job: JobRecord, byId: Map<string, JobRecord>): JobStatus {
	if (statusIsTerminal(job.status) || job.status === "running" || job.status === "interrupted") return job.status;
	const deps = job.dependsOn.map((d) => byId.get(d)).filter((d): d is JobRecord => Boolean(d));
	if (deps.some((d) => d.status === "failed" || d.status === "cancelled")) return "failed";
	if (deps.length > 0 && deps.every((d) => d.status === "success")) return "ready";
	if (deps.length > 0) return "blocked";
	return "ready";
}

export function detectCycles(jobs: JobRecord[]): string[][] {
	const byId = new Map(jobs.map((j) => [j.jobId, j]));
	const state = new Map<string, "visiting" | "done">();
	const cycles: string[][] = [];
	const visit = (id: string, stack: string[]) => {
		const s = state.get(id);
		if (s === "done") return;
		if (s === "visiting") {
			const start = stack.indexOf(id);
			cycles.push(stack.slice(start >= 0 ? start : 0).concat(id));
			return;
		}
		state.set(id, "visiting");
		const job = byId.get(id);
		for (const dep of job?.dependsOn ?? []) if (byId.has(dep)) visit(dep, [...stack, id]);
		state.set(id, "done");
	};
	for (const j of jobs) visit(j.jobId, []);
	return cycles;
}

/** Sum provider-leg usage into `into`; contextTokens is a max high-water mark. */
function accumulateUsage(into: UsageInfo, add?: UsageInfo): void {
	if (!add) return;
	into.input += add.input;
	into.output += add.output;
	into.cacheRead += add.cacheRead;
	into.cacheWrite += add.cacheWrite;
	into.costUsd += add.costUsd;
	into.turns += add.turns;
	into.contextTokens = Math.max(into.contextTokens, add.contextTokens);
}

function combineSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
	if (!b) return a;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (a.aborted || b.aborted) controller.abort();
	else {
		a.addEventListener("abort", onAbort, { once: true });
		b.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			resolve();
		}, { once: true });
	});
}
