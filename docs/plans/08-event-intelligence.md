# Event Intelligence Plan

## Objective

Add a read-only intelligence layer for newly observed 42 Event Markets so the operator can quickly understand what a newly created non-template event is about and whether it has a Binance connection.

## Contract

Event intelligence must never block discovery, premium probes, pre-signing, buying, selling, nonce management, or RPC fanout. It is an asynchronous sidecar. If web search or X/Twitter APIs are slow, missing, rate-limited, or misconfigured, the market still gets its premium probe and the intelligence report records the missing source.

The premium watcher remains responsible for the hard invariant: every observed current/future market gets a probe timer or an explicit `not-scheduled` audit row. Event intelligence is triggered from the same first-observation path, then fixed templates are archived with a light report while non-template events run the external analysis. It must never replace or delay the premium probe.

## Event Classes

Classify every newly observed market before heavy analysis:

- Fixed template: known daily/weekly/monthly recurring templates such as Futures Daily Volume, Daily Token Usage, OpenRouter usage/model usage, OpenRouter Python usage winner templates, World Cup single-day total goals, weekly/monthly notional volume, HIP volume, and fixed price-range templates. Chinese titles such as `期貨每日交易量`, `每日成交量`, `每日代幣使用總量`, and `哪個 AI 模型在 ... 於 OpenRouter 上的 Python 使用量最高` are included. These still get an intelligence audit row and per-market light report, but do not run heavy web/X analysis by default.
- Price event: markets identified by Price category/tag, 8 hour tag, clock curve, price range wording, or point-in-time questions such as `What is the price of BTC at 12:00 UTC`. These still get an audit row and light report. The operator display/Feishu `价格` filter now only hides BTC Price variants; non-BTC Meme price-range events such as `$PUMP price range...` remain visible/notifiable for Bot2/Bot3/Bot5 filtered notification profiles.
- Non-template event: newly created, non-repeating, or WSS-receipt-style events whose subject may come from Binance memes, Binance announcements, BNB Chain, Binance Wallet, Binance Alpha, Launchpool, Megadrop, CZ/Yi He, or broader market news. These must enter the intelligence queue.
- Unknown: incomplete title/time metadata. Treat as non-template for intelligence so the system does not silently miss a potentially important new event.

Template-like markets whose `createdAt` and `startDate` are close are treated as non-template because they behave like new creations, not scheduled batches. The default close-open threshold is 31 minutes through `EVENT_INTEL_CREATED_AT_OPEN_THRESHOLD_MINUTES=31`.

## Analysis Sources

For every first-observed market, write one intelligence report. For non-template events, enrich it with:

- Chinese one-line event explanation based on the 42 question and available search snippets.
- Web search results when a provider is configured.
- X/Twitter search results when a provider is configured, preferably through the local `twitterapi-io` skill-backed TwitterAPI.io provider.
- A simple tweet heat label so the operator can tell whether the topic is merely Binance-related or also actively discussed.
- Binance relation score and label: strong, medium, weak, none, or unknown.
- Evidence lines that explain why the relation label was assigned.
- Probe/discovery context: market address, title, start time, source, and output links when known.

Supported web search providers should be optional and configured by environment variables. The first implementation supports Brave Search, SerpAPI, or a custom JSON endpoint template. Supported X/Twitter providers should be optional and configured by environment variables. The current implementation supports the local `twitterapi-io` skill path through `TWITTERAPI_IO_KEY`, official recent search bearer-token mode, and a custom JSON endpoint template for other third-party APIs. Provider credentials must stay outside Git.

## Binance Relation Rules

Strong relation:

- Binance official product/announcement/ecosystem domains or official/core accounts are directly present. Generic Binance trade/chart/futures data URLs used only as resolution sources are weak evidence, not strong by themselves.
- The topic explicitly mentions Binance, Binance Alpha, Binance Wallet, BNB Chain, Launchpool, Megadrop, CZ, Yi He, or BNB and the evidence supports the relation.
- The question's core subject is a Binance listing, Binance official product/ecosystem item, BNB comparison, CZ/Yi He action, or Chinese `币安` topic. These are treated as strong even if external search/X providers are missing or rate-limited. A bare `BNB` ticker mention is not enough by itself; this avoids treating fixed `BNB/USDT Futures Daily Volume` templates as strong buy targets after Bot2 moves from fixed-buy to filter-buy mode.
- `CZ Tweet Count` may still score strong in the intelligence report because CZ is a core Binance person, but Bot2's buy filter excludes Tweet Count topics as low-liquidity by strategy.

Medium relation:

- Multiple search/X results connect the topic to Binance ecosystem discussion, but not from official/core sources.

Weak relation:

- Only loose keywords or incidental exchange/trading-pair mentions are present.

None:

- Search and X evidence are available and do not connect the topic to Binance.

Unknown:

- Search/X sources are not configured or both failed.

## Outputs

Write reports under `output/event-intel/` by default:

- JSONL audit row in `output/event-intel.jsonl`.
- Persistent seen-state in `output/event-intel-seen.json`, seeded from the JSONL audit on startup, so service restarts do not repeatedly reprocess historical markets.
- Persistent notification seen-state in `output/event-intel-notify-seen.json`, keyed only by market address, so WSS/REST duplicates and service restarts do not repeatedly notify the same market.
- Per-market JSON report.
- Per-market Chinese Markdown report.

