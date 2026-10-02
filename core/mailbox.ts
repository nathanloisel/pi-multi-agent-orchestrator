/**
 * core/mailbox.ts — persistent inter-job mailbox transport.
 *
 * Append-only, one atomic JSON file per message:
 *   <root>/jobs/<toJobId>/mailbox/messages/<uuid>.json
 *
 * Durable per-attempt per-message receipts:
 *   <root>/jobs/<jobId>/attempts/<attemptId>/mailbox-receipts/<messageId>.json
 *
 * Design notes:
 *   - A unique UUID file name per message means concurrent senders can never
 *     lose each other's updates (no shared read-modify-write state).
 *   - A message is "pending" for an attempt iff no receipt file exists for it
 *     under THAT attempt. A restarted same attempt re-reads its receipts; a
 *     fresh attempt starts with its own (empty) receipts. Per-message receipts
 *     mean acknowledging one message can never skip another.
 *   - Writes reuse the storage.ts atomic pattern (temp file + rename in the
 *     same directory). In-progress temp files are dot-prefixed and ignored by
 *     readers.
 *   - Read-only helpers (list/readPending) NEVER acknowledge or create files.
 *   - Malformed/corrupt message records are excluded individually; one bad
 *     record never poisons the valid ones.
 *
 * Safety: job/attempt/message identifiers must be safe single path components
 * (no separators, no ".", no ".."). Every directory used at a boundary is
 * resolved with realpath and must stay contained in the store root, so
 * symlinked jobs/attempts/mailbox directories that escape the store are
 * rejected with clear errors.
 *
 * Bounds: body max 4096 UTF-8 bytes and nonempty; read default limit 8,
 * hard max 32; per-call returned body total max 16 KiB; stable ordering by
 * createdAt then id.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { atomicWriteJson } from "./storage.ts";

// ── Schema + bounds ─────────────────────────────────────────────────────────

export const MAILBOX_SCHEMA_VERSION = 1 as const;
export const MAILBOX_MAX_BODY_BYTES = 4096;
export const MAILBOX_DEFAULT_READ_LIMIT = 8;
export const MAILBOX_MAX_READ_LIMIT = 32;
export const MAILBOX_MAX_BATCH_BODY_BYTES = 16 * 1024;

/** One persisted message (schema v1). */
export interface MailboxMessage {
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	id: string; // UUID (file name stem)
	createdAt: string; // ISO-8601 UTC
	fromJobId: string;
	fromAttemptId: string;
	toJobId: string;
	body: string; // nonempty, ≤ 4096 UTF-8 bytes
}

export interface SendMailboxMessageInput {
	fromJobId: string;
	fromAttemptId: string;
	toJobId: string;
	body: string;
}

export interface MailboxReadOptions {
	/** Positive integer; clamped to MAILBOX_MAX_READ_LIMIT. Default 8. */
	limit?: number;
}

export interface MailboxAckResult {
	/** Ids durably acknowledged for this attempt (deduplicated, input order). */
	acknowledged: string[];
}

/** One durable per-attempt receipt file (not part of the public API surface). */
export interface MailboxReceipt {
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	jobId: string;
	attemptId: string;
	messageId: string;
	acknowledgedAt: string; // ISO-8601 UTC
}

// ── Validation helpers ──────────────────────────────────────────────────────

/** Safe single path component: alnum first char, then alnum/-/_/. ; no separators. */
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function validIdent(v: unknown): v is string {
	return typeof v === "string" && IDENT_RE.test(v);
}

function assertIdent(v: unknown, field: string): string {
	if (!validIdent(v)) {
		throw new Error(`mailbox: invalid ${field} ${JSON.stringify(v)} (expected a single safe path component: letters/digits then [A-Za-z0-9._-], no separators)`);
	}
	return v;
}

