# Single Install Multi Profile Runtime Plan

## Objective

Run `42space`, `42space-2`, `42space-3`, `42space-4`, and staged `42space-5` as independent bot profiles from one installed program directory, `/opt/42space`.

This is the runtime step after the code merge. The code source of truth is `MeiYanDong/42space`; `42space-2` remains an A/B testing bot, but it should no longer require a separate server code tree.

## Target Model

```text
/opt/42space
  src/
  public/
  docs/
  package.json

/etc/42space/profiles/42space.env
/etc/42space/profiles/42space-2.env
/etc/42space/profiles/42space-3.env
/etc/42space/profiles/42space-4.env
/etc/42space/profiles/42space-5.env

/opt/42space/data/42space/
/opt/42space/data/42space-2/
/opt/42space/data/42space-3/
/opt/42space/data/42space-4/
/opt/42space/data/42space-5/

42space-event@42space.service
42space-event@42space-2.service
42space-event@42space-3.service
42space-event@42space-4.service
42space-event@42space-5.service
42space-dashboard@42space.service
42space-dashboard@42space-2.service
42space-dashboard@42space-3.service
42space-dashboard@42space-4.service
42space-dashboard@42space-5.service
```

Each bot runs in its own process with its own environment file and data directory. The shared part is only the program code and static UI assets.

Bot1's fast T+23-27 exit and later T+20 buys share one profile wallet, so their nonce ordering is profile-local execution state: operator approvals happen before pre-signing, and only the earliest buy is signed while a faster exit owns the next nonce. Bot3 does not inherit this sell lane; it keeps strict T+19 buy execution and ten-hour pre-start selling, with a current `0.003 BNB` global Builder tip.

## Isolation Contract

Profiles must not share:

- private key;
- wallet address;
- RPC HTTP or WSS endpoint;
- Feishu webhook;
- dashboard port;
- runtime config file;
- fills, market decisions, seen markets, auto-sell state, auto-sell circuit state, or dashboard action log;
- systemd service instance.

Profiles may share:

- `/opt/42space/src`;
- `/opt/42space/public`;
- `package.json` and installed dependencies;
- dashboard UI code;
- a read-only event discovery feed file written by the central watcher.

The shared discovery feed is not execution state. It must not contain private keys, RPC keys, webhook URLs, nonce state, fills, or sell state. Profiles consuming it still run independent strategy gates, wallet funding checks, pre-signing, raw transaction broadcast, receipts, and auto-sell logic.

A standalone shared chain observer may also publish raw read-only block/log observations. This is an operations-side exception to profile RPC isolation, not a profile runtime: it has its own root-only read env, no profile env, no wallet/signer, no nonce, no Feishu webhook, and no execution helpers. Profile HTTP/WSS endpoints used for funding, signing, broadcast, receipts, or sells remain unshared. Profile-local orderflow and address services may read its persistent JSONL feed only through an explicit source override; their base default remains direct RPC, and they reconstruct canonical receipt details before applying profile-local validation or execution. As of 2026-07-14, all five orderflow units use independent feed-source drop-ins while retaining per-unit direct-RPC rollback.

## Why This Shape

The previous migration made `MeiYanDong/42space` the canonical codebase, but the server still had two code directories: `/opt/42space` and `/opt/42space-2`.

That reduced code fork risk, but UI/code updates still had to be synced to two directories.

This migration makes updates simpler:

1. deploy code once to `/opt/42space`;
2. restart the affected profile instances;
3. all dashboards get the same UI code while keeping profile-local data and config.

It intentionally does not run both wallets inside one Node process. Separate processes keep nonce locks, crashes, CPU pressure, dashboard calls, and auto-sell circuit breakers easier to isolate and audit.

## Runtime Profile Rules

Each profile env must set:

- `BOT_NAME`;
- `BOT_SYSTEMD_SERVICE`;
- `DASHBOARD_PORT`;
- `RUNTIME_CONFIG_FILE`;
- `MARKET_FOLLOW_FILE`;
- `ALERT_STATE_FILE`;
- `STATE_FILE`;
- `FILLS_FILE`;
- `MARKET_DECISIONS_FILE`;
- `AUTO_SELL_STATE_FILE`;
- `AUTO_SELL_POSITION_STATE_FILE`;
- `AUTO_SELL_CIRCUIT_STATE_FILE`;
- `EVENT_RUNTIME_HEALTH_FILE` (or the profile-local default beside `RUNTIME_CONFIG_FILE`);
- `DASHBOARD_ACTIONS_FILE`.

