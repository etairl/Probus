# probus

> Agentic security scanner for source-code repos. Three specialised LLM agents — an analyst, a researcher, and a QA — collaborate to find, verify, and write up vulnerabilities. Live terminal UI. Any model OpenRouter supports.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)
[![CI](https://github.com/ItayRosen/Probus/actions/workflows/ci.yml/badge.svg)](https://github.com/ItayRosen/Probus/actions/workflows/ci.yml)

![Probus scanning a repo](./docs/screenshot.png)

---

## What it does

probus points three agents at a git repo:

1. **Analyst** — reads the codebase, picks ~50–500 files worth scanning (entry points, third-party surface, dangerous sinks).
2. **Researcher** — opens each file, digs through its imports and callers, and writes raw findings as structured JSON.
3. **QA** — independently verifies each finding against the source, discards false positives, and writes a Markdown report for every real vulnerability.

Output lands in `output/<repo-slug>/` — one JSON per file, one Markdown report per verified finding, and a per-file debug log so you can audit what the agents actually did.

Everything runs through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), pointed at [OpenRouter](https://openrouter.ai) so you can mix and match Claude, Qwen, Kimi, or any other supported model.

## Quick start

```bash
npm install -g probus    # or: npx probus ...
probus scan ./my-app
```

First run will prompt for your OpenRouter API key and save it to `~/.probus/.env` (chmod 600).

### Local dev

```bash
git clone https://github.com/ItayRosen/Probus
cd probus
nvm use && npm install
export OPENROUTER_API_KEY=sk-or-v1-...
npm run dev -- scan ../some-repo
```

## Usage

```text
probus scan <repo-path> [--effort low|medium|high] [--researchModel slug] [--qaModel slug] [--provider openai|openrouter|anthropic]
probus view <repo-path>
```

### Commands

| Command  | What it does                                                             |
| -------- | ------------------------------------------------------------------------ |
| `scan`   | Full pipeline: analyst → researcher → QA, then drops you into the browser. |
| `view`   | Skip straight to the report browser for a previously-scanned repo.         |

### `--effort`

Controls how many files the analyst targets:

| Effort        | Files (approx) |
| ------------- | -------------- |
| `low` (default) | 50             |
| `medium`        | 100            |
| `high`          | 500            |

### Models

Pass models as `<provider>/<model>` slugs via `--researchModel` and `--qaModel`:

```bash
probus scan ./app --effort medium \
  --researchModel anthropic/claude-sonnet-4.6 \
  --qaModel anthropic/claude-opus-4.7
```

Defaults are picked from whichever `*_API_KEY` env var is set
(precedence: `OPENROUTER_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY`);
use `--provider` to override when multiple keys are present.

| Provider     | Researcher default            | QA default                       |
| ------------ | ----------------------------- | -------------------------------- |
| `openrouter` | `openrouter/qwen/qwen3.6-plus` | `openrouter/anthropic/claude-opus-4.7` |
| `openai`     | `openai/gpt-5.4-mini`          | `openai/gpt-5.4`                       |
| `anthropic`  | `anthropic/claude-sonnet-4.6`  | `anthropic/claude-opus-4.7`            |

## Keybindings

**Scanning phase**
- `↑` / `↓` / `j` / `k` — scroll the file list
- `s` — skip the current file
- `q` — quit

**Browser phase**
- `↑` / `↓` / `j` / `k` — navigate findings (sorted by severity)
- `↵` / `→` / `l` — open the Markdown report
- `←` / `h` / `Esc` — collapse
- `q` — quit

## Output layout

```
output/<repo-slug>/
├── analysis.json           # file list picked by the analyst
├── findings/
│   └── src__foo__bar.ts.json   # per-file findings (verified + unverified)
├── reports/
│   └── src__foo__bar.ts--1.md  # one Markdown report per verified finding
├── debug/
│   └── src__foo__bar.ts.log    # full agent transcript per file
└── processed-files.txt     # cache so reruns skip finished files
```

`<repo-slug>` is `<basename>-<sha1(abspath)[:8]>` so the same repo never collides with another.

## Architecture

```
┌────────────┐   files[]   ┌──────────────┐  findings[]  ┌──────────┐
│  Analyst   │────────────▶│  Researcher  │─────────────▶│   QA     │
│  (1 call)  │             │  (per file)  │              │ (per file)│
└────────────┘             └──────────────┘              └─────┬────┘
                                                               │
                                                               ▼
                                                       reports/*.md
```

All three run as isolated `query()` sessions through the Claude Agent SDK, each with its own filesystem sandbox scoped to the repo being scanned.

## Configuration

probus reads, in order:
1. `process.env.OPENROUTER_API_KEY`
2. `~/.probus/.env`
3. Interactive prompt (scan mode only) — saves to `~/.probus/.env`

## Safety

probus is an agentic tool that:
- Reads the entire repo you point at (sent in chunks to the model provider).
- Executes shell/fs tool calls inside the agent sandbox.
- Writes reports to the host filesystem.

**Do not scan third-party repos you don't own or have permission to audit.** Review OpenRouter's (or your chosen provider's) data policy before scanning repos with secrets or PII. See [SECURITY.md](./SECURITY.md).

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, scripts, and conventions.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
