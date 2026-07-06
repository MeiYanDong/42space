# Discovery And Filtering Plan

## Objective

Detect all relevant 42 Event Markets early, but only buy markets that match the strategy.

## Source Model

Use both sources, then normalize into one market record.

| Source | Role | Strength | Limitation |
| --- | --- | --- | --- |
| Chain / WSS controller logs | Fast signal | Can appear immediately around contract creation | Not complete for every visible website market |
| 42 REST `status=all` | Completeness signal | Sees `not_started`, `live`, `startDate`, `endDate`, categories, tags, outcomes | Polling latency and API shape can change |

The buy decision must not depend on whether a market came from chain or REST. Source only affects speed and evidence.

REST discovery must inspect raw website markets before applying the buy filter. A market that is too short, Price, missing time, or otherwise not buyable still needs a `filtered` decision row; otherwise the operator cannot tell whether it was seen and rejected or missed entirely.

In WSS/chain mode, the startup REST seed still owns current future-market scheduling after a restart. After that seed, the REST sidecar must also recheck known website markets that are not already seen or pending; if they still have a future action time and now pass the strategy filter, they are promoted into the buy pipeline. This prevents a long-running worker from missing a future market that was present in REST but never entered the in-memory pending queue.

The premium watcher uses the same raw source model before buy-strategy filters. It is not allowed to depend on `duration >= 48h`, profile allowlists, follow state, Price tags, contract version, or initial outcome completeness, because its job is to measure opening quote behavior across every newly discovered market. Technical incompatibility must be recorded as probe output or an explicit `not-scheduled` reason; it must not silently prevent a newly observed current/future market from getting a probe timer.

Event intelligence is a sidecar after raw discovery and starts from the same first-observation branch as `premium-watch-seen`. The classifier separates fixed daily/weekly/monthly templates from non-template newly created markets, using a 31-minute `createdAt`/`startDate` close-open threshold. Fixed templates keep light audit reports and optional premium probes only. Non-template events enter asynchronous web/X analysis for Chinese explanation and Binance relevance. Bot1 keeps the close-open non-template alert path, while Bot2, Bot3, and staged Bot5 send Feishu for every event not hidden by their enabled display-filter rules; this must not change buy filters or delay buy execution.

## Market Classifier

Normalize every discovered market into:

- title
- category/tag
- market type
- start time
- end time
- duration
- outcomes and odds
- discovery source
- filter result

Then apply two separate gates: a display/notification gate for operator visibility, and a buy/follow gate for execution.

## Current Display And Notification Gate

Bot2, Bot3, and staged Bot5 `即将开盘` display use checkbox-controlled display-filter rules. The default enabled rules hide only the basic recurring/noise classes:

- `价格`: only BTC Price/8 hour/clock-curve/point-in-time BTC price events; non-BTC Meme price-range events such as `$PUMP price range...` remain visible/notifiable
- `日常固定模板`: known daily/weekly/monthly fixed templates such as Futures Daily Volume, Daily Token Usage, OpenRouter usage, World Cup single-day total goals, weekly/monthly notional volume, HIP volume, and fixed-time price range templates, including Chinese titles such as `期貨每日交易量`, `每日成交量`, and `每日代幣使用總量`
- `总进球数`: sports side markets such as Total Goals/Total Score, including Chinese `總進球數`
- `净胜球数`: sports side markets such as Goal/Score Differential, including Chinese `净胜球數`
- missing market/outcome/status data that cannot be displayed safely

All other live or not-started non-basic events are visible to the operator and eligible for Bot2/Bot3/Bot5 Feishu notification even when they are not buy-eligible. If all display-filter rules are unchecked, every monitored data-complete `live` or `not_started` event is visible and notifiable. FIFA/Sports exact-score markets are not positively selected by a special filter; they remain visible because Total Goals and Goal Differential side markets are filtered out. Meme, Binance strong, FIFA/Sports exact-score, and World Cup player-performance prop markets such as `World Cup Star of Stars` are still marked as focus classes for easier scanning. Display or notification does not imply auto-buy.

