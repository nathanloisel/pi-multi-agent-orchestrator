/**
 * core/validation.ts — first-class deterministic validation (§15, §16).
 *
 * Host-side execution of the agent's (or job's) validation commands inside the
 * attempt workspace. Logs are written to the attempt's validation/ dir and
 * referenced as artifacts — they never enter model context. The outcome is
 * merged into the canonical JobResult, overriding whatever the worker claimed:
 * deterministic checks beat self-reported success.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidationCheck, ValidationOutcome } from "./types.ts";

export interface RunValidationOpts {
	commands: string[];
	cwd: string;
	validationDir: string;
	timeoutSeconds?: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onCheck?: (check: ValidationCheck) => void;
}

function runCommand(command: string, cwd: string, logFile: string, timeoutMs: number, env: NodeJS.ProcessEnv | undefined, signal?: AbortSignal): Promise<{ exitCode: number; timedOut: boolean }> {
	return new Promise((resolve) => {
		const out = fs.createWriteStream(logFile);
		const proc = spawn("bash", ["-lc", command], { cwd, env, shell: false });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000);
		}, timeoutMs);
		const onAbort = () => {
			proc.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		proc.stdout.pipe(out);
		proc.stderr.pipe(out, { end: false });
		proc.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			out.end();
			resolve({ exitCode: code ?? -1, timedOut });
		});
		proc.on("error", () => {
			clearTimeout(timer);
			out.end();
			resolve({ exitCode: -1, timedOut });
		});
	});
}

export async function runValidation(opts: RunValidationOpts): Promise<ValidationOutcome> {
	if (opts.commands.length === 0) return { status: "skipped", checks: [] };
	fs.mkdirSync(opts.validationDir, { recursive: true });
	const checks: ValidationCheck[] = [];
	for (const command of opts.commands) {
		const name = command.split(/\s+/).slice(0, 2).join(" ").replace(/[^\w.-]+/g, "_").slice(0, 40) || "check";
		const logName = `${name}-${checks.length + 1}.log`;
		const logFile = path.join(opts.validationDir, logName);
		const started = Date.now();
		const { exitCode, timedOut } = await runCommand(
			command,
			opts.cwd,
			logFile,
			(opts.timeoutSeconds ?? 600) * 1000,
			opts.env,
			opts.signal,
		);
		const check: ValidationCheck = {
			name,
			command,
			status: timedOut ? "error" : exitCode === 0 ? "passed" : "failed",
			exitCode,
			durationMs: Date.now() - started,
			artifact: `validation/${logName}`,
		};
		if (timedOut) check.message = `timed out after ${opts.timeoutSeconds ?? 600}s`;
		checks.push(check);
		opts.onCheck?.(check);
		if (check.status !== "passed") break; // fail fast: first failure is the actionable signal
	}
	const status = checks.some((c) => c.status === "failed" || c.status === "error")
		? "failed"
		: checks.every((c) => c.status === "passed")
			? "passed"
			: "error";
	return { status, checks };
}

/** Render a compact failure feedback block for fresh-retry context packs (§16). */
export function validationFeedback(outcome: ValidationOutcome, attemptId: string): string {
	const failed = outcome.checks.filter((c) => c.status !== "passed");
	return [
		`Previous attempt (${attemptId}) failed deterministic validation:`,
		...failed.map((c) => `- ${c.command ?? c.name}: ${c.status}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ""}${c.message ? ` — ${c.message}` : ""}`),
		`Read the full logs under the attempt's validation/ directory if needed; fix the root cause.`,
	].join("\n");
}