Non-template new-event notifications are enabled by default when the market is close-open: `createdAt` and `startDate` must be within the configured 31-minute threshold. Bot2, Bot3, and staged Bot5 additionally treat every event not hidden by their enabled display-filter rules as notifiable. The default Bot2/Bot3/Bot5 display-filter rules hide `价格`, `日常固定模板`, `总进球数`, and `净胜球数`; if the runtime rule list is empty, that profile notifies every monitored data-complete live/not-started event. Sports/FIFA exact-score markets are an operator alert class even when created well before kickoff, because they are actionable match markets; they remain visible by filtering out the Total Goals/Total Score and Goal/Score Differential side markets, not by a separate positive exact-score selector. Exact-score cards and reports must parse the matchup and outcome scores into a stable `sportsMatch` block: localized team labels use `中文（FIFA code）` plus flag, score direction is explicitly home-away, and every outcome score remains available in JSON/Markdown for review.

Bot1 keeps the close-open non-template alert path. Bot2, Bot3, and Bot5 are profile-local and broader for operator visibility: they can use the current process `FEISHU_WEBHOOK` only when the current profile name/role matches that bot, and they notify all non-filtered events. Meme, Binance strong, FIFA/Sports exact-score, and World Cup player-performance prop markets such as `World Cup Star of Stars` are still tagged as focus classes, but generic non-template Bot2/Bot3/Bot5 markets also send Feishu. Bot5 can set `EVENT_PROFILE_ROLE=bot2_like` so it reuses Bot2-like filtered notification semantics even when its display name is not `42space-5`. Set `EVENT_INTEL_FEISHU_WEBHOOK` to override the primary target webhook, and set `EVENT_INTEL_BOT2_FEISHU_WEBHOOK` / `EVENT_INTEL_BOT3_FEISHU_WEBHOOK` / `EVENT_INTEL_BOT5_FEISHU_WEBHOOK` when a shared Bot1 watcher should additionally route profile notifications. A shared watcher can set `EVENT_INTEL_BOT2_RUNTIME_CONFIG_FILE`, `EVENT_INTEL_BOT3_RUNTIME_CONFIG_FILE`, or `EVENT_INTEL_BOT5_RUNTIME_CONFIG_FILE` to the profile runtime-config file so Feishu notification filtering follows the dashboard checkbox state; `EVENT_INTEL_BOT2_DISPLAY_FILTER_RULES`, `EVENT_INTEL_BOT3_DISPLAY_FILTER_RULES`, and `EVENT_INTEL_BOT5_DISPLAY_FILTER_RULES` are env overrides when no runtime file should be read.

BTC Price events are filtered out of Feishu by default through the `价格` display-filter rule. Non-BTC Meme price-range events are not hidden by that rule. `EVENT_INTEL_NOTIFY_PRICE_EVENTS=0` remains a compatibility default for older paths, but Bot2/Bot3/Bot5 operator paths should use the runtime display-filter list.

The Feishu notification surface is operator-first, not report-first: use an interactive card, render open/create times in Beijing local time, show the created/open gap, and include clickable 42 market, BscScan, and REST buttons. Do not show server-local Markdown report paths in Feishu because the operator cannot open them from chat.

Strong relation notifications remain as a compatibility switch through `EVENT_INTEL_NOTIFY_STRONG`, but the normal operator path is now "close-open non-template once" rather than "strong Binance only".

The `auto` X provider selection prefers TwitterAPI.io when `TWITTERAPI_IO_KEY` is present, then falls back to custom endpoint and official bearer-token mode. The key can come from the process environment, workspace `.env`, or local secret env files such as `~/.codex/secrets/twitterapi-io.env`; event reports must not print API keys or raw provider headers.

## Bot2 Buy Filter

Event intelligence remains asynchronous by default and still must not delay premium probes. Bot2 may opt into `EVENT_INTEL_BUY_FILTER=strong`, which uses only local market metadata and the already-written JSONL report file in the strategy gate. It does not run web/X providers in the buy hot path. The buy filter passes non-archived Meme board events by default, including title-pattern fallback when REST categories are empty, passes non-Meme Binance strong events, excludes low-liquidity Tweet Count topics, and keeps fixed templates/Price events out of auto-buy. Display/notification classes, including generic non-template, FIFA/Sports exact-score, and World Cup player-performance props, do not default-follow unless manually followed or planned.

Bot3 can reuse the Bot2 display/notification filter path without enabling this buy filter. In that mode, Bot3 still receives non-filtered event visibility and Feishu cards, but Meme/Binance strong markets do not become default-follow buy targets; Bot3 execution remains controlled by manual follow, profile allowlists, or profile-local planned buys.

Bot5 intentionally reuses the Bot2 buy-filter behavior when `EVENT_INTEL_BUY_FILTER=strong` is enabled. It remains a separate execution profile: Bot5's notification dedupe scope, webhook, runtime config, follow state, and execution state must not share Bot2 files.

## Safety

- No secrets, API keys, webhook URLs, or raw provider headers in logs or reports.
- No trading decisions are made by the sidecar itself. A bot profile may explicitly read the local/report strong label through `EVENT_INTEL_BUY_FILTER=strong`.
- Search and X failures are report fields, not process failures.
- Fixed-template classification must be visible so the operator can tell "skipped as template" from "missed".
