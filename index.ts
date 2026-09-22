/**
 * Orchestrator extension — multi sub-agent job delegation runtime for pi.
 *
 * Architecture (see PROTOCOL.md / ARCHITECTURE.md):
 *
 *   FRONTIER MAIN AGENT (planner only; delegate/jobs tools; hard tool block)
 *     └── ORCHESTRATION CORE (core/orchestrator.ts)
 *           ├── routing (logical aliases → ModelRegistry → provider backends)
 *           ├── budgets, concurrency gates, event log, metrics
 *           ├── jobs → attempts (resume | fresh | escalation ladder)
 *           ├── deterministic validation, git-worktree isolation
 *           └── WORKERS = isolated `pi` subprocesses (core/spawn.ts)
 *                 OpenRouter today; local OpenAI-compatible later = config only
 *
 * The orchestrator never cares where inference happens.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import { parse as yamlParse } from "yaml";
import { discoverAgents, orchestratorRoot, type AgentConfig } from "./discovery.ts";
import { rosterText, orchestratorPrompt } from "./core/prompts.ts";
import { ModelRegistry } from "./core/models.ts";
import { Router, type RoutingRule } from "./core/routing.ts";
import { JobStore, readJson } from "./core/storage.ts";
import {
	collectMembershipBindings,
	collectMembershipJobIds,
	ProgressTracker,
	progressStatusText,
	PROGRESS_MEMBERSHIP_ENTRY_TYPE,
	stateFromEventType,
} from "./core/progress.ts";
import { EventLog } from "./core/events.ts";
import { BudgetManager } from "./core/budget.ts";
import { ConcurrencyManager } from "./core/concurrency.ts";
import type { AttentionItem, HumanQuestionHandler, InboxItem, InboxRequest, RoutedQuestion } from "./core/broker.ts";
import type { WorkerReply } from "./core/messaging.ts";
import { askUserQuestion, disposeQuestionUi } from "./ask-user.ts";
import { Orchestrator, type CreateJobInput, type RunReport } from "./core/orchestrator.ts";
import { PlannerTelemetryCollector, PlannerTelemetryStore } from "./core/telemetry.ts";
import { scaffoldOrchestratorFiles } from "./core/scaffold.ts";
import {
	buildPlanSnapshot,
	DEFAULT_CONCURRENCY,
	deriveAutoPlanSteps,
	PLAN_ENTRY_TYPE,
	PLAN_SCHEMA_VERSION,
	PLAN_STEP_STATUSES,
	readLatestPlan,
	renderPlanSummary,
	type ConcurrencyConfig,
	type ContextPack,
	type JobRecord,
	type PlanJobBinding,
	type PlanSnapshot,
} from "./core/types.ts";

const ORCHESTRATOR_TOOLS = new Set(["delegate", "jobs", "ask_user_question"]);
/** customType for pi.sendMessage notifications that must reach the main LLM. */
const MAIN_MESSAGE_TYPE = "orchestrator-message";
const MAX_PARALLEL_TASKS = 16;
const SUMMARY_CAP = 4 * 1024;
const PROGRESS_WIDGET_ID = "orchestrator-progress";
const PROGRESS_STATUS_KEY = "orchestrator";

const HERE = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function cap(text: string, bytes = SUMMARY_CAP): string {
	return Buffer.byteLength(text) <= bytes ? text : `${text.slice(0, bytes)}\n[… truncated — full details via jobs.read / jobs.artifact]`;
}

interface LoadedConfig {
	concurrency: ConcurrencyConfig;
	budgets: { perAttemptUsd?: number; perJobUsd?: number; dailyUsd?: number };
	routing: RoutingRule[];
}

function loadOrchestratorConfig(root: string): LoadedConfig {
	for (const name of ["config.yaml", "config.yml", "config.json"]) {
		const file = path.join(root, name);
		if (!fs.existsSync(file)) continue;
		try {
			const raw = fs.readFileSync(file, "utf-8");
			const cfg = name.endsWith(".json") ? JSON.parse(raw) : yamlParse(raw);
			return {
				concurrency: { ...DEFAULT_CONCURRENCY, ...(cfg.concurrency ?? {}) },
				budgets: cfg.budgets ?? {},
				routing: Array.isArray(cfg.routing?.rules) ? cfg.routing.rules : [],
			};
		} catch {
			/* fall through to defaults */
		}
	}
	return {
		concurrency: { ...DEFAULT_CONCURRENCY },
		budgets: {},
		routing: [],
	};
}

