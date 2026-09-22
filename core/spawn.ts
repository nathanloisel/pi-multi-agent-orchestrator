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
 *   - spawn `pi --mode rpc` with per-attempt session dir; the prompt command
 *     is sent over stdin (an ACK response only means "accepted"; genuine
 *     completion is the `agent_settled` event, after which stdin is closed
 *     gracefully so RPC mode flushes its final output before exiting)
 *   - parse the JSON event stream (messages, usage, session id)
 *   - relay live worker messaging (core/messaging.ts) over the RPC
 *     extension-UI subprotocol: one-way messages, blocking requests, and
 *     steering control for the parent
 *   - normalize transport vs task failures (core/errors.ts)
 *   - enforce timeouts / aborts, capture stderr tail
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { classifyRunFailure, OrchestratorError } from "./errors.ts";
import {
	MESSAGING_TOOL_NAMES,
	decodeMessageEnvelope,
	decodeRequestEnvelope,
	encodeReplyValue,
	isMessagingEnvelope,
	type WorkerMessage,
	type WorkerReply,
	type WorkerRequest,
} from "./messaging.ts";
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
	/** Live messaging (phase 1): one-way worker -> main messages. */
	onMessage?: (message: WorkerMessage) => void;
	/** Live messaging (phase 1): blocking worker requests. Absent handler -> explicit "unavailable" reply. */
	onRequest?: (request: WorkerRequest, rpc: { id: string; signal: AbortSignal }) => Promise<WorkerReply>;
	/** Live messaging (phase 1): control handle, provided once the worker is spawned and undefined again on exit. */
	onControl?: (control: WorkerControl | undefined) => void;
}

/** Parent-side control over a running worker (live messaging, phase 1). */
export interface WorkerControl {
	/** Queue a steering message on the running worker; resolves when pi accepts it, rejects on RPC error/exit. */
	steer(text: string): Promise<void>;
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

/** Hard bound for each captured stream file (current and previous). */
export const MAX_STREAM_BYTES = 2 * 1024 * 1024;

/**
 * Bounded capture of raw pi `--mode json` event lines into
 * attemptDir/stream.jsonl, with one rotated predecessor stream.previous.jsonl.
 *
 * Wire contract: both files are plain JSONL containing raw complete valid event
 * lines. Before appending a line that would push the current file past
 * maxBytes, the current file is renamed to stream.previous.jsonl (overwritten),
 * so exactly current + previous exist and chronology is previous → current.
 * Whole lines larger than maxBytes are dropped so the files never contain a
 * truncated JSON object; normal stdout processing is unaffected.
 *
 * Every operation is best-effort: persistence errors are swallowed so worker
 * execution and result extraction are never blocked or failed. Files are
 * created 0600 because events may contain sensitive session text, and capture
 * never prints to stdout.
 */
export class StreamCapture {
	private currentBytes = 0;
	private readonly currentPath: string;
	private readonly previousPath: string;

	constructor(
		attemptDir: string,
		private readonly maxBytes: number = MAX_STREAM_BYTES,
	) {
		this.currentPath = path.join(attemptDir, "stream.jsonl");
		this.previousPath = path.join(attemptDir, "stream.previous.jsonl");
		try {
			fs.mkdirSync(attemptDir, { recursive: true });
			const st = fs.statSync(this.currentPath);
			this.currentBytes = st.isFile() ? st.size : 0;
		} catch {
			this.currentBytes = 0;
		}
	}

	/** Append one raw, already-validated JSON event line. Never throws. */
	append(line: string): void {
		try {
			const bytes = Buffer.byteLength(line, "utf-8") + 1; // + newline
			if (bytes > this.maxBytes) return; // oversized single line: skip, keep valid JSONL
			if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) this.rotate();
			fs.appendFileSync(this.currentPath, `${line}\n`, { mode: 0o600 });
			this.currentBytes += bytes;
		} catch {
			/* capture is optional and must never affect the worker outcome */
		}
	}

	private rotate(): void {
		try {
			fs.renameSync(this.currentPath, this.previousPath);
		} catch {
			try {
				fs.rmSync(this.currentPath, { force: true });
			} catch {
				/* ignore */
			}
		}
		this.currentBytes = 0;
	}
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
	// RPC mode: the prompt travels as a stdin command (sent by runWorker once
	// the stream listeners are attached), never as a positional argument.
	const args: string[] = ["--mode", "rpc"];
	args.push("--session-dir", req.sessionDir, "--session-id", req.sessionId);
	args.push(...req.launchArgs);

