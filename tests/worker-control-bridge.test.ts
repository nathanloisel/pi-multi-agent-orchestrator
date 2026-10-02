/**
 * tests/worker-control-bridge.test.ts — the pi.events worker-control bridge
 * (fixed v1 protocol: orchestrator:worker-control:request:v1 → response:v1).
 *
 * Fake EventBus (plus one case on the REAL host createEventBus) driving the
 * REAL Orchestrator harness — no live provider, no network, no pi subprocess:
 * the fake worker runner blocks inside ask_main so the job stays "running"
 * with a live child, and steer ACKs are deterministic deferred promises.
 *
 * Covers: malformed/oversized/root-mismatch validation, status for
 * running/offline/finished/missing jobs, the attempt guard, pending ACK (zero
 * responses and zero feed prompts until acceptance), rejection without a feed
 * prompt, repeated-request dedup with no double steer, the concurrent cap and
 * bounded dedup caches, dispose/start lifecycle, pre-runtime unavailability,
 * and runtime replacement (late old-runtime replies never claim delivery).
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { Orchestrator } from "../core/orchestrator.ts";
import {
	createWorkerControlBridge,
	WORKER_CONTROL_REQUEST_CHANNEL,
	WORKER_CONTROL_RESPONSE_CHANNEL,
	type WorkerControlBridge,
	type WorkerControlEventBus,
	type WorkerControlRequest,
	type WorkerControlResponse,
} from "../worker-control-bridge.ts";
import { makeHarness, outcome, writingWorker, type Harness } from "./helpers.ts";

// ── Test doubles & helpers ───────────────────────────────────────────────────

class FakeEventBus implements WorkerControlEventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		let set = this.handlers.get(channel);
		if (!set) {
			set = new Set();
			this.handlers.set(channel, set);
		}
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}

	listenerCount(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}
}

/** Drain microtasks (+ one macrotask turn) so synchronous-status responses settle. */
async function flush(rounds = 25): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let requestSeq = 0;
function statusRequest(jobsRoot: string, jobId: string, over: Partial<WorkerControlRequest> = {}): WorkerControlRequest {
	return { version: 1, requestId: `req-${++requestSeq}`, operation: "status", jobsRoot, jobId, ...over };
}

function steerRequest(jobsRoot: string, jobId: string, text: string, over: Partial<WorkerControlRequest> = {}): WorkerControlRequest {
	return { version: 1, requestId: `req-${++requestSeq}`, operation: "steer", jobsRoot, jobId, text, ...over };
}

function collectResponses(bus: WorkerControlEventBus): WorkerControlResponse[] {
	const out: WorkerControlResponse[] = [];
	bus.on(WORKER_CONTROL_RESPONSE_CHANNEL, (data) => out.push(data as WorkerControlResponse));
	return out;
}

interface LiveJob {
	h: Harness;
	jobsRoot: string;
	jobId: string;
	steered: string[];
	ack: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };
	finish: () => Promise<void>;
}

/**
 * Real harness job that is RUNNING with a live (fake) worker: the child blocks
 * inside ask_main, and every steer lands in `steered` before its ACK — gated on
 * `ack` when manualAck is set, immediate otherwise.
 */
function runningHarness(opts: { manualAck?: boolean } = {}): Promise<LiveJob> {
	const h = makeHarness();
	const steered: string[] = [];
	const ack = deferred<void>();
	const child = new AbortController();
	h.setWorker(async (req) => {
		req.onControl?.({
			steer: async (text) => {
				steered.push(text);
				if (opts.manualAck) await ack.promise;
			},
		});
		await req.onRequest!({ kind: "ask_main", question: "blocked?" }, { id: "rpc-live", signal: child.signal });
		const o = writingWorker(() => outcome({ status: "success", summary: "done" }))(req);
		req.onControl?.(undefined); // like runWorker: the control handle dies with the child
		return o;
	});
	const job = h.orch.createJob({ agent: "worker", task: "live steering target" }, h.agents);
	const run = h.orch.runJob(job, h.agents);
	return (async () => {
		// Deterministic: never hand out the job before the attempt is RUNNING
		// with a live child (status "running", latestAttemptId persisted, control registered).
		await waitFor(() => h.orch.hasLiveWorker(job.jobId));
		return {
			h,
			jobsRoot: h.orch.store.jobsDir(),
			jobId: job.jobId,
			steered,
			ack,
			async finish() {
				child.abort();
				await run;
				h.cleanup();
			},
		};
	})();
}

