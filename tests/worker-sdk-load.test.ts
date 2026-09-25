/**
 * Real SDK extension load smoke — loads worker.ts through the INSTALLED pi
 * SDK's public loader (`discoverAndLoadExtensions` from
 * `@earendil-works/pi-coding-agent`, present in both the project SDK 0.85.1
 * and the global runtime 0.87.1), so tool and event registration runs against
 * the REAL ExtensionAPI implementation: jiti TypeScript module load, real
 * Extension objects (tools/handlers maps), real pi.sendMessage forwarding.
 *
 * No network, no model credentials: the shared runtime's action methods are
 * replaced with recording stubs and registered handlers are invoked directly.
 *
 * Honest test boundary: the live agent-loop drain of a queued follow-up
 * (turn_end → sendMessage(deliverAs followUp) → next model turn) needs a
 * running pi runtime with credentials and is NOT exercised here. Enqueue
 * ordering (before receipts) and full checkpoint semantics are covered in
 * tests/worker-mailbox.test.ts; this smoke proves the same code paths run
 * through the real SDK registration surface with zero load errors.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
	discoverAndLoadExtensions,
	type Extension,
	type ExtensionContext,
	type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { JobStore } from "../core/storage.ts";
import { DEFAULT_RETRY } from "../core/types.ts";
import { readPendingMailboxMessages, sendMailboxMessage } from "../core/mailbox.ts";
import { buildChildEnv, type SpawnRequest } from "../core/spawn.ts";
import { MAILBOX_EVIDENCE_CUSTOM_TYPE } from "../core/mailbox-delivery.ts";

const workerPath = fileURLToPath(new URL("../worker.ts", import.meta.url));

// ── Hermetic sandbox + env discipline ───────────────────────────────────────

const liveRoots = new Set<string>();
process.on("exit", () => {
	for (const r of liveRoots) {
		try {
			fs.rmSync(r, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	liveRoots.clear();
});

function tmpRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sdk-load-"));
	liveRoots.add(root);
	return root;
}

const ENV_KEYS = ["PI_ORCHESTRATOR_SUBAGENT", "PI_ORCHESTRATOR_ALLOWED_TOOLS", "PI_ORCHESTRATOR_JOB_ID", "PI_ORCHESTRATOR_ATTEMPT_ID", "PI_ORCHESTRATOR_JOB_DIR", "PI_ORCHESTRATOR_ATTEMPT_DIR"];
const savedEnv = new Map<string, string | undefined>();
function setEnv(env: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(env)) {
		if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}
after(() => {
	for (const [k, v] of savedEnv) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	savedEnv.clear();
});

// ── Real store fixture (same layout core/mailbox.ts requires) ───────────────

function makeJob(store: JobStore, jobId: string): string {
	store.createJobDir(jobId);
	store.writeJob({
		schemaVersion: 1,
		jobId,
		objective: `objective for ${jobId}`,
		agent: "worker",
		dependsOn: [],
		status: "ready",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		cwd: "/tmp",
		retry: DEFAULT_RETRY,
		attemptCount: 1,
	});
	const attemptId = store.allocateAttempt(jobId);
	store.writeAttempt({ schemaVersion: 1, attemptId, jobId, agent: "worker", retryMode: "initial", status: "running", startedAt: Date.now() });
	return attemptId;
}

function identityEnvFor(store: JobStore, jobId: string, attemptId: string): Record<string, string> {
	const attemptDir = store.attemptDir(jobId, attemptId);
	const spawnEnv = buildChildEnv({ attemptDir, agent: {} } as SpawnRequest, { jobId, attemptId, artifactsDir: path.join(attemptDir, "artifacts") });
	return {
		PI_ORCHESTRATOR_SUBAGENT: "1",
		PI_ORCHESTRATOR_JOB_ID: spawnEnv.PI_ORCHESTRATOR_JOB_ID!,
		PI_ORCHESTRATOR_ATTEMPT_ID: spawnEnv.PI_ORCHESTRATOR_ATTEMPT_ID!,
		PI_ORCHESTRATOR_JOB_DIR: spawnEnv.PI_ORCHESTRATOR_JOB_DIR!,
		PI_ORCHESTRATOR_ATTEMPT_DIR: spawnEnv.PI_ORCHESTRATOR_ATTEMPT_DIR!,
	};
}

// ── Recording runtime (real createExtensionRuntime + real API surface) ──────

interface SentRecord {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

interface Harness {
	extension: Extension;
	sent: SentRecord[];
	setActiveCalls: string[][];
}

async function loadWorker(env: Record<string, string | undefined>, activeTools: string[]): Promise<Harness> {
	setEnv(env);
	const sent: SentRecord[] = [];
	const setActiveCalls: string[][] = [];
	let active = [...activeTools];

	// Hermetic discovery roots: nothing but worker.ts is loaded.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sdk-cwd-"));
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sdk-agent-"));
	liveRoots.add(cwd);
	liveRoots.add(agentDir);
	const result = await discoverAndLoadExtensions([workerPath], cwd, agentDir);
	assert.deepEqual(result.errors, [], `real SDK loader must report zero errors: ${JSON.stringify(result.errors)}`);
	assert.equal(result.extensions.length, 1, "exactly one extension loaded");

	// The real ExtensionAPI delegates action calls to this shared runtime at
	// call time; replacing them with recording stubs needs no fake ExtensionAPI.
	const runtime: ExtensionRuntime = result.runtime;
	runtime.getActiveTools = () => [...active];
	runtime.setActiveTools = (names: string[]) => {
		active = [...names];
		setActiveCalls.push([...names]);
	};
	runtime.sendMessage = ((message: SentRecord["message"], options?: SentRecord["options"]) => {
		sent.push({ message, options });
	}) as ExtensionRuntime["sendMessage"];

	return { extension: result.extensions[0]!, sent, setActiveCalls };
}

function ctx(): ExtensionContext {
	return { ui: { setStatus: () => {} } } as unknown as ExtensionContext;
}

async function fire(ext: Extension, event: string, payload: unknown): Promise<unknown> {
	const list = ext.handlers.get(event) ?? [];
	assert.ok(list.length > 0, `handler "${event}" registered`);
	let last: unknown;
	for (const handler of list) last = await (handler as (e: unknown, c: unknown) => unknown)(payload, ctx());
	return last;
}

// ── Smoke tests ─────────────────────────────────────────────────────────────

describe("real SDK load smoke: worker.ts via discoverAndLoadExtensions", () => {
	it("loads with zero errors and registers mailbox tools + checkpoint hook on the real API", async () => {
		const store = new JobStore(tmpRoot());
		const attemptId = makeJob(store, "worker-job");
		const { extension } = await loadWorker(identityEnvFor(store, "worker-job", attemptId), ["read"]);

		for (const name of ["mailbox_send", "mailbox_read"]) {
			const tool = extension.tools.get(name);
			assert.ok(tool, `${name} registered through the real SDK loader`);
			assert.ok(tool.definition.description, `${name} carries a description`);
			assert.ok((tool.definition.parameters as { properties?: unknown }).properties !== undefined || name === "mailbox_read", `${name} exposes its schema`);
		}
		for (const event of ["session_start", "tool_call", "turn_end"]) {
			assert.ok(extension.handlers.has(event), `"${event}" handler registered (checkpoint wired on the real API)`);
		}
	});

	it("session_start on the real API: mailbox tools active despite a restrictive allowlist, orchestrator tools hard-stripped", async () => {
		const store = new JobStore(tmpRoot());
		const attemptId = makeJob(store, "worker-job");
		const { extension, setActiveCalls } = await loadWorker(
			{ ...identityEnvFor(store, "worker-job", attemptId), PI_ORCHESTRATOR_ALLOWED_TOOLS: "read" },
			["read", "bash", "delegate", "jobs", "subagent"],
		);

		await fire(extension, "session_start", {});
		assert.deepEqual(setActiveCalls.at(-1), ["read", "mailbox_send", "mailbox_read"]);
	});

	it("tool_call gate on the real API: delegate/jobs/subagent hard-blocked, mailbox tools exempt, allowlist enforced", async () => {
		const store = new JobStore(tmpRoot());
		const attemptId = makeJob(store, "worker-job");
		const { extension } = await loadWorker(
			{ ...identityEnvFor(store, "worker-job", attemptId), PI_ORCHESTRATOR_ALLOWED_TOOLS: "read" },
			["read"],
		);

		for (const forbidden of ["delegate", "jobs", "subagent"]) {
			const blocked = (await fire(extension, "tool_call", { toolName: forbidden })) as { block?: boolean } | undefined;
			assert.equal(blocked?.block, true, `${forbidden} hard-blocked`);
		}
		assert.equal(await fire(extension, "tool_call", { toolName: "mailbox_read" }), undefined, "mailbox_read exempt");
		assert.equal(await fire(extension, "tool_call", { toolName: "mailbox_send" }), undefined, "mailbox_send exempt");
		assert.equal(await fire(extension, "tool_call", { toolName: "read" }), undefined, "allowlisted tool allowed");
		const bash = (await fire(extension, "tool_call", { toolName: "bash" })) as { block?: boolean } | undefined;
		assert.equal(bash?.block, true, "non-allowlisted tool blocked");
	});

	it("turn_end checkpoint through the real API: pi.sendMessage enqueue, receipts written, no re-delivery", async () => {
		const store = new JobStore(tmpRoot());
		const peerAttempt = makeJob(store, "peer-job");
		const attemptId = makeJob(store, "worker-job");
		const sent0 = await sendMailboxMessage(store.root, { fromJobId: "peer-job", fromAttemptId: peerAttempt, toJobId: "worker-job", body: "sdk smoke: peer evidence" });
		const { extension, sent } = await loadWorker(identityEnvFor(store, "worker-job", attemptId), ["read"]);

		await fire(extension, "turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
		assert.equal(sent.length, 1, "exactly one enqueue via the real pi.sendMessage");
		assert.equal(sent[0]!.message.customType, MAILBOX_EVIDENCE_CUSTOM_TYPE);
		assert.equal(sent[0]!.options?.deliverAs, "followUp");
		assert.match(sent[0]!.message.content, /UNTRUSTED PEER EVIDENCE/);
		assert.match(sent[0]!.message.content, /sdk smoke: peer evidence/);
		const receiptPath = path.join(store.attemptDir("worker-job", attemptId), "mailbox-receipts", `${sent0.id}.json`);
		assert.ok(fs.existsSync(receiptPath), "receipt written after the enqueue returned");

		// Receipt suppresses re-delivery: a second checkpoint is a no-op.
		await fire(extension, "turn_end", { type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
		assert.equal(sent.length, 1, "no duplicate enqueue after receipt");
		assert.deepEqual((await readPendingMailboxMessages(store.root, "worker-job", attemptId)).map((m) => m.id), [], "nothing pending after checkpoint");
	});

	it("without spawn identity the checkpoint hook is not registered; tools still load", async () => {
		setEnv({ PI_ORCHESTRATOR_SUBAGENT: "1" });
		const { extension } = await loadWorker({ PI_ORCHESTRATOR_JOB_ID: undefined, PI_ORCHESTRATOR_ATTEMPT_ID: undefined, PI_ORCHESTRATOR_JOB_DIR: undefined, PI_ORCHESTRATOR_ATTEMPT_DIR: undefined }, ["read"]);
		assert.ok(extension.tools.has("mailbox_send"), "tools still registered");
		assert.ok(extension.tools.has("mailbox_read"), "tools still registered");
		assert.equal(extension.handlers.has("turn_end"), false, "checkpoint disabled without trusted identity");
	});
});
