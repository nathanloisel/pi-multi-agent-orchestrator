/**
 * Tests: orchestrator main-agent visible-output contract (§ orchestratorPrompt).
 *
 * Verifies that orchestratorPrompt injects the concise user-visible progress
 * contract (short numbered Plan, "Now:" delegation updates, explicit
 * "Plan update:" deltas only, stable step labels, no premature completion,
 * no filler) while preserving the enforced role, delegation requirements, and
 * context-discipline rules, plus roster/alias/mainInstructions interpolation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orchestratorPrompt, renderEnvelope } from "../core/prompts.ts";
import type { ContextPack } from "../core/types.ts";

const BASE_OPTS = {
	roster: "- coder model:worker-cheap tools:[read,edit,bash] — implements code changes",
	aliases: "- worker-cheap → openrouter/test/cheap",
};

const prompt = orchestratorPrompt(BASE_OPTS);

describe("orchestratorPrompt — user-visible progress contract", () => {
	it("mandates a short numbered Plan for multi-step work and forbids ceremony on trivial requests", () => {
		assert.match(prompt, /short numbered Plan/);
		assert.match(prompt, /Trivial single-step requests:\s*\n\s*no plan, no headings/);
	});

	it("frames messages as complementing the live progress display, not the only channel", () => {
		assert.match(prompt, /A live progress display already shows tool calls and job state in real time;/);
		assert.match(prompt, /never repeat what it already makes visible/);
		assert.doesNotMatch(prompt, /only thing the user sees/);
	});

	it("limits Now updates to meaningful execution transitions and allows skipping when the live display shows it", () => {
		assert.match(prompt, /"Now:" only at meaningful execution transitions/);
		assert.match(prompt, /Skip it when the live display already makes/);
		assert.match(prompt, /naming the concrete job\(s\) and/);
		assert.doesNotMatch(prompt, /When you delegate or act, emit/);
	});

	it("restricts Plan updates to real deltas (add/remove/reorder/replace/blocker) with a reason", () => {
		assert.match(prompt, /"Plan update:" ONLY when steps are added, removed, reordered, replaced/);
		assert.match(prompt, /with a one-line reason/);
	});

	it("forbids re-printing the entire plan on every tool call or delegation", () => {
		assert.match(prompt, /Never re-print\s*\n\s*the whole plan on every tool call or delegation/);
	});

	it("requires stable step labels and that terminal states never disappear", () => {
		assert.match(prompt, /Keep step labels\/numbering stable across updates/);
		assert.match(prompt, /never quietly\s*\n\s*disappear/);
	});

	it("requires planned vs running distinction and individually identifiable parallel job labels", () => {
		assert.match(prompt, /Distinguish planned vs running steps/);
		assert.match(prompt, /every parallel job keeps\s*\n\s*its own identifiable label \(one line listing them is fine\)/);
		assert.doesNotMatch(prompt, /never collapse concurrent work/);
	});

	it("forbids claiming completion before a validated result", () => {
		assert.match(prompt, /Never claim a step is done before its job returned a validated result/);
		assert.match(prompt, /validation passed, not merely a worker's claim/);
	});

	it("requires plain partial/blocked/failure reporting with the next action", () => {
		assert.match(prompt, /Report partial, blocked,\s*\n\s*or failed outcomes plainly/);
		assert.match(prompt, /followup \/ retry \/s*\n?\s*escalate/);
	});

	it("bans filler, praise, tool-narration, and speculative promises", () => {
		assert.match(prompt, /Banned: filler \("I'll dive in", "great question"\), praise, retrospective\s*\n\s*narration of tool internals, speculative promises/);
	});

	it("constrains the final answer to outcome, paths, and real validation results", () => {
		assert.match(prompt, /Final answer: outcome, relevant paths, actual validation results or\s*\n\s*blockers/);
	});

	it("includes a concrete plan → execution → changed-plan example", () => {
		assert.match(prompt, /Example \(plan then a changed plan mid-flight\)/);
		assert.match(prompt, /Plan update: adding bench-j3/);
	});
});

describe("orchestratorPrompt — preserved role, delegation, and context rules", () => {
	it("keeps the enforced planner role and hard tool lockdown", () => {
		assert.match(prompt, /You are the ORCHESTRATOR/);
		assert.match(prompt, /You do NOT execute anything yourself\./);
		assert.match(prompt, /attempts to call them are blocked/);
	});

	it("keeps the delegate/jobs tool surface", () => {
		assert.match(prompt, /^- delegate: create jobs/m);
		assert.match(prompt, /^- jobs: list \| status/m);
	});

	it("keeps the 5-step job workflow including decomposition, context packing, and synthesis", () => {
		assert.match(prompt, /Decompose the request into small, self-contained jobs/);
		assert.match(prompt, /workers cannot see this conversation/);
		assert.match(prompt, /Synthesize the final answer yourself from job summaries/);
	});

	it("keeps context-discipline and retry-ladder guidance", () => {
		assert.match(prompt, /Never ask for full transcripts or logs into your context/);
		assert.match(prompt, /retry ladder automatically/);
	});

	it("interpolates roster, aliases, and additional main instructions", () => {
		assert.ok(prompt.includes(BASE_OPTS.roster));
		assert.ok(prompt.includes(BASE_OPTS.aliases));
		const withMain = orchestratorPrompt({ ...BASE_OPTS, mainInstructions: "Always answer in French." });
		assert.match(withMain, /## Additional orchestrator instructions\s*\nAlways answer in French\./);
	});
});

describe("orchestratorPrompt — envelope untouched by the output-contract change", () => {
	it("renderEnvelope still renders all canonical sections for workers", () => {
		const pack = { background: "b", relevantFiles: ["a.ts"], relevantSymbols: [], acceptance: ["works"], inlinedFiles: [], constraints: [] } as unknown as ContextPack;
		const env = renderEnvelope({
			jobId: "j1",
			attemptId: "attempt-001",
			agent: { name: "coder", description: "codes", role: "sub", runtime: {}, context: { mode: "none" }, workspace: { strategy: "cwd" } } as never,
			task: "do the thing",
			pack,
			inlinedFiles: [],
			workspaceDir: "/ws",
			attemptDir: "/ws/.attempts/attempt-001",
			artifactsDir: "/ws/.attempts/attempt-001/artifacts",
			validationCommands: ["npm test"],
			isFollowUp: false,
			resultPath: "/ws/.attempts/attempt-001/result.json",
		});
		for (const section of ["# ROLE", "# JOB", "# TASK", "# CONTEXT", "# CONSTRAINTS", "# ACCEPTANCE CRITERIA", "# WORKSPACE", "# ARTIFACT DIRECTORY", "# VALIDATION", "# OUTPUT CONTRACT"]) {
			assert.ok(env.includes(section), `missing section ${section}`);
		}
		assert.ok(env.includes("Write result.json BEFORE your final message"));
	});
});
