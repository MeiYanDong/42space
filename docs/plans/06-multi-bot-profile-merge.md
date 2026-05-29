# Multi Bot Profile Merge Plan

## Objective

Make `MeiYanDong/42space` the single canonical codebase for both live bot lines:

- `42space`: current production bot.
- `42space-2`: independent A/B testing bot.

The goal is to stop maintaining two diverging code forks while preserving the operational isolation that protects wallet nonce safety, RPC behavior, dashboard state, data files, Feishu alerts, and risk parameters.

## User Decisions

- Canonical repository: `MeiYanDong/42space`.
- `42space-2` is not a long-term code fork; it becomes an A/B testing bot profile running the same code.
- Dashboard remains independent per bot.
- Data, wallet, private key, RPC, Feishu webhook, buy parameters, sell parameters, gas settings, runtime config, and service names must remain isolated.
- Both bots are allowed to buy the same eligible market. They are independent bots with independent wallets and exposure.
- Frontend may edit runtime trading parameters, including gas price, but not secrets.
- `42space-2` improvements must be migrated into the canonical repo before the fork is retired:
  - auto-sell circuit breaker after repeated failures;
  - auto-sell gas guard and BNB reserve checks;
  - failure cooldown and Feishu dedupe/cooldown;
  - sell amount normalization to the `0.01` outcome-token tick;
  - direct `amountOt` sell paths also round down, not only percentage sells;
  - sub-tick sell amounts become zero and are not broadcast;
  - large `fills.jsonl` hot paths use bounded tail reads, not full-file scans;
  - auto-sell eligibility keeps position-state fallback so tail reads do not drop old valid positions;
  - runtime strategy controls from dashboard.

## Non-Goals

- Do not merge the two wallets into one process-level signer.
- Do not share a private key, wallet address, RPC endpoint, Feishu webhook, data directory, runtime config, or dashboard port.
- Do not introduce cross-bot market allocation. If both bots like the same event, both may buy.
- Do not move production `42space` to the new profile layout until the canonical repo has passed local verification and `42space-2` has validated the merged code.
- Do not expose secrets in dashboard, logs, Git, docs, `todo.md`, or command output.

## Current State

### Production Bot

- Local source: `/Users/myandong/Projects/42space`
- GitHub repo: `MeiYanDong/42space`
- Server code path: `/opt/42space`
- Env file: `/etc/42space/42space.env`
- Dashboard: `http://47.251.26.212:4242/`
- Services:
  - `42space-event-arm.service`
  - `42space-dashboard.service`

### A/B Bot

- Local source: `/Users/myandong/Projects/42space-2`
- GitHub repo: `MeiYanDong/42space-2`
- Server code path: `/opt/42space-2`
- Env file: `/etc/42space-2/42space.env`
- Dashboard: `http://47.251.26.212:4243/`
- Services:
  - `42space-2-event-arm.service`
  - `42space-2-dashboard.service`

## Target Architecture

### Recommended Runtime Model

Use one shared codebase with multiple isolated bot profiles:

```text
MeiYanDong/42space
  src/
  public/
  docs/
  package.json

42space profile
  env: /etc/42space/42space.env
  data: /opt/42space/data
  dashboard: 4242
  services: 42space-event-arm.service, 42space-dashboard.service

42space-2 profile
  env: /etc/42space-2/42space.env
  data: /opt/42space-2/data
  dashboard: 4243
  services: 42space-2-event-arm.service, 42space-2-dashboard.service
```

The first migration stage may keep two server code directories for safer rollout, but the source of truth for code must be `MeiYanDong/42space`. Once stable, `/opt/42space-2` can be updated from the canonical repo instead of from the `42space-2` fork.

### Why Not One Process With Two Wallets

The current worker is designed around one config object, one private key, one nonce domain, one transaction lock, one pending-open queue, one auto-sell monitor, and one log/data namespace. Running two wallets inside one long-lived Node process would couple failure domains:

- one CPU or memory leak can stall both bots;
- one dashboard refresh issue can affect both overview surfaces;
- one uncaught exception can stop both strategies;
- transaction priority and nonce locks become harder to audit;
- logs and runtime state need additional namespacing everywhere.

The safer design is multi-profile, multi-process isolation with shared code.

## Profile Contract

Each bot profile owns the following values.

### Identity And Secrets

- `BOT_NAME`
- `PRIVATE_KEY`
- `WALLET_ADDRESS`
- `PRIVATE_KEY_KEYCHAIN_SERVICE`
- `PRIVATE_KEY_KEYCHAIN_ACCOUNT`
- `DISABLE_KEYCHAIN_PRIVATE_KEY`

These are profile-specific and must never be committed.

### RPC And Broadcast

- `BSC_RPC_URL`
- `BSC_WS_URL`
- `CHAINSTACK_BSC_RPC_URL`
- `CHAINSTACK_BSC_WS_URL`
- `ANKR_BSC_RPC_URL`
- `ANKR_BSC_WS_URL`
- fanout broadcast settings

RPC isolation is required so one bot's provider throttling or latency does not directly affect the other bot.

### Dashboard And Service Control

- `DASHBOARD_HOST`
- `DASHBOARD_PORT`
- `DASHBOARD_WALLET`
- `BOT_SYSTEMD_SERVICE`
- `DASHBOARD_ADMIN_TOKEN`
- `DASHBOARD_RUNTIME_RESTART`
- `RUNTIME_CONFIG_FILE`

Dashboard actions must restart only the worker service for the same profile.

### Data Files

- `STATE_FILE`
- `FILLS_FILE`
- `MARKET_DECISIONS_FILE`
- `AUTO_SELL_STATE_FILE`
- `AUTO_SELL_POSITION_STATE_FILE`
- `AUTO_SELL_CIRCUIT_STATE_FILE`
- dashboard action logs
- runtime config JSON

Data files must be profile-local. No bot may read or write the other bot's fills, decisions, auto-sell state, or runtime config.

### Buy Strategy

- `EVENT_OUTCOME_COUNT`
- `EVENT_OUTCOME_SELECTION`
- `EVENT_OUTCOME_SELECTION_FALLBACK`
- `STAKE_PER_OUTCOME_USDT`
- `MAX_MARKET_STAKE_USDT`
- `MAX_BATCH_STAKE_USDT`
- `MARKET_CATEGORY_BLOCKLIST`
- `MARKET_TAG_BLOCKLIST`
- `MIN_EVENT_DURATION_HOURS`
- open-window and pre-sign parameters

The current production profile can keep production filtering, while `42space-2` can run A/B test parameters such as price-only filtering, two outcomes, or smaller stake.

### Sell Strategy

- `AUTO_SELL_ENABLED`
- `AUTO_SELL_STRATEGY`
- `AUTO_SELL_START_DELAY_SECONDS`
- `AUTO_SELL_INTERVAL_SECONDS`
- `AUTO_SELL_CHUNK_PERCENT`
- `AUTO_SELL_STOP_LOSS_ENABLED`
- `AUTO_SELL_STOP_LOSS_PERCENT`
- `AUTO_SELL_STOP_LOSS_SELL_PERCENT`
- sell batch caps
- operator approval policy
- circuit breaker policy

Sell behavior must be profile-specific. A circuit breaker opening for `42space-2` must not pause production `42space`.

### Gas And Safety

- `GAS_PRICE_GWEI`
- `FAST_GAS_LIMIT`
- `BUNDLE_FAST_GAS_LIMIT`
- `FAST_GAS_WALLET_BUDGET`
- `FAST_GAS_TX_LIMIT`
- `AUTO_SELL_MIN_BNB_RESERVE`
- `AUTO_SELL_MAX_GAS_PER_TX`