/** The ACK-gated prompt must only appear in the feed AFTER acceptance. */
function promptEntries(h: Harness, jobId: string): { text: string }[] {
	return h.orch.workerFeed.read(jobId).entries.filter((e) => e.role === "user");
}

const bridges: WorkerControlBridge[] = [];
function makeBridge(bus: WorkerControlEventBus, getRuntime: () => Orchestrator | null): WorkerControlBridge {
	const bridge = createWorkerControlBridge({ events: bus, getRuntime });
	bridge.start();
	bridges.push(bridge);
	return bridge;
}

const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
	for (const fn of cleanups) {
		try {
			await fn();
		} catch {
			/* best effort */
		}
	}
	for (const bridge of bridges) {
		try {
			bridge.dispose();
		} catch {
			/* best effort */
		}
	}
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("worker-control bridge: validation and canonical scoping", () => {
	it("drops malformed/unknown event data without throwing; correlatable requests still answer", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		const bridge = makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();

		// Not correlatable → dropped silently, no throw, no response:
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, null);
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, "string-data");
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, [1, 2, 3]);
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { version: 2, requestId: "v2req", operation: "status", jobsRoot: root, jobId: "some-job" });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { version: "1", requestId: "strver", operation: "status", jobsRoot: root, jobId: "some-job" });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { ...statusRequest(root, "some-job"), operation: "destroy" as WorkerControlRequest["operation"] });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { version: 1, requestId: "bad id!", operation: "status", jobsRoot: root, jobId: "some-job" });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { version: 1, requestId: "x".repeat(200), operation: "status", jobsRoot: root, jobId: "some-job" });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { version: 1, operation: "status", jobsRoot: root, jobId: "some-job" });
		await flush();
		assert.equal(out.length, 0, "malformed data must never produce a response");
		assert.equal(bridge.stats().inflight, 0, "no state was consumed by malformed data");

		// The bus and bridge stay healthy afterwards:
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, "missing-job"));
		await waitFor(() => out.length === 1);
		assert.equal(out[0]!.ok, false);
		assert.equal(out[0]!.canSend, false);
		assert.match(out[0]!.error!, /unknown job/);
		h.cleanup();
	});

	it("rejects unsafe/oversized jobId before any job read", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();

		for (const jobId of ["", "a".repeat(129), "../escape", "has/slash", "has space"]) {
			bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, jobId));
		}
		await waitFor(() => out.length === 5);
		for (const response of out) {
			assert.equal(response.ok, false);
			assert.equal(response.canSend, false);
			assert.match(response.error!, /jobId must be a safe id/);
		}
		h.cleanup();
	});

	it("rejects foreign and relative jobsRoot before touching any job (canonical scoping)", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();
		const job = h.orch.createJob({ agent: "worker", task: "scoped" }, h.agents);

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest("/tmp/some-other-jobs-root", job.jobId));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest("relative/jobs", job.jobId));
		await waitFor(() => out.length === 2);
		assert.match(out[0]!.error!, /canonical jobs root/);
		assert.match(out[1]!.error!, /absolute path/);
		assert.equal(out[0]!.jobsRoot, "/tmp/some-other-jobs-root", "response echoes the rejected root for correlation");

		// The canonical root answers normally for the very same job (queued → no live worker):
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, job.jobId));
		await waitFor(() => out.length === 3);
		assert.equal(out[2]!.ok, true);
		assert.equal(out[2]!.canSend, false);
		assert.match(out[2]!.error!, /only running jobs have a live worker/);
		h.cleanup();
	});

	it("enforces steer text bounds: required, nonempty, ≤4096 UTF-8 bytes (multibyte counts)", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);
		const { jobsRoot, jobId } = live;

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { version: 1, requestId: "no-text", operation: "steer", jobsRoot, jobId });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, ""));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, "a".repeat(4097)));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, "é".repeat(2049))); // 4098 bytes
		await waitFor(() => out.length === 4);
		assert.match(out[0]!.error!, /text is required/);
		assert.match(out[1]!.error!, /nonempty/);
		assert.match(out[2]!.error!, /4096 UTF-8 bytes/);
		assert.match(out[3]!.error!, /4096 UTF-8 bytes/);
		for (const response of out) {
			assert.equal(response.ok, false);
			assert.equal(response.accepted, false);
		}
		assert.deepEqual(live.steered, [], "validation failures never dispatch");

		// Exactly 4096 UTF-8 bytes passes validation and dispatches (ACK still gated):
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, "b".repeat(4096)));
		await waitFor(() => live.steered.length === 1);
		assert.equal(out.length, 4, "no response until the worker ACKs");
		live.ack.resolve();
		await waitFor(() => out.length === 5);
		assert.equal(out[4]!.ok, true);
		assert.equal(out[4]!.accepted, true);
		await live.finish();
	});
});

