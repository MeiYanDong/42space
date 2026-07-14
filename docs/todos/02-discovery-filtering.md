# Discovery And Filtering Todo

## Done

- [x] Add REST `status=all` sidecar discovery.
- [x] Make REST discovery inspect raw website markets before filtering, so filtered new markets are still recorded.
- [x] Track `not_started` markets as pending.
- [x] Raise REST scan limit to reduce missing website markets.
- [x] Use open-window deadline to skip stale markets.
- [x] Keep REST discovery non-blocking in both WS and chain-fallback loops so REST cannot delay due execution.
- [x] 2026-05-31 define premium watcher discovery as raw WSS/REST monitoring before auto-buy strategy filters, so newly created markets can be probed even when the buy bot would skip them.
- [x] 2026-05-31 harden premium watcher live WSS discovery with creation-log receipt/REST hydration fallback, so a new market is not lost when WSS emits an incomplete controller-log batch.
- [x] 2026-05-31 make premium watcher scheduling filter-free for observed current/future markets: Price tags, unsupported contract versions, and missing outcomes no longer block probe timer creation.
- [x] 2026-05-31 start event intelligence from raw first observation, with fixed templates archived lightly and non-template markets enriched without changing buy filters or premium probe scheduling.
- [x] 2026-05-31 classify close-open markets with a 31-minute threshold and dedupe their Bot1 Feishu notifications by market address.

## Next

- [x] Implement `duration >= 48h` auto-buy filter.
- [x] Exclude Price markets from Event auto-buy.
- [x] Normalize `startDate`, `endDate`, and `duration` for every source.
- [x] Add `discoverySource` to market decisions, fills, and dashboard data.
- [x] Add skip reasons: `price-market`, `short-duration`, `missing-time`, `open-window-expired`, `insufficient-data`.
- [x] Verify that chain-discovered and REST-discovered markets pass through the same classifier.
- [x] Keep missing-odds fallback as speed-first `token_order`; `error` remains opt-in only.
- [x] Add fixture tests for:
  - [x] long non-Price Event Market should buy
  - [x] daily futures volume should skip
  - [x] OpenRouter daily usage should skip
  - [x] BTC price range should skip
  - [x] missing end time should skip
