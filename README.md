# Pi Multi-Agent Orchestrator

[![CI](https://github.com/nathanloisel/pi-multi-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/nathanloisel/pi-multi-agent-orchestrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A [Pi](https://pi.dev) extension that turns your main agent into a pure
**planner** and gives it a fleet of isolated **worker sub-agents**: cheap models
do the work, deterministic tools verify it, stronger models handle exceptions.

```
expensive model = plans   ·   cheap model = works
deterministic tools = verify   ·   stronger models = handle exceptions
```

Core principle: **the orchestrator does not care where inference happens.**
Workers run on whatever backends you configure — hosted providers today, local
OpenAI-compatible servers tomorrow — by editing one YAML file.

## What it does

- **Main-agent lockdown** — with a `role: main` agent present, the main agent
  gets exactly two tools (`delegate`, `jobs`); every other direct tool call is
  hard-blocked. It plans, decomposes, delegates, and inspects — it cannot
  implement.
- **Isolated workers** — each job runs in a fresh `pi` subprocess with its own
  model, thinking effort, tool allowlist, session, and (optionally) its own git
  worktree. No conversation context leaks in; no recursion leaks out.
- **Structured results** — workers write a schema-validated `result.json`
  (status, summary, findings, changes, validation, artifacts). The orchestrator
  receives only that — never raw transcripts.
- **Jobs that survive** — jobs, attempts, events, and artifacts persist on disk
  outside any LLM context. Retry, escalate, resume, cancel, or inspect at any
  time, across restarts and crashes.
- **Retry + escalation ladder** — cheap fresh retry with deterministic failure
  feedback → stronger worker model → frontier model. Transport errors retry
  inside the attempt without consuming the task ladder.
- **DAG scheduling** — batch `delegate` calls with `dependsOn` form a
  dependency graph; independent jobs run concurrently under global and
  per-model concurrency gates; failed dependencies propagate; cycles are
  detected.
- **Budgets & metrics** — per-attempt / per-job / daily USD ceilings, per-turn
  and token limits, and full planner + per-agent×model usage metrics.
- **Host-side validation** — run deterministic checks (typecheck, tests) in the
  worker's workspace after each attempt; a failed check overrides
  worker-claimed success.

Full technical details: [PROTOCOL.md](./PROTOCOL.md).

## Architecture

```
FRONTIER MAIN AGENT (planner only; delegate/jobs tools; hard tool block)
  └── ORCHESTRATION CORE (core/orchestrator.ts)
        ├── routing (logical aliases → ModelRegistry → provider backends)
        ├── budgets, concurrency gates, event log, metrics
        ├── jobs → attempts (resume | fresh | escalation ladder)
        ├── deterministic validation, git-worktree isolation
        └── WORKERS = isolated `pi` subprocesses (core/spawn.ts)
              hosted providers today; local OpenAI-compatible later = config only
```

```
~/.pi/orchestrator/                     # orchestrator state (private)
├── config.yaml · models.yaml           # your configuration
├── planner-metrics.json                # main-agent usage
└── jobs/<jobId>/                       # job store
    ├── job.json · task.md · events.jsonl · result.json · report.md
    ├── artifacts/
    └── attempts/attempt-NNN/           # per-attempt session/result/usage
~/.pi/agents/<name>/AGENT.md            # worker runtime packages (v2)
```

## Features

| Area | What you get |
|---|---|
| Tools | `delegate` (single job or DAG batch), `jobs` (list/status/read/artifact/graph/events/attempts/followup/retry/cancel/wait/metrics) |
| Commands | `/agents` (roster + registry status), `/orchestrator-init` (scaffold starter config) |
| Models | Logical aliases (`worker-cheap`, `worker-best`, `frontier`, …) resolved in one registry file |
| Routing | Kind/tag/attempt/failure-trigger rules; explicit overrides; per-agent defaults |
| Retries | Configurable ladders, resume vs fresh, transport-vs-task error separation |
| Budgets | USD per attempt/job/day, maxTurns, maxOutputTokens, timeoutSeconds |
| Workspaces | `cwd` or isolated `git-worktree` with diff capture and cleanup policies |
| Validation | Deterministic post-attempt commands; failures feed the next attempt |
| Recovery | Crash-interrupted attempts detected and resumable after restart |

## Requirements

- [Pi](https://pi.dev) (extension host) — current release
- Node 22+ and npm (Pi runs `npm install` for git/npm packages automatically)
- Provider credentials for the models you configure (environment variables)

## Quick start

### 1. Install

```bash
pi install git:github.com/nathanloisel/pi-multi-agent-orchestrator@v1.0.0
```

### 2. Scaffold starter configuration

```bash
pi
> /orchestrator-init
```

This creates (never overwriting anything that already exists):

- `~/.pi/orchestrator/config.yaml` — concurrency, budgets, routing rules
- `~/.pi/orchestrator/models.yaml` — logical model aliases (example models)
- `~/.pi/agents/coder/AGENT.md`, `~/.pi/agents/researcher/AGENT.md`,
  `~/.pi/agents/vision/AGENT.md` — example worker profiles

### 3. Set provider auth and edit models

Export the API keys for your providers, then edit
`~/.pi/orchestrator/models.yaml` to use models actually available to you
(`pi --list-models` lists what your Pi install can resolve). Example aliases:

```yaml
models:
  worker-cheap:
    provider: openrouter
    model: anthropic/claude-haiku-4.5
  worker-best:
    provider: openrouter
    model: anthropic/claude-sonnet-4.5
  frontier:
    provider: anthropic
    model: claude-opus-4-8
defaults:
  worker: worker-cheap
```

API keys are **never** stored in config files — reference them by environment
variable name (`apiKeyEnv`) or rely on Pi's own provider auth. See
[SECURITY.md](./SECURITY.md).

### 4. Reload

```
/reload
```

The orchestrator activates at session start. Done — the `/agents` command
shows your roster and resolved aliases.

### 5. Delegate

Just ask your main agent to do something; it plans and delegates:

> Use the coder agent to add a `--json` flag to `scripts/report.ts` that prints
> the summary as JSON. Keep the table output as default. Run the project's
> typecheck and tests as validation, and make them pass.

> Research how error handling is centralized in `src/` and report the three
> most important patterns with file:line evidence.

> Read `design/mockups/settings.png` and list every control that appears in
> the mockup but not in the current settings page implementation.

Batch with dependencies (DAG):

> Delegate three jobs to the coder agent: first add the parser, then the
> serializer depending on the parser, then the CLI wiring depending on both.
> Each must pass `npm run typecheck`.

### 6. Watch it work

While jobs run, a live progress display shows tool calls and job state in
real time; the main agent's visible messages complement it — terse, factual,
and never repeating what the display already shows:

- **Plan** — a short numbered plan for multi-step work (one line per step/job);
  trivial single-step requests skip ceremony entirely.
- **Now:** — only at meaningful execution transitions (new batch of jobs, new
  phase, changed approach): one line naming the job(s) and targets. Skipped
  when the live display already makes the transition obvious.
- **Plan update:** — only when steps are added, removed, reordered, replaced,
  or a blocker changes the approach, with a one-line reason. Step numbering is
  stable, every parallel job keeps its own identifiable label (one line
  listing them is fine), and completed/cancelled steps remain listed with
  their terminal state.
- **Final message** — outcome, relevant paths, and actual validation results
  or blockers.

No filler, no plan dumps between tool calls, and no step is called done before
its job returned a validated result.

The live display itself is a bounded **Plan** widget (above the editor, with a
status line) driven by persisted job state: only jobs from the current session
branch appear, `Now:` names actually running work, and finished history is
capped with truthful overflow lines. It is re-projected on session switch and
cleared on `/reload` (see [Troubleshooting](#troubleshooting)).

## Tools

### `delegate`

- Single: `{ agent, task, context?, kind?, id?, model?, retry?, cwd? }`
- Batch (DAG): `{ jobs: [{ id, dependsOn, agent, task, … }] }` — independent
  jobs run concurrently; failed dependencies gate downstream jobs.
- The optional `model` is a logical alias override applied to the job's first
  attempt; `jobs.retry model=…` overrides later.

### `jobs`

| Action | Purpose |
|---|---|
| `list` | Recent jobs with status and summary |
| `status <id>` | Full job state, attempts, blockers |
| `read <id>` | Canonical `result.json` (on-demand — pull, don't push) |
| `artifact <id>,path[,attempt]` | Read a stored artifact |
| `graph` | DAG view with effective states and cycles |
| `events <id>` | Append-only event stream |
| `attempts <id>` | Per-attempt model/usage/cost/latency |
| `followup <id>,message` | Resume the worker's session (cheapest correction) |
| `retry <id>[,strategy][,model]` | New attempt (`fresh` or `resume`, optional escalation) |
| `cancel <id>` | Cancel a non-terminal job |
| `wait <id>[,id…]` | Block until jobs settle |
| `metrics` | Planner + per-agent×alias worker totals |

### Commands

- `/agents` — roster, alias registry, diagnostics.
- `/orchestrator-init` — scaffold starter templates (idempotent, never
  overwrites existing files).

## Agent profiles (`~/.pi/agents/<name>/AGENT.md`)

Workers are declarative runtime packages (v2 frontmatter; v1 flat keys still
load):

```yaml
---
name: coder
description: Implements code changes in an isolated workspace with validation.
role: sub                      # sub | main
runtime:
  model: worker-cheap          # logical alias (or explicit "provider/model")
  effort: medium
capabilities: [read, edit, bash]
limits: { maxTurns: 20, timeoutSeconds: 900, maxOutputTokens: 16000 }
context:
  mode: selective              # none | selective | full
  files: [AGENTS.md, docs/architecture.md]
workspace:
  strategy: git-worktree       # cwd | git-worktree
  cleanup: keep                # keep | remove-on-success
validation:
  commands: [npm run typecheck, npm test]
retry:
  maxAttempts: 4               # ladder: cheap fresh → worker-best → frontier
budget: { perJobUsd: 3.00 }
hooks:
  enabled: true
---
Instructions body (worker system prompt). The output contract is injected
automatically — don't repeat it.
```

Mark one profile `role: main` to activate main-agent lockdown. Without one,
the extension stays passive and you keep your normal tools.

## Switching workers to local inference

Edit `~/.pi/orchestrator/models.yaml` only — no changes to agents, jobs,
routing, retries, validation, or DAG logic:

```yaml
providers:
  local-openai-compatible:
    name: Local LLM
    baseUrl: http://localhost:8080/v1
    api: openai-completions
    apiKey: $LOCAL_LLM_KEY
    models: [{ id: my-local-model }]
models:
  worker-cheap:
    provider: local-openai-compatible
    model: my-local-model
    baseUrl: http://localhost:8080/v1
    apiKeyEnv: LOCAL_LLM_KEY
```

## AgentsView integration (opt-in, private by default)

The bridge exports each finished worker attempt as a standard Pi JSONL session
so [AgentsView](https://github.com/earendil-works/agentsview) (verified with
v0.41.1) can display sub-agent sessions. It is **disabled by default** for
privacy — nothing is exported until you opt in, and even then everything stays
on your machine under the directory you choose. Files are written atomically
with private permissions (`0600` files, `0700` project directory).

1. In `~/.pi/orchestrator/config.yaml`:

```yaml
agentsView:
  enabled: true
  exportDir: ~/.pi/orchestrator/agentsview-sessions
```

2. Register the export directory with AgentsView using a
   `[[session_sources]]` entry in `~/.agentsview/config.toml` (the nested
   `<exportDir>/orchestrator/<jobId>--<attemptId>.jsonl` project layout is what
   AgentsView's parser requires):

```toml
[[session_sources]]
agent = "pi"
dir = "~/.pi/orchestrator/agentsview-sessions"
```

3. Restart or sync AgentsView. Sessions appear under the `pi` agent with
   sub-agent identity and status in the title; a sidecar
   `orchestrator-sessions.json` retains exact agent/model/provider/status and
   source paths.

On activation the orchestrator backfills existing attempts idempotently, so
sub-agents that ran before enabling the bridge become visible too.

## Security & privacy

- The orchestrator is local-first: job state, transcripts, metrics, and
  artifacts live under `~/.pi/orchestrator/` with private permissions where the
  OS supports them.
- Worker subprocesses get a **sanitized environment** — only PATH/HOME/proxy
  settings, the API keys needed by the configured models, and explicit per-job
  variables. No unrelated parent secrets.
- Config files never contain tokens; credentials come from your environment.
- The AgentsView bridge is opt-in and purely local.
- Review the source before installing; see [SECURITY.md](./SECURITY.md) for
  the full trust model and disclosure policy.

## Development & testing

```bash
git clone https://github.com/nathanloisel/pi-multi-agent-orchestrator.git
cd pi-multi-agent-orchestrator
npm install
npm run typecheck   # strict TypeScript
npm test            # full deterministic suite (77 tests, no network)
npm run release:check
```

Try the extension without installing it:

```bash
pi -e /path/to/pi-multi-agent-orchestrator
```

## Updating and uninstalling

Git sources are installed at a **pinned ref** (tag or commit).
`pi update --extensions` / `pi update --all` reconcile the clone to the pinned
ref but do **not** advance it. To move to a newer release, reinstall with the
newer tag:

```bash
pi install git:github.com/nathanloisel/pi-multi-agent-orchestrator@v1.1.0   # example
pi remove git:github.com/nathanloisel/pi-multi-agent-orchestrator           # uninstall
```

`pi list` shows installed packages. Your `~/.pi/orchestrator/` state and
`~/.pi/agents/` profiles are not removed by uninstalling the package.

Source install alternative (loads in place, no copy):

```bash
pi install /absolute/path/to/pi-multi-agent-orchestrator
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown model alias "worker-cheap"` | Add the alias to `~/.pi/orchestrator/models.yaml` (or use an explicit `provider/model` override), then `/reload`. |
| `unresolved` alias in `/agents` | The alias's provider/model isn't available to your Pi install — run `pi --list-models`, fix `models.yaml`, `/reload`. |
| Workers fail with auth errors | Export the API key environment variables your providers need; never hardcode keys in config files. |
| Main agent still has direct tools | Lockdown needs a `role: main` agent in `~/.pi/agents/`; `/orchestrator-init` scaffolds only sub-agents. Create one or omit it to keep normal tools. |
| `/orchestrator-init` says files exist | That's by design — it never overwrites. Edit the existing files manually. |
| Job stuck `interrupted` after a crash | Expected: reload detects the interrupted attempt; `jobs.retry` allocates a fresh attempt. |
| AgentsView shows nothing | Bridge must be enabled in `config.yaml`, the export dir registered via `[[session_sources]]`, and AgentsView restarted/synced. |
| After editing any config | Run `/reload` — YAML files and agent profiles are read at session start. |

## License

[MIT](./LICENSE) © 2026 Nathan Loisel