Profiles that use central discovery should also set:

- `EVENT_DISCOVERY=feed`;
- `EVENT_DISCOVERY_FEED_FILE` pointing to the central watcher JSONL feed.

All event and dashboard profiles load `/etc/42space/shared-builder.env` before their profile env. The shared file owns the default Builder transport and timing policy, while a profile env or planned-buy `builderBundle` object may override specific values:

- `BUILDER_BUNDLE_ENABLED`;
- `BUILDER_BUNDLE_URL`;
- `BUILDER_BUNDLE_TIP_BNB`;
- `BUILDER_BUNDLE_TIP_TO`;
- `BUILDER_BUNDLE_TIP_GAS_PRICE_GWEI`.
- `BUILDER_BUNDLE_MODE`, default `concurrent`; use `builder_only` only when the profile or planned buy should skip public fanout and require builder-paid inclusion; use `builder_then_fanout` for the preferred hybrid path that falls back to existing public broadcast RPCs after a short builder wait.
- `BUILDER_BUNDLE_FANOUT_DELAY_MS`, default `120`, used only by `builder_then_fanout`.
- `BUILDER_BUNDLE_TIMING_MODE`, production default `auto`; T+18.x maps to the targeted 19-second window, T+19.x maps to the targeted 20-second window, and other timings stay RPC-only.
- `BUILDER_BUNDLE_PREPOSITION_LEAD_MS`; Bot2 guarded plans use `500ms` and retry every `100ms` through the target boundary.
- `BUILDER_BUNDLE_FALLBACK_SAFETY_MS`, retained for configuration compatibility; an in-flight Builder request no longer shortens its timeout or blocks the profile's normal RPC action.
- `BUILDER_BUNDLE_EARLY_SUBMIT_LEAD_MS`, default `0`; when positive, pre-submit only an already pre-signed `builder_then_fanout` bundle before the public action time.
- `BUILDER_BUNDLE_MIN_TIMESTAMP_OFFSET_MS`, legacy compatibility only. Guarded execution sends `minTimestamp=maxTimestamp=targetTimestamp`, but treats both as Builder hints; only the on-chain guard enforces not-before.
- `BUILDER_TIMESTAMP_GUARD_ENABLED` and `BUILDER_TIMESTAMP_GUARD_ADDRESS`; Bot2 alone currently enables the capability with verified contract `0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557`. Builder itself remains profile-default-off.
- `BUILDER_TIMESTAMP_GUARD_RETRY_INTERVAL_MS`, `BUILDER_TIMESTAMP_GUARD_RETRY_UNTIL_LEAD_MS`, and `BUILDER_TIMESTAMP_GUARD_RELEASE_POLL_MS` control private retry cadence and chain-time fallback release.

Builder and tip are currently default-off. A planned-buy record can carry a nested `builderBundle` override with explicit enablement and positive `tipBnb`. For guarded Bot2 plans, the pre-signed transactions use guard/buy/tip consecutive nonces. The nonce-gapped buy can fan out at the normal action time but cannot execute before the private guard; if Builder misses, the guard is released only after observed chain time reaches the target. Wallet, nonce manager, pending records, fills, and sell state remain profile-local.

All data file values should be absolute paths under the profile data directory, for example:

```text
RUNTIME_CONFIG_FILE=/opt/42space/data/42space-2/runtime-config.json
MARKET_FOLLOW_FILE=/opt/42space/data/42space-2/market-follow.json
ALERT_STATE_FILE=/opt/42space/data/42space-2/alert-state.json
FILLS_FILE=/opt/42space/data/42space-2/fills.jsonl
DASHBOARD_ACTIONS_FILE=/opt/42space/data/42space-2/dashboard-actions.jsonl
```

Absolute paths are required because both profiles use the same working directory.

Bot1 uses `EVENT_PROFILE_ROLE=bot3_like` to activate the same FIFA exact-score selector as Bot3 without impersonating Bot3 or sharing state. Bot1 keeps its own T+20 timed executor and profile-local randomized T+23-27 full exit; Bot3 keeps T+19 and ten-hour pre-start exit. Planned-buy auto-sell overrides remain authoritative, so Bot1's existing Runner-Up and 3rd Place positions continue their explicit ten-hour `pre_start_exit` schedule. The role never changes wallet, RPC, webhook, planned-buy file, nonce, fills, follow state, or auto-sell state ownership.

