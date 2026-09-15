/**
 * tests/scaffold.test.ts — deterministic tests for /orchestrator-init
 * scaffolding behavior (core/scaffold.ts).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse as yamlParse } from "yaml";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_SCAFFOLD_TARGETS,
	resolveWithin,
	scaffoldOrchestratorFiles,
} from "../core/scaffold.ts";

const packageTemplatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

function tempPiRoot(): { root: string; agentDir: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-scaffold-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	return { root, agentDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("scaffold", () => {
	it("clean PI agent dir creates the expected template files", () => {
		const { root, agentDir, cleanup } = tempPiRoot();
		try {
			const result = scaffoldOrchestratorFiles({ agentDir, templatesDir: packageTemplatesDir });
			assert.equal(result.created.length, DEFAULT_SCAFFOLD_TARGETS.length);
			assert.equal(result.skipped.length, 0);
			for (const target of DEFAULT_SCAFFOLD_TARGETS) {
				const file = path.join(root, target.target);
				assert.ok(fs.existsSync(file), `missing ${target.target}`);
				assert.ok(fs.statSync(file).isFile());
			}
			// Contents come from the bundled templates (no local paths, no secrets).
			const config = fs.readFileSync(path.join(root, "orchestrator/config.yaml"), "utf-8");
			for (const section of ["concurrency", "budgets", "routing"]) {
				assert.match(config, new RegExp(`^${section}:`, "m"), `scaffolded config should configure ${section}`);
			}
			const models = yamlParse(fs.readFileSync(path.join(root, "orchestrator/models.yaml"), "utf-8")) as {
				models: Record<string, { provider: string; model: string }>;
				defaults: { worker: string };
			};
			assert.ok(models.models["worker-cheap"]?.provider);
			assert.ok(models.models["worker-best"]?.model);
			assert.ok(models.models["frontier"]?.model);
			assert.equal(models.defaults.worker, "worker-cheap");
			for (const name of ["coder", "researcher", "vision"]) {
				const raw = fs.readFileSync(path.join(root, "agents", name, "AGENT.md"), "utf-8");
				const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
				assert.equal(frontmatter?.name, name);
				assert.equal(frontmatter?.role, "sub");
				assert.ok(String(frontmatter?.runtime && (frontmatter.runtime as Record<string, unknown>).model));
			}
		} finally {
			cleanup();
		}
	});

	it("second run is idempotent: everything skipped, files unchanged", () => {
		const { root, agentDir, cleanup } = tempPiRoot();
		try {
			scaffoldOrchestratorFiles({ agentDir, templatesDir: packageTemplatesDir });
			const before = new Map<string, { content: string; mtimeMs: number }>();
			for (const target of DEFAULT_SCAFFOLD_TARGETS) {
				const file = path.join(root, target.target);
				before.set(target.target, { content: fs.readFileSync(file, "utf-8"), mtimeMs: fs.statSync(file).mtimeMs });
			}
			const second = scaffoldOrchestratorFiles({ agentDir, templatesDir: packageTemplatesDir });
			assert.equal(second.created.length, 0);
			assert.deepEqual(second.skipped.sort(), DEFAULT_SCAFFOLD_TARGETS.map((t) => t.target).sort());
			for (const target of DEFAULT_SCAFFOLD_TARGETS) {
				const file = path.join(root, target.target);
				assert.equal(fs.readFileSync(file, "utf-8"), before.get(target.target)!.content);
				assert.equal(fs.statSync(file).mtimeMs, before.get(target.target)!.mtimeMs);
			}
		} finally {
			cleanup();
		}
	});

	it("existing custom files are never overwritten", () => {
		const { root, agentDir, cleanup } = tempPiRoot();
		try {
			const customConfig = "# my hand-tuned config\nconcurrency:\n  global: 2\n";
			const customAgent = "---\nname: my-coder\nrole: sub\n---\nCustom instructions.\n";
			fs.mkdirSync(path.join(root, "orchestrator"), { recursive: true });
			fs.mkdirSync(path.join(root, "agents", "coder"), { recursive: true });
			fs.writeFileSync(path.join(root, "orchestrator/config.yaml"), customConfig);
			fs.writeFileSync(path.join(root, "agents/coder/AGENT.md"), customAgent);
			const result = scaffoldOrchestratorFiles({ agentDir, templatesDir: packageTemplatesDir });
			assert.ok(result.skipped.includes("orchestrator/config.yaml"));
			assert.ok(result.skipped.includes("agents/coder/AGENT.md"));
			assert.ok(!result.created.includes("orchestrator/config.yaml"));
			assert.ok(!result.created.includes("agents/coder/AGENT.md"));
			assert.equal(fs.readFileSync(path.join(root, "orchestrator/config.yaml"), "utf-8"), customConfig);
			assert.equal(fs.readFileSync(path.join(root, "agents/coder/AGENT.md"), "utf-8"), customAgent);
		} finally {
			cleanup();
		}
	});

	it("rejects paths that would escape their root", () => {
		const base = os.tmpdir();
		assert.throws(() => resolveWithin(base, "../outside"));
		assert.throws(() => resolveWithin(base, "a/../../outside"));
		assert.throws(() => resolveWithin(base, path.join(base, "abs")));
		assert.throws(() => resolveWithin(base, ""));
		// benign relative paths stay inside
		const resolved = resolveWithin(base, "sub/dir/file.yaml");
		assert.ok(resolved.startsWith(path.resolve(base) + path.sep));
	});

	it("creates directories with private permissions where the OS supports it", () => {
		if (process.platform === "win32") return; // POSIX-only assertion
		const { root, agentDir, cleanup } = tempPiRoot();
		try {
			scaffoldOrchestratorFiles({ agentDir, templatesDir: packageTemplatesDir });
			const orchDir = fs.statSync(path.join(root, "orchestrator"));
			const agentProfileDir = fs.statSync(path.join(root, "agents", "coder"));
			assert.equal(orchDir.mode & 0o777, 0o700, "orchestrator dir should be 0700");
			assert.equal(agentProfileDir.mode & 0o777, 0o700, "agent profile dir should be 0700");
			const fileMode = fs.statSync(path.join(root, "orchestrator", "config.yaml")).mode & 0o777;
			assert.equal(fileMode, 0o600, "scaffolded file should be 0600");
		} finally {
			cleanup();
		}
	});
});