Display and notification must stay independent from strategy question allowlists. `MARKET_QUESTION_ALLOWLIST_REGEX` and `MARKET_BUY_QUESTION_ALLOWLIST_REGEX` can block auto-buy, but they must not hide otherwise displayable markets such as Bot3 exact-score matches from `即将开盘`.

Profiles can also set `EVENT_DISPLAY_INCLUDE_RULES` as a positive display allowlist. Bot4 uses this with `daily_fixed_template` so its `即将开盘` page shows only daily fixed templates, while the buy gate remains narrower and independent.

## Current Strategy Gate

Auto-buy only:

- Event Market
- matches `MARKET_QUESTION_ALLOWLIST_REGEX` when that profile sets one
- matches `MARKET_BUY_QUESTION_ALLOWLIST_REGEX` when that profile sets one; this is buy-only and does not hide non-matching events from the dashboard
- matches `EVENT_INTEL_BUY_FILTER=strong` when a profile enables the Bot2 focus strategy: Meme board events default-follow; non-Meme events must be Binance strong from local metadata or the intelligence JSONL
- not cancelled in the profile-local follow state
- Not Price
- satisfies the profile/runtime duration gate (`MIN_EVENT_DURATION_HOURS`; Bot2 production may set this to `0` during the current focus phase)
- Opened less than `EVENT_OPEN_WINDOW_SECONDS`
- Current Bot2/Bot5 buy selection uses `EVENT_OUTCOME_SELECTION=middle`, taking the centered three outcomes by display/token order; FDV/market-cap range events therefore buy the middle three ranges
- Explicit one-off large-option markets can use `EVENT_OUTCOME_SELECTION=names` with comma-separated `EVENT_OUTCOME_NAMES`; this bypasses the candidate-count guard only for the named selection while still enforcing `MAX_OUTCOMES_PER_MARKET` on the selected outcomes
- Profile-local planned buys use `EVENT_PLANNED_BUYS_FILE` to bind a market address or exact question to its own outcome names and per-outcome stake. A planned buy overrides the global `middle` selection only for that market, is marked in the prepared plan, and can pass the single-market-per-open limit when the operator explicitly planned multiple same-start markets.
- If a planned buy matches a future market that was previously persisted in `seen` by an older filtered decision, the startup/discovery scheduler clears that stale seen key before the action time. After the action time, `seen` remains a duplicate-buy guard.
- The old odds-based selector remains available as `EVENT_OUTCOME_SELECTION=lowest_odds`; if odds are missing in that mode, keep speed-first `token_order` fallback

Skip:

- markets explicitly cancelled from follow
- Price markets
- Short fixed-cycle templates, for example daily volume, daily token usage, model usage, price range
- Non-Meme, non-strong Binance intelligence results when `EVENT_INTEL_BUY_FILTER=strong`
- Low-liquidity Binance-related topics such as `Tweet Count`
- Anything older than the open window
- Anything that cannot be normalized safely
- Missing odds only if `EVENT_OUTCOME_SELECTION_FALLBACK=error` is explicitly enabled

Manual follow can intentionally allow an otherwise filtered strategy market, including a non-strong intelligence result, but status, start time, and outcome availability still have to be usable.

Profile-level question allowlists are hard strategy boundaries. Manual follow must not bypass them; use this for isolated buy strategies such as a Daily Volume-only Bot2. They are strategy-only boundaries and do not suppress dashboard display.

Profile-level buy-only question allowlists are also hard strategy boundaries. Manual follow must not bypass them either. Bot4 uses this to display all daily fixed templates but auto-buy only the OpenRouter Python usage and BNB/USDT Futures Daily Volume templates while Hermes OpenRouter token usage is paused/display-only.

