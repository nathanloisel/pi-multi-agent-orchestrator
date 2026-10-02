/**
 * core/worker-feed.ts tests — bounded event-driven transcript feed.
 *
 * Covers: message start/delta/end de-duplication, multiple text blocks with
 * tool interleaving, message_end-only fallback, attempt isolation/retry,
 * observer exception isolation, UTF-8 retention caps and adversarial oversized
 * events, LRU buffer cap with truthful truncation, cached unchanged snapshot
 * reads, 10k-delta high-volume retention, disposal/unsubscribe, and the
 * orchestrator wiring (public workerFeed + trusted job/attempt ids through the
 * workerRunner seam).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_FEED_ENTRIES, MAX_FEED_TEXT_BYTES, MAX_PROMPT_BYTES, WorkerFeed, type WorkerFeedEvent } from "../core/worker-feed.ts";
import { makeHarness, outcome, writingWorker } from "./helpers.ts";

const JOB = "job-1";
const ATT = "attempt-001";

// ── Event builders (raw RPC shapes from docs/json.md) ────────────────────────

const msgStart = (content: unknown[] = []): WorkerFeedEvent => ({ type: "message_start", message: { role: "assistant", content } });
const textStart = (contentIndex: number): WorkerFeedEvent => ({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex } });
const textDelta = (contentIndex: number, delta: string): WorkerFeedEvent => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta } });
const textEnd = (contentIndex: number, content: string): WorkerFeedEvent => ({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex, content } });
const msgEnd = (content: unknown[]): WorkerFeedEvent => ({ type: "message_end", message: { role: "assistant", content } });
const toolStart = (toolCallId: string, toolName: string): WorkerFeedEvent => ({
	type: "tool_execution_start",
	toolCallId,
	toolName,
	args: { command: "HUGE_ARGS_MARKER " + "x".repeat(5000) },
});
const toolEnd = (toolCallId: string, toolName: string, isError = false): WorkerFeedEvent => ({
	type: "tool_execution_end",
	toolCallId,
	toolName,
	result: { content: [{ type: "text", text: "HUGE_RESULT_MARKER " + "y".repeat(5000) }] },
	isError,
});

function feedWith(jobId: string, attemptId: string): WorkerFeed {
	const feed = new WorkerFeed();
	feed.beginAttempt(jobId, attemptId);
	return feed;
}

// ── De-duplication ───────────────────────────────────────────────────────────

describe("WorkerFeed message de-duplication", () => {
	it("keeps streamed assistant text without duplicating message_end full text", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgStart());
		feed.ingest(JOB, ATT, textStart(0));
		feed.ingest(JOB, ATT, textDelta(0, "Hel"));
		feed.ingest(JOB, ATT, textDelta(0, "lo"));
		const mid = feed.read(JOB);
		assert.equal(mid.entries.length, 1);
		assert.equal(mid.entries[0].text, "Hello");
		assert.equal(mid.entries[0].streaming, true);

		feed.ingest(JOB, ATT, textEnd(0, "Hello"));
		feed.ingest(JOB, ATT, msgEnd([{ type: "text", text: "Hello" }]));
		const snap = feed.read(JOB);
		assert.equal(snap.entries.length, 1, "message_end must not append a duplicate of the streamed text");
		assert.equal(snap.entries[0].text, "Hello");
		assert.equal(snap.entries[0].role, "assistant");
		assert.ok(!snap.entries[0].streaming, "finalized entries are not streaming");
		assert.equal(snap.truncated, false);
	});

	it("replaces streamed partials with the authoritative message_end text", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgStart());
		feed.ingest(JOB, ATT, textDelta(0, "Hel"));
		feed.ingest(JOB, ATT, msgEnd([{ type: "text", text: "Hello world" }]));
		const snap = feed.read(JOB);
		assert.equal(snap.entries.length, 1);
		assert.equal(snap.entries[0].text, "Hello world");
	});

	it("falls back to message_end text when no deltas were streamed", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgEnd([{ type: "thinking", thinking: "SECRET_THOUGHT" }, { type: "text", text: "final answer" }]));
		const snap = feed.read(JOB);
		assert.equal(snap.entries.length, 1);
		assert.equal(snap.entries[0].text, "final answer");
		assert.equal(snap.entries[0].role, "assistant");
		assert.ok(!snap.entries[0].streaming);
		assert.ok(!snap.entries[0].text.includes("SECRET_THOUGHT"), "hidden reasoning is omitted");
	});

	it("keeps separate end-only messages as separate entries", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgEnd([{ type: "text", text: "first reply" }]));
		feed.ingest(JOB, ATT, msgEnd([{ type: "text", text: "second reply" }]));
		assert.deepEqual(feed.read(JOB).entries.map((e) => e.text), ["first reply", "second reply"]);
	});
});

// ── Multi-block + tool interleave ────────────────────────────────────────────

describe("WorkerFeed multi-block and tool interleaving", () => {
	it("preserves chronological order across text blocks and tool lifecycles", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgStart());
		feed.ingest(JOB, ATT, textStart(0));
		feed.ingest(JOB, ATT, textDelta(0, "A"));
		feed.ingest(JOB, ATT, textEnd(0, "A"));
		feed.ingest(JOB, ATT, toolStart("c1", "bash"));
		feed.ingest(JOB, ATT, { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: "HUGE_PARTIAL_MARKER" } });
		feed.ingest(JOB, ATT, toolEnd("c1", "bash"));
		feed.ingest(JOB, ATT, textStart(2));
		feed.ingest(JOB, ATT, textDelta(2, "B"));
		feed.ingest(JOB, ATT, textEnd(2, "B"));
		feed.ingest(JOB, ATT, msgEnd([{ type: "text", text: "A" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }, { type: "text", text: "B" }]));

		const snap = feed.read(JOB);
		assert.deepEqual(snap.entries.map((e) => e.role), ["assistant", "tool", "assistant"]);
		assert.deepEqual(snap.entries.map((e) => e.text), ["A", "bash · done", "B"]);
		const joined = snap.entries.map((e) => e.text).join("\n");
		assert.ok(!joined.includes("HUGE_"), "tool args/results are never serialized into the feed");
	});

	it("renders bounded tool name/status summaries and marks failed tools", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, toolStart("c1", "T".repeat(500)));
		feed.ingest(JOB, ATT, toolEnd("c1", "T".repeat(500), true));
		const snap = feed.read(JOB);
		assert.equal(snap.entries.length, 1, "duplicate lifecycle events reuse one entry");
		assert.ok(snap.entries[0].text.endsWith("failed"));
		assert.ok(Buffer.byteLength(snap.entries[0].text, "utf8") <= 120, "tool name is bounded");
		assert.ok(!snap.entries[0].streaming);
	});

	it("omits hidden thinking updates entirely", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgStart());
		feed.ingest(JOB, ATT, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
		feed.ingest(JOB, ATT, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "SECRET_THOUGHT" } });
		feed.ingest(JOB, ATT, { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "SECRET_THOUGHT" } });
		assert.equal(feed.read(JOB).entries.length, 0);
	});
});

// ── Attempt isolation / retry ────────────────────────────────────────────────

describe("WorkerFeed attempt isolation", () => {
	it("resets the latest-attempt view on retry and ignores stale attempt events", () => {
		const feed = feedWith(JOB, "attempt-001");
		feed.ingest(JOB, "attempt-001", msgStart());
		feed.ingest(JOB, "attempt-001", textDelta(0, "first-run text"));
		assert.equal(feed.read(JOB).entries[0].text, "first-run text");

		feed.beginAttempt(JOB, "attempt-002"); // fresh retry opens a new view
		assert.equal(feed.read(JOB).attemptId, "attempt-002");
		assert.equal(feed.read(JOB).entries.length, 0, "the view shows only the latest attempt");

		feed.ingest(JOB, "attempt-001", textDelta(0, "STALE"));
		assert.equal(feed.read(JOB).entries.length, 0, "stale older-attempt events are ignored");

		feed.ingest(JOB, "attempt-002", textDelta(0, "second-run text"));
		assert.equal(feed.read(JOB).entries[0].text, "second-run text");
	});

	it("ignores events after finishAttempt and continues a resumed same attempt", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, textDelta(0, "second-run text"));
		feed.finishAttempt(JOB, ATT);

		feed.ingest(JOB, ATT, textDelta(0, "LATE"));
		assert.equal(feed.read(JOB).entries.length, 1, "late events after finish are dropped");
		assert.equal(feed.read(JOB).entries[0].text, "second-run text");

		feed.beginAttempt(JOB, ATT); // follow-up resume of the SAME attempt
		assert.equal(feed.read(JOB).entries.length, 1, "resume continues the same-attempt transcript");
		feed.ingest(JOB, ATT, textDelta(0, "followup text"));
		assert.deepEqual(feed.read(JOB).entries.map((e) => e.text), ["second-run text", "followup text"]);
	});
});

// ── Observers ────────────────────────────────────────────────────────────────

describe("WorkerFeed observers", () => {
	it("isolates listener exceptions and keeps notifications flowing", () => {
		const feed = new WorkerFeed();
		const seen: string[] = [];
		feed.subscribe(() => {
			throw new Error("boom");
		});
		const off = feed.subscribe((jobId) => seen.push(jobId));
		feed.beginAttempt(JOB, ATT);
		feed.appendPrompt(JOB, "hello prompt");
		assert.deepEqual(seen, [JOB, JOB]);
		feed.ingest(JOB, ATT, textDelta(0, "text"));
		assert.equal(seen.length, 3);
		assert.equal(feed.read(JOB).entries.length, 2, "a throwing listener never breaks ingestion or reads");
		off();
		feed.appendPrompt(JOB, "again");
		assert.equal(seen.length, 3, "unsubscribed listeners stop receiving");
	});

	it("stops notifications after unsubscribe and no-ops after dispose", () => {
		const feed = new WorkerFeed();
		let calls = 0;
		const off = feed.subscribe(() => {
			calls++;
		});
		feed.beginAttempt(JOB, ATT);
		const before = calls;
		off();
		feed.appendPrompt(JOB, "hi");
		assert.equal(calls, before);

		feed.dispose();
		assert.deepEqual(feed.read(JOB), { jobId: JOB, revision: 0, entries: [], truncated: false });
		feed.beginAttempt(JOB, "attempt-002");
		feed.ingest(JOB, "attempt-002", textDelta(0, "x"));
		feed.appendPrompt(JOB, "x");
		assert.equal(feed.read(JOB).entries.length, 0, "disposed feeds accept nothing");
		assert.equal(calls, before, "disposed feeds notify nobody");
	});
});

// ── Retention bounds ─────────────────────────────────────────────────────────

describe("WorkerFeed retention bounds", () => {
	it("caps UTF-8 text deterministically for multibyte deltas", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgStart());
		feed.ingest(JOB, ATT, textDelta(0, "😀".repeat(20000))); // 80 KiB → capped
		const snap = feed.read(JOB);
		assert.equal(snap.truncated, true);
		assert.equal(Buffer.byteLength(snap.entries[0].text, "utf8"), MAX_FEED_TEXT_BYTES);
		assert.equal(snap.entries[0].text, "😀".repeat(MAX_FEED_TEXT_BYTES / 4), "deterministic cut, no split characters");
		assert.ok(!snap.entries[0].text.includes("\uFFFD"));

		const feed2 = feedWith(JOB, ATT);
		feed2.ingest(JOB, ATT, textDelta(0, "é".repeat(100000))); // 200 KiB → capped
		const snap2 = feed2.read(JOB);
		assert.equal(Buffer.byteLength(snap2.entries[0].text, "utf8"), MAX_FEED_TEXT_BYTES);
		assert.equal(snap2.entries[0].text, "é".repeat(MAX_FEED_TEXT_BYTES / 2));
	});

	it("survives adversarial oversized and malformed events without unbounded growth", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, textDelta(0, "x".repeat(1024 * 1024))); // 1 MiB single delta
		const snap = feed.read(JOB);
		assert.equal(Buffer.byteLength(snap.entries[0].text, "utf8"), MAX_FEED_TEXT_BYTES);
		assert.equal(snap.truncated, true);

		const feed2 = feedWith(JOB, ATT);
		feed2.ingest(JOB, ATT, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: 12345 } } as WorkerFeedEvent);
		feed2.ingest(JOB, ATT, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1e9, delta: "x" } });
		feed2.ingest(JOB, ATT, { type: "message_end", message: "not-an-object" } as WorkerFeedEvent);
		feed2.ingest(JOB, ATT, { type: "tool_execution_start", toolCallId: 42, toolName: "bash" } as WorkerFeedEvent);
		feed2.ingest(JOB, ATT, { type: 42 } as unknown as WorkerFeedEvent);
		feed2.ingest(JOB, ATT, null as unknown as WorkerFeedEvent);
		feed2.ingest(JOB, ATT, textDelta(0, "ok"));
		feed2.ingest(JOB, ATT, toolStart("c1", "bash"));
		feed2.ingest(JOB, ATT, toolEnd("c1", "bash"));
		const snap2 = feed2.read(JOB);
		assert.deepEqual(snap2.entries.map((e) => e.text), ["ok", "bash · done"], "only validated fields become entries");
	});

	it("ignores events for unknown jobs and other attempts", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest("job-unknown", ATT, textDelta(0, "x"));
		feed.ingest(JOB, "attempt-999", textDelta(0, "x"));
		assert.equal(feed.read(JOB).entries.length, 0);
		assert.equal(feed.read("job-unknown").entries.length, 0);
		assert.equal(feed.read("job-unknown").truncated, false);
	});

	it("caps entries per job and marks truncation", () => {
		const feed = new WorkerFeed();
		for (let i = 0; i < 250; i++) feed.appendPrompt(JOB, `p${i}`);
		const snap = feed.read(JOB);
		assert.equal(snap.entries.length, MAX_FEED_ENTRIES);
		assert.equal(snap.truncated, true);
		assert.equal(snap.entries[0].text, "p50", "oldest entries are dropped first");
		assert.equal(snap.entries[snap.entries.length - 1].text, "p249");
	});

	it("bounds appendPrompt entries to 4096 UTF-8 bytes", () => {
		const feed = new WorkerFeed();
		feed.appendPrompt(JOB, "p".repeat(10000));
		const first = feed.read(JOB).entries[0];
		assert.equal(first.role, "user");
		assert.equal(Buffer.byteLength(first.text, "utf8"), MAX_PROMPT_BYTES);
		assert.ok(first.text.endsWith("…"));

		feed.appendPrompt(JOB, "😀".repeat(2000));
		const second = feed.read(JOB).entries[1];
		assert.ok(Buffer.byteLength(second.text, "utf8") <= MAX_PROMPT_BYTES);
		assert.ok(Buffer.byteLength(second.text, "utf8") >= MAX_PROMPT_BYTES - 3);
		assert.ok(second.text.endsWith("…"));
		assert.ok(!second.text.includes("\uFFFD"), "prompt truncation never splits characters");
	});

	it("retains bounded state across 10k streaming deltas", () => {
		const feed = feedWith(JOB, ATT);
		feed.ingest(JOB, ATT, msgStart());
		for (let i = 0; i < 10000; i++) feed.ingest(JOB, ATT, textDelta(0, "xxxxxxxxxx"));
		const snap = feed.read(JOB);
		assert.equal(snap.entries.length, 1);
		assert.equal(Buffer.byteLength(snap.entries[0].text, "utf8"), MAX_FEED_TEXT_BYTES);
		assert.equal(snap.entries[0].text, "x".repeat(MAX_FEED_TEXT_BYTES));
		assert.equal(snap.truncated, true);
	});
});

// ── LRU + snapshot caching ───────────────────────────────────────────────────

describe("WorkerFeed LRU and snapshot caching", () => {
	it("caps job buffers at 48 via LRU with a truthful truncated tombstone", () => {
		const feed = new WorkerFeed();
		for (let i = 0; i < 50; i++) {
			const jobId = `job-${i}`;
			feed.beginAttempt(jobId, ATT);
			feed.appendPrompt(jobId, `prompt-${i}`);
		}
		const evicted0 = feed.read("job-0");
		assert.equal(evicted0.truncated, true, "eviction is reported truthfully");
		assert.equal(evicted0.entries.length, 0);
		assert.strictEqual(feed.read("job-0"), evicted0, "tombstones are stable reads");

		const evicted1 = feed.read("job-1");
		assert.equal(evicted1.truncated, true);
		assert.equal(evicted1.entries.length, 0);

		for (const id of ["job-2", "job-48", "job-49"]) {
			const kept = feed.read(id);
			assert.equal(kept.truncated, false);
			assert.equal(kept.entries.length, 1);
			assert.equal(kept.entries[0].text, `prompt-${Number(id.slice(4))}`);
		}
	});

	it("returns the cached snapshot object while the revision is unchanged", () => {
		const feed = feedWith(JOB, ATT);
		feed.appendPrompt(JOB, "hello");
		const s1 = feed.read(JOB);
		assert.strictEqual(feed.read(JOB), s1, "unchanged revision returns the same materialized snapshot");

		feed.ingest(JOB, ATT, { type: "tool_execution_update", toolCallId: "x", toolName: "bash", partialResult: { content: "ignored" } });
		assert.strictEqual(feed.read(JOB), s1, "no-op events do not invalidate the cache");

		feed.ingest(JOB, ATT, textDelta(0, "stream"));
		const s2 = feed.read(JOB);
		assert.notStrictEqual(s2, s1);
		assert.ok(s2.revision > s1.revision);
		assert.equal(s2.entries.length, 2);
	});
});

// ── Orchestrator wiring ──────────────────────────────────────────────────────

describe("orchestrator workerFeed wiring", () => {
	it("feeds raw events with trusted ids through the workerRunner seam", async () => {
		const h = makeHarness();
		try {
			const writer = writingWorker(() => outcome({ status: "success", summary: "done" }));
			h.setWorker((req) => {
				assert.equal(typeof req.onEvent, "function", "spawn request carries the onEvent observer");
				req.onEvent?.({ type: "message_start", message: { role: "assistant", content: [] } });
				req.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello " } });
				req.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } });
				req.onEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } });
				return writer(req);
			});
			const report = await h.orch.runJob({ agent: "worker", task: "build it" }, h.agents);
			assert.equal(report.status, "success");

			const snap = h.orch.workerFeed.read(report.jobId);
			assert.equal(snap.attemptId, "attempt-001");
			assert.deepEqual(snap.entries.map((e) => e.text), ["hello world"]);
			assert.equal(snap.entries[0].role, "assistant");

			// finishAttempt closed the run: stale events are ignored afterwards
			const before = snap.revision;
			h.workerCalls[0].onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "STALE" } });
			assert.equal(h.orch.workerFeed.read(report.jobId).revision, before);
		} finally {
			h.cleanup();
		}
	});

	it("isolates retries: a fresh attempt resets the feed view", async () => {
		const h = makeHarness();
		try {
			const ok = writingWorker(() => outcome({ status: "success", summary: "ok" }));
			const bad = writingWorker(() => outcome({ status: "failure", summary: "boom" }));
			h.setWorker((req, callIndex) => {
				req.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: callIndex === 0 ? "first-run text" : "second-run text" } });
				return callIndex === 0 ? bad(req) : ok(req);
			});
			const report = await h.orch.runJob({ agent: "worker", task: "build it" }, h.agents);
			assert.equal(report.status, "success");
			assert.equal(report.attempts.length, 2, "ladder ran a fresh second attempt");

			const snap = h.orch.workerFeed.read(report.jobId);
			assert.equal(snap.attemptId, "attempt-002");
			assert.deepEqual(snap.entries.map((e) => e.text), ["second-run text"], "latest-attempt view only");
		} finally {
			h.cleanup();
		}
	});

	it("keeps the transcript across a follow-up resume of the same attempt", async () => {
		const h = makeHarness();
		try {
			const writer = writingWorker(() => outcome({ status: "success", summary: "done" }));
			h.setWorker((req, callIndex) => {
				const text = callIndex === 0 ? "hello world" : "followup text";
				req.onEvent?.({ type: "message_start", message: { role: "assistant", content: [] } });
				req.onEvent?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
				req.onEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
				return writer(req);
			});
			const report = await h.orch.runJob({ agent: "worker", task: "build it" }, h.agents);
			const follow = await h.orch.followupJob(report.jobId, "do more", h.agents);
			assert.equal(follow.status, "success");

			const snap = h.orch.workerFeed.read(report.jobId);
			assert.equal(snap.attemptId, "attempt-001", "follow-up resumes the same attempt");
			assert.deepEqual(snap.entries.map((e) => e.text), ["hello world", "followup text"]);
		} finally {
			h.cleanup();
		}
	});
});
