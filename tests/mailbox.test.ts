/**
 * core/mailbox tests: persistent mailbox transport — concurrency, persistence,
 * per-attempt receipt/ack semantics, bounds (count/bytes/multibyte), missing
 * identities, path safety (traversal + symlink escapes), malformed records,
 * and read-only inspection.
 *
 * Standalone: uses only node builtins + JobStore fixtures (no orchestrator,
 * no pi SDK).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { JobStore } from "../core/storage.ts";
import { DEFAULT_RETRY } from "../core/types.ts";
import {
	acknowledgeMailboxMessages,
	listMailboxMessages,
	readPendingMailboxMessages,
	sendMailboxMessage,
	MAILBOX_DEFAULT_READ_LIMIT,
	MAILBOX_MAX_BATCH_BODY_BYTES,
	MAILBOX_MAX_BODY_BYTES,
	MAILBOX_MAX_READ_LIMIT,
	type MailboxMessage,
} from "../core/mailbox.ts";

// Temp roots with exit-time cleanup (guards against /tmp leaks).
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-test-"));
	liveRoots.add(root);
	return root;
}
function cleanup(root: string): void {
	liveRoots.delete(root);
	fs.rmSync(root, { recursive: true, force: true });
}

function createStore(): JobStore {
	return new JobStore(tmpRoot());
}

/** Create a job record + N attempts through the real storage layout. */
function makeJob(store: JobStore, jobId: string, attemptCount = 1): string[] {
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
		attemptCount,
	});
	const ids: string[] = [];
	for (let i = 0; i < attemptCount; i++) {
		const id = store.allocateAttempt(jobId);
		store.writeAttempt({
			schemaVersion: 1,
			attemptId: id,
			jobId,
			agent: "worker",
			retryMode: "initial",
			status: "running",
			startedAt: Date.now(),
		});
		ids.push(id);
	}
	return ids;
}

function send(root: string, fromAttemptId: string, toJobId: string, body: string, fromJobId = "sender-job"): Promise<MailboxMessage> {
	return sendMailboxMessage(root, { fromJobId, fromAttemptId, toJobId, body });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── Concurrency + persistence ───────────────────────────────────────────────

test("concurrent sends preserve all messages", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	makeJob(store, "receiver-job");

	const N = 25;
	const sends = Array.from({ length: N }, (_, i) => send(root, fromAttempt, "receiver-job", `concurrent message ${i}`));
	const peeks = Array.from({ length: 5 }, () => listMailboxMessages(root, "receiver-job"));
	await Promise.all([...sends, ...peeks]); // reads interleaved with writes must not lose sends

	const listed = await listMailboxMessages(root, "receiver-job", { limit: MAILBOX_MAX_READ_LIMIT });
	assert.equal(listed.length, N, "every concurrent send must be visible");
	assert.equal(new Set(listed.map((m) => m.id)).size, N, "message ids must be unique");
	for (let i = 0; i < N; i++) {
		assert.ok(listed.some((m) => m.body === `concurrent message ${i}`), `message ${i} must not be lost`);
	}
	cleanup(root);
});

test("messages persist across store instances (restart) with one atomic file per message", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	makeJob(store, "receiver-job");

	const m1 = await send(root, fromAttempt, "receiver-job", "first");
	const m2 = await send(root, fromAttempt, "receiver-job", "second");
	assert.match(m1.id, UUID_RE);
	assert.equal(m1.schemaVersion, 1);
	assert.equal(m1.toJobId, "receiver-job");
	assert.match(m1.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

	// on-disk layout: one file per message under the recipient mailbox
	const messagesDir = path.join(root, "jobs", "receiver-job", "mailbox", "messages");
	assert.ok(fs.existsSync(path.join(messagesDir, `${m1.id}.json`)));
	assert.ok(fs.existsSync(path.join(messagesDir, `${m2.id}.json`)));

	// simulate a brand-new process: fresh store instance over the same root
	const store2 = new JobStore(root);
	assert.equal(store2.listJobs().length, 2);
	const msgs = await listMailboxMessages(store2.root, "receiver-job");
	assert.equal(msgs.length, 2);
	assert.deepEqual(
		new Set(msgs.map((m) => m.body)),
		new Set(["first", "second"]),
	);
	cleanup(root);
});

