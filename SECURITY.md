# Security Policy

## Scope and trust model

This package is a **Pi extension**. Installing and loading it grants it the
same permissions as your own shell: it reads and writes files, spawns
subprocesses (worker agents run as isolated `pi` processes), and registers
tools, commands, and providers inside your Pi session. Review the source
before installing third-party packages.

What the orchestrator does by design:

- **Executes local code** — the extension itself and any agent `hooks` it loads
  run on your machine with your user privileges.
- **Spawns worker processes** — each delegated job launches a `pi` subprocess
  with a sanitized environment (only PATH/HOME/proxy settings, the provider API
  keys needed by the configured models, and explicit per-job variables).
- **Persists job data locally** — job records, worker transcripts, results,
  artifacts, and planner metrics are written under `~/.pi/orchestrator/`
  (and worktrees under `<repo>/.pi-worktrees/`). This may contain your task
  content, code, and provider usage. Files and directories are written with
  private permissions where the OS supports it.

## Provider credentials

The orchestrator never stores API keys in its config files. Credentials are
supplied through your existing Pi provider configuration and environment
variables (e.g. `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`), referenced from
`~/.pi/orchestrator/models.yaml` only by *environment variable name*
(`apiKeyEnv`). Never put literal tokens into `models.yaml`, `config.yaml`, or
agent `AGENT.md` files.

## Reporting a vulnerability

Please report security issues responsibly via
[GitHub private vulnerability reporting](https://github.com/nathanloisel/pi-multi-agent-orchestrator/security/advisories/new)
if enabled; otherwise open a minimal issue without sensitive details and
contact the maintainer to coordinate disclosure. Do not include secrets,
tokens, or private session data in public issues.
