/**
 * core/prompts.ts — the formal downstream envelope (§18) + output contract (§4).
 *
 * Deterministic, repetitive, explicit — optimized for cheap-model reliability,
 * not elegance. Sections are always present (empty sections say "none") so the
 * shape is identical across every job a worker sees.
 *
 * Also renders the orchestrator's own system prompt section (planner role,
 * tool surface, context discipline).
 */

import type { AgentConfig, ContextPack } from "./types.ts";
import { RESULT_SCHEMA_VERSION } from "./types.ts";

export interface EnvelopeInput {
	jobId: string;
	attemptId: string;
	agent: AgentConfig;
	task: string;
	pack: ContextPack;
	inlinedFiles: { path: string; content: string; truncated: boolean }[];
	constraints?: string[];
	workspaceDir: string;
	attemptDir: string;
	artifactsDir: string;
	validationCommands: string[];
	isFollowUp: boolean;
	resultPath: string; // where the worker must write result.json
}

export function outputContract(resultPath: string, artifactsDir: string): string {
	return `# OUTPUT CONTRACT

You MUST finish by writing a JSON file to exactly this path, using your file tools:

${resultPath}

Schema version: ${RESULT_SCHEMA_VERSION}. Shape (all fields required; empty arrays allowed):

{
  "schemaVersion": ${RESULT_SCHEMA_VERSION},
  "jobId": "<job id>",
  "attemptId": "<attempt id>",
  "status": "success" | "partial" | "failure" | "blocked",
  "summary": "<one line: what was accomplished>",
  "findings": [ { "severity": "info|warning|error", "code": "<SHORT_CODE>", "message": "<fact>", "evidence": "<path:line or command output snippet>" } ],
  "changes": [ "<path of each file you changed>" ],
  "validation": { "status": "passed|failed|skipped", "checks": [ { "name": "...", "status": "...", "command": "..." } ] },
  "artifacts": [ { "id": "<short-id>", "type": "git-diff|log|file|data|image", "path": "<relative to artifacts dir>", "size": <bytes> } ],
  "blockers": [ "<only when blocked/failure>" ],
  "followUps": [ "<suggested next steps>" ],
  "metrics": {}
}

Hard rules:
- Write result.json BEFORE your final message. Your final chat message must be
  one short line: the status and a one-sentence summary. Nothing else.
- NEVER paste large content (file bodies, logs, diffs, transcripts) into
  result.json fields or your final message. Write it to a file under
  ${artifactsDir}
  and reference it in "artifacts" with its relative path.
- "changes" lists repository paths you modified; the orchestrator collects the
  diff itself.
- Host-side deterministic validation may re-run commands after you finish; your
  self-reported "validation" does not replace it. Be honest: never claim success
  you did not verify.
- Do not include hidden reasoning traces. Only summaries, decisions, findings,
  evidence, artifacts.`;
}

