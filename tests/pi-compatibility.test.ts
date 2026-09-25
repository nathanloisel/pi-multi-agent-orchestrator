/**
 * pi runtime compatibility tests — REAL selected CLI, no mocks, no network
 * model calls, no paid spend.
 *
 * Unlike tests/extension-smoke.test.ts (which drives index.ts against a mock
 * ExtensionAPI), this suite launches the INSTALLED pi coding agent in RPC
 * mode with the orchestrator extensions loaded, in an isolated temp
 * environment (temp HOME + PI_CODING_AGENT_DIR; user config/keys are never
 * read or written). It exercises:
 *
 *   - the local pi binary resolved from the package's declared `bin`
 *     (never a hardcoded global path or dist internals),
 *   - extension loading of the REAL index.ts (slash commands visible through
 *     the RPC `get_commands` protocol; a failed load can NOT be silently
 *     accepted because the assertions require the registered commands),
 *   - extension loading of the REAL worker.ts with a restrictive base
 *     `--tools` allowlist + env allowlist, verifying via a tiny probe
 *     extension that the live messaging tools are registered and active
 *     (reported through pi's native `ctx.ui.notify` envelope, i.e.
 *     `extension_ui_request` on stdout — no raw custom protocol),
 *   - graceful exit 0 on stdin EOF, and fail-fast on hang (timeout → kill).
 *
 * The CLI/peer versions under test are whatever node_modules currently holds:
 * the reproducible baseline lock (0.85.1) or a selected release installed by
 * scripts/install-pi-test-version.mjs (0.87.0 / latest). Both must pass.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { describePlan, installSpecs, resolveInstallPlan, resolveVersion } from "../scripts/lib/pi-version-plan.mjs";

// ── Pure helper coverage (no network, mocked npm metadata) ──────────────────

describe("pi test-version planning (pure helper)", () => {
	it("maps exact versions, dist-tags, and peer specs onto install specs", () => {
		const plan = resolveInstallPlan({
			requested: "0.87.0",
			distTags: { latest: "0.87.0", legacy: "0.74.2" },
			codingAgentDependencies: {
				"@earendil-works/pi-ai": "^0.87.0",
				"@earendil-works/pi-tui": "^0.87.0",
				typebox: "1.3.27",
				"@earendil-works/chord": "^0.87.0",
			},
		});
		assert.equal(plan.codingAgent.version, "0.87.0");
		// Peer versions derive from the SELECTED release, not a shared version:
		// typebox is 1.3.27 here while the @earendil-works packages are 0.87.x.
		assert.deepEqual(
			installSpecs(plan),
			[
				"@earendil-works/pi-coding-agent@0.87.0",
				"@earendil-works/pi-ai@^0.87.0",
				"@earendil-works/pi-tui@^0.87.0",
				"typebox@1.3.27",
			],
		);
		assert.match(describePlan(plan), /pi coding-agent 0\.87\.0/);
		assert.match(describePlan(plan), /typebox@1\.3\.27/);
	});

	it("resolves 'latest' and arbitrary dist-tags via dist-tags metadata", () => {
		const plan = resolveInstallPlan({
			requested: "legacy",
			distTags: { latest: "0.87.0", legacy: "0.74.2" },
			codingAgentDependencies: { "@earendil-works/pi-ai": "^0.74.2", "@earendil-works/pi-tui": "^0.74.2", typebox: "1.2.0" },
		});
		assert.equal(plan.codingAgent.version, "0.74.2");
		assert.equal(resolveVersion({ requested: "legacy", distTags: { latest: "0.87.0", legacy: "0.74.2" } }), "0.74.2");
	});

	it("rejects missing/unknown versions instead of guessing", () => {
		assert.throws(
			() => resolveInstallPlan({ requested: "", distTags: {}, codingAgentDependencies: {} }),
			/No pi version requested/,
		);
		assert.throws(
			() => resolveInstallPlan({ requested: "0.99.x", distTags: { latest: "0.87.0" }, codingAgentDependencies: {} }),
			/neither an exact semver version nor a known dist-tag/,
		);
		assert.throws(
			() => resolveInstallPlan({ requested: "latest", distTags: undefined, codingAgentDependencies: {} }),
			/missing or malformed/,
		);
	});

	it("refuses a selected release that stopped declaring a peer dependency", () => {
		assert.throws(
			() =>
				resolveInstallPlan({
					requested: "9.0.0",
					distTags: { latest: "9.0.0" },
					codingAgentDependencies: { "@earendil-works/pi-ai": "^9.0.0" },
				}),
			/Cannot guarantee matching peer versions/,
		);
	});
});

// ── Real CLI RPC smoke (local installed pi, isolated environment) ────────────

const TIMEOUT_MS = 90_000;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Resolve the LOCAL pi executable from the installed package's declared bin. */
function resolveLocalPi(): { cliPath: string; version: string } {
	const pkgRoot = resolvePackageRoot();
	const pkgPath = path.join(pkgRoot, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
		name?: string;
		version?: string;
		bin?: string | Record<string, string>;
	};
	if (pkg.name !== "@earendil-works/pi-coding-agent") {
		throw new Error(`Package root mismatch at ${pkgRoot}: name is ${String(pkg.name)}`);
	}
	const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (!binRel) throw new Error("Installed pi-coding-agent package.json declares no `pi` bin entry");
	const cliPath = path.join(pkgRoot, binRel);
	if (!fs.existsSync(cliPath)) throw new Error(`Declared pi bin does not exist: ${cliPath}`);
	return { cliPath, version: pkg.version ?? "unknown" };
}