// ── Status ───────────────────────────────────────────────────────────────────

describe("worker-control bridge: status", () => {
	it("running+live: ok=true canSend=true with the latest attemptId", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);
		const latest = live.h.orch.store.readJob(live.jobId)?.latestAttemptId;
		assert.equal(latest, "attempt-001");

		const request = statusRequest(live.jobsRoot, live.jobId);
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, request);
		await waitFor(() => out.length === 1);
		assert.deepEqual(out[0], {
			version: 1,
			requestId: request.requestId,
			operation: "status",
			jobsRoot: live.jobsRoot,
			jobId: live.jobId,
			ok: true,
			canSend: true,
			attemptId: "attempt-001",
		});
		await live.finish();
	});

	it("running without a live worker: ok=true canSend=false with a clear offline error", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const job = h.orch.createJob({ agent: "worker", task: "orphaned runner" }, h.agents);
		// Persisted "running" state with NO spawned child (e.g. lost worker):
		job.status = "running";
		h.orch.store.writeJob(job);

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(h.orch.store.jobsDir(), job.jobId));
		await waitFor(() => out.length === 1);
		assert.equal(out[0]!.ok, true);
		assert.equal(out[0]!.canSend, false);
		assert.match(out[0]!.error!, /offline/);
		h.cleanup();
	});

	it("finished job: ok=true canSend=false; missing job: ok=false with error", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome({ status: "success", summary: "done" })));
		makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();
		const finished = h.orch.createJob({ agent: "worker", task: "already done" }, h.agents);
		const report = await h.orch.runJob(finished, h.agents);
		assert.equal(report.status, "success");
		assert.equal(h.orch.store.readJob(finished.jobId)?.status, "success");

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, finished.jobId));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, "no-such-job"));
		await waitFor(() => out.length === 2);
		assert.equal(out[0]!.ok, true);
		assert.equal(out[0]!.canSend, false);
		assert.equal(out[0]!.attemptId, "attempt-001");
		assert.match(out[0]!.error!, /success; only running jobs/);
		assert.equal(out[1]!.ok, false);
		assert.equal(out[1]!.canSend, false);
		assert.match(out[1]!.error!, /unknown job: no-such-job/);
		h.cleanup();
	});
});

// ── Steer: guards, ACK gating, dedup ─────────────────────────────────────────