Each worker writes `runtime-health.json` under its profile data directory every 5 seconds. This is operational evidence only, not execution state: it contains PID, heartbeat, pending/prepared counts, and the latest auto-sell scan summary, but no key, RPC URL, webhook, signed transaction, or nonce. Dashboard polling of this file remains independent from expensive overview/RPC refreshes.

If a live profile may be temporarily unfunded, set `ARM_WAIT_FOR_FUNDING=1` for that profile. Otherwise `event:arm` exits on funding preflight failure and systemd will restart it repeatedly.

## Service Rules

Use templated systemd services:

- `42space-event@.service`
- `42space-dashboard@.service`

Instance `%i` maps to `/etc/42space/profiles/%i.env`.

The dashboard instance must set `BOT_SYSTEMD_SERVICE=42space-event@%i.service` so dashboard runtime-config changes restart only the matching event worker.

Standalone ops sidecars may run outside the templated event/dashboard pair when they do not share nonce, wallet execution, or trading state. These sidecars should still read profile env only for notification/RPC configuration, use optional dedicated read RPC env files when available, and write state/log files under the relevant profile data directory. Address-watcher definitions and state remain available for `0x96FDe...3650`, `0x1Bc7...A80b`, and `0x5134...9C41`, but all three services are disabled as of 2026-07-11 while trading-related RPC is optimized. The lower-priority `42space-shared-rpc-observer.service` now supplies the production orderflow read feed through Chainstack WSS plus a temporary one-second Chainstack HTTP safety audit; starting or stopping it must never restart Event, Dashboard, orderflow execution, or value-sell services.

## Migration Steps

1. Add the profile runtime documentation and profile-local dashboard action file support.
2. Verify the canonical repo locally.
3. Deploy canonical code to `/opt/42space`.
4. Create `/etc/42space/profiles`.
5. Copy existing production env to `/etc/42space/profiles/42space.env`.
6. Copy existing A/B env to `/etc/42space/profiles/42space-2.env`.
7. Add absolute profile-local data paths to both env files without printing secrets.
8. Move or copy `/opt/42space-2/data` into `/opt/42space/data/42space-2`.
9. Keep `/opt/42space/data` production files, then normalize production paths to `/opt/42space/data/42space`.
10. Install templated systemd units.
11. Start `42space-dashboard@42space`, `42space-event@42space`, `42space-dashboard@42space-2`, and `42space-event@42space-2`.
12. Stop and disable legacy `42space-*` and `42space-2-*` services only after the new instances are healthy.
13. Verify dashboards on ports `4242` and `4243`.
14. Verify only the new templated event workers are running.

## Rollback

If a profile fails after migration:

1. stop the failed templated profile instance;
2. restart the matching legacy service while its old env and data directory are still present;
3. inspect journal logs before retrying.

Do not run the same wallet in both legacy and templated event workers at the same time.

## Bot3 Exact-Score Profile

