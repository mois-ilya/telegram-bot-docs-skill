# Telegram Bot Docs for AI agents

Telegram's bot documentation is authoritative, but its largest pages contain
hundreds of methods, types, examples, and changelog entries. Loading them whole
wastes an agent's context; relying on model memory risks missing a recent change.

This Agent Skill turns ten official pages into about 1,000 small searchable
sections and keeps them in a freshness-checked local cache. The agent reads only
the sections it needs, then links its answer back to `core.telegram.org`.

> **Beta:** the documentation pipeline, clean installation, and Claude
> Code/Codex compatibility are tested. Feedback from real projects is welcome.

## Quick start

You need Node.js 20 or newer, network access to `core.telegram.org`, and a
writable skill directory. The skill has no runtime npm dependencies.

Install the skill with the cross-agent Skills CLI:

```bash
npx skills add mois-ilya/telegram-bot-docs-skill --skill telegram-bot-docs
```

The installer detects supported agents in the current project. You can also
name the targets explicitly:

```bash
npx skills add mois-ilya/telegram-bot-docs-skill \
  --skill telegram-bot-docs \
  --agent claude-code codex gemini-cli opencode
```

Prefer a direct clone? Jump to [Manual installation](#manual-installation).

Start a new agent session after installation, then ask a Telegram platform
question as you normally would:

```text
Check how Mini App initData should be validated against the official documentation.
```

Or invoke the skill explicitly:

| Host | Example |
|---|---|
| Claude Code | `/telegram-bot-docs Why does my bot miss some group messages?` |
| Codex | `Use $telegram-bot-docs to verify MarkdownV2 escaping.` |
| Other Agent Skills hosts | Use the host's skill invocation syntax or ask naturally. |

## What it covers

The cache includes:

- Bot API methods and types;
- Mini Apps and `initData` validation;
- bot features, BotFather, commands, deep links, and privacy mode;
- webhooks, certificates, update delivery, and troubleshooting;
- payments, Telegram Stars, subscriptions, and paid media;
- inline mode and games;
- the Bot API changelog and FAQ.

The skill documents the Telegram platform itself. It does not replace the
documentation for grammY, Telegraf, `@telegram-apps/sdk`, or another library.
For a framework-specific question, use that framework's documentation and this
skill together to verify the underlying Telegram behavior.

## How freshness works

The first request downloads the official pages and builds a local index plus one
Markdown file per section. Later requests reuse that cache for 24 hours, so
normal lookups are fast and offline. After the TTL expires, the skill checks the
live pages and rebuilds only sources whose content changed.

A failed update never replaces the last valid cache. New content is staged and
published only after the converter verifies text coverage, section counts,
links, tables, code blocks, and other important structure.

## Compatibility

The core workflow is host-neutral. The installation matrix covers Claude Code,
Codex, Gemini CLI, and OpenCode; direct runtime smoke tests cover Claude Code and
Codex. Other Agent Skills hosts can use the same folder as long as they can run
Node.js and write the generated cache.

## Manual installation

If you prefer not to use the Skills CLI, clone the repository into the host's
skills directory. Keep the destination folder name exactly
`telegram-bot-docs`.

Claude Code:

```bash
git clone https://github.com/mois-ilya/telegram-bot-docs-skill.git \
  ~/.claude/skills/telegram-bot-docs
```

Codex:

```bash
git clone https://github.com/mois-ilya/telegram-bot-docs-skill.git \
  ~/.codex/skills/telegram-bot-docs
```

When `CODEX_HOME` is set, use `$CODEX_HOME/skills/telegram-bot-docs` instead.

## Cache maintenance

Normal use needs no maintenance. To refresh manually, run:

```bash
node scripts/refresh.mjs
```

Use `--max-age 0` to force a live check regardless of cache age. The command
reports each source separately: `fresh` or `refreshed` is ready to use, `STALE`
keeps the previous cache but could not verify it, and `FATAL` means that source
has no usable cache.

## Development

The fast suite is offline and runs on every pull request:

```bash
npm test
```

Additional checks exercise the live Telegram pages, a clean packaged install,
and the supported host layouts:

```bash
npm run test:live
npm run smoke:install
npm run test:portability
npm run smoke:hosts
```

The `main` branch is protected by the offline, packaging, portability, and
cross-agent installation checks. A scheduled workflow runs the live regression
and clean-install tests so changes on Telegram's side are detected even when the
repository is quiet. Together these checks verify the Agent Skills contract,
published package, relocated execution, Claude Code and Codex paths, the
universal `.agents/skills` path, and installation through the pinned Skills CLI.

## Repository map

```text
SKILL.md              agent-facing workflow
agents/openai.yaml    optional OpenAI UI metadata
reference/basics.md   maps user symptoms to official Telegram concepts
scripts/refresh.mjs   fetches, verifies, and converts the documentation
cache/                generated local documentation; not committed
tests/                converter, packaging, live, and portability tests
```

## License

MIT. This is an independent community project and is not affiliated with or
endorsed by Telegram.
