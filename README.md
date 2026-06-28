# probus

> Open-source AI vulnerability scanner powered by open models.

[![npm version](https://img.shields.io/npm/v/probus.svg)](https://www.npmjs.com/package/probus)
[![npm downloads](https://img.shields.io/npm/dt/probus.svg)](https://www.npmjs.com/package/probus)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)
[![CI](https://github.com/ItayRosen/Probus/actions/workflows/ci.yml/badge.svg)](https://github.com/ItayRosen/Probus/actions/workflows/ci.yml)

![Probus scanning a repo](./docs/screenshot.png)

---

Probus started as an internal supply chain security scanning tool that proved itself extremely efficient by finding vulnerabilities in top open source packages (e.g. n8n, AI sdk, langraphjs and more). It is now open-source to help developers better secure their codebase & supply chain. Probus' edge lies in its ability to scale its scanning capabilities with open models (by using OpenRouter).

## What it does

Probus harnesses 3 agents that:

- [Analyst] Analyze the codebase and pick key files for deep scanning (e.g. entry points, third-party surface, dangerous sinks).
- [Researcher] Scan each file, dig through its chains of calls, and write raw findings (potential vulnerabilities).
- [QA] Independently verify each finding, make sure it has a real attack vector, and write a report.

![Per-finding report with vulnerable code, attack path, and a one-click Fix → PR action](./docs/report.png)

## Quick start

```bash
npm install -g probus
probus
```

`probus` launches a local web server, opens your browser to it, and from there you:

- pick a repo to scan,
- enter / pick a model-provider API key,
- watch a live dashboard of the analyst → researcher → QA pipeline,
- and browse verified findings as polished markdown reports.

No CLI flags, no scan/view subcommands — everything happens on the page. The only options are launcher flags:

```text
probus [--port <N>] [--no-open]
```

| Flag         | Default | What it does                                          |
| ------------ | ------- | ----------------------------------------------------- |
| `--port`     | random  | Pin the local server port (otherwise picks a free one) |
| `--no-open`  | open    | Skip auto-opening the browser; just print the URL      |

## Model providers

Probus runs most (cost) effectively with open models using [OpenRouter](https://openrouter.ai). It is still possible however to use other providers, such as [OpenAI](https://openai.com) or [Anthropic](https://anthropic.com), albeit with higher costs.

You configure providers and keys directly in the web UI's **Settings** tab (or inline on the **New scan** screen). Keys are stored at `~/.probus/.env` (chmod 600) and never leave the machine.

### Defaults per provider

When you don't pass model overrides, these are the picks:

| Provider     | Primary default                | Secondary default                     |
| ------------ | ------------------------------ | ------------------------------------- |
| `openrouter` | `openrouter/qwen/qwen3.7-plus`  | `openrouter/z-ai/glm-5.2`             |
| `openai`     | `openai/gpt-5.4-mini`          | `openai/gpt-5.4`                      |
| `anthropic`  | `anthropic/claude-sonnet-4-6`  | `anthropic/claude-opus-4-7`           |

### Effort levels

Each scan picks an effort level that caps the number of files the analyst targets:

| Effort     | Files (approx) |
| ---------- | -------------- |
| `low`      | 50             |
| `medium`   | 100            |
| `high`     | 500            |

## Cost

Probus splits work between two models so you only pay premium rates where it matters:

- **Primary** (~90% of tokens) — runs on every file. Pick something cheap and fast: `qwen3.7-plus`, `gpt-5.4-mini`, `sonnet-4.6`.
- **Secondary** (~10% of tokens) — verifies findings. Pick something smarter: `glm-5.2`, `qwen3.7-max`, `gpt-5.4`, `opus-4.7`.

Each file consumes roughly **1M input tokens**. Approximate per-file cost by provider:

| Provider                   | Cost / file | vs. open models |
| -------------------------- | ----------- | --------------- |
| `openrouter` (open models) | ~$0.50      | 1× (baseline)   |
| `openai`                   | ~$1.25      | ~2.5×           |
| `anthropic`                | ~$5.00      | ~10×            |

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, scripts, and conventions.

## Development

### Local dev

```bash
git clone https://github.com/ItayRosen/Probus
cd probus
nvm use && npm install
npm run dev          # one command: Vite HMR for web/, tsx-watch reload for src/
```

`npm run dev` boots the server on `:9091` in dev mode — backend changes hot-reload via `tsx watch`, frontend changes hot-reload via Vite middleware. No build step needed during iteration.

For a production-mode local run (serving the prebuilt bundle from `dist/web`):

```bash
npm run build && npm start
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
