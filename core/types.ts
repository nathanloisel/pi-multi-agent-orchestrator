/**
 * core/types.ts — versioned schemas + typed definitions + runtime validation.
 *
 * The canonical machine protocol is JobResult (result.json, schemaVersion 1).
 * report.md is a human rendering of it. The orchestrator NEVER parses
 * free-form markdown to understand job state.
 *
 * Separation of concerns encoded here:
 *   Agent    = behavior (role, instructions, tools, hooks, limits, policies)
 *   Model    = capability (logical alias: worker-cheap / worker-best / frontier)
 *   Provider = transport (openrouter / anthropic / local-openai-compatible ...)
 *   Job      = persistent objective (survives retries/escalation/model changes)
 *   Attempt  = one execution of a job (one agent/runtime/model/session)
 */

// ── Result schema (canonical upstream protocol) ────────────────────────────

export const RESULT_SCHEMA_VERSION = 1;

export type ResultStatus = "success" | "partial" | "failure" | "blocked";
export type ValidationStatus = "passed" | "failed" | "skipped" | "error";
export type FindingSeverity = "info" | "warning" | "error";

export interface Finding {
	severity: FindingSeverity;
	code?: string;
	message: string;
	evidence?: string; // file:line refs, command output snippets (short)
}

export interface ValidationCheck {
	name: string;
	status: ValidationStatus;
	command?: string;
	exitCode?: number;
	durationMs?: number;
	artifact?: string; // path relative to attempt dir, e.g. validation/tests.log
	message?: string;
}

export interface ValidationOutcome {
	status: ValidationStatus;
	checks: ValidationCheck[];
}

export interface ArtifactRecord {
	id: string;
	type: string; // git-diff | log | file | data | image | other
	path: string; // relative to the attempt's artifacts dir
	size: number;
	sha256?: string;
	contentType?: string;
}

export interface JobResult {
	schemaVersion: number;
	jobId: string;
	attemptId: string;
	status: ResultStatus;
	summary: string;
	findings: Finding[];
	changes: string[];
	validation: ValidationOutcome;
	artifacts: ArtifactRecord[];
	blockers: string[];
	followUps: string[];
	metrics: Record<string, unknown>;
}

// ── Jobs / attempts ────────────────────────────────────────────────────────

export type JobStatus =
	| "queued" // created, dependencies not evaluated yet
	| "blocked" // waiting on dependencies
	| "ready" // dependencies satisfied, awaiting scheduler
	| "running" // an attempt is in flight
	| "waiting" // attempt finished unsuccessfully; retry/escalation pending or possible
	| "success"
	| "failed" // terminal: ladder exhausted or non-retryable
	| "cancelled"
	| "interrupted"; // orphaned by crash; recoverable

export type AttemptExitReason =
	| "completed"
	| "validation_failed"
	| "malformed_result"
	| "timeout"
	| "aborted"
	| "budget_exceeded"
	| "transport_error" // provider/network failure — NOT a task failure
	| "task_error"
	| "crashed";

export type RetryMode = "initial" | "resume" | "fresh";

export interface WorkspaceInfo {
	strategy: "cwd" | "git-worktree";
	path: string;
	branch?: string;
	baseCommit?: string;
}

export interface UsageInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextTokens: number;
	turns: number;
}

export interface AttemptRecord {
	schemaVersion: 1;
	attemptId: string; // attempt-001
	jobId: string;
	agent: string;
	parentAttemptId?: string;
	logicalModel?: string; // alias, e.g. worker-cheap
	resolvedModel?: string; // concrete, e.g. openrouter/x/y
	provider?: string;
	effort?: string;
	retryMode: RetryMode;
	escalationReason?: string;
	status: JobStatus; // running | success | failed | interrupted | cancelled
	exitReason?: AttemptExitReason;
	startedAt: number;
	ownerPid?: number; // orchestrator process that persisted/owned the running attempt
	completedAt?: number;
	latencyMs?: number;
	usage?: UsageInfo;
	sessionDir?: string;
	sessionId?: string;
	workspace?: WorkspaceInfo;
	validation?: ValidationOutcome;
	resultPath?: string;
	rawOutputPath?: string;
	transportRetries?: number;
	error?: string;
}

export interface RetryRung {
	model?: string; // logical alias override for this attempt
	strategy: "resume" | "fresh";
	maxTransportRetries?: number;
}

export interface RetrySpec {
	maxAttempts: number;
	ladder: RetryRung[]; // attempt 1 is implicit (agent/runtime default); ladder covers 2..N
}

