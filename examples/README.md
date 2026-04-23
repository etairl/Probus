# Examples

Short snippets showing how to drive probus.

## Scan a repo you're working on

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
probus scan ../my-webapp
```

## Wider sweep

The analyst normally picks ~50 files. For a larger codebase, bump `--effort`:

```bash
probus scan ../big-monorepo --effort high
```

## Review past findings

No re-scan, just open the browser over findings already on disk:

```bash
probus view ../my-webapp
```

## Pick your models

Any OpenRouter slug works. The researcher is the expensive one — pick a model
strong at reading code. The QA can be cheaper/faster since it's a verifier.

```bash
probus scan ../my-webapp \
  --effort medium \
  anthropic/claude-sonnet-4.6 \
  anthropic/claude-opus-4.7
```

## CI integration (sketch)

probus exits non-zero on fatal errors but currently always exits 0 after a
successful scan even when findings are present. For a gate, parse
`output/<slug>/findings/*.json` and fail the job when any finding has
`verified: true`. Full CI support is on the roadmap.
