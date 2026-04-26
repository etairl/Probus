# probus

> Open-source AI vulnerability scanner powered by open models.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)
[![CI](https://github.com/ItayRosen/Probus/actions/workflows/ci.yml/badge.svg)](https://github.com/ItayRosen/Probus/actions/workflows/ci.yml)

![Probus scanning a repo](./docs/screenshot.png)

---

I created this project after finding (and reporting) vulnerabilities in my chain of dependencies (n8n, AI sdk, langraphjs and more), to help other developers better secure their code before a malicious actor takes advantage.

## What it does

Probus harnesses 3 agents that:

- [Analyst] Analyze the codebase and pick key files for deep scanning (e.g. entry points, third-party surface, dangerous sinks).
- [Researcher] Scan each file, dig through its chains of calls, and write raw findings (potential vulnerabilities).
- [QA] Independently verify each finding, make sure it has a real attack vector, and write a report.

## Quick start

```bash
npm install -g probus
probus scan ./my-app
```

## Model providers

Probus runs most (cost) effectively with open models using [OpenRouter](https://openrouter.ai). It is still possible however to use other providers, such as [OpenAI](https://openai.com) or [Anthropic](https://anthropic.com), albeit with higher costs.

## Usage

```text
probus scan <repo-path> [--effort low|medium|high] [--primaryModel slug] [--secondaryModel slug] [--provider openai|openrouter|anthropic]
probus view <repo-path>
```

### Commands

| Command | What it does                                                       |
| ------- | ------------------------------------------------------------------ |
| `scan`  | Full pipeline: analyst → research → qa.                            |
| `view`  | Skip straight to the report browser for a previously-scanned repo. |

### `--effort`

Controls how many files the analyst targets:

| Effort          | Files (approx) |
| --------------- | -------------- |
| `low` (default) | 50             |
| `medium`        | 100            |
| `high`          | 500            |

### `--primaryModel` / `--secondaryModel`

Pass models as `<provider>/<model>` slugs via `--primaryModel` and `--secondaryModel`:

```bash
probus scan ./app --effort medium \
  --primaryModel anthropic/claude-sonnet-4.6 \
  --secondaryModel anthropic/claude-opus-4.7
```

Defaults are picked from whichever `*_API_KEY` env var is set
(precedence: `OPENROUTER_API_KEY` → `OPENAI_API_KEY` → `ANTHROPIC_API_KEY`);
use `--provider` to override when multiple keys are present.

| Provider     | Primary default                | Secondary default                     |
| ------------ | ------------------------------ | ------------------------------------- |
| `openrouter` | `openrouter/qwen/qwen3.6-plus` | `openrouter/deepseek/deepseek-v4-pro` |
| `openai`     | `openai/gpt-5.4-mini`          | `openai/gpt-5.4`                      |
| `anthropic`  | `anthropic/claude-sonnet-4-6`  | `anthropic/claude-opus-4-7`           |

## Cost

Probus splits work between two models so you only pay premium rates where it matters:

- **Primary** (~90% of tokens) — runs on every file. Pick something cheap and fast: `qwen3.6`, `gpt-5.4-mini`, `sonnet-4.6`.
- **Secondary** (~10% of tokens) — verifies findings. Pick something smarter: `deepseek-v4-pro`, `gpt-5.4`, `opus-4.7`.

Each file consumes roughly **1M input tokens**. Approximate per-file cost by provider:

| Provider     | Cost / file | vs. open models |
| ------------ | ----------- | --------------- |
| `openrouter` (open models) | ~$0.50  | 1× (baseline)   |
| `openai`                   | ~$1.25  | ~2.5×           |
| `anthropic`                | ~$5.00  | ~10×            |

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, scripts, and conventions.

## Development

### Local dev

```bash
git clone https://github.com/ItayRosen/Probus
cd probus
nvm use && npm install
export OPENROUTER_API_KEY=sk-or-v1-...
npm run dev -- scan ../some-repo
```

### Architecture

```
┌────────────┐   files[]   ┌──────────────┐  findings[]  ┌───────────┐
│  Analyst   │────────────▶│   Primary    │─────────────▶│ Secondary │
│  (1 call)  │             │  (per file)  │              │ (per file)│
└────────────┘             └──────────────┘              └─────┬─────┘
                                                               │
                                                               ▼
                                                       reports/*.md
```

All three run as isolated `query()` sessions through the Claude Agent SDK, each with its own filesystem sandbox scoped to the repo being scanned.

### Output layout

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

## License

Apache 2.0 — see [LICENSE](./LICENSE).
