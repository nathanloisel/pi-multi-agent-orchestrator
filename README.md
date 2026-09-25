# Pi Multi-Agent Orchestrator

A [Pi](https://pi.dev) extension that turns your main agent into a planner. It gives pieces of work to worker agents and combines their results.

Workers run in their own Pi sessions with their own models; independent jobs run in parallel, and a failed job can be retried with a stronger model. The planner delegates — it does not edit files or run commands itself.

## Install

Requires [Pi](https://pi.dev) and Node 22+.

```bash
pi install git:github.com/nathanloisel/pi-multi-agent-orchestrator
```

## Set up

Start `pi` and run:

```
/orchestrator-init
```

This creates `~/.pi/orchestrator/config.yaml` (limits and settings), `~/.pi/orchestrator/models.yaml` (model choices), and three worker profiles in `~/.pi/agents/`: `coder`, `researcher`, and `vision`. Existing files are never overwritten.

Edit `~/.pi/orchestrator/models.yaml` to use models you have already configured in Pi. Names such as `worker-cheap`, `worker-best`, and `frontier` are labels for those models. Run `pi --list-models` in your terminal to see available models. The `vision` worker needs a model that accepts images.

Now create `~/.pi/agents/main/AGENT.md` — this profile is what activates the orchestrator:

```markdown
---
name: main
role: main
---
Plan the work, delegate focused tasks, and check the results.
```

Run `/reload`, then `/agents` to check the loaded agents and models.

## Use

Ask your main agent as you would ask a colleague:

> Find why the tests fail, fix the cause, and run them again.

It picks suitable workers, runs the jobs, tracks them, and reports the results. While jobs run, a live progress display above the editor shows job state in real time. You can also ask "Show current jobs" or "Retry the failed job".

## Pi version compatibility

This extension is validated against real pi releases, not just the version in
your lockfile:

- **Baseline (lockfile):** pi `0.85.1` — what `npm ci` installs for local dev.
- **Current target:** pi `0.87.0` — required to pass before releases.
- **Latest canary:** `latest` runs weekly in CI and on every manual dispatch;
  a new pi that breaks this extension turns that job red (no allow-failure).

CI runs the suite on a Node 22/24 × pi version matrix (`0.85.1`, `0.87.0`,
`latest`) and prints the versions actually tested. The npm dependency and the
`pi` binary you interact with are different things: the lockfile pins the
installed `@earendil-works/pi-coding-agent` package, while the global `pi`
command comes from your own install and can be newer.

To test a specific pi version locally without touching the manifest or the
reproducible baseline lockfile:

```bash
npm ci                                   # reproducible baseline (0.85.1)
npm run pi:test-version -- 0.87.0        # overlay node_modules with pi 0.87.0 + matching peers
npm run release:check                    # typecheck + tests against 0.87.0
npm run pi:test-version -- latest        # or the newest published release
npm run release:check
npm ci                                   # back to the baseline lock
```

The overlay script resolves the selected release and installs its own declared
peer versions (`pi-ai`, `pi-tui`, `typebox`) with `--no-save
--package-lock=false`, so peer versions always match the selected pi instead of
assuming one shared version.

Compatibility policy: the tests launch the real pi CLI in RPC mode (isolated
temp environment, no model calls, no spend) and assert the public surfaces this
extension uses — slash-command registration, tool registration/activation, and
the native extension-UI envelopes. Optional UI affordances already guard with
`hasUI`/`ctx.mode` capability checks rather than version branches; keep it that
way for new optional APIs. There is no universal future guarantee: a breaking
future pi requires a maintenance release, and the `latest` canary exists to
surface that immediately.

## Live messaging (no tmux)

Workers are normal Pi sessions in RPC mode, so the orchestrator wires their live
tools straight into the main session — no multiplexer, no background shells:

- **message_main** (worker → main): one-way progress notes and findings. The main
  agent sees them as typed messages while the worker keeps going.
- **ask_main** (worker → main, blocking): the worker is stuck on a question only
  the main agent can answer. The running `delegate`/`jobs wait` call returns early
  with the pending `requestId`; the main agent answers with
  `jobs action=reply jobId=<job> requestId=<id> answer="..."` and the worker
  resumes with the answer. Unanswered requests time out explicitly (default 300s).
- **ask_user_question** (worker → user): a decision only you can make pops up in
  the main session — options with descriptions, arrow keys + Enter, a typed
  answer when `allowCustom` is true, and Escape to cancel. It shows the asking
  job and agent. The main agent also has this tool directly.
- **jobs action=message** steers a live worker (delivery is confirmed only when
  the worker accepts it); **jobs action=inbox** lists live messages and pending
  requests; **jobs action=cancel** aborts a running job.

A job keeps its `running` state while a worker waits for an answer, and dependent
jobs still wait for the real result. In headless runs (no UI) questions return
`unavailable` immediately instead of hanging; timeouts and cancellations are
always explicit — a worker never receives a fabricated answer.

## Checkpoint mailbox (persisted peer messages)

Alongside live messaging, workers can exchange bounded, persisted peer
messages — a separate surface that survives restarts:

- **mailbox_send**(toJobId, body) persists a short message (body ≤ 4 KiB) for a
  specific peer job; the sender identity comes from the trusted spawn
  environment, never from tool parameters.
- **mailbox_read**() returns the worker's own bounded inbox (8 by default, 32
  max, 16 KiB of bodies per batch) and acknowledges exactly the batch it
  returns — a consuming read.
- Delivery happens at the between-turn checkpoint: pending messages are handed
  over when a worker checkpoints, injected as untrusted peer evidence (claims
  from a peer job — never instructions), with a bounded continuation budget.
  Receipts are acknowledged only after the enqueue succeeds, so delivery is
  bounded at-least-once: a crash can re-deliver a batch as a duplicate, never
  drop one.
- **jobs action=messages** lets the orchestrator inspect a job's stored mailbox
  read-only (never consumed).

Use messages for concrete blockers, interface questions, and discoveries a peer
job needs — never for wholesale work handoff. The live messaging tools above
and the mailbox coexist: live tools answer now, the mailbox persists and
delivers at checkpoints.

## Approach

Use a strong model for planning and cheaper models for focused tasks. Keep tasks separate and check results before moving on. Slice work into the smallest independently verifiable outcomes (each ending in a concrete check); split jobs only when the parallel gain outweighs the coordination cost. Dependency handoffs and mailbox messages are evidence only — code integration stays a named responsibility, followed by one final end-to-end validation.

Workers run on your machine with your permissions — this is not a security sandbox (see [SECURITY.md](./SECURITY.md)). More detail: [PROTOCOL.md](./PROTOCOL.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).