`42space-3` is an additive Bot3 profile created on 2026-06-21 for exact-score operation. It copies the current Bot1 runtime config and `planned-buys.json`, uses its own wallet, RPC endpoints, Feishu webhook, data directory, and dashboard port `4244`. On 2026-06-22, the operator funded the wallet and approved live buying for six exact-score planned buys at `10U` per outcome, so `42space-event@42space-3.service` is active and enabled. On 2026-06-26, Bot3 inherited Bot2's display/notification event-filter rules but explicitly did not inherit Bot2's Meme/Binance strong default-follow buy filter; Bot3 keeps `EVENT_INTEL_BUY_FILTER=off` and non-matching question allowlists for ordinary strategy buys, while profile-local planned buys still override that boundary. Later the same day, the operator-approved USA vs Bosnia and Herzegovina exact-score planned buy was added with five named outcomes at `10U` each, `openBroadcastDelayMs=18985`, `autoSell.strategy=pre_start_exit`, 10h before kickoff, and stop-loss disabled. On 2026-06-27, Bot3 production defaults were updated and verified as planned-buy-only with `MARKET_QUESTION_ALLOWLIST_REGEX=a^`, `MARKET_BUY_QUESTION_ALLOWLIST_REGEX=a^`, buy `GAS_PRICE_GWEI=1`, and sell `AUTO_SELL_GAS_PRICE_GWEI=0.15`. After USA vs Bosnia ranked behind a lower-gas buyer because Bot3 first RPC acceptance arrived at T+19.049 and landed one block later, Bot3 production `OPEN_BROADCAST_DELAY_MS` was retuned to `18900`; `npm run bot3:buy-rank` and `42space-bot3-buy-rank-evidence.timer` were deployed to keep future rank proof reproducible without manual polling. On 2026-06-28, Bot3 added profile-local exact-score planned buys for Australia vs Egypt and Argentina vs Cabo Verde, adjusted Australia vs Egypt to `5U` per selected outcome, then bought Mexico vs Ecuador at `5U` per selected outcome after correcting the plan to exact market `0x519F7d36E0ac447235A4d7E715739bF747D67D8d` and removing the broad regex that also matched Goal Differential and Total Goals. Bot3's profile default was reset from the inherited ladder/stop-loss runtime to `pre_start_exit`, stop-loss disabled, 10h-before-kickoff clearing, and `AUTO_SELL_POLL_MS=30000`; the deployed strategy-gated quote path estimates Bot3 quote-driving positions at `0` before due time. Bot3 current production default is `OPEN_BROADCAST_DELAY_MS=18850` and buy `GAS_PRICE_GWEI=1.1`. On 2026-06-29, Bot3 bought `2026 FIFA World Cup 3rd Place ?` at market `0x86308B8059183eA443fd1885D5493cF6C5222F1f`, selecting France, Argentina, Spain, England, and Brazil at `10U` each and ranking `1/9`; it also bought `2026 FIFA World Cup Runner-Up?` at market `0x6B7F30fb52B26814BB49312442010450e43e226D`, selecting France, England, Argentina, and Spain at `30U` each and ranking `3/9`. Both long-dated non-exact-score baskets are explicitly `hold_to_settlement` so they are excluded from Bot3's default 10h pre-start auto-sell path. On 2026-06-30, Bot3 website-bought `France vs Sweden` exact-score positions were enrolled for retained auto-sell and updated to retain `10%`, then Bot3 bought `France vs. Sweden - Handicap` / `France −1.5` at `10U` with per-record `1.1gwei`; that Handicap record stays on `pre_start_exit` with kickoff `2026-06-30T21:00:00.000Z`. Current services are active with broadcast RPC `2/2`. On 2026-07-07, Bot3 orderflow-trigger sell coverage expanded from Runner-Up to Runner-Up plus 3rd Place, with separate profile-local state/log files per market and the same dedicated orderflow RPC env file. On 2026-07-09, Bot3 added `Spain vs Belgium` exact-score market `0x94FA631F5A8d830919db6d5B1571e438f0222Fb0` to orderflow-trigger sell coverage at a `50U` external-buy threshold for matched held outcomes, and also added a single-outcome value-trigger sell monitor for tokenId `2048` (`ESP 2-1 BEL`) that sells once the full sell quote reaches `99U` with `minCollateralOut=99U`. Later on 2026-07-09, Bot3 added `Argentina vs Switzerland - Moneyline` as a profile-local planned buy for all three outcomes at `20U` each, per-record `openBroadcastDelayMs=19850`, buy gas `3.1gwei`, and the normal `pre_start_exit` 10h-before-kickoff sell policy anchored to `2026-07-12T01:00:00.000Z`.

As of 2026-07-04, Bot3 also has a profile-only FIFA/Sports exact-score auto-buy selector behind `BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED`. This is not a Bot1/Bot2/Bot5 strategy. If no planned buy matches, it previews the exact-score market, requires the ten canonical win-side scorelines, excludes Total Goals/Total Score/Goal Differential/Score Different side markets, uses the original three-score tier rows to choose the lower-price non-draw side, and buys that side's five-score basket. On 2026-07-05, production stake was raised from `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=1` to `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=5`; on 2026-07-06, it was raised again to `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=10`; on 2026-07-07, the selected basket changed from three to five outcomes, so the automatic exact-score path now buys `10U` per selected outcome and normally requires `50U` for the five-outcome basket. Existing Bot3 planned-buy rows always override the selector and keep their own outcome names, stake, timing, gas, and auto-sell settings. While waiting for an unknown next batch in `WATCH_FUNDING_MODE=next_batch`, Bot3 uses the auto selector's five-outcome stake as the funding fallback so the old generic upper bound does not prevent discovery/watch startup or underfund the auto basket; once a concrete planned buy or next batch is known, funding uses that actual batch requirement. On 2026-07-06, automatic exact-score auto-sell timing was aligned with planned-buy `pre_start_exit`: planned `kickoffAt` still has priority, and otherwise exact-score positions use market `endDate` as the match anchor instead of open `startDate`; side markets such as Total Goals, Goal Differential, and Handicap remain excluded.

