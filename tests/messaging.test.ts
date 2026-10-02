/**
 * tests/messaging.test.ts — phase 1 live agent messaging.
 *
 * Covers:
 *   - core/messaging.ts: envelope encode/decode, validation, bounds, clamping
 *   - core/spawn.ts buildSpawnArgs: RPC contract (--mode rpc, stdin prompt,
 *     --tools union with the messaging tools)
 *   - worker.ts: messaging tool registration, allowlist union, tool_call
 *     policy, and blocker request answer/cancel/timeout/headless behavior
 *   - runWorker RPC transport, driven against a fake RPC child (the
 *     getPiInvocation argv[1] seam used by spawn-stream.test.ts): prompt ACK
 *     vs genuine completion, steer accepted/error, one-way messages, ask
 *     request + matched reply, missing handler -> unavailable, malformed
 *     stdout/envelopes, Unicode/LF framing, graceful final output flush,
 *     early exit / cancel / timeout without hung promises, stream byte cap.
 *
 * No network, no provider calls: the fake child speaks the pi RPC wire
 * protocol deterministically.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	MESSAGING_ENVELOPE_MAX_BYTES,
	MESSAGING_PREFIX,
	MESSAGING_TEXT_MAX_BYTES,
	MESSAGING_TOOL_NAMES,
	REQUEST_TIMEOUT_DEFAULT_SECONDS,
	clampRequestTimeoutSeconds,
	decodeMessageEnvelope,
	decodeReplyValue,
	decodeRequestEnvelope,
	encodeMessageEnvelope,
	encodeReplyValue,
	encodeRequestEnvelope,
	formatReplyForModel,
	isMessagingEnvelope,
	type WorkerMessage,
	type WorkerReply,
	type WorkerRequest,
} from "../core/messaging.ts";
import { MAX_STREAM_BYTES, buildSpawnArgs, runWorker, type SpawnRequest, type WorkerControl } from "../core/spawn.ts";
import { makeAgent } from "./helpers.ts";
import workerExtension from "../worker.ts";

const roots: string[] = [];
function tmp(prefix = "orch-msg-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(dir);
	return dir;
}
after(() => {
	for (const root of roots) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

// ── Unit: protocol (core/messaging.ts) ───────────────────────────────────────

describe("messaging protocol", () => {
	it("round-trips a one-way message envelope", () => {
		const encoded = encodeMessageEnvelope("found the bug in parser.ts");
		assert.ok(encoded.startsWith(MESSAGING_PREFIX));
		assert.ok(isMessagingEnvelope(encoded));
		const decoded = decodeMessageEnvelope(encoded);
		assert.deepEqual(decoded, { kind: "message", text: "found the bug in parser.ts" });
	});

	it("round-trips ask_main and ask_user_question request envelopes", () => {
		const askMain = decodeRequestEnvelope(encodeRequestEnvelope({ kind: "ask_main", question: "blocked: which DB?", timeoutSeconds: 120 }));
		assert.ok(askMain.ok);
		assert.deepEqual(askMain.request, { kind: "ask_main", question: "blocked: which DB?", timeoutSeconds: 120 });

		const askUser = decodeRequestEnvelope(
			encodeRequestEnvelope({
				kind: "ask_user_question",
				question: "Ship Friday?",
				options: [
					{ label: "Ship it" },
					{ label: "Hold", description: "wait for QA" },
				],
				allowCustom: false,
				timeoutSeconds: 60,
			}),
		);
		assert.ok(askUser.ok);
		assert.equal(askUser.request.kind, "ask_user_question");
		assert.deepEqual(askUser.request.options, [{ label: "Ship it" }, { label: "Hold", description: "wait for QA" }]);
		assert.equal(askUser.request.allowCustom, false);
	});

	it("round-trips replies and formats them for the model", () => {
		const reply: WorkerReply = { status: "answered", answer: "use approach B" };
		assert.deepEqual(decodeReplyValue(encodeReplyValue(reply)), reply);
		assert.equal(formatReplyForModel(reply), "answered: use approach B");
		assert.equal(formatReplyForModel({ status: "cancelled" }), "cancelled: the request was dismissed without an answer");
		assert.equal(formatReplyForModel({ status: "timeout" }), "timeout: no answer arrived in time");
		assert.match(formatReplyForModel({ status: "unavailable", reason: "no transport" }), /^unavailable: /);
		assert.match(formatReplyForModel({ status: "error", reason: "boom" }), /^error: /);
	});

	it("rejects invalid requests without throwing", () => {
		const cases: Array<[string, string]> = [
			[MESSAGING_PREFIX + "{not json", "malformed JSON"],
			[encodeRequestEnvelope({ kind: "ask_main", question: "q" }).replace('"v":1', '"v":2'), "version"],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "message", text: "hi" })}`, "wrong kind"],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main" })}`, "missing question"],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main", question: "q", options: [{ label: "a" }, { label: "b" }] })}`, "ask_main with options"],
			[
				`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_user_question", question: "q", options: [{ label: "only" }] })}`,
				"one option",
			],
			[
				`${MESSAGING_PREFIX}${JSON.stringify({
					v: 1,
					kind: "ask_user_question",
					question: "q",
					options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })),
				})}`,
				"nine options",
			],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_user_question", question: "q", allowCustom: "yes" })}`, "allowCustom type"],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main", question: "q", timeoutSeconds: 0 })}`, "timeout below bound"],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main", question: "q", timeoutSeconds: 901 })}`, "timeout above bound"],
			[`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main", question: "x".repeat(MESSAGING_TEXT_MAX_BYTES + 1) })}`, "oversized question"],
		];
		for (const [payload, label] of cases) {
			const decoded = decodeRequestEnvelope(payload);
			assert.equal(decoded.ok, false, `expected rejection: ${label}`);
		}
	});

	it("rejects oversized envelopes by total size", () => {
		// Valid fields, but total envelope above the 64 KiB bound.
		const oversized = `${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main", question: "q", pad: "x".repeat(MESSAGING_ENVELOPE_MAX_BYTES) })}`;
		assert.equal(decodeRequestEnvelope(oversized).ok, false);
		assert.equal(decodeMessageEnvelope(oversized), undefined);
	});

	it("drops malformed one-way messages and never treats them as requests", () => {
		assert.equal(decodeMessageEnvelope("ordinary notification"), undefined);
		assert.equal(decodeMessageEnvelope(MESSAGING_PREFIX + "{oops"), undefined);
		assert.equal(decodeMessageEnvelope(`${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "ask_main", question: "q" })}`), undefined);
		assert.throws(() => encodeMessageEnvelope("x".repeat(MESSAGING_TEXT_MAX_BYTES + 1)), /16.*bytes/);
	});

	it("decodes invalid replies into explicit error replies (never a fabricated answer)", () => {
		assert.equal(decodeReplyValue("{not json").status, "error");
		assert.equal(decodeReplyValue(JSON.stringify({ status: "maybe" })).status, "error");
		assert.equal(decodeReplyValue(JSON.stringify({ status: "answered" })).status, "error"); // missing answer
		assert.equal(decodeReplyValue("").status, "error");
		assert.throws(() => encodeReplyValue({ status: "answered" } as never));
		assert.throws(() => encodeReplyValue({ status: "weird" } as never));
	});

	it("clamps request timeouts into 1..900 with a 300s default", () => {
		assert.equal(clampRequestTimeoutSeconds(undefined), REQUEST_TIMEOUT_DEFAULT_SECONDS);
		assert.equal(clampRequestTimeoutSeconds(0), 1);
		assert.equal(clampRequestTimeoutSeconds(-5), 1);
		assert.equal(clampRequestTimeoutSeconds(10000), 900);
		assert.equal(clampRequestTimeoutSeconds(42.7), 43);
		assert.equal(clampRequestTimeoutSeconds(Number.NaN), REQUEST_TIMEOUT_DEFAULT_SECONDS);
	});

	it("exposes the messaging tool names", () => {
		assert.deepEqual([...MESSAGING_TOOL_NAMES], ["message_main", "ask_main", "ask_user_question"]);
	});
});

// ── Unit: buildSpawnArgs RPC contract ────────────────────────────────────────

describe("buildSpawnArgs RPC contract", () => {
	function makeReqDir(): string {
		const dir = tmp("orch-msg-args-");
		fs.mkdirSync(path.join(dir, "session"), { recursive: true });
		return dir;
	}

	it("spawns RPC mode without a positional prompt and unions messaging tools into --tools", () => {
		const attemptDir = makeReqDir();
		const req = {
			agent: makeAgent({ name: "worker", capabilities: ["read", "grep"] }),
			resolved: { alias: "a", concrete: { provider: "fake", model: "fake/x" }, source: "registry" },
			prompt: "do the work",
			cwd: attemptDir,
			jobId: "job-1",
			attemptId: "attempt-001",
			attemptDir,
			sessionDir: path.join(attemptDir, "session"),
			sessionId: "sess-1",
			workerExtensionPath: path.join(attemptDir, "worker.ts"),
			timeoutSeconds: 30,
			launchArgs: ["--model", "fake/x", "--thinking", "medium"],
			launchEnv: {},
		} as unknown as SpawnRequest;

		const args = buildSpawnArgs(req);
		assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
		assert.equal(args.includes("-p"), false);
		assert.equal(args.includes(req.prompt), false, "prompt must travel over stdin, not argv");
		// session/model/config flags preserved
		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("--session-id"));
		assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "fake/x"]);
		assert.ok(args.includes("--thinking"));
		// messaging tools unioned into the CLI allowlist
		const toolsFlag = args[args.indexOf("--tools") + 1];
		const tools = toolsFlag.split(",");
		for (const name of MESSAGING_TOOL_NAMES) assert.ok(tools.includes(name), `${name} must survive the --tools allowlist`);
		assert.ok(tools.includes("read"));
		assert.ok(tools.includes("grep"));
		assert.equal(tools.filter((t) => t === "read").length, 1, "no duplicates");
	});

	it("omits --tools entirely when the role declares no capabilities", () => {
		const attemptDir = makeReqDir();
		const req = {
			agent: makeAgent({ name: "worker", capabilities: [] }),
			resolved: { alias: "a", concrete: { provider: "fake", model: "fake/x" }, source: "registry" },
			prompt: "p",
			cwd: attemptDir,
			jobId: "j",
			attemptId: "a",
			attemptDir,
			sessionDir: path.join(attemptDir, "session"),
			sessionId: "s",
			workerExtensionPath: "worker.ts",
			timeoutSeconds: 30,
			launchArgs: [],
			launchEnv: {},
		} as unknown as SpawnRequest;
		assert.equal(buildSpawnArgs(req).includes("--tools"), false);
	});
});

// ── Worker extension (worker.ts) ─────────────────────────────────────────────

interface MockWorkerTool {
	name: string;
	execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) => Promise<unknown>;
}

interface MockWorkerPi {
	handlers: Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>;
	tools: Map<string, MockWorkerTool>;
	active: () => string[];
}

function loadWorkerPi(env: Record<string, string | undefined>, activeTools: string[] = []): MockWorkerPi {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const tools = new Map<string, MockWorkerTool>();
	const state = { active: [...activeTools] };
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => handlers.set(event, handler as (event: any, ctx: any) => unknown),
		registerTool: (tool: MockWorkerTool) => tools.set(tool.name, tool),
		getActiveTools: () => [...state.active],
		setActiveTools: (names: string[]) => {
			state.active = [...names];
		},
	} as never;
	try {
		(workerExtension as (pi: unknown) => void)(pi);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return { handlers, tools, active: () => [...state.active] };
}

function makeWorkerCtx(overrides: {
	mode?: string;
	input?: (title: string, placeholder: string | undefined, opts: { signal?: AbortSignal } | undefined) => Promise<string | undefined>;
	notified?: string[];
} = {}): { ctx: ExtensionContext } {
	const notified = overrides.notified ?? [];
	const ctx = {
		mode: overrides.mode ?? "rpc",
		hasUI: true,
		ui: {
			input: overrides.input ?? (async () => undefined),
			notify: (message: string) => notified.push(message),
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx };
}

describe("worker messaging tools", () => {
	it("registers the messaging and mailbox tools only for orchestrator sub agents", () => {
		const sub = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1", PI_ORCHESTRATOR_ALLOWED_TOOLS: "read" });
		assert.deepEqual([...sub.tools.keys()].sort(), ["ask_main", "ask_user_question", "mailbox_read", "mailbox_send", "message_main"]);

		const main = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: undefined });
		assert.equal(main.tools.size, 0);
		assert.equal(main.handlers.size, 0);
	});

	it("unions messaging tools into the active set under a restrictive allowlist", async () => {
		// Simulate pi's post---tools active set: the role's tools plus the
		// messaging tools the CLI allowlist union keeps registered.
		const worker = loadWorkerPi(
			{ PI_ORCHESTRATOR_SUBAGENT: "1", PI_ORCHESTRATOR_ALLOWED_TOOLS: "read" },
			["read", "bash", "edit", "write", "message_main", "ask_main", "ask_user_question", "delegate"],
		);
		const sessionStart = worker.handlers.get("session_start")!;
		await sessionStart({ type: "session_start" }, makeWorkerCtx().ctx);
		assert.deepEqual(worker.active().sort(), ["ask_main", "ask_user_question", "mailbox_read", "mailbox_send", "message_main", "read"]);
	});

	it("allows messaging tool calls while enforcing the role allowlist and recursion block", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1", PI_ORCHESTRATOR_ALLOWED_TOOLS: "read" });
		const toolCall = worker.handlers.get("tool_call")!;
		const ctx = makeWorkerCtx().ctx;

		assert.equal(await toolCall({ toolName: "message_main", toolCallId: "c1", input: {} }, ctx), undefined);
		assert.equal(await toolCall({ toolName: "ask_main", toolCallId: "c2", input: {} }, ctx), undefined);
		assert.equal(await toolCall({ toolName: "ask_user_question", toolCallId: "c3", input: {} }, ctx), undefined);
		assert.equal(await toolCall({ toolName: "read", toolCallId: "c4", input: {} }, ctx), undefined);
		// coexisting checkpoint mailbox tools pass the guard alongside live messaging
		assert.equal(await toolCall({ toolName: "mailbox_send", toolCallId: "c6", input: {} }, ctx), undefined);
		assert.equal(await toolCall({ toolName: "mailbox_read", toolCallId: "c7", input: {} }, ctx), undefined);

		const blockedBash = (await toolCall({ toolName: "bash", toolCallId: "c5", input: {} }, ctx)) as { block: boolean; reason: string };
		assert.equal(blockedBash.block, true);
		assert.match(blockedBash.reason, /not allowed for this agent/);

		const blockedDelegate = (await toolCall({ toolName: "delegate", toolCallId: "c6", input: {} }, ctx)) as { block: boolean; reason: string };
		assert.equal(blockedDelegate.block, true);
		assert.match(blockedDelegate.reason, /Recursion blocked/);
	});

	it("message_main delivers an encoded envelope via notify", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		const notified: string[] = [];
		const { ctx } = makeWorkerCtx({ notified });
		const result = (await worker.tools.get("message_main")!.execute("c1", { message: "halfway through the parser" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		assert.equal(notified.length, 1);
		assert.deepEqual(decodeMessageEnvelope(notified[0]), { kind: "message", text: "halfway through the parser" });
		assert.match(result.content[0].text, /^delivered: /);
	});

	it("message_main is explicitly unavailable outside RPC (headless), without touching the UI", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		const notified: string[] = [];
		const { ctx } = makeWorkerCtx({ mode: "json", notified });
		const result = (await worker.tools.get("message_main")!.execute("c1", { message: "hi" }, undefined, undefined, ctx)) as {
			content: { text: string }[];
		};
		assert.match(result.content[0].text, /^unavailable: /);
		assert.equal(notified.length, 0);
	});

	it("ask_main sends a request envelope and returns the matched answer", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		let seenTitle = "";
		let seenOpts: { signal?: AbortSignal } | undefined;
		const { ctx } = makeWorkerCtx({
			input: async (title, _placeholder, opts) => {
				seenTitle = title;
				seenOpts = opts;
				return encodeReplyValue({ status: "answered", answer: "use approach B" });
			},
		});
		const result = (await worker.tools.get("ask_main")!.execute("c1", { question: "Which approach for the parser?", timeoutSeconds: 120 }, undefined, undefined, ctx)) as {
			content: { text: string }[];
		};
		const decoded = decodeRequestEnvelope(seenTitle);
		assert.ok(decoded.ok);
		assert.deepEqual(decoded.request, { kind: "ask_main", question: "Which approach for the parser?", timeoutSeconds: 120 });
		assert.ok(seenOpts?.signal instanceof AbortSignal, "worker must pass an abort signal so timeouts/cancels are distinguishable");
		assert.equal(result.content[0].text, "answered: use approach B");
	});

	it("ask_main reports explicit cancelled results and never fabricates an answer", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		const { ctx } = makeWorkerCtx({ input: async () => undefined });
		const result = (await worker.tools.get("ask_main")!.execute("c1", { question: "blocked?" }, undefined, undefined, ctx)) as { content: { text: string }[] };
		assert.equal(result.content[0].text, "cancelled: the request was dismissed without an answer");
	});

	it("ask_main distinguishes its own timeout from cancellation", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		const { ctx } = makeWorkerCtx({
			input: (_title, _placeholder, opts) =>
				new Promise<string | undefined>((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		});
		const result = (await worker.tools.get("ask_main")!.execute("c1", { question: "blocked?", timeoutSeconds: 1 }, undefined, undefined, ctx)) as {
			content: { text: string }[];
		};
		assert.equal(result.content[0].text, "timeout: no answer arrived in time");
	});

	it("ask_user_question validates options and carries them in the envelope", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		let seenTitle = "";
		const { ctx } = makeWorkerCtx({
			input: async (title) => {
				seenTitle = title;
				return encodeReplyValue({ status: "answered", answer: "Ship it" });
			},
		});

		await assert.rejects(
			worker.tools.get("ask_user_question")!.execute("c1", { question: "q", options: [{ label: "only one" }] }, undefined, undefined, ctx),
			/options must contain 2\.\.8/,
		);

		const result = (await worker.tools.get("ask_user_question")!.execute(
			"c2",
			{ question: "Ship Friday?", options: [{ label: "Ship it" }, { label: "Hold", description: "wait for QA" }], timeoutSeconds: 60 },
			undefined,
			undefined,
			ctx,
		)) as { content: { text: string }[] };
		const decoded = decodeRequestEnvelope(seenTitle);
		assert.ok(decoded.ok);
		assert.equal(decoded.request.kind, "ask_user_question");
		assert.deepEqual(decoded.request.options, [{ label: "Ship it" }, { label: "Hold", description: "wait for QA" }]);
		assert.equal(decoded.request.allowCustom, true, "allowCustom defaults to true");
		assert.equal(result.content[0].text, "answered: Ship it");
	});

	it("ask tools are explicitly unavailable outside RPC (headless)", async () => {
		const worker = loadWorkerPi({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		let inputCalled = 0;
		const { ctx } = makeWorkerCtx({
			mode: "print",
			input: async () => {
				inputCalled++;
				return undefined;
			},
		});
		const askMain = (await worker.tools.get("ask_main")!.execute("c1", { question: "q" }, undefined, undefined, ctx)) as { content: { text: string }[] };
		const askUser = (await worker.tools.get("ask_user_question")!.execute("c2", { question: "q" }, undefined, undefined, ctx)) as { content: { text: string }[] };
		assert.match(askMain.content[0].text, /^unavailable: /);
		assert.match(askUser.content[0].text, /^unavailable: /);
		assert.equal(inputCalled, 0, "no dialog may be opened without a transport");
	});
});

// ── Integration: runWorker RPC transport (fake RPC child) ────────────────────

const fakeRpcWorkerPath = path.join(tmp("orch-msg-worker-"), "fake-rpc-worker.mjs");
fs.writeFileSync(
	fakeRpcWorkerPath,
	[
		"import * as fs from 'node:fs';",
		"const spec = JSON.parse(fs.readFileSync(process.env.FAKE_SPEC, 'utf8'));",
		"const log = (entry) => { try { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n'); } catch {} };",
		"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
		"const respond = (command, id, success, error) => out(success",
		"  ? { id, type: 'response', command, success: true }",
		"  : { id, type: 'response', command, success: false, error });",
		"for (const w of spec.rawWrites ?? []) process.stdout.write(w);",
		"for (const e of spec.initialEvents ?? []) out(e);",
		"let buf = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => {",
		"  buf += chunk;",
		"  let i;",
		"  while ((i = buf.indexOf('\\n')) !== -1) {",
		"    let line = buf.slice(0, i);",
		"    buf = buf.slice(i + 1);",
		"    if (line.endsWith('\\r')) line = line.slice(0, -1);",
		"    if (!line.trim()) continue;",
		"    log({ stdin: line });",
		"    let cmd;",
		"    try { cmd = JSON.parse(line); } catch { continue; }",
		"    if (cmd.type === 'prompt') {",
		"      if (spec.promptResponse === 'error') respond('prompt', cmd.id, false, spec.promptError ?? 'no model selected');",
		"      else respond('prompt', cmd.id, true);",
		"      for (const e of spec.eventsAfterPrompt ?? []) out(e);",
		"    } else if (cmd.type === 'steer') {",
		"      if (spec.steerResponse === 'error') respond('steer', cmd.id, false, spec.steerError ?? 'steer rejected');",
		"      else respond('steer', cmd.id, true);",
		"      for (const e of spec.eventsAfterSteer ?? []) out(e);",
		"    } else if (cmd.type === 'extension_ui_response') {",
		"      log({ uiResponse: cmd });",
		"      if (spec.settleOnUiResponse) { log({ settledEmitted: Date.now() }); out({ type: 'agent_settled' }); }",
		"    }",
		"  }",
		"});",
		"if (spec.settleAfterMs !== undefined) setTimeout(() => { log({ settledEmitted: Date.now() }); out({ type: 'agent_settled' }); }, spec.settleAfterMs);",
		"if (spec.exitAfterMs !== undefined) setTimeout(() => process.exit(spec.exitCode ?? 7), spec.exitAfterMs);",
		"if (spec.exitImmediately) process.exit(spec.exitCode ?? 7);",
		"if (spec.keepAlive) setInterval(() => {}, 1000);",
		"process.stdin.on('end', () => {",
		"  log({ stdinEnd: Date.now() });",
		"  for (const e of spec.finalEvents ?? []) out(e);",
		"  process.exit(spec.exitCode ?? 0);",
		"});",
		"",
	].join("\n"),
);
const realArgv1 = process.argv[1];
process.argv[1] = fakeRpcWorkerPath;
after(() => {
	process.argv[1] = realArgv1;
});

function assistantEnd(text: string) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 7 },
			stopReason: "stop",
		},
	};
}

interface FakeSpec {
	rawWrites?: string[];
	initialEvents?: unknown[];
	eventsAfterPrompt?: unknown[];
	eventsAfterSteer?: unknown[];
	finalEvents?: unknown[];
	promptResponse?: "success" | "error" | "none";
	promptError?: string;
	steerResponse?: "success" | "error" | "none";
	steerError?: string;
	settleOnUiResponse?: boolean;
	settleAfterMs?: number;
	exitAfterMs?: number;
	exitImmediately?: boolean;
	keepAlive?: boolean;
	exitCode?: number;
}

interface ChildLog {
	stdin?: string;
	uiResponse?: { type: string; id: string; value?: string; cancelled?: boolean };
	settledEmitted?: number;
	stdinEnd?: number;
}

function makeTransportReq(
	spec: FakeSpec,
	hooks: {
		onMessage?: (message: WorkerMessage) => void;
		onRequest?: (request: WorkerRequest, rpc: { id: string; signal: AbortSignal }) => Promise<WorkerReply>;
		onControl?: (control: WorkerControl | undefined) => void;
	} = {},
): { req: SpawnRequest; logPath: string } {
	const attemptDir = tmp("orch-msg-attempt-");
	const specPath = path.join(tmp("orch-msg-spec-"), "spec.json");
	fs.mkdirSync(path.join(attemptDir, "session"), { recursive: true });
	fs.writeFileSync(specPath, JSON.stringify(spec));
	const logPath = path.join(attemptDir, "child.log");
	fs.writeFileSync(logPath, "");
	const cwd = tmp("orch-msg-cwd-");
	const req: SpawnRequest = {
		agent: makeAgent({ name: "worker" }),
		resolved: {
			alias: "worker-cheap",
			concrete: { provider: "fake", model: "fake/cheap" },
			source: "registry",
		},
		prompt: "do the work",
		cwd,
		jobId: "job-1",
		attemptId: "attempt-001",
		attemptDir,
		sessionDir: path.join(attemptDir, "session"),
		sessionId: "sess-1",
		workerExtensionPath: path.join(cwd, "worker.ts"),
		timeoutSeconds: 20,
		launchArgs: [],
		launchEnv: { FAKE_SPEC: specPath, FAKE_LOG: logPath },
		...(hooks.onMessage ? { onMessage: hooks.onMessage } : {}),
		...(hooks.onRequest ? { onRequest: hooks.onRequest } : {}),
		...(hooks.onControl ? { onControl: hooks.onControl } : {}),
	};
	return { req, logPath };
}

function readChildLog(logPath: string): ChildLog[] {
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ChildLog);
}

describe("runWorker RPC transport", () => {
	it("treats the prompt ACK as acceptance only; completes on agent_settled with a graceful final flush", async () => {
		const { req, logPath } = makeTransportReq({
			promptResponse: "success",
			eventsAfterPrompt: [assistantEnd("working")],
			settleAfterMs: 300,
			finalEvents: [assistantEnd("final answer")],
		});

		const outcome = await runWorker(req);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.finalText, "final answer");
		assert.equal(outcome.usage.turns, 2);

		const log = readChildLog(logPath);
		// The prompt traveled as a stdin command (never argv).
		const promptEntry = log.find((e) => {
			if (typeof e.stdin !== "string") return false;
			const cmd = JSON.parse(e.stdin);
			return cmd.type === "prompt" && cmd.message === "do the work" && typeof cmd.id === "string";
		});
		assert.ok(promptEntry, "prompt command must be written to stdin");

		// stdin was closed only after the genuine completion event, so the
		// child's final output (written on stdin end) flushed before exit.
		const settled = log.find((e) => e.settledEmitted !== undefined);
		const stdinEnd = log.find((e) => e.stdinEnd !== undefined);
		assert.ok(settled && stdinEnd);
		assert.ok(settled.settledEmitted! <= stdinEnd.stdinEnd!, "stdin must stay open past the prompt ACK until agent_settled");

		const stream = fs.readFileSync(path.join(req.attemptDir, "stream.jsonl"), "utf8").split("\n").filter(Boolean);
		const settledIndex = stream.findIndex((l) => l.includes('"agent_settled"'));
		const finalIndex = stream.findIndex((l) => l.includes("final answer"));
		assert.ok(settledIndex !== -1 && finalIndex !== -1);
		assert.ok(settledIndex < finalIndex, "graceful close must let the final output flush after agent_settled");
	});

	it("steers the running worker through the control handle and resolves on acceptance", async () => {
		let control: WorkerControl | undefined;
		let controlReleased = false;
		const { req, logPath } = makeTransportReq(
			{
				promptResponse: "success",
				eventsAfterPrompt: [assistantEnd("working")],
				steerResponse: "success",
				eventsAfterSteer: [{ type: "agent_settled" }],
				finalEvents: [assistantEnd("done after steer")],
			},
			{
				onControl: (c) => {
					if (c) control = c;
					else controlReleased = true;
				},
			},
		);

		const promise = runWorker(req);
		await waitFor(() => control !== undefined);
		await control!.steer("focus on the tests");
		const outcome = await promise;

		assert.equal(outcome.finalText, "done after steer");
		assert.equal(outcome.exitCode, 0);
		const steerEntry = readChildLog(logPath).find((e) => {
			if (typeof e.stdin !== "string") return false;
			const cmd = JSON.parse(e.stdin);
			return cmd.type === "steer" && cmd.message === "focus on the tests";
		});
		assert.ok(steerEntry, "steer command must reach the worker stdin");
		assert.equal(controlReleased, true, "onControl(undefined) must fire on exit");
	});

	it("rejects steer when the worker rejects the command", async () => {
		let control: WorkerControl | undefined;
		const { req } = makeTransportReq(
			{
				promptResponse: "success",
				eventsAfterPrompt: [assistantEnd("working")],
				steerResponse: "error",
				steerError: "Extension command \"/x\" cannot be queued",
				eventsAfterSteer: [{ type: "agent_settled" }],
			},
			{ onControl: (c) => (control = c ?? control) },
		);

		const promise = runWorker(req);
		await waitFor(() => control !== undefined);
		await assert.rejects(control!.steer("/x"), /steer rejected: .*cannot be queued/);
		const outcome = await promise;
		assert.equal(outcome.exitCode, 0);
	});

	it("parses one-way worker messages, including raw U+2028/U+2029 payloads (LF-only framing)", async () => {
		const unicodeText = "progress: line\u2028sep and para\u2029sep and emoji \u{1F389} done";
		const received: { kind: string; text: string }[] = [];
		const { req } = makeTransportReq(
			{
				promptResponse: "success",
				eventsAfterPrompt: [
					{ type: "extension_ui_request", id: "n1", method: "notify", message: encodeMessageEnvelope(unicodeText), notifyType: "info" },
					assistantEnd(`summary with \u2028 inside`),
				],
				settleAfterMs: 150,
			},
			{ onMessage: (m) => received.push(m) },
		);

		const outcome = await runWorker(req);
		assert.deepEqual(received, [{ kind: "message", text: unicodeText }]);
		assert.equal(outcome.finalText, "summary with \u2028 inside");
	});

	it("relays an ask request, matches the reply by native RPC id, and completes after the answer", async () => {
		const { req, logPath } = makeTransportReq(
			{
				promptResponse: "success",
				eventsAfterPrompt: [
					{
						type: "extension_ui_request",
						id: "ui-42",
						method: "input",
						title: encodeRequestEnvelope({ kind: "ask_main", question: "Which approach for the parser?", timeoutSeconds: 120 }),
					},
				],
				settleOnUiResponse: true,
				finalEvents: [assistantEnd("final answer")],
			},
			{
				onRequest: async (request, rpc) => {
					assert.equal(request.kind, "ask_main");
					assert.equal(request.question, "Which approach for the parser?");
					assert.equal(request.timeoutSeconds, 120);
					assert.equal(rpc.id, "ui-42");
					assert.ok(rpc.signal instanceof AbortSignal);
					return { status: "answered", answer: "use approach B" };
				},
			},
		);

		const outcome = await runWorker(req);
		assert.equal(outcome.finalText, "final answer");
		assert.equal(outcome.exitCode, 0);

		const uiResponse = readChildLog(logPath).find((e) => e.uiResponse)?.uiResponse;
		assert.ok(uiResponse);
		assert.equal(uiResponse.type, "extension_ui_response");
		assert.equal(uiResponse.id, "ui-42");
		assert.deepEqual(decodeReplyValue(uiResponse.value!), { status: "answered", answer: "use approach B" });
	});

	it("answers ask requests with an explicit unavailable reply when no handler is attached", async () => {
		const { req, logPath } = makeTransportReq({
			promptResponse: "success",
			eventsAfterPrompt: [
				{
					type: "extension_ui_request",
					id: "ui-7",
					method: "input",
					title: encodeRequestEnvelope({ kind: "ask_user_question", question: "Ship Friday?" }),
				},
			],
			settleOnUiResponse: true,
		});

		const outcome = await runWorker(req);
		assert.equal(outcome.exitCode, 0);
		const uiResponse = readChildLog(logPath).find((e) => e.uiResponse)?.uiResponse;
		assert.ok(uiResponse);
		const reply = decodeReplyValue(uiResponse.value!);
		assert.equal(reply.status, "unavailable");
		assert.match((reply as { reason: string }).reason, /no request handler/);
	});

	it("answers malformed messaging envelopes with an error reply and cancels unrecognized dialogs", async () => {
		const { req, logPath } = makeTransportReq({
			promptResponse: "success",
			eventsAfterPrompt: [
				{ type: "extension_ui_request", id: "bad-1", method: "input", title: `${MESSAGING_PREFIX}{not json` },
				{ type: "extension_ui_request", id: "sel-1", method: "select", title: "Allow dangerous command?", options: ["Allow", "Block"] },
				{ type: "extension_ui_request", id: "note-1", method: "notify", message: "ordinary notification" },
				{ type: "extension_ui_request", id: "note-2", method: "notify", message: `${MESSAGING_PREFIX}{broken` },
			],
			settleAfterMs: 200,
		});

		const messages: unknown[] = [];
		const outcome = await runWorker({ ...req, onMessage: () => messages.push(1) });
		assert.equal(outcome.exitCode, 0);
		assert.equal(messages.length, 0, "malformed envelopes must never surface as messages");

		const log = readChildLog(logPath);
		const badReply = log.find((e) => e.uiResponse?.id === "bad-1")?.uiResponse;
		assert.ok(badReply);
		assert.equal(decodeReplyValue(badReply.value!).status, "error");

		const cancelled = log.find((e) => e.uiResponse?.id === "sel-1")?.uiResponse;
		assert.ok(cancelled);
		assert.equal(cancelled.cancelled, true, "unrecognized dialogs must be cancelled so the worker cannot hang");

		assert.equal(log.some((e) => e.uiResponse?.id === "note-1" || e.uiResponse?.id === "note-2"), false, "fire-and-forget methods get no response");
	});

	it("ignores malformed and oversized stdout lines but keeps processing events (stream byte cap)", async () => {
		const oversized = JSON.stringify({ type: "message_update", marker: "OVERSIZED_MARKER", pad: "x".repeat(MAX_STREAM_BYTES + 1024) });
		const { req } = makeTransportReq({
			rawWrites: [`{not valid json\n`, `${JSON.stringify({ type: "session_start", sessionId: "s" })}\r\n`, `${oversized}\n`],
			promptResponse: "success",
			eventsAfterPrompt: [assistantEnd("final answer")],
			settleAfterMs: 100,
		});

		const outcome = await runWorker(req);
		assert.equal(outcome.finalText, "final answer");
		assert.equal(outcome.sessionId, "s", "CRLF-terminated lines must parse");
		const captured = fs.readFileSync(path.join(req.attemptDir, "stream.jsonl"), "utf8");
		assert.ok(!captured.includes("not valid json"));
		assert.ok(!captured.includes("OVERSIZED_MARKER"), "oversized lines must be skipped from the bounded capture");
		assert.ok(captured.includes('"agent_settled"'));
	});

	it("fails explicitly when the worker rejects the prompt before running", async () => {
		const { req } = makeTransportReq({ promptResponse: "error", promptError: "No model selected" });
		const outcome = await runWorker(req);
		assert.equal(outcome.usage.turns, 0);
		assert.ok(outcome.runError, "a rejected prompt must be a run failure");
		assert.match(outcome.errorMessage ?? "", /prompt rejected: No model selected/);
	});

	it("early exit: resolves without waiting on pending request callbacks, aborts their signals, and refuses late steers", async () => {
		const signalSeen: AbortSignal[] = [];
		const { req } = makeTransportReq(
			{
				initialEvents: [
					{
						type: "extension_ui_request",
						id: "ui-early",
						method: "input",
						title: encodeRequestEnvelope({ kind: "ask_main", question: "blocked?" }),
					},
				],
				promptResponse: "success",
				exitAfterMs: 300,
				exitCode: 7,
			},
			{
				onRequest: (request, rpc) =>
					new Promise<WorkerReply>(() => {
						// Never resolves on purpose: the transport must not hang on it.
						signalSeen.push(rpc.signal);
						void request;
					}),
				onControl: () => {},
			},
		);

		let control: WorkerControl | undefined;
		const outcome = await runWorker({ ...req, onControl: (c) => (control = c ?? control) });
		assert.equal(outcome.exitCode, 7);
		assert.ok(outcome.runError);
		assert.equal(signalSeen.length, 1);
		assert.equal(signalSeen[0].aborted, true, "per-request AbortController must be invalidated on exit");
		// Steer after exit must refuse instead of pretending success.
		await assert.rejects(control!.steer("too late"), /stdin is closed|exited/);
	});

	it("drops whitespace-only message_main envelopes and never surfaces them as messages", async () => {
		// The wire boundary rejects blank text: an envelope that slipped through
		// with whitespace-only text decodes to nothing (never a message, never a crash).
		const received: unknown[] = [];
		const { req } = makeTransportReq(
			{
				promptResponse: "success",
				eventsAfterPrompt: [
					{ type: "extension_ui_request", id: "blank-1", method: "notify", message: `${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "message", text: "   \t " })}` },
					{ type: "extension_ui_request", id: "blank-2", method: "notify", message: `${MESSAGING_PREFIX}${JSON.stringify({ v: 1, kind: "message", text: "" })}` },
					assistantEnd("final answer"),
				],
				settleAfterMs: 100,
			},
			{ onMessage: (m) => received.push(m) },
		);

		const outcome = await runWorker(req);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.finalText, "final answer");
		assert.equal(received.length, 0, "blank messages must be dropped at the boundary");
		// the encoder rejects blank text up front too
		assert.throws(() => encodeMessageEnvelope("   \t "), /blank/);
		assert.throws(() => encodeRequestEnvelope({ kind: "ask_main", question: " " }), /blank/);
	});

	it("a throwing onMessage callback never crashes the parent; the run still completes", async () => {
		const received: unknown[] = [];
		const { req } = makeTransportReq(
			{
				promptResponse: "success",
				eventsAfterPrompt: [
					{ type: "extension_ui_request", id: "good-1", method: "notify", message: encodeMessageEnvelope("legit message before the crasher") },
					{ type: "extension_ui_request", id: "crash-1", method: "notify", message: encodeMessageEnvelope("this one explodes the callback") },
					assistantEnd("final answer"),
				],
				settleAfterMs: 100,
			},
			{
				onMessage: (m) => {
					received.push(m);
					if ((m as { text: string }).text.includes("explodes")) throw new Error("broker callback exploded");
				},
			},
		);

		const outcome = await runWorker(req);
		assert.equal(outcome.exitCode, 0, "the parent transport must survive a throwing observer");
		assert.equal(outcome.finalText, "final answer", "stdout parsing continues past the crasher");
		assert.equal(received.length, 2, "both messages reached the callback");
	});

	it("preserves overall execution timeout termination", async () => {
		const { req } = makeTransportReq({ promptResponse: "success", eventsAfterPrompt: [assistantEnd("working")], keepAlive: true });
		const outcome = await runWorker({ ...req, timeoutSeconds: 1 });
		assert.ok(outcome.runError);
		assert.equal(outcome.runError!.kind, "timeout");
	});

	it("preserves abort termination", async () => {
		const { req } = makeTransportReq({ promptResponse: "success", eventsAfterPrompt: [assistantEnd("working")], keepAlive: true });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 250);
		const outcome = await runWorker({ ...req, signal: controller.signal });
		assert.ok(outcome.runError);
		assert.equal(outcome.runError!.kind, "aborted");
	});
});
