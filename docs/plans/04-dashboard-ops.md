# Dashboard And Ops Plan

## Objective

Give a non-technical operator a clear view of what the bot is doing and what positions exist.

## User-Facing Principles

- No raw contract fields unless needed for support.
- Minimal language.
- Show useful business facts first.
- Prefer clear labels over implementation terms.
- Markets primary list is split by open time: past markets show most recent opens first, future markets show nearest opens first. State must not push a market to the wrong time group.
- Manual sell controls must be visible where holdings are shown.

## Required Views

### Upcoming Page

`即将开盘` is an independent page. It shows future markets as an expandable list with filters for event duration, market category, and open-time horizon. Expanding a market shows its outcomes, prices, and odds when available.

Follow state is operational, not cosmetic: following a market allows the bot to buy it, and cancelling follow forbids the bot from buying it. Each profile stores its own follow state under its profile data directory.

### Upcoming

Show markets that may be bought:

- title
- starts in
- ends in
- duration
- category
- decision: pending or skipped
- reason

### Holdings

`项目持仓` is an independent page. It combines default-followed strategy matches, manually followed markets, current holdings, and a hidden-by-default history section for projects that have been fully sold.

Show current bot positions:

- market
- outcome
- remaining chips
- invested amount: cumulative buy amount, never reduced by partial sells
- sold amount
- current sell value for remaining position
- realized profit/loss from sold portions
- unrealized profit/loss from remaining position
- total profit/loss
- multiplier
- sell button
- one-click sell button for all open outcomes in one market
- manual sell disabled state during buy protection windows

### PnL

Show:

- total invested, sold, current value, realized profit/loss, unrealized profit/loss, and total profit/loss
- per-market invested, sold, current value, realized profit/loss, unrealized profit/loss, and total profit/loss
- invested is computed from buy activity; open positions only provide remaining value and unrealized profit/loss

### Activity

Show recent actions without cramped layout:

- bought
- skipped
- pending
- sold
- failed

Each row should show the market, action, amount, and reason.

### Health

Show:

- bot running
- wallet funding state: all buyable, partially buyable, or not buyable
- partially buyable text must show how many markets can execute now versus full-batch shortfall
- last market scan
- last buy attempt
- wallet BUSDT and BNB
- last alert status

## Current Gap

Market source labels are still not simplified for operators. The next dashboard improvement is to show source as Website, Chain, or Both without exposing raw fields.

## Analysis Tooling

Daily volume markets need a reusable hourly heatmap before making a trading decision. The `volume:heatmap` command keeps a local Binance Futures 1h kline cache, prints dates horizontally and UTC hours vertically, compares today's completed or live hours against the prior 7 complete UTC days, and projects conservative, median, and hot final ranges.

## Alerting

Feishu alerts should render as operator-facing cards first, with a clean text fallback if the webhook rejects interactive cards. The card body should use Chinese labels, show only 3 to 5 useful facts, and keep raw technical fields in JSONL logs instead of sending them to operators.

Noisy operational alerts should be state-change based. Low-funds alerts are sent for a new funding state or the T-30m/T-5m reminder stage for the next opening, then stay silent until the gap, next opening, or readiness changes. Receipt success stays in fills/decision logs only; receipt failure sends Feishu. Automatic-sell success stays in logs only; automatic-sell failure or circuit pause sends one concise card and is deduped through the profile-local alert state file.

Feishu alerts should fire for:

- service start
- eligible new market accepted for pending or immediate buy
- buy broadcast
- buy failure
- receipt failure
- auto-sell failure or circuit pause
- low funds state changes

Do not store webhook URLs in Git.
