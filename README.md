# telegram-bot-docs-skill

An Agent Skill that gives coding agents current, searchable Telegram Bot API and
Mini Apps documentation without loading the full reference into context.

Use it when an agent needs to verify platform behavior, find an exact method or
type, troubleshoot webhooks and payments, validate Mini App data, or answer a
Telegram bot question with a link to the official source.

> Status: beta. The core cache and conversion workflow is tested; installation
> and compatibility feedback is welcome.

## What you get

- Official Bot API, Mini Apps, Bot Features, changelog, FAQ, webhooks, payments,
  Stars, inline mode, and games documentation.
- Roughly 1,000 small Markdown sections instead of a handful of very large HTML
  pages.
- A searchable index that separates methods, types, guides, and changelog entries.
- Freshness checks with a 24-hour default TTL and an explicit live-check mode.
- Source links in every cached section so answers can cite the original page.
- Safe fallback to the last usable cache when a live refresh fails.

The skill covers the Telegram platform itself. It does not replace documentation
for libraries such as grammY, Telegraf, or `@telegram-apps/sdk`.

## Requirements

- Node.js 20 or newer
- Network access to `https://core.telegram.org`
- A writable skill directory for the generated cache

There are no runtime npm dependencies.

## Install

### Codex

Clone the repository to your user skills directory:

```bash
git clone https://github.com/mois-ilya/telegram-bot-docs-skill.git ~/.codex/skills/telegram-bot-docs
```

The resulting directory is:

```text
~/.codex/skills/telegram-bot-docs/
```

This is `$CODEX_HOME/skills/telegram-bot-docs/` when `CODEX_HOME` is set. Codex
discovers the `SKILL.md` automatically. If it does not appear immediately, restart
Codex. You can also ask `$skill-installer` to install this repository.

### Other Agent Skills hosts

Place the repository in the host's user or project skills directory. The host must
be able to run Node.js scripts and allow access to `core.telegram.org`.

## Use

Invoke the skill explicitly:

```text
Use $telegram-bot-docs to verify how MarkdownV2 escaping works.
```

```text
Use $telegram-bot-docs to explain why my bot does not receive every group message.
```

```text
Use $telegram-bot-docs to check how Mini App initData should be validated.
```

The skill can also activate automatically when a request matches its description.

## How it works

On first use, the skill downloads ten official documentation pages, converts them
into small per-section Markdown files, and builds `cache/index.md`. Later uses skip
the network while the freshness TTL is valid. When the TTL expires, the script
checks the live pages and rebuilds only sources that changed.

The generated cache is local and excluded from Git.

Refresh manually:

```bash
node scripts/refresh.mjs
```

Force a live check:

```bash
node scripts/refresh.mjs --max-age 0
```

Use a different cache location:

```bash
node scripts/refresh.mjs --cache-dir /path/to/cache
```

Run `node scripts/refresh.mjs --help` for all options.

## Reliability

A changed page is published only after the converter verifies that it found every
section and preserved the page's text and important Markdown structure, including
tables, links, code blocks, code spans, and media. Updates are staged before they
replace the last usable cache, and each documentation source is refreshed
independently.

The command reports one status per source:

- `fresh` or `refreshed`: safe to use
- `STALE`, exit code 2: the previous cache is usable but could not be verified
- `FATAL`, exit code 1: no usable cache exists for that source

## Development

Run all checks that do not require network access:

```bash
npm test
```

Build a fresh cache from the live Telegram documentation and run the live
regression checks:

```bash
npm run test:live
```

Run both suites:

```bash
npm run test:all
```

Pack the repository, extract it as a clean installation, and verify that the
installed copy can build a complete live cache:

```bash
npm run smoke:install
```

Validate JavaScript syntax:

```bash
npm run check
```

Pushes and pull requests run the offline suite on supported Node.js versions.
A scheduled workflow runs the live and clean-install checks against the current
Telegram documentation.

## Project layout

```text
SKILL.md              agent-facing workflow
agents/openai.yaml    optional Codex UI metadata
reference/basics.md   symptom-to-documentation routing
scripts/refresh.mjs   cache refresher and HTML-to-Markdown converter
cache/                generated local documentation cache
tests/                CLI and converter regression tests
```

## License

The project source is available under the MIT License. This is an independent
community project and is not affiliated with or endorsed by Telegram.
