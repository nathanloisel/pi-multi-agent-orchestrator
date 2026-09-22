#!/usr/bin/env node
/**
 * install-pi-test-version.mjs — create a "selected pi version" test overlay.
 *
 * The repository keeps a reproducible baseline lockfile (currently pi 0.85.1).
 * This script overlays node_modules with a DIFFERENT selected pi release
 * (e.g. 0.87.0 or 'latest') WITHOUT touching package.json / package-lock.json:
 *
 *     node scripts/install-pi-test-version.mjs 0.87.0
 *     npm run pi:test-version -- latest
 *
 * How it works:
 *   1. Resolves the requested version/tag against npm dist-tags.
 *   2. Reads the selected release's own `dependencies` and derives install
 *      specs for the orchestrator's declared peer packages (pi-ai, pi-tui,
 *      typebox) from THAT release — so peers match the selected pi instead of
 *      assuming all @earendil-works packages share one version (no root 0.85
 *      ai/tui paired with a nested 0.87 coding-agent).
 *   3. Runs ONE `npm install --no-save --package-lock=false` with the coding
 *      agent plus the matched peer specs. Manifest and lockfile stay on the
 *      reproducible baseline; `npm ci` restores it at any time.
 *
 * This is a test/validation tool only — it is NOT part of the production
 * runtime and adds no dependencies. Not run on CI as-is with 'latest' as an
 * allow-failure: an incompatible new pi must surface as a red canary.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describePlan, installSpecs, resolveInstallPlan, resolveVersion } from "./lib/pi-version-plan.mjs";

const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const CODING_AGENT = "@earendil-works/pi-coding-agent";

async function npmView(args) {
	try {
		const { stdout } = await execFileP(NPM, ["view", ...args, "--json"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 120_000,
		});
		const trimmed = stdout.trim();
		if (!trimmed) return null;
		return JSON.parse(trimmed);
	} catch (err) {
		const detail = [err.message, err.stderr?.trim()].filter(Boolean).join("\n");
		throw new Error(`npm view ${args.join(" ")} failed.\n${detail}`);
	}
}

async function main() {
	const requested = process.argv[2];
	if (!requested || process.argv.length > 3) {
		console.error("Usage: node scripts/install-pi-test-version.mjs <version | dist-tag>");
		console.error("Examples: 0.85.1 | 0.87.0 | latest");
		process.exit(2);
	}

	console.log(`[pi-version] resolving requested pi release '${requested}' ...`);
	const distTags = await npmView([CODING_AGENT, "dist-tags"]);
	if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
		throw new Error(`npm did not return dist-tags metadata for ${CODING_AGENT}.`);
	}

	// Resolve version first so dependency metadata can be fetched for exactly
	// that release (needed to match peer versions to the selected release).
	const version = resolveVersion({ requested, distTags });
	const deps = (await npmView([`${CODING_AGENT}@${version}`, "dependencies"])) ?? {};
	const plan = resolveInstallPlan({ requested, distTags, codingAgentDependencies: deps });

	console.log(`[pi-version] ${describePlan(plan)}`);

	const specs = installSpecs(plan);
	console.log(`[pi-version] installing overlay (manifest/lock untouched): npm install --no-save --package-lock=false ${specs.join(" ")}`);
	await execFileP(
		NPM,
		["install", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "--loglevel=error", ...specs],
		{ cwd: repoRoot, encoding: "utf8", timeout: 300_000 },
	);

	// Verify what actually landed in node_modules (never trust the request).
	const installedPkgPath = path.join(repoRoot, "node_modules", ...CODING_AGENT.split("/"), "package.json");
	const installed = JSON.parse(readFileSync(installedPkgPath, "utf8"));
	if (installed.version !== plan.codingAgent.version) {
		throw new Error(
			`Overlay verification failed: node_modules has ${CODING_AGENT}@${installed.version}, expected ${plan.codingAgent.version}.`,
		);
	}
	const peerLines = plan.peers.map((p) => {
		const peerPkgPath = path.join(repoRoot, "node_modules", ...p.name.split("/"), "package.json");
		const peerPkg = JSON.parse(readFileSync(peerPkgPath, "utf8"));
		return `  ${p.name}: ${peerPkg.version} (spec ${p.spec})`;
	});
	console.log(`[pi-version] installed for this test run: ${CODING_AGENT}@${installed.version}`);
	console.log(peerLines.join("\n"));
	console.log('[pi-version] note: manifest/lockfile still pin the reproducible baseline; run `npm ci` to restore it.');
}

main().catch((err) => {
	console.error(`[pi-version] ERROR: ${err.message}`);
	process.exit(1);
});
