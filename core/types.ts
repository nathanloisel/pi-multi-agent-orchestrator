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

/**
 * Bounded evidence carried automatically from a prerequisite job into a
 * dependent job's context (one entry per `dependsOn` id). Deliberately NOT a
 * transcript or a source dump: small capped fields plus an absolute canonical
 * result.json reference so a worker can read full detail on demand. Artifact
 * references are resolved to absolute, existing paths via the storage helpers
 * (never invented). */
export interface DependencyHandoff {
	jobId: string;
	agent: string;
	status: JobStatus | "missing"; // "missing" = no stored result for the prerequisite
	summary: string;
	findings: { message: string; evidence?: string }[];
	changedPaths: string[];
	validation: ValidationStatus;
	artifacts: string[]; // absolute paths resolved from the prerequisite's artifacts
	/** Absolute canonical result.json path for the prerequisite. */
	resultPath: string;
	/** Counts of list values dropped by the per-entry caps (optional for old contexts). */
	findingsOmitted?: number;
	changedPathsOmitted?: number;
	artifactsOmitted?: number;
}

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
	/** Bounded handoffs from prerequisite jobs — evidence, not instructions. */
	dependencies?: DependencyHandoff[];
	/** Count of prerequisite records dropped by the handoff bounds. */
	dependenciesOmitted?: number;
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

// ── Structured plan publication (orchestrator.plan) ────────────────────────
//
// The main agent publishes its structured early plan as a complete, immutable
// Pi session custom entry (`orchestrator.plan`) on the CURRENT branch. Each
// entry is a full snapshot (never a patch), so the latest valid entry on a
// branch is the entire plan — no cross-session cache or filesystem store is
// needed. See PLAN-CONTRACT.md for the consumer contract.
//
// A deliberate mismatch with the sibling plan-protocol: this is the minimal
// producer wire shape the orchestrator can emit today with no new tool and no
// future schema requirement. It carries declared plan state; live job state
// stays in the JobRecord store and is joined by explicit `jobIds` / membership
// bindings.

export const PLAN_ENTRY_TYPE = "orchestrator.plan";
export const PLAN_SCHEMA_VERSION = 1 as const;

/** Hard bounds so a single plan can never grow unbounded. */
export const MAX_PLAN_STEPS = 64;
export const MAX_PLAN_TITLE_CHARS = 120;
export const MAX_PLAN_ID_CHARS = 80;
export const MAX_PLAN_REF_CHARS = 80;
export const MAX_PLAN_REFS = 64;

export const PLAN_STEP_STATUSES = ["planned", "running", "completed", "failed", "blocked", "cancelled", "superseded"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/** One declared plan step. `agent` is optional and never defaulted. */
export interface PlanStep {
	id: string;
	title: string;
	agent?: string;
	dependsOn: string[];
	jobIds: string[];
	status: PlanStepStatus;
}

/** The exact custom-entry payload persisted under `orchestrator.plan`. */
export interface PlanSnapshot {
	version: typeof PLAN_SCHEMA_VERSION;
	planId: string;
	revision: number;
	steps: PlanStep[];
}

/** Stable job↔step association recorded in the progress membership entry. */
export interface PlanJobBinding {
	jobId: string;
	stepId: string;
}

export type PlanRevisionResult = { ok: true; snapshot: PlanSnapshot } | { ok: false; errors: string[] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize an id array: absent → [], otherwise unique non-empty bounded strings. */
function normalizeRefArray(value: unknown): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_PLAN_REFS) return null;
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		const id = entry.trim();
		if (!id || id.length > MAX_PLAN_REF_CHARS || out.includes(id)) return null;
		out.push(id);
	}
	return out;
}

