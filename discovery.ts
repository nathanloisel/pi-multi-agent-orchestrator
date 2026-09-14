/**
 * discovery.ts — AGENT.md loader (v2 declarative runtime package, §7).
 *
 * ~/.pi/agents/<agent-name>/
 * ├── AGENT.md          # v2 frontmatter + instructions body
 * ├── hooks/*.ts        # dedicated sub-process extensions (-e)
 * ├── scripts/
 * └── resources/
 *
 * v1 frontmatter (flat model/provider/effort/tools/timeoutSeconds/contextFiles/
 * skills/hooks) is still accepted and normalized into the v2 shape, so existing
 * agents keep working unchanged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_RETRY,
	type AgentConfig,
	type AgentHooksConfig,
	type BudgetConfig,
	type RetrySpec,
} from "./core/types.ts";

export type { AgentConfig };

type Raw = Record<string, unknown>;

export function agentsRoot(): string {
	return path.join(path.dirname(getAgentDir()), "agents"); // ~/.pi/agents
}

export function orchestratorRoot(): string {
	return path.join(path.dirname(getAgentDir()), "orchestrator"); // ~/.pi/orchestrator
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function bool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function list(v: unknown): string[] | undefined {
	const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
	const items = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function obj(v: unknown): Raw | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : undefined;
}

function strMap(v: unknown): Record<string, string> | undefined {
	const o = obj(v);
	if (!o) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(o)) {
		if (typeof val === "string") out[k] = val;
		else if (typeof val === "number" || typeof val === "boolean") out[k] = String(val);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function parseHooks(v: unknown, agentDir: string): { hooks: AgentHooksConfig; hookPaths: string[]; mainHookPaths: string[] } {
	const raw = obj(v);
	const hooks: AgentHooksConfig = {
		enabled: bool(raw?.enabled) ?? true,
		paths: list(raw?.paths),
		mainPaths: list(raw?.mainPaths),
	};
	const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(agentDir, p));
	const resolveExisting = (paths?: string[]) =>
		(paths ?? []).map(resolve).filter((p) => fs.existsSync(p) && p.startsWith(path.resolve(agentDir)));
	return { hooks, hookPaths: resolveExisting(hooks.paths), mainHookPaths: resolveExisting(hooks.mainPaths) };
}

function parseRetry(v: unknown): Partial<RetrySpec> | undefined {
	const raw = obj(v);
	if (!raw) return undefined;
	const out: Partial<RetrySpec> = {};
	const maxAttempts = num(raw.maxAttempts);
	if (maxAttempts !== undefined) out.maxAttempts = maxAttempts;
	if (Array.isArray(raw.ladder)) {
		out.ladder = raw.ladder
			.map((rung) => obj(rung))
			.filter((r): r is Raw => Boolean(r))
			.map((r) => ({
				model: str(r.model),
				strategy: str(r.strategy) === "resume" ? "resume" : "fresh",
			}));
	}
	return out;
}

function parseBudget(v: unknown): BudgetConfig | undefined {
	const raw = obj(v);
	if (!raw) return undefined;
	const b: BudgetConfig = {};
	for (const k of ["perAttemptUsd", "perJobUsd", "dailyUsd"] as const) if (num(raw[k]) !== undefined) b[k] = num(raw[k]);
	for (const k of ["maxTurns", "maxOutputTokens", "timeoutSeconds", "maxAttempts"] as const) if (num(raw[k]) !== undefined) b[k] = num(raw[k]);
	return Object.keys(b).length ? b : undefined;
}

export function parseAgentFile(filePath: string, dir: string, source: "user" | "project", fallbackName: string): AgentConfig | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const { frontmatter, body } = parseFrontmatter<Raw>(content);
	const fm = (frontmatter ?? {}) as Raw;

	const name = str(fm.name) ?? fallbackName;
	const description = str(fm.description) ?? "";
	const role = str(fm.role)?.toLowerCase() === "main" ? "main" : "sub";
	const isV2 = obj(fm.runtime) !== undefined || obj(fm.limits) !== undefined || obj(fm.workspace) !== undefined;

	// runtime: v2 nested, v1 flat (model may embed "provider/model:effort")
	const rt = obj(fm.runtime) ?? {};
	let model = str(rt.model) ?? str(fm.model);
	let provider = str(rt.provider) ?? str(fm.provider);
	let effort = str(rt.effort) ?? str(fm.effort);
	if (model?.includes(":")) {
		const [m, e] = model.split(":");
		model = m;
		if (!effort) effort = e;
	}
	if (model?.includes("/") && !provider) {
		const [p, ...rest] = model.split("/");
		provider = p;
		model = rest.join("/");
	}

	const { hooks, hookPaths, mainHookPaths } = parseHooks(fm.hooks, dir);

	// limits: v2 nested; v1 timeoutSeconds flat
	const lim = obj(fm.limits) ?? {};
	const limits = {
		maxTurns: num(lim.maxTurns),
		timeoutSeconds: num(lim.timeoutSeconds) ?? num(fm.timeoutSeconds) ?? 1800,
		maxOutputTokens: num(lim.maxOutputTokens),
	};

	// context: v2 nested policy; v1 contextFiles boolean
	const ctxFm = obj(fm.context) ?? {};
	const contextFilesV1 = bool(fm.contextFiles);
	const context = {
		mode: (str(ctxFm.mode) === "none" ? "none" : str(ctxFm.mode) === "full" ? "full" : "selective") as "none" | "selective" | "full",
		files: list(ctxFm.files),
	};
	if (contextFilesV1 === false && !isV2) context.mode = "none";

	const ws = obj(fm.workspace) ?? {};
	const workspace = {
		strategy: str(ws.strategy) === "git-worktree" ? ("git-worktree" as const) : ("cwd" as const),
		cleanup: str(ws.cleanup) === "remove-on-success" ? ("remove-on-success" as const) : ("keep" as const),
	};

	const val = obj(fm.validation) ?? {};
	const validation = {
		commands: list(val.commands),
		timeoutSeconds: num(val.timeoutSeconds) ?? 600,
	};

	const retry = { ...DEFAULT_RETRY, ...(parseRetry(fm.retry) ?? {}) };

	return {
		name,
		description,
		role,
		runtime: { model, provider, effort },
		capabilities: list(fm.capabilities) ?? list(fm.tools),
		limits,
		context,
		workspace,
		validation,
		retry,
		budget: parseBudget(fm.budget),
		env: strMap(fm.env),
		hooks,
		systemPrompt: body.trim(),
		dir,
		filePath,
		source,
		hookPaths,
		mainHookPaths,
		schema: isV2 ? "v2" : "v1",
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const agentFile = path.join(full, "AGENT.md");
			if (fs.existsSync(agentFile)) {
				const agent = parseAgentFile(agentFile, full, source, entry.name);
				if (agent) agents.push(agent);
			}
		} else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
			const agent = parseAgentFile(full, dir, source, entry.name.replace(/\.md$/, ""));
			if (agent) agents.push(agent);
		}
	}
	return agents;
}

export interface DiscoveryResult {
	agents: AgentConfig[];
	userAgentsDir: string;
	projectAgentsDir: string | null;
	main: AgentConfig | null;
}

export function discoverAgents(cwd: string, opts: { includeProject?: boolean } = {}): DiscoveryResult {
	const userAgentsDir = agentsRoot();
	const projectAgentsDir = path.join(cwd, CONFIG_DIR_NAME, "agents");

	const agents = loadAgentsFromDir(userAgentsDir, "user");
	if (opts.includeProject && fs.existsSync(projectAgentsDir)) {
		const byName = new Map(agents.map((a) => [a.name, a]));
		for (const a of loadAgentsFromDir(projectAgentsDir, "project")) byName.set(a.name, a);
		const all = [...byName.values()];
		return { agents: all, userAgentsDir, projectAgentsDir, main: all.find((a) => a.role === "main") ?? null };
	}
	return {
		agents,
		userAgentsDir,
		projectAgentsDir: fs.existsSync(projectAgentsDir) ? projectAgentsDir : null,
		main: agents.find((a) => a.role === "main") ?? null,
	};
}
