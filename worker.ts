/**
 * Orchestrator worker hooks — loaded INSIDE each sub agent process
 * (via `pi -e worker.ts`). Never loads into the main process.
 *
 * Responsibilities:
 *  1. Enforce the sub agent's dedicated tool policy (from AGENT.md `tools:`),
 *     as a hard block on top of the `--tools` allowlist.
 *  2. Prevent recursion: a sub agent can never call delegate/jobs.
 *  3. Apply the agent's dedicated tool allowlist passed via env.
 *
 * Report-contract enforcement (missing ```report block) is handled by the
 * runner in the main process via one deterministic follow-up nudge.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ORCHESTRATOR_TOOLS = new Set(["delegate", "jobs", "subagent"]);

export default function (pi: ExtensionAPI) {
	if (!process.env.PI_ORCHESTRATOR_SUBAGENT) return; // main process: do nothing

	const allowed = (process.env.PI_ORCHESTRATOR_ALLOWED_TOOLS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const allowSet = new Set(allowed);

	pi.on("session_start", async (_event, ctx) => {
		if (allowSet.size > 0) {
			const active = pi.getActiveTools().filter((name) => allowSet.has(name) && !ORCHESTRATOR_TOOLS.has(name));
			pi.setActiveTools(active);
		} else {
			// No explicit policy: still strip orchestrator tools if present.
			pi.setActiveTools(pi.getActiveTools().filter((name) => !ORCHESTRATOR_TOOLS.has(name)));
		}
		ctx.ui.setStatus?.("orchestrator-worker", `job:${process.env.PI_ORCHESTRATOR_JOB_ID ?? "?"}`);
	});

	pi.on("tool_call", async (event) => {
		if (ORCHESTRATOR_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Recursion blocked: sub agents cannot delegate. Complete the task yourself and report back via the report contract.",
			};
		}
		if (allowSet.size > 0 && !allowSet.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool "${event.toolName}" is not allowed for this agent. Allowed tools: ${[...allowSet].join(", ")}.`,
			};
		}
	});
}