/** Collect a reference array while pushing human-readable validation errors. */
function validateRefArray(value: unknown, field: string, errors: string[]): string[] | null {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array of strings`);
		return null;
	}
	if (value.length > MAX_PLAN_REFS) {
		errors.push(`${field} exceeds ${MAX_PLAN_REFS} entries`);
		return null;
	}
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			errors.push(`${field} entries must be strings`);
			return null;
		}
		const id = entry.trim();
		if (!id) {
			errors.push(`${field} entries must not be empty`);
			return null;
		}
		if (id.length > MAX_PLAN_REF_CHARS) {
			errors.push(`${field} entries exceed ${MAX_PLAN_REF_CHARS} characters`);
			return null;
		}
		if (out.includes(id)) {
			errors.push(`${field} contains duplicate ${id}`);
			return null;
		}
		out.push(id);
	}
	return out;
}

/** Cycle detection over step.dependsOn. Returns the cycle path, or null. */
function findDependencyCycle(steps: readonly PlanStep[]): string[] | null {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	let cycle: string[] | null = null;
	const visit = (id: string): boolean => {
		const current = state.get(id) ?? 0;
		if (current === 1) {
			const start = stack.indexOf(id);
			cycle = [...stack.slice(start), id];
			return true;
		}
		if (current === 2) return false;
		state.set(id, 1);
		stack.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			if (byId.has(dep) && visit(dep)) return true;
		}
		stack.pop();
		state.set(id, 2);
		return false;
	};
	for (const step of steps) {
		if (visit(step.id)) break;
	}
	return cycle;
}

/**
 * Strictly parse a persisted snapshot. Returns null for ANY malformed shape
 * (bad version, missing fields, duplicate ids, unknown/cyclic dependencies) so
 * callers can skip malformed historical entries instead of throwing.
 */
export function normalizePlanSnapshot(raw: unknown): PlanSnapshot | null {
	if (!isPlainRecord(raw)) return null;
	if (raw.version !== PLAN_SCHEMA_VERSION) return null;
	if (typeof raw.planId !== "string") return null;
	const planId = raw.planId.trim();
	if (!planId || planId.length > MAX_PLAN_ID_CHARS) return null;
	if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) return null;
	if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_PLAN_STEPS) return null;

	const steps: PlanStep[] = [];
	const seen = new Set<string>();
	for (const candidate of raw.steps) {
		if (!isPlainRecord(candidate)) return null;
		if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
		const id = candidate.id.trim();
		const title = candidate.title.replace(/\s+/g, " ").trim();
		if (!id || id.length > MAX_PLAN_REF_CHARS || seen.has(id)) return null;
		if (!title || title.length > MAX_PLAN_TITLE_CHARS) return null;
		if (candidate.agent !== undefined && (typeof candidate.agent !== "string" || candidate.agent.trim().length === 0 || candidate.agent.length > MAX_PLAN_REF_CHARS)) return null;
		const dependsOn = normalizeRefArray(candidate.dependsOn);
		const jobIds = normalizeRefArray(candidate.jobIds);
		if (!dependsOn || !jobIds) return null;
		if (typeof candidate.status !== "string" || !PLAN_STEP_STATUSES.includes(candidate.status as PlanStepStatus)) return null;
		seen.add(id);
		const step: PlanStep = { id, title, dependsOn, jobIds, status: candidate.status as PlanStepStatus };
		if (typeof candidate.agent === "string" && candidate.agent.trim()) step.agent = candidate.agent.trim();
		steps.push(step);
	}

	for (const step of steps) {
		for (const dep of step.dependsOn) if (!seen.has(dep)) return null;
	}
	if (findDependencyCycle(steps)) return null;

	return { version: PLAN_SCHEMA_VERSION, planId, revision: raw.revision, steps };
}

/**
 * Build the next branch-local plan revision from a `jobs action=plan` call.
 *
 * Retention rule: supplied steps replace same-id definitions in place and new
 * ids append; every omitted previous step is retained verbatim, so steps can
 * never silently disappear. Validation is exhaustive and happens before any
 * append (atomic). `revision` is always previous + 1 (or 1 for the first).
 */
export function buildPlanSnapshot(opts: { previous: PlanSnapshot | null; planId?: unknown; steps: unknown }): PlanRevisionResult {
	const errors: string[] = [];
	const previous = opts.previous;

	let suppliedPlanId: string | undefined;
	if (opts.planId !== undefined) {
		if (typeof opts.planId !== "string") errors.push("planId must be a string");
		else {
			const clean = opts.planId.trim();
			if (!clean) errors.push("planId must not be empty");
			else if (clean.length > MAX_PLAN_ID_CHARS) errors.push(`planId exceeds ${MAX_PLAN_ID_CHARS} characters`);
			else suppliedPlanId = clean;
		}
	}
	if (suppliedPlanId && previous && suppliedPlanId !== previous.planId) {
		errors.push(`planId cannot change within a branch (current: ${previous.planId})`);
	}
	const planId = suppliedPlanId ?? previous?.planId ?? "plan";

	if (!Array.isArray(opts.steps) || opts.steps.length === 0) {
		return { ok: false, errors: [...errors, "steps must be a non-empty array"] };
	}
	if (opts.steps.length > MAX_PLAN_STEPS) {
		return { ok: false, errors: [...errors, `steps exceeds ${MAX_PLAN_STEPS} entries`] };
	}

	const inputs: PlanStep[] = [];
	const suppliedIds = new Set<string>();
	for (let i = 0; i < opts.steps.length; i++) {
		const label = `steps[${i}]`;
		const raw = opts.steps[i];
		if (!isPlainRecord(raw)) {
			errors.push(`${label} must be an object`);
			continue;
		}
		if (typeof raw.id !== "string") {
			errors.push(`${label}.id must be a string`);
			continue;
		}
		const id = raw.id.replace(/[\r\n\t]+/g, " ").trim();
		if (!id) {
			errors.push(`${label}.id must not be empty`);
			continue;
		}
		if (id.length > MAX_PLAN_REF_CHARS) {
			errors.push(`${label}.id exceeds ${MAX_PLAN_REF_CHARS} characters`);
			continue;
		}
		if (suppliedIds.has(id)) {
			errors.push(`duplicate step id: ${id}`);
			continue;
		}
		if (typeof raw.title !== "string") {
			errors.push(`${label}.title must be a string`);
			continue;
		}
		const title = raw.title.replace(/\s+/g, " ").trim();
		if (!title) {
			errors.push(`${label}.title must not be empty`);
			continue;
		}
		if (title.length > MAX_PLAN_TITLE_CHARS) {
			errors.push(`${label}.title exceeds ${MAX_PLAN_TITLE_CHARS} characters`);
			continue;
		}
		let agent: string | undefined;
		if (raw.agent !== undefined) {
			if (typeof raw.agent !== "string") {
				errors.push(`${label}.agent must be a string`);
				continue;
			}
			const cleanAgent = raw.agent.replace(/[\r\n\t]+/g, " ").trim();
			if (cleanAgent) {
				if (cleanAgent.length > MAX_PLAN_REF_CHARS) {
					errors.push(`${label}.agent exceeds ${MAX_PLAN_REF_CHARS} characters`);
					continue;
				}
				agent = cleanAgent;
			}
		}
		const dependsOn = validateRefArray(raw.dependsOn, `${label}.dependsOn`, errors);
		const jobIds = validateRefArray(raw.jobIds, `${label}.jobIds`, errors);
		if (dependsOn === null || jobIds === null) continue;
		let status: PlanStepStatus = "planned";
		if (raw.status !== undefined) {
			if (typeof raw.status !== "string" || !PLAN_STEP_STATUSES.includes(raw.status as PlanStepStatus)) {
				errors.push(`${label}.status must be one of ${PLAN_STEP_STATUSES.join(", ")}`);
				continue;
			}
			status = raw.status as PlanStepStatus;
		}
		suppliedIds.add(id);
		const step: PlanStep = { id, title, dependsOn, jobIds, status };
		if (agent) step.agent = agent;
		inputs.push(step);
	}

	if (errors.length > 0) return { ok: false, errors };

	const merged: PlanStep[] = previous
		? previous.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn], jobIds: [...step.jobIds] }))
		: [];
	for (const input of inputs) {
		const index = merged.findIndex((step) => step.id === input.id);
		if (index >= 0) merged[index] = input;
		else merged.push(input);
	}
	if (merged.length > MAX_PLAN_STEPS) {
		return { ok: false, errors: [`plan exceeds ${MAX_PLAN_STEPS} steps after retention (${merged.length})`] };
	}

	const ids = new Set(merged.map((step) => step.id));
	for (const step of merged) {
		for (const dep of step.dependsOn) {
			if (!ids.has(dep)) errors.push(`step ${step.id} depends on unknown step ${dep}`);
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	const cycle = findDependencyCycle(merged);
	if (cycle) return { ok: false, errors: [`dependency cycle: ${cycle.join(" → ")}`] };

	return {
		ok: true,
		snapshot: { version: PLAN_SCHEMA_VERSION, planId, revision: (previous?.revision ?? 0) + 1, steps: merged },
	};
}

/** Inputs for the automatic plan fallback: one freshly created job. Derived
 * from created JobRecords BEFORE any run starts. */
export interface AutoPlanJobInput {
	jobId: string;
	agent: string;
	objective: string;
	dependsOn: readonly string[];
	/** Optional explicit title from the delegate call. */
	title?: string;
}

/** A new plan step produced by the automatic fallback (before validation). */
export interface AutoPlanStepInput {
	id: string;
	title: string;
	agent: string;
	dependsOn: string[];
	jobIds: string[];
}

export interface AutoPlanDerivation {
	steps: AutoPlanStepInput[];
	diagnostics: string[];
}

/** Clean a delegate title/objective into a bounded single-line plan title.
 * Prefers an explicit title; otherwise uses the first sentence of the
 * objective (markdown bullets/numbering and leading headings stripped). */
export function deriveAutoPlanTitle(explicit: string | undefined, objective: string): string {
	const hasExplicit = typeof explicit === "string" && explicit.trim().length > 0;
	// For an objective, use the first non-empty line; an explicit title is whole.
	const source = hasExplicit ? explicit! : (objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "");
	let title = source.replace(/\s+/g, " ").trim();
	for (let i = 0; i < 3; i++) {
		const next = title
			.replace(/^#+\s*/, "")
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+[.)]\s*/, "")
			.trimStart();
		if (next === title) break;
		title = next;
	}
	title = title.trim();
	if (!hasExplicit) {
		const sentence = title.match(/^[^.!?]*[.!?]/)?.[0]?.trim();
		if (sentence) title = sentence;
	}
	if (!title) return "job";
	return title.length > MAX_PLAN_TITLE_CHARS ? `${title.slice(0, MAX_PLAN_TITLE_CHARS - 1).trimEnd()}…` : title;
}

/** Derive the minimal set of NEW plan steps for freshly created jobs when the
 * model omitted `jobs action=plan`. Explicit plan steps always win: a job that
 * is already represented (same step id, or listed in some step's jobIds) gets
 * no new step, and existing titles/statuses are never touched. Dependencies
 * are emitted only when they resolve to a step that is or will be in the plan,
 * so a generated plan can never dangle or cycle. */
export function deriveAutoPlanSteps(opts: { previous: PlanSnapshot | null; jobs: readonly AutoPlanJobInput[] }): AutoPlanDerivation {
	const existingStepIds = new Set<string>();
	const representedJobIds = new Set<string>();
	for (const step of opts.previous?.steps ?? []) {
		existingStepIds.add(step.id);
		representedJobIds.add(step.id);
		for (const jobId of step.jobIds) representedJobIds.add(jobId);
	}
	const newStepIds = new Set(opts.jobs.filter((job) => !representedJobIds.has(job.jobId)).map((job) => job.jobId));
	const validDependencyIds = new Set([...existingStepIds, ...newStepIds]);
	const diagnostics: string[] = [];
	const steps: AutoPlanStepInput[] = [];
	for (const job of opts.jobs) {
		if (representedJobIds.has(job.jobId)) continue;
		const dependsOn: string[] = [];
		for (const dep of job.dependsOn) {
			if (validDependencyIds.has(dep)) {
				if (!dependsOn.includes(dep)) dependsOn.push(dep);
			} else {
				diagnostics.push(`dependency "${dep}" of job "${job.jobId}" has no plan step and was omitted`);
			}
		}
		steps.push({ id: job.jobId, title: deriveAutoPlanTitle(job.title, job.objective), agent: job.agent, dependsOn, jobIds: [job.jobId] });
	}
	return { steps, diagnostics };
}

/**
 * Latest VALID plan snapshot on a branch (root→leaf order). Malformed
 * historical entries are skipped, never thrown on. Callers pass only the
 * current branch, so sessions never inherit each other's plans.
 */
export function readLatestPlan(branch: readonly unknown[]): PlanSnapshot | null {
	let latest: PlanSnapshot | null = null;
	for (const entry of branch) {
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown } | null | undefined;
		if (!candidate || candidate.type !== "custom" || candidate.customType !== PLAN_ENTRY_TYPE) continue;
		const parsed = normalizePlanSnapshot(candidate.data);
		if (parsed) latest = parsed;
	}
	return latest;
}

/** Compact, bounded tool-result summary of a snapshot (live job states optional). */
export function renderPlanSummary(snapshot: PlanSnapshot, live: Readonly<Record<string, string>> = {}): string {
	const counts = new Map<PlanStepStatus, number>();
	for (const step of snapshot.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
	const countText = PLAN_STEP_STATUSES.filter((status) => counts.has(status))
		.map((status) => `${counts.get(status)!} ${status}`)
		.join(", ");
	const lines = [`plan "${snapshot.planId}" revision ${snapshot.revision}: ${snapshot.steps.length} step${snapshot.steps.length === 1 ? "" : "s"} (${countText})`];
	for (const step of snapshot.steps) {
		const agent = step.agent ? ` [${step.agent}]` : "";
		const deps = step.dependsOn.length ? ` ⇠ ${step.dependsOn.join(",")}` : "";
		// Show live job state for explicit jobIds and for an alias-bound step id
		// (step.id === job.jobId) when that job resolves.
		const refs = [...new Set([...step.jobIds, ...(live[step.id] !== undefined ? [step.id] : [])])];
		const jobs = refs.length ? ` · jobs: ${refs.map((jobId) => `${jobId}=${live[jobId] ?? "unknown"}`).join(", ")}` : "";
		lines.push(`- ${step.id}${agent} ${step.status}${deps} — ${step.title}${jobs}`);
	}
	return lines.join("\n");
}