/** Locate node_modules/@earendil-works/pi-coding-agent without hardcoding paths.
 *
 * Tries standard require resolution first (works whenever the package exposes
 * a `require` condition), then falls back to walking ancestor node_modules
 * dirs — pi 0.85.1/0.87.0 only expose an `import` condition, which CJS
 * require() cannot resolve.
 */
function resolvePackageRoot(): string {
	const pkgDirName = path.join("@earendil-works", "pi-coding-agent");
	try {
		const entry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
		let dir = path.dirname(entry);
		for (;;) {
			const pkgPath = path.join(dir, "package.json");
			if (fs.existsSync(pkgPath) && (JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string }).name === "@earendil-works/pi-coding-agent") {
				return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		/* exports map without a require condition — fall through to fs lookup */
	}
	for (let dir = REPO_ROOT; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", pkgDirName, "package.json");
		if (fs.existsSync(candidate)) return path.dirname(candidate);
		const parent = path.dirname(dir);
		if (parent === dir) break;
	}
	throw new Error(
		"Could not locate @earendil-works/pi-coding-agent in node_modules — run `npm ci` (baseline) or scripts/install-pi-test-version.mjs <version> first",
	);
}

const localPi = resolveLocalPi();

// Hermetic sandbox: temp HOME + PI_CODING_AGENT_DIR so neither the user's
// config/credentials nor the real ~/.pi are touched. No session files, no
// model calls (no prompt is ever sent), no network (--offline).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compat-"));
const homeDir = path.join(sandbox, "home");
const agentDir = path.join(homeDir, ".pi", "agent");
const projectDir = path.join(sandbox, "project");
for (const dir of [agentDir, projectDir]) fs.mkdirSync(dir, { recursive: true });

/** Child env: isolated HOME/agent dir, orchestrator worker vars scrubbed. */
function rpcEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("PI_ORCHESTRATOR_")) delete env[key];
	env.HOME = homeDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	return { ...env, ...extra } as NodeJS.ProcessEnv;
}

type RpcEvent = Record<string, unknown> & { type?: string };

/** Minimal strict-JSONL RPC client (splits on \n only, per docs/rpc.md). */
class RpcSession {
	readonly proc: ChildProcess;
	readonly events: RpcEvent[] = [];
	private buffer = "";
	private pending = new Map<string, { resolve: (v: RpcEvent) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
	private exitWaiters: Array<{ resolve: (code: number | null) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }> = [];
	private exited = false;
	private exitCode: number | null = null;

	constructor(proc: ChildProcess) {
		this.proc = proc;
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
		proc.on("error", (err) => this.failAll(new Error(`pi process error: ${err.message}`)));
		proc.on("exit", (code) => {
			this.exited = true;
			this.exitCode = code;
			// Any pending request after exit = premature termination: fail it.
			if (this.pending.size > 0) {
				this.failAll(new Error(`pi exited prematurely with code ${code} while ${this.pending.size} RPC request(s) were pending`));
			}
			for (const w of this.exitWaiters) {
				clearTimeout(w.timer);
				w.resolve(code);
			}
			this.exitWaiters = [];
		});
	}

	private failAll(err: Error | null) {
		if (!err) return;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.fail(err);
		}
		this.pending.clear();
	}

