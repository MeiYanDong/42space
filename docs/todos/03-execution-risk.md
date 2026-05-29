# Execution And Risk Todo

## Done

- [x] Configure 5 selected outcomes per market.
- [x] Configure `5U` per selected outcome.
- [x] Use `lowest_odds` selection.
- [x] Add hard open-window skip behavior.
- [x] Add auto-sell policy concept: `2x` sell `50%`.
- [x] Add dry-run self-test coverage.
- [x] Add startup Router auto-approval before live monitoring.
- [x] Allow partial same-start batch execution when funds cover only some complete markets.
- [x] Remove fund-binding semantics: live execution recalculates wallet budget and discards stale pre-signed bundles.
- [x] Add buy/auto-sell transaction lock in the long-running process.
- [x] Pause auto-sell after hot buy pre-signing until the open window has passed.
- [x] Force manual sell quote path to dry-run even when dashboard inherits production execute env.
- [x] Preserve speed-first token-order fallback while keeping strict odds as an opt-in mode.
- [x] Make pre-sign, due, catch-up, and retry dry-run tests use the production discovery model: chain first, REST future fallback.
- [x] 2026-05-27 dry-run chain verification passed for pre-sign cache, due drain, catch-up, deadline skip, and retry classifier.
- [x] 2026-05-27 server deployment verification passed on `47.83.23.65`: local verify, remote verify, service restart, health check, dry-run pre-sign/due/catch-up/retry.
- [x] Move open snipe defaults to T-60s hot/pre-sign, T-750ms prebroadcast, dedicated Chainstack/Ankr broadcast, and short raw-tx rebroadcast.
- [x] Raise speed-first default gas to `2.0 gwei` after same-market audit showed first-block buyers at `1.55 gwei`.
- [x] Make partial funding BNB-aware so higher gas settings do not stop monitoring when at least one complete market can still execute.
- [x] Clean test decision-log artifacts after dry-run validation so dashboard activity does not present tests as real buys.
- [x] Persist broadcast timing, first accepted RPC timing, gas, and nonce in buy results for post-open speed audits.
- [x] Add hot-window background broadcast RPC keepalive so sendRawTransaction does not hit cold RPC connections at open.
- [x] Add single-writer risk rule for US West primary and Hong Kong standby.
- [x] 2026-05-27 US West dry-run flow passed: self-test, presign cache, due drain, catch-up, retry classifier, deadline skip, and RPC warmup; no broadcast.
- [x] 2026-05-27 update stake to `20U` per selected outcome, 5 outcomes per market, `100U` max per market and per same-start batch.
- [x] 2026-05-27 update stake to `50U` per selected outcome, 5 outcomes per market, `250U` max per market and per same-start batch.
- [x] 2026-05-27 switch current production policy back to `20U` per selected outcome, 5 lowest-odds outcomes per market, `100U` max per market.
- [x] Keep `ARM_WAIT_FOR_FUNDING=0` so the bot continues monitoring new markets even when the current wallet cannot fund a `100U` market.
- [x] Put single-market buys and pre-sign nonce reservation behind the same transaction lock used by bundle buys, and recheck auto-sell pause before any auto-sell execution.
- [x] Block Dashboard manual sell execution during the pre-sign/open-buy hot window so a separate sell process cannot steal the buy nonce.
- [x] Block manual real `event:buy` and bundle buy execution after `EVENT_OPEN_WINDOW_SECONDS`; the 60s deadline now applies at the final broadcast entrypoint, not only in the watcher.
- [x] 2026-05-27 tighten `EVENT_OPEN_WINDOW_SECONDS` to `5`; any market not bought within 5 seconds after open is marked skipped and all live buy entrypoints refuse it.
- [x] Keep pre-open raw-tx broadcast as the first-buyer strategy; the GTA failure was OOG after entering the opening block, not proof that prebroadcast should be disabled.
- [x] 2026-05-27 GTA incident trace: failed buy was `txIndex=11` in the opening block, before the first successful buyer at `txIndex=191`, but reverted from `out of gas`; raise 9-outcome single-market dynamic gas from `3.15M` to `4.8M` and add self-test coverage.
- [x] Make funding-blocked logs distinguish BUSDT, allowance, and BNB gas reserve instead of always claiming higher-priority BUSDT allocation.
- [x] Add auto stop-loss: if full-exit quote is down at least 10% from cost basis, sell 100%; stop-loss and take-profit use separate dedupe keys.
- [x] 2026-05-27 raise fast dynamic gas again for OOG safety: 9-outcome single-market path now computes `7.0M`, and 3-market/15-outcome bundle computes `11.7M` under the new caps.
- [x] Block Dashboard manual sell quotes as well as execution during the hot window; default guard is `PRE_SIGN_WINDOW_MS + 15s` before open through `EVENT_OPEN_WINDOW_SECONDS + 15s` after open.
- [x] 2026-05-27 change fast buy gas policy to wallet-budget mode: pre-sign and fallback signing use pending BNB balance / configured gas price as the effective gas limit, so fixed `FAST_GAS_LIMIT` values no longer cap opening buys when BNB can cover more.
- [x] 2026-05-27 replace `2x sell 50%` with new-position ladder exit: buy+30s start, sell 10% of initial outcome tokens every 15s, single-outcome -10% stop-loss sells that outcome fully, and due sells use `minOut=1` without price binding.
- [x] 2026-05-28 `$光源` incident: wallet-budget gas signed `18,012,201`, but BSC rejected tx gas above `16,777,216` before mempool entry; add `FAST_GAS_TX_LIMIT=16777216` and self-test coverage.
- [x] 2026-05-28 tighten new-position ladder exit to buy+10s start and sell 10% of initial outcome tokens every 10s.
- [x] 2026-05-28 `$GENIUS` incident: T-750ms pre-open broadcast landed in the previous BSC block and reverted before market open; make pre-open broadcast opt-in/off by default and discard mined reverted pre-signed raw tx instead of reusing it.
- [x] 2026-05-28 optimize post-open first broadcast: add exact open-time scheduler, short final spin, and bypass the due-time funding RPC when a valid pre-signed raw tx already exists.
- [x] 2026-05-28 detach receipt waiting from the buy transaction lock: fast buy marks RPC-accepted raw tx as submitted, releases the lock immediately, and records receipt success/failure in the background.
- [x] 2026-05-28 fix `presign-test` and `due-test` to use a budget-capped same-start batch and fail hard if no reusable pre-signed transaction exists; tests now cover both single and bundled pre-sign shapes.
- [x] 2026-05-29 harden auto-sell around buys: known pending openings pause operator approvals and sells, operator approval is prewarmed separately, due sells are cross-market chunked, and sell state updates only on successful receipt.
- [x] 2026-05-29 include broadcast-accepted buys in auto-sell eligibility; the actual open-position pull still gates real sell actions, so failed broadcasts do not create sellable positions.
- [x] 2026-05-29 make cancelled follow state a live buy blocker; pending records are dropped and pre-signed raw buys are discarded before due execution.

