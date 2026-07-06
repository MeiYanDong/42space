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
- `DASHBOARD_ACTIONS_FILE`.

Profiles that use central discovery should also set:

- `EVENT_DISCOVERY=feed`;
- `EVENT_DISCOVERY_FEED_FILE` pointing to the central watcher JSONL feed.

All data file values should be absolute paths under the profile data directory, for example:

```text
RUNTIME_CONFIG_FILE=/opt/42space/data/42space-2/runtime-config.json
MARKET_FOLLOW_FILE=/opt/42space/data/42space-2/market-follow.json
ALERT_STATE_FILE=/opt/42space/data/42space-2/alert-state.json
FILLS_FILE=/opt/42space/data/42space-2/fills.jsonl
DASHBOARD_ACTIONS_FILE=/opt/42space/data/42space-2/dashboard-actions.jsonl
```

Absolute paths are required because both profiles use the same working directory.

If a live profile may be temporarily unfunded, set `ARM_WAIT_FOR_FUNDING=1` for that profile. Otherwise `event:arm` exits on funding preflight failure and systemd will restart it repeatedly.

## Service Rules

Use templated systemd services:

- `42space-event@.service`
- `42space-dashboard@.service`

Instance `%i` maps to `/etc/42space/profiles/%i.env`.

The dashboard instance must set `BOT_SYSTEMD_SERVICE=42space-event@%i.service` so dashboard runtime-config changes restart only the matching event worker.

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

`42space-3` is an additive Bot3 profile created on 2026-06-21 for exact-score operation. It copies the current Bot1 runtime config and `planned-buys.json`, uses its own wallet, RPC endpoints, Feishu webhook, data directory, and dashboard port `4244`. On 2026-06-22, the operator funded the wallet and approved live buying for six exact-score planned buys at `10U` per outcome, so `42space-event@42space-3.service` is active and enabled. On 2026-06-26, Bot3 inherited Bot2's display/notification event-filter rules but explicitly did not inherit Bot2's Meme/Binance strong default-follow buy filter; Bot3 keeps `EVENT_INTEL_BUY_FILTER=off` and non-matching question allowlists for ordinary strategy buys, while profile-local planned buys still override that boundary. Later the same day, the operator-approved USA vs Bosnia and Herzegovina exact-score planned buy was added with five named outcomes at `10U` each, `openBroadcastDelayMs=18985`, `autoSell.strategy=pre_start_exit`, 10h before kickoff, and stop-loss disabled. On 2026-06-27, Bot3 production defaults were updated and verified as planned-buy-only with `MARKET_QUESTION_ALLOWLIST_REGEX=a^`, `MARKET_BUY_QUESTION_ALLOWLIST_REGEX=a^`, buy `GAS_PRICE_GWEI=1`, and sell `AUTO_SELL_GAS_PRICE_GWEI=0.15`. After USA vs Bosnia ranked behind a lower-gas buyer because Bot3 first RPC acceptance arrived at T+19.049 and landed one block later, Bot3 production `OPEN_BROADCAST_DELAY_MS` was retuned to `18900`; `npm run bot3:buy-rank` and `42space-bot3-buy-rank-evidence.timer` were deployed to keep future rank proof reproducible without manual polling. On 2026-06-28, Bot3 added profile-local exact-score planned buys for Australia vs Egypt and Argentina vs Cabo Verde, adjusted Australia vs Egypt to `5U` per selected outcome, then bought Mexico vs Ecuador at `5U` per selected outcome after correcting the plan to exact market `0x519F7d36E0ac447235A4d7E715739bF747D67D8d` and removing the broad regex that also matched Goal Differential and Total Goals. Bot3's profile default was reset from the inherited ladder/stop-loss runtime to `pre_start_exit`, stop-loss disabled, 10h-before-kickoff clearing, and `AUTO_SELL_POLL_MS=30000`; the deployed strategy-gated quote path estimates Bot3 quote-driving positions at `0` before due time. Bot3 current production default is `OPEN_BROADCAST_DELAY_MS=18850` and buy `GAS_PRICE_GWEI=1.1`. On 2026-06-29, Bot3 bought `2026 FIFA World Cup 3rd Place ?` at market `0x86308B8059183eA443fd1885D5493cF6C5222F1f`, selecting France, Argentina, Spain, England, and Brazil at `10U` each and ranking `1/9`; it also bought `2026 FIFA World Cup Runner-Up?` at market `0x6B7F30fb52B26814BB49312442010450e43e226D`, selecting France, England, Argentina, and Spain at `30U` each and ranking `3/9`. Both long-dated non-exact-score baskets are explicitly `hold_to_settlement` so they are excluded from Bot3's default 10h pre-start auto-sell path. On 2026-06-30, Bot3 website-bought `France vs Sweden` exact-score positions were enrolled for retained auto-sell and updated to retain `10%`, then Bot3 bought `France vs. Sweden - Handicap` / `France −1.5` at `10U` with per-record `1.1gwei`; that Handicap record stays on `pre_start_exit` with kickoff `2026-06-30T21:00:00.000Z`. Current services are active with broadcast RPC `2/2`.

