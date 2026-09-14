/**
 * core/spawn.ts — the worker backend launcher.
 *
 * The ONLY module that knows how a worker process is started. It speaks pi CLI
 * (the harness itself is the provider runtime): model resolution arrives as
 * LaunchConfig from core/models.ts, so OpenRouter today and a local
 * OpenAI-compatible endpoint later are both just registry entries — nothing
 * here changes (§3, §10, §34).
 *
 * Responsibilities:
 *   - spawn `pi --mode json -p` with per-attempt session dir
 *   - parse the JSON event stream (messages, usage, session id)
 *   - normalize transport vs task failures (core/errors.ts)
 *   - enforce timeouts / aborts, capture stderr tail
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { classifyRunFailure, OrchestratorError } from "./errors.ts";
import type { AgentConfig, ResolvedModel, UsageInfo } from "./types.ts";

export interface SpawnRequest {
	agent: AgentConfig;
	resolved: ResolvedModel;
	prompt: string;
	cwd: string; // workspace dir
	jobId: string;
	attemptId: string;
	attemptDir: string;
	sessionDir: string;
	sessionId: string;
	workerExtensionPath: string;
	envAllowlist?: string[]; // extra env vars allowed through (§30)
	timeoutSeconds: number;
	signal?: AbortSignal;
	onUpdate?: (u: { finalText: string; turns: number }) => void;
	/** pi CLI arg overrides (e.g. --session-dir reuse handled internally). */
	extraArgs?: string[];
	launchArgs: string[]; // --model/--thinking/etc. from ModelRegistry.toLaunchConfig
	launchEnv: Record<string, string>;
}

export interface SpawnOutcome {
	exitCode: number;
	messages: Message[];
	finalText: string;
	usage: UsageInfo;
	stopReason?: string;
	errorMessage?: string;
	stderrTail: string;
	sessionId?: string;
	/** Normalized failure when the run itself failed (not task-level failure). */
	runError?: OrchestratorError;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Build the sanitized child environment (§30).
 * Workers get: PATH/HOME/LANG/TERM + pi config vars + the provider key they
 * need (via launchEnv/apiKeyEnv) + agent-declared env. They do NOT inherit
 * arbitrary parent secrets (other providers' API keys, OAuth tokens, app env).
 */
export function buildChildEnv(req: SpawnRequest, jobMeta: { jobId: string; attemptId: string; artifactsDir: string }): NodeJS.ProcessEnv {
	const safeKeys = [
		"PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TZ", "SHELL", "TMPDIR", "TEMP", "TMP",
		"PI_CONFIG_DIR", "PI_AGENT_DIR", "NODE_OPTIONS",
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", // pi provider auth fallbacks
	];
	const env: NodeJS.ProcessEnv = {};
	for (const k of safeKeys) if (process.env[k] !== undefined) env[k] = process.env[k];
	for (const k of req.envAllowlist ?? []) if (process.env[k] !== undefined) env[k] = process.env[k];
	Object.assign(env, req.launchEnv);
	Object.assign(env, req.agent.env ?? {});
	env.PI_ORCHESTRATOR_SUBAGENT = "1";
	env.PI_ORCHESTRATOR_JOB_ID = jobMeta.jobId;
	env.PI_ORCHESTRATOR_ATTEMPT_ID = jobMeta.attemptId;
	env.PI_ORCHESTRATOR_JOB_DIR = path.dirname(path.dirname(req.attemptDir));
	env.PI_ORCHESTRATOR_ATTEMPT_DIR = req.attemptDir;
	env.PI_ORCHESTRATOR_ARTIFACTS = jobMeta.artifactsDir;
	env.PI_ORCHESTRATOR_RESULT_PATH = path.join(req.attemptDir, "result.json");
	env.PI_ORCHESTRATOR_ALLOWED_TOOLS = (req.agent.capabilities ?? []).join(",");
	return env;
}

export function buildSpawnArgs(req: SpawnRequest): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	args.push("--session-dir", req.sessionDir, "--session-id", req.sessionId);
	args.push(...req.launchArgs);

	const agent = req.agent;
	if (agent.capabilities && agent.capabilities.length > 0) args.push("--tools", agent.capabilities.join(","));
	if (agent.context.mode === "none") args.push("--no-context-files");
	if (agent.context.mode !== "full") args.push("--no-skills");

	if (agent.systemPrompt) {
		const promptFile = path.join(req.attemptDir, "SYSTEM.md");
		fs.writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptFile);
	}

