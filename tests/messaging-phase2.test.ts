/**
 * tests/messaging-phase2.test.ts — phase 2 live agent messaging.
 *
 * Covers the parent broker (core/broker.ts) + Orchestrator surface, the
 * ask_user_question UI helper (ask-user.ts), and the extension-level
 * deadlock-free attention yielding (index.ts) end to end:
 *
 *   A. Broker correlation across two simultaneous workers, duplicate/late/
 *      cross-job reply rejection, parent-enforced timeout, child exit/cancel,
 *      restart-stale requests, live-worker run guards, messageJob delivery
 *      (steer ACK only), attention subscription/consumption, bounded inbox.
 *   B. UI helper: option select, custom typed answer, Escape cancel, timeout,
 *      headless unavailability, RPC built-in fallback, FIFO queue with
 *      per-request isolation, deadline honoured while queued.
 *   C. Extension integration against a fake RPC child (the argv[1] seam):
 *      delegate yields on ask_main while the child stays alive → jobs reply →
 *      background completion notification; messages wake an idle main via
 *      pi.sendMessage; DAG dependents wait for the real result; cancellation
 *      aborts the live child; worker ask_user_question renders in the main
 *      session with job/agent identity; headless returns unavailable; the
 *      main ask_user_question tool is active under lockdown.
 *
 * Deterministic: workerRunner injection (A) and fake RPC children (C) — no
 * network, no provider calls.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventLog } from "../core/events.ts";
import { MessageBroker } from "../core/broker.ts";
import {
	encodeMessageEnvelope,
	encodeReplyValue,
	encodeRequestEnvelope,
	type WorkerReply,
} from "../core/messaging.ts";
import type { SpawnRequest } from "../core/spawn.ts";
import { makeAgent, makeHarness, outcome, tmpRoot, writingWorker } from "./helpers.ts";
import { askUserQuestion } from "../ask-user.ts";

// Raw terminal input sequences (what handleInput receives from the TUI).
// matchesKey() compares raw data against key NAMES (Key.enter === "enter"),
// so tests must feed the escape sequences, not the Key constants.
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESCAPE = "\x1b";

async function waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 15));
	}
}

const roots: string[] = [];
function tmp(prefix = "orch-p2-"): string {
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

// ── A. Parent broker (Orchestrator + injected workerRunner driving the hooks) ─

describe("broker: request correlation and lifecycle", () => {
	function askingHarness(question: (index: number) => string, childSignals: AbortSignal[]) {
		const h = makeHarness();
		const replies: WorkerReply[] = [];
		h.setWorker(async (req) => {
			const index = h.workerCalls.length - 1;
			const signal = new AbortController().signal;
			childSignals.push(signal);
			req.onControl?.({
				steer: async () => {
					/* ACK immediately */
				},
			});
			const reply = await req.onRequest!({ kind: "ask_main", question: question(index) }, { id: `rpc-${index}`, signal });
			replies.push(reply);
			const o = writingWorker(() => outcome({ status: "success", summary: `done after ${reply.status}` }))(req);
			req.onControl?.(undefined); // like runWorker: the control handle dies with the child
			return o;
		});
		return { h, replies };
	}

	it("correlates replies by requestId across two simultaneous workers", async () => {
		const childSignals: AbortSignal[] = [];
		const { h, replies } = askingHarness((i) => `question ${i}`, childSignals);
		const jobA = h.orch.createJob({ agent: "worker", task: "A" }, h.agents);
		const jobB = h.orch.createJob({ agent: "worker", task: "B" }, h.agents);
		const runA = h.orch.runJob(jobA, h.agents);
		const runB = h.orch.runJob(jobB, h.agents);

		await waitFor(() => h.orch.broker.pendingRequests().length === 2);
		const pending = h.orch.broker.pendingRequests();
		assert.deepEqual(pending.map((p) => p.requestId).sort(), ["rpc-0", "rpc-1"]);
		assert.deepEqual(pending.map((p) => p.jobId).sort(), [jobA.jobId, jobB.jobId].sort());

		h.orch.reply(jobA.jobId, "rpc-0", "answer A");
		h.orch.reply(jobB.jobId, "rpc-1", "answer B");
		const [ra, rb] = await Promise.all([runA, runB]);
		assert.equal(ra.status, "success");
		assert.equal(rb.status, "success");
		assert.deepEqual(replies.map((r) => (r as { answer?: string }).answer), ["answer A", "answer B"]);
		h.cleanup();
	});

	it("rejects duplicate, cross-job, and unknown replies explicitly", async () => {
		const childSignals: AbortSignal[] = [];
		const { h } = askingHarness((i) => `q${i}`, childSignals);
		const jobA = h.orch.createJob({ agent: "worker", task: "A" }, h.agents);
		const jobB = h.orch.createJob({ agent: "worker", task: "B" }, h.agents);
		const runA = h.orch.runJob(jobA, h.agents);
		const runB = h.orch.runJob(jobB, h.agents);
		await waitFor(() => h.orch.broker.pendingRequests().length === 2);

		// cross-job: rpc-0 belongs to jobA
		assert.throws(() => h.orch.reply(jobB.jobId, "rpc-0", "wrong job"), /belongs to job/);
		h.orch.reply(jobA.jobId, "rpc-0", "answer A");
		// duplicate: already answered
		assert.throws(() => h.orch.reply(jobA.jobId, "rpc-0", "again"), /already answered/);
		// unknown / stale id
		assert.throws(() => h.orch.reply(jobA.jobId, "rpc-nope", "x"), /Unknown request/);
		h.orch.reply(jobB.jobId, "rpc-1", "answer B");
		await Promise.all([runA, runB]);
		h.cleanup();
	});

	it("enforces the parent-side deadline: timeout settles the request and cleans up", async () => {
		const childSignals: AbortSignal[] = [];
		const h = makeHarness();
		const seen: WorkerReply[] = [];
		h.setWorker(async (req) => {
			const reply = await req.onRequest!({ kind: "ask_main", question: "blocked?", timeoutSeconds: 1 }, { id: "rpc-t", signal: new AbortController().signal });
			seen.push(reply);
			return writingWorker(() => outcome({ status: "success", summary: "continued" }))(req);
		});
		const job = h.orch.createJob({ agent: "worker", task: "slow ask" }, h.agents);
		const report = await h.orch.runJob(job, h.agents);
		assert.equal(report.status, "success", "the worker resumes after an explicit timeout");
		assert.deepEqual(seen, [{ status: "timeout" }]);
		const items = h.orch.inbox(job.jobId).filter((i) => i.type === "request");
		assert.equal(items[0].status, "timeout");
		assert.equal(h.orch.broker.pendingRequests().length, 0, "timed-out requests are removed from pending");
		assert.throws(() => h.orch.reply(job.jobId, "rpc-t", "too late"), /already timeout/);
		h.cleanup();
	});

	it("child exit settles cancelled, never revives, and rejects late replies", async () => {
		const h = makeHarness();
		const seen: WorkerReply[] = [];
		const childController = new AbortController();
		h.setWorker(async (req) => {
			const reply = await req.onRequest!({ kind: "ask_main", question: "blocked?" }, { id: "rpc-x", signal: childController.signal });
			seen.push(reply);
			return writingWorker(() => outcome({ status: "success", summary: "gave up" }))(req);
		});
		const job = h.orch.createJob({ agent: "worker", task: "will exit" }, h.agents);
		const runPromise = h.orch.runJob(job, h.agents);
		await waitFor(() => h.orch.broker.pendingRequests().length === 1);
		childController.abort(); // the worker process exits before answering
		const report = await runPromise;
		assert.equal(report.status, "success");
		assert.deepEqual(seen, [{ status: "cancelled" }]);
		const items = h.orch.inbox(job.jobId).filter((i) => i.type === "request");
		assert.equal(items[0].status, "cancelled");
		assert.throws(() => h.orch.reply(job.jobId, "rpc-x", "late"), /already cancelled/);
		h.cleanup();
	});

	it("requests from an old process/restart are stale forever (never revived)", async () => {
		const root = tmpRoot();
		const h1 = makeHarness({ root });
		h1.setWorker(async (req) => {
			await req.onRequest!({ kind: "ask_main", question: "blocked?", timeoutSeconds: 2 }, { id: "rpc-old", signal: new AbortController().signal });
			return writingWorker(() => outcome({ status: "success", summary: "done" }))(req);
		});
		const job = h1.orch.createJob({ agent: "worker", task: "restart scenario" }, h1.agents);
		const runPromise = h1.orch.runJob(job, h1.agents); // pending on the ask
		await waitFor(() => h1.orch.broker.pendingRequests().length === 1);
		// simulate an orchestrator restart: a fresh runtime over the same root
		const h2 = makeHarness({ root });
		assert.throws(() => h2.orch.reply(job.jobId, "rpc-old", "late answer"), /Unknown request/);
		assert.equal(h2.orch.broker.pendingRequests().length, 0);
		// the old process's request times out on its own and the old run settles
		const report = await runPromise;
		assert.equal(report.status, "success");
		h2.cleanup();
		h1.cleanup();
	});

	it("guards followup/retry/run while a worker is live; messageJob works instead", async () => {
		const h = makeHarness();
		const childController = new AbortController();
		const steered: string[] = [];
		h.setWorker(async (req) => {
			req.onControl?.({
				steer: async (text) => {
					steered.push(text);
				},
			});
			const reply = await req.onRequest!({ kind: "ask_main", question: "blocked?" }, { id: "rpc-g", signal: childController.signal });
			assert.equal(reply.status, "cancelled");
			const o = writingWorker(() => outcome({ status: "success", summary: "cancelled ask" }))(req);
			req.onControl?.(undefined); // the child exits at run end
			return o;
		});
		const job = h.orch.createJob({ agent: "worker", task: "guard me" }, h.agents);
		const runPromise = h.orch.runJob(job, h.agents);
		await waitFor(() => h.orch.hasLiveWorker(job.jobId));

		await assert.rejects(() => h.orch.followupJob(job.jobId, "again", h.agents), /live worker/);
		await assert.rejects(() => h.orch.runJob(job, h.agents), /live worker/);
		await assert.rejects(() => h.orch.retryJob(job.jobId, h.agents), /live worker|is running/);

		// the live-worker channel: steer with delivery claimed only on ACK
		await h.orch.messageJob(job.jobId, "stay focused on the parser");
		assert.deepEqual(steered, ["stay focused on the parser"]);
		const inbox = h.orch.inbox(job.jobId);
		const mainMsg = inbox.find((i) => i.type === "message" && i.direction === "main");
		assert.ok(mainMsg && mainMsg.type === "message" && mainMsg.delivered, "steered message recorded as delivered only after ACK");

		childController.abort();
		const report = await runPromise;
		assert.equal(report.status, "success");

		// after the child is gone the guards open again
		h.setWorker(writingWorker(() => outcome({ status: "success", summary: "followed up" })));
		const follow = await h.orch.followupJob(job.jobId, "one more thing", h.agents);
		assert.equal(follow.status, "success");
		h.cleanup();
	});

	it("messageJob errors explicitly for unknown, non-running, and refusing workers", async () => {
		const h = makeHarness();
		const job = h.orch.createJob({ agent: "worker", task: "plain" }, h.agents);
		await assert.rejects(() => h.orch.messageJob(job.jobId, "hi"), /not running/);
		await h.orch.runJob(h.orch.createJob({ agent: "worker", task: "x" }, h.agents), h.agents);
		await assert.rejects(() => h.orch.messageJob("no-such-job", "hi"), /Unknown job/);
		// a live worker that refuses the steer: no delivery claim, no inbox record
		const childController = new AbortController();
		h.setWorker(async (req) => {
			req.onControl?.({
				steer: async () => {
					throw new Error("steer rejected: worker busy");
				},
			});
			await req.onRequest!({ kind: "ask_main", question: "q" }, { id: "rpc-m", signal: childController.signal });
			const o = writingWorker(() => outcome({ status: "success", summary: "ok" }))(req);
			req.onControl?.(undefined);
			return o;
		});
		const job2 = h.orch.createJob({ agent: "worker", task: "refuse steer" }, h.agents);
		const runPromise = h.orch.runJob(job2, h.agents);
		await waitFor(() => h.orch.hasLiveWorker(job2.jobId));
		await assert.rejects(() => h.orch.messageJob(job2.jobId, "hello?"), /steer rejected: worker busy/);
		assert.equal(h.orch.inbox(job2.jobId).some((i) => i.type === "message" && i.direction === "main"), false, "failed steers are never recorded as delivered");
		childController.abort();
		await runPromise;
		h.cleanup();
	});
});

