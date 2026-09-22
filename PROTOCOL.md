# Orchestrator Protocol v2

Multi sub-agent job delegation runtime for pi.

```
expensive model = plans   ·   cheap model = works
deterministic tools = verify   ·   stronger models = handle exceptions
```

Core principle: **the orchestrator does not care where inference happens.**
Workers run on OpenRouter today; switching to local Qwen/llama.cpp later is a
change to `~/.pi/orchestrator/models.yaml` only.

```
Agent    = behavior    (role, instructions, tools, hooks, limits, validation, policies)
Model    = capability  (logical alias: worker-cheap / worker-best / frontier)
Provider = transport   (openrouter / anthropic / local-openai-compatible / ...)
Job      = persistent objective (survives retries, escalations, model changes)
Attempt  = one execution (one agent/runtime/model/session/workspace/validation)
```

## 1. Model registry — the only place concrete models exist

`~/.pi/orchestrator/models.yaml`:

```yaml
models:
  worker-cheap: { provider: openrouter, model: <cheap-id> }
  worker-best:  { provider: openrouter, model: <stronger-id> }
  frontier:     { provider: anthropic,  model: claude-opus-4-8 }
  # future — drop-in local backend, zero code changes elsewhere:
  # worker-cheap:
  #   provider: local-openai-compatible
  #   model: swift-qwen-27b
  #   baseUrl: http://gpu-server:8080/v1
  #   apiKeyEnv: LOCAL_LLM_KEY
providers: {}        # custom pi provider registrations (pi.registerProvider shape)
defaults: { worker: worker-cheap }
```

`~/.pi/orchestrator/config.yaml`: `concurrency` (global + byModel), `budgets`
(perAttemptUsd/perJobUsd/dailyUsd), `routing.rules` (kind/tag/attempt → alias).

Resolution chain: explicit override (`jobs.retry model=...`, first attempt of
the job only) → job's persisted `initialModel` (from `delegate model=...`,
first attempt only) → routing rules → retry ladder → agent `runtime.model` →
registry default. Aliases like `worker-cheap-a`/`worker-cheap-b` enable A/B
experiments with no agent changes.

## 2. Worker execution (transport)

Each attempt spawns an isolated pi subprocess (built in `core/spawn.ts`):

```
pi --mode rpc
   --session-dir <attempt>/session --session-id <jobId>-<attemptId>
   --model <resolved provider/model> [--thinking effort]
   [--tools capabilities,+message_main,+ask_main,+ask_user_question]
   [--no-context-files] [--no-skills]
   --append-system-prompt <attempt>/SYSTEM.md      # AGENT.md body
   -e worker.ts [-e agent hooks...]                # dedicated hooks
   --no-extensions                                  # no recursion/lockdown leakage
   # the rendered job envelope travels as a stdin `prompt` command (never argv);
   # genuine completion is the agent_settled event, after which stdin closes
   # gracefully so RPC mode flushes its final output
```

- RPC mode also carries live messaging: worker `notify`/`input` dialogs are
  the transport for message_main / ask_main / ask_user_question, answered by
  the parent broker over correlated `extension_ui_response` records; the
  control handle steers a live worker (`jobs action=message`). No tmux, no
  sockets, no mailboxes (§13).

- Sanitized child env (§30): PATH/HOME/proxies + needed provider keys + agent
  `env` + `PI_ORCHESTRATOR_*` (JOB_ID, ATTEMPT_DIR, ARTIFACTS, RESULT_PATH,
  ALLOWED_TOOLS). No unrelated parent secrets.
- JSON event stream parsed for messages/usage/session; costs persisted.
- Failure classification (`core/errors.ts`): rate_limited / provider_unavailable
  / timeout / auth are **transport** errors → in-attempt exponential-backoff
  retries that never consume the task ladder. Task errors → ladder.
- Timeouts, Esc-abort (SIGTERM→SIGKILL), crash → attempt persisted as
  `interrupted` and recovered on next load.

## 3. Canonical upstream protocol: result.json (schema v1)

Workers MUST write `<attempt>/result.json` (path given in the envelope's OUTPUT
CONTRACT and via `PI_ORCHESTRATOR_RESULT_PATH`):

