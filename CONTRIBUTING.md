# Contributing to probus

Thanks for your interest! This doc gets you from `git clone` to a passing PR.

## Dev setup

```bash
git clone https://github.com/<your-fork>/probus.git
cd probus
nvm use         # uses .nvmrc (Node 20)
npm install
```

## Run it locally

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
npm run dev -- scan ../some-repo
```

Or `npm run dev -- view ../some-repo` to browse prior findings.

## Scripts

| Command           | What it does                                        |
| ----------------- | --------------------------------------------------- |
| `npm run dev`     | Run the CLI with `tsx` (no build step)              |
| `npm run build`   | Compile TypeScript to `dist/`                       |
| `npm test`        | Run the `vitest` suite                              |
| `npm run typecheck` | `tsc --noEmit` — CI runs this                      |

## Before opening a PR

1. `npm run typecheck` — no errors.
2. `npm test` — all green.
3. Keep PRs focused. One concern per PR.
4. Add/update tests when you change `src/scanner.ts` pure helpers, `src/env.ts`, or `src/cli.ts`.

## Architecture sketch

```
CLI (src/cli.ts + src/index.tsx)
   │
   ▼
Ink UI (src/ui/App.tsx) — phases: api-key → analyst → scanning → browse
   │
   ▼
Pipeline (src/scanner.ts)
   ├─ Analyst   : picks files to inspect
   ├─ Researcher: raw findings per file
   └─ QA        : verifies + writes markdown reports
   │
   ▼
Claude Agent SDK → OpenRouter (any supported model)
```

Output lives in `output/<repo-slug>/` — findings JSON, markdown reports, per-file debug logs.

## Reporting security issues

Please see [SECURITY.md](./SECURITY.md). Don't open public issues for suspected vulnerabilities in probus itself.

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