function openStore(root: unknown): string {
	if (typeof root !== "string" || !root) throw new Error("mailbox: store root must be a nonempty string");
	let real: string;
	try {
		real = fs.realpathSync(path.resolve(root));
	} catch {
		throw new Error(`mailbox: store root not found: ${path.resolve(root)}`);
	}
	return real;
}

/** Resolve target with realpath and require containment in the store root. */
function assertWithin(realRoot: string, target: string, label: string): string {
	let real: string;
	try {
		real = fs.realpathSync(target);
	} catch {
		throw new Error(`mailbox: ${label} not found: ${target}`);
	}
	if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
		throw new Error(`mailbox: ${label} escapes store root via symlink: ${target}`);
	}
	return real;
}

function requireJob(realRoot: string, jobId: string): string {
	const realJob = assertWithin(realRoot, path.join(realRoot, "jobs", jobId), `job "${jobId}"`);
	if (!fs.existsSync(path.join(realJob, "job.json"))) throw new Error(`mailbox: job "${jobId}" not found in store`);
	return realJob;
}

function requireAttempt(realRoot: string, realJob: string, jobId: string, attemptId: string): string {
	const realAttempt = assertWithin(realRoot, path.join(realJob, "attempts", attemptId), `attempt "${attemptId}" of job "${jobId}"`);
	if (!fs.existsSync(path.join(realAttempt, "attempt.json"))) {
		throw new Error(`mailbox: attempt "${attemptId}" of job "${jobId}" not found in store`);
	}
	return realAttempt;
}

/** Messages dir under the recipient job (write path): create it, then re-verify containment. */
function ensureMessagesDir(realRoot: string, realJob: string): string {
	const dir = path.join(realJob, "mailbox", "messages");
	if (fs.existsSync(dir)) return assertWithin(realRoot, dir, "mailbox messages directory");
	const mailboxDir = path.join(realJob, "mailbox");
	if (fs.existsSync(mailboxDir)) assertWithin(realRoot, mailboxDir, "mailbox directory"); // symlink check before mkdir
	fs.mkdirSync(dir, { recursive: true });
	return assertWithin(realRoot, dir, "mailbox messages directory");
}

/** Messages dir for read paths: never creates; returns null when absent. */
function checkMessagesDir(realRoot: string, realJob: string): string | null {
	const dir = path.join(realJob, "mailbox", "messages");
	if (fs.existsSync(dir)) return assertWithin(realRoot, dir, "mailbox messages directory");
	const mailboxDir = path.join(realJob, "mailbox");
	if (fs.existsSync(mailboxDir)) assertWithin(realRoot, mailboxDir, "mailbox directory");
	return null;
}

function ensureReceiptsDir(realRoot: string, realAttempt: string): string {
	const dir = path.join(realAttempt, "mailbox-receipts");
	if (fs.existsSync(dir)) return assertWithin(realRoot, dir, "mailbox receipts directory");
	fs.mkdirSync(dir, { recursive: true });
	return assertWithin(realRoot, dir, "mailbox receipts directory");
}

// ── Record parsing / bounding ───────────────────────────────────────────────

/** Parse one stored record; null for anything malformed (excluded, never thrown on). */
function parseMailboxRecord(raw: unknown): MailboxMessage | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (o.schemaVersion !== MAILBOX_SCHEMA_VERSION) return null;
	if (!validIdent(o.id)) return null;
	if (typeof o.createdAt !== "string" || !ISO_RE.test(o.createdAt) || Number.isNaN(Date.parse(o.createdAt))) return null;
	if (!validIdent(o.fromJobId) || !validIdent(o.fromAttemptId) || !validIdent(o.toJobId)) return null;
	if (typeof o.body !== "string" || o.body.length === 0) return null;
	if (Buffer.byteLength(o.body, "utf8") > MAILBOX_MAX_BODY_BYTES) return null;
	return {
		schemaVersion: MAILBOX_SCHEMA_VERSION,
		id: o.id,
		createdAt: o.createdAt,
		fromJobId: o.fromJobId,
		fromAttemptId: o.fromAttemptId,
		toJobId: o.toJobId,
		body: o.body,
	};
}