```json
{ "schemaVersion": 1, "jobId": "...", "attemptId": "...",
  "status": "success|partial|failure|blocked", "summary": "...",
  "findings": [{ "severity": "info|warning|error", "code": "...", "message": "...", "evidence": "path:line" }],
  "changes": ["src/x.ts"],
  "validation": { "status": "passed|failed|skipped", "checks": [{ "name","status","command","exitCode","artifact" }] },
  "artifacts": [{ "id","type","path","size","sha256?" }],
  "blockers": [], "followUps": [], "metrics": {} }
```

Extraction pipeline (`core/result.ts`): result.json file → fenced ```json block
→ legacy ```report markdown (v1 compat) → synthetic failure. Everything is
schema-normalized with recorded repairs; raw worker output kept in
`raw-output.txt`. `report.md` is **rendered from** result.json, never parsed.
Malformed output = one ladder retry, never a crash. A terminal `runError` (the
transport-retry loop ended in failure) is authoritative: any worker-written
success is overridden to canonical `failure` before persistence — findings,
changes, and artifacts are preserved and a concise blocker records the error
kind/message. Intermediate transport failures that later recover never force a
final failure.

## 4. Downstream envelope (deterministic, §18)

Fixed sections: ROLE / JOB / TASK / CONTEXT (pack + inlined files + previous
failure feedback) / CONSTRAINTS / ACCEPTANCE CRITERIA / WORKSPACE / ARTIFACT
DIRECTORY / VALIDATION / OUTPUT CONTRACT. Context packs (`core/context.ts`) are
persisted per attempt; fresh retries carry only task + selected context +
failure summary + validation feedback — never the old transcript.

## 5. Job store

```
~/.pi/orchestrator/jobs/<jobId>/
├── job.json          # JobRecord: objective, dependsOn, status, retry spec, latest summary
├── task.md           # rendered envelope
├── context.json      # initial context pack
├── events.jsonl      # append-only: job.created/attempt.started/provider.*/validation.*/...
├── result.json       # canonical result (latest attempt)
├── report.md         # rendered from result.json
├── artifacts/        # promoted attempt artifacts + manifest.json (sha256, size)
└── attempts/attempt-NNN/
    ├── attempt.json  # model alias/resolved, retryMode, exitReason, usage, workspace, validation
    ├── result.json · raw-output.txt · report.md · context.json
    ├── SYSTEM.md · env.json (launch audit, non-secret)
    ├── artifacts/ · validation/ · session/   # session = resume channel
```

Atomic writes (tmp+rename), atomic attempt allocation (mkdir), traversal-safe
artifact reads. Job states: queued → blocked/ready → running → success |
failed | waiting | cancelled | interrupted.

## 6. Retry / escalation / follow-up

- `jobs.followup` — resume the latest attempt's session (cheapest channel; the
  worker keeps its memory; no new attempt).
- `jobs.retry strategy=fresh [model=alias]` — new attempt; fresh context pack
  with deterministic failure feedback.
- Automatic cheap-first ladder (configurable per agent/job):
  `worker-cheap → worker-cheap(fresh+feedback) → worker-best → frontier`.
  Validation failure feeds the next attempt; frontier is the last resort.
- Host-side validation (`agent.validation.commands`) runs after the attempt in
  its workspace; logs stay in `validation/` as artifacts. Failed validation
  overrides worker-claimed success.
- Budgets: per-attempt/per-job/daily USD ceilings + maxTurns/maxOutputTokens/
  timeout; violations are machine-readable (`budget exceeded: perJobUsd:2`).

## 7. DAG & concurrency

`delegate {jobs:[{id, dependsOn:[...]}]}` creates a batch; the scheduler runs
ready jobs concurrently (global + per-alias gates), propagates dependency
failures downstream without running blocked jobs, detects cycles, and expands
scoped runs to transitive dependencies. `jobs.graph` shows effective states
without injecting results into context.

## 8. Workspaces (§14)

`workspace.strategy: git-worktree` → `repo/.pi-worktrees/<jobId>` on branch
`pi/<jobId>` from HEAD; attempt records branch+baseCommit; `change.patch`
captured to artifacts; cleanup policy `keep | remove-on-success`; never merges
automatically. Non-git dirs degrade to `cwd`.

## 9. Main-agent lockdown (§8)

