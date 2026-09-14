/**
 * core/workspace.ts — isolated workspaces for coding jobs (§14).
 *
 * strategy "cwd": run in the given directory (research/read-only jobs).
 * strategy "git-worktree": create repo/.pi-worktrees/<jobId> on branch
 * pi/<jobId> from the current HEAD. Never merges automatically; cleanup is
 * policy-driven (keep | remove-on-success).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceInfo } from "./types.ts";

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function isGitRepo(cwd: string): boolean {
	try {
		git(["rev-parse", "--git-dir"], cwd);
		return true;
	} catch {
		return false;
	}
}

export interface CreateWorkspaceOpts {
	strategy: "cwd" | "git-worktree";
	jobId: string;
	cwd: string;
	/** Base ref for the worktree branch (default: current HEAD). */
	baseRef?: string;
}

export function createWorkspace(opts: CreateWorkspaceOpts): WorkspaceInfo {
	if (opts.strategy !== "git-worktree") {
		return { strategy: "cwd", path: opts.cwd };
	}
	if (!isGitRepo(opts.cwd)) {
		// Degrade gracefully instead of failing the job.
		return { strategy: "cwd", path: opts.cwd };
	}
	const repoRoot = git(["rev-parse", "--show-toplevel"], opts.cwd);
	const baseCommit = git(["rev-parse", opts.baseRef ?? "HEAD"], repoRoot);
	const branch = `pi/${opts.jobId}`;
	const wtRoot = path.join(repoRoot, ".pi-worktrees");
	const wtPath = path.join(wtRoot, opts.jobId);
	fs.mkdirSync(wtRoot, { recursive: true });
	if (fs.existsSync(wtPath)) {
		return { strategy: "git-worktree", path: wtPath, branch, baseCommit };
	}
	// Reuse the branch if a previous attempt created it (fresh retry on same job).
	let branchExists = false;
	try {
		git(["rev-parse", "--verify", branch], repoRoot);
		branchExists = true;
	} catch {
		branchExists = false;
	}
	if (branchExists) {
		git(["worktree", "add", wtPath, branch], repoRoot);
	} else {
		git(["worktree", "add", "-b", branch, wtPath, opts.baseRef ?? "HEAD"], repoRoot);
	}
	return { strategy: "git-worktree", path: wtPath, branch, baseCommit };
}

export function cleanupWorkspace(ws: WorkspaceInfo | undefined, policy: "keep" | "remove-on-success", succeeded: boolean): void {
	if (!ws || ws.strategy !== "git-worktree") return;
	if (policy === "keep" || !succeeded) return; // never delete evidence of failure
	try {
		const repoRoot = git(["rev-parse", "--show-toplevel"], path.dirname(ws.path));
		git(["worktree", "remove", "--force", ws.path], repoRoot);
	} catch {
		try {
			fs.rmSync(ws.path, { recursive: true, force: true });
		} catch {
			/* leave it; user can prune */
		}
	}
}

/** Produce a git-diff artifact of the worktree (uncommitted + committed vs base). */
export function captureDiffArtifact(ws: WorkspaceInfo, artifactsDir: string): string | null {
	if (ws.strategy !== "git-worktree") return null;
	try {
		const diff = git(["diff", "HEAD"], ws.path);
		const staged = git(["diff", "--cached"], ws.path);
		const untracked = git(["ls-files", "--others", "--exclude-standard"], ws.path);
		const parts = [staged, diff].filter(Boolean);
		if (untracked) parts.push(`# untracked files:\n${untracked}`);
		if (parts.length === 0) return null;
		const file = path.join(artifactsDir, "change.patch");
		fs.mkdirSync(artifactsDir, { recursive: true });
		fs.writeFileSync(file, `${parts.join("\n\n")}\n`);
		return file;
	} catch {
		return null;
	}
}
