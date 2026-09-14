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
import * as os from "node:os";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { EventLog } from "./core/events.ts";
import { AgentsViewExporter } from "./core/agentsview.ts";
import { BudgetManager } from "./core/budget.ts";
import { ConcurrencyManager } from "./core/concurrency.ts";
import { Orchestrator, type CreateJobInput, type RunReport } from "./core/orchestrator.ts";
import { PlannerTelemetryCollector, PlannerTelemetryStore } from "./core/telemetry.ts";
import { scaffoldOrchestratorFiles } from "./core/scaffold.ts";
import { DEFAULT_CONCURRENCY, type ConcurrencyConfig, type ContextPack, type JobRecord } from "./core/types.ts";

const ORCHESTRATOR_TOOLS = new Set(["delegate", "jobs"]);
const MAX_PARALLEL_TASKS = 16;
const SUMMARY_CAP = 4 * 1024;

const HERE = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function cap(text: string, bytes = SUMMARY_CAP): string {
	return Buffer.byteLength(text) <= bytes ? text : `${text.slice(0, bytes)}\n[… truncated — full details via jobs.read / jobs.artifact]`;
}

interface LoadedConfig {
	concurrency: ConcurrencyConfig;
	budgets: { perAttemptUsd?: number; perJobUsd?: number; dailyUsd?: number };
	routing: RoutingRule[];
	agentsView: { enabled: boolean; exportDir: string };
}

function loadOrchestratorConfig(root: string): LoadedConfig {
	for (const name of ["config.yaml", "config.yml", "config.json"]) {
		const file = path.join(root, name);
		if (!fs.existsSync(file)) continue;
		try {
			const raw = fs.readFileSync(file, "utf-8");
			const cfg = name.endsWith(".json") ? JSON.parse(raw) : yamlParse(raw);
			const configuredExportDir = typeof cfg.agentsView?.exportDir === "string" ? cfg.agentsView.exportDir : path.join(root, "agentsview-sessions");
			return {
				concurrency: { ...DEFAULT_CONCURRENCY, ...(cfg.concurrency ?? {}) },
				budgets: cfg.budgets ?? {},
				routing: Array.isArray(cfg.routing?.rules) ? cfg.routing.rules : [],
				agentsView: {
					enabled: cfg.agentsView?.enabled === true,
					exportDir: configuredExportDir.startsWith("~/") ? path.join(os.homedir(), configuredExportDir.slice(2)) : configuredExportDir,
				},
			};
		} catch {
			/* fall through to defaults */
		}
	}
	return {
		concurrency: { ...DEFAULT_CONCURRENCY },
		budgets: {},
		routing: [],
		agentsView: { enabled: false, exportDir: path.join(root, "agentsview-sessions") },
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
			agentsViewExporter: new AgentsViewExporter(cfg.agentsView),
			plannerTelemetry: plannerStore,
			defaults: { model: sessionModel, budget: cfg.budgets, concurrency: cfg.concurrency },
		});
		// Backfill: attempts that predate AgentsView activation become visible too.
		try {
			orch.backfillAgentsView();
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error("[orchestrator] AgentsView backfill failed:", err);
		}
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

		if (!enforceMain) return;

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
			`orchestrator: main locked to delegate/jobs · ${agents.filter((a) => a.role === "sub").length} agents · models: ${registry?.aliases().join(", ") || "(none — using session model)"}`,
			"info",
		);
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
			"Write delegate tasks for a focused cheap model with zero conversation context: exact paths, symbols, constraints, acceptance criteria.",
			"Batch independent work into one delegate call with multiple jobs; express ordering with dependsOn instead of chain calls.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String()),
			task: Type.Optional(Type.String()),
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
					onUpdate?.({ content: [{ type: "text" as const, text: `job ${job.jobId} created (${params.agent}) — running…` }], details: { jobId: job.jobId } });
					const report = await o.runJob(job, agents, signal);
					onUpdate?.({ content: [{ type: "text" as const, text: `job ${job.jobId}: ${report.status}` }], details: { jobId: job.jobId } });
					return renderRunReport(report);
				}

				if (params.jobs!.length > MAX_PARALLEL_TASKS) {
					return { content: [{ type: "text" as const, text: `Too many jobs (${params.jobs!.length}); max ${MAX_PARALLEL_TASKS}.` }], details: {}, isError: true };
				}
				const created: JobRecord[] = [];
				for (const j of params.jobs!) created.push(o.createJob(toInput(j), agents));
				onUpdate?.({ content: [{ type: "text" as const, text: `created ${created.length} jobs — running DAG…` }], details: { jobIds: created.map((c) => c.jobId) } });
				const reports = await o.runGraph(agents, { signal, jobIds: created.map((c) => c.jobId) });
				return renderRunReports(reports, created);
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
			"Job runtime control & inspection. Actions: list | status <jobId> | read <jobId> (canonical result.json summary) | artifact <jobId,path[,attemptId]> | graph | events <jobId> | attempts <jobId> | followup <jobId,message> (resume worker session — cheapest) | retry <jobId[,strategy=resume|fresh][,model=alias]> | cancel <jobId> | wait <jobId[,jobId...]> | metrics.",
		promptSnippet: "Job control: list/status/read/artifact/graph/events/attempts/followup/retry/cancel/wait/metrics",
		promptGuidelines: [
			"Use jobs.followup for small corrections (resumes the worker's session); use jobs.retry strategy=fresh when the worker is stuck, optionally escalating model (worker-best, frontier).",
			"Use jobs.read and jobs.artifact to pull details on demand — never request full logs into context.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["list", "status", "read", "artifact", "graph", "events", "attempts", "followup", "retry", "cancel", "wait", "metrics"] as const,
			),
			jobId: Type.Optional(Type.String()),
			path: Type.Optional(Type.String({ description: "artifact relative path (action: artifact)" })),
			attemptId: Type.Optional(Type.String()),
			message: Type.Optional(Type.String({ description: "follow-up instruction (action: followup)" })),
			strategy: Type.Optional(StringEnum(["resume", "fresh"] as const, { description: "retry strategy (default: fresh)" })),
			model: Type.Optional(Type.String({ description: "logical alias override for retry (worker-cheap/worker-best/frontier)" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const o = requireOrch(ctx.cwd, ctx.model ? { provider: ctx.model.provider, model: ctx.model.id, effort: ctx.thinkingLevel } : undefined);
			const t = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} as Record<string, unknown> });
			const needsId = () => t("jobId is required for this action.");
			try {
				switch (params.action) {
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
						const report = await o.followupJob(params.jobId, params.message, agents, signal);
						return renderRunReport(report);
					}
					case "retry": {
						if (!params.jobId) return needsId();
						const report = await o.retryJob(params.jobId, agents, { strategy: params.strategy, model: params.model, reason: "orchestrator retry", signal });
						return renderRunReport(report);
					}
					case "cancel": {
						if (!params.jobId) return needsId();
						return t(o.cancelJob(params.jobId) ? `Cancelled ${params.jobId}` : `Cannot cancel ${params.jobId} (terminal or unknown)`);
					}
					case "wait": {
						if (!params.jobId) return needsId();
						const ids = params.jobId.split(",").map((s) => s.trim()).filter(Boolean);
						const jobs = await o.waitJobs(ids, 300000, signal);
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