/**
 * Load every valid message in the mailbox. Dot-prefixed files (in-progress
 * atomic temp files) are ignored; corrupt or non-member records are skipped
 * individually so one bad record never poisons the rest.
 */
async function loadMessages(realMessagesDir: string, jobId: string): Promise<MailboxMessage[]> {
	let entries: string[];
	try {
		entries = await fsp.readdir(realMessagesDir);
	} catch {
		return [];
	}
	const out: MailboxMessage[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".") || !entry.endsWith(".json")) continue; // ignore temp + foreign files
		const stem = entry.slice(0, -".json".length);
		if (!validIdent(stem)) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(await fsp.readFile(path.join(realMessagesDir, entry), "utf8"));
		} catch {
			continue; // corrupt record — excluded, not fatal
		}
		const msg = parseMailboxRecord(raw);
		if (!msg || msg.id !== stem || msg.toJobId !== jobId) continue; // schema/id/recipient mismatch — excluded
		out.push(msg);
	}
	out.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1));
	return out;
}

function resolveLimit(options?: MailboxReadOptions): number {
	if (options === undefined) return MAILBOX_DEFAULT_READ_LIMIT;
	if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error("mailbox: options must be an object");
	const l = (options as MailboxReadOptions).limit;
	if (l === undefined) return MAILBOX_DEFAULT_READ_LIMIT;
	if (typeof l !== "number" || !Number.isInteger(l) || l < 1) {
		throw new Error(`mailbox: limit must be a positive integer (got ${JSON.stringify(l)})`);
	}
	return Math.min(l, MAILBOX_MAX_READ_LIMIT);
}

/** Apply the stable order's count limit and the 16 KiB batch body cap. */
function boundMessages(all: MailboxMessage[], limit: number): MailboxMessage[] {
	const out: MailboxMessage[] = [];
	let bytes = 0;
	for (const m of all) {
		if (out.length >= limit) break;
		const size = Buffer.byteLength(m.body, "utf8");
		if (out.length > 0 && bytes + size > MAILBOX_MAX_BATCH_BODY_BYTES) break; // single message ≤ 4096 always fits
		out.push(m);
		bytes += size;
	}
	return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send one message to a recipient job's mailbox. Sender job + sender attempt
 * and recipient job must exist in the same store. The message lands as one
 * atomic file keyed by a fresh UUID — concurrent sends never overwrite.
 */
export async function sendMailboxMessage(root: string, input: SendMailboxMessageInput): Promise<MailboxMessage> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("mailbox: input must be an object");
	const fromJobId = assertIdent(input.fromJobId, "fromJobId");
	const fromAttemptId = assertIdent(input.fromAttemptId, "fromAttemptId");
	const toJobId = assertIdent(input.toJobId, "toJobId");
	if (typeof input.body !== "string") throw new Error("mailbox: body must be a string");
	if (input.body.length === 0) throw new Error("mailbox: body must be nonempty");
	const bodyBytes = Buffer.byteLength(input.body, "utf8");
	if (bodyBytes > MAILBOX_MAX_BODY_BYTES) {
		throw new Error(`mailbox: body is ${bodyBytes} UTF-8 bytes; max is ${MAILBOX_MAX_BODY_BYTES}`);
	}

	const realRoot = openStore(root);
	const realFromJob = requireJob(realRoot, fromJobId);
	requireAttempt(realRoot, realFromJob, fromJobId, fromAttemptId);
	const realToJob = requireJob(realRoot, toJobId);
	const messagesDir = ensureMessagesDir(realRoot, realToJob);

	const message: MailboxMessage = {
		schemaVersion: MAILBOX_SCHEMA_VERSION,
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		fromJobId,
		fromAttemptId,
		toJobId,
		body: input.body,
	};
	atomicWriteJson(path.join(messagesDir, `${message.id}.json`), message);
	return message;
}

