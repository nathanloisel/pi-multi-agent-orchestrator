/**
 * tests/workspace-stdio.test.ts — regression tests for the workspace git()
 * helper leaking subprocess stderr onto the parent terminal.
 *
 * core/workspace.ts runs several *expected-to-fail* git probes (rev-parse
 * --verify on a fresh branch, rev-parse --git-dir in a non-repo, ...). These
 * throw and are caught, but execFileSync prints uncaptured stderr to the
 * parent fd2 unless stdio is explicit. The fix sets
 * stdio: ['ignore', 'pipe', 'pipe'] so diagnostics stay on error.stderr.
 *
 * Because native fd2 writes bypass process.stderr.write interception, these
 * tests run the real helper in a child process and assert the child's stderr
 * is empty for expected caught failures and success.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const childFixture = path.join(here, "fixtures", "workspace-stdio-child.ts");

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

function git(cwd: string, ...args: string[]): string {
	const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
	assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
	return res.stdout;
}

function initRepo(dir: string): void {
	git(dir, "init", "-q");
	// Deterministic local identity/config so commits never depend on the host.
	git(dir, "config", "user.email", "workspace-stdio@example.com");
	git(dir, "config", "user.name", "Workspace Stdio Test");
	git(dir, "config", "commit.gpgsign", "false");
}

interface ChildRun {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runChild(mode: string, dir: string, jobId: string): ChildRun {
	const res = spawnSync(
		process.execPath,
		["--import", "tsx", childFixture, mode, dir, jobId],
		{ cwd: repoRoot, encoding: "utf-8" }
	);
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

type Payload = {
	mode: string;
	ok: boolean;
	result?: { strategy: string; path: string; branch?: string; baseCommit?: string };
	error?: { message: string; stderr: string | null; stdout: string | null; status: number | null };
	isGitRepo?: boolean;
};

function parsePayload(run: ChildRun): Payload {
	const lines = run.stdout.trim().split("\n").filter(Boolean);
	assert.ok(lines.length > 0, `child produced no stdout (status=${run.status}, stderr=${run.stderr})`);
	return JSON.parse(lines[lines.length - 1]) as Payload;
}

describe("workspace git() parent stderr capture", () => {
	it("fresh committed repo: creates worktree on pi/<jobId> with no parent stderr", () => {
		const repo = tempDir("orch-ws-stdio-fresh-");
		initRepo(repo);
		fs.writeFileSync(path.join(repo, "file.txt"), "hello\n");
		git(repo, "add", "file.txt");
		git(repo, "commit", "-q", "-m", "init");

		const jobId = "stdio-fresh-job";
		const run = runChild("fresh", repo, jobId);
		assert.equal(run.status, 0, `child exited ${run.status}`);
		assert.equal(run.stderr, "", "expected fresh createWorkspace to emit no parent stderr");
		assert.ok(run.stdout.includes(jobId), "child stdout should serialize the workspace result");

		const payload = parsePayload(run);
		assert.equal(payload.ok, true, `unexpected child error: ${JSON.stringify(payload.error)}`);
		assert.equal(payload.result?.strategy, "git-worktree");
		assert.equal(payload.result?.branch, `pi/${jobId}`);
		assert.ok(payload.result?.path);
		assert.ok(payload.result?.baseCommit);
		assert.ok(
			payload.result!.path.includes(path.join(".pi-worktrees", jobId)),
			`worktree path should be under .pi-worktrees: ${payload.result?.path}`
		);
		assert.ok(fs.existsSync(payload.result!.path), "worktree path should exist");
	});

	it("non-Git cwd: falls back to cwd strategy with no parent stderr", () => {
		const dir = tempDir("orch-ws-stdio-nonrepo-");
		fs.mkdirSync(path.join(dir, "nested"), { recursive: true });

		const run = runChild("nonrepo", dir, "stdio-nonrepo-job");
		assert.equal(run.status, 0, `child exited ${run.status}`);
		assert.equal(run.stderr, "", "expected non-repo probe failure to emit no parent stderr");

		const payload = parsePayload(run);
		assert.equal(payload.ok, true, `unexpected child error: ${JSON.stringify(payload.error)}`);
		assert.equal(payload.result?.strategy, "cwd", "non-repo must preserve cwd fallback");
		assert.equal(payload.result?.path, dir);
		assert.equal(payload.isGitRepo, false);
	});

	it("unborn repo: preserves thrown failure and captured stderr with no parent stderr", () => {
		const repo = tempDir("orch-ws-stdio-unborn-");
		initRepo(repo);

		const run = runChild("unborn", repo, "stdio-unborn-job");
		assert.equal(run.status, 0, `child exited ${run.status}`);
		assert.equal(run.stderr, "", "expected unborn-repo probe failure to emit no parent stderr");

		const payload = parsePayload(run);
		assert.equal(payload.ok, false, "unborn repo must still throw from createWorkspace");
		assert.ok(payload.error, "child should serialize the caught error");
		assert.ok(payload.error!.message.length > 0, "error message should be present");
		assert.ok(
			typeof payload.error!.stderr === "string" && payload.error!.stderr.length > 0,
			"caught error should retain usable captured stderr"
		);
	});
});