On 2026-07-09, Bot3 proved concurrent submission and Bot2 ASML proved `builder_only`; those results remain historical transport evidence. After the 2026-07-10 timestamp incident, a 24-round production-region canary proved that even a `300ms` Builder lead can enter T-1 in hybrid mode. The replacement guarded test landed `10/12` in the target second with two no-cost misses and zero T-1; four nonce-gap fallback rounds completed with zero T-1. Bot2 keeps Builder/tip default-off but can use this guarded path per explicit planned buy; each profile keeps its wallet, nonce, state, fills, and sell policy isolated.

On 2026-07-10, Bot2 used its isolated `42space-2` wallet/state to buy six `2026 World Cup Winner market volume on 42, July 19th?` ranges at `20U` each. The planned buy overrode the shared tip to `0.004 BNB`, pinned T+18.850 and `3.1gwei`, and disabled automatic selling. The old `1000ms` preset actually sent the private request at T+18.006; 48Club accepted at T+18.260 and placed marker/buy/tip at txIndex `0/1/2` in an open+18s block. Bot2 immediately sold all six outcomes, disabled the plan, and restored its worker/dashboard; no Bot1/Bot3/Bot4/Bot5 profile state was changed.

## Bot4 Daily Template Profile

`42space-4` is an additive Bot4 profile for daily fixed-template scanning and narrow auto-buy strategies. It uses its own wallet, Chainstack RPC/WSS, Feishu webhook, data directory, dashboard port `4245`, runtime config, follow state, seen/fills/decision files, and auto-sell state. Bot4 uses the shared read-only discovery feed, shows daily templates, and limits buying to OpenRouter Python usage-winner and BNB/USDT Futures Daily Volume templates. OpenRouter is a strict plan-local dual-Builder T+20 action: its atomic bundle is pre-signed, submitted privately to 48Club and authenticated BlockRazor at T+19.300, and cannot public-fallback. Exact executor `0xC2B2F78C620228Ea8d1B2E155664ceBbc7212148` accepts only T+20 while the Builder payload declares `[T+20,T+21)`; T+21 is terminal and releases dependent pre-signs through chain-nonce reconciliation. It buys `Hy3 (free)` at `20U` and `MiMo - V2.5` at `10U` with `0.5gwei` buy gas and a `0.001 BNB` winning-provider tip. Bot4 global Builder execution remains disabled, so BNB/USDT stays an independent RPC-only T+22.000 action at `0.15gwei`. Fast buys remain quote-free and pre-signed. Sell gas stays `0.15gwei`; the paired OpenRouter outcome-price exits are `Hy3 (free) >= 0.0020` and `MiMo - V2.5 >= 0.0017`, Beijing 19:00 clears the remainder, and stop loss remains disabled.

## Bot5 Bot2-Like Profile

`42space-5` is a live Bot5 profile that mirrors Bot2 execution and sell parameters while staying operationally independent. It can participate in the same event as Bot2, but it uses its own wallet/private key, Chainstack RPC/WSS, Feishu webhook, executor, dashboard port `4246`, runtime config, follow state, fills, decision log, auto-sell state, and nonce ownership.

Bot5 sets `EVENT_PROFILE_ROLE=bot2_like` so notification and dashboard rule summaries use Bot2-like display/filter semantics. It consumes the shared read-only discovery feed and retains a three-outcome `10U` selector with `30U` market/batch caps. Buying matches Bot2's strict dual Builder T+19 path: T+18.300 private submission, `builder_only`, `0.003 BNB` tip, buy gas `1.1gwei`, `positionFirst`/`noMerge`, no public fallback, and Bot5-owned executor `0xe8e714bE74480788cABe470935DEb82236793bc3`. Bot2 and Bot5 now also share randomized T+20.5-21.5 full exit with fixed T+21 fallback. Both retain sell gas `0.15gwei` and `-10%` full stop loss.

