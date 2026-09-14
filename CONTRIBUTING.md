# Contributing

Thanks for your interest in improving the Pi Multi-Agent Orchestrator.

## Development setup

Requirements: Node 22+ and npm.

```bash
git clone https://github.com/nathanloisel/pi-multi-agent-orchestrator.git
cd pi-multi-agent-orchestrator
npm install
```

Try the extension against your Pi install without committing to it:

```bash
pi -e /path/to/pi-multi-agent-orchestrator
```

## Validate before opening a PR

```bash
npm run typecheck   # strict TypeScript, no emit
npm test            # full node:test suite (deterministic, no network)
```

CI runs both on maintained Node LTS versions. Please include the same checks
with your PR.

## Guidelines

- Keep the architecture described in [PROTOCOL.md](./PROTOCOL.md). The
  orchestrator core must stay UI-independent and transport-agnostic.
- Keep everything deterministic in tests: no network calls, no real provider
  spend, no reliance on machine-specific paths — use temp roots and injectable
  worker runners (see `tests/helpers.ts`).
- New behavior needs tests. Bug fixes need a regression test.
- Template files under `templates/` must stay generic: no personal paths,
  tokens, or private prompts.
- Sanitized, precise changes only — one logical change per PR.

## Reporting issues

Open a GitHub issue with the Pi version (`pi --version`), Node version, and a
minimal reproduction. For security concerns, see [SECURITY.md](./SECURITY.md).
