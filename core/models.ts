/**
 * core/models.ts — the model registry: logical alias → concrete backend (§1, §2, §3, §10).
 *
 * This is the ONLY place concrete provider/model identifiers exist. Everything
 * above (agents, jobs, attempts, routing, retry ladders, orchestrator prompts)
 * speaks in logical aliases: worker-cheap, worker-best, frontier, ...
 *
 * Registry file: ~/.pi/orchestrator/models.yaml (or .json):
 *
 *   models:
 *     worker-cheap:
 *       provider: openrouter
 *       model: <configured-cheap-model-id>
 *     worker-best:
 *       provider: openrouter
 *       model: <configured-stronger-model-id>
 *     frontier:
 *       provider: anthropic
 *       model: claude-opus-4-8
 *     local-worker:            # future: local inference, config-only change
 *       provider: local-openai-compatible
 *       model: swift-qwen-27b
 *       baseUrl: http://gpu-server:8080/v1
 *       apiKeyEnv: LOCAL_LLM_KEY
 *
 *   defaults:
 *     worker: worker-cheap
 *
 * Custom providers (e.g. local-openai-compatible) are registered with pi via
 * `providers` (same shape as pi.registerProvider's config form) — the extension
 * calls registry.providerRegistrations() once at session_start.
 *
 * Execution stays inside the pi harness: resolution produces pi CLI launch
 * config (--model, --thinking, env). No parallel HTTP stack, no leaked
 * provider-specific behavior in job logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import type { ConcreteModelConfig, ResolvedModel } from "./types.ts";

export interface ProviderRegistration {
	name: string;
	config: ProviderConfig;
}

export interface RegistryFile {
	models?: Record<string, ConcreteModelConfig & { effort?: string }>;
	defaults?: { worker?: string; frontier?: string };
	providers?: Record<string, Record<string, unknown>>;
}

export interface LaunchConfig {
	args: string[]; // pi CLI args: --model ..., --thinking ...
	env: Record<string, string>; // extra env for the subprocess
	resolved: ResolvedModel;
}

export class ModelRegistry {
	private models = new Map<string, ConcreteModelConfig>();
	private providerRegs = new Map<string, ProviderConfig>();
	private defaultWorker = "worker-cheap";
	readonly fileUsed: string | null;
	readonly diagnostics: string[] = [];

	constructor(private readonly orchestratorDir: string) {
		this.fileUsed = this.load();
	}

	private load(): string | null {
		for (const name of ["models.yaml", "models.yml", "models.json"]) {
			const file = path.join(this.orchestratorDir, name);
			if (!fs.existsSync(file)) continue;
			try {
				const raw = fs.readFileSync(file, "utf-8");
				const parsed = name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
				this.apply(parsed as RegistryFile, file);
				return file;
			} catch (e) {
				this.diagnostics.push(`models registry ${name} failed to load: ${(e as Error).message}`);
			}
		}
		return null;
	}

	private apply(reg: RegistryFile, file: string): void {
		for (const [alias, cfg] of Object.entries(reg.models ?? {})) {
			if (!cfg || typeof cfg !== "object" || !cfg.provider || !cfg.model) {
				this.diagnostics.push(`models: alias "${alias}" in ${file} lacks provider/model — skipped`);
				continue;
			}
			this.models.set(alias, { ...cfg });
		}
		for (const [name, cfg] of Object.entries(reg.providers ?? {})) {
			this.providerRegs.set(name, cfg as ProviderConfig);
		}
		if (reg.defaults?.worker) this.defaultWorker = reg.defaults.worker;
	}

	has(alias: string): boolean {
		return this.models.has(alias);
	}

	aliases(): string[] {
		return [...this.models.keys()];
	}

	/** Pi provider registrations needed by the registry (e.g. local endpoints). */
	providerRegistrations(): ProviderRegistration[] {
		return [...this.providerRegs.entries()].map(([name, config]) => ({ name, config }));
	}

	/**
	 * Resolve a model reference to a concrete backend.
	 * Accepts:
	 *   - logical alias            ("worker-cheap")           → registry
	 *   - concrete "provider/model" (explicit override)       → direct
	 *   - undefined                                          → default worker alias
	 */
	resolve(ref: string | undefined, opts: { fallbackConcrete?: { provider?: string; model?: string; effort?: string } } = {}): ResolvedModel {
		if (!ref) {
			// agent/session default
			if (this.models.has(this.defaultWorker)) {
				return { alias: this.defaultWorker, concrete: this.models.get(this.defaultWorker)!, source: "registry" };
			}
			const fb = opts.fallbackConcrete;
			if (fb?.model) {
				return {
					alias: "(inherited)",
					concrete: { provider: fb.provider ?? "", model: fb.model, effort: fb.effort },
					source: "inherited",
				};
			}
			throw new Error(`No model reference and no default "${this.defaultWorker}" in registry`);
		}
		if (this.models.has(ref)) {
			return { alias: ref, concrete: this.models.get(ref)!, source: "registry" };
		}
		// explicit concrete override "provider/model" (optionally ":effort")
		let spec = ref;
		let effort: string | undefined;
		const colon = spec.lastIndexOf(":");
		if (colon > spec.lastIndexOf("/")) {
			effort = spec.slice(colon + 1);
			spec = spec.slice(0, colon);
		}
		const slash = spec.indexOf("/");
		if (slash > 0) {
			return {
				alias: ref,
				concrete: { provider: spec.slice(0, slash), model: spec.slice(slash + 1), effort },
				source: "override",
			};
		}
		throw new Error(
			`Unknown model alias "${ref}" (registry has: ${this.aliases().join(", ") || "none"}). ` +
				`Add it to ${path.join(this.orchestratorDir, "models.yaml")} or use "provider/model".`,
		);
	}

	/** Turn a resolved model into pi subprocess launch configuration. */
	toLaunchConfig(resolved: ResolvedModel, effortOverride?: string): LaunchConfig {
		const c = resolved.concrete;
		const args: string[] = [];
		const env: Record<string, string> = { ...(c.env ?? {}) };

		if (c.baseUrl || c.apiKeyEnv || Object.keys(c.headers ?? {}).length) {
			// Ensure a pi provider exists for this endpoint. Named providers from
			// the registry's `providers:` section are registered by the extension
			// at startup; baseUrl-only entries get a deterministic generated name.
			args.push("--model", `${c.provider}/${c.model}`);
			if (c.apiKeyEnv && process.env[c.apiKeyEnv]) env[`${c.apiKeyEnv}`] = process.env[c.apiKeyEnv]!;
		} else {
			args.push("--model", c.provider ? `${c.provider}/${c.model}` : c.model);
		}
		const effort = effortOverride ?? c.effort;
		if (effort) args.push("--thinking", effort);
		for (const a of c.extraArgs ?? []) args.push(a);

		return { args, env, resolved };
	}
}

// ── YAML loading ───────────────────────────────────────────────────────────
// Prefer the `yaml` package (installed next to the extension); fall back to
// JSON, and finally to a minimal indentation parser sufficient for the flat
// registry format so the system degrades instead of breaking.

function parseYaml(raw: string): unknown {
	try {
		return yamlParse(raw);
	} catch {
		return minimalYaml(raw);
	}
}

/** Very small YAML subset parser: nested maps, scalars, no lists/anchors. */
export function minimalYaml(raw: string): unknown {
	const root: Record<string, unknown> = {};
	const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/#.*$/, "").trimEnd();
		if (!line.trim()) continue;
		const indent = line.length - line.trimStart().length;
		const m = line.trim().match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
		if (!m) continue;
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1].obj;
		const [, key, value] = m;
		if (value === "") {
			const child: Record<string, unknown> = {};
			parent[key] = child;
			stack.push({ indent, obj: child });
		} else {
			parent[key] = value.replace(/^["']|["']$/g, "");
		}
	}
	return root;
}