export interface JobRecord {
	schemaVersion: 1;
	jobId: string;
	objective: string;
	agent: string;
	dependsOn: string[]; // jobIds
	status: JobStatus;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	cwd: string;
	kind?: string; // implementation | research | test-writing | debugging | review | other
	retry: RetrySpec;
	latestAttemptId?: string;
	attemptCount: number;
	// denormalized latest outcome — what the orchestrator sees by default (§26)
	lastStatus?: ResultStatus | JobStatus;
	lastSummary?: string;
	lastValidation?: ValidationStatus;
	lastBlockers?: string[];
	needsFollowUp?: boolean;
	budget?: BudgetConfig;
	priority?: number;
	tags?: string[];
	/** Logical model alias persisted from CreateJobInput.model; applied only to
	 * the job's FIRST attempt (jobs.retry model=... overrides win). Optional so
	 * previously persisted jobs load unchanged. */
	initialModel?: string;
}

// ── Budgets (§13) ──────────────────────────────────────────────────────────

export interface BudgetConfig {
	perAttemptUsd?: number;
	perJobUsd?: number;
	dailyUsd?: number;
	maxTurns?: number;
	maxOutputTokens?: number;
	timeoutSeconds?: number;
	maxAttempts?: number;
}

export interface BudgetCheck {
	ok: boolean;
	violations: string[]; // machine-readable, e.g. "perJobUsd:0.20"
}

// ── Concurrency (§12) ──────────────────────────────────────────────────────

export interface ConcurrencyConfig {
	global: number;
	byModel: Record<string, number>; // logical alias → max concurrent attempts
}

// ── Model aliases (§1, §2, §10) ────────────────────────────────────────────

export interface ConcreteModelConfig {
	provider: string; // openrouter | anthropic | local-openai-compatible | ...
	model: string; // concrete id at that provider
	baseUrl?: string; // for openai-compatible endpoints (local later)
	apiKeyEnv?: string; // env var holding the key (never in prompts)
	effort?: string; // default thinking level
	env?: Record<string, string>;
	extraArgs?: string[]; // extra pi CLI args for this backend
	headers?: Record<string, string>;
}

export interface ResolvedModel {
	alias: string;
	concrete: ConcreteModelConfig;
	source: "registry" | "agent" | "override" | "inherited";
}

// ── Agent runtime package (§7) ─────────────────────────────────────────────

export interface AgentLimits {
	maxTurns?: number;
	timeoutSeconds?: number;
	maxOutputTokens?: number;
}

export interface AgentContextPolicy {
	mode: "none" | "selective" | "full"; // full = pi default AGENTS.md discovery
	files?: string[]; // relative to workspace; injected into the envelope
}

export interface AgentWorkspacePolicy {
	strategy: "cwd" | "git-worktree";
	cleanup?: "keep" | "remove-on-success";
}

export interface AgentValidationConfig {
	commands?: string[]; // run host-side after the attempt, inside the workspace
	timeoutSeconds?: number;
}

export interface AgentRuntimeConfig {
	model?: string; // LOGICAL ALIAS (worker-cheap). Concrete provider/model allowed as override.
	provider?: string; // explicit override (skips registry)
	effort?: string;
}

export interface AgentHooksConfig {
	enabled?: boolean;
	paths?: string[]; // sub-process hooks (relative to agent dir)
	mainPaths?: string[]; // main-process hooks
}

export interface AgentConfig {
	name: string;
	description: string;
	role: "main" | "sub";
	runtime: AgentRuntimeConfig;
	capabilities?: string[]; // tool allowlist
	limits: AgentLimits;
	context: AgentContextPolicy;
	workspace: AgentWorkspacePolicy;
	validation: AgentValidationConfig;
	retry?: Partial<RetrySpec>;
	budget?: BudgetConfig;
	env?: Record<string, string>;
	hooks: AgentHooksConfig;
	systemPrompt: string; // AGENT.md body
	dir: string;
	filePath: string;
	source: "user" | "project";
	hookPaths: string[]; // resolved
	mainHookPaths: string[]; // resolved
	schema: "v1" | "v2"; // v1 = legacy flat frontmatter
}

// ── Context packs (§19) ────────────────────────────────────────────────────

export interface ContextPack {
	objective: string;
	relevantFiles?: string[];
	relevantSymbols?: string[];
	constraints?: string[];
	acceptance?: string[];
	background?: string; // short prose from the orchestrator
	previousFailure?: {
		attemptId: string;
		summary: string;
		validation?: ValidationOutcome;
		selectedArtifacts?: string[];
	};
}

// ── Routing (§9) ───────────────────────────────────────────────────────────

export interface RoutingRule {
	kind?: string; // job kind match
	tag?: string;
	attempt?: number; // 1-based; matches when attemptCount === this
	on?: "initial" | "validation_failed" | "any_failure";
	model: string; // logical alias
}