	args.push("-e", req.workerExtensionPath);
	if (agent.hooks.enabled !== false) {
		for (const hookPath of agent.hookPaths) args.push("-e", hookPath);
	}
	args.push("--no-extensions"); // no recursion, no main-lockdown leakage
	args.push(...(req.extraArgs ?? []));
	args.push(req.prompt); // positional message must come last
	return args;
}

export async function runWorker(req: SpawnRequest): Promise<SpawnOutcome> {
	const args = buildSpawnArgs(req);
	const artifactsDir = path.join(req.attemptDir, "artifacts");
	const env = buildChildEnv(req, {
		jobId: req.jobId,
		attemptId: req.attemptId,
		artifactsDir,
	});

	// Persist launch audit (non-secret env only).
	try {
		fs.writeFileSync(
			path.join(req.attemptDir, "env.json"),
			JSON.stringify({ args: args.filter((a) => !a.startsWith("sk-")), envKeys: Object.keys(env), cwd: req.cwd }, null, 2),
		);
	} catch {
		/* best effort */
	}

	const messages: Message[] = [];
	const usage: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, turns: 0 };
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let sessionId: string | undefined;
	let aborted = false;

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, { cwd: req.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			if (!parsed || typeof parsed !== "object") return;
			const event = parsed as { type?: unknown; sessionId?: unknown; message?: unknown };
			if (event.type === "session_start" && typeof event.sessionId === "string") sessionId = event.sessionId;
			if (event.type === "message_end" && event.message && typeof event.message === "object") {
				const msg = event.message as Message;
				messages.push(msg);
				if (msg.role === "assistant") {
					usage.turns++;
					const u = msg.usage;
					usage.input += u.input || 0;
					usage.output += u.output || 0;
					usage.cacheRead += u.cacheRead || 0;
					usage.cacheWrite += u.cacheWrite || 0;
					usage.costUsd += u.cost.total || 0;
					usage.contextTokens = u.totalTokens || 0;
					stopReason = msg.stopReason;
					if (msg.errorMessage) errorMessage = msg.errorMessage;
					req.onUpdate?.({ finalText: finalTextOf(messages), turns: usage.turns });
				}
			}
			if (event.type === "tool_result_end" && event.message && typeof event.message === "object") messages.push(event.message as Message);
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
			if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
		});
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", (e) => {
			errorMessage = e.message;
			resolve(1);
		});

		const timer = setTimeout(() => {
			errorMessage = errorMessage ?? `Timed out after ${req.timeoutSeconds}s`;
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000);
		}, req.timeoutSeconds * 1000);
		proc.on("close", () => clearTimeout(timer));

		if (req.signal) {
			const kill = () => {
				aborted = true;
				errorMessage = errorMessage ?? "Aborted by orchestrator";
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000);
			};
			if (req.signal.aborted) kill();
			else req.signal.addEventListener("abort", kill, { once: true });
		}
	});

	const finalText = finalTextOf(messages);
	const outcome: SpawnOutcome = {
		exitCode,
		messages,
		finalText,
		usage,
		stopReason,
		errorMessage,
		stderrTail: stderr.slice(-2000),
		sessionId,
	};

	if (aborted) {
		outcome.runError = new OrchestratorError("aborted", errorMessage ?? "Aborted");
	} else if (errorMessage && /timed out/i.test(errorMessage)) {
		outcome.runError = new OrchestratorError("timeout", errorMessage);
	} else if (exitCode !== 0 || stopReason === "error") {
		outcome.runError = classifyRunFailure(exitCode, stopReason, errorMessage, stderr);
	}
	return outcome;
}

export function finalTextOf(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const texts = msg.content.filter((part): part is Extract<(typeof msg.content)[number], { type: "text" }> => part.type === "text");
			if (texts.length > 0) return texts.map((text) => text.text).join("\n");
		}
	}
	return "";
}