	private onData(chunk: string) {
		this.buffer += chunk;
		for (;;) {
			const nl = this.buffer.indexOf("\n");
			if (nl < 0) break;
			const line = this.buffer.slice(0, nl).replace(/\r$/, "");
			this.buffer = this.buffer.slice(nl + 1);
			if (!line.trim()) continue;
			let event: RpcEvent;
			try {
				event = JSON.parse(line);
			} catch {
				continue; // tolerate non-protocol noise
			}
			this.events.push(event);
			if (event.type === "response" && typeof event.id === "string") {
				const p = this.pending.get(event.id);
				if (p) {
					clearTimeout(p.timer);
					this.pending.delete(event.id);
					p.resolve(event);
				}
			}
		}
	}

	send(cmd: Record<string, unknown>): void {
		if (this.exited) throw new Error("pi process already exited");
		this.proc.stdin?.write(`${JSON.stringify(cmd)}\n`);
	}

	/** Correlated request/response; times out → kill → fail-fast. */
	async request(cmd: Record<string, unknown> & { id: string }, timeoutMs = 45_000): Promise<RpcEvent> {
		if (this.pending.has(cmd.id)) throw new Error(`duplicate request id ${cmd.id}`);
		return new Promise<RpcEvent>((resolve, fail) => {
			const timer = setTimeout(() => {
				this.pending.delete(cmd.id);
				fail(new Error(`RPC request ${cmd.id} (${String(cmd.type)}) timed out after ${timeoutMs}ms`));
				this.kill();
			}, timeoutMs);
			this.pending.set(cmd.id, { resolve, fail, timer });
			this.send(cmd);
		});
	}

	/** First event matching pred; timeout → kill → fail-fast. */
	async waitFor(pred: (e: RpcEvent) => boolean, description: string, timeoutMs = 45_000): Promise<RpcEvent> {
		const found = this.events.find(pred);
		if (found) return found;
		return new Promise((resolve, fail) => {
			const startedAt = Date.now();
			const timer = setInterval(() => {
				const hit = this.events.find(pred);
				if (hit) {
					clearInterval(timer);
					resolve(hit);
					return;
				}
				if (Date.now() - startedAt > timeoutMs) {
					clearInterval(timer);
					fail(new Error(`timed out after ${timeoutMs}ms waiting for ${description}`));
					this.kill();
					return;
				}
				if (this.exited) {
					clearInterval(timer);
					fail(new Error(`pi exited with code ${this.exitCode} before ${description}`));
					return;
				}
			}, 50);
		});
	}

	/** Graceful shutdown: stdin EOF → expect a clean exit code. */
	async close(expectedCode = 0, timeoutMs = 30_000): Promise<number> {
		const code = await new Promise<number | null>((resolve, fail) => {
			if (this.exited) return resolve(this.exitCode);
			const timer = setTimeout(() => {
				fail(new Error(`pi did not exit within ${timeoutMs}ms after stdin EOF`));
				this.kill();
			}, timeoutMs);
			this.exitWaiters.push({ resolve, fail, timer });
			this.proc.stdin?.end();
		});
		assert.equal(code, expectedCode, `pi should exit gracefully with code ${expectedCode} on stdin EOF`);
		return code;
	}

	kill(): void {
		if (!this.exited && this.proc.exitCode === null && this.proc.pid) this.proc.kill("SIGKILL");
	}
}

