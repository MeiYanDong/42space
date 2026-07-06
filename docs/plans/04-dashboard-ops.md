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

Bot2, Bot3, and staged Bot5 `即将开盘` keep display broader than buy eligibility. They hide only explicitly filtered noise: Price, 8 hour, automated, clock-curve, known daily/weekly/monthly fixed templates, World Cup single-day total goals, and sports side markets such as Total Goals, Total Score, Goal Differential, Score Differential, `總進球數`, or `净胜球數`. Other non-filtered events remain visible and notifiable even when they are not buy-eligible. Meme, Binance strong, FIFA/Sports exact-score, and World Cup player-performance prop markets are marked as default-display focus classes.

Strategy question allowlists must not hide the `即将开盘` page. A profile can set a hard buy boundary such as `MARKET_QUESTION_ALLOWLIST_REGEX=a^` to prevent unplanned auto-buy, while exact-score and other non-filtered events still display as observation rows.

Bot4 inverts that display model for recurring-template operations: `EVENT_DISPLAY_INCLUDE_RULES=daily_fixed_template` makes `即将开盘` show only daily fixed templates. Its buy rule is narrower and profile-local, so seeing a template on the page does not mean Bot4 will buy it.

### Upcoming

Show markets that may be bought:

- title
- starts in
- ends in
- duration
- category
- decision: pending or skipped
- reason

The Strategy page shows the active rule summary in operator terms:

- auto-filter: Price/8hour/automated, recurring daily templates, and sports Total Goals/Goal Differential side markets
- positive display allowlist when enabled, for example Bot4's `只显示：日常固定模板`
- default-display/notification: all non-filtered events, with focus tags for Meme, Binance strong, exact-score, and player-performance props
- default-follow: only Meme and Binance strong; manual follow or planned buy is required for other displayed markets
- runtime risk controls: show buy gas and sell gas as separate fields so event-specific high buy gas does not overwrite the low-priority auto-sell gas setting

### Holdings

`项目持仓` is an independent page. It combines default-followed strategy matches, manually followed markets, current holdings, and a hidden-by-default history section for projects that have been fully sold. The page uses project/event rows as the primary object: the event header shows identity, follow/status, market open time, and match start time when known; the header's right side shows only project-level financial totals. Option-level rows live under expansion and carry per-option prices, chips, PnL, and sell controls.

Show current bot positions:

- market
- outcome
- remaining chips
- invested amount: cumulative buy amount, never reduced by partial sells
- sold amount
- current sell value for remaining position
- realized profit/loss from sold portions
- unrealized profit/loss from remaining position
- gross profit/loss before Gas
- Gas cost
- net profit/loss after Gas
- multiplier
- sell button
- one-click sell button for all open outcomes in one market
- manual sell disabled state during buy protection windows

Historical projects use the same project row shape. A historical row can be expanded to show option-level buy price, bought, sold, realized PnL, Gas, net PnL, ROI, token ID, and last activity time.

### PnL

Show:

- total invested, sold, current value, realized profit/loss, unrealized profit/loss, Gas cost, gross profit/loss, and net profit/loss
- per-market invested, sold, current value, realized profit/loss, unrealized profit/loss, Gas cost, gross profit/loss, and net profit/loss inside the project row instead of a separate duplicate project-statistics panel
- invested is computed from buy activity; open positions only provide remaining value and unrealized profit/loss
- Gas is computed from the profile-local Gas ledger and allocated by tx metadata to market/outcome/action. Net profit/loss is gross profit/loss minus priced Gas cost; exact BNB Gas without USDT pricing remains visible as unpriced Gas until backfilled.
- settlement/finalise activity is treated as recovered value plus realized profit/loss, so resolved hold-to-settlement projects do not disappear as zero-PnL closed positions
- project statistics are ordered by latest project trade time first, so recently active historical projects stay at the top

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

## Runtime Load Control

Dashboard overview is an operator view, not a trading prerequisite. On the multi-profile production host, each overview build runs child `event-sniper.js status` and `positions` commands. With five live profile dashboards, startup or periodic background refreshes can create simultaneous child-process bursts that contend with event workers on the 2GB SWAS host.

Production dashboards should set `DASHBOARD_STARTUP_REFRESH=0` and `DASHBOARD_OVERVIEW_REFRESH_MS=0` when the host is resource-constrained. This keeps the dashboard HTTP service available and still allows on-demand `/api/overview` when an operator opens a page, but avoids unattended background refresh work that can interfere with buy readiness. The frontend should avoid high-frequency overview polling; visible dashboard tabs refresh at a slower interval, hidden tabs do not auto-refresh, and the manual refresh button may call `/api/overview?refresh=1` to bypass the server-side cache.

## Current Gap

Market source labels are still not simplified for operators. The next dashboard improvement is to show source as Website, Chain, or Both without exposing raw fields.

## Analysis Tooling

Daily volume markets need a reusable hourly heatmap before making a trading decision. The `volume:heatmap` command keeps a local Binance Futures 1h kline cache, prints dates horizontally and UTC hours vertically, compares today's completed or live hours against the prior 7 complete UTC days, and projects conservative, median, and hot final ranges.

## Alerting

Feishu alerts should render as operator-facing cards first, with a clean text fallback if the webhook rejects interactive cards. The card body should use Chinese labels, show only 3 to 5 useful facts, and keep raw technical fields in JSONL logs instead of sending them to operators.

Noisy operational alerts should be action-window based. Normal low-funds status belongs in the dashboard and JSONL logs only; Feishu low-funds alerts are reserved for the T-30m/T-5m reminder stage before the next opening, then stay silent until the gap, next opening, or readiness changes. Receipt success stays in fills/decision logs only; receipt failure sends Feishu. Automatic-sell success stays in logs only; automatic-sell failure or circuit pause sends one concise card and is deduped through the profile-local alert state file. Short 42 positions API 5xx/429/network/invalid-JSON outages during auto-sell are log-only retryable skips; only a prolonged consecutive outage should notify.

Feishu alerts should fire for:

- service start
- eligible new market accepted for pending or immediate buy
- buy broadcast
- buy failure
- receipt failure
- auto-sell failure or circuit pause
- low funds state changes

Event intelligence for close-open non-template new markets writes JSONL/Markdown reports first. Bot1 keeps the existing close-open non-template alert path. Bot2, Bot3, and staged Bot5 use notification paths for all events not hidden by their enabled display-filter rules; Meme, Binance strong, FIFA/Sports exact-score, and World Cup player-performance props are focus tags, not the only notification classes. The frontend exposes `价格`, `日常固定模板`, `总进球数`, and `净胜球数` as runtime checkbox filters; `价格` now hides only BTC Price classes, so non-BTC Meme price-range events remain visible/notifiable, and unchecking all filters shows all monitored data-complete live/not-started events. Strong Binance-relevance alerts remain available through `EVENT_INTEL_NOTIFY_STRONG=1`, and all event-intelligence notifications dedupe through `EVENT_INTEL_NOTIFY_SEEN_FILE`; shared watcher fanout uses profile scopes such as `bot2-focus`, `bot3-filtered`, and `bot5-focus` so chats do not suppress one another. Bot3 shares the display/notification filters only; Bot2's Meme/Binance strong default-follow buy filter is not part of the Bot3 migration. Bot5 deliberately opts into Bot2-like buy/filter summaries through `EVENT_PROFILE_ROLE=bot2_like` while keeping its state and webhook independent.

Do not store webhook URLs in Git.
