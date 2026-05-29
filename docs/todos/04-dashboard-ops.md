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

## Next

- [x] Show upcoming market duration and buy/skip decision.
- [ ] Show source as simple labels: Website, Chain, Both.
- [x] Show filter reason in plain Chinese.
- [x] Add visible low-funds warning.

## Update Rule

Update this file after dashboard, alert, activity, holdings, or operator workflow changes.
