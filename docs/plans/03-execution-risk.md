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
7. Schedule the signed raw transaction for the exact post-open action time and keep rebroadcasting through dedicated RPCs.
8. Mark accepted broadcast as submitted, then store receipt and position state asynchronously.
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
- Use T-60s hot/pre-sign, but do not broadcast before the contract's open time by default. The `$GENIUS` incident showed T-750ms can land in the previous BSC block and revert before the market opens.
- The post-open action time is `start + OPEN_BROADCAST_DELAY_MS` when pre-open broadcast is disabled. A dedicated timer is armed inside the hot window; its final `OPEN_BROADCAST_SPIN_MS` is reserved for reducing Node timer jitter before raw-tx fanout.
- The buy transaction lock covers signing and raw-tx broadcast only. It must not wait for receipt, because receipt waiting can block the next opening.
- Size fast gas limit from the bot wallet's BNB budget, not from an artificial conservative cap. The GTA transaction entered the first block before the first successful buyer but reverted because the signed gas limit was too low.
- Avoid per-outcome slow simulation in the hot path.
- Batch same-start markets only when it does not hide failure evidence.
- Speed is the priority: use odds when available, but do not block the hot buy path only because odds are missing.

## Risk Boundaries

- Funding gate before live mode.
- If one opening batch has insufficient BUSDT or BNB, buy the highest-priority complete markets that fit the wallet budget; do not block the whole batch.
- No funds are bound on-chain to future events. The hot window checks funding before pre-signing; once a raw transaction is pre-signed, the open-time hot path trusts that snapshot and does not spend an extra balance/allowance RPC roundtrip before broadcasting.
- Router BUSDT allowance is checked at startup and auto-approved before monitoring.
- Pre-signed transactions are reused only when the exact market bundle still matches. If the bundle changes before open, discard the old signature and reset nonce from chain pending state.
- If a pre-signed transaction is mined and reverts, do not keep reusing the same raw transaction. If the failure came from explicit pre-open broadcast and the market is still inside the open window, discard the signature, sync nonce, and retry once through the normal due path; otherwise stop retrying that market to avoid repeated gas burn.
- Buy execution and auto-sell execution share an in-process transaction lock so auto-sell does not compete with open-buy for nonce or broadcast timing.
- After buy transactions are pre-signed, auto-sell pauses through the open window to avoid consuming the reserved nonce.
- Auto-sell also checks the known pending buy queue, not just the current transaction lock. By default it pauses from `AUTO_SELL_BUY_GUARD_BEFORE_MS=120000` before a known open through `AUTO_SELL_BUY_GUARD_AFTER_MS=10000` after the open window, so a long sell or approval queue cannot start just before a buy.
- Dashboard manual sell quote and execution are blocked during the pre-sign/open-buy hot window because they run in a separate process and could otherwise create a human workflow that consumes or invalidates the buy nonce.
- Across servers, the production wallet has a single active writer. Do not run two independent signers for the same private key.
- Speed-first gas limit must prioritize avoiding OOG over preserving BNB. The bot wallet's BNB is the gas budget; use pending BNB balance and the configured gas price to set the real signing limit, bounded by wallet balance, current block constraints, and the BSC single-transaction gas cap. Do not confuse gas limit with gas price: the GTA failure was OOG, while the `$光源` failure was an over-cap gas limit rejected before mempool entry.
- During the hot window, broadcast RPC clients should be kept warm in the background; keepalive must never block WSS or due execution.
- Per-market and per-batch caps.
- Manual rescue commands are not exempt from the open-window cap unless `ALLOW_LATE_BUY=1` is intentionally set for an explicit exception.
- Persist seen/skipped/submitted markets to avoid duplicate buying and duplicate gas burn.
- Persist receipts and fills atomically.
- Persist broadcast start, first RPC acceptance, gas, and nonce in buy results so delayed buys can be audited without guessing.
- Never expose private key in logs, docs, or command history.

## Auto-Sell Policy

Current intended policy:

- Applies only to positions bought after the configured `AUTO_SELL_APPLY_AFTER_ISO` cutover timestamp.
- After a successful buy, each outcome starts a ladder exit at `T+10s`.
- Every `10s`, sell `10%` of that outcome's initial token amount.
- If one outcome's full-exit quote is down at least `10%` from its current cost basis, stop that outcome's ladder and sell all remaining tokens for that outcome.
- Other outcomes in the same market continue their own ladders after one outcome stop-losses.
- Automatic sells do not bind price; use `minOut=1`. If a sell quote fails on a due ladder step, still execute the scheduled sell directly.
- Before the first sell for a market, the bot tries to preapprove Router as operator with low priority. The actual sell path requires preapproved operators by default, so it does not insert surprise `setOperator` transactions into the sell batch.
- Group due outcomes across markets into capped sell batches when possible. Each outcome keeps independent ladder/stop-loss state; batching is execution optimization only.
- Buy hot windows take priority; ladder/stop-loss sells and operator approvals pause when a known buy is near, when open-buy pre-sign/broadcast is active, or when the transaction lock is busy.
- Sell batch size is capped by outcome count, market count, gas estimate, and max transactions per tick. Receipt success is required before updating outcome ladder state.
- Human dashboard must still allow manual sell.
- Manual sell quote must never execute a sell. The sell command only executes when `--execute` or `--real` is passed.

## Current Risk

Buying has real success history, but source attribution and failed/blocked funding evidence must keep improving before increasing capital.
