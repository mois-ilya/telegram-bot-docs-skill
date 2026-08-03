# Telegram platform basics — orientation and routing

Hand-maintained navigation aid for the cached documentation. Read this first when a
question is conceptual ("how does X work on Telegram?") or when it is not obvious
which cached section answers it. Then open the cached file and answer from **that**.

> **This file is not freshness-checked.** Everything under `cache/` is verified
> against the live official pages by `scripts/refresh.mjs`; this file is not. It
> therefore carries **no** version-dependent facts — no limits, no field names, no
> method signatures. Where a number or a signature matters, it names the cached file
> that holds the authoritative answer. If this file ever contradicts `cache/`, the
> cache wins.

## Why this exists

The usual failure is a vocabulary gap: the user describes a symptom, the docs use a
term, and without the term you cannot grep `cache/index.md`. Nobody searches for
"privacy mode" when their complaint is "my bot doesn't see group messages". The table
below closes that gap.

## Symptom → official term → cached section

| The question sounds like | Official term | Read |
|---|---|---|
| Bot doesn't see messages in a group | **Privacy mode** | `features/privacy-mode.md`, `faq/what-messages-will-my-bot-get.md` |
| Bot doesn't react to another bot | Bots never receive bot messages | `faq/why-doesnt-my-bot-see-messages-from-other-bots.md`, `features/bot-to-bot-communication.md` |
| Pass a parameter through the bot link; referral/invite links | **Deep linking** (`?start=`) | `features/deep-linking.md` |
| Change the bot's name, about text, commands, picture | **BotFather** | `features/botfather.md`, `features/botfather-commands.md`, `features/edit-bots.md` |
| Buttons attached under a message | **Inline keyboard** | `features/inline-keyboards.md` |
| Buttons replacing the user's keyboard | **Reply keyboard** | `features/keyboards.md` |
| Button to the left of the input field | **Menu button** | `features/menu-button.md` |
| Command list / autocomplete in the input field | **Commands**, scopes | `features/commands.md`, `features/global-commands.md` |
| Same updates arrive over and over | `offset` confirmation | `faq/long-polling-gives-me-the-same-updates-again-and-again.md`, `bot-api/getting-updates.md` |
| 429 / "too many requests" | **Rate limits** | `faq/my-bot-is-hitting-limits-how-do-i-avoid-this.md` |
| Send a message to every user | **Broadcasting**, paid broadcast | `faq/how-can-i-message-all-of-my-bots-subscribers-at-once.md` |
| Webhook not delivering; certificate rejected | Webhook setup, SSL | `faq/im-having-problems-with-webhooks.md`, then `webhooks/the-short-version.md` |
| Prove a request really came from Telegram | `secret_token` | `faq/how-can-i-make-sure-that-webhook-requests-are-coming-from-telegram.md`, `bot-api/setwebhook.md` |
| Reply without a separate API call | Reply on the webhook response | `faq/how-can-i-make-requests-in-response-to-updates.md`, `bot-api/making-requests-when-getting-updates.md` |
| A web page running inside Telegram | **Mini App** (formerly Web App) | `features/mini-apps.md`, `webapps/initializing-mini-apps.md` |
| Trust the user identity a Mini App sends me | **initData validation** | `webapps/validating-data-received-via-the-mini-app.md`, `webapps/webappinitdata.md` |
| Match the Mini App to the user's theme | **Theme params** | `webapps/themeparams.md` |
| Sell digital goods, in-app purchases | **Telegram Stars** (`XTR`) | `features/telegram-stars.md`, `payments-stars/overview.md` |
| Refund a Stars purchase | Refunds | `payments-stars/q-how-can-i-issue-refunds.md` |
| Recurring payments | **Subscriptions** | `features/subscription-plans.md` |
| Charge real money / ship physical goods | **Payment provider** | `payments/the-payments-api.md`, `payments/supported-currencies.md` |
| Pay-to-view photo or video | **Paid media** | `features/paid-media.md` |
| Results while typing `@bot query` | **Inline mode** | `bot-api/inline-mode.md`, `inline/inline-results.md` |
| Send the user from inline mode into a chat with the bot | Switching inline/PM modes | `inline/switching-inline-pm-modes.md` |
| Log in to a website with Telegram | **Login Widget** / inline login | `features/web-login.md`, `features/inline-login.md` |
| Text formatting breaks on special characters | **MarkdownV2** escaping | `bot-api/formatting-options.md` |
| Reuse a `file_id` elsewhere | `file_id` scope | `faq/can-i-count-on-file-ids-to-be-persistent.md` |
| Upload or download a file above the limit | **Local Bot API server** | `faq/how-do-i-upload-a-large-file.md`, `features/local-bot-api.md` |
| Bot answering on behalf of a business account | **Business / managed bots** | `features/managed-bots.md`, `features/creating-your-own-management-bot.md` |
| "Since which version is this available?" | Bot API version history | `changelog/` (79 dated entries, 2015→today) |
| Test without touching production | **Test environment** | `features/dedicated-test-environment.md`, `features/testing-your-bot.md` |
| Hand the bot to another owner | Transfer ownership | `features/transfer-ownership.md` |