- [x] Add regression coverage that REST raw discovery still notices newly filtered markets after the initial seed.
- [x] Add profile-local follow state so default strategy matches are allowed, manual follow can allow buy, and cancel follow blocks buy.
- [x] Add a hard profile-level `MARKET_QUESTION_ALLOWLIST_REGEX` gate for isolated sub-strategies such as Bot2 Daily Volume.
- [x] 2026-06-02 add profile-local `EVENT_INTEL_BUY_FILTER=strong` so Bot2 can default-follow and auto-buy only non-archived Binance strong events.
- [x] 2026-06-02 deploy Bot2 strong filter to `/etc/42space/profiles/42space-2.env`, clear the old Daily Volume allowlist, and verify fixed templates are excluded from funding/prebuy.
- [x] 2026-06-06 add `src/event-library.js` follow-rule fixtures covering the requested Meme examples, category-empty title fallback, `CZ Tweet Count` exclusion, Binance strong comparison, and Price exclusion.
- [x] 2026-06-06 improve Bot2 focus filtering so non-archived Meme board events default-follow from category/tag/topic or title fallback, non-Meme events still require Binance strong, and low-liquidity `Tweet Count` topics are skipped.
- [x] 2026-06-06 add `EVENT_OUTCOME_SELECTION=middle` so Bot2 can buy the middle three display/token-order outcomes; FDV/market-cap events map this to the middle three ranges.
- [x] 2026-06-08 add explicit `EVENT_OUTCOME_SELECTION=names` and allow manual follow to override non-strong intelligence results for operator-selected one-off markets.
- [x] 2026-06-25 recheck REST markets that were already known after seed whenever they are not seen or pending, still have a future action time, and currently pass the strategy filter, so long-running workers do not miss a future eligible market that never entered the pending queue.
- [x] 2026-06-15 add profile-local planned buys so operator-provided World Cup match outcomes can override global middle selection per market without changing every other event.
- [x] 2026-06-16 fix planned-buy startup/discovery handling so future planned markets clear stale filtered `seen` keys before scheduling, while submitted/past markets remain duplicate-protected.
- [x] 2026-06-23 split Bot2 display from default-follow buying: hide only basic fixed/Price templates, show other non-basic events, mark Meme/Binance/exact-score/player-prop focus classes, and keep default-follow limited to Meme/Binance strong.
- [x] 2026-06-23 broaden Bot2 display/notification to all non-filtered events, explicitly filter Chinese daily templates, World Cup single-day total goals, and sports Total Goals/Goal Differential side markets, while keeping default-follow limited to Meme/Binance strong.
- [x] 2026-06-30 pause Bot2 automatic buying by adding a non-matching hard buy allowlist and disabling Bot2 planned-buy rows; display/notification rules remain active and auto-sell is unchanged.
- [x] 2026-06-23 make Bot2 display/notification filters runtime-configurable with `价格`, `日常固定模板`, `总进球数`, and `净胜球数` checkbox rules; when all are unchecked, every monitored data-complete `live`/`not_started` event displays and notifies.
- [x] 2026-06-26 give Bot3 the same display/notification filtering path as Bot2 while keeping Bot2's Meme/Binance strong default-follow buy filter out of Bot3.
- [x] 2026-06-26 add Bot4-ready split filtering: `EVENT_DISPLAY_INCLUDE_RULES=daily_fixed_template` can show only daily templates, while `MARKET_BUY_QUESTION_ALLOWLIST_REGEX` hard-limits auto-buy to the OpenRouter Python usage and BNB/USDT Futures Daily Volume templates without hiding the rest of the daily templates; Hermes OpenRouter token usage is currently display-only.
- [x] 2026-06-26 decouple strategy question allowlists from display decisions, so Bot3 can keep `MARKET_QUESTION_ALLOWLIST_REGEX=a^` as a buy blocker while still showing exact-score markets in `即将开盘`.
- [x] 2026-06-27 stage Bot5 as a Bot2-like focus profile: it reuses the same display/notification filters and Meme/Binance strong default-follow rule, while keeping follow, seen, planned-buy, and execution state profile-local.
- [x] 2026-07-02 narrow the display/Feishu `价格` filter to BTC Price only. Non-BTC Meme price-range markets such as `$PUMP price range...` remain visible/notifiable, while buy-side Price exclusion stays separate.
- [x] 2026-07-09 add an `$ARROW FDV...` regression fixture proving Meme/FDV markets whose resolution text or subcategory mentions price are still default-followed, displayed, and notified; only BTC Price display filtering should hide by default.
- [x] 2026-07-09 allow explicit profile-local planned buys to override the buy-side `price-market` strategy filter while keeping automatic Price buys filtered. This lets operator-specified Finance/Prices markets such as ASML/MU price ranges enter the planned-buy queue without broadening default auto-buy.
- [x] 2026-07-04 add Bot3-only FIFA/Sports exact-score auto-buy filtering behind `BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED`: planned buys remain first priority; non-planned exact-score markets must parse as `A vs B`, exclude Total Goals/Total Score/Goal Differential/Score Different side markets, expose the canonical win-side scorelines, and pass price-tier checks before Bot3 can auto-select the lower price win-side tier. As of 2026-07-07 the selector requires ten canonical scorelines, uses the original three-score rows to choose the lower-price side, and buys that side's five-score basket.
- [x] 2026-07-11 add `EVENT_PROFILE_ROLE=bot3_like` and deploy it only to Bot1. Bot1 now shares Bot3's exact-score five-score selector at `10U` per outcome, keeps planned-buy priority and side-market exclusions, disables Meme/Binance default buying, and retains its own strict T+20 Builder target.
- [x] 2026-07-11 add the Bot2/Bot5 Meme numeric-range selector. Shared discovery locks the first observed DEX Screener/Pyth value, persists the evidence, selects the matched outcome plus adjacent buckets, never refreshes near opening, and emits an explicit middle-three fallback on unsupported or failed resolution.
- [x] 2026-07-11 close rollout findings before Bot5 activation: prevent a following sentence's `T` from being parsed as trillion supply, load the shared lock before startup REST plan construction, upgrade only un-signed fallback plans when the original lock arrives, persist selected outcomes in decision evidence, and keep non-Meme Price markets blocked.
- [x] 2026-07-11 production readback proves Bot2 and Bot5 consume the same immutable first-observation locks for the next three Meme markets. CASHCAT selected `$150M - $175M`, `$175M - $200M`, `$200M - $225M`; JUGGERNAUT selected `$10M - $12.5M`, `$12.5M - $15M`, `$15M - $17.5M`; HOODRAT selected `$7.5M - $10M`, `$10M - $12.5M`, `$12.5M - $15M`. No T-50 or opening-time refresh is scheduled.
- [x] 2026-07-11 make Meme execution-window size profile-local without changing the immutable source lock. Bot2 now expands the matched bucket to five outcomes (`+/-2`), falls back to middle five, and prepares `5 x 10U` with `50U` caps. Bot5 remains three-outcome and is disabled. JUGGERNAUT safely skipped after restart exceeded the open window; HOODRAT production readback is funded/prepared at five outcomes and `50U`.
- [x] 2026-07-11 verify planned-buy precedence on both Bot2 and Bot5. The CRCL Finance/Price market is globally ineligible, but profile-local planned rows make it buy-eligible and select exact named outcomes; production decision evidence records `planned-buy`, `rankSource=name`, and `$50 - $60` / `$60 - $70` / `$70 - $80`, while the following three Meme markets still carry their locked `memeRangeSelection=true` choices.

## Update Rule

Update this file after discovery, REST, WSS, market parsing, or filter changes.
