/**
 * Frozen cross-contract fixture: a local mirror of the pi-session-desk
 * `pi-workspace` consumer (`packages/pi-workspace/src/plan.ts`).
 *
 * The orchestrator repo cannot depend on the sibling repo at build or runtime
 * (constraint: no cross-repo dependency), so this fixture freezes the consumer
 * contract the producer must satisfy:
 *
 *   - the exact `orchestrator.plan` custom-entry payload shape;
 *   - strict validation that skips (never throws on) malformed entries;
 *   - `orchestrator.progress-jobs` `data.jobIds` + additive `data.bindings`
 *     readers;
 *   - link precedence: membership binding > step.jobIds > step.id === jobId;
 *   - live job state wins over declared plan status, and a completed step
 *     requires a recorded non-failed validation.
 *
 * It is intentionally a near-verbatim port of the desk's pure functions so a
 * producer wire-shape change fails this test. Desk source of truth:
 * /home/nathan/dev/pi-session-desk/packages/pi-workspace/src/plan.ts
 */

export const PLAN_ENTRY_TYPE = "orchestrator.plan";
export const PROGRESS_MEMBERSHIP_ENTRY_TYPE = "orchestrator.progress-jobs";
export const PLAN_SCHEMA_VERSION = 1 as const;

export const MAX_PLAN_STEPS = 64;
export const MAX_PLAN_TITLE_CHARS = 120;
export const MAX_PLAN_REF_CHARS = 80;
export const MAX_PLAN_REFS = 64;
export const MAX_PLAN_ID_CHARS = 80;

export const PLAN_STEP_STATUSES = [
	"planned",
	"running",
	"completed",
	"failed",
	"blocked",
	"cancelled",
	"superseded",
] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStep {
	id: string;
	title: string;
	agent?: string;
	dependsOn: string[];
	jobIds: string[];
	status: PlanStepStatus;
}

export interface PlanSnapshot {
	version: typeof PLAN_SCHEMA_VERSION;
	planId: string;
	revision: number;
	steps: PlanStep[];
}

export interface PlanJobBinding {
	jobId: string;
	stepId: string;
}

interface RawEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

function asEntry(value: unknown): RawEntry | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as RawEntry) : null;
}