/**
 * Orchestrator read-only inspection: all valid messages in a job's mailbox in
 * stable createdAt/id order, bounded by limit + 16 KiB body total. Never
 * acknowledges, never creates files.
 */
export async function listMailboxMessages(root: string, jobId: string, options?: MailboxReadOptions): Promise<MailboxMessage[]> {
	assertIdent(jobId, "jobId");
	const limit = resolveLimit(options);
	const realRoot = openStore(root);
	const realJob = requireJob(realRoot, jobId);
	const messagesDir = checkMessagesDir(realRoot, realJob);
	if (!messagesDir) return [];
	return boundMessages(await loadMessages(messagesDir, jobId), limit);
}

/**
 * Worker read: bounded unacknowledged messages for THIS attempt. Messages the
 * attempt has acknowledged (receipt file present) are excluded; other attempts'
 * receipts are never consulted, so a fresh attempt starts seeing everything
 * again. Never acknowledges, never creates files.
 */
export async function readPendingMailboxMessages(
	root: string,
	jobId: string,
	attemptId: string,
	options?: MailboxReadOptions,
): Promise<MailboxMessage[]> {
	assertIdent(jobId, "jobId");
	assertIdent(attemptId, "attemptId");
	const limit = resolveLimit(options);
	const realRoot = openStore(root);
	const realJob = requireJob(realRoot, jobId);
	requireAttempt(realRoot, realJob, jobId, attemptId);
	const messagesDir = checkMessagesDir(realRoot, realJob);
	if (!messagesDir) return [];
	const all = await loadMessages(messagesDir, jobId);

	const receiptsDir = path.join(realJob, "attempts", attemptId, "mailbox-receipts");
	let acked: Set<string>;
	if (fs.existsSync(receiptsDir)) {
		const realReceipts = assertWithin(realRoot, receiptsDir, "mailbox receipts directory");
		try {
			acked = new Set(await fsp.readdir(realReceipts));
		} catch {
			acked = new Set();
		}
	} else {
		acked = new Set();
	}
	const pending = all.filter((m) => !acked.has(`${m.id}.json`));
	return boundMessages(pending, limit);
}

/**
 * Durably acknowledge a delivered batch for one attempt. Validates every id
 * (safe component + actual member of THIS job's mailbox) BEFORE writing any
 * receipt, so an invalid batch writes nothing. Idempotent per message id.
 */
export async function acknowledgeMailboxMessages(root: string, jobId: string, attemptId: string, messageIds: string[]): Promise<MailboxAckResult> {
	assertIdent(jobId, "jobId");
	assertIdent(attemptId, "attemptId");
	if (!Array.isArray(messageIds)) throw new Error("mailbox: messageIds must be an array of message ids");
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const raw of messageIds) {
		const id = assertIdent(raw, "messageId");
		if (!seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}

	const realRoot = openStore(root);
	const realJob = requireJob(realRoot, jobId);
	const realAttempt = requireAttempt(realRoot, realJob, jobId, attemptId);

	if (ids.length > 0) {
		// Validate recipient membership for the whole batch before any write.
		const messagesDir = checkMessagesDir(realRoot, realJob);
		const byId = messagesDir ? new Map((await loadMessages(messagesDir, jobId)).map((m) => [m.id, m])) : new Map<string, MailboxMessage>();
		for (const id of ids) {
			if (!byId.has(id)) throw new Error(`mailbox: message "${id}" is not a member of job "${jobId}" mailbox`);
		}
		const receiptsDir = ensureReceiptsDir(realRoot, realAttempt);
		const acknowledgedAt = new Date().toISOString();
		for (const id of ids) {
			const receipt: MailboxReceipt = { schemaVersion: MAILBOX_SCHEMA_VERSION, jobId, attemptId, messageId: id, acknowledgedAt };
			atomicWriteJson(path.join(receiptsDir, `${id}.json`), receipt);
		}
	}
	return { acknowledged: ids };
}
