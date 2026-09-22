/**
 * core/spawn.ts stream capture tests.
 *
 * Unit tests exercise StreamCapture directly (rotation boundaries, oversized
 * lines). Integration tests drive runWorker against a fake pi worker script
 * (via the getPiInvocation argv[1] seam used by extension-smoke.test.ts) to
 * prove incremental capture, final unterminated line capture, malformed /
 * oversized line handling, IO-failure isolation and unchanged result
 * extraction.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { MAX_STREAM_BYTES, StreamCapture, runWorker, type SpawnRequest } from "../core/spawn.ts";
import { makeAgent } from "./helpers.ts";

const roots: string[] = [];
function tmp(prefix = "orch-stream-"): string {
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

// ── Fake worker child ────────────────────────────────────────────────────────

const fakeWorkerPath = path.join(tmp("orch-stream-worker-"), "fake-worker.mjs");
fs.writeFileSync(
	fakeWorkerPath,
	[
		"import * as fs from 'node:fs';",
		"const spec = JSON.parse(fs.readFileSync(process.env.FAKE_SPEC, 'utf8'));",
		"for (const seg of spec.segments ?? []) {",
		"  if (seg.write) process.stdout.write(seg.write);",
		"  if (seg.waitFor) {",
		"    while (!fs.existsSync(seg.waitFor)) await new Promise((r) => setTimeout(r, 5));",
		"  }",
		"}",
		"process.exitCode = spec.exitCode ?? 0;",
		"",
	].join("\n"),
);
const realArgv1 = process.argv[1];
process.argv[1] = fakeWorkerPath;
after(() => {
	process.argv[1] = realArgv1;
});

function writeSpec(spec: unknown): string {
	const file = path.join(tmp("orch-stream-spec-"), "spec.json");
	fs.writeFileSync(file, JSON.stringify(spec));
	return file;
}

function makeReq(attemptDir: string, opts: { launchEnv?: Record<string, string>; prompt?: string } = {}): SpawnRequest {
	const cwd = tmp("orch-stream-cwd-");
	fs.mkdirSync(path.join(attemptDir, "session"), { recursive: true });
	return {
		agent: makeAgent({ name: "worker" }),
		resolved: {
			alias: "worker-cheap",
			concrete: { provider: "fake", model: "fake/cheap" },
			source: "registry",
		},
		prompt: opts.prompt ?? "do the work",
		cwd,
		jobId: "job-1",
		attemptId: "attempt-001",
		attemptDir,
		sessionDir: path.join(attemptDir, "session"),
		sessionId: "sess-1",
		workerExtensionPath: path.join(cwd, "worker.ts"),
		timeoutSeconds: 30,
		launchArgs: [],
		launchEnv: opts.launchEnv ?? {},
	};
}

const assistantEnd = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "final answer" }],
		usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 }, totalTokens: 7 },
		stopReason: "stop",
	},
};

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 10));
	}
}

function readCapture(dir: string, name = "stream.jsonl"): string {
	return fs.readFileSync(path.join(dir, name), "utf8");
}

// ── Unit: rotation / bounds ──────────────────────────────────────────────────

describe("StreamCapture bounds", () => {
	const size = (line: string) => Buffer.byteLength(line, "utf-8") + 1;
	const line = (n: number) => JSON.stringify({ type: "event", n });

	it("rotates to exactly current + previous before exceeding the bound", () => {
		const dir = tmp();
		const a = line(1);
		const b = line(2);
		const c = line(3);
		const cap = new StreamCapture(dir, size(a) + size(b) - 1);

		cap.append(a);
		assert.equal(readCapture(dir), `${a}\n`);
		assert.equal(fs.existsSync(path.join(dir, "stream.previous.jsonl")), false);

		cap.append(b); // would exceed → rotate
		assert.equal(readCapture(dir, "stream.previous.jsonl"), `${a}\n`);
		assert.equal(readCapture(dir), `${b}\n`);

		cap.append(c); // would exceed → rotate again, previous overwritten
		assert.equal(readCapture(dir, "stream.previous.jsonl"), `${b}\n`);
		assert.equal(readCapture(dir), `${c}\n`);

		// exactly two files, no accumulation
		const files = fs.readdirSync(dir).filter((f) => f.startsWith("stream")).sort();
		assert.deepEqual(files, ["stream.jsonl", "stream.previous.jsonl"]);
	});

	it("keeps a line that exactly fills the bound without rotating", () => {
		const dir = tmp();
		const a = line(1);
		const b = line(2);
		const cap = new StreamCapture(dir, size(a) + size(b));

		cap.append(a);
		cap.append(b); // a + b == bound, allowed
		assert.equal(readCapture(dir), `${a}\n${b}\n`);
		assert.equal(fs.existsSync(path.join(dir, "stream.previous.jsonl")), false);
	});

	it("skips a single line larger than the bound and keeps valid JSONL", () => {
		const dir = tmp();
		const cap = new StreamCapture(dir, 40);
		cap.append(JSON.stringify({ type: "message_update", pad: "x".repeat(200) }));
		assert.equal(fs.existsSync(path.join(dir, "stream.jsonl")), false);

		cap.append(JSON.stringify({ type: "ok" }));
		assert.equal(readCapture(dir), `${JSON.stringify({ type: "ok" })}\n`);
	});

	it("creates files with restrictive 0600 permissions", () => {
		const dir = tmp();
		const cap = new StreamCapture(dir, 1024);
		cap.append(JSON.stringify({ type: "event" }));
		assert.equal(fs.statSync(path.join(dir, "stream.jsonl")).mode & 0o777, 0o600);
	});
});

// ── Integration: runWorker ───────────────────────────────────────────────────

describe("runWorker stream capture", () => {
	it("captures incremental events before exit and a final unterminated line", async () => {
		const attemptDir = tmp("orch-stream-attempt-");
		const signal = path.join(attemptDir, "go");
		const first =
			`${JSON.stringify({ type: "session_start", sessionId: "s" })}\n` +
			`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } })}\n`;
		const spec = writeSpec({
			segments: [{ write: first }, { waitFor: signal }, { write: JSON.stringify(assistantEnd) }],
		});
		const req = makeReq(attemptDir, { launchEnv: { FAKE_SPEC: spec } });

		const promise = runWorker(req);
		await waitFor(() => {
			const p = path.join(attemptDir, "stream.jsonl");
			return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("message_update");
		});

		const mid = readCapture(attemptDir);
		assert.ok(mid.includes("session_start"));
		assert.ok(!mid.includes("final answer"), "final event must not be captured before it is emitted");

		fs.writeFileSync(signal, "");
		const outcome = await promise;

		assert.equal(outcome.finalText, "final answer");
		assert.equal(outcome.usage.turns, 1);
		assert.equal(outcome.exitCode, 0);

		const captured = readCapture(attemptDir);
		const lines = captured.split("\n").filter(Boolean);
		assert.equal(lines.length, 3);
		assert.ok(captured.endsWith("\n"), "final unterminated stdout line is normalized with a newline");
		assert.equal(JSON.parse(lines[2]).message.content[0].text, "final answer");
		assert.equal(fs.statSync(path.join(attemptDir, "stream.jsonl")).mode & 0o777, 0o600);
	});

	it("ignores malformed and oversized lines but still processes stdout normally", async () => {
		const attemptDir = tmp("orch-stream-attempt-");
		const oversized = JSON.stringify({ type: "message_update", marker: "OVERSIZED_MARKER", pad: "x".repeat(MAX_STREAM_BYTES + 1024) });
		const spec = writeSpec({
			segments: [
				{
					write:
						`{not valid json\n` +
						`${JSON.stringify({ type: "session_start", sessionId: "s" })}\n` +
						`${oversized}\n` +
						`${JSON.stringify(assistantEnd)}\n`,
				},
			],
		});
		const req = makeReq(attemptDir, { launchEnv: { FAKE_SPEC: spec } });

		const outcome = await runWorker(req);
		assert.equal(outcome.finalText, "final answer", "normal stdout processing continues past bad/oversized lines");

		const captured = readCapture(attemptDir);
		assert.ok(!captured.includes("not valid json"), "malformed line ignored");
		assert.ok(!captured.includes("OVERSIZED_MARKER"), "oversized line skipped");
		const lines = captured.split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
		assert.equal(JSON.parse(lines[0]).type, "session_start");
		assert.equal(JSON.parse(lines[1]).type, "message_end");
	});

	it("isolates capture IO failures and leaves result extraction unchanged", async () => {
		const attemptDir = tmp("orch-stream-attempt-");
		// Make stream.jsonl a directory so every append fails with EISDIR.
		fs.mkdirSync(path.join(attemptDir, "stream.jsonl"));
		const spec = writeSpec({
			segments: [
				{
					write:
						`${JSON.stringify({ type: "session_start", sessionId: "s" })}\n` +
						`${JSON.stringify(assistantEnd)}\n`,
				},
			],
		});
		const req = makeReq(attemptDir, { launchEnv: { FAKE_SPEC: spec } });

		const outcome = await runWorker(req);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.finalText, "final answer");
		assert.equal(outcome.usage.turns, 1);
		assert.equal(outcome.usage.input, 3);
		assert.equal(outcome.usage.output, 4);
		assert.ok(fs.statSync(path.join(attemptDir, "stream.jsonl")).isDirectory(), "capture target untouched by failure");
	});
});