describe("broker: attention, human questions, and bounds", () => {
	it("emits attention for messages and ask_main but not ask_user_question; reading consumes", () => {
		const root = tmp();
		const events = new EventLog(path.join(root, "jobs"));
		const broker = new MessageBroker(events);
		const attention: string[] = [];
		broker.onAttention((att) => attention.push(att.id));

		broker.handleWorkerMessage("j1", "attempt-001", { kind: "message", text: "halfway there" });
		broker.handleWorkerRequest("j1", "attempt-001", "worker", { kind: "ask_main", question: "which?" }, { id: "r-main", signal: new AbortController().signal });
		broker.handleWorkerRequest("j1", "attempt-001", "worker", { kind: "ask_user_question", question: "ship?" }, { id: "r-user", signal: new AbortController().signal });
		assert.deepEqual(attention.length, 2, "user questions go to the UI seam, not main-model attention");
		assert.equal(broker.hasUnconsumedAttention("j1"), true);
		const items = broker.readInbox("j1");
		assert.equal(items.length, 3);
		assert.equal(broker.hasUnconsumedAttention("j1"), false, "reading consumes attention");
		broker.dispose(); // session teardown: settles the still-pending ask_main and clears its timer
	});

	it("routes ask_user_question through the human seam with combined deadline/child signal", async () => {
		const root = tmp();
		const events = new EventLog(path.join(root, "jobs"));
		const broker = new MessageBroker(events);
		const seenSignals: AbortSignal[] = [];
		broker.setHumanQuestionHandler(async (routed, rpc) => {
			assert.equal(routed.jobId, "j1");
			assert.equal(routed.agent, "coder");
			assert.equal(routed.request.kind, "ask_user_question");
			seenSignals.push(rpc.signal);
			return { status: "answered", answer: "Ship it" };
		});
		const reply = await broker.handleWorkerRequest(
			"j1",
			"attempt-001",
			"coder",
			{ kind: "ask_user_question", question: "Ship Friday?", options: [{ label: "Ship it" }, { label: "Hold" }] },
			{ id: "r-user", signal: new AbortController().signal },
		);
		assert.deepEqual(reply, { status: "answered", answer: "Ship it" });
		assert.equal(seenSignals.length, 1);
		// without a handler: explicit unavailable, never an invented answer
		broker.setHumanQuestionHandler(undefined);
		const reply2 = await broker.handleWorkerRequest("j1", "attempt-001", "coder", { kind: "ask_user_question", question: "again?" }, { id: "r-user2", signal: new AbortController().signal });
		assert.equal(reply2.status, "unavailable");
	});

	it("aborts the UI seam at the deadline and discards late answers (settle once)", async () => {
		const root = tmp();
		const events = new EventLog(path.join(root, "jobs"));
		const broker = new MessageBroker(events);
		let uiResolves = 0;
		broker.setHumanQuestionHandler((_routed, rpc) =>
			new Promise<WorkerReply>((resolve) => {
				rpc.signal.addEventListener("abort", () => {
					uiResolves++;
					resolve({ status: "cancelled" });
				}, { once: true });
				// the "user" answers only well after the deadline already fired
				setTimeout(() => {
					uiResolves++;
					resolve({ status: "answered", answer: "too late" });
				}, 1500);
			}),
		);
		const reply = await broker.handleWorkerRequest("j1", "attempt-001", "coder", { kind: "ask_user_question", question: "slow?", timeoutSeconds: 1 }, { id: "r-dead", signal: new AbortController().signal });
		assert.equal(reply.status, "timeout", "the parent deadline wins");
		// let the late UI answer actually fire, then prove it was discarded:
		// the request stays timeout (never answered) and cannot be revived.
		await new Promise((r) => setTimeout(r, 700));
		assert.ok(uiResolves >= 2, "the late UI answer arrived");
		const item = broker.readInbox("j1").find((i) => i.type === "request") as { status: string };
		assert.equal(item.status, "timeout", "a late UI answer must never flip the settled request to answered");
		assert.throws(() => broker.reply("j1", "r-dead", "too late"), /already timeout/);
	});

	it("keeps the inbox bounded (latest 100 items, per job)", () => {
		const root = tmp();
		const events = new EventLog(path.join(root, "jobs"));
		const broker = new MessageBroker(events);
		for (let i = 0; i < 150; i++) broker.handleWorkerMessage("j1", "attempt-001", { kind: "message", text: `m${i}` });
		const items = broker.readInbox("j1");
		assert.equal(items.length, 100);
		const first = items[0];
		assert.ok(first.type === "message" && first.text === "m50", "oldest items dropped, latest kept");
	});
});

