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

describe("orchestratorPrompt — structured plan contract", () => {
	it("mandates publishing jobs action=plan before the first delegate", () => {
		assert.match(prompt, /`jobs action=plan` BEFORE the first\s*\n`delegate` call/);
		assert.match(prompt, /publish the same steps via\s*\n\s*`jobs action=plan` BEFORE the first `delegate`/);
	});

	it("requires clear human-readable titles and stable step ids equal to the delegate alias", () => {
		assert.match(prompt, /clear human-readable `title`/);
		assert.match(prompt, /SAME value for the step id\s*\n\s*and the delegate job alias/);
	});

	it("requires revisions to retain omitted steps and advance declared status", () => {
		assert.match(prompt, /omitted steps are\s*\n\s*retained verbatim/);
		assert.match(prompt, /revision\s*\n\s*number increments/);
		assert.match(prompt, /Never mark a step `completed` before its\s*\n\s*job returned a validated, passing result/);
	});

	it("adds plan to the jobs tool surface", () => {
		assert.match(prompt, /^- jobs: list \| status.*\| plan$/m);
	});
});

describe("orchestratorPrompt — clarification policy for consequential ambiguity", () => {
	it("places the clarification policy between 'Your job' and the structured plan", () => {
		const job = prompt.indexOf("## Your job");
		const clarify = prompt.indexOf("## Clarify before consequential ambiguity");
		const plan = prompt.indexOf("## Structured plan");
		assert.ok(job >= 0 && clarify > job && plan > clarify, `section order job=${job} clarify=${clarify} plan=${plan}`);
	});

	it("triggers one targeted question only for genuinely blocking ambiguity", () => {
		assert.match(prompt, /Not every request is straightforward\./);
		assert.match(prompt, /Ask ONE concise question, only for a genuinely blocking choice/);
		assert.match(prompt, /different interpretations affect requested behavior, scope, architecture, UX,\s*\n\s*compatibility, persistence, or a destructive choice/);
	});

	it("requires read-only discovery of existing behavior before ambiguous modification", () => {
		assert.match(prompt, /If the uncertainty can be resolved by inspecting the code,\s*\n\s*do that read-only research before asking/);
		assert.match(prompt, /If the requested capability already exists, or partly\s*\n\s*exists, explain what is already there before editing/);
	});

	it("allows read-only research but blocks implementation and code/config changes until an answer", () => {
		assert.match(prompt, /While a question is unanswered, reads,\s*\n\s*searches, and `jobs` inspection are allowed; delegating implementation or changing\s*\n\s*code\/config is not/);
	});

	it("forbids silently choosing the broader interpretation or presenting inferred design as approved", () => {
		assert.match(prompt, /Do not silently pick\s*\n\s*the broader interpretation or present an inferred design as already approved/);
	});

	it("carries the confirmed decision into worker context and acceptance", () => {
		assert.match(prompt, /Put the confirmed decision into the worker's context and\s*\n\s*acceptance criteria/);
	});

	it("does not over-question explicit choices, routine details, bug fixes, or code-inferable facts", () => {
		assert.match(prompt, /Skip the question when the user already chose explicitly, for routine\s*\n\s*local implementation details, for straightforward bug fixes, or for details safely\s*\n\s*inferable from the code/);
		assert.match(prompt, /stop speculative scope\s*\n\s*expansion and surface the question instead/);
	});

	it("includes the alias vs concrete-model example and the confirmed 'both' path", () => {
		assert.match(prompt, /the user asks for "the model" in a header that already shows an alias\./);
		assert.match(prompt, /keep the\s*\n\s*alias \/ show the concrete model \/ show both/);
		assert.match(prompt, /If the user answers "both", proceed without repeating it\./);
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
