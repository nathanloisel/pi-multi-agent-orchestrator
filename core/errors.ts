/**
 * core/errors.ts — normalized error taxonomy (§29).
 *
 * Transport-level failures (provider 5xx, rate limits, network, auth/quota at
 * the API layer) are NOT task failures. They are retried at the transport level
 * and never consume a rung of the task-retry ladder.
 */

export type ErrorKind =
	| "rate_limited"
	| "provider_unavailable" // 5xx, connection reset, DNS
	| "timeout"
	| "auth" // bad key, exhausted quota
	| "malformed_output" // worker produced no parseable result
	| "validation_failed" // deterministic checks failed → task-level
	| "task_failed" // worker reported failure/blocked → task-level
	| "aborted"
	| "budget_exceeded"
	| "unknown";

export class OrchestratorError extends Error {
	constructor(
		public kind: ErrorKind,
		message: string,
		public detail?: unknown,
	) {
		super(message);
		this.name = "OrchestratorError";
	}

	/** Transport errors are retryable without counting against the task ladder. */
	get isTransport(): boolean {
		return this.kind === "rate_limited" || this.kind === "provider_unavailable" || this.kind === "timeout";
	}
}

/**
 * Classify a pi subprocess failure into the normalized taxonomy.
 * Inputs: exit code, pi's stopReason/errorMessage, and captured stderr.
 */
export function classifyRunFailure(exitCode: number, stopReason?: string, errorMessage?: string, stderr?: string): OrchestratorError {
	const blob = `${errorMessage ?? ""}\n${stderr ?? ""}`.toLowerCase();

	if (stopReason === "aborted" || blob.includes("aborted by orchestrator")) {
		return new OrchestratorError("aborted", errorMessage || "Aborted", { exitCode });
	}
	if (/out of extra usage|quota|insufficient|unauthorized|invalid api key|authentication|403/.test(blob)) {
		return new OrchestratorError("auth", errorMessage || "Provider auth/quota failure", { exitCode, stderr: stderr?.slice(-500) });
	}
	if (/rate.?limit|429|too many requests/.test(blob)) {
		return new OrchestratorError("rate_limited", errorMessage || "Provider rate limited", { exitCode });
	}
	if (/timed? ?out|timeout|deadline/.test(blob)) {
		return new OrchestratorError("timeout", errorMessage || "Timed out", { exitCode });
	}
	if (/50[0-9]|bad gateway|service unavailable|connection (reset|refused|error)|econnreset|enotfound|overloaded|fetch failed|not a valid model id|invalid model(?: id)?|400[^\n]*model/.test(blob)) {
		return new OrchestratorError("provider_unavailable", errorMessage || "Provider unavailable", { exitCode });
	}
	if (stopReason === "error") {
		return new OrchestratorError("provider_unavailable", errorMessage || "Provider error", { exitCode });
	}
	if (exitCode !== 0) {
		return new OrchestratorError("unknown", errorMessage || stderr?.slice(-300) || `Subprocess exited ${exitCode}`, { exitCode });
	}
	return new OrchestratorError("task_failed", errorMessage || "Worker reported task failure", { exitCode });
}
