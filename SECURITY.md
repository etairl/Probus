# Security Policy

## Reporting a Vulnerability in probus

If you believe you've found a security issue in this tool itself (not in a repo
you scanned with it), please **do not** open a public GitHub issue.

Instead, open a [private security advisory][adv] on GitHub, or email the
maintainers listed in `package.json`.

We'll acknowledge within a few business days and work with you on a fix and
disclosure timeline.

[adv]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## Responsible use

probus scans source code you have permission to analyze. Do not point it at
third-party repositories without the owner's consent. The tool runs agentic LLM
calls that may read files, execute shell commands (via the agent sandbox), and
produce reports — use the `--effort low` default on untrusted code until you
understand what the analyst is doing.

Scanned content (including any secrets or PII in your repo) is sent to the
configured model provider (default: OpenRouter). Review that provider's data
policies before scanning sensitive code.
