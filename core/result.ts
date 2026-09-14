/**
 * core/result.ts — canonical JobResult handling (§4).
 *
 * Extraction pipeline (most reliable first):
 *   1. attempt/result.json written by the worker via its file tools (preferred)
 *   2. fenced ```json block in the worker's final message
 *   3. legacy fenced ```report markdown block → lenient mapping (compat)
 *   4. malformed → synthetic failure result, raw output preserved for debugging
 *
 * report.md is always RENDERED FROM the validated result, never the other way
 * around.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	emptyValidation,
	normalizeJobResult,
	RESULT_SCHEMA_VERSION,
	type AttemptRecord,
	type JobResult,
	type ValidationOutcome,
} from "./types.ts";
import { atomicWriteJson, atomicWriteText } from "./storage.ts";

export interface ExtractedResult {
	result: JobResult;
	source: "file" | "json-block" | "legacy-report" | "synthetic";
	repairs: string[];
	rawFinalText: string;
}

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)```/;
const REPORT_BLOCK_RE = /```report\s*\n([\s\S]*?)```/;

/** Map a legacy v1 markdown report block onto the v1 JSON schema (compat path). */
function fromLegacyReport(block: string, jobId: string, attemptId: string): unknown {
	const lines = block.split("\n");
	const section = (name: string): string[] => {
		const out: string[] = [];
		let inside = false;
		for (const line of lines) {
			if (/^[a-zA-Z]+:/.test(line) && !line.startsWith("-")) {
				inside = line.toLowerCase().startsWith(`${name}:`);
				const inline = line.slice(line.indexOf(":") + 1).trim();
				if (inside && inline) out.push(inline);
				continue;
			}
			if (inside && line.trim().startsWith("-")) out.push(line.replace(/^\s*-\s*/, "").trim());
		}
		return out;
	};
	const status = (section("status")[0] ?? "failure").trim();
	return {
		schemaVersion: RESULT_SCHEMA_VERSION,
		jobId,
		attemptId,
		status: ["success", "partial", "failure", "blocked"].includes(status) ? status : "failure",
		summary: section("summary")[0] ?? "",
		findings: section("findings").map((m) => ({ severity: "info", message: m })),
		changes: [],
		validation: emptyValidation(),
		artifacts: section("artifacts").map((a, i) => {
			const [p, ...desc] = a.split(":");
			return { id: `legacy-${i + 1}`, type: "file", path: p.trim(), size: 0, contentType: desc.join(":").trim() || undefined };
		}),
		blockers: section("blockers"),
		followUps: section("followups"),
		metrics: { legacyReport: true },
	};
}

export function extractResult(opts: {
	attemptDir: string;
	finalText: string;
	jobId: string;
	attemptId: string;
}): ExtractedResult {
	const { attemptDir, finalText, jobId, attemptId } = opts;
	const repairs: string[] = [];

	// 1. worker-written result.json (canonical path)
	const resultFile = path.join(attemptDir, "result.json");
	let candidate: unknown = null;
	let source: ExtractedResult["source"] = "synthetic";
	if (fs.existsSync(resultFile)) {
		try {
			candidate = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
			source = "file";
		} catch (e) {
			repairs.push(`result.json unreadable (${(e as Error).message}); falling back to message parsing`);
		}
	}

	// 2. fenced json block
	if (candidate === null) {
		const m = finalText.match(JSON_BLOCK_RE);
		if (m) {
			try {
				candidate = JSON.parse(m[1]);
				source = "json-block";
			} catch {
				repairs.push("```json block found but not parseable");
			}
		}
	}

	// 3. legacy markdown report block (backward compat with v1 workers)
	if (candidate === null) {
		const m = finalText.match(REPORT_BLOCK_RE);
		if (m) {
			candidate = fromLegacyReport(m[1], jobId, attemptId);
			source = "legacy-report";
			repairs.push("legacy markdown report mapped to schema v1");
		}
	}

	// 4. synthetic failure
	if (candidate === null) {
		candidate = {
			schemaVersion: RESULT_SCHEMA_VERSION,
			jobId,
			attemptId,
			status: "failure",
			summary: finalText.split("\n")[0]?.slice(0, 200) || "Worker produced no machine-readable result",
			findings: [],
			changes: [],
			validation: emptyValidation(),
			artifacts: [],
			blockers: ["Worker output did not follow the output contract (no result.json / json block)."],
			followUps: [],
			metrics: {},
		};
		repairs.push("no machine-readable result found → synthetic failure");
	}

	const normalized = normalizeJobResult(candidate, jobId, attemptId);
	return {
		result: normalized.result,
		source,
		repairs: [...repairs, ...normalized.repairs],
		rawFinalText: finalText,
	};
}

