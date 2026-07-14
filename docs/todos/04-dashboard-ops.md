# Dashboard And Ops Todo

## Done

- [x] Build operator dashboard.
- [x] Show holdings and recent activity.
- [x] Add manual sell direction as a required workflow.
- [x] Add Feishu alert path in production environment.
- [x] Show full market names in main market list.
- [x] Show filtered markets with plain tags and filter reasons.
- [x] Add filters for funding blocked and filtered markets.
- [x] Show wallet funding as three states: all buyable, partially buyable, not buyable.
- [x] Improve recent activity layout so buttons and titles do not squeeze each other.
- [x] Show total invested, current value, and profit/loss.
- [x] Show per-market invested, current value, and profit/loss.
- [x] Keep invested amount fixed after partial sells.
- [x] Split position profit/loss into sold, realized, and unrealized.
- [x] Add manual sell confirmation state.
- [x] Split Markets by open time into past and future.
- [x] Sort past markets by latest open time and future markets by nearest open time.
- [x] Show creation, open, close, and duration in the Markets time column.
- [x] Show remaining chips directly in holdings and sell quotes.
- [x] Clarify partial funding text as executable markets versus full-batch shortfall.
- [x] Keep bought market queue stake from actual buy records instead of recalculating old buys with the current stake config.
- [x] Add one-click sell for all open outcomes in the same market.
- [x] Label Dashboard manual sells separately in recent activity and keep tx metadata in action logs.
- [x] Show and enforce Dashboard manual-sell protection during the buy hot window.
- [x] Add reusable Binance Futures hourly volume heatmap analysis with local kline cache.
- [x] Stop Feishu notifications for skipped markets; notify only eligible new markets that enter pending or immediate buy flow.
- [x] Render Feishu notifications as concise operator cards with Chinese labels and clean text fallback.
- [x] Deduplicate Feishu funding and auto-sell failure alerts by profile-local state; keep receipt success and auto-sell success in logs instead of operator chat.
- [x] Keep normal low-funds status out of Feishu; only send low-funds alerts in the T-30m/T-5m opening window.
- [x] Add independent `即将开盘` and `项目持仓` pages with profile-local follow state.
- [x] Make follow state operational: follow allows buy, cancel follow forbids buy, and fully sold projects remain visible under history.
- [x] Add bulk selection on `即将开盘` so filtered markets can be followed or cancelled in one action.
- [x] Suppress short auto-sell Feishu noise from transient 42 positions API 5xx/429/network/invalid-JSON responses; keep them as retryable JSONL/journal warnings unless the outage is prolonged.
- [x] Document event-intelligence alert boundary: strong Binance-relevance alerts stay optional until explicitly enabled.
- [x] Route close-open non-template event-intelligence alerts to Bot1 Feishu once per market address; fixed 08:00 template batches remain archive-only.
- [x] Show FIFA/Sports exact-score markets in `即将开盘` while hiding Total Goals/Total Score and Goal/Score Differential side markets.
- [x] Show planned-buy auto-sell policy text and per-market planned stake overrides consistently across the queue and new-market dashboard lists.
- [x] Sort `项目统计` by latest project trade time, newest first.
- [x] Count 42 REST `FINALISE`/`FINALIZE` settlement rows in Dashboard PnL so hold-to-settlement projects show recovered value and realized profit/loss after claim/finalization.
- [x] Merge duplicate `当前持仓明细` and `项目统计` panels into `项目持仓`; event headers now keep identity/time fields separate from financial totals, and historical projects expand to option-level realized data.
- [x] 2026-07-06 show Gas cost, gross PnL, and net PnL in summary cards, project rows, option rows, sell modal, and historical position details; net PnL now subtracts priced Gas from the profile-local Gas ledger.
- [x] 2026-07-09 add a 4242-only Bot1-Bot4 aggregate net-PnL panel with a cumulative line and daily net-increase bars; bar labels show readable integer daily amounts and share the same y-axis scale as the line.
- [x] 2026-07-09 align the 4242 aggregate net-PnL panel with per-profile dashboards by reading REST open-position `cashPnl`/`costBasis` fields as current unrealized PnL instead of only the dashboard-normalized field names.
- [x] 2026-07-11 extend the 4242 aggregate net-PnL panel to Bot1-Bot5. Gas backfill can now read 42 REST activity `transactionHash` rows in addition to local fills/actions, so profiles with website or otherwise non-bot-local transactions can rebuild a profile-local Gas ledger. Bot5 production backfill wrote `17` entries for `0.0003858789 BNB / 0.246306U`.
- [x] 2026-07-09 add and deploy a 4242-only World Cup orderflow monitor editor for the fixed Bot1/Bot3 Runner-Up and 3rd Place services. Each card shows service state, current market, threshold, token IDs, current-position watch status, state/log health, and lets the operator save a changed event/threshold and restart just that monitor. Production readback showed `/api/orderflow-monitors` enabled with 4 running monitors, all thresholds `150U`, failed/processing queues `0/0`, and the 4242 HTML containing `orderflowPanel`.
- [x] 2026-07-09 add and deploy a generic address transaction Feishu watcher for `0x96FDe227f3863812464dC1320B505016837a3650`. It watches BSC direct transactions plus ERC20/ERC721/ERC1155 `Transfer` logs, writes `/opt/42space/data/42space/address-tx-watch-0x96fde-{state.json,jsonl}`, and suppresses Feishu notifications for 10 minutes after each sent alert.
- [x] 2026-07-09 extend address watching to `0x1Bc7dF2AA0DBE1a489A7205f2D1fF92C3d51A80b` and `0x51349f0B9b8C21A34781273e37F16B0233239C41`, and add a 4242 address-monitoring dashboard view. The new API reads all three watcher services/state/logs, scans the recent token-transfer window, and maps decoded 42 receipt logs to market/outcome rows when available.
- [x] 2026-07-10 enrich watched-address Feishu cards with decoded 42 trade context. Receipt `MarketTrade` logs provide buy-side market/token/USDT/size data, Binance Router sell paths fall back to 42 REST activity by transaction hash, and the card shows event, outcome, actual USDT, position size, and optional BNB input. A real buy and sell replay plus the watcher self-test cover both paths.
- [x] 2026-07-11 pause address monitoring while trading-related RPC is optimized. Disable and stop all three address watcher units without deleting their state/logs or dashboard history; verify trading workers and sell services remain active.
- [x] 2026-06-23 show Bot2 rule summary in the frontend and broaden `即将开盘` to all non-basic events while keeping default-follow limited to Meme/Binance strong.
- [x] 2026-06-23 make the Bot2 frontend rule summary concrete: list Price/8hour/automated, daily fixed templates, World Cup single-day total goals, and sports Total Goals/Goal Differential filters; show that all non-filtered events display and notify.
- [x] 2026-06-23 expose Bot2 display/notification filters as runtime checkboxes for `价格`, `日常固定模板`, `总进球数`, and `净胜球数`; empty selection means display all monitored data-complete events.
- [x] 2026-07-02 narrow the dashboard/notification `价格` checkbox semantics to BTC Price only; non-BTC Meme price-range markets are visible/notifiable unless another display rule hides them.
- [x] 2026-06-23 add dashboard runtime-config support for separate buy gas and sell gas so operator saves cannot accidentally erase the sell-only gas setting.
- [x] 2026-06-26 apply the same checkbox-driven display/notification filter summary to Bot3 while keeping Meme/Binance strong default-follow buying disabled for Bot3.
- [x] 2026-06-26 add dashboard runtime-config support for positive display include rules so Bot4 can show only daily fixed templates while preserving its narrower buy-only question allowlist.
- [x] 2026-06-26 keep `即将开盘` broader than buy eligibility even when a profile sets a hard strategy question allowlist; Bot3 exact-score events now remain visible while unplanned auto-buy stays blocked.
- [x] 2026-06-26 clarify Bot4's dashboard rule summary so the page states that only the Bot4 buy question allowlist templates are buy-eligible while other daily templates are display/notification only.
- [x] 2026-06-26 surface Bot4 readiness and first-buy evidence snapshots in the Strategy preflight panel; the current evidence schema audits OpenRouter T+19.900/`0.5gwei` and BNB/USDT T+22.000/`0.15gwei` separately from the public dashboard.
- [x] 2026-06-26 make template-level planned buys visible as `计划买入` in the Bot4 upcoming list, so the BNB/USDT daily-volume plan shows `待买` instead of `观察` while non-planned daily templates remain display-only.
- [x] 2026-06-26 add dashboard-only `DASHBOARD_ACTIVITY_SINCE` so a newly created profile such as Bot4 can hide pre-profile wallet history from activity, PnL, and project history without affecting live positions or worker execution.
- [x] 2026-06-26 show option-level average buy price inside historical project details by rebuilding it from MINT trade price and size.
- [x] 2026-06-27 avoid false low-funds dashboard warnings when there is no next opening batch and the wallet already satisfies the configured single-market upper-bound BUSDT, allowance, and buy-gas reserve.
- [x] 2026-06-27 add staged Bot5/Bot2-like dashboard rule summaries, so `EVENT_PROFILE_ROLE=bot2_like` profiles show the same non-filtered display/notification and Meme/Binance strong default-follow semantics without sharing Bot2 state.
- [x] 2026-06-27 add dashboard load controls and deploy them to production: `DASHBOARD_STARTUP_REFRESH=0`, `DASHBOARD_OVERVIEW_REFRESH_MS=0`, `DASHBOARD_OVERVIEW_CACHE_MS=300000`, and `DASHBOARD_OVERVIEW_STALE_MS=900000` across all profile dashboards; frontend auto-refresh now runs every 60s only for visible tabs, and the manual refresh button uses `/api/overview?refresh=1`. This prevents dashboards from spawning simultaneous `status` and `positions` child-process bursts while keeping on-demand overview available.
- [x] 2026-07-10 add a tested profile-aware strategy model for Bot1-Bot5. It derives market scope, default selection, RPC/Builder transport, automatic exit, stop loss, and planned-buy priority from each profile's live config instead of a shared static strategy card.
- [x] 2026-07-10 replace the old two-column Strategy page with a responsive four-stage strategy flow, production fact table, profile-scoped preflight, discovery/notification boundaries, and collapsed advanced parameters.
- [x] 2026-07-10 remove the obsolete `10s/10s/10%` presentation from `open_timed_exit` and `pre_start_exit` profiles. Delay/interval/chunk controls now render only for ladder-compatible modes, while Bot2 shows T+25s/fast-window/stop-loss and Bot3 shows the ten-hour pre-start exit.
- [x] 2026-07-10 deploy the shared Strategy UI to dashboard ports `4242-4246` and the active Bot5 public dashboard without restarting event workers. All five production APIs returned their own profile strategy; desktop and `390px` Playwright checks had zero horizontal overflow, and Bot4 readiness evidence appeared only on Bot4.
- [x] 2026-07-11 make Bot4 Strategy execution plan-aware. The production API and UI now show OpenRouter dual Builder T+20 with T+19.500 private submission, `0.5gwei`, `0.001 BNB` tip, and no public fallback separately from BNB/USDT RPC T+22 at `0.15gwei`. Replace the misleading `止损监控 已启动 · 10% 全卖` evidence label with `自动卖出监控 已启动`; the stop-loss badge remains `止损关闭`. Desktop `1440px` and mobile `390px` Playwright checks passed with zero horizontal overflow.
- [x] 2026-07-11 add a Bot4-only OpenRouter price-exit editor to port `4245`. It displays current REST price, configured threshold, reached/waiting state, 1s/10min then 60s cadence, and 100% sell behavior; operators can enable, remove, add from the plan's selected outcomes, adjust thresholds, and explicitly include existing positions. Saves require the dashboard admin token, atomically back up/update the profile-local planned-buy file, and restart only the Bot4 worker.
- [x] 2026-07-12 make Dashboard planned-buy stake readback outcome-aware and deploy it to Bot4 port `4245`. Upcoming-market totals and Bot4 Strategy details now use `stakeByOutcomeUsdt` overrides plus the default stake; production API readback displays `Non-listed Model 20U`, `DeepSeek V4 Flash 10U`, OpenRouter total `30U`, and unchanged BNB/USDT total `20U` instead of the old uniform OpenRouter `10U x 2` calculation.
- [x] 2026-07-11 enable and verify Bot1/Bot5 Strategy readback for strict dual Builder T+20. Ports `4242` and `4246` return `ok=true` and show T+19.5 private submit, buy Gas `1.1gwei`, `0.001 BNB` tip, no public fallback, `positionFirst`, and `noMerge`, while retaining each profile's existing selection and sell policy.
- [x] 2026-07-12 verify Bot1's updated profile readback on port `4242`: Strategy shows T+19.5 private submit into strict T+20, buy Gas `2.1gwei`, `0.005 BNB` tip, no public fallback, and `100%` exit at random T+23-27 with sell Gas `0.15gwei`. Automation status reports a fresh cgroup-matching heartbeat and an error-free five-position scan after restart.
- [x] 2026-07-11 add and deploy live automation status to Bot1-Bot5. Workers atomically write a profile-local 5s heartbeat with pending/prepared buys and auto-sell scan results; `/api/automation-status` validates service cgroup ownership and the Strategy UI refreshes every 10s. Production readback showed fresh matching heartbeats for all five profiles; Bot1 reported exact-score auto-buy waiting, a last successful scan covering 6 held positions, and its temporary startup buy-protection window. Playwright checks at `1440px` and `390px` had zero horizontal overflow.
- [x] 2026-07-11 align Dashboard planned-buy precedence with the worker for Price markets. A matching planned row now changes both the upcoming-list decision and `/api/market-detail` from `Price 场` / `观察` to `计划买入` / `待买`, while an explicitly blocked follow still remains blocked. CRCL on Bot2/Bot5 is the production acceptance case.

- [x] 2026-07-14 update Bot4's 4245 Strategy and price-exit readback for the new OpenRouter pair. The UI now shows `Hy3 (free) 20U`, `MiMo - V2.5 10U`, total `30U`, thresholds `$0.0020/$0.0017`, T+19.3 private submit, and unchanged T+20 Builder/19:00 exit behavior; API readback and the 23-profile-assertion Strategy self-test pass.

## Next

- [x] Show upcoming market duration and buy/skip decision.
- [ ] Show source as simple labels: Website, Chain, Both.
- [ ] Surface event intelligence links and Binance relevance labels after the report format proves stable.
- [x] Show filter reason in plain Chinese.
- [x] Add visible low-funds warning.

## Update Rule

Update this file after dashboard, alert, activity, holdings, or operator workflow changes.