// ── B. ask-user.ts UI helper (simulated TUI/RPC/headless) ─────────────────────

interface CapturedDialog {
	component: { render: (width: number) => string[]; handleInput: (data: string) => void };
	options: unknown;
}

function makeTuiCtx(overrides: { mode?: string; hasUI?: boolean } = {}) {
	const opened: CapturedDialog[] = [];
	const tui = { requestRender: () => {} };
	const theme = { fg: (_color: string, s: string) => s, bg: (_color: string, s: string) => s, bold: (s: string) => s };
	const ctx = {
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown, options: unknown) => {
				let resolveFn!: (value: unknown) => void;
				const promise = new Promise((resolve) => {
					resolveFn = resolve;
				});
				const component = factory(tui, theme, undefined, (value) => resolveFn(value)) as CapturedDialog["component"];
				opened.push({ component, options });
				return promise;
			},
			select: async (_title: string, labels: string[]) => labels[0],
			input: async () => undefined,
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx, opened };
}

describe("ask-user UI helper", () => {
	it("selects an option with up/down + Enter", async () => {
		const { ctx, opened } = makeTuiCtx();
		const promise = askUserQuestion(ctx, { question: "Pick one", options: [{ label: "A" }, { label: "B" }, { label: "C" }] });
		await waitFor(() => opened.length === 1);
		opened[0].component.handleInput(DOWN);
		opened[0].component.handleInput(ENTER);
		const result = await promise;
		assert.deepEqual(result, { status: "answered", answer: "B", wasCustom: false });
	});

	it("accepts a typed custom answer when allowCustom is true", async () => {
		const { ctx, opened } = makeTuiCtx();
		const promise = askUserQuestion(ctx, { question: "Pick", options: [{ label: "A" }, { label: "B" }], allowCustom: true });
		await waitFor(() => opened.length === 1);
		opened[0].component.handleInput(DOWN);
		opened[0].component.handleInput(DOWN); // "Type your own answer"
		opened[0].component.handleInput(ENTER);
		opened[0].component.handleInput("hello world");
		opened[0].component.handleInput(ENTER);
		const result = await promise;
		assert.deepEqual(result, { status: "answered", answer: "hello world", wasCustom: true });
	});

	it("text-only questions take inline input directly", async () => {
		const { ctx, opened } = makeTuiCtx();
		const promise = askUserQuestion(ctx, { question: "Name?" });
		await waitFor(() => opened.length === 1);
		opened[0].component.handleInput("Ada");
		opened[0].component.handleInput(ENTER);
		const result = await promise;
		assert.deepEqual(result, { status: "answered", answer: "Ada", wasCustom: true });
	});

	it("Escape cancels explicitly (never a default answer)", async () => {
		const { ctx, opened } = makeTuiCtx();
		const promise = askUserQuestion(ctx, { question: "Pick", options: [{ label: "A" }, { label: "B" }] });
		await waitFor(() => opened.length === 1);
		opened[0].component.handleInput(ESCAPE);
		assert.deepEqual(await promise, { status: "cancelled" });
	});

	it("times out with an explicit timeout result and no default answer", async () => {
		const { ctx, opened } = makeTuiCtx();
		const promise = askUserQuestion(ctx, { question: "Slow?", options: [{ label: "A" }, { label: "B" }], timeoutSeconds: 1 });
		await waitFor(() => opened.length === 1);
		assert.deepEqual(await promise, { status: "timeout" });
	});

	it("returns unavailable immediately in headless modes (no dialog)", async () => {
		for (const mode of ["json", "print"]) {
			const { ctx, opened } = makeTuiCtx({ mode });
			const result = await askUserQuestion(ctx, { question: "q" });
			assert.equal(result.status, "unavailable");
			assert.equal(opened.length, 0, "no dialog may open without a UI");
		}
		const noUi = makeTuiCtx({ hasUI: false });
		const result2 = await askUserQuestion(noUi.ctx, { question: "q" });
		assert.equal(result2.status, "unavailable");
	});

	it("RPC mode falls back to the built-in select/input dialogs", async () => {
		const opened: CapturedDialog[] = [];
		const selectCalls: { title: string; labels: string[] }[] = [];
		const inputCalls: string[] = [];
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				custom: (factory: never, options: unknown) => {
					opened.push({ component: undefined as never, options });
					return Promise.resolve(null);
				},
				select: async (title: string, labels: string[]) => {
					selectCalls.push({ title, labels });
					return "Ship it";
				},
				input: async (title: string) => {
					inputCalls.push(title);
					return "typed answer";
				},
				notify: () => {},
			},
		} as unknown as ExtensionContext;
		const picked = await askUserQuestion(ctx, { question: "Ship?", options: [{ label: "Ship it" }, { label: "Hold" }] });
		assert.deepEqual(picked, { status: "answered", answer: "Ship it", wasCustom: false });
		assert.equal(selectCalls.length, 1);
		// custom answer when select dismissed
		const select = { ...ctx, ui: { ...ctx.ui, select: async () => undefined } } as unknown as ExtensionContext;
		const custom = await askUserQuestion(select, { question: "Ship?", options: [{ label: "A" }, { label: "B" }], allowCustom: true });
		assert.deepEqual(custom, { status: "answered", answer: "typed answer", wasCustom: true });
		// text-only → input directly; escape → cancelled
		const textOnly = { ...ctx, ui: { ...ctx.ui, input: async () => undefined } } as unknown as ExtensionContext;
		const cancelled = await askUserQuestion(textOnly, { question: "Free text?" });
		assert.deepEqual(cancelled, { status: "cancelled" });
		assert.equal(opened.length, 0, "ctx.ui.custom is never used in RPC mode");
	});

	it("RPC fallback reports timeout when the local deadline aborts the built-in dialog", async () => {
		// built-in dialogs resolve undefined on abort; no default answer is chosen
		const dialog = (opts: { signal?: AbortSignal } | undefined) =>
			new Promise<string | undefined>((resolve) => {
				if (opts?.signal?.aborted) return resolve(undefined);
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (_t: string, _l: string[], opts: { signal?: AbortSignal }) => dialog(opts),
				input: async (_t: string, _p: string, opts: { signal?: AbortSignal }) => dialog(opts),
				notify: () => {},
				custom: async () => null,
			},
		} as unknown as ExtensionContext;
		const result = await askUserQuestion(ctx, { question: "Slow?", options: [{ label: "A" }, { label: "B" }], timeoutSeconds: 1 });
		assert.deepEqual(result, { status: "timeout" }, "deadline-abort must map to timeout, not cancelled");
		const textOnly = await askUserQuestion(ctx, { question: "Free text?", timeoutSeconds: 1 });
		assert.deepEqual(textOnly, { status: "timeout" });
	});

	it("RPC fallback reports cancelled on explicit dismissal (Escape), never a default answer", async () => {
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async () => undefined, // user dismisses the option list
				input: async () => undefined, // user dismisses the custom dialog
				notify: () => {},
				custom: async () => null,
			},
		} as unknown as ExtensionContext;
		const picked = await askUserQuestion(ctx, { question: "Pick?", options: [{ label: "A" }, { label: "B" }], allowCustom: false, timeoutSeconds: 5 });
		assert.deepEqual(picked, { status: "cancelled" }, "explicit dismissal must map to cancelled");
		const textOnly = await askUserQuestion(ctx, { question: "Free text?", timeoutSeconds: 5 });
		assert.deepEqual(textOnly, { status: "cancelled" });
	});

	it("serializes simultaneous questions FIFO with answers isolated to the exact request", async () => {
		const { ctx, opened } = makeTuiCtx();
		const q1 = askUserQuestion(ctx, { question: "First?", options: [{ label: "One" }, { label: "Two" }] });
		const q2 = askUserQuestion(ctx, { question: "Second?", options: [{ label: "AAA" }, { label: "BBB" }] });
		await waitFor(() => opened.length === 1);
		// answer the FIRST question (its options)
		opened[0].component.handleInput(ENTER);
		assert.deepEqual(await q1, { status: "answered", answer: "One", wasCustom: false });
		await waitFor(() => opened.length === 2);
		// the second question then opens with ITS options
		opened[1].component.handleInput(DOWN);
		opened[1].component.handleInput(ENTER);
		assert.deepEqual(await q2, { status: "answered", answer: "BBB", wasCustom: false });
	});

	it("honours deadlines while queued: an expired question is never shown or answered", async () => {
		const { ctx, opened } = makeTuiCtx();
		const q1 = askUserQuestion(ctx, { question: "First?", options: [{ label: "One" }, { label: "Two" }] });
		const q2 = askUserQuestion(ctx, { question: "Second?", options: [{ label: "A" }, { label: "B" }], timeoutSeconds: 1 });
		await waitFor(() => opened.length === 1);
		// q2 expires while still queued behind q1
		assert.deepEqual(await q2, { status: "timeout" });
		assert.equal(opened.length, 1, "the expired question never opened a dialog");
		opened[0].component.handleInput(ENTER);
		assert.deepEqual(await q1, { status: "answered", answer: "One", wasCustom: false });
	});

	it("external abort closes an open dialog as cancelled", async () => {
		const { ctx, opened } = makeTuiCtx();
		const controller = new AbortController();
		const promise = askUserQuestion(ctx, { question: "Open?", options: [{ label: "A" }, { label: "B" }] }, { signal: controller.signal });
		await waitFor(() => opened.length === 1);
		controller.abort();
		assert.deepEqual(await promise, { status: "cancelled" });
	});
});