/** Persist the canonical result + rendered report for one attempt. */
export function persistAttemptResult(
	attemptDir: string,
	extracted: ExtractedResult,
	validationOverride?: ValidationOutcome,
): JobResult {
	const result: JobResult = validationOverride
		? { ...extracted.result, validation: validationOverride }
		: extracted.result;
	atomicWriteJson(path.join(attemptDir, "result.json"), result);
	atomicWriteText(path.join(attemptDir, "raw-output.txt"), extracted.rawFinalText);
	atomicWriteText(path.join(attemptDir, "report.md"), renderReportMd(result, extracted));
	return result;
}

/** Render report.md FROM result.json (§4: markdown is a view, not the protocol). */
export function renderReportMd(result: JobResult, extracted?: Pick<ExtractedResult, "source" | "repairs">): string {
	const lines: string[] = [];
	lines.push(`# Job ${result.jobId} — attempt ${result.attemptId}`);
	lines.push(``);
	lines.push(`**status:** ${result.status}  `);
	lines.push(`**summary:** ${result.summary || "(none)"}`);
	if (result.validation.status !== "skipped") lines.push(`**validation:** ${result.validation.status}`);
	if (result.findings.length) {
		lines.push(``, `## Findings`);
		for (const f of result.findings) lines.push(`- [${f.severity}]${f.code ? ` ${f.code}:` : ""} ${f.message}${f.evidence ? ` (${f.evidence})` : ""}`);
	}
	if (result.changes.length) {
		lines.push(``, `## Changes`);
		for (const c of result.changes) lines.push(`- ${c}`);
	}
	if (result.validation.checks.length) {
		lines.push(``, `## Validation`);
		for (const c of result.validation.checks) {
			lines.push(`- ${c.name}: ${c.status}${c.command ? ` \`${c.command}\`` : ""}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ""}${c.artifact ? ` → ${c.artifact}` : ""}`);
		}
	}
	if (result.artifacts.length) {
		lines.push(``, `## Artifacts`);
		for (const a of result.artifacts) lines.push(`- ${a.id} (${a.type}): ${a.path}${a.size ? ` [${a.size}B]` : ""}`);
	}
	if (result.blockers.length) {
		lines.push(``, `## Blockers`);
		for (const b of result.blockers) lines.push(`- ${b}`);
	}
	if (result.followUps.length) {
		lines.push(``, `## Follow-ups`);
		for (const f of result.followUps) lines.push(`- ${f}`);
	}
	if (Object.keys(result.metrics).length) {
		lines.push(``, `## Metrics`, "```json", JSON.stringify(result.metrics, null, 2), "```");
	}
	if (extracted && (extracted.source !== "file" || extracted.repairs.length)) {
		lines.push(``, `---`, `_result source: ${extracted.source}${extracted.repairs.length ? `; repairs: ${extracted.repairs.join("; ")}` : ""}_`);
	}
	return `${lines.join("\n")}\n`;
}

/** Compact orchestrator-facing summary (§26: never the full transcript). */
export function resultSummaryForOrchestrator(result: JobResult, attempt?: AttemptRecord | null): string {
	const parts: string[] = [`status: ${result.status}`];
	if (result.summary) parts.push(`summary: ${result.summary}`);
	if (result.validation.status !== "skipped") parts.push(`validation: ${result.validation.status}`);
	if (result.blockers.length) parts.push(`blockers: ${result.blockers.slice(0, 3).join(" | ")}`);
	if (result.followUps.length) parts.push(`followUps: ${result.followUps.slice(0, 3).join(" | ")}`);
	if (result.artifacts.length) parts.push(`artifacts: ${result.artifacts.map((a) => a.path).slice(0, 5).join(", ")}`);
	if (attempt?.usage) {
		const u = attempt.usage;
		parts.push(`usage: ${u.turns} turns, ↑${u.input} ↓${u.output}, $${u.costUsd.toFixed(4)}, ${((attempt.latencyMs ?? 0) / 1000).toFixed(1)}s`);
	}
	return parts.join("\n");
}