As of 2026-07-04, Bot3 also has a profile-only FIFA/Sports exact-score auto-buy selector behind `BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED`. This is not a Bot1/Bot2/Bot5 strategy. If no planned buy matches, it previews the exact-score market, requires the six canonical win-side scorelines and uniform price tiers, excludes Total Goals/Total Score/Goal Differential/Score Different side markets, and buys the lower price win-side tier. On 2026-07-05, production stake was raised from `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=1` to `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=5`; on 2026-07-06, it was raised again to `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=10`, so the automatic exact-score path now buys `10U` per selected outcome and normally requires `30U` for the three-outcome basket. Existing Bot3 planned-buy rows always override the selector and keep their own outcome names, stake, timing, gas, and auto-sell settings. While waiting for an unknown next batch in `WATCH_FUNDING_MODE=next_batch`, Bot3 uses the auto selector's three-outcome stake as the funding fallback so the old generic upper bound does not prevent discovery/watch startup; once a concrete planned buy or next batch is known, funding uses that actual batch requirement. On 2026-07-06, automatic exact-score auto-sell timing was aligned with planned-buy `pre_start_exit`: planned `kickoffAt` still has priority, and otherwise exact-score positions use market `endDate` as the match anchor instead of open `startDate`; side markets such as Total Goals, Goal Differential, and Handicap remain excluded.

## Bot4 Daily Template Profile

`42space-4` is an additive Bot4 profile for daily fixed-template scanning and narrow auto-buy strategies. It uses its own wallet, Chainstack RPC/WSS, Feishu webhook, data directory, dashboard port `4245`, runtime config, follow state, seen/fills/decision files, and auto-sell state. Bot4 uses the shared read-only discovery feed, sets `EVENT_DISPLAY_INCLUDE_RULES=daily_fixed_template` so the dashboard shows daily templates, and sets `MARKET_BUY_QUESTION_ALLOWLIST_REGEX` so only the OpenRouter Python usage-winner and BNB/USDT Futures Daily Volume templates can be auto-bought. Active planned buys bind outcomes per recurring question: OpenRouter Python buys `DeepSeek V4 Flash`, `Owl Alpha`, and `Hy3 preview` at `10U` each; BNB/USDT buys `$150M – $300M` and `$300M – $450M` at `10U` each. Hermes OpenRouter token usage buying is paused after the template/outcome change and removed from the buy allowlist while still visible through daily-template display. Bot4 disables bundle buys and uses staggered single pre-signing: OpenRouter Python uses T+19.900 and `0.5gwei`, and BNB overrides to T+22.000, `0.15gwei`, and the secondary Bot4 RPC. `MAX_MARKET_STAKE_USDT=30` covers the three-outcome OpenRouter market and `MAX_BATCH_STAKE_USDT=50` covers the active daily-template batch. `EVENT_OPEN_WINDOW_SECONDS=35` is stale-buy protection for staggered actions, not a buy timestamp; sell gas stays `0.15gwei`. Bot4 post-cutover daily buys use `open_timed_exit` at T+39600s, so the 08:00 Beijing daily open sells 100% at 19:00 Beijing unless the operator explicitly asks to hold and the planned buy is given `hold_to_settlement`; old positions before the cutover stay excluded by `AUTO_SELL_APPLY_AFTER_ISO`. Direct public `4245` is open and verified for Bot4; the old `42space-bot4-public-dashboard.service` port-80 fallback has been disabled because port 80 now serves Bot5.

## Bot5 Bot2-Like Profile

`42space-5` is a staged Bot5 profile that intentionally mirrors the current Bot2 production selection and sell policy while keeping its operator-adjusted T+19.900 buy broadcast and staying operationally independent. It can participate in the same event as Bot2, but it must use its own wallet/private key, Chainstack RPC/WSS, broadcast RPC list, Feishu webhook, dashboard port `4246`, runtime config, follow state, seen markets, fills, decision log, auto-sell state, and dashboard action log.

Bot5 sets `EVENT_PROFILE_ROLE=bot2_like` so notification and dashboard rule summaries use the Bot2-like display/filter semantics even if the operator-visible `BOT_NAME` is `Bot5 Console`. The staged runtime template keeps the current Bot2-like selection and sell defaults with the operator-adjusted buy broadcast: consume the shared read-only discovery feed, `EVENT_INTEL_BUY_FILTER=strong`, middle 3 outcomes, `10U` per outcome, `30U` per market/batch cap, `EVENT_MAX_DUE_MARKETS_PER_OPEN=1`, `OPEN_BROADCAST_DELAY_MS=19900`, buy gas `6gwei`, `AUTO_SELL_STRATEGY=open_timed_exit`, full exit at T+25s, sell gas `0.15gwei`, fast randomized open-exit enabled, and `-10%` stop-loss full clear-out.

The repository includes no-secret staging artifacts under `ops/profiles/42space-5.env.example` and `ops/profiles/42space-5.runtime-config.json`. On 2026-06-27, the operator-provided Bot5 Chainstack RPC/WSS, wallet/private key, and Feishu webhook were installed into `/etc/42space/profiles/42space-5.env`, profile-local state was initialized under `/opt/42space/data/42space-5`, Bot5 was aligned to Bot2's production selection and sell policy plus T+19.900 buy broadcast, and read-only doctor/WSS checks verified key loading, wallet match, HTTP RPC, WSS, broadcast RPC, and current funding blockers. `42space-event@42space-5.service` is enabled and active in waiting-for-funds production mode. Public access is configured through `42space-bot5-public-dashboard.service` on `http://47.251.26.212/`, and direct public `http://47.251.26.212:4246/` is open through the lightweight cloud server SWAS firewall rule `42space-5-dashboard`. Production trading activation is not complete until the wallet is funded and first-buy proof is recorded.

## Definition Of Done

- `/opt/42space` is the only active code install.
- `42space` and `42space-2` both run from templated services; `42space-3` runs its dashboard and exact-score worker from templated services after operator launch approval; `42space-4` runs from the same templated service model with daily-template buy gating, OpenRouter Python T+19.900/`0.5gwei`, Hermes buying paused, BNB/USDT T+22.000/`0.15gwei` through the secondary Bot4 RPC, default Beijing 19:00 timed full exits for post-cutover daily buys, and bundle buys disabled; `42space-5` has a dedicated server profile, public port-80 dashboard, and active waiting-for-funds worker.
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
