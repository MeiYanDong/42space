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

## Alerting

Feishu alerts should fire for:

- service start
- eligible market pending
- buy success
- buy failure
- skipped because open window expired
- auto-sell success or failure
- low funds

Do not store webhook URLs in Git.