describe("worker-control bridge: steer guards", () => {
	it("stale or malformed attemptId is rejected before dispatch; a matching one dispatches", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);
		const { jobsRoot, jobId } = live;

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, "stale one", { attemptId: "attempt-999" }));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, "bad shape", { attemptId: "../not-an-attempt" }));
		await waitFor(() => out.length === 2);
		assert.match(out[0]!.error!, /stale attemptId attempt-999: latest attempt is attempt-001/);
		assert.match(out[1]!.error!, /attemptId must be a safe id/);
		assert.equal(out[1]!.accepted, false);
		assert.deepEqual(live.steered, [], "attempt guard rejects before any dispatch");

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(jobsRoot, jobId, "on target", { attemptId: "attempt-001" }));
		await waitFor(() => live.steered.length === 1);
		assert.equal(out.length, 2, "still zero responses while the ACK is pending");
		live.ack.resolve();
		await waitFor(() => out.length === 3);
		assert.equal(out[2]!.ok, true);
		assert.equal(out[2]!.accepted, true);
		assert.equal(out[2]!.attemptId, "attempt-001");
		await live.finish();
	});

	it("finished, unknown, and offline jobs are rejected with accepted=false and no feed prompt", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		h.setWorker(writingWorker(() => outcome({ status: "success", summary: "finished" })));
		const finished = h.orch.createJob({ agent: "worker", task: "finish me" }, h.agents);
		const report = await h.orch.runJob(finished, h.agents);
		assert.equal(report.status, "success");
		const offline = h.orch.createJob({ agent: "worker", task: "no child" }, h.agents);
		offline.status = "running";
		h.orch.store.writeJob(offline);
		makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(root, finished.jobId, "one more thing"));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(root, "missing-job", "hello?"));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(root, offline.jobId, "anyone home?"));
		await waitFor(() => out.length === 3);
		assert.match(out[0]!.error!, /job is success; only running jobs/);
		assert.match(out[1]!.error!, /unknown job: missing-job/);
		assert.match(out[2]!.error!, /offline/);
		for (const response of out) {
			assert.equal(response.ok, false);
			assert.equal(response.accepted, false);
		}
		// No prompt ever reaches a feed for a rejected steer:
		assert.deepEqual(promptEntries(h, finished.jobId), []);
		h.cleanup();
	});

	it("pending ACK: zero responses and zero feed prompts until acceptance, then accepted=true", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		const bridge = makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(live.jobsRoot, live.jobId, "keep going on parser.ts"));
		await flush();
		assert.equal(out.length, 0, "no response is emitted while the worker ACK is pending");
		assert.deepEqual(promptEntries(live.h, live.jobId), [], "no feed prompt before acceptance");
		assert.equal(bridge.stats().inflight, 1);
		assert.equal(bridge.stats().pending, 1);
		assert.deepEqual(live.steered, ["keep going on parser.ts"], "the steer reached the worker; only the ACK is pending");

		live.ack.resolve();
		await waitFor(() => out.length === 1);
		assert.equal(out[0]!.ok, true);
		assert.equal(out[0]!.accepted, true);
		assert.equal(out[0]!.attemptId, "attempt-001");
		const prompts = promptEntries(live.h, live.jobId);
		assert.equal(prompts.length, 1, "prompt recorded only after the ACK");
		assert.equal(prompts[0]!.text, "keep going on parser.ts");
		await live.finish();
	});

	it("repeated requestId reuses the in-flight request and completion cache: exactly one steer", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		const bridge = makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);
		const request = steerRequest(live.jobsRoot, live.jobId, "steady as she goes");

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, request);
		await flush();
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, request); // duplicate while in flight
		await flush();
		assert.deepEqual(live.steered, ["steady as she goes"], "dedup reuse must never dispatch twice");
		assert.equal(out.length, 0, "the duplicate waits on the same pending ACK");
		assert.equal(bridge.stats().inflight, 1, "dedup reuse does not consume a concurrency slot");
		assert.equal(bridge.stats().pending, 1);

		live.ack.resolve();
		await waitFor(() => out.length === 2);
		assert.deepEqual(out[0], out[1], "both waiters receive the identical response");
		assert.equal(out[0]!.accepted, true);

		// Completion-cache replay after settle: still no second steer.
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, request);
		await flush();
		assert.equal(out.length, 3);
		assert.deepEqual(out[2], out[0]);
		assert.deepEqual(live.steered, ["steady as she goes"]);
		assert.equal(bridge.stats().completed, 1);
		await live.finish();
	});

	it("same requestId with a different payload is rejected without disturbing the original", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);
		const request = steerRequest(live.jobsRoot, live.jobId, "first payload");

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, request);
		await flush();
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { ...request, text: "different payload" });
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, { ...request, operation: "status" });
		await waitFor(() => out.length >= 2);
		assert.match(out[0]!.error!, /different request payload/);
		assert.match(out[1]!.error!, /different request payload/);
		assert.deepEqual(live.steered, ["first payload"], "the original in-flight steer is untouched");

		// The original request still completes normally:
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, request);
		live.ack.resolve();
		await waitFor(() => out.length === 4);
		assert.equal(out[2]!.accepted, true);
		assert.equal(out[3]!.accepted, true);
		assert.equal(out[2]!.requestId, request.requestId);
		assert.deepEqual(live.steered, ["first payload"], "exactly one dispatch in total");
		await live.finish();
	});
});

// ── Bounds: concurrency cap + caches ─────────────────────────────────────────