// ── C. Extension integration (fake RPC children over the argv[1] seam) ────────

// Hermetic sandbox created BEFORE importing the extension module.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "orch-p2-ext-"));
const agentDir = path.join(sandbox, "pi-agent");
const agentsRoot = path.join(sandbox, "agents");
const configDir = path.join(sandbox, "config");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CONFIG_DIR = configDir;
delete process.env.PI_ORCHESTRATOR_SUBAGENT;
for (const dir of [agentsRoot, configDir, path.join(agentsRoot, "worker"), path.join(agentsRoot, "main")]) {
	fs.mkdirSync(dir, { recursive: true });
}
const orchRoot = path.join(sandbox, "orchestrator");
fs.mkdirSync(orchRoot, { recursive: true });
fs.writeFileSync(
	path.join(agentsRoot, "worker", "AGENT.md"),
	[
		"---",
		"name: worker",
		"description: Deterministic phase-2 RPC worker.",
		"role: sub",
		"runtime: {}",
		"limits:",
		"  timeoutSeconds: 60",
		"context:",
		"  mode: none",
		"workspace:",
		"  strategy: cwd",
		"  cleanup: keep",
		"validation:",
		"  commands: []",
		"retry:",
		"  maxAttempts: 1",
		"hooks:",
		"  enabled: false",
		"---",
		"",
		"Phase-2 worker body.",
		"",
	].join("\n"),
);
fs.writeFileSync(
	path.join(agentsRoot, "main", "AGENT.md"),
	["---", "name: main", "description: Test main agent.", "role: main", "---", "", "Plan and delegate.", ""].join("\n"),
);
fs.writeFileSync(
	path.join(orchRoot, "models.yaml"),
	["models:", "  worker-cheap:", "    provider: fake", "    model: fake/cheap", "defaults:", "  worker: worker-cheap", ""].join("\n"),
);