export function collectMembershipJobIds(entries: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		const e = asEntry(entry);
		if (!e || e.type !== "custom" || e.customType !== PROGRESS_MEMBERSHIP_ENTRY_TYPE) continue;
		const raw = (e.data as { jobIds?: unknown } | undefined)?.jobIds;
		if (!Array.isArray(raw)) continue;
		for (const id of raw) if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

export function collectMembershipBindings(entries: readonly unknown[]): PlanJobBinding[] {
	const out: PlanJobBinding[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const e = asEntry(entry);
		if (!e || e.type !== "custom" || e.customType !== PROGRESS_MEMBERSHIP_ENTRY_TYPE) continue;
		const raw = (e.data as { bindings?: unknown } | undefined)?.bindings;
		if (!Array.isArray(raw)) continue;
		for (const candidate of raw) {
			const b = candidate as { jobId?: unknown; stepId?: unknown } | null | undefined;
			const jobId = typeof b?.jobId === "string" && b.jobId.length > 0 ? b.jobId : null;
			const stepId = typeof b?.stepId === "string" && b.stepId.length > 0 ? b.stepId : null;
			if (!jobId || !stepId) continue;
			const key = `${jobId}\u0000${stepId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ jobId, stepId });
		}
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
		for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep) && visit(dep)) return true;
		stack.pop();
		state.set(id, 2);
		return false;
	};
	for (const step of steps) if (visit(step.id)) break;
	return cycle;
}

export function normalizePlanSnapshot(raw: unknown): PlanSnapshot | null {
	if (!isRecord(raw)) return null;
	if (raw.version !== PLAN_SCHEMA_VERSION) return null;
	if (typeof raw.planId !== "string") return null;
	const planId = raw.planId.trim();
	if (!planId || planId.length > MAX_PLAN_ID_CHARS) return null;
	if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) return null;
	if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_PLAN_STEPS) return null;

	const steps: PlanStep[] = [];
	const seen = new Set<string>();
	for (const candidate of raw.steps) {
		if (!isRecord(candidate)) return null;
		if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
		const id = candidate.id.trim();
		const title = candidate.title.replace(/\s+/g, " ").trim();
		if (!id || id.length > MAX_PLAN_REF_CHARS || seen.has(id)) return null;
		if (!title || title.length > MAX_PLAN_TITLE_CHARS) return null;
		if (
			candidate.agent !== undefined &&
			(typeof candidate.agent !== "string" ||
				candidate.agent.trim().length === 0 ||
				candidate.agent.length > MAX_PLAN_REF_CHARS)
		) {
			return null;
		}
		const dependsOn = normalizeRefArray(candidate.dependsOn);
		const jobIds = normalizeRefArray(candidate.jobIds);
		if (!dependsOn || !jobIds) return null;
		if (typeof candidate.status !== "string" || !PLAN_STEP_STATUSES.includes(candidate.status as PlanStepStatus)) return null;
		seen.add(id);
		const step: PlanStep = { id, title, dependsOn, jobIds, status: candidate.status as PlanStepStatus };
		if (typeof candidate.agent === "string" && candidate.agent.trim()) step.agent = candidate.agent.trim();
		steps.push(step);
	}
	for (const step of steps) for (const dep of step.dependsOn) if (!seen.has(dep)) return null;
	if (findDependencyCycle(steps)) return null;
	return { version: PLAN_SCHEMA_VERSION, planId, revision: raw.revision, steps };
}

export function readLatestPlan(branch: readonly unknown[]): PlanSnapshot | null {
	let latest: PlanSnapshot | null = null;
	for (const entry of branch) {
		const e = asEntry(entry);
		if (!e || e.type !== "custom" || e.customType !== PLAN_ENTRY_TYPE) continue;
		const parsed = normalizePlanSnapshot(e.data);
		if (parsed) latest = parsed;
	}
	return latest;
}

// ── Projection (subset of the desk's deriveWorkspaceModel) ─────────────────

export type WorkspaceStepState =
	| "planned"
	| "queued"
	| "blocked"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "superseded"
	| "unknown";

/** Minimal DeskJob projection: only fields the plan projection consumes. */
export interface DeskJobLike {
	jobId: string;
	label: string;
	status: string;
	state: "done" | "running" | "blocked" | "failed" | "cancelled" | "interrupted" | "queued" | "unknown";
	agent: string;
	lastValidation?: string;
	latestAttemptId?: string;
}

export interface WorkspaceStep {
	id: string;
	title: string;
	declaredAgent?: string;
	executingAgent?: string;
	dependsOn: string[];
	declaredStatus: PlanStepStatus;
	state: WorkspaceStepState;
	jobs: DeskJobLike[];
	unlinked: boolean;
}

export interface WorkspaceModel {
	planId: string | null;
	revision: number | null;
	steps: WorkspaceStep[];
	otherJobs: DeskJobLike[];
	planMissing: boolean;
	warnings: string[];
}

function jobState(job: DeskJobLike): WorkspaceStepState {
	switch (job.state) {
		case "running":
			return "running";
		case "blocked":
			return "blocked";
		case "done":
			if (job.lastValidation === "failed" || job.lastValidation === "error") return "failed";
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "failed";
		case "queued":
			return "queued";
		default:
			return "unknown";
	}
}

function declaredState(status: PlanStepStatus): WorkspaceStepState {
	switch (status) {
		case "planned":
			return "planned";
		case "running":
			return "running";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "blocked":
			return "blocked";
		case "cancelled":
			return "cancelled";
		case "superseded":
			return "superseded";
		default:
			return "unknown";
	}
}

function aggregateState(jobs: readonly DeskJobLike[], declared: PlanStepStatus): WorkspaceStepState {
	if (jobs.length === 0) return declaredState(declared);
	const states = jobs.map(jobState);
	if (states.some((s) => s === "failed")) return "failed";
	if (states.every((s) => s === "cancelled")) return "cancelled";
	if (states.some((s) => s === "running")) return "running";
	if (states.some((s) => s === "blocked")) return "blocked";
	if (states.every((s) => s === "completed")) return "completed";
	if (states.some((s) => s === "completed")) return "running";
	return "queued";
}

export function buildJobToStepMap(plan: PlanSnapshot | null, bindings: readonly PlanJobBinding[]): Map<string, string> {
	const map = new Map<string, string>();
	if (!plan) return map;
	const stepIds = new Set(plan.steps.map((s) => s.id));
	for (const binding of bindings) {
		if (stepIds.has(binding.stepId) && !map.has(binding.jobId)) map.set(binding.jobId, binding.stepId);
	}
	for (const step of plan.steps) for (const jobId of step.jobIds) if (!map.has(jobId)) map.set(jobId, step.id);
	return map;
}

function topologicalStepIds(steps: readonly PlanStep[]): string[] {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const visited = new Set<string>();
	const active = new Set<string>();
	const order: string[] = [];
	const visit = (id: string): void => {
		if (visited.has(id) || active.has(id)) return;
		active.add(id);
		const step = byId.get(id);
		if (step) for (const dep of step.dependsOn) if (byId.has(dep)) visit(dep);
		active.delete(id);
		visited.add(id);
		order.push(id);
	};
	for (const step of steps) visit(step.id);
	return order;
}

export interface DeriveInput {
	plan: PlanSnapshot | null;
	jobs: readonly DeskJobLike[];
	bindings: readonly PlanJobBinding[];
	requestedJobIds: readonly string[];
	missingJobIds?: readonly string[];
}

export function deriveWorkspaceModel(input: DeriveInput): WorkspaceModel {
	const { plan, jobs, bindings, requestedJobIds, missingJobIds = [] } = input;
	const jobById = new Map(jobs.map((j) => [j.jobId, j]));
	const jobToStep = buildJobToStepMap(plan, bindings);
	if (plan) {
		for (const step of plan.steps) if (jobById.has(step.id) && !jobToStep.has(step.id)) jobToStep.set(step.id, step.id);
	}

	const warnings: string[] = [];
	const steps: WorkspaceStep[] = [];
	const claimed = new Set<string>();
	if (plan) {
		const order = topologicalStepIds(plan.steps);
		const byId = new Map(plan.steps.map((s) => [s.id, s]));
		for (const id of order) {
			const step = byId.get(id)!;
			const linkedIds = [...jobToStep.entries()].filter(([, stepId]) => stepId === step.id).map(([jobId]) => jobId);
			const linked = linkedIds.map((jobId) => jobById.get(jobId)).filter((job): job is DeskJobLike => Boolean(job));
			for (const jobId of linkedIds) claimed.add(jobId);
			const running = linked.find((j) => jobState(j) === "running");
			steps.push({
				id: step.id,
				title: step.title,
				declaredAgent: step.agent,
				executingAgent: running?.agent || step.agent || linked[0]?.agent || undefined,
				dependsOn: [...step.dependsOn],
				declaredStatus: step.status,
				state: aggregateState(linked, step.status),
				jobs: linked,
				unlinked: linked.length === 0,
			});
		}
	}

	const otherIds = new Set<string>();
	for (const jobId of requestedJobIds) if (!claimed.has(jobId)) otherIds.add(jobId);
	for (const job of jobs) if (!claimed.has(job.jobId)) otherIds.add(job.jobId);
	for (const jobId of missingJobIds) if (!claimed.has(jobId)) otherIds.add(jobId);

	const otherJobs: DeskJobLike[] = [];
	for (const jobId of otherIds) {
		const job = jobById.get(jobId);
		if (job) otherJobs.push(job);
	}

	if (!plan && requestedJobIds.length === 0) warnings.push("No plan entry and no recorded jobs on this branch yet.");

	return {
		planId: plan?.planId ?? null,
		revision: plan?.revision ?? null,
		steps,
		otherJobs,
		planMissing: plan === null,
		warnings,
	};
}