/** Launch the real local pi CLI in RPC mode with explicit extensions. */
function startRpc(extensionPaths: string[], extraArgs: string[] = [], env: NodeJS.ProcessEnv = rpcEnv()): RpcSession {
	const args = [
		localPi.cliPath,
		"--mode", "rpc",
		"--offline", // no startup network operations; no model calls are ever made
		"--no-session", // no session persistence
		"--no-extensions", // disable discovery; explicit -e paths still load
		"--no-skills",
		"--no-context-files", // no AGENTS.md/CLAUDE.md discovery
		...extraArgs,
	];
	for (const ext of extensionPaths) args.push("-e", ext);
	const proc = spawn(process.execPath, args, {
		cwd: projectDir,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return new RpcSession(proc);
}

const MAIN_EXT = path.join(REPO_ROOT, "index.ts");
const WORKER_EXT = path.join(REPO_ROOT, "worker.ts");
const PROBE_EXT = path.join(REPO_ROOT, "tests", "fixtures", "compat-probe.ts");
for (const ext of [MAIN_EXT, WORKER_EXT, PROBE_EXT]) {
	if (!fs.existsSync(ext)) throw new Error(`missing extension file for compatibility smoke: ${ext}`);
}

after(() => {
	try {
		fs.rmSync(sandbox, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe("pi runtime compatibility (real installed CLI in RPC mode)", () => {
	it("resolves the local pi binary from the package's declared bin", () => {
		assert.match(localPi.version, /^\d+\.\d+\.\d+/, "installed pi version should be a concrete semver");
		assert.ok(fs.existsSync(localPi.cliPath), "declared bin should exist");
	});

	it("loads the real orchestrator main extension: slash commands + native UI envelopes + clean EOF exit", async () => {
		const session = startRpc([MAIN_EXT]);
		try {
			const state = await session.request({ id: "c-state", type: "get_state" });
			assert.equal(state.success, true, `get_state must succeed: ${JSON.stringify(state)}`);
			assert.ok(typeof (state.data as { sessionId?: string })?.sessionId === "string");

			const commands = await session.request({ id: "c-commands", type: "get_commands" });
			assert.equal(commands.success, true, `get_commands must succeed: ${JSON.stringify(commands)}`);
			const names = (commands.data as { commands: Array<{ name: string; source: string }> }).commands.map((c) => c.name);
			// Registration happens only when the extension actually loaded — a
			// failed/silent load would leave these out and fail the assertion.
			assert.ok(names.includes("orchestrator-init"), `orchestrator-init missing from get_commands: ${names.join(", ")}`);
			assert.ok(names.includes("agents"), `agents missing from get_commands: ${names.join(", ")}`);

			// Native extension-UI envelopes flow through the public RPC surface.
			const notify = await session.waitFor(
				(e) => e.type === "extension_ui_request" && e.method === "notify" && String(e.message).includes("orchestrator"),
				"orchestrator startup notify envelope",
			);
			assert.ok(String(notify.message).startsWith("orchestrator"));
			assert.ok(
				session.events.some((e) => e.type === "extension_ui_request" && e.method === "setWidget"),
				"expected the progress setWidget envelope",
			);

			assert.ok(
				!session.events.some((e) => e.type === "extension_error"),
				`extension_error events must not be silently accepted: ${JSON.stringify(session.events.filter((e) => e.type === "extension_error"))}`,
			);
			await session.close();
		} finally {
			session.kill();
		}
	});

	it("loads the real worker extension with a restrictive allowlist and activates the live messaging tools", async () => {
		const session = startRpc(
			[WORKER_EXT, PROBE_EXT],
			// Mirror production core/spawn.ts: the role capabilities AND the
			// messaging tools are unioned into the CLI allowlist itself.
			["--tools", "read,message_main,ask_main,ask_user_question"],
			rpcEnv({
				PI_ORCHESTRATOR_SUBAGENT: "1",
				PI_ORCHESTRATOR_JOB_ID: "compat-job",
				PI_ORCHESTRATOR_ATTEMPT_ID: "attempt-1",
				PI_ORCHESTRATOR_ALLOWED_TOOLS: "read",
			}),
		);
		try {
			// The probe reports the real tool surface via ctx.ui.notify → the
			// native extension_ui_request envelope (fire-and-forget, no response).
			const probeEvent = await session.waitFor(
				(e) => e.type === "extension_ui_request" && e.method === "notify" && String(e.message).startsWith("PROBE:"),
				"compat probe notify envelope",
			);
			const probe = JSON.parse(String(probeEvent.message).slice("PROBE:".length)) as {
				all: string[];
				active: string[];
				mode: string;
			};
			assert.equal(probe.mode, "rpc");
			for (const tool of ["read", "message_main", "ask_main", "ask_user_question"]) {
				assert.ok(probe.all.includes(tool), `${tool} should be registered (all tools): ${probe.all.join(", ")}`);
				assert.ok(probe.active.includes(tool), `${tool} should be active under the restrictive allowlist: ${probe.active.join(", ")}`);
			}
			for (const forbidden of ["delegate", "jobs"]) {
				assert.ok(!probe.active.includes(forbidden), `${forbidden} must never be active for workers: ${probe.active.join(", ")}`);
			}
			assert.ok(
				probe.active.every((t) => ["read", "message_main", "ask_main", "ask_user_question"].includes(t)),
				`restrictive allowlist should keep everything else off: ${probe.active.join(", ")}`,
			);

			// worker.ts also drives the native setStatus envelope at session_start.
			const status = await session.waitFor(
				(e) => e.type === "extension_ui_request" && e.method === "setStatus" && e.statusKey === "orchestrator-worker",
				"orchestrator-worker setStatus envelope",
			);
			assert.ok(String(status.statusText).includes("compat-job"));

			assert.ok(
				!session.events.some((e) => e.type === "extension_error"),
				`extension_error events must not be silently accepted: ${JSON.stringify(session.events.filter((e) => e.type === "extension_error"))}`,
			);
			await session.close();
		} finally {
			session.kill();
		}
	});
});