// ── Receipts / acknowledgement ──────────────────────────────────────────────

test("per-attempt receipts and explicit ack semantics", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	const [r1, r2] = makeJob(store, "receiver-job", 2);

	const [m1, m2, m3] = await Promise.all([
		send(root, fromAttempt, "receiver-job", "alpha"),
		send(root, fromAttempt, "receiver-job", "beta"),
		send(root, fromAttempt, "receiver-job", "gamma"),
	]);

	assert.equal((await readPendingMailboxMessages(root, "receiver-job", r1)).length, 3);
	assert.equal((await listMailboxMessages(root, "receiver-job")).length, 3, "inspection must not consume");

	// explicit ack for a delivered batch
	const res = await acknowledgeMailboxMessages(root, "receiver-job", r1, [m1.id]);
	assert.deepEqual(res.acknowledged, [m1.id]);

	const after = await readPendingMailboxMessages(root, "receiver-job", r1);
	assert.equal(after.length, 2);
	assert.ok(!after.some((m) => m.id === m1.id), "acked message must be excluded");
	assert.equal((await listMailboxMessages(root, "receiver-job")).length, 3, "list still shows everything");

	// idempotent re-ack
	await acknowledgeMailboxMessages(root, "receiver-job", r1, [m1.id]);
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", r1)).length, 2);

	// a fresh attempt starts with its OWN (empty) receipts
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", r2)).length, 3);

	// per-message receipts: acking m2 can never skip m3
	await acknowledgeMailboxMessages(root, "receiver-job", r1, [m2.id]);
	const p = await readPendingMailboxMessages(root, "receiver-job", r1);
	assert.deepEqual(
		new Set(p.map((m) => m.id)),
		new Set([m3.id]),
	);

	// receipts survive a restart: fresh store instance, same attempt
	const store2 = new JobStore(root);
	const afterRestart = await readPendingMailboxMessages(store2.root, "receiver-job", r1);
	assert.equal(afterRestart.length, 1);
	assert.equal(afterRestart[0].id, m3.id);

	const receiptsDir = path.join(root, "jobs", "receiver-job", "attempts", r1, "mailbox-receipts");
	assert.ok(fs.existsSync(path.join(receiptsDir, `${m1.id}.json`)), "receipt must be a durable file");
	assert.ok(fs.existsSync(path.join(receiptsDir, `${m2.id}.json`)));
	assert.ok(!fs.existsSync(path.join(receiptsDir, `${m3.id}.json`)), "unacked message must have no receipt");
	// the other attempt's receipts are untouched by r1's acks
	assert.ok(!fs.existsSync(path.join(root, "jobs", "receiver-job", "attempts", r2, "mailbox-receipts", `${m1.id}.json`)));
	cleanup(root);
});

