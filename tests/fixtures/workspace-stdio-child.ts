/**
 * tests/fixtures/workspace-stdio-child.ts — child harness for the parent-stderr
 * capture regression tests.
 *
 * Imports the real core/workspace.ts, runs one createWorkspace scenario, and
 * serializes the essential result / error diagnostics to stdout. The parent
 * asserts this process's native stderr fd stays empty on expected caught
 * failures and on success — intercepting process.stderr.write would miss
 * native fd2 writes, so a real subprocess is required.
 */

import { createWorkspace, isGitRepo } from "../../core/workspace.ts";

type Json = Record<string, unknown>;

const [mode, dir, jobId = "stdio-job"] = process.argv.slice(2);

function emit(payload: Json): void {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function serializeError(err: unknown): Json {
	const e = err as {
		message?: string;
		stdout?: string | null;
		stderr?: string | null;
		status?: number | null;
	};
	return {
		message: e?.message ?? String(err),
		stdout: e?.stdout ?? null,
		stderr: e?.stderr ?? null,
		status: e?.status ?? null,
	};
}

if (!dir) {
	emit({ mode, ok: false, error: { message: "dir argument required" } });
	process.exit(2);
}

// Every scenario catches expected errors itself so the parent can assert the
// child exited cleanly while its native stderr remained untouched.
try {
	const ws = createWorkspace({ strategy: "git-worktree", jobId, cwd: dir });
	emit({ mode, ok: true, result: ws, isGitRepo: isGitRepo(dir) });
} catch (err) {
	emit({ mode, ok: false, error: serializeError(err) });
}