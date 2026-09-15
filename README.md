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

## Approach

Use a strong model for planning and cheaper models for focused tasks. Keep tasks separate and check results before moving on.

Workers run on your machine with your permissions — this is not a security sandbox (see [SECURITY.md](./SECURITY.md)). More detail: [PROTOCOL.md](./PROTOCOL.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).