test("ack validates ids and recipient membership; an invalid batch writes nothing", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	const [attempt] = makeJob(store, "receiver-job");
	makeJob(store, "other-job");

	const [m1, m2] = await Promise.all([send(root, fromAttempt, "receiver-job", "one"), send(root, fromAttempt, "receiver-job", "two")]);
	const foreign = await send(root, fromAttempt, "other-job", "belongs elsewhere");
	const receiptsDir = path.join(root, "jobs", "receiver-job", "attempts", attempt, "mailbox-receipts");

	// unknown-but-safe id
	await assert.rejects(acknowledgeMailboxMessages(root, "receiver-job", attempt, [crypto.randomUUID()]), /not a member/);
	// id from another job's mailbox
	await assert.rejects(acknowledgeMailboxMessages(root, "receiver-job", attempt, [foreign.id]), /not a member/);
	// batch atomicity: valid + invalid → rejects and writes NOTHING
	await assert.rejects(acknowledgeMailboxMessages(root, "receiver-job", attempt, [m1.id, crypto.randomUUID()]), /not a member/);
	assert.ok(!fs.existsSync(path.join(receiptsDir, `${m1.id}.json`)), "invalid batch must not ack the valid id");
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", attempt)).length, 2, "nothing was consumed");

	// valid batch
	const res = await acknowledgeMailboxMessages(root, "receiver-job", attempt, [m1.id, m2.id]);
	assert.deepEqual(res.acknowledged, [m1.id, m2.id]);
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", attempt)).length, 0);
	assert.equal((await listMailboxMessages(root, "receiver-job")).length, 2, "messages stay listed after ack");

	// malformed record is not a valid member
	const badId = crypto.randomUUID();
	fs.writeFileSync(path.join(root, "jobs", "receiver-job", "mailbox", "messages", `${badId}.json`), "not json at all");
	await assert.rejects(acknowledgeMailboxMessages(root, "receiver-job", attempt, [badId]), /not a member/);

	// non-array ids / empty batch
	await assert.rejects(
		acknowledgeMailboxMessages(root, "receiver-job", attempt, "nope" as unknown as string[]),
		/must be an array/,
	);
	const empty = await acknowledgeMailboxMessages(root, "receiver-job", attempt, []);
	assert.deepEqual(empty.acknowledged, []);
	cleanup(root);
});

test("read-only inspection never consumes", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	const [attempt] = makeJob(store, "receiver-job");
	for (const body of ["m1", "m2", "m3"]) await send(root, fromAttempt, "receiver-job", body);

	const a = await listMailboxMessages(root, "receiver-job");
	const b = await listMailboxMessages(root, "receiver-job");
	assert.deepEqual(
		a.map((m) => m.id),
		b.map((m) => m.id),
		"stable createdAt/id order",
	);
	assert.equal(a.length, 3);

	const p1 = await readPendingMailboxMessages(root, "receiver-job", attempt);
	await listMailboxMessages(root, "receiver-job");
	const p2 = await readPendingMailboxMessages(root, "receiver-job", attempt);
	assert.deepEqual(
		p1.map((m) => m.id),
		p2.map((m) => m.id),
		"inspection must not acknowledge",
	);
	assert.ok(
		!fs.existsSync(path.join(root, "jobs", "receiver-job", "attempts", attempt, "mailbox-receipts")),
		"reads must not create receipt files",
	);
	cleanup(root);
});

// ── Bounds ──────────────────────────────────────────────────────────────────

test("body bounds: nonempty and at most 4096 UTF-8 bytes (multibyte aware)", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	makeJob(store, "receiver-job");

	// multibyte body just under the cap: 1365 × "€" = 4095 bytes
	const euro = "€".repeat(1365);
	const sent = await send(root, fromAttempt, "receiver-job", euro);
	assert.equal(Buffer.byteLength(sent.body, "utf8"), 4095);
	// exact ascii cap
	await send(root, fromAttempt, "receiver-job", "a".repeat(MAILBOX_MAX_BODY_BYTES));
	// over the cap (ascii and multibyte)
	await assert.rejects(send(root, fromAttempt, "receiver-job", "a".repeat(MAILBOX_MAX_BODY_BYTES + 1)), /max is 4096/);
	await assert.rejects(send(root, fromAttempt, "receiver-job", "€".repeat(1366)), /max is 4096/); // 4098 bytes
	// empty / non-string
	await assert.rejects(send(root, fromAttempt, "receiver-job", ""), /nonempty/);
	await assert.rejects(
		sendMailboxMessage(root, { fromJobId: "sender-job", fromAttemptId: fromAttempt, toJobId: "receiver-job", body: 42 as unknown as string }),
		/body must be a string/,
	);

	// the two oversized bodies never landed on disk
	const listed = await listMailboxMessages(root, "receiver-job", { limit: MAILBOX_MAX_READ_LIMIT });
	assert.equal(listed.length, 2);
	cleanup(root);
});