describe("worker-control bridge: concurrency cap and bounded caches", () => {
	it("caps concurrent requests at 32 while a steer is pending", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		const bridge = makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(live.jobsRoot, live.jobId, "hold the line")); // inflight 1
		for (let i = 0; i < 40; i++) {
			bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(live.jobsRoot, live.jobId)); // sync burst
		}
		await flush();
		const capped = out.filter((r) => /too many concurrent/.test(r.error ?? ""));
		assert.equal(capped.length, 9, "only 31 of 40 burst status requests fit alongside the pending steer");
		assert.equal(capped[0]!.ok, false);
		assert.equal(capped[0]!.canSend, false);
		const answered = out.filter((r) => r.ok === true);
		assert.equal(answered.length, 31);
		assert.equal(bridge.stats().inflight, 1, "only the pending steer remains in flight");

		live.ack.resolve();
		await waitFor(() => out.length === 41);
		assert.equal(out.filter((r) => r.accepted === true).length, 1, "the capped burst never affected the steer");
		assert.equal(bridge.stats().inflight, 0);
		assert.equal(bridge.stats().pending, 0);
		assert.equal(bridge.stats().completed, 32, "31 statuses + 1 steer");
		await live.finish();
	});

	it("keeps the completion cache bounded at 128 and evicts oldest first", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		const bridge = makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();
		const job = h.orch.createJob({ agent: "worker", task: "cache target" }, h.agents);

		const first = statusRequest(root, job.jobId);
		const requests: WorkerControlRequest[] = [];
		for (let i = 0; i < 150; i++) {
			const req = i === 0 ? first : statusRequest(root, job.jobId);
			requests.push(req);
			bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, req);
			await flush(5);
		}
		assert.equal(out.length, 150, "every unique request answered exactly once");
		assert.equal(bridge.stats().completed, 128, "completion cache is bounded");
		assert.equal(bridge.stats().pending, 0);

		// The evicted first requestId re-processes (and re-caches) instead of replaying:
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, first);
		await flush();
		assert.equal(out.length, 151, "evicted requestId is no longer served from the cache");
		assert.equal(bridge.stats().completed, 128);
		assert.ok(requests.length === 150);
		h.cleanup();
	});

	it("reset() clears the dedup lifecycle and bumps the generation", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		const bridge = makeBridge(bus, () => h.orch);
		const out = collectResponses(bus);
		const root = h.orch.store.jobsDir();

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, "job-a"));
		await waitFor(() => out.length === 1);
		assert.equal(bridge.stats().completed, 1);
		const gen = bridge.stats().generation;
		bridge.reset();
		assert.equal(bridge.stats().generation, gen + 1);
		assert.equal(bridge.stats().completed, 0);
		assert.equal(bridge.stats().pending, 0);
		h.cleanup();
	});
});

// ── Lifecycle: unavailable, dispose, runtime replacement ─────────────────────