export default function (pi: ExtensionAPI) {
	// Never activate inside worker subprocesses: worker.ts owns those.
	if (process.env.PI_ORCHESTRATOR_SUBAGENT) return;

	const root = orchestratorRoot();
	let agents: AgentConfig[] = [];
	let mainAgent: AgentConfig | null = null;
	let enforceMain = false;
	let orch: Orchestrator | null = null;
	let registry: ModelRegistry | null = null;
	let plannerTelemetry: PlannerTelemetryCollector | null = null;

	// ── Live progress (Plan widget) — a projection of persisted job state ──
	let tracker = new ProgressTracker();
	let uiCtx: ExtensionContext | null = null;
	let unlistenProgress: (() => void) | null = null;
	const membershipLogged = new Set<string>();

	// ── Structured plan (persisted snapshots on the current branch) ──
	// Derived ONLY from `orchestrator.plan` entries on the current branch; no
	// cross-session cached state. Used to bind delegate aliases to plan steps.
	let latestPlan: PlanSnapshot | null = null;
	const bindingsLogged = new Set<string>();
	/** One concise source/capability diagnostic per loaded extension instance so
	 * a stale install (e.g. an old ~/.pi extension lacking structured plans) is
	 * diagnosable without repeating on every session. */
	let startupDiagnosticShown = false;

	/** Persist job MEMBERSHIP for this session branch (ids only — never a
	 * second copy of job state). Restore scans branch entries only, so two
	 * main sessions in the same cwd never inherit each other's jobs.
	 * `bindings` is the additive job↔plan-step association; readers that only
	 * read `jobIds` remain compatible. */
	function appendMembership(jobIds: string[], bindings: PlanJobBinding[] = []): void {
		const fresh = jobIds.filter((id) => !membershipLogged.has(id));
		const freshBindings = bindings.filter((b) => !bindingsLogged.has(`${b.jobId}\u0000${b.stepId}`));
		if (fresh.length === 0 && freshBindings.length === 0) return;
		try {
			for (const id of fresh) membershipLogged.add(id);
			for (const b of freshBindings) bindingsLogged.add(`${b.jobId}\u0000${b.stepId}`);
			const data: { jobIds: string[]; bindings?: PlanJobBinding[] } = { jobIds: fresh };
			if (freshBindings.length > 0) data.bindings = freshBindings;
			pi.appendEntry(PROGRESS_MEMBERSHIP_ENTRY_TYPE, data);
		} catch {
			/* membership persistence is best effort */
		}
	}

	/** Current plan-step bindings for freshly created/referenced job ids: a step
	 * binds when its id equals the job alias id or it lists the job in jobIds. */
	function planBindingsForJobs(jobIds: string[]): PlanJobBinding[] {
		if (!latestPlan) return [];
		const out: PlanJobBinding[] = [];
		for (const jobId of jobIds) {
			for (const step of latestPlan.steps) {
				if (step.id === jobId || step.jobIds.includes(jobId)) out.push({ jobId, stepId: step.id });
			}
		}
		return out;
	}

	/** Branch-scoped plan read for the automatic fallback: latestPlan is the
	 * live branch snapshot, but a fresh extension instance (no session_start
	 * yet) can still recover from the branch. Never a cross-session cache. */
	function readBranchPlan(ctx: ExtensionContext): PlanSnapshot | null {
		try {
			return readLatestPlan(ctx.sessionManager.getBranch() as readonly unknown[]);
		} catch {
			return null;
		}
	}

	/** Best-effort structured-plan publication for a delegate call whose model
	 * omitted `jobs action=plan`. Steps are derived from the created JobRecords
	 * BEFORE any run starts; explicit plan steps always win (only missing steps
	 * are appended, titles/statuses are never replaced). A publication that
	 * cannot be made safe returns a diagnosis and NEVER blocks delegation. */
	function autoPublishPlan(ctx: ExtensionContext, jobs: readonly JobRecord[], titles: ReadonlyMap<string, string>): { note?: string; bindings: PlanJobBinding[] } {
		const jobIds = jobs.map((job) => job.jobId);
		const previous = latestPlan ?? readBranchPlan(ctx);
		const derivation = deriveAutoPlanSteps({
			previous,
			jobs: jobs.map((job) => ({ jobId: job.jobId, agent: job.agent, objective: job.objective, dependsOn: job.dependsOn, title: titles.get(job.jobId) })),
		});
		if (derivation.steps.length === 0) {
			const note = derivation.diagnostics.length > 0 ? `structured plan: ${derivation.diagnostics.join("; ")}` : undefined;
			return { note, bindings: planBindingsForJobs(jobIds) };
		}
		const revision = buildPlanSnapshot({ previous, steps: derivation.steps });
		if (!revision.ok) {
			return { note: `structured plan auto-publication skipped: ${revision.errors.join("; ")}`, bindings: planBindingsForJobs(jobIds) };
		}
		try {
			pi.appendEntry(PLAN_ENTRY_TYPE, revision.snapshot);
			latestPlan = revision.snapshot;
		} catch (err) {
			return { note: `structured plan auto-publication failed: ${(err as Error).message}`, bindings: planBindingsForJobs(jobIds) };
		}
		const note = derivation.diagnostics.length > 0 ? `structured plan: ${derivation.diagnostics.join("; ")}` : undefined;
		return { note, bindings: planBindingsForJobs(jobIds) };
	}

	/** Track a job explicitly referenced by this session (jobs.wait/retry/
	 * followup on an older job): sync its persisted state into the projection
	 * and record membership. Raw store read — side-effect-free, no recovery. */
	function trackExplicitJob(jobId: string): void {
		try {
			const job = orch?.store.readJob(jobId);
			if (!job) return;
			if (tracker.sync([job])) refreshProgressUI();
			appendMembership([jobId], planBindingsForJobs([jobId]));
		} catch {
			/* best effort */
		}
	}

	/** Restore tracked jobs from the CURRENT branch's membership entries only.
	 * Raw store.readJob per id (no listJobs — its recovery mutates state),
	 * finished included within the display budget (tracker prunes). Also
	 * re-derives the active structured plan from `orchestrator.plan` entries. */
	function restoreProgressFromBranch(ctx: ExtensionContext): void {
		try {
			const branch = ctx.sessionManager.getBranch() as readonly unknown[];
			const ids = collectMembershipJobIds(branch);
			for (const id of ids) membershipLogged.add(id);
			// Restore binding dedupe state too: otherwise a retry/followup after a
			// reload re-appends an already-persisted binding-only membership entry.
			for (const binding of collectMembershipBindings(branch)) bindingsLogged.add(`${binding.jobId}\u0000${binding.stepId}`);
			latestPlan = readLatestPlan(branch);
			const jobs = ids
				.map((id) => orch?.store.readJob(id))
				.filter((j): j is JobRecord => Boolean(j));
			tracker.sync(jobs);
			// Always refresh: the caller just reset the tracker, so an empty result
			// must CLEAR stale widget lines from a previous branch/session too.
			refreshProgressUI();
		} catch {
			/* progress restore must never break session start */
		}
	}

	/** One-time cleanup for the removed above-editor Plan widget: a stale copy
	 * from an older extension version is cleared on session start, branch
	 * navigation, and shutdown. This key is never set to a non-empty payload
	 * again — plan/progress detail lives in the workspace/sidebar view, and only
	 * the compact footer status is owned here. */
	function clearProgressWidget(ctx: ExtensionContext | null): void {
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setWidget(PROGRESS_WIDGET_ID, undefined);
		} catch {
			/* progress UI must never break orchestration */
		}
	}

	/** Project tracked jobs into the compact footer status only. */
	function refreshProgressUI(): void {
		const ctx = uiCtx;
		if (!ctx) return;
		try {
			if (!ctx.hasUI) return;
			const tasks = tracker.snapshot();
			ctx.ui.setStatus(PROGRESS_STATUS_KEY, progressStatusText(tasks) || undefined);
		} catch {
			/* progress UI must never break orchestration */
		}
	}

	/** Observe in-process runtime transitions via the EventLog seam and project
	 * them into the widget. Tracked jobs = restored branch membership + jobs
	 * created by this session's own tool calls; every other session's jobs are
	 * invisible. Side-effect-free: raw store reads only. */
	function attachProgressListener(): void {
		if (!orch || unlistenProgress) return;
		unlistenProgress = orch.events.onEvent((event) => {
			try {
				if (event.type !== "job.created" && !tracker.has(event.jobId)) return;
				// Raw persisted state only — never orch.readJob(), whose crash
				// recovery would falsely mark a legitimately running attempt as
				// interrupted. EventLog appends happen after the matching state
				// write, so the projection is always current.
				const job = orch?.store.readJob(event.jobId);
				if (job && tracker.sync([job])) refreshProgressUI();
			} catch {
				/* observer isolation: UI state never affects jobs */
			}
		});
	}

	function resetProgress(): void {
		unlistenProgress?.();
		unlistenProgress = null;
		tracker = new ProgressTracker();
		membershipLogged.clear();
		bindingsLogged.clear();
		latestPlan = null;
	}

	/** Stream real transition states for a single job into the tool's partial
	 * result. Only states CONFIRMED by runtime events are emitted ("running"
	 * only after attempt.started — never before the scheduler); terminal truth
	 * arrives via the final tool report. Exceptions isolated. */
	function streamJobEvents(o: Orchestrator, jobId: string, onUpdate: ((u: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined): () => void {
		let last: string | null = "queued"; // callers already announce the queued baseline
		return o.events.onEvent((event) => {
			if (event.jobId !== jobId) return;
			const state = stateFromEventType(event.type);
			if (!state || state === last) return;
			last = state;
			try {
				onUpdate?.({ content: [{ type: "text", text: `job ${jobId}: ${state}` }], details: { jobId } });
			} catch {
				/* progress UI must never affect jobs */
			}
		});
	}

	/** Adapter from pi's tool onUpdate callback to the loose streaming shape. */
	function toolStream(onUpdate: unknown): ((u: { content: { type: "text"; text: string }[]; details?: unknown }) => void) | undefined {
		if (typeof onUpdate !== "function") return undefined;
		return (u) => {
			(onUpdate as (x: unknown) => void)(u);
		};
	}

	// ── Live messaging (phase 2): attention yielding + background runs ──────
	//
	// delegate and jobs.wait normally BLOCK the main LLM until the run
	// finishes. When a worker sends a message or an ask_main request, the
	// blocking tool returns EARLY with the running job ids and pending request
	// ids while the actual run promise continues, tracked here. Later worker
	// attention and background completions reach the main model through
	// pi.sendMessage typed custom messages (deduplicated by inbox item id).

	interface AttentionRace {
		jobIds: Set<string>;
		deliver: (attention: AttentionItem) => void;
	}

	interface BackgroundRun {
		key: string;
		jobIds: string[];
		controller: AbortController;
		onSettled?: () => void;
	}

	let activeRaces: AttentionRace[] = [];
	let backgroundRuns = new Map<string, BackgroundRun>();
	let unlistenAttention: (() => void) | null = null;
	const notifiedAttention = new Set<string>();

	/** Wire the current orchestrator's broker to this session (attention + human questions). */
	function attachLiveMessaging(): void {
		if (!orch) return;
		unlistenAttention?.();
		unlistenAttention = orch.onAttention(dispatchAttention);
		orch.setHumanQuestionHandler(handleRoutedQuestion);
	}

	/** New attention: hand it to a blocking tool racing on these jobs, else wake the main model. */
	function dispatchAttention(attention: AttentionItem): void {
		for (const race of activeRaces) {
			if (race.jobIds.has(attention.jobId)) {
				race.deliver(attention);
				return;
			}
		}
		notifyMain(attention);
	}

	/** Wake the main LLM with a typed custom message (deduplicated; never raw streams). */
	function notifyMain(attention: AttentionItem): void {
		if (notifiedAttention.has(attention.id)) return;
		notifiedAttention.add(attention.id);
		if (notifiedAttention.size > 1000) notifiedAttention.clear();
		try {
			// Custom messages participate in LLM context; triggerTurn wakes an
			// idle main agent, deliverAs steer delivers before the next LLM call when busy.
			pi.sendMessage({ customType: MAIN_MESSAGE_TYPE, content: renderAttentionText(attention), display: true }, { triggerTurn: true, deliverAs: "steer" });
		} catch {
			/* notifications must never break orchestration */
		}
	}

	function renderAttentionText(attention: AttentionItem): string {
		if (attention.kind === "message" && attention.message) {
			return `[orchestrator] message from worker job ${attention.message.jobId}: ${attention.message.text}\n(One-way message_main — no reply is expected.)`;
		}
		if (attention.request) {
			const r = attention.request;
			return [
				`[orchestrator] job ${r.jobId} (agent ${r.agent}) is BLOCKED waiting for your answer — requestId: ${r.requestId}`,
				r.question,
				`Answer with: jobs action=reply jobId=${r.jobId} requestId=${r.requestId} answer="..." (times out after ${r.timeoutSeconds}s)`,
			].join("\n");
		}
		return "[orchestrator] worker attention";
	}

	function notifyBackgroundCompletion(text: string): void {
		try {
			pi.sendMessage({ customType: MAIN_MESSAGE_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "steer" });
		} catch {
			/* notifications must never break orchestration */
		}
	}

	function renderReportNotification(report: RunReport): string {
		return `[orchestrator] background job ${report.jobId} finished: ${report.status}${report.summaryForOrchestrator ? `\n${cap(report.summaryForOrchestrator, 2 * 1024)}` : ""}`;
	}

	/** Race a run promise against NEW attention on the given jobs; exactly one outcome wins. */
	function raceRunAttention<T>(run: Promise<T>, jobIds: Set<string>): Promise<{ attention?: AttentionItem; report?: T; error?: Error }> {
		return new Promise((resolve) => {
			const race: AttentionRace = {
				jobIds,
				deliver: (attention) => {
					remove();
					resolve({ attention });
				},
			};
			const remove = () => {
				const i = activeRaces.indexOf(race);
				if (i >= 0) activeRaces.splice(i, 1);
			};
			activeRaces.push(race);
			run.then(
				(report) => {
					remove();
					resolve({ report });
				},
				(error) => {
					remove();
					resolve({ error: error instanceof Error ? error : new Error(String(error)) });
				},
			);
		});
	}

	/** Track a run continuing in the background after a yield; notify the main model on settle. */
	function registerBackgroundRun(key: string, jobIds: string[], controller: AbortController, run: Promise<RunReport | RunReport[]>, onSettled?: () => void): void {
		const tracked: BackgroundRun = { key, jobIds, controller, onSettled };
		backgroundRuns.set(key, tracked);
		Promise.resolve(run).then(
			(report) => {
				if (backgroundRuns.get(key) === tracked) backgroundRuns.delete(key);
				tracked.onSettled?.();
				notifyBackgroundCompletion(Array.isArray(report) ? report.map(renderReportNotification).join("\n\n") : renderReportNotification(report));
			},
			(err) => {
					if (backgroundRuns.get(key) === tracked) backgroundRuns.delete(key);
				tracked.onSettled?.();
				notifyBackgroundCompletion(`[orchestrator] background run failed: ${err instanceof Error ? err.message : String(err)}`);
			},
		);
	}

	/** The EARLY tool result that hands attention back to the main model. */
	function renderYieldResult(items: InboxItem[], jobIds: string[], source: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: boolean } {
		const pending = items.filter((i): i is InboxRequest => i.type === "request" && i.status === "pending" && i.kind === "ask_main");
		const userQuestions = items.filter((i): i is InboxRequest => i.type === "request" && i.status === "pending" && i.kind === "ask_user_question");
		const messages = items.filter((i) => i.type === "message");
		const lines: string[] = [];
		lines.push(`${source} yielded — ${jobIds.join(", ")} ${jobIds.length === 1 ? "is" : "are"} still RUNNING in the background.`);
		if (messages.length > 0) {
			lines.push("Messages:");
			for (const m of messages) lines.push(`- [${m.direction === "worker" ? "worker" : "main"} · job ${m.jobId}] ${m.text}`);
		}
		for (const r of pending) {
			lines.push(`PENDING ask_main from job ${r.jobId} (agent ${r.agent}) — requestId: ${r.requestId}`);
			lines.push(`Question: ${r.question}`);
			lines.push(`Answer with: jobs action=reply jobId=${r.jobId} requestId=${r.requestId} answer="..." (times out after ${r.timeoutSeconds}s)`);
		}
		for (const r of userQuestions) {
			lines.push(`A question for the USER from job ${r.jobId} (agent ${r.agent}) is open in the UI: ${r.question}`);
		}
		lines.push("The background run continues and you will be notified when it finishes. Keep working or wait; do NOT re-delegate, retry, or follow up these jobs while they run — use jobs action=message to send guidance to a live worker.");
		return { content: [{ type: "text", text: lines.join("\n") }], details: { yielded: true, jobIds, pendingRequests: pending }, isError: false };
	}

	/** Human-question seam: render a worker-routed ask_user_question in the main session UI. */
	const handleRoutedQuestion: HumanQuestionHandler = async (routed: RoutedQuestion, rpc): Promise<WorkerReply> => {
		const ctx = uiCtx;
		const identity = `job ${routed.jobId} · agent ${routed.agent} · attempt ${routed.attemptId}`;
		if (!ctx || ctx.hasUI === false || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
			return { status: "unavailable", reason: "no interactive UI is attached to the orchestrator main session; re-run the job where the main agent has a UI" };
		}
		const out = await askUserQuestion(
			ctx,
			{
				question: routed.request.question,
				options: routed.request.options,
				allowCustom: routed.request.allowCustom ?? true,
				timeoutSeconds: routed.request.timeoutSeconds,
			},
			{ identity, signal: rpc.signal },
		);
		switch (out.status) {
			case "answered":
				return { status: "answered", answer: out.answer };
			case "cancelled":
				return { status: "cancelled" };
			case "timeout":
				return { status: "timeout" };
			default:
				return { status: "unavailable", reason: out.reason };
		}
	};

	/** Session teardown: dispose races, background runs, pending questions, broker state. */
	function teardownLiveMessaging(): void {
		unlistenAttention?.();
		unlistenAttention = null;
		activeRaces = [];
		for (const run of backgroundRuns.values()) {
			try {
				run.controller.abort();
			} catch {
					/* best effort */
			}
			run.onSettled?.();
		}
		backgroundRuns.clear();
		notifiedAttention.clear();
		disposeQuestionUi();
		try {
			orch?.broker.dispose();
		} catch {
			/* best effort */
		}
	}

	function buildRuntime(cwd: string, sessionModel?: { provider?: string; model?: string; effort?: string }) {
		const discovery = discoverAgents(cwd, { includeProject: false });
		agents = discovery.agents;
		mainAgent = discovery.main;
		enforceMain = Boolean(mainAgent);

		registry = new ModelRegistry(root);
		const cfg = loadOrchestratorConfig(root);
		const store = new JobStore(root);
		const plannerStore = new PlannerTelemetryStore(root);
		plannerTelemetry = new PlannerTelemetryCollector(plannerStore);
		orch = new Orchestrator({
			root,
			agentsRoot: discovery.userAgentsDir,
			workerExtensionPath: path.join(HERE, "worker.ts"),
			registry,
			router: new Router(registry, cfg.routing),
			concurrency: new ConcurrencyManager(cfg.concurrency),
			budgets: new BudgetManager(root),
			events: new EventLog(store.jobsDir()),
			store,
			plannerTelemetry: plannerStore,
			defaults: { model: sessionModel, budget: cfg.budgets, concurrency: cfg.concurrency },
		});
		for (const reg of registry.providerRegistrations()) {
			try {
				pi.registerProvider(reg.name, reg.config);
			} catch {
				/* provider already registered */
			}
		}
		return orch;
	}

	function requireOrch(ctxCwd: string, sessionModel?: { provider?: string; model?: string; effort?: string }): Orchestrator {
		if (!orch || !registry) return buildRuntime(ctxCwd, sessionModel);
		// refresh agents cheaply so newly added agents work without /reload
		const discovery = discoverAgents(ctxCwd, { includeProject: false });
		agents = discovery.agents;
		mainAgent = discovery.main;
		enforceMain = Boolean(mainAgent);
		return orch;
	}

	async function loadMainHooks(cwd: string) {
		const discovery = discoverAgents(cwd, { includeProject: false });
		for (const agent of discovery.agents) {
			for (const hookPath of agent.mainHookPaths) {
				try {
					const mod = await import(hookPath);
					const factory = mod?.default ?? mod;
					if (typeof factory === "function") factory(pi);
				} catch (err) {
					// eslint-disable-next-line no-console
					console.error(`[orchestrator] failed to load main hook ${hookPath}:`, err);
				}
			}
		}
	}

	// ── Main agent lockdown + config ───────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const sessionModel = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, effort: ctx.thinkingLevel } : undefined;
		buildRuntime(ctx.cwd, sessionModel);
		await loadMainHooks(ctx.cwd);

		// Live progress: fresh projection per session. Restore ONLY job ids
		// recorded as owned/referenced by THIS branch (membership entries);
		// finished referenced jobs reappear within the display budget. Same-cwd
		// other sessions and raw history never leak in. Persisted JobRecords
		// stay the sole source of truth — the tracker is a display projection.
		resetProgress();
		uiCtx = ctx;
		clearProgressWidget(ctx);
		attachProgressListener();
		restoreProgressFromBranch(ctx);
		// Live messaging: the fresh Orchestrator's broker is session-owned.
		attachLiveMessaging();
		// Concise startup diagnostic: which orchestrator source loaded and whether
		// this build carries structured-plan publishing. No secrets, once per load.
		const sourceDiagnostic = `src:${path.join(HERE, "index.ts")} · structured-plan:v${PLAN_SCHEMA_VERSION}`;
		if (!enforceMain) {
			if (!startupDiagnosticShown) {
				startupDiagnosticShown = true;
				ctx.ui.notify(`orchestrator: no main agent — lockdown INACTIVE · ${sourceDiagnostic}`, "info");
			}
			return;
		}

		const allToolNames = pi.getAllTools().map((tool) => tool.name);
		pi.setActiveTools(allToolNames.filter((name) => ORCHESTRATOR_TOOLS.has(name)));

		const userPickedModel = Boolean(process.env.PI_MODEL || process.argv.some((a) => a === "--model" || a.startsWith("--model=")));
		if (!userPickedModel && mainAgent?.runtime) {
			const ref = mainAgent.runtime.model ?? (mainAgent.runtime.provider ? `${mainAgent.runtime.provider}/${mainAgent.runtime.model ?? ""}` : undefined);
			if (ref && registry) {
				try {
					const resolved = registry.resolve(ref);
					const model = ctx.modelRegistry.find(resolved.concrete.provider, resolved.concrete.model);
					if (model) await pi.setModel(model);
				} catch {
					/* keep session model */
				}
			}
			if (mainAgent.runtime.effort) {
				try {
					pi.setThinkingLevel(mainAgent.runtime.effort as Parameters<typeof pi.setThinkingLevel>[0]);
				} catch {
					/* unsupported */
				}
			}
		}
		ctx.ui.notify(
			`orchestrator: main locked to delegate/jobs · ${agents.filter((a) => a.role === "sub").length} agents · models: ${registry?.aliases().join(", ") || "(none — using session model)"} · ${sourceDiagnostic}`,
			"info",
		);
	});

	// Clear progress UI + observers on teardown (quit, /reload, session swap).
	pi.on("session_shutdown", async (_event, ctx) => {
		resetProgress();
		teardownLiveMessaging();
		uiCtx = null;
		clearProgressWidget(ctx);
		try {
			if (ctx.hasUI) ctx.ui.setStatus(PROGRESS_STATUS_KEY, undefined);
		} catch {
			/* best effort */
		}
	});

	// Branch navigation: re-project from the NEW branch's membership entries.
	pi.on("session_tree", async (_event, ctx) => {
		resetProgress();
		uiCtx = ctx;
		clearProgressWidget(ctx);
		attachProgressListener();
		restoreProgressFromBranch(ctx);
	});

	// Main planner telemetry uses Pi's documented lifecycle. Worker subprocesses
	// never load this extension, so their usage remains solely in AttemptRecord.
	pi.on("agent_start", (_event, ctx) => {
		plannerTelemetry?.start(ctx.model?.provider ?? "unknown", ctx.model?.id ?? "unknown");
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		plannerTelemetry?.addAssistant(event.message);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const record = plannerTelemetry?.finish({
			id: ctx.sessionManager.getSessionId(),
			path: ctx.sessionManager.getSessionFile(),
		});
		if (!record) return;
		pi.appendEntry("orchestrator.planner-telemetry", record);
		pi.events.emit("orchestrator:metrics", { planner: record });
	});

	pi.on("tool_call", async (event) => {
		if (!enforceMain || ORCHESTRATOR_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason:
				"You are the ORCHESTRATOR. Direct tool calls are blocked — decompose this into a job and use `delegate` (inspect with `jobs`). See the orchestrator section of your system prompt.",
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!enforceMain || !registry) return;
		const aliasLines = registry.aliases().length
			? registry.aliases().map((a) => {
					try {
						const r = registry!.resolve(a);
						return `- ${a} → ${r.concrete.provider}/${r.concrete.model}`;
					} catch {
						return `- ${a} → (unresolved)`;
					}
				})
			: ["(registry empty — workers inherit the main session model; configure ~/.pi/orchestrator/models.yaml)"];
		return {
			systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt({
				mainInstructions: mainAgent?.systemPrompt,
				roster: rosterText(agents),
				aliases: aliasLines.join("\n"),
			})}`,
		};
	});

	// ── delegate tool ──────────────────────────────────────────────────────
	const ContextSchema = Type.Object({
		background: Type.Optional(Type.String({ description: "Short prose background the worker needs (it cannot see this conversation)" })),
		relevantFiles: Type.Optional(Type.Array(Type.String(), { description: "Repo-relative files relevant to the task" })),
		relevantSymbols: Type.Optional(Type.Array(Type.String())),
		constraints: Type.Optional(Type.Array(Type.String())),
		acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria the worker must satisfy" })),
	});

	const JobInput = Type.Object({
		agent: Type.String({ description: "Sub agent name from the roster" }),
		task: Type.String({ description: "Fully self-contained task: what to do, exact paths/symbols/commands, acceptance criteria" }),
		title: Type.Optional(Type.String({ description: "Optional clear plan-step title for this job (defaults to the first sentence of task)" })),
		context: Type.Optional(ContextSchema),
		kind: Type.Optional(StringEnum(["implementation", "research", "test-writing", "debugging", "review", "other"] as const)),
		id: Type.Optional(Type.String({ description: "Stable job id/alias for dependency references (auto-generated if omitted)" })),
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Job ids that must succeed first (enables DAG scheduling)" })),
		model: Type.Optional(Type.String({ description: "Logical model alias override (worker-cheap / worker-best / frontier) — routing normally decides" })),
		cwd: Type.Optional(Type.String()),
		retry: Type.Optional(Type.Object({
			maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
			enabled: Type.Optional(Type.Boolean({ description: "false → single attempt, no ladder" })),
		})),
		run: Type.Optional(Type.Boolean({ description: "false → create job only (schedule later with jobs.wait/graph or another delegate). Default true." })),
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Create and run jobs for sub agents (isolated pi workers with their own model/tools/session/workspace).",
			"Modes (exactly one): single {agent,task}, batch {jobs:[...]} — batch jobs may declare dependsOn (by id) forming a DAG; independent jobs run concurrently under configured limits.",
			"Workers write a validated result.json; you receive only status/summary/validation/blockers/artifact refs/usage. Retry ladder (cheap fresh retry → worker-best → frontier) runs automatically on failure when retry is enabled.",
		].join(" "),
		promptSnippet: "Delegate jobs to sub agents (single or DAG batch); workers return validated structured results",
		promptGuidelines: [
			"Use delegate for ALL work requiring file access, commands, search, images, or code changes — the orchestrator has no direct tools.",
			"You own synthesis, diagnosis, and design; use delegate for bounded work — workers collect facts or implement decided changes, not open-ended architecture.",
			"Write delegate tasks for a focused cheap model with zero conversation context: objective, exact targets, chosen approach/steps, boundaries/non-goals, expected cases, and the validation command.",
			"Use delegate with the fewest coherent jobs: keep related changes and their specified tests together, batch only independent jobs with dependsOn, and never create one job per file or command.",
			"Use delegate followup for related bounded corrections; let the automatic retry ladder handle execution errors and replan a bad specification instead of retrying it.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String()),
			task: Type.Optional(Type.String()),
			title: Type.Optional(Type.String({ description: "Optional clear plan-step title (falls back to the first sentence of task)" })),
			context: Type.Optional(ContextSchema),
			kind: Type.Optional(StringEnum(["implementation", "research", "test-writing", "debugging", "review", "other"] as const)),
			id: Type.Optional(Type.String()),
			model: Type.Optional(Type.String()),
			cwd: Type.Optional(Type.String()),
			retry: Type.Optional(Type.Object({
				maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
				enabled: Type.Optional(Type.Boolean()),
			})),
			jobs: Type.Optional(Type.Array(JobInput, { description: "Batch of jobs (DAG via id/dependsOn), max 16" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const o = requireOrch(ctx.cwd, ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, effort: ctx.thinkingLevel } : undefined);
			const sessionModel = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, effort: ctx.thinkingLevel } : undefined;

			const hasBatch = (params.jobs?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			if (hasBatch === hasSingle) {
				return {
					content: [{ type: "text" as const, text: "Provide exactly one mode: {agent,task} or {jobs:[...]}" }],
					details: {},
					isError: true,
				};
			}

			const toInput = (j: {
				agent: string; task: string; context?: Partial<ContextPack>; kind?: string; id?: string; dependsOn?: string[]; model?: string; cwd?: string; retry?: { maxAttempts?: number; enabled?: boolean };
			}): CreateJobInput & { autoRun: boolean } => ({
				agent: j.agent,
				task: j.task,
				context: j.context,
				kind: j.kind,
				jobId: j.id,
				dependsOn: j.dependsOn,
				model: j.model,
				cwd: j.cwd ?? ctx.cwd,
				retry: j.retry?.enabled === false ? { maxAttempts: 1, ladder: [] } : j.retry?.maxAttempts ? { maxAttempts: j.retry.maxAttempts } : undefined,
				autoRun: true,
				signal,
			});

			try {
				if (hasSingle) {
					const input = toInput({ ...params, agent: params.agent!, task: params.task! });
					const job = o.createJob(input, agents);
					const auto = autoPublishPlan(ctx, [job], params.title ? new Map([[job.jobId, params.title]]) : new Map());
					appendMembership([job.jobId], auto.bindings);
					try {
						onUpdate?.({ content: [{ type: "text" as const, text: `job ${job.jobId} created (${params.agent}) — queued${auto.note ? `\n${auto.note}` : ""}` }], details: { jobId: job.jobId } });
					} catch {
						/* progress UI must never affect jobs */
					}
					// Stream real transitions ("running" only once attempt.started
					// confirms it); terminal truth arrives via the final report — or the
					// early yield below when the worker needs the main agent's attention.
					const unstream = streamJobEvents(o, job.jobId, toolStream(onUpdate));
					// Abort ownership: while this tool actively waits, its signal cancels
					// the work; after a messaging yield the background run is owned by
					// jobs cancel + session shutdown instead (the tool finalizing must
					// never abort a still-running worker).
					const runController = new AbortController();
					const forwardAbort = () => runController.abort();
					if (signal?.aborted) runController.abort();
					else signal?.addEventListener("abort", forwardAbort, { once: true });
					const launched = o.runJob(job, agents, runController.signal);
					const raced = await raceRunAttention(launched, new Set([job.jobId]));
					if (raced.attention) {
						// DEADLOCK-FREE yielding: return EARLY with the pending request
						// ids while the run continues, tracked in the background.
						signal?.removeEventListener("abort", forwardAbort);
						registerBackgroundRun(job.jobId, [job.jobId], runController, launched, unstream);
						const items = o.inbox(job.jobId); // reading consumes the attention
						return renderYieldResult(items, [job.jobId], "delegate");
					}
					unstream();
					if (raced.error) throw raced.error;
					const report: RunReport = raced.report!;
					try {
						onUpdate?.({ content: [{ type: "text" as const, text: `job ${job.jobId}: ${report.status}` }], details: { jobId: job.jobId } });
					} catch {
						/* progress UI must never affect jobs */
					}
					return renderRunReport(report);
				}

				if (params.jobs!.length > MAX_PARALLEL_TASKS) {
					return { content: [{ type: "text" as const, text: `Too many jobs (${params.jobs!.length}); max ${MAX_PARALLEL_TASKS}.` }], details: {}, isError: true };
				}
				const created: JobRecord[] = [];
				const titleById = new Map<string, string>();
				for (const j of params.jobs!) {
					const record = o.createJob(toInput(j), agents);
					created.push(record);
					if (j.title) titleById.set(record.jobId, j.title);
				}
				const auto = autoPublishPlan(ctx, created, titleById);
				const createdIds = created.map((c) => c.jobId);
				appendMembership(createdIds, auto.bindings);
				try {
					onUpdate?.({ content: [{ type: "text" as const, text: `created ${created.length} jobs — running DAG…${auto.note ? `\n${auto.note}` : ""}` }], details: { jobIds: createdIds } });
				} catch {
					/* progress UI must never affect jobs */
				}
				// Stream per-job results as they settle so partially-completed batches
				// are visible while the remaining jobs keep running.
				const settled: RunReport[] = [];
				// Abort ownership mirrors the single path: after a messaging yield the
				// DAG continues in the background (jobs cancel + shutdown own it).
				const runController = new AbortController();
				const forwardAbort = () => runController.abort();
				if (signal?.aborted) runController.abort();
				else signal?.addEventListener("abort", forwardAbort, { once: true });
				const launched = o.runGraph(agents, {
					signal: runController.signal,
					jobIds: created.map((c) => c.jobId),
					onJobUpdate: (report) => {
						try {
							settled.push(report);
							onUpdate?.({
								content: [{ type: "text" as const, text: `DAG progress: ${settled.length}/${created.length} finished — ${report.jobId}: ${report.status}` }],
								details: { reports: [...settled] } as Record<string, unknown>,
							});
						} catch {
							/* progress UI must never affect jobs */
						}
					},
				});
				const raced = await raceRunAttention(launched, new Set(createdIds));
				if (raced.attention) {
					// Yield the batch: the DAG (including dependent waits) continues
					// in the background; dependencies still await actual results.
					signal?.removeEventListener("abort", forwardAbort);
					registerBackgroundRun(created[0].jobId, createdIds, runController, launched);
					const items = createdIds.flatMap((id) => o.inbox(id)); // consumes the attention
					return renderYieldResult(items, createdIds, "delegate batch");
				}
				if (raced.error) throw raced.error;
				return renderRunReports(raced.report!, created);
			} catch (e) {
				const err = e as Error & { detail?: { available?: string[] } };
				return {
					content: [{ type: "text" as const, text: `delegate failed: ${err.message}${err.detail?.available ? `\nAvailable agents: ${err.detail.available.join(", ")}` : ""}` }],
					details: {},
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const a = args as { agent?: string; task?: string; jobs?: { agent?: string; task?: string; dependsOn?: string[] }[] };
			const items: { agent?: string; task?: string; dependsOn?: string[] }[] = a.jobs ?? (a.agent ? [{ agent: a.agent, task: a.task }] : []);
			let text = `${theme.fg("toolTitle", theme.bold("delegate "))}${theme.fg("muted", items.length > 1 ? `[${items.length} jobs]` : "")}`;
			for (const j of items.slice(0, 4)) {
				const preview = String(j.task ?? "").slice(0, 60);
				text += `\n  ${theme.fg("accent", String(j.agent))}${j.dependsOn?.length ? theme.fg("warning", ` ⇠ ${j.dependsOn.join(",")}`) : ""} ${theme.fg("dim", preview)}`;
			}
			if (items.length > 4) text += `\n  ${theme.fg("muted", `… +${items.length - 4} more`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			const details = result.details as { reports?: RunReport[] } | undefined;
			if (!expanded && details?.reports) {
				const lines = details.reports.map((r) => {
					const icon = r.status === "success" ? theme.fg("success", "✓") : r.status === "failed" ? theme.fg("error", "✗") : theme.fg("warning", "◌");
					return `${icon} ${r.jobId}: ${r.status} (${r.attempts.length} attempt${r.attempts.length !== 1 ? "s" : ""})`;
				});
				return new Text(`${lines.join("\n")}\n${theme.fg("muted", "(Ctrl+O to expand)")}`, 0, 0);
			}
			return new Text(text, 0, 0);
		},
	});

	// ── jobs tool (§24 primitive surface) ─────────────────────────────────
	pi.registerTool({
		name: "jobs",
		label: "Jobs",
		description:
			"Job runtime control & inspection. Actions: list | status <jobId> | read <jobId> (canonical result.json summary) | artifact <jobId,path[,attemptId]> | graph | events <jobId> | attempts <jobId> | followup <jobId,message> (resume worker session — cheapest) | retry <jobId[,strategy=resume|fresh][,model=alias]> | cancel <jobId> | wait <jobId[,jobId...]> (yields early when a worker messages or asks) | inbox [jobId] (live messages + pending requests) | message <jobId,message> (steer a LIVE worker; delivered only on ACK) | reply <jobId,requestId,answer> (answer a pending ask_main) | plan steps=[...] (publish/revise the structured plan) | metrics.",
		promptSnippet: "Job control: list/status/read/artifact/graph/events/attempts/followup/retry/cancel/wait/inbox/message/reply/plan/metrics",
		promptGuidelines: [
			"Publish the structured plan with jobs action=plan BEFORE delegating for any multi-step task; each step needs a stable id and a clear human-readable title, and the step id should equal the delegate job alias id (delegate id=...) so the workspace can bind them.",
			"Omit unchanged steps when revising a plan — they are retained; only real changes need a new revision, and statuses advance planned → running → completed/failed/blocked/cancelled/superseded.",
			"Use jobs.followup for small corrections (resumes the worker's session); use jobs.retry strategy=fresh when the worker is stuck, optionally escalating model (worker-best, frontier).",
			"Use jobs.read and jobs.artifact to pull details on demand — never request full logs into context.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["list", "status", "read", "artifact", "graph", "events", "attempts", "followup", "retry", "cancel", "wait", "inbox", "message", "reply", "plan", "metrics"] as const,
			),
			jobId: Type.Optional(Type.String()),
			path: Type.Optional(Type.String({ description: "artifact relative path (action: artifact)" })),
			attemptId: Type.Optional(Type.String()),
			message: Type.Optional(Type.String({ description: "follow-up instruction (action: followup)" })),
			strategy: Type.Optional(StringEnum(["resume", "fresh"] as const, { description: "retry strategy (default: fresh)" })),
			model: Type.Optional(Type.String({ description: "logical alias override for retry (worker-cheap/worker-best/frontier)" })),
			requestId: Type.Optional(Type.String({ description: "pending ask_main request id (actions: reply)" })),
			answer: Type.Optional(Type.String({ description: "answer text for a pending ask_main request (actions: reply)" })),
			planId: Type.Optional(Type.String({ description: "stable plan id (omit to continue the current branch's plan)" })),
			steps: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "stable step id; use the delegate job alias id to bind step ↔ job" }),
						title: Type.String({ description: "clear human-readable title (what changes, not 'step 1')" }),
						agent: Type.Optional(Type.String({ description: "sub agent name from the roster" })),
						dependsOn: Type.Optional(Type.Array(Type.String(), { description: "step ids that must finish first" })),
						jobIds: Type.Optional(Type.Array(Type.String(), { description: "existing job ids this step links to" })),
						status: Type.Optional(StringEnum(PLAN_STEP_STATUSES, { description: "declared step status (default: planned)" })),
					}),
					{ description: "plan revision steps (max 64); omitted previous steps are retained" },
				),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const o = requireOrch(ctx.cwd, ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, effort: ctx.thinkingLevel } : undefined);
			const t = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} as Record<string, unknown> });
			// Progress UI must never affect job outcomes.
			const safeOnUpdate = (update: { content: { type: "text"; text: string }[]; details?: unknown }) => {
				try {
					onUpdate?.(update as Parameters<NonNullable<typeof onUpdate>>[0]);
				} catch {
					/* observer isolation */
				}
			};
			const needsId = () => t("jobId is required for this action.");
			try {
				switch (params.action) {
					case "plan": {
						// Validate EVERYTHING before the first append, so a rejected plan
						// writes no session entry and never advances the revision.
						const revision = buildPlanSnapshot({ previous: latestPlan, planId: params.planId, steps: params.steps ?? [] });
						if (!revision.ok) {
							return {
								content: [{ type: "text" as const, text: `plan rejected (no entry written):\n- ${revision.errors.join("\n- ")}` }],
								details: {},
								isError: true,
							};
						}
						const snapshot = revision.snapshot;
						pi.appendEntry(PLAN_ENTRY_TYPE, snapshot);
						latestPlan = snapshot;
						// Explicit jobIds AND alias-matching existing jobs become stable
						// membership bindings (job↔step), and the compact summary shows the
						// effective live job state. The persisted snapshot stays declared-only.
						const bindings: PlanJobBinding[] = [];
						const membershipIds = new Set<string>();
						const live: Record<string, string> = {};
						for (const step of snapshot.steps) {
							for (const jobId of step.jobIds) {
								bindings.push({ jobId, stepId: step.id });
								membershipIds.add(jobId);
								if (live[jobId] === undefined) {
									const job = o.store.readJob(jobId);
									if (job) live[jobId] = job.status;
								}
							}
							if (live[step.id] === undefined) {
								const aliasJob = o.store.readJob(step.id);
								if (aliasJob) {
									live[step.id] = aliasJob.status;
									bindings.push({ jobId: step.id, stepId: step.id });
									membershipIds.add(step.id);
								}
							}
						}
						appendMembership([...membershipIds], bindings);
						return t(renderPlanSummary(snapshot, live));
					}
					case "list": {
						const jobs = o.listJobs().slice(0, 30);
						if (jobs.length === 0) return t("No jobs yet.");
						return t(
							jobs
								.map((j) => `- ${j.jobId} [${j.agent}] ${j.status}${j.lastValidation && j.lastValidation !== "skipped" ? `/val:${j.lastValidation}` : ""} — ${(j.lastSummary ?? j.objective).slice(0, 120)} (attempts:${j.attemptCount})`)
								.join("\n"),
						);
					}
					case "status": {
						if (!params.jobId) return needsId();
						const job = o.readJob(params.jobId);
						if (!job) return t(`Unknown job ${params.jobId}`);
						const last = job.latestAttemptId ? o.readAttempt(job.jobId, job.latestAttemptId) : null;
						return t(
							[
								`job: ${job.jobId}`,
								`agent: ${job.agent} | status: ${job.status} | attempts: ${job.attemptCount}/${job.retry.maxAttempts}`,
								`dependsOn: ${job.dependsOn.join(", ") || "(none)"}`,
								`objective: ${job.objective.slice(0, 200)}`,
								last ? `lastAttempt: ${last.attemptId} [${last.logicalModel ?? "?"}] ${last.status}${last.exitReason ? ` (${last.exitReason})` : ""}` : "",
								job.lastSummary ? `summary: ${job.lastSummary}` : "",
								job.lastValidation ? `validation: ${job.lastValidation}` : "",
								job.lastBlockers?.length ? `blockers: ${job.lastBlockers.join(" | ")}` : "",
								job.needsFollowUp ? `followUpRecommended: yes` : "",
							]
								.filter(Boolean)
								.join("\n"),
						);
					}
					case "read": {
						if (!params.jobId) return needsId();
						const result = o.readResult(params.jobId);
						if (!result) return t(`No result for job ${params.jobId}`);
						return t(cap(JSON.stringify(result, null, 2), 16 * 1024));
					}
					case "artifact": {
						if (!params.jobId || !params.path) return t("jobId and path are required.");
						const art = o.readArtifact(params.jobId, params.path, params.attemptId);
						if (!art) return t(`Artifact not found: ${params.path}. List them with jobs.status / result.artifacts.`);
						return t(cap(art.content, 50 * 1024));
					}
					case "graph": {
						const g = o.graph();
						const lines = g.nodes.map((n) => `- ${n.jobId} [${n.agent}] ${n.effectiveStatus}${n.dependsOn.length ? ` ⇠ ${n.dependsOn.join(",")}` : ""}`);
						if (g.cycles.length) lines.push(`CYCLES DETECTED: ${g.cycles.map((c) => c.join("→")).join("; ")}`);
						return t(lines.join("\n") || "(no jobs)");
					}
					case "events": {
						if (!params.jobId) return needsId();
						const events = o.events.read(params.jobId, 100);
						return t(events.map((e) => `${new Date(e.t).toISOString()} ${e.type}${e.attemptId ? ` [${e.attemptId}]` : ""}${e.data ? ` ${JSON.stringify(e.data).slice(0, 160)}` : ""}`).join("\n") || "(no events)");
					}
					case "attempts": {
						if (!params.jobId) return needsId();
						const attempts = o.store.listAttempts(params.jobId);
						return t(
							attempts
								.map((a) => `- ${a.attemptId} [${a.logicalModel ?? "?"}→${a.resolvedModel ?? "?"}] ${a.retryMode} ${a.status}${a.exitReason ? ` (${a.exitReason})` : ""} ${a.usage ? `$${a.usage.costUsd.toFixed(4)} ${a.usage.turns}t ${((a.latencyMs ?? 0) / 1000).toFixed(0)}s` : ""}`)
								.join("\n") || "(no attempts)",
						);
					}
					case "followup": {
						if (!params.jobId || !params.message) return t("jobId and message are required.");
						trackExplicitJob(params.jobId);
						safeOnUpdate({ content: [{ type: "text", text: `job ${params.jobId}: follow-up requested (queued)` }], details: { jobId: params.jobId } });
						const unstream = streamJobEvents(o, params.jobId, safeOnUpdate);
						let report: RunReport;
						try {
							report = await o.followupJob(params.jobId, params.message, agents, signal);
						} finally {
							unstream();
						}
						safeOnUpdate({ content: [{ type: "text", text: `job ${params.jobId}: ${report.status}` }], details: { reports: [report] } });
						return renderRunReport(report);
					}
					case "retry": {
						if (!params.jobId) return needsId();
						trackExplicitJob(params.jobId);
						safeOnUpdate({ content: [{ type: "text", text: `job ${params.jobId}: retry requested (queued)` }], details: { jobId: params.jobId } });
						const unstream = streamJobEvents(o, params.jobId, safeOnUpdate);
						let report: RunReport;
						try {
							report = await o.retryJob(params.jobId, agents, { strategy: params.strategy, model: params.model, reason: "orchestrator retry", signal });
						} finally {
							unstream();
						}
						safeOnUpdate({ content: [{ type: "text", text: `job ${params.jobId}: ${report.status}` }], details: { reports: [report] } });
						return renderRunReport(report);
					}
					case "cancel": {
						if (!params.jobId) return needsId();
						return t(o.cancelJob(params.jobId) ? `Cancelled ${params.jobId}` : `Cannot cancel ${params.jobId} (terminal or unknown)`);
					}
					case "message": {
						if (!params.jobId || !params.message) return t("jobId and message are required.");
						trackExplicitJob(params.jobId);
						// Delivered only on steer ACK; explicit errors for non-running/failed control.
						await o.messageJob(params.jobId, params.message);
						return t(`delivered: message sent to the live worker of job ${params.jobId}`);
					}
					case "inbox": {
						const items = o.inbox(params.jobId); // reading consumes attention
						if (items.length === 0) return t("No live messages or requests yet." + (params.jobId ? "" : " (pass jobId for one job)"));
						return t(renderInboxItems(items));
					}
					case "reply": {
						if (!params.jobId || !params.requestId || !params.answer) return t("jobId, requestId, and answer are required.");
						trackExplicitJob(params.jobId);
						// Exact correlation only: duplicates, expired, and cross-job replies reject.
						o.reply(params.jobId, params.requestId, params.answer);
						return t(`delivered: answered request ${params.requestId} for job ${params.jobId}`);
					}
					case "wait": {
						if (!params.jobId) return needsId();
						const ids = params.jobId.split(",").map((s) => s.trim()).filter(Boolean);
						for (const id of ids) trackExplicitJob(id);
						// Yield on pending ask_main / new worker messages instead of
						// blocking the turn: the run keeps going in the background.
						const waitController = new AbortController();
						const forwardAbort = () => waitController.abort();
						if (signal?.aborted) waitController.abort();
						else signal?.addEventListener("abort", forwardAbort, { once: true });
						const waiting = o.waitJobs(ids, 300000, waitController.signal, (snapshot) => {
							safeOnUpdate({
								content: [{ type: "text", text: `waiting: ${snapshot.map((j) => `${j.jobId}=${j.status}`).join(", ")}` }],
								details: {},
							});
						});
						const raced = await raceRunAttention(waiting, new Set(ids));
						if (raced.attention) {
							// Abandon the poller (state lives in the store) and yield.
								waitController.abort();
							signal?.removeEventListener("abort", forwardAbort);
							const items = ids.flatMap((id) => o.inbox(id));
							// Raw store read: crash recovery must not touch live jobs.
							const jobs = ids.map((id) => o.store.readJob(id)).filter((j): j is JobRecord => Boolean(j));
							return renderYieldResult(items, jobs.map((j) => j.jobId), "jobs.wait");
						}
						if (raced.error) throw raced.error;
						const jobs = raced.report!;
						return t(jobs.map((j) => `- ${j.jobId}: ${j.status}${j.lastSummary ? ` — ${j.lastSummary.slice(0, 120)}` : ""}`).join("\n"));
					}
					case "metrics": {
						const metrics = o.metrics();
						if (metrics.workers.length === 0 && metrics.planner.runs === 0) return t("No metrics yet.");
						const lines = metrics.workers.map((m) => `${m.agent} / ${m.alias} (${m.concreteModel} @ ${m.provider}): attempts=${m.attempts} success=${m.successes} firstPass=${m.firstAttemptSuccesses} valPass=${m.validationPassed} valFail=${m.validationFailed} transport=${m.transportErrors} cost=$${m.costUsd.toFixed(4)} tokens=${m.promptTokens}↑/${m.completionTokens}↓ avgTime=${m.attempts ? (m.wallTimeMs / m.attempts / 1000).toFixed(1) : 0}s`);
						if (metrics.planner.runs > 0) lines.unshift(`planner: runs=${metrics.planner.runs} cost=$${metrics.planner.costUsd.toFixed(4)} tokens=${metrics.planner.promptTokens}↑/${metrics.planner.completionTokens}↓ cache=${metrics.planner.cacheReadTokens}r/${metrics.planner.cacheWriteTokens}w avgTime=${(metrics.planner.wallTimeMs / metrics.planner.runs / 1000).toFixed(1)}s`);
						return t(lines.join("\n"));
					}
				}
			} catch (e) {
				return { content: [{ type: "text" as const, text: `jobs.${params.action} failed: ${(e as Error).message}` }], details: {}, isError: true };
			}
			return t("Unknown action.");
		},
	});

	// ── ask_user_question (main tool; also the renderer for worker-routed asks) ─
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the human user ONE question. Provide 2-8 named options (each with an optional description) or omit options for free text; allowCustom (default true) accepts a typed answer on top of the options. Renders an interactive popup in the main session (the same UI used for worker-routed questions). Returns the user's answer verbatim, or an explicit cancelled/timeout/unavailable result — never a fabricated answer.",
		promptSnippet: "Ask the human user a single question with options or free text",
		promptGuidelines: [
			"Use ask_user_question when only the human user can decide something; ask ONE question per call with 2-8 concrete options (plus allowCustom for free text) and never invent the user's answer.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The single question to ask" }),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Display label for the option" }),
						description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
					}),
					{ description: "2-8 named options; omit for free text" },
				),
			),
			allowCustom: Type.Optional(Type.Boolean({ description: "accept a typed answer (default true)" })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "how long to wait (seconds, 1..900, default 300)" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const out = await askUserQuestion(
				ctx,
				{
					question: params.question,
					options: params.options,
					allowCustom: params.allowCustom ?? true,
					timeoutSeconds: params.timeoutSeconds,
				},
				{ signal },
			);
			switch (out.status) {
				case "answered":
					return {
						content: [{ type: "text" as const, text: `User answered: ${out.answer}` }],
						details: { question: params.question, answer: out.answer, wasCustom: out.wasCustom },
					};
				case "cancelled":
					return {
						content: [{ type: "text" as const, text: "User cancelled the question without answering" }],
						details: { question: params.question, answer: null },
					};
				case "timeout":
					return {
						content: [{ type: "text" as const, text: `Timed out after ${params.timeoutSeconds ?? 300}s with no answer (no default was chosen)` }],
						details: { question: params.question, answer: null },
					};
				default:
					return {
						content: [{ type: "text" as const, text: `unavailable: ${out.reason}` }],
						details: { question: params.question, answer: null },
						isError: true,
					};
			}
		},
		renderCall(args, theme) {
			const a = args as { question?: string; options?: { label?: string }[] };
			let text = `${theme.fg("toolTitle", theme.bold("ask_user_question "))}${theme.fg("muted", String(a.question ?? ""))}`;
			const opts = Array.isArray(a.options) ? a.options : [];
			if (opts.length) text += `\n  ${theme.fg("dim", `Options: ${opts.map((o, i) => `${i + 1}. ${o.label ?? "?"}`).join(", ")}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { answer?: string | null; wasCustom?: boolean } | undefined;
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			if (details && typeof details.answer === "string") {
				return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", details.answer)}${details.wasCustom ? theme.fg("muted", " (typed)") : ""}`, 0, 0);
			}
			if (/^unavailable:/.test(text)) return new Text(theme.fg("error", text), 0, 0);
			return new Text(theme.fg("warning", text || "Cancelled"), 0, 0);
		},
	});

	// ── commands ───────────────────────────────────────────────────────────
	// Scaffold orchestrator config + agent profile templates. Idempotent and
	// non-destructive: existing files are never overwritten (no --force; an
	// explicit re-confirmation flow would be required for that and is omitted
	// on purpose). Existing user configs are always left untouched.
	pi.registerCommand("orchestrator-init", {
		description: "Create starter config.yaml/models.yaml and example agent profiles (never overwrites existing files)",
		handler: async (_args, ctx) => {
			try {
				const result = scaffoldOrchestratorFiles({ agentDir: getAgentDir() });
				const lines: string[] = [];
				lines.push(result.created.length ? `Created:\n${result.created.map((p) => `  ${p}`).join("\n")}` : "Nothing to create — all template files already exist (existing files are never overwritten).");
				if (result.skipped.length) lines.push(`Skipped (already exist):\n${result.skipped.map((p) => `  ${p}`).join("\n")}`);
				lines.push(...result.nextSteps);
				ctx.ui.notify(lines.join("\n\n"), "info");
			} catch (err) {
				ctx.ui.notify(`orchestrator-init failed: ${(err as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("agents", {
		description: "List orchestrator agents, model registry, and runtime status",
		handler: async (_args, ctx) => {
			const o = requireOrch(ctx.cwd);
			const aliasLines = registry?.aliases().map((a) => {
				try {
					const r = registry!.resolve(a);
					return `  ${a} → ${r.concrete.provider}/${r.concrete.model}`;
				} catch {
					return `  ${a} → (unresolved)`;
				}
			}) ?? [];
			ctx.ui.notify(
				[
					mainAgent ? `main: ${mainAgent.name} (${mainAgent.filePath})` : "main: (none — lockdown INACTIVE)",
					`agents:\n${rosterText(agents)}`,
					`models (${registry?.fileUsed ?? "no registry file — using defaults/session model"}):\n${aliasLines.join("\n") || "  (none)"}`,
					`registry diagnostics: ${registry?.diagnostics.join("; ") || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

// ── helpers ──────────────────────────────────────────────────────────────────

function renderRunReport(report: RunReport) {
	const failed = report.status === "failed" || report.status === "cancelled";
	return {
		content: [{ type: "text" as const, text: cap(report.summaryForOrchestrator, 8 * 1024) }],
		details: { reports: [report] } as Record<string, unknown>,
		isError: failed,
	};
}

/** Bounded text rendering of live inbox items (messages + request lifecycle). */
function renderInboxItems(items: InboxItem[]): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "message") {
			const who = item.direction === "worker" ? `worker · job ${item.jobId}` : `main → worker · job ${item.jobId}${item.delivered ? "" : " (not delivered)"}`;
			lines.push(`- [${new Date(item.createdAt).toISOString()}] ${who}: ${item.text}`);
		} else {
			const expires = Math.max(0, Math.round((item.createdAt + item.timeoutSeconds * 1000 - Date.now()) / 1000));
			const status = item.status === "pending" ? `waiting (times out in ${expires}s)` : `${item.status}${item.answer ? `: ${item.answer}` : ""}`;
			lines.push(`- [request ${item.requestId}] ${item.kind} · job ${item.jobId} (agent ${item.agent}) — ${status}`);
			lines.push(`  question: ${item.question}`);
			if (item.status === "pending" && item.kind === "ask_main") lines.push(`  answer with: jobs action=reply jobId=${item.jobId} requestId=${item.requestId} answer="..."`);
		}
	}
	return cap(lines.join("\n"));
}

function renderRunReports(reports: RunReport[], created: JobRecord[]) {
	const ok = reports.filter((r) => r.status === "success").length;
	const lines = reports.map((r) => `─── ${r.jobId} ───\n${r.summaryForOrchestrator}`);
	const notRun = created.filter((c) => !reports.some((r) => r.jobId === c.jobId)).map((c) => `- ${c.jobId}: ${c.status} (dependency-gated; use jobs.graph / jobs.wait)`);
	return {
		content: [{ type: "text" as const, text: cap(`DAG batch: ${ok}/${reports.length} succeeded\n\n${lines.join("\n\n")}${notRun.length ? `\n\nNot run:\n${notRun.join("\n")}` : ""}`, 16 * 1024) }],
		details: { reports } as Record<string, unknown>,
		isError: reports.some((r) => r.status === "failed"),
	};
}