test("read limits: default 8, hard max 32, positive integers only", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	const [attempt] = makeJob(store, "receiver-job");
	await Promise.all(Array.from({ length: 40 }, (_, i) => send(root, fromAttempt, "receiver-job", `n${i}`)));

	assert.equal((await readPendingMailboxMessages(root, "receiver-job", attempt)).length, MAILBOX_DEFAULT_READ_LIMIT);
	assert.equal((await listMailboxMessages(root, "receiver-job")).length, MAILBOX_DEFAULT_READ_LIMIT);
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", attempt, { limit: MAILBOX_MAX_READ_LIMIT })).length, 32);
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", attempt, { limit: 999 })).length, 32, "limit clamps to max");
	assert.equal((await readPendingMailboxMessages(root, "receiver-job", attempt, { limit: 1 })).length, 1);
	await assert.rejects(readPendingMailboxMessages(root, "receiver-job", attempt, { limit: 0 }), /positive integer/);
	await assert.rejects(readPendingMailboxMessages(root, "receiver-job", attempt, { limit: -3 }), /positive integer/);
	await assert.rejects(readPendingMailboxMessages(root, "receiver-job", attempt, { limit: 2.5 }), /positive integer/);
	cleanup(root);
});

test("batch body total capped at 16 KiB", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	const [attempt] = makeJob(store, "receiver-job");
	await Promise.all(Array.from({ length: 5 }, () => send(root, fromAttempt, "receiver-job", "x".repeat(MAILBOX_MAX_BODY_BYTES))));

	const pending = await readPendingMailboxMessages(root, "receiver-job", attempt, { limit: MAILBOX_MAX_READ_LIMIT });
	assert.equal(pending.length, 4, "4 × 4096 = 16384 fits, the 5th must not");
	const total = pending.reduce((n, m) => n + Buffer.byteLength(m.body, "utf8"), 0);
	assert.equal(total, MAILBOX_MAX_BATCH_BODY_BYTES);

	const listed = await listMailboxMessages(root, "receiver-job", { limit: MAILBOX_MAX_READ_LIMIT });
	assert.equal(listed.length, 4, "inspection is bounded too");
	cleanup(root);
});

// ── Missing identities ──────────────────────────────────────────────────────

test("missing jobs and attempts are rejected with clear errors", async () => {
	const store = createStore();
	const root = store.root;
	const [attempt] = makeJob(store, "sender-job", 1);
	makeJob(store, "two-attempt-job", 2);

	// sender attempt must exist under the SENDER job (attempt-002 exists only under two-attempt-job)
	await assert.rejects(send(root, "attempt-002", "sender-job", "x"), /attempt "attempt-002"/);
	await assert.rejects(send(root, "attempt-999", "sender-job", "x"), /attempt "attempt-999"/);
	// missing recipient / sender jobs
	await assert.rejects(send(root, attempt, "ghost-job", "x"), /job "ghost-job" not found/);
	await assert.rejects(send(root, attempt, "ghost-job", "x", "ghost-job"), /job "ghost-job" not found/);

	await assert.rejects(listMailboxMessages(root, "ghost-job"), /job "ghost-job" not found/);
	await assert.rejects(readPendingMailboxMessages(root, "ghost-job", "attempt-001"), /job "ghost-job" not found/);
	await assert.rejects(readPendingMailboxMessages(root, "sender-job", "attempt-999"), /attempt "attempt-999"/);
	await assert.rejects(acknowledgeMailboxMessages(root, "ghost-job", "attempt-001", []), /job "ghost-job" not found/);
	await assert.rejects(acknowledgeMailboxMessages(root, "sender-job", "attempt-999", []), /attempt "attempt-999"/);

	// missing store root
	await assert.rejects(listMailboxMessages(path.join(root, "does-not-exist"), "sender-job"), /store root not found/);
	cleanup(root);
});

// ── Path safety ─────────────────────────────────────────────────────────────

