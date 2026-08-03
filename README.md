# telegram-docs

Portable Agent Skill providing freshness-checked official Telegram bot documentation
as small per-section Markdown files instead of large HTML pages. Covers the Bot API
and Mini Apps references plus the guide pages under `core.telegram.org/bots`:
features, changelog, webhooks, payments, Stars, inline mode, games and the FAQ —
~970 sections across ten sources.

The skill follows the portable `SKILL.md` Agent Skills layout and contains no
client-specific workflow instructions. It can be used by skills-compatible agents
that can run Node.js scripts and access `core.telegram.org`, including Claude Code
and Codex.

## Why

Telegram publishes its bot documentation as large human-oriented HTML pages. Loading
them into an agent's context is expensive, while answering from model memory is often
stale. This skill builds a local searchable Markdown cache and checks it against the
official pages within a configurable TTL window (24 hours by default; use
`--max-age 0` for a live check).

Reference material alone is not enough: much of what breaks a bot in practice — privacy
mode, rate limits, deep linking, webhook certificates — lives in the guide pages, not
in the method reference. Those are cached too, and `reference/basics.md` maps how users
describe a symptom onto the official term needed to find it.

## Freshness model

`scripts/refresh.mjs`:

1. Skips the network within the TTL.
2. Otherwise downloads each official page and compares a SHA-256 hash of its
   documentation content region. Sources are independent: one page failing to verify
   never blocks the others.
3. Rebuilds per-section Markdown and `cache/index.md` only when needed.
4. Reports `STALE` with exit code 2 when an existing cache cannot be checked, and
   `FATAL` with exit code 1 when no usable cache exists.

Two guards decide whether a rebuild may be published. The heading guard refuses when
the number of parsed sections does not match the number of headings on the page. The
body-fidelity guard compares the visible text of each section's HTML against the
Markdown produced from it and refuses when a section lost more than 15% of it. The
first proves every section was found, the second proves each was carried over whole —
without it a converter that silently drops part of a body still reports `fresh`,
which is the only way this cache could mislead without a visible symptom.

## Distribution model

This repository does **not** redistribute Telegram documentation. Generated cache
contents are ignored by Git; each installation downloads and builds its own private
cache from the official Telegram documentation pages. Only `cache/.gitkeep` is
distributed so the directory exists immediately after installation.

## Layout

```text
SKILL.md            portable agent-facing workflow
reference/basics.md hand-maintained symptom-to-section routing (not freshness-checked)
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