Gas price may be editable from dashboard per profile. Private keys and RPC endpoints may not be editable from dashboard.

## Dashboard Runtime Config Requirements

Dashboard runtime controls must support profile-local updates for:

- filter mode: production filtering or price-only test filtering;
- outcome count;
- stake per outcome;
- max batch stake;
- gas price in gwei;
- auto-sell enabled flag;
- ladder start delay;
- ladder interval;
- ladder chunk percent;
- stop-loss percent;
- stop-loss sell percent.

Runtime config writes must:

- require `DASHBOARD_ADMIN_TOKEN`;
- write only to the current profile's `RUNTIME_CONFIG_FILE`;
- never write secrets;
- restart only `BOT_SYSTEMD_SERVICE` for the current profile when enabled;
- show the effective running config in the overview.

## Safety And Risk Requirements

- Private keys must not appear in docs, logs, command output, or Git.
- The buy transaction lock remains per process/profile.
- Auto-sell must pause around known buy hot windows.
- Manual dashboard sell quote and execution must remain blocked during buy hot windows.
- `42space-2` failure must not stop production services.
- Large JSONL files must never be full-scanned in dashboard refresh or auto-sell ticks.
- Auto-sell errors must be compacted before Feishu and logs to avoid huge repeated JSONL writes.
- Failed sell loops must stop through cooldown/circuit breaker before repeated gas burn.
- Sell amounts must be normalized to curve precision before quote/simulation/execution.

## Migration Plan

### Phase 1: Documentation And Diff Audit

- Record this plan as the accepted technical contract.
- Record a checkbox todo list for implementation.
- Compare `42space` and `42space-2`.
- Identify which `42space-2` fixes are missing from canonical `42space`.

### Phase 2: Canonical Code Migration

- Migrate runtime config support into `MeiYanDong/42space`.
- Migrate dashboard runtime controls.
- Migrate auto-sell circuit breaker, cooldown, compact errors, gas guard, and Feishu cooldown.
- Migrate sell amount tick normalization for both percentage and direct amount paths.
- Migrate JSONL tail-read hotfixes.
- Preserve production defaults in the canonical repo:
  - default bot name remains `42space`;
  - default dashboard port remains `4242`;
  - default systemd worker service remains `42space-event-arm.service`;
  - default `GAS_PRICE_GWEI` remains production-oriented unless profile env overrides it.

### Phase 3: Local Verification

- Run syntax checks and event self-test.
- Confirm tests cover:
  - circuit breaker opening after repeated failures;
  - sell amount tick rounding;
  - sub-tick sell amount rejection;
  - tail-read eligibility and position-state fallback;
  - runtime config validation.
- Confirm no secret values were added to Git.

### Phase 4: A/B Bot Rollout

- Deploy canonical code to `42space-2` first.
- Keep `/etc/42space-2/42space.env`, `/opt/42space-2/data`, port `4243`, and `42space-2-*` service names.
- Verify dashboard and worker are active.
- Verify `/api/overview` returns `ok: true`.
- Confirm production `42space` remains active.

### Phase 5: Production Rollout

- Only after explicit operator approval, deploy canonical code to production `42space`.
- Preserve `/etc/42space/42space.env`, `/opt/42space/data`, port `4242`, and production service names.
- Verify production health.
- Keep rollback path available.

## Definition Of Done

- `docs/plan.md` and `docs/todo.md` point to the multi-bot merge plan.
- `docs/plans/06-multi-bot-profile-merge.md` describes the accepted requirements and safety boundaries.
- `docs/todos/06-multi-bot-profile-merge.md` tracks implementation with checkboxes.
- `MeiYanDong/42space` contains the `42space-2` sell protection and CPU hotfixes.
- `npm run verify` passes in `MeiYanDong/42space`.
- Runtime config supports profile-local gas price and sell/buy controls.
- No secrets are committed.
- Server rollout remains separated by profile and never stops production without explicit approval.