	const agent = req.agent;
	// The messaging tools are unioned into the CLI allowlist so pi's tool
	// registry keeps them available no matter how restrictive the role is;
	// worker.ts unions them into the active set the same way.
	if (agent.capabilities && agent.capabilities.length > 0) {
		args.push("--tools", [...new Set([...agent.capabilities, ...MESSAGING_TOOL_NAMES])].join(","));
	}
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
	// No positional prompt: RPC mode receives it as a stdin command from
	// runWorker(), after the stream listeners are attached.
	return args;
}

/** Dialog extension UI methods (block the worker until the parent responds). Everything else is fire-and-forget. */
const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** Hard bound for a single command written to the worker's stdin (bytes). */
const MAX_STDIN_COMMAND_BYTES = 1024 * 1024;
/** Grace period after a graceful stdin close before falling back to signals. */
const GRACEFUL_EXIT_GRACE_MS = 5000;

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
	let promptError: string | undefined; // prompt never accepted by the worker (RPC)

	const capture = new StreamCapture(req.attemptDir);

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, { cwd: req.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });

		// ── RPC transport state ────────────────────────────────────────────
		// Strict LF-only JSONL framing on both sides (docs/rpc.md): records are
		// split on "\n" only, never on Unicode separators such as U+2028.
		let exited = false;
		let finished = false; // graceful completion already initiated
		let settled = false; // genuine completion (agent_settled) seen
		let promptAccepted = false;
		let stdinClosed = false;
		let stdinError: string | undefined;
		let commandSeq = 0;
		const pendingCommands = new Map<string, { command: string; resolve: () => void; reject: (err: Error) => void }>();
		const activeRequests = new Map<string, AbortController>();

		const failAllCommands = (reason: string) => {
			for (const pending of pendingCommands.values()) pending.reject(new Error(reason));
			pendingCommands.clear();
		};

		// A broken stdin pipe (e.g. EPIPE when the worker exits without reading)
		// must never crash the runner; pending commands fail at exit instead.
		proc.stdin.on("error", (e) => {
			if (!stdinError) stdinError = e instanceof Error ? e.message : String(e);
			stdinClosed = true;
		});

		/** Write one LF-framed JSON command to the worker's stdin. */
		const writeCommand = (command: Record<string, unknown>): void => {
			if (exited || stdinClosed) throw new Error(`worker stdin is closed${stdinError ? ` (${stdinError})` : ""}`);
			const line = `${JSON.stringify(command)}\n`;
			if (Buffer.byteLength(line, "utf-8") > MAX_STDIN_COMMAND_BYTES) throw new Error("worker command exceeds stdin write bound");
			proc.stdin.write(line);
		};

		/** Answer one extension UI dialog. Swallowed when the worker is gone. */
		const sendUiResponse = (response: { type: "extension_ui_response"; id: string; value?: string; cancelled?: boolean }): void => {
			try {
				writeCommand(response);
			} catch {
				/* worker already gone: nothing to answer */
			}
		};

		/** Initiate graceful completion: close stdin so RPC mode flushes and exits. */
		const finishGracefully = () => {
			if (finished) return;
			finished = true;
			if (!stdinClosed && !exited) {
				stdinClosed = true;
				try {
					proc.stdin.end();
				} catch {
					/* already closed */
				}
			}
			// Fallback: if the worker does not exit promptly, signal it.
			const grace = setTimeout(() => {
				if (exited) return;
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000);
			}, GRACEFUL_EXIT_GRACE_MS);
			grace.unref?.();
			proc.on("close", () => clearTimeout(grace));
		};

		/** Handle one native extension_ui_request from the worker. */
		const handleUiRequest = (event: { id?: unknown; method?: unknown; title?: unknown; message?: unknown }) => {
			const id = typeof event.id === "string" ? event.id : undefined;
			const method = typeof event.method === "string" ? event.method : "";
			if (!id) return;
			if (!DIALOG_UI_METHODS.has(method)) {
				// Fire-and-forget: only our one-way message payload is meaningful;
				// ordinary notifications are ignored (still captured in the stream log).
				if (method === "notify" && typeof event.message === "string" && isMessagingEnvelope(event.message)) {
					const message = decodeMessageEnvelope(event.message);
					if (message) req.onMessage?.(message);
				}
				return;
			}
			const title = typeof event.title === "string" ? event.title : "";
			if (!isMessagingEnvelope(title)) {
				// A dialog we do not understand: cancel it so the worker cannot hang.
				sendUiResponse({ type: "extension_ui_response", id, cancelled: true });
				return;
			}
			const decoded = decodeRequestEnvelope(title);
			if (!decoded.ok) {
				sendUiResponse({ type: "extension_ui_response", id, value: encodeReplyValue({ status: "error", reason: decoded.error }) });
				return;
			}
			if (!req.onRequest) {
				sendUiResponse({
					type: "extension_ui_response",
					id,
					value: encodeReplyValue({ status: "unavailable", reason: "no request handler is attached on the orchestrator side" }),
				});
				return;
			}
			const handler = req.onRequest;
			const controller = new AbortController();
			activeRequests.set(id, controller);
			const respond = (make: () => string) => {
				activeRequests.delete(id);
				if (exited) return; // late callback: the worker is gone, nothing to answer
				let value: string;
				try {
					value = make();
				} catch (err) {
					value = encodeReplyValue({ status: "error", reason: `invalid reply: ${err instanceof Error ? err.message : String(err)}` });
				}
				sendUiResponse({ type: "extension_ui_response", id, value });
			};
			// Never awaited here: the stdout loop keeps processing other events.
			void Promise.resolve()
				.then(() => handler(decoded.request, { id, signal: controller.signal }))
				.then(
					(reply) => respond(() => encodeReplyValue(reply)),
					(err) => respond(() => encodeReplyValue({ status: "error", reason: err instanceof Error ? err.message : String(err) })),
				);
		};

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
			capture.append(line); // raw valid event line; best-effort bounded capture
			const event = parsed as { type?: unknown; sessionId?: unknown; message?: unknown; id?: unknown; success?: unknown; error?: unknown };
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
			// RPC command response: correlate by our command id (prompt ACK, steer).
			if (event.type === "response" && typeof event.id === "string") {
				const pending = pendingCommands.get(event.id);
				if (pending) {
					pendingCommands.delete(event.id);
					if (event.success === true) pending.resolve();
					else pending.reject(new Error(`${pending.command} rejected: ${typeof event.error === "string" ? event.error : "unknown error"}`));
				}
				return;
			}
			if (event.type === "extension_ui_request") {
				handleUiRequest(event as { id?: unknown; method?: unknown; title?: unknown; message?: unknown });
				return;
			}
			// Genuine completion: `agent_settled` means no retry, compaction retry,
			// or queued continuation remains (agent_end alone is NOT completion).
			if (event.type === "agent_settled") {
				settled = true;
				if (promptAccepted) finishGracefully();
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			// LF-only framing: never split on Unicode line separators.
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			}
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
			if (stderr.length > 16 * 1024) stderr = stderr.slice(-16 * 1024);
		});
		proc.on("close", (code) => {
			exited = true;
			if (buffer.trim()) processLine(buffer);
			for (const controller of activeRequests.values()) controller.abort();
			activeRequests.clear();
			failAllCommands("worker exited before responding");
			req.onControl?.(undefined);
			resolve(code ?? 0);
		});
		proc.on("error", (e) => {
			errorMessage = e.message;
			resolve(1);
		});

		// ── Prompt command (stdin) — sent only after the listeners above exist. ─
		// The correlated response is just the acceptance ACK; the real completion
		// signal is the agent_settled event above.
		const promptId = `orch-${++commandSeq}`;
		const promptPromise = new Promise<void>((resolve, reject) => {
			pendingCommands.set(promptId, {
				command: "prompt",
				resolve: () => {
					promptAccepted = true;
					resolve();
					if (settled) finishGracefully();
				},
				reject,
			});
			try {
				writeCommand({ id: promptId, type: "prompt", message: req.prompt });
			} catch (err) {
				pendingCommands.delete(promptId);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
		promptPromise.catch((err) => {
			if (promptError === undefined) promptError = err instanceof Error ? err.message : String(err);
			// The worker will never run this prompt; end stdin so RPC mode exits.
			finishGracefully();
		});

		// ── Control handle for the parent (steering, phase-2 broker). ─────────
		req.onControl?.({
			steer: (text: string) => {
				const steerId = `orch-${++commandSeq}`;
				return new Promise<void>((resolve, reject) => {
					pendingCommands.set(steerId, { command: "steer", resolve, reject });
					try {
						writeCommand({ id: steerId, type: "steer", message: text });
					} catch (err) {
						pendingCommands.delete(steerId);
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
			},
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

	// A prompt the worker never accepted (rejected preflight, or the worker
	// exited before answering) only matters when nothing ran: a completed run
	// against a non-RPC child that ignores stdin is not a failure.
	if (promptError !== undefined && usage.turns === 0) {
		errorMessage = errorMessage ?? promptError;
	}

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
	} else if (promptError !== undefined && usage.turns === 0) {
		outcome.runError = classifyRunFailure(exitCode, "error", errorMessage, stderr);
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