## Next

- [x] Deploy startup auto-approval to `47.83.23.65`.
- [x] Confirm production logs show `event-router-approval-startup`.
- [ ] Re-run live buy-path verification on the next eligible opening after the speed-first fallback correction.
- [ ] Compare next live buy against same-market first-block transactions and tune post-open broadcast/gas from evidence.
- [ ] Record next post-open scheduled timer latency, broadcast start, first accepted RPC, and async receipt result after the broadcast-only lock deploy.
- [ ] After US West cutover, compare first accepted RPC timing against the prior Hong Kong baseline.
- [ ] Fix `event:bench` to use the production discovery model. Current benchmark command is chain-future-only and can miss REST future markets.
- [x] Confirm current production env now matches `5 outcomes * 20U`.
- [x] Confirm current production env now matches `5 outcomes * 50U`.
- [x] Confirm current production env now matches `5 lowest-odds outcomes * 20U`.
- [ ] Add explicit per-market max cost display to dashboard.
- [ ] Make failed broadcast reasons visible in activity.
- [ ] Add a live incident replay for out-of-gas opening revert + expired-window manual rescue to prevent repeating the GTA failure mode.
- [ ] Add a replay for previous-block pre-open revert so `ALLOW_PREOPEN_BROADCAST=0` and terminal pre-signed discard cannot regress.
- [ ] Add a replay for over-cap gas signing so wallet-budget mode cannot regress past the BSC single-transaction gas cap.
- [x] Confirm auto-sell records partial sells clearly.
- [ ] Promote the current transaction lock into a full priority Tx Scheduler after the next live buy/sell proof, so all chain-writing actions share explicit priority state instead of direct function calls.
- [ ] Add a small replay covering duplicate prevention after restart.

## Update Rule

Update this file after buy, sell, funding, caps, retry, receipt, or persistence changes.