`EVENT_INTEL_BUY_FILTER=strong` is profile-local and defaults to `off`. It is intended for Bot2/Bot5 focus-buy mode: a market can pass when it is a non-archived Meme board event, when local market metadata already proves a Binance strong topic, or when the configured intelligence JSONL has a non-archived `binanceRelation=strong` row. Meme recognition first uses category/tag/topic metadata, then falls back to title patterns for token-style FDV and known Chinese meme names when REST categories are empty. Fixed daily/weekly/monthly templates and Price events remain excluded from this intelligence buy filter so the old fixed-buy strategy does not leak back in. `Tweet Count` is excluded even when `CZ` makes the report strong, because observed trading volume is too low for default buying. Bot5 uses its own follow/seen/planned-buy state even when it mirrors Bot2 focus-buy rules. Bot3 may share Bot2's display/notification filters, but must keep this Meme/Binance strong default-follow buy filter disabled unless the operator explicitly asks to migrate buy focus.

FIFA/Sports exact-score and player-performance prop markets are display/notification classes by default. Bot1/Bot2/Bot5 do not default-buy them from display alone. Bot3 has a separate profile-only exception behind `BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED`: if there is no matching planned buy, Bot3 may auto-buy only Sports/FIFA exact-score markets that parse as `A vs B`, are not Total Goals/Total Score/Goal Differential/Score Different side markets, expose all six canonical win-side outcomes (`1-0`, `2-0`, `2-1`, `0-1`, `0-2`, `1-2`), and have uniform outcome prices inside each win-side tier. The selector buys only the lower price win-side tier; draw outcomes are displayed in the preview but never bought. If any parse, price, tier, or side-market check fails, Bot3 records/skips the automatic buy path and keeps the market visible for operator review.

Bot3 planned buys remain higher priority than this automatic exact-score selector. A market address/question matched by `EVENT_PLANNED_BUYS_FILE` must use the operator-specified outcome names, stake, timing, gas, and auto-sell override, even if the automatic selector would choose the other side.

## Follow Rule Event Library

`src/event-library.js` is the regression library for strategy examples and expected follow decisions. `npm run event:self-test` evaluates the library under Bot2-like focus settings and currently proves:

- Meme board examples such as `$苹果人生`, `$白毛股神`, `$世界杯`, `$币安人生`, and `哈基米 ... Binance` default-follow, including category-empty REST records that only expose the meme through the title.
- `CZ Tweet Count` does not default-follow.
- Price markets remain excluded.
- Non-template Binance strong comparisons still default-follow.
- FIFA/Sports exact-score and `World Cup Star of Stars`-style player-performance props display and notify but do not default-follow.
- Sports side markets such as `總進球數` and `净胜球數` are filtered by configurable rules so exact-score markets remain visible by exclusion.
- Generic non-template events display and notify without default-follow, proving Bot2 only actively hides the explicit noise classes and still keeps buy gating separate.
- An empty display-filter rule list displays and notifies every data-complete monitored library event, proving the frontend checkbox contract.
- A positive display include rule can show only daily fixed templates, proving Bot4 can scan recurring-template openings without broadening its buy gate.

## Timing Model

- If `startDate > now`: put into pending, hydrate data, prebuild/presign if possible.
- If `now - startDate <= openWindow`: buy immediately.
- If `now - startDate > openWindow`: skip and persist the skip.

## Current State

The code has REST `status=all` raw discovery, scan limit improvements, known-future eligible recheck after REST seed, the `duration >= 48h` strategy gate, Bot2/Bot5 middle-three outcome selection, speed-first token-order fallback, and a market decision jsonl for later proof. In WSS mode, REST sidecar polling runs in the background and WSS queues are drained before REST candidates.

## Evidence To Preserve

For each market decision, logs and dashboard should show:

- market title
- start time
- end time
- duration
- source
- decision: pending, bought, skipped
- skip reason, if skipped
- mode: execute or dry-run, so tests cannot be mistaken for real buys