test("unsafe / traversal identifiers are rejected before touching the filesystem", async () => {
	const store = createStore();
	const root = store.root;
	const [attempt] = makeJob(store, "sender-job");

	const bad = ["..", "../evil", "a/b", "/abs", "a\\b", "", ".hidden", "x".repeat(300), "sp ace"];
	for (const id of bad) {
		await assert.rejects(send(root, attempt, id, "x"), /invalid toJobId/);
		await assert.rejects(send(root, attempt, "sender-job", "x", id), /invalid fromJobId/);
		await assert.rejects(sendMailboxMessage(root, { fromJobId: "sender-job", fromAttemptId: id, toJobId: "sender-job", body: "x" }), /invalid fromAttemptId/);
		await assert.rejects(listMailboxMessages(root, id), /invalid jobId/);
		await assert.rejects(readPendingMailboxMessages(root, "sender-job", id), /invalid attemptId/);
		await assert.rejects(acknowledgeMailboxMessages(root, "sender-job", attempt, [id]), /invalid messageId/);
	}
	await assert.rejects(listMailboxMessages(root, 42 as unknown as string), /invalid jobId/);
	await assert.rejects(sendMailboxMessage(root, null as unknown as Parameters<typeof sendMailboxMessage>[1]), /must be an object/);

	// nothing escaped the store
	assert.ok(!fs.existsSync(path.join(root, "jobs", "evil")));
	assert.ok(!fs.existsSync(path.join(root, "evil")));
	cleanup(root);
});

test("symlink escapes are rejected at every store boundary", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	makeJob(store, "receiver-job");
	const outside = tmpRoot();

	// 1) a job directory symlinked outside the store
	const outsideJob = path.join(outside, "evil-job");
	fs.mkdirSync(outsideJob, { recursive: true });
	fs.writeFileSync(path.join(outsideJob, "job.json"), "{}"); // looks like a job from inside
	fs.symlinkSync(outsideJob, path.join(root, "jobs", "evil-job"));
	await assert.rejects(send(root, fromAttempt, "evil-job", "x"), /escapes store root/);
	await assert.rejects(listMailboxMessages(root, "evil-job"), /escapes store root/);

	// 2) recipient mailbox/messages symlinked outside
	const mailboxDir = path.join(root, "jobs", "receiver-job", "mailbox");
	const outsideMsgs = path.join(outside, "msgs");
	fs.mkdirSync(outsideMsgs, { recursive: true });
	fs.mkdirSync(mailboxDir, { recursive: true });
	fs.symlinkSync(outsideMsgs, path.join(mailboxDir, "messages"));
	await assert.rejects(send(root, fromAttempt, "receiver-job", "x"), /escapes store root/);
	await assert.rejects(listMailboxMessages(root, "receiver-job"), /escapes store root/);
	await assert.rejects(readPendingMailboxMessages(root, "receiver-job", "attempt-001"), /escapes store root/);
	fs.unlinkSync(path.join(mailboxDir, "messages"));

	// 3) an attempt directory symlinked outside
	const [victimAttempt] = makeJob(store, "victim-job");
	const victimAttDir = path.join(root, "jobs", "victim-job", "attempts", victimAttempt);
	const outsideAtt = path.join(outside, "attempt");
	fs.mkdirSync(outsideAtt, { recursive: true });
	fs.writeFileSync(path.join(outsideAtt, "attempt.json"), "{}");
	fs.rmSync(victimAttDir, { recursive: true });
	fs.symlinkSync(outsideAtt, victimAttDir);
	await assert.rejects(readPendingMailboxMessages(root, "victim-job", victimAttempt), /escapes store root/);
	await assert.rejects(acknowledgeMailboxMessages(root, "victim-job", victimAttempt, []), /escapes store root/);

	// 4) receipts dir symlinked outside (send first, then swap)
	makeJob(store, "receipts-victim-job");
	const msg = await send(root, fromAttempt, "receipts-victim-job", "payload");
	const rvAttDir = path.join(root, "jobs", "receipts-victim-job", "attempts", "attempt-001");
	const outsideReceipts = path.join(outside, "receipts");
	fs.mkdirSync(outsideReceipts, { recursive: true });
	fs.symlinkSync(outsideReceipts, path.join(rvAttDir, "mailbox-receipts"));
	await assert.rejects(acknowledgeMailboxMessages(root, "receipts-victim-job", "attempt-001", [msg.id]), /escapes store root/);
	await assert.rejects(readPendingMailboxMessages(root, "receipts-victim-job", "attempt-001"), /escapes store root/);
	// the message still never left the store
	assert.ok(fs.existsSync(path.join(root, "jobs", "receipts-victim-job", "mailbox", "messages", `${msg.id}.json`)));
	cleanup(root);
});