// Fake RPC child: replays behavior from PI_CONFIG_DIR/fake-rpc-spec.json,
// selected by sequential spawn order (PI_CONFIG_DIR/fake-rpc-count).
const fakeChildPath = path.join(sandbox, "fake-rpc-child.mjs");
fs.writeFileSync(
	fakeChildPath,
	[
		"import * as fs from 'node:fs';",
		"import * as path from 'node:path';",
		`const cfg = process.env.PI_CONFIG_DIR ?? '';`,
		"const logFile = path.join(cfg, 'fake-rpc-child.log');",
		"const log = (e) => { try { fs.appendFileSync(logFile, JSON.stringify(e) + '\\n'); } catch {} };",
		"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
		"const spec = JSON.parse(fs.readFileSync(path.join(cfg, 'fake-rpc-spec.json'), 'utf8'));",
		"let counter = 0;",
		"try { counter = parseInt(fs.readFileSync(path.join(cfg, 'fake-rpc-count'), 'utf8'), 10) || 0; } catch {}",
		"try { fs.writeFileSync(path.join(cfg, 'fake-rpc-count'), String(counter + 1)); } catch {}",
		"const byId = (spec.jobs ?? {})[process.env.PI_ORCHESTRATOR_JOB_ID ?? \'\'];",
		"const behavior = byId ?? spec.behaviors[Math.min(counter, spec.behaviors.length - 1)];",
		"if (process.env.PI_ORCHESTRATOR_RESULT_PATH) {",
		"  fs.writeFileSync(process.env.PI_ORCHESTRATOR_RESULT_PATH, JSON.stringify({",
		"    schemaVersion: 1,",
		"    jobId: process.env.PI_ORCHESTRATOR_JOB_ID,",
		"    attemptId: process.env.PI_ORCHESTRATOR_ATTEMPT_ID,",
		"    status: behavior.resultStatus ?? 'success',",
		"    summary: behavior.summary ?? 'fake rpc worker done',",
		"    findings: [], changes: [], validation: { status: 'skipped', checks: [] },",
		"    artifacts: [], blockers: [], followUps: [], metrics: {},",
		"  }, null, 2));",
		"}",
		"out({ type: 'session_start', sessionId: 'fake-rpc-session' });",
		"out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 2 }, stopReason: 'stop' } });",
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
		"    let cmd; try { cmd = JSON.parse(line); } catch { continue; }",
		"    if (cmd.type === 'prompt') {",
		"      out({ id: cmd.id, type: 'response', command: 'prompt', success: true });",
		"      if (behavior.ask) out({ type: 'extension_ui_request', id: behavior.askId ?? 'ui-ask', method: 'input', title: behavior.ask });",
		"      if (behavior.settleAfterMs !== undefined) setTimeout(() => out({ type: 'agent_settled' }), behavior.settleAfterMs);",
		"    } else if (cmd.type === 'steer') {",
		"      log({ steered: cmd.message });",
		"      out({ id: cmd.id, type: 'response', command: 'steer', success: true });",
		"    } else if (cmd.type === 'extension_ui_response') {",
		"      log({ uiResponse: cmd });",
		"      if (behavior.settleOnUiResponse !== false) out({ type: 'agent_settled' });",
		"      for (const e of behavior.eventsAfterUiResponse ?? []) out(e);",
		"    }",
		"  }",
		"});",
		"if (behavior.keepAlive) setInterval(() => {}, 1000);",
		"process.stdin.on('end', () => { log({ stdinEnd: Date.now() }); process.exit(0); });",
		"",
	].join("\n"),
);
const realArgv1 = process.argv[1];
process.argv[1] = fakeChildPath;
after(() => {
	process.argv[1] = realArgv1;
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CONFIG_DIR;
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

interface FakeBehavior {
	ask?: string;
	askId?: string;
	settleOnUiResponse?: boolean;
	settleAfterMs?: number;
	keepAlive?: boolean;
	resultStatus?: string;
	eventsAfterUiResponse?: unknown[];
}

function writeSpec(behaviors: FakeBehavior[], jobs: Record<string, FakeBehavior> = {}): void {

	fs.writeFileSync(path.join(configDir, "fake-rpc-spec.json"), JSON.stringify({ behaviors, jobs }));
	fs.rmSync(path.join(configDir, "fake-rpc-count"), { force: true });
	fs.writeFileSync(path.join(configDir, "fake-rpc-child.log"), "");
}

function readChildLog(): Array<Record<string, unknown>> {
	return fs
		.readFileSync(path.join(configDir, "fake-rpc-child.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

type Update = { content: { type: "text"; text: string }[]; details?: unknown };
interface SentMessage {
	message: { customType: string; content: string; display: boolean };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

function makeMockPi(withMain: boolean) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
	const tools = new Map<string, { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: ((u: Update) => void) | undefined, ctx: unknown) => Promise<unknown> }>();
	const sent: SentMessage[] = [];
	const activeToolCalls: string[][] = [];
	const allToolNames = ["delegate", "jobs", "ask_user_question", "read", "bash", "edit"];
	let active: string[] = [...allToolNames];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => handlers.set(event, handler),
		registerTool: (tool: { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: ((u: Update) => void) | undefined, ctx: unknown) => Promise<unknown> }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		registerProvider: () => {},
		getAllTools: () => allToolNames.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
			activeToolCalls.push([...names]);
		},
		setModel: async () => {},
		setThinkingLevel: () => {},
		appendEntry: () => {},
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			sent.push({ message, options });
		},
		events: { emit: () => {} },
	} as unknown as ExtensionAPI;
	void withMain;
	return { pi, handlers, tools, sent, activeToolCalls, activeNames: () => active };
}

function makeExtCtx(overrides: { mode?: string; hasUI?: boolean } = {}) {
	const opened: CapturedDialog[] = [];
	const tui = { requestRender: () => {} };
	const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
	const ctx = {
		cwd: sandbox,
		mode: overrides.mode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown, options: unknown) => {
				let resolveFn!: (value: unknown) => void;
				const promise = new Promise((resolve) => {
					resolveFn = resolve;
				});
				const component = factory(tui, theme, undefined, (value) => resolveFn(value)) as CapturedDialog["component"];
				opened.push({ component, options });
				return promise;
			},
			select: async (_t: string, labels: string[]) => labels[0],
			input: async () => undefined,
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			theme: undefined,
		},
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "p2-session",
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;
	return { ctx, opened };
}

