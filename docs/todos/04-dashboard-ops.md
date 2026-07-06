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

## Next

- [x] Show upcoming market duration and buy/skip decision.
- [ ] Show source as simple labels: Website, Chain, Both.
- [ ] Surface event intelligence links and Binance relevance labels after the report format proves stable.
- [x] Show filter reason in plain Chinese.
- [x] Add visible low-funds warning.

## Update Rule

Update this file after dashboard, alert, activity, holdings, or operator workflow changes.