// ── Malformed records ───────────────────────────────────────────────────────

test("malformed records are excluded without poisoning valid messages", async () => {
	const store = createStore();
	const root = store.root;
	const [fromAttempt] = makeJob(store, "sender-job");
	const [attempt] = makeJob(store, "receiver-job");

	const m1 = await send(root, fromAttempt, "receiver-job", "valid one");
	const m2 = await send(root, fromAttempt, "receiver-job", "valid two");
	const dir = path.join(root, "jobs", "receiver-job", "mailbox", "messages");
	const now = new Date().toISOString();
	const base = { createdAt: now, fromJobId: "sender-job", fromAttemptId: fromAttempt, toJobId: "receiver-job" };

	const write = (id: string, record: unknown) => fs.writeFileSync(path.join(dir, `${id}.json`), typeof record === "string" ? record : JSON.stringify(record));
	write(crypto.randomUUID(), "{corrupt json!!"); // invalid JSON
	const wrongSchema = crypto.randomUUID();
	write(wrongSchema, { schemaVersion: 2, id: wrongSchema, ...base, body: "x" });
	const noBody = crypto.randomUUID();
	write(noBody, { schemaVersion: 1, id: noBody, ...base });
	const emptyBody = crypto.randomUUID();
	write(emptyBody, { schemaVersion: 1, id: emptyBody, ...base, body: "" });
	const badDate = crypto.randomUUID();
	write(badDate, { schemaVersion: 1, id: badDate, ...base, createdAt: "yesterday", body: "x" });
	const wrongRecipient = crypto.randomUUID();
	write(wrongRecipient, { schemaVersion: 1, id: wrongRecipient, ...base, toJobId: "other-job", body: "x" });
	const mismatched = crypto.randomUUID();
	write(mismatched, { schemaVersion: 1, id: "some-other-id", ...base, body: "x" });
	const oversized = crypto.randomUUID();
	write(oversized, { schemaVersion: 1, id: oversized, ...base, body: "z".repeat(MAILBOX_MAX_BODY_BYTES + 1) });
	// in-progress atomic temp file with VALID content — must still be ignored
	fs.writeFileSync(path.join(dir, `.${crypto.randomUUID()}.json.123.abc.tmp`), JSON.stringify({ schemaVersion: 1, id: "temp-id", ...base, body: "temp" }));
	// foreign file
	fs.writeFileSync(path.join(dir, "notes.txt"), "not a message");

	const listed = await listMailboxMessages(root, "receiver-job", { limit: MAILBOX_MAX_READ_LIMIT });
	assert.deepEqual(
		new Set(listed.map((m) => m.id)),
		new Set([m1.id, m2.id]),
		"only the two valid records must survive",
	);
	const pending = await readPendingMailboxMessages(root, "receiver-job", attempt, { limit: MAILBOX_MAX_READ_LIMIT });
	assert.deepEqual(
		new Set(pending.map((m) => m.id)),
		new Set([m1.id, m2.id]),
	);

	// valid messages remain fully usable alongside the corrupt ones
	await acknowledgeMailboxMessages(root, "receiver-job", attempt, [m1.id]);
	const after = await readPendingMailboxMessages(root, "receiver-job", attempt, { limit: MAILBOX_MAX_READ_LIMIT });
	assert.deepEqual(
		after.map((m) => m.id),
		[m2.id],
	);
	cleanup(root);
});
