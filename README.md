# telegram-docs

Portable Agent Skill providing freshness-checked official Telegram bot documentation
as small per-section Markdown files instead of large HTML pages. Covers the Bot API
and Mini Apps references plus the guide pages under `core.telegram.org/bots`:
features, changelog, webhooks, payments, Stars, inline mode, games and the FAQ —
~980 sections across ten sources.

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

Freshness tracks the converter as well as the page. Each entry in `cache/meta.json`
records a hash of `scripts/refresh.mjs`, so editing the converter invalidates every
cached page automatically on the next run — a cache built by an older, buggier build
can never stay marked `fresh`, and applying a fix never depends on someone remembering
to pass `--force`.

Guards decide whether a rebuild may be published, and each catches what the previous
ones cannot. All of them have been observed firing on a deliberately reintroduced
defect — a guard never seen red is not a guard:

1. **Headings** — refuses when the number of parsed sections does not match the number
   of headings on the page. Proves every section was *found*.
2. **Body fidelity** — compares the visible text of each section's HTML against the
   Markdown produced from it, refusing when a section lost more than 15%. Proves each
   section was carried over *whole*.
3. **Block structure** — counts tables, code blocks and table *rows* on both sides.
   Text volume cannot see a table flattened into a paragraph or a code block mashed
   into prose: every character survives while the rows, columns and fences are
   destroyed. Rows are compared exactly rather than by ratio, because across 573
   sections containing tables the Markdown line count equals `<tr>` plus one
   separator per table with no exceptions. Counting whole tables alone let a single
   dropped row through, which once deleted a 95-row table's header and promoted the
   first data row into its place — still valid Markdown, no longer true.
4. **Inline categories** — compares link and code-span counts page-wide. When a tag
   pattern stops matching, an entire category disappears at once rather than
   gradually, and nothing above can see it: link targets are excluded from the text
   comparison by design, and emphasis and backticks are punctuation no character
   count weighs. These thresholds are deliberately loose; they detect catastrophe,
   not attrition.
5. **Conservation of mass** — weighs the whole page against everything written out,
   byte-exactly for splitter coverage and by ratio for converted text. Guards 2 and 3
   compare section bodies against section bodies, so neither can see content that
   ended up in *no* section — which is how the intro of every page went missing
   undetected through two full audits. This is the only guard that closes that gap.

Without them a converter that silently drops or flattens content still reports
`fresh`, which is the only way this cache could mislead with no visible symptom.

Text preceding a page's first anchored heading is published as a synthetic
`_intro.md` section and passes through the same guards. It is real content: the
webhooks guide opens with 1088 characters comparing `getUpdates` and `setWebhook`.

`--golden` converts whole saved pages from `tests/fixtures/` offline and diffs the
result against recorded output, so converter changes are reviewed as a diff over real
markup rather than over fragments someone thought to write down. Re-record with
`--update-golden` after an intended change.

## Distribution model

The generated cache is **not** redistributed. Its contents are ignored by Git; each
installation downloads and builds its own private copy from the official Telegram
documentation pages, and only `cache/.gitkeep` ships so the directory exists
immediately after installation.

Three files under `tests/fixtures/` are the exception: they are verbatim copies of
three official pages, checked in together with their converted output so the golden
test can run offline and deterministically. They are test data, not the cache, and
are never read at runtime. Everything else in this repository — the skill
instructions, scripts and tests — is the project's own work and is what the LICENSE
covers; the fixture pages and their conversions remain Telegram's content.

## Layout

```text
SKILL.md            portable agent-facing workflow
reference/basics.md hand-maintained symptom-to-section routing (not freshness-checked)
scripts/refresh.mjs dependency-free Node.js refresher and converter
cache/.gitkeep      preserves the generated-cache directory in Git
cache/*             generated locally and not distributed
tests/              offline regression and CLI tests
tests/fixtures/     saved real pages plus their recorded conversion (golden tests)
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
