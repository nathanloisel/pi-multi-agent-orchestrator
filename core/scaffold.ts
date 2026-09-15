/**
 * core/scaffold.ts — /orchestrator-init implementation (testable, UI-free).
 *
 * Copies versioned templates from the package's templates/ directory into the
 * user's Pi configuration:
 *
 *   ~/.pi/orchestrator/config.yaml
 *   ~/.pi/orchestrator/models.yaml
 *   ~/.pi/agents/<name>/AGENT.md        (coder, researcher, vision)
 *
 * Guarantees:
 *   - NEVER overwrites existing files (idempotent).
 *   - Directories are created with 0700, files written with 0600 where the OS
 *     supports POSIX permissions (best-effort, never fatal).
 *   - Template paths are validated so they cannot escape their roots.
 *   - Copies only the bundled templates — never reads or copies user secrets.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ScaffoldTarget {
	/** Template path relative to templates/ (e.g. "orchestrator/config.yaml"). */
	template: string;
	/** Destination path relative to the Pi agent dir (e.g. "orchestrator/config.yaml"). */
	target: string;
}

export interface ScaffoldOptions {
	/** Pi agent dir (getAgentDir()). Targets resolve against its parent (~/.pi). */
	agentDir: string;
	/** Templates root; defaults to <package>/templates. */
	templatesDir?: string;
	/** Explicit targets; defaults to the standard template set. */
	targets?: ScaffoldTarget[];
}

export interface ScaffoldResult {
	created: string[];
	skipped: string[];
	/** Human-readable next steps (provider auth, /reload). */
	nextSteps: string[];
}

/** Standard scaffold set: orchestrator config + generic agent profiles. */
export const DEFAULT_SCAFFOLD_TARGETS: ScaffoldTarget[] = [
	{ template: "orchestrator/config.yaml", target: "orchestrator/config.yaml" },
	{ template: "orchestrator/models.yaml", target: "orchestrator/models.yaml" },
	{ template: "agents/coder/AGENT.md", target: "agents/coder/AGENT.md" },
	{ template: "agents/researcher/AGENT.md", target: "agents/researcher/AGENT.md" },
	{ template: "agents/vision/AGENT.md", target: "agents/vision/AGENT.md" },
];

const NEXT_STEPS = [
	"1. Edit ~/.pi/orchestrator/models.yaml — set model IDs available on your provider and export the matching API key environment variables (never put tokens in the file).",
	"2. Edit the agent profiles in ~/.pi/agents/*/AGENT.md to match your projects.",
	"3. Run /reload in Pi so the orchestrator picks up the new configuration.",
];

/**
 * Resolve `rel` inside `base`, rejecting anything that escapes it
 * (absolute paths, "..", symlink-unsafe traversal). Throws on violation.
 */
export function resolveWithin(base: string, rel: string): string {
	if (typeof rel !== "string" || rel.length === 0) throw new Error("empty path segment");
	if (path.isAbsolute(rel)) throw new Error(`absolute path not allowed: ${rel}`);
	const resolved = path.resolve(base, rel);
	const normalizedBase = path.resolve(base);
	if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
		throw new Error(`path escapes ${normalizedBase}: ${rel}`);
	}
	return resolved;
}

function applyPrivateMode(p: string, mode: number): void {
	try {
		fs.chmodSync(p, mode);
	} catch {
		/* not portable (e.g. Windows) — ignore */
	}
}

function copyTemplate(templatesDir: string, target: ScaffoldTarget, base: string, result: ScaffoldResult): void {
	const source = resolveWithin(templatesDir, target.template);
	const destination = resolveWithin(base, target.target);

	if (fs.existsSync(destination)) {
		result.skipped.push(target.target);
		return;
	}
	if (!fs.existsSync(source)) throw new Error(`bundled template missing: ${target.template}`);

	const destDir = path.dirname(destination);
	fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
	applyPrivateMode(destDir, 0o700);
	fs.copyFileSync(source, destination);
	applyPrivateMode(destination, 0o600);
	result.created.push(target.target);
}

/**
 * Scaffold orchestrator config and agent profile templates. Idempotent and
 * non-destructive: existing files are always skipped, never overwritten.
 */
export function scaffoldOrchestratorFiles(opts: ScaffoldOptions): ScaffoldResult {
	const result: ScaffoldResult = { created: [], skipped: [], nextSteps: NEXT_STEPS };
	const piRoot = path.dirname(path.resolve(opts.agentDir));
	const templatesDir = opts.templatesDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
	for (const target of opts.targets ?? DEFAULT_SCAFFOLD_TARGETS) {
		copyTemplate(templatesDir, target, piRoot, result);
	}
	return result;
}