// ── Runtime validation helpers (no deps) ───────────────────────────────────

export function emptyValidation(): ValidationOutcome {
	return { status: "skipped", checks: [] };
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Validate/normalize an untrusted worker-produced JobResult.
 * Never throws; returns a corrected result plus the list of repairs.
 */
export function normalizeJobResult(raw: unknown, jobId: string, attemptId: string): { result: JobResult; repairs: string[] } {
	const repairs: string[] = [];
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	if (o.schemaVersion !== RESULT_SCHEMA_VERSION) repairs.push(`schemaVersion missing/unknown (${String(o.schemaVersion)}) → ${RESULT_SCHEMA_VERSION}`);

	const statusRaw = typeof o.status === "string" ? o.status : "";
	const status: ResultStatus = (["success", "partial", "failure", "blocked"] as const).includes(statusRaw as ResultStatus)
		? (statusRaw as ResultStatus)
		: (repairs.push(`status invalid (${statusRaw || "missing"}) → failure`), "failure");

	const findings: Finding[] = Array.isArray(o.findings)
		? o.findings
				.filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
				.map((f) => ({
					severity: (["info", "warning", "error"] as const).includes(f.severity as FindingSeverity)
						? (f.severity as FindingSeverity)
						: "info",
					code: typeof f.code === "string" ? f.code : undefined,
					message: typeof f.message === "string" ? f.message : String(f),
					evidence: typeof f.evidence === "string" ? f.evidence : undefined,
				}))
		: (o.findings !== undefined && repairs.push("findings not an array → []"), []);

	const validation: ValidationOutcome = (() => {
		const v = (o.validation && typeof o.validation === "object" ? o.validation : {}) as Record<string, unknown>;
		const checks: ValidationCheck[] = Array.isArray(v.checks)
			? v.checks
					.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
					.map((c) => ({
						name: typeof c.name === "string" ? c.name : "check",
						status: (["passed", "failed", "skipped", "error"] as const).includes(c.status as ValidationStatus)
							? (c.status as ValidationStatus)
							: "skipped",
						command: typeof c.command === "string" ? c.command : undefined,
						exitCode: typeof c.exitCode === "number" ? c.exitCode : undefined,
						durationMs: typeof c.durationMs === "number" ? c.durationMs : undefined,
						artifact: typeof c.artifact === "string" ? c.artifact : undefined,
						message: typeof c.message === "string" ? c.message : undefined,
					}))
			: [];
		const vsRaw = typeof v.status === "string" ? v.status : "";
		const vs: ValidationStatus = (["passed", "failed", "skipped", "error"] as const).includes(vsRaw as ValidationStatus)
			? (vsRaw as ValidationStatus)
			: checks.length > 0
				? checks.some((c) => c.status === "failed" || c.status === "error")
					? "failed"
					: "passed"
				: "skipped";
		return { status: vs, checks };
	})();

	const artifacts: ArtifactRecord[] = Array.isArray(o.artifacts)
		? o.artifacts
				.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
				.map((a, i) => ({
					id: typeof a.id === "string" ? a.id : `artifact-${i + 1}`,
					type: typeof a.type === "string" ? a.type : "other",
					path: typeof a.path === "string" ? a.path : "",
					size: typeof a.size === "number" ? a.size : 0,
					sha256: typeof a.sha256 === "string" ? a.sha256 : undefined,
					contentType: typeof a.contentType === "string" ? a.contentType : undefined,
				}))
				.filter((a) => a.path.length > 0)
		: [];

	return {
		repairs,
		result: {
			schemaVersion: RESULT_SCHEMA_VERSION,
			jobId: typeof o.jobId === "string" ? o.jobId : jobId,
			attemptId: typeof o.attemptId === "string" ? o.attemptId : attemptId,
			status,
			summary: typeof o.summary === "string" ? o.summary : "",
			findings,
			changes: strArray(o.changes),
			validation,
			artifacts,
			blockers: strArray(o.blockers),
			followUps: strArray(o.followUps),
			metrics: (o.metrics && typeof o.metrics === "object" && !Array.isArray(o.metrics) ? o.metrics : {}) as Record<string, unknown>,
		},
	};
}

export const DEFAULT_RETRY: RetrySpec = {
	maxAttempts: 4,
	ladder: [
		{ strategy: "fresh" }, // attempt 2: cheap fresh retry + deterministic failure feedback (§16, §20)
		{ model: "worker-best", strategy: "fresh" }, // attempt 3
		{ model: "frontier", strategy: "fresh" }, // attempt 4
	],
};

export const DEFAULT_CONCURRENCY: ConcurrencyConfig = { global: 4, byModel: {} };
