# Execution And Risk Plan

## Objective

Make the buy path simple, fast, and bounded.

## Current Buy Policy

- Select the 5 lowest-odds outcomes.
- Buy `20U` per selected outcome.
- Maximum normal cost per market: `100U`.
- Buy only inside the open window.
- Skip if the first successful buy cannot happen within `EVENT_OPEN_WINDOW_SECONDS`.
- Every live buy entrypoint, including manual `event:buy`, must enforce the same open-window deadline before signing or broadcasting.

## Execution Path

1. Discover market.
2. Normalize and filter.
3. Hydrate outcomes and odds.
4. Build buy plan.
5. Check BUSDT and BNB.
6. Enter hot snipe state 60s before open: no hot-path REST dependency, sync nonce, prebuild, and presign.
7. Prebroadcast the signed raw transaction shortly before open and keep rebroadcasting through dedicated RPCs.
8. Store receipt and position state.
9. Alert operator.

## Verification Model

Regression tests must mirror production discovery:

- Prefer chain/WSS when it has the future market.
- Fall back to REST `status=all` for future markets visible on the website but missing from the current controller-log replay.
- Keep tests dry-run or public-test-key only unless explicitly validating a real buy with small capital.
- After server dry-run tests, remove `dry-run` and `catchup-test` decision-log rows from the production dashboard log. Test records must not look like real buys.

## Speed Priorities

- Use WSS or hot polling for early signal.
- Use REST as sidecar completeness source.
- Prebuild pending market bundles before the hot window.
- Use Chainstack and Ankr for raw transaction fanout; public RPC is only fallback when dedicated endpoints are absent.
- Use T-60s hot/pre-sign and pre-open raw-tx broadcast for first-block priority. Turning off prebroadcast is not a valid first-buyer strategy.
- Size fast gas limit from the bot wallet's BNB budget, not from an artificial conservative cap. The GTA transaction entered the first block before the first successful buyer but reverted because the signed gas limit was too low.
- Avoid per-outcome slow simulation in the hot path.
- Batch same-start markets only when it does not hide failure evidence.
- Speed is the priority: use odds when available, but do not block the hot buy path only because odds are missing.

## Risk Boundaries

- Funding gate before live mode.
- If one opening batch has insufficient BUSDT or BNB, buy the highest-priority complete markets that fit the wallet budget; do not block the whole batch.
- No funds are bound to future events. Every hot/open execution recalculates from current BUSDT balance and Router allowance.
- Router BUSDT allowance is checked at startup and auto-approved before monitoring.
- Pre-signed transactions are reused only when the exact market bundle still matches. If the bundle changes before open, discard the old signature and reset nonce from chain pending state.
- Buy execution and auto-sell execution share an in-process transaction lock so auto-sell does not compete with open-buy for nonce or broadcast timing.
- After buy transactions are pre-signed, auto-sell pauses through the open window to avoid consuming the reserved nonce.
- Dashboard manual sell quote and execution are blocked during the pre-sign/open-buy hot window because they run in a separate process and could otherwise create a human workflow that consumes or invalidates the buy nonce.
- Across servers, the production wallet has a single active writer. Do not run two independent signers for the same private key.
- Speed-first gas limit must prioritize avoiding OOG over preserving BNB. The bot wallet's BNB is the gas budget; use pending BNB balance and the configured gas price to set the real signing limit, bounded only by what the wallet and current block can support. Do not confuse gas limit with gas price: the GTA failure was OOG, so the primary fix is a larger gas limit, not blindly raising gas price.
- During the hot window, broadcast RPC clients should be kept warm in the background; keepalive must never block WSS or due execution.
- Per-market and per-batch caps.
- Manual rescue commands are not exempt from the open-window cap unless `ALLOW_LATE_BUY=1` is intentionally set for an explicit exception.
- Persist seen/skipped markets to avoid duplicate buying.
- Persist receipts and fills atomically.
- Persist broadcast start, first RPC acceptance, gas, and nonce in buy results so delayed buys can be audited without guessing.
- Never expose private key in logs, docs, or command history.

## Auto-Sell Policy

Current intended policy:

- Applies only to positions bought after the configured `AUTO_SELL_APPLY_AFTER_ISO` cutover timestamp.
- After a successful buy, each outcome starts a ladder exit at `T+30s`.
- Every `15s`, sell `10%` of that outcome's initial token amount.
- If one outcome's full-exit quote is down at least `10%` from its current cost basis, stop that outcome's ladder and sell all remaining tokens for that outcome.
- Other outcomes in the same market continue their own ladders after one outcome stop-losses.
- Automatic sells do not bind price; use `minOut=1`. If a sell quote fails on a due ladder step, still execute the scheduled sell directly.
- Group all due outcomes for the same market into one batch sell transaction when possible.
- Buy hot windows take priority; ladder/stop-loss sells pause when open-buy pre-sign or broadcast is active.
- Human dashboard must still allow manual sell.
- Manual sell quote must never execute a sell. The sell command only executes when `--execute` or `--real` is passed.

## Current Risk

Buying has real success history, but source attribution and failed/blocked funding evidence must keep improving before increasing capital.