## Which source answers which kind of question

| Directory | Use it for |
|---|---|
| `bot-api/` | The reference: every method, every type, exact fields. Start here for "what does this method return". |
| `features/` | Conceptual guide to bot capabilities and BotFather. Start here for "how does this work / what is it called". |
| `webapps/` | Mini Apps: the JS `WebApp` object, initData, theming, events. |
| `faq/` | Operational troubleshooting — limits, polling, webhooks, media. Short and unusually high-yield. |
| `webhooks/` | Deep webhook and TLS troubleshooting. |
| `payments/`, `payments-stars/` | Payment flows end to end. `payments/` is provider-based money; `payments-stars/` is Stars. |
| `inline/`, `games/` | Inline mode and the HTML5 game platform. |
| `changelog/` | Full dated Bot API history. `bot-api/recent-changes.md` holds only the newest entries. |

`bot-api/` and `webapps/` carry `kind: method` / `kind: type` in `cache/index.md`;
every guide source is `kind: section` (dated changelog entries are `kind: changelog`).
Filtering a grep by kind is the fastest way to separate "the API surface" from "the
prose about it".

### One oversized file

`webhooks/the-verbose-version.md` is ~32 KB — the official page keeps that whole
walkthrough under a single anchor, so it cannot be split without inventing anchors
the source does not have. Prefer the sibling h4 sections
(`supported-certificates.md`, `an-untrusted-root.md`, `intermediate-certificates.md`,
`verified-or-self-signed.md`) and open the verbose file only for a deep TLS dig.

## Stable platform facts

Structural properties that have held for years and are not tied to a Bot API version.
They are recorded here because the page that stated them (`core.telegram.org/bots`) is
deliberately not cached — it is mostly marketing. Treat them as orientation; anything
load-bearing should still be confirmed against `cache/`.

- **A bot cannot start a conversation.** The user must message the bot, or add it to a
  group, first. This shapes every "notify the user" design.
- **Bots have no online status and no phone number.** They are accounts of a different
  kind, not automated user accounts.
- **Bot usernames end in `bot`** — case-insensitively, e.g. `@my_bot`, `@MyBot`. A few
  historic bots (`@stickers`, `@gif`) predate the rule.
- **Bot API access is HTTPS-only**, keyed by the token BotFather issues; the token is
  the whole credential — see `bot-api/authorizing-your-bot.md`.
- **The Bot API is a wrapper over the MTProto client API.** Anything it does not expose
  (reading arbitrary chat history, acting as a user) is out of scope for a bot and
  belongs to the client API at `core.telegram.org/api` — which this skill does not cache.