export function renderEnvelope(i: EnvelopeInput): string {
	const sect = (name: string, body: string) => `# ${name}\n\n${body.trim() || "none"}\n`;
	const list = (items?: string[]) => (items && items.length ? items.map((x) => `- ${x}`).join("\n") : "none");

	const filesSection = i.inlinedFiles.length
		? i.inlinedFiles.map((f) => `## ${f.path}${f.truncated ? " (truncated)" : ""}\n\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")
		: "none inlined — use your tools to read the relevant files listed above";

	const prev = i.pack.previousFailure
		? [
				`Previous attempt ${i.pack.previousFailure.attemptId} did not succeed.`,
				`Summary: ${i.pack.previousFailure.summary}`,
				i.pack.previousFailure.validation && i.pack.previousFailure.validation.status !== "skipped"
					? `Validation: ${i.pack.previousFailure.validation.status}\n${i.pack.previousFailure.validation.checks
							.map((c) => `- ${c.command ?? c.name}: ${c.status}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ""}${c.message ? ` — ${c.message}` : ""}`)
							.join("\n")}`
					: "",
				i.pack.previousFailure.selectedArtifacts?.length
					? `Selected artifacts from previous attempt: ${i.pack.previousFailure.selectedArtifacts.join(", ")}`
					: "",
			]
				.filter(Boolean)
				.join("\n")
		: "";

	return [
		i.isFollowUp
			? sect(
					"FOLLOW-UP",
					"This is a FOLLOW-UP message in your existing session. You already have the original task and your prior work in context. Address the new instruction below, update result.json at the path given in OUTPUT CONTRACT, then reply with one short line.",
				)
			: "",
		sect("ROLE", i.agent.description || i.agent.name),
		sect("JOB", `jobId: ${i.jobId}\nattemptId: ${i.attemptId}`),
		sect("TASK", i.task),
		sect(
			"CONTEXT",
			[
				i.pack.background ? `Background: ${i.pack.background}` : "",
				i.pack.relevantFiles?.length ? `Relevant files:\n${list(i.pack.relevantFiles)}` : "",
				i.pack.relevantSymbols?.length ? `Relevant symbols:\n${list(i.pack.relevantSymbols)}` : "",
				prev,
				"\n## Inlined files\n\n" + filesSection,
			]
				.filter(Boolean)
				.join("\n"),
		),
		sect("CONSTRAINTS", list([...(i.agent.context.mode === "none" ? [] : []), ...(i.constraints ?? []), ...(i.pack.constraints ?? [])])),
		sect("ACCEPTANCE CRITERIA", list(i.pack.acceptance)),
		sect("WORKSPACE", `Work in: ${i.workspaceDir}\nAll paths are relative to this directory unless absolute.`),
		sect("ARTIFACT DIRECTORY", `Write all large outputs (logs, extracted data, generated files) under:\n${i.artifactsDir}`),
		sect(
			"VALIDATION",
			i.validationCommands.length
				? `After finishing your changes, run these commands yourself and make them pass:\n${i.validationCommands.map((c) => `- ${c}`).join("\n")}\nThe orchestrator will ALSO run them host-side. Failing validation = failed attempt.`
				: "No host-side validation configured. Verify your work as appropriate and record what you verified in result.json.",
		),
		sect("OUTPUT CONTRACT", outputContract(i.resultPath, i.artifactsDir).replace("# OUTPUT CONTRACT\n\n", "")),
	]
		.filter(Boolean)
		.join("\n");
}

export function orchestratorPrompt(opts: {
	mainInstructions?: string;
	roster: string;
	aliases: string;
}): string {
	return `# Orchestrator role (enforced by the orchestrator extension)

You are the ORCHESTRATOR: a frontier planning agent. You do NOT execute anything yourself.
All implementation tools are disabled; attempts to call them are blocked. Your tools:

- delegate: create jobs (single / parallel batch / chain with dependencies) or follow up on a job
- jobs: list | status | read | artifact | graph | retry | followup | cancel | wait | events

## Execution model
- Every delegation creates a persistent JOB with a unique jobId. Each execution of a
  job is an ATTEMPT (own model, session, workspace, validation, result.json).
- Workers run on interchangeable backends via logical model aliases (see registry
  below). You never pick concrete provider models; routing decides, and you may
  request a stronger alias (worker-best, frontier) explicitly on retry when justified.
- Workers finish by writing a validated result.json. You receive only: status,
  summary, validation status, blockers, artifact references, usage. Pull details
  with jobs.read / jobs.artifact ONLY when needed.
- Failed validation triggers the retry ladder automatically when the job was
  created with retry enabled: cheap fresh retry with failure feedback → stronger
  worker → frontier. Deterministic feedback first; do not jump to frontier models.

## Your job
1. Decompose the request into small, self-contained jobs a focused cheap model can
   execute without ambiguity. State dependencies so independent jobs run in parallel.
2. For every job write: task (exact paths/symbols/commands/acceptance criteria),
   context (relevantFiles, relevantSymbols, constraints, acceptance, background —
   workers cannot see this conversation).
3. Choose the agent whose role matches the task. Route by role, not by model name.
4. Inspect returned summaries. Verify validation status. On partial/blocked/failed:
   prefer jobs.followup (cheap, resumes worker session) for small corrections, or
   jobs.retry strategy=fresh (optionally with a stronger model alias) when the
   worker is trapped in a bad path.
5. Synthesize the final answer yourself from job summaries and selective reads.

## Context discipline
- Never ask for full transcripts or logs into your context; use artifact references.
- One job = one clear outcome. Keep summaries flowing, details on disk.

## Agent roster
${opts.roster}

## Model aliases (registry)
${opts.aliases}
${opts.mainInstructions ? `\n## Additional orchestrator instructions\n${opts.mainInstructions}` : ""}`;
}

export function rosterText(agents: AgentConfig[]): string {
	const subs = agents.filter((a) => a.role === "sub");
	if (subs.length === 0) return "(no sub agents configured — create ~/.pi/agents/<name>/AGENT.md)";
	return subs
		.map((a) => {
			const bits = [a.name];
			bits.push(`model:${a.runtime.model ?? a.runtime.provider ?? "default"}`);
			if (a.runtime.effort) bits.push(`effort:${a.runtime.effort}`);
			if (a.capabilities?.length) bits.push(`tools:[${a.capabilities.join(",")}]`);
			if (a.validation.commands?.length) bits.push(`validates:[${a.validation.commands.join(" && ")}]`);
			if (a.workspace.strategy === "git-worktree") bits.push("worktree");
			return `- ${bits.join(" ")} — ${a.description}`;
		})
		.join("\n");
}