function readStoredJob(jobId: string): { status: string; startedAt?: number; completedAt?: number } | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(orchRoot, "jobs", jobId, "job.json"), "utf8"));
	} catch {
		return null;
	}
}

/** Raw attempt.json read: the live-worker regression asserts the attempt was never flipped to interrupted. */
function readStoredAttempt(jobId: string): { status: string; ownerPid?: number } | null {
	try {
		const attemptsDir = path.join(orchRoot, "jobs", jobId, "attempts");
		for (const name of fs.readdirSync(attemptsDir)) {
			return JSON.parse(fs.readFileSync(path.join(attemptsDir, name, "attempt.json"), "utf8"));
		}
		return null;
	} catch {
		return null;
	}
}

const extension = (await import("../index.ts")).default;

async function toolText(mock: ReturnType<typeof makeMockPi>, name: string, params: Record<string, unknown>, ctx: ExtensionContext): Promise<{ text: string; details: Record<string, unknown>; isError?: boolean }> {
	const result = (await mock.tools.get(name)!.execute(`call-${name}-${Math.random()}`, params, undefined, undefined, ctx)) as {
		content: { type: string; text: string }[];
		details: Record<string, unknown>;
		isError?: boolean;
	};
	return { text: result.content[0]?.text ?? "", details: result.details, isError: result.isError };
}

