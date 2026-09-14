/**
 * core/context.ts — explicit, serializable context packs (§19).
 *
 * Workers receive the MINIMUM useful context. Packs are persisted as
 * context.json in the job (initial) or attempt (fresh retry) directory so any
 * attempt is reproducible from disk alone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentContextPolicy, ContextPack } from "./types.ts";

export interface BuildContextOpts {
	objective: string;
	context?: Partial<ContextPack>;
	agentContext: AgentContextPolicy;
	workspaceDir: string;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

export interface BuiltContext {
	pack: ContextPack;
	/** File contents inlined into the envelope (small, explicitly selected files only). */
	inlinedFiles: { path: string; content: string; truncated: boolean }[];
	totalBytes: number;
}

const DEFAULT_MAX_FILE_BYTES = 16 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024;

/**
 * Assemble the pack. Agent-declared context files (frontmatter
 * context.files) are read from the workspace and inlined when small;
 * orchestrator-provided pack fields (relevantFiles/symbols/constraints/
 * acceptance/background) are passed through structurally — the worker reads
 * full files itself with its tools (cheaper than inlining everything).
 */
export function buildContextPack(opts: BuildContextOpts): BuiltContext {
	const pack: ContextPack = {
		objective: opts.objective,
		relevantFiles: opts.context?.relevantFiles,
		relevantSymbols: opts.context?.relevantSymbols,
		constraints: opts.context?.constraints,
		acceptance: opts.context?.acceptance,
		background: opts.context?.background,
		previousFailure: opts.context?.previousFailure,
	};

	const inlined: BuiltContext["inlinedFiles"] = [];
	let total = 0;
	const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

	if (opts.agentContext.mode !== "none") {
		for (const rel of opts.agentContext.files ?? []) {
			if (total >= maxTotal) break;
			const full = path.resolve(opts.workspaceDir, rel.replace(/^[/@]+/, ""));
			if (!full.startsWith(path.resolve(opts.workspaceDir))) continue; // traversal guard (§30)
			try {
				const stat = fs.statSync(full);
				if (!stat.isFile() || stat.size > maxFile * 4) continue;
				let content = fs.readFileSync(full, "utf-8");
				const truncated = content.length > maxFile;
				if (truncated) content = `${content.slice(0, maxFile)}\n[truncated]`;
				inlined.push({ path: rel, content, truncated });
				total += content.length;
			} catch {
				/* missing context files are not fatal */
			}
		}
	}

	return { pack, inlinedFiles: inlined, totalBytes: total };
}
