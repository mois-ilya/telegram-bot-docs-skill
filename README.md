# telegram-docs

Portable Agent Skill providing freshness-checked official Telegram documentation
(Bot API + Mini Apps) as small per-section Markdown files instead of large HTML pages.

The skill follows the portable `SKILL.md` Agent Skills layout and contains no
client-specific workflow instructions. It can be used by skills-compatible agents
that can run Node.js scripts and access `core.telegram.org`, including Claude Code
and Codex.

## Why

Telegram publishes the Bot API and Mini Apps references as large human-oriented HTML
pages. Loading them into an agent's context is expensive, while answering from model
memory is often stale. This skill builds a local searchable Markdown cache and checks
it against the official pages within a configurable TTL window (24 hours by default;
use `--max-age 0` for a live check).

## Freshness model

`scripts/refresh.mjs`:

1. Skips the network within the TTL.
2. Otherwise downloads both official pages and compares a SHA-256 hash of their
   documentation content regions.
3. Rebuilds per-section Markdown and `cache/index.md` only when needed.
4. Reports `STALE` with exit code 2 when an existing cache cannot be checked, and
   `FATAL` with exit code 1 when no usable cache exists.

## Distribution model

This repository does **not** redistribute Telegram documentation. Generated cache
contents are ignored by Git; each installation downloads and builds its own private
cache from the official Telegram documentation pages. Only `cache/.gitkeep` is
distributed so the directory exists immediately after installation.

## Layout

```text
SKILL.md            portable agent-facing workflow
scripts/refresh.mjs dependency-free Node.js refresher and converter
cache/.gitkeep      preserves the generated-cache directory in Git
cache/*             generated locally and not distributed
tests/              offline regression and CLI tests
```

## Requirements and usage

Requires Node.js 20 or newer. There are no npm runtime dependencies.

From any working directory, resolve the installed skill directory and run:

```bash
node <path-to-telegram-docs>/scripts/refresh.mjs
```

Run `node scripts/refresh.mjs --help` from the repository for all CLI options. Run
`npm test` for the offline test suite.

## License and attribution

The repository license covers the skill instructions and source code only. Generated
cache files come from the official Telegram documentation and are not distributed.
This project is independent and is not affiliated with or endorsed by Telegram.