describe("extension: live messaging end to end", () => {
	it("delegate yields on ask_main while the worker stays alive; jobs reply completes the run", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({ kind: "ask_main", question: "Which approach for the parser?", timeoutSeconds: 120 }),
				askId: "ui-42",
				settleOnUiResponse: true,
				eventsAfterUiResponse: [
					{ type: "extension_ui_request", id: "note-1", method: "notify", message: encodeMessageEnvelope("reached the parser; applying the fix now") },
				],
			},
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);

		const delegate = mock.tools.get("delegate")!;
		const yielded = (await delegate.execute("c1", { agent: "worker", task: "fix the parser" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
			details: { jobIds?: string[]; yielded?: boolean };
		};
		const text = yielded.content[0]!.text;
		assert.match(text, /delegate yielded/, `expected early yield, got: ${text}`);
		assert.match(text, /requestId: ui-42/);
		assert.match(text, /Which approach for the parser\?/);
		assert.equal(yielded.details.yielded, true);
		const jobId = yielded.details.jobIds![0]!;
		const job = readStoredJob(jobId);
		assert.equal(job?.status, "running", "the job keeps its running status during a pending ask");

		// answer via the jobs tool (exact correlation)
		const reply = await toolText(mock, "jobs", { action: "reply", jobId, requestId: "ui-42", answer: "use approach B" }, ctx);
		assert.match(reply.text, /delivered: answered request ui-42/);

		// the background run completes and the main model is woken via sendMessage
		await waitFor(() => mock.sent.some((m) => m.message.content.includes(`background job ${jobId} finished: success`)));
		// the worker saw the answer on its stdin
		const uiResponse = readChildLog().find((e) => "uiResponse" in e)?.uiResponse as { id: string; value?: string };
		assert.equal(uiResponse.id, "ui-42");
		assert.match(uiResponse.value ?? "", /"answered"/);
		assert.match(uiResponse.value ?? "", /use approach B/);
		// the one-way message reached the main model as a typed custom message
		await waitFor(() => mock.sent.some((m) => m.message.content.includes("reached the parser")));
		const attentionMsg = mock.sent.find((m) => m.message.content.includes("reached the parser"))!;
		assert.equal(attentionMsg.message.customType, "orchestrator-message");
		assert.equal(attentionMsg.options?.triggerTurn, true, "idle main is woken with triggerTurn");
		assert.equal(readStoredJob(jobId)?.status, "success");
	});

	it("inbox lists pending requests and messages; reply rejects stale duplicates at the tool level", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({ kind: "ask_main", question: "Which DB?", timeoutSeconds: 120 }),
				askId: "ui-db",
				settleOnUiResponse: true,
			},
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		const yielded = (await delegate.execute("c1", { agent: "worker", task: "db work" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
			details: { jobIds?: string[] };
		};
		const jobId = yielded.details.jobIds![0]!;

		const inbox = await toolText(mock, "jobs", { action: "inbox", jobId }, ctx);
		assert.match(inbox.text, /ask_main/);
		assert.match(inbox.text, /ui-db/);
		assert.match(inbox.text, /Which DB\?/);

		const ok = await toolText(mock, "jobs", { action: "reply", jobId, requestId: "ui-db", answer: "postgres" }, ctx);
		assert.match(ok.text, /delivered: answered request/);
		const stale = await toolText(mock, "jobs", { action: "reply", jobId, requestId: "ui-db", answer: "again" }, ctx);
		assert.equal(stale.isError, true, "duplicate replies must fail explicitly");
		await waitFor(() => readStoredJob(jobId)?.status === "success");
	});

	it("DAG dependents wait for the real result across a yield", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({ kind: "ask_main", question: "Choose the port?", timeoutSeconds: 120 }),
				askId: "ui-port",
				settleOnUiResponse: true,
			},
			{ settleAfterMs: 200 },
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		const yielded = (await delegate.execute(
			"c1",
			{
				jobs: [
					{ agent: "worker", task: "first job", id: "dag-a" },
					{ agent: "worker", task: "second job", id: "dag-b", dependsOn: ["dag-a"] },
				],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: { type: string; text: string }[]; details: { jobIds?: string[] } };
		assert.match(yielded.content[0]!.text, /delegate batch yielded/);

		// answer the first job's question; the second job must run only AFTER
		// the first job's actual result lands.
		const ok = await toolText(mock, "jobs", { action: "reply", jobId: "dag-a", requestId: "ui-port", answer: "8080" }, ctx);
		assert.match(ok.text, /delivered/);
		await waitFor(() => readStoredJob("dag-a")?.status === "success");
		await waitFor(() => readStoredJob("dag-b")?.status === "success");
		// the dependent started after its prerequisite completed
		const a = readStoredJob("dag-a") as { status: string; startedAt?: number; completedAt?: number };
		const b = readStoredJob("dag-b") as { status: string; startedAt?: number };
		assert.ok(b.startedAt && (a.completedAt ?? 0) <= b.startedAt, "dependent must start after the prerequisite completes");
		// both spawns happened (sequential counter)
		assert.equal(fs.readFileSync(path.join(configDir, "fake-rpc-count"), "utf8"), "2");
	});

	it("jobs status/list/graph/wait keep a live worker's job running (no false interrupted)", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({ kind: "ask_main", question: "Blocked while you inspect?", timeoutSeconds: 30 }),
				askId: "ui-inspect",
				settleOnUiResponse: true,
			},
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		const yielded = (await delegate.execute("c1", { agent: "worker", task: "inspectable" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
			details: { jobIds?: string[] };
		};
		const jobId = yielded.details.jobIds![0]!;
		assert.equal(readStoredJob(jobId)?.status, "running");

		// Every inspection path applies crash recovery on read — with a LIVE
		// owner the attempt must stay "running" (previously these flipped it).
		const status = await toolText(mock, "jobs", { action: "status", jobId }, ctx);
		assert.match(status.text, /status: running/);
		const list = await toolText(mock, "jobs", { action: "list" }, ctx);
		assert.match(list.text, /running/);
		const graph = await toolText(mock, "jobs", { action: "graph" }, ctx);
		assert.match(graph.text, /running/);
		// raw attempt record never flipped to interrupted
		const attempt = readStoredAttempt(jobId);
		assert.equal(attempt?.status, "running", "a live owner's attempt must not be marked interrupted");
		assert.equal(attempt?.ownerPid, process.pid, "ownerPid is persisted for liveness checks");

		// jobs.wait polls the store while the child is alive; run it concurrently
		// with the reply so the poll window overlaps the pending ask.
		const waitPromise = toolText(mock, "jobs", { action: "wait", jobId }, ctx);
		const msg = await toolText(mock, "jobs", { action: "message", jobId, message: "keep going after your answer" }, ctx);
		assert.match(msg.text, /delivered: message sent to the live worker/, "the live child must still be steerable after inspection reads");
		assert.equal(readStoredAttempt(jobId)?.status, "running");

		const reply = await toolText(mock, "jobs", { action: "reply", jobId, requestId: "ui-inspect", answer: "go with plan B" }, ctx);
		assert.match(reply.text, /delivered: answered request/);
		const waitResult = await waitPromise;
		assert.match(waitResult.text, /success/);
		await waitFor(() => readStoredJob(jobId)?.status === "success");
	});

	it("concurrent A/B/C: A finishes while B asks; B is never interrupted; C starts only after B's real completion", async () => {
		writeSpec(
			[{ settleAfterMs: 150 }],
			{
				"conc-a": { settleAfterMs: 150 },
				"conc-b": {
					ask: encodeRequestEnvelope({ kind: "ask_main", question: "Which port?", timeoutSeconds: 30 }),
					askId: "ui-port-b",
					settleOnUiResponse: true,
				},
				"conc-c": { settleAfterMs: 150 },
			},
		);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		const yielded = (await delegate.execute(
			"c1",
			{
				jobs: [
					{ agent: "worker", task: "independent quick job", id: "conc-a" },
					{ agent: "worker", task: "asks a blocking question", id: "conc-b" },
					{ agent: "worker", task: "depends on the answer", id: "conc-c", dependsOn: ["conc-b"] },
				],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: { type: string; text: string }[]; details: { jobIds?: string[] } };
		assert.match(yielded.content[0]!.text, /delegate batch yielded/);

		// A finishes while B is still blocked on its ask
		await waitFor(() => readStoredJob("conc-a")?.status === "success");
		assert.equal(readStoredJob("conc-b")?.status, "running");
		assert.equal(readStoredAttempt("conc-b")?.status, "running", "B must never be flipped to interrupted while its owner is alive");
		// a graph poll while B is blocked must not corrupt B either
		const graph = await toolText(mock, "jobs", { action: "graph" }, ctx);
		assert.match(graph.text, /conc-b/);
		assert.equal(readStoredAttempt("conc-b")?.status, "running");

		const reply = await toolText(mock, "jobs", { action: "reply", jobId: "conc-b", requestId: "ui-port-b", answer: "8080" }, ctx);
		assert.match(reply.text, /delivered: answered request/);
		await waitFor(() => readStoredJob("conc-b")?.status === "success");
		await waitFor(() => readStoredJob("conc-c")?.status === "success");
		// C started only after B's real completion
		const b = readStoredJob("conc-b") as { completedAt?: number };
		const c = readStoredJob("conc-c") as { startedAt?: number };
		assert.ok(c.startedAt && b.completedAt && c.startedAt >= b.completedAt, "C must start after B actually completes");
	});

	it("jobs cancel aborts a live background worker without leaked processes", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({ kind: "ask_main", question: "Never answered?", timeoutSeconds: 30 }),
				askId: "ui-never",
				settleOnUiResponse: false, // the worker never settles on its own
				keepAlive: true,
			},
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		const yielded = (await delegate.execute("c1", { agent: "worker", task: "cancellable" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
			details: { jobIds?: string[] };
		};
		const jobId = yielded.details.jobIds![0]!;
		assert.equal(readStoredJob(jobId)?.status, "running");

		const cancelled = await toolText(mock, "jobs", { action: "cancel", jobId }, ctx);
		assert.match(cancelled.text, /Cancelled/);
		// the live child is killed (SIGTERM on abort) and the run settles
		await waitFor(() => readStoredJob(jobId)?.status === "cancelled");
		await waitFor(() => mock.sent.some((m) => m.message.content.includes("finished: cancelled")));
	});

	it("worker ask_user_question renders in the main session with job/agent identity and returns the user's choice", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({
					kind: "ask_user_question",
					question: "Ship Friday?",
					options: [
						{ label: "Ship it" },
						{ label: "Hold", description: "wait for QA" },
					],
					allowCustom: true,
					timeoutSeconds: 120,
				}),
				askId: "ui-user",
				settleOnUiResponse: true,
			},
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx, opened } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		// ask_user_question does NOT yield: the delegate keeps running while the
		// popup renders in the main session.
		const runPromise = delegate.execute("c1", { agent: "worker", task: "needs a user decision" }, undefined, undefined, ctx);
		await waitFor(() => opened.length === 1);
		const rendered = opened[0].component.render(80).join("\n");
		assert.match(rendered, /job \S+ · agent worker/, "identity must show job + agent");
		assert.match(rendered, /Ship Friday\?/);
		assert.match(rendered, /Ship it/);
		assert.match(rendered, /wait for QA/);
		// pick the first option
		opened[0].component.handleInput(ENTER);
		const result = (await runPromise) as { content: { type: string; text: string }[] };
		assert.match(result.content[0]!.text, /success/, "the worker completes with the user's answer");
		const uiResponse = readChildLog().find((e) => "uiResponse" in e)?.uiResponse as { id: string; value?: string };
		assert.equal(uiResponse.id, "ui-user");
		assert.match(uiResponse.value ?? "", /"answered"/);
		assert.match(uiResponse.value ?? "", /Ship it/);
	});

	it("headless sessions answer ask_user_question as unavailable immediately", async () => {
		writeSpec([
			{
				ask: encodeRequestEnvelope({ kind: "ask_user_question", question: "Anyone there?", timeoutSeconds: 120 }),
				askId: "ui-headless",
				settleOnUiResponse: true,
			},
		]);
		const mock = makeMockPi(false);
		extension(mock.pi);
		const { ctx, opened } = makeExtCtx({ mode: "json", hasUI: false });
		await mock.handlers.get("session_start")!({}, ctx);
		const delegate = mock.tools.get("delegate")!;
		const result = (await delegate.execute("c1", { agent: "worker", task: "headless ask" }, undefined, undefined, ctx)) as {
			content: { type: string; text: string }[];
		};
		assert.equal(opened.length, 0, "no dialog in headless mode");
		assert.match(result.content[0]!.text, /success/, "the worker continues after an explicit unavailable");
		const uiResponse = readChildLog().find((e) => "uiResponse" in e)?.uiResponse as { id: string; value?: string };
		assert.equal(uiResponse.id, "ui-headless");
		assert.match(uiResponse.value ?? "", /"unavailable"/);
	});

	it("main ask_user_question stays active under lockdown and answers verbatim", async () => {
		const mock = makeMockPi(true);
		extension(mock.pi);
		const { ctx, opened } = makeExtCtx();
		await mock.handlers.get("session_start")!({}, ctx);
		// lockdown: active tools = delegate + jobs + ask_user_question
		assert.deepEqual(mock.activeNames().sort(), ["ask_user_question", "delegate", "jobs"]);
		// tool_call policy: allowed through
		const toolCall = mock.handlers.get("tool_call")!;
		assert.equal(await toolCall({ toolName: "ask_user_question", toolCallId: "t1", input: {} }, ctx), undefined);
		const blocked = (await toolCall({ toolName: "read", toolCallId: "t2", input: {} }, ctx)) as { block: boolean };
		assert.equal(blocked.block, true);
		// execute the tool against the shared popup: the execute stays pending
		// while the dialog is open, so drive the popup concurrently.
		const executePromise = mock.tools.get("ask_user_question")!.execute(
			"c1",
			{ question: "Deploy now?", options: [{ label: "Now" }, { label: "Later", description: "after QA" }], allowCustom: true, timeoutSeconds: 30 },
			undefined,
			undefined,
			ctx,
		);
		await waitFor(() => opened.length === 1);
		opened[0].component.handleInput(ENTER);
		const answer = (await executePromise) as { content: { type: string; text: string }[]; details: { answer?: string } };
		assert.equal(opened.length, 1, "the shared popup component is used");
		assert.match(answer.content[0]!.text, /User answered: Now/);
		assert.equal(answer.details.answer, "Now");
	});
});