The repository includes no-secret staging artifacts under `ops/profiles/42space-5.env.example` and `ops/profiles/42space-5.runtime-config.json`. Production has dedicated secrets and state under `/etc/42space/profiles/42space-5.env` and `/opt/42space/data/42space-5`. CRCL completed Bot5's first strict T+20 proof; CASHCAT proved the repaired T+40-50 exit. After funding and raising the tip to `0.006 BNB`, HOODRAT completed another full chain: buy rank `5` overall / `3` in T+20, BlockRazor tip mined, no public fallback, T+40.702 sell success, zero final positions, nonce `31/31`.

Bot5 was later refunded and explicitly re-enabled. For the recreated GRVT market it bought display outcomes 4-6 while Bot2 bought outcomes 1-3, each at `10U`; all transport and default exit parameters matched. Both buys landed in the same T+19 block and both randomized exits succeeded in T+25 timestamp blocks. All six balances are zero, the plan rows are disabled, and both Event and Dashboard units remain enabled/active with `NRestarts=0`.

The 2026-07-13 ARROW split retained the same independent outcome ownership. Both profiles bought and exited the July 14 market. Bot2 alone bought the July 31 market because an external Bot5-wallet transaction converted `66 BUSDT` to USDC shortly before open, leaving about `0.9044 BUSDT`; Bot5's pre-signed nonce-45 candidate remained unmined and contiguous. This is a funding blocker, not shared Builder-token contention. Bot2's July 31 exit supplied live proof of the new earlier sell window: target T+21.979, first RPC acceptance T+22.032, successful receipt, and zero selected balances.

The later Hakimi split confirmed that Bot5 funding was restored and both profiles can execute together under the unified sell window. Bot5 bought outcomes 4-6 and Bot2 bought outcomes 1-3 at `10U` each in the same T+19 block, with BlockRazor tips mined and no public fallback. Their randomized targets were T+21.014/T+21.033; both full sells confirmed in the T+21 block, all six positions are empty, and latest/pending nonces remain contiguous at Bot5 `50/50` and Bot2 `875/875`.

Bot2's profile-local backup Ankr HTTP/WSS credential was rotated after the previous account returned `401 API key disabled`. Direct HTTP/WSS probes and production doctor pass; Chainstack plus Ankr broadcast readiness is restored to `2/2`. No RPC value is committed or printed in project documentation.

## Bot1 And Bot5 Atomic Execution

Bot1 and Bot5 use the common atomic Builder implementation without sharing contracts or nonce state. Bot1 owns executor `0xe40b5c53d2C6566219f85431a334BA9692d0d6E4`, remains strict T+20, uses a `0.005 BNB` tip and `2.1gwei`, then exits at randomized T+23-27 with stop loss off. Bot5 owns `0xe8e714bE74480788cABe470935DEb82236793bc3` and matches Bot2's strict T+19 buy path, T+18.300 private submission, `0.003 BNB`, `1.1gwei`, randomized T+20.5-21.5 exit, fixed T+21 fallback, and 10% stop loss. Both use authenticated BlockRazor plus 48Club with no public buy fallback.

## Definition Of Done

- `/opt/42space` is the only active code install.
- All five profiles retain templated services with isolated wallets/state. Bot2/Bot3/Bot5 use strict Builder T+19; Bot1 uses strict Builder T+20; Bot4 OpenRouter uses strict Builder T+20 plan-locally while BNB/USDT remains RPC T+22. Bot5's Event and Dashboard units are enabled, and the funded Hakimi split completed without a profile, Builder, or nonce blocker.
- `42space-2` no longer has an active worker or dashboard process from `/opt/42space-2`.
- `http://47.251.26.212:4242/api/overview` returns `ok: true`.
- `http://47.251.26.212:4243/api/overview` returns `ok: true`.
- `http://47.251.26.212:4244/api/overview` returns `ok: true` for Bot3 with the worker running; planned-buy execution readiness still depends on profile-local BUSDT funding.
- `http://47.251.26.212/api/overview` returns `ok: true` for the Bot5 port-80 public dashboard.
- `http://127.0.0.1:4245/api/overview` and `http://47.251.26.212:4245/api/overview` return `ok: true` for Bot4.
- After Bot5 launch, `http://127.0.0.1:4246/api/overview`, `http://47.251.26.212:4246/api/overview`, and the configured port-80 public route return `ok: true` for Bot5.
- Process cwd for all dashboard and worker profile instances is `/opt/42space`.
- Profile data is under `/opt/42space/data/42space`, `/opt/42space/data/42space-2`, `/opt/42space/data/42space-3`, `/opt/42space/data/42space-4`, and `/opt/42space/data/42space-5`.
- No secrets are committed or printed.