describe("worker-control bridge: lifecycle", () => {
	it("replies unavailable before the runtime exists (status and steer)", async () => {
		const bus = new FakeEventBus();
		let current: Orchestrator | null = null;
		makeBridge(bus, () => current);
		const out = collectResponses(bus);
		const root = "/tmp/pre-runtime-jobs";

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, "some-job"));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(root, "some-job", "hello"));
		await waitFor(() => out.length === 2);
		assert.match(out[0]!.error!, /not ready/);
		assert.equal(out[0]!.ok, false);
		assert.equal(out[0]!.canSend, false);
		assert.match(out[1]!.error!, /not ready/);
		assert.equal(out[1]!.ok, false);
		assert.equal(out[1]!.accepted, false);
	});

	it("start/dispose are idempotent: subscribe once, unsubscribe fully, re-subscribe after shutdown", async () => {
		const bus = new FakeEventBus();
		const h = makeHarness();
		const bridge = makeBridge(bus, () => h.orch);
		bridge.start(); // second start must not double-subscribe
		assert.equal(bus.listenerCount(WORKER_CONTROL_REQUEST_CHANNEL), 1);

		const out = collectResponses(bus);
		bridge.dispose();
		bridge.dispose(); // idempotent
		assert.equal(bus.listenerCount(WORKER_CONTROL_REQUEST_CHANNEL), 0);
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(h.orch.store.jobsDir(), "some-job"));
		await flush();
		assert.equal(out.length, 0, "disposed bridge answers nothing");

		bridge.start(); // session restart re-subscribes
		assert.equal(bus.listenerCount(WORKER_CONTROL_REQUEST_CHANNEL), 1);
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(h.orch.store.jobsDir(), "some-job"));
		await waitFor(() => out.length === 1);
		assert.match(out[0]!.error!, /unknown job/);
		h.cleanup();
	});

	it("dispose during a pending ACK: no delivery claim, no feed prompt, no cache residue", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true });
		const bridge = makeBridge(bus, () => live.h.orch);
		const out = collectResponses(bus);

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(live.jobsRoot, live.jobId, "in flight"));
		await flush();
		assert.equal(out.length, 0);
		assert.equal(bridge.stats().pending, 1);

		bridge.dispose();
		assert.equal(bus.listenerCount(WORKER_CONTROL_REQUEST_CHANNEL), 0);
		// New requests after shutdown get no handler at all:
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(live.jobsRoot, live.jobId));
		await flush();
		assert.equal(out.length, 0);

		live.ack.resolve(); // the old runtime's ACK lands late
		await waitFor(() => out.length === 1);
		assert.equal(out[0]!.ok, false);
		assert.equal(out[0]!.accepted, false, "a late ACK after shutdown must never claim delivery");
		assert.match(out[0]!.error!, /replaced before the worker ACK/);
		assert.deepEqual(promptEntries(live.h, live.jobId), [], "no feed prompt for an unconfirmed delivery");
		await live.finish();
		assert.equal(bridge.stats().inflight, 0);
		assert.equal(bridge.stats().completed, 0, "dedup lifecycle stays clear after dispose");
	});

	it("runtime replacement: the accessor follows the NEW runtime and late replies never claim delivery", async () => {
		const bus = new FakeEventBus();
		const live = await runningHarness({ manualAck: true }); // runtime A
		const hB = makeHarness(); // runtime B (different canonical jobs root)
		let current: Orchestrator | null = live.h.orch;
		const bridge = makeBridge(bus, () => current);
		const out = collectResponses(bus);
		const rootA = live.jobsRoot;
		const rootB = hB.orch.store.jobsDir();
		assert.notEqual(rootA, rootB);

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, steerRequest(rootA, live.jobId, "for runtime A"));
		await flush();
		assert.equal(out.length, 0);

		// Runtime replacement (as buildRuntime does on session start):
		current = hB.orch;
		bridge.reset();
		live.ack.resolve(); // old runtime's ACK lands after the swap
		await waitFor(() => out.length === 1);
		assert.equal(out[0]!.ok, false);
		assert.equal(out[0]!.accepted, false, "late old-runtime reply must not claim successful new delivery");
		assert.match(out[0]!.error!, /replaced before the worker ACK/);
		assert.deepEqual(promptEntries(live.h, live.jobId), [], "old feed never receives the prompt");

		// New requests are scoped to the CURRENT runtime's canonical root:
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(rootA, live.jobId));
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(rootB, live.jobId));
		await waitFor(() => out.length === 3);
		assert.match(out[1]!.error!, /canonical jobs root/, "the old root is rejected by the new runtime");
		assert.match(out[2]!.error!, /unknown job/, "the new runtime answers with its own state");
		assert.equal(bridge.stats().completed, 2, "post-replacement completions are tracked under the new generation");

		await live.finish();
		hB.cleanup();
	});
});

// ── Real host EventBus seam ──────────────────────────────────────────────────

describe("worker-control bridge: real host EventBus", () => {
	it("carries the exact v1 contract through pi's createEventBus and stops on dispose", async () => {
		const bus = createEventBus();
		const h = makeHarness();
		const out = collectResponses(bus);
		const bridge = makeBridge(bus, () => h.orch);
		const root = h.orch.store.jobsDir();

		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, "real-bus-job"));
		await waitFor(() => out.length === 1);
		assert.deepEqual(
			Object.keys(out[0]!).sort(),
			["canSend", "error", "jobId", "jobsRoot", "ok", "operation", "requestId", "version"],
			"unknown-job error response carries exactly the contract fields (minus optionals)",
		);
		assert.equal(out[0]!.version, 1);
		assert.equal(out[0]!.operation, "status");
		assert.equal(out[0]!.jobsRoot, root);
		assert.equal(out[0]!.jobId, "real-bus-job");
		assert.equal(out[0]!.ok, false);
		assert.equal(out[0]!.canSend, false);
		assert.match(out[0]!.error!, /unknown job: real-bus-job/);

		bridge.dispose();
		bus.emit(WORKER_CONTROL_REQUEST_CHANNEL, statusRequest(root, "real-bus-job"));
		await flush();
		assert.equal(out.length, 1, "dispose unsubscribes from the real bus");
		h.cleanup();
	});
});