With a `role: main` agent present: active tools = `delegate` + `jobs` +
`ask_user_question` only, hard `tool_call` block on everything else,
orchestrator prompt + roster + alias registry injected each turn. The main
agent reasons, decomposes, delegates, inspects summaries, retries/escalates —
it cannot implement (it can only ask the human user questions).

## 10. Metrics (§21)

Every attempt persists role/alias/concrete model/provider/status/first-pass/
tokens/cost/latency/validation/transport-retries. Attempt usage is cumulative
across all provider legs inside one invocation (transport retries included;
`contextTokens` is the max high-water mark), so a final zero-usage leg never
erases earlier spend. Follow-ups resume the same attempt: `attempt.json` holds
cumulative usage while only the newly incurred cost is charged to the daily
budget ledger (prior spend was already recorded). Main-planner usage is captured
separately from Pi lifecycle events at `agent_start`, finalized assistant
`message_end`, and `agent_settled`; this records prompt/completion/cache tokens,
cost, provider/model, and duration in `planner-metrics.json`, the Pi session,
and the `orchestrator:metrics` event bus event. Worker processes do not load the
main extension, preventing double counting. `jobs` action `metrics` and
`Orchestrator.metrics()` expose both planner and per-agent×alias worker totals.
No learned router in V1.

## 11. Transport exhaustion and recovery

Provider-level retries remain inside one attempt. If they exhaust with
`provider_unavailable`/`transport_error`, the job enters explicit, inspectable
`failed` state and no reasoning/model ladder rung is consumed. A process crash leaves a
running attempt; reload marks it `interrupted`, emits `job.interrupted`, and a
fresh retry allocates a new attempt while retaining the interrupted record.

## 12. Runtime API (§24, UI-independent)

`Orchestrator` (core/orchestrator.ts): createJob, listJobs, readJob,
readAttempt, readResult, readArtifact, runJob, runGraph, followupJob, retryJob,
cancelJob, graph, waitJobs, events — the same primitives the pi tools use;
future web/mobile/CI interfaces reuse them directly. Worker execution is an
injectable seam (`config.workerRunner`) used by the deterministic test suite.

## 13. Live agent messaging (phase 2, no tmux)

Workers run in RPC mode, so live messaging rides pi's native extension-UI
subprotocol — the parent broker (`core/broker.ts`) owns correlation and
lifecycle; nothing here spawns shells or multiplexers:

- **Wire protocol** (`core/messaging.ts`): versioned, bounded envelopes
  (`PI-ORCH-MSG:v1:`) for one-way messages (`message_main`) and blocking requests
  (`ask_main`, `ask_user_question`; 2..8 options, optional descriptions,
  `allowCustom`, `timeoutSeconds` 1..900 default 300). Replies are explicit:
  `answered | cancelled | timeout | unavailable | error` — never a fabricated
  answer.
- **Parent broker**: live controls keyed by `jobId+attemptId`; pending requests
  keyed by `jobId+attemptId+rpc.id`, settled EXACTLY ONCE. Messages and request
  lifecycle are durable events in `events.jsonl`; the bounded inbox keeps the
  latest 100 items per job. Per-request deadlines are parent-enforced: the
  pending UI is aborted and settled `timeout` when the deadline fires; worker
  exit settles `cancelled`. Requests from an old process are stale forever —
  late replies reject as unknown/expired.
- **Deadlock-free attention**: `delegate` and `jobs wait` return EARLY with the
  running jobIds and pending requestIds when a worker messages or asks; the
  actual run promise continues, tracked in the background (single flight per
  job; `jobs cancel` and session shutdown own its lifecycle). Later attention
  and background completions reach the main model via deduplicated
  `pi.sendMessage` typed custom messages. The main agent answers with
  `jobs action=reply jobId=<job> requestId=<id> answer="..."`; `jobs
  action=message` steers a live worker (delivery claimed only on steer ACK);
  `jobs action=inbox` lists messages + pending requests. Concurrent runs,
  retries, and follow-ups are rejected while a job's worker is live.
- **User questions**: `ask_user_question` renders ONE interactive popup in the
  main session (options + descriptions, up/down + Enter, typed custom answer,
  Escape cancel, FIFO queue, deadlines honoured even while queued). The same
  component is the main agent's own `ask_user_question` tool, active under
  main lockdown. Headless/no-UI sessions return `unavailable` immediately.
- Job status stays `running` while a worker waits; DAG dependents await the
  actual result.
