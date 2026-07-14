# Execution And Risk Plan

## Objective

Make the buy path simple, fast, and bounded.

## Current Buy Policy

- Bot2 selects the first 3 outcomes by display/token order.
- For FDV/market-cap range events, Bot2 buys the first 3 market-cap ranges.
- Buy `10U` per selected outcome for the normal Bot2 default path.
- Maximum normal cost per market: `30U`.
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
7. Schedule the signed raw transaction for the exact post-open action time and keep rebroadcasting through dedicated RPCs; if the hot path has to sign just-in-time, rebroadcast that raw transaction too. When a ranking-sensitive Builder plan is enabled, pre-sign `buy nonce N + tip nonce N+1`, submit the private bundle `300ms` before the inferred T+19/T+20 boundary, and send the same buy raw transaction through the profile's public RPCs at its configured fallback time if the Builder request is still in flight. The in-flight promise is reused so the fallback cannot create a second Builder request. `maxTimestamp` expires the bundle at the end of the target second; no code path treats `minTimestamp` as an enforceable lower bound.
8. Mark accepted broadcast as submitted, then store receipt and position state asynchronously; if receipt watching times out, probe the chain and record whether the tx is still pending or dropped.
9. Alert operator.

## Verification Model

Regression tests must mirror production discovery:

- Prefer chain/WSS when it has the future market.
- Fall back to REST `status=all` for future markets visible on the website but missing from the current controller-log replay.
- Keep tests dry-run or public-test-key only unless explicitly validating a real buy with small capital.
- After server dry-run tests, remove `dry-run` and `catchup-test` decision-log rows from the production dashboard log. Test records must not look like real buys.

Anti-sniping premium measurement is read-only. It must not sign, broadcast, mutate seen/fills/runtime state, or make a buy/sell decision.

The legacy `event:premium-probe` command is a manual next-batch sampler: it observes the next same-start upcoming Event Market batch, picks only the single lowest-odds outcome for each market, and repeatedly calls `FTLensV2.simulateMint` around open. It is useful for ad hoc checks, but it can miss markets that are created while the process is sleeping on an earlier batch.

The continuous watcher is `event:premium-watch`. It is a standalone read-only process separate from `event-sniper`, with its own output files under `output/`. It continuously monitors every newly discovered supported V2 Event Market from WSS controller logs and REST `status=all`, including markets that would be filtered out by the auto-buy duration or allowlist strategy. It samples all outcomes, not only the lowest-odds outcome. The default stake ladder is `1U` plus the configured real `STAKE_PER_OUTCOME_USDT` amount, so the reports show both a small-size curve and the size relevant to the bot.

Premium watcher must stay lower priority than the live sniper. Run it with lower system priority and a dedicated read-only RPC/WSS env overlay so quote sampling cannot contend with Bot2's open-time fanout.

Premium watcher can run in notification-only mode with `PREMIUM_WATCH_PROBES_ENABLED=0` or `--no-probes`. In that mode it still performs WSS/REST discovery and starts event-intelligence notifications, but it does not arm opening-time `simulateMint` probe timers. This keeps operator notification coverage without adding premium quote load near open.

When `EVENT_DISCOVERY_FEED_FILE` is set, the watcher also writes a structured read-only discovery feed. Bot profiles may use `EVENT_DISCOVERY=feed` to consume that file instead of running continuous profile-local WSS/REST discovery. The feed is only a market observation bus: each bot still applies its own follow/planned-buy strategy, hot pre-sign, nonce manager, broadcast RPC fanout, receipt tracking, and auto-sell monitor.

Planned-buy auto-sell overrides must apply to every sell entrypoint for that buy, including the receipt-triggered fast open-exit path. A planned buy with `autoSell.enabled=false` or `autoSell.strategy=hold_to_settlement` must not schedule fast open-exit even when the profile's global strategy is `open_timed_exit`.

When premium probes are enabled, the hard invariant is: every newly observed `live` or `not_started` market with an address, a usable `startDate`, and an opening time that has not already exceeded the probe tail must get a probe timer. Strategy filters, Price tags, contract version, and missing outcomes are not allowed to block timer creation; they can only show up later as quote/sample errors in the probe output. Every unique observed market is also written to `premium-watch-discovery.jsonl` with either `scheduled`, `rescheduled`, `probe-start`, `probe-complete`, or an explicit `not-scheduled` reason.

The watcher records both local wall-clock offset and chain timestamp offset because the premium is expected to follow `block.timestamp`, not a continuous local timer. Sampling is `500ms` from local open until chain `T+22s`, with a local tail up to about `T+25s` to cover block/RPC jitter. If WSS or receipt fallback already has outcome IDs, the watcher must start `simulateMint` sampling immediately and hydrate REST metadata in the background; REST `404`/lag must not block the first post-open samples. A market is complete only after chain offset reaches at least `22s` and there are at least three valid `chainOffset >= 20s` samples. Reports should treat the chain-offset aggregate as the primary premium curve; local-offset aggregation is only timing diagnostics.

The protocol does not expose a separate `premium` field in REST activity or transaction receipts. The watcher therefore preserves raw quote fields and derives an estimated premium from the quote curve:

```text
effectiveCost(t) = collateralFromUser(t) / otToUser(t)
quoteMarkupPct(t) = (effectiveCost(t) / prePrice(t) - 1) * 100
baselineMarkupPct = median quoteMarkupPct where chainOffset >= 20s, by market/outcome/stake
estimatedPremiumPctOfBase(t) = max(0, quoteMarkupPct(t) - baselineMarkupPct)
estimatedPremiumUsdt(t) = max(0, effectiveCost(t) - prePrice(t) * (1 + baselineMarkupPct / 100)) * otToUser(t)

observedCostPremiumPct(t) = (effectiveCost(t) / baselineEffectiveCost - 1) * 100
otShortfallPct(t) = (1 - otToUser(t) / baselineOtToUser) * 100
```

`estimatedPremiumPctOfBase` is the best live estimate of the anti-sniping premium after removing the normal post-20s markup for the same market/outcome/stake. `observedCostPremiumPct` is deliberately labeled as the total observed cost curve: it includes anti-sniping premium plus any orderflow/power-curve movement already visible on-chain. Neither metric is a pure protocol-formula isolation test unless the contract later exposes the premium directly.

Premium watcher visualization is generated automatically as `<outputBase>.chart.html` after each completed probe, and can be regenerated with `npm run event:premium-chart -- --input <file.enriched.jsonl>`. The HTML chart is a read-only post-processing artifact and should show Chinese labels for estimated premium, actual cost curve, same-stake obtainable quantity, quote latency, key-second tables, and per-outcome summaries. It must keep the distinction between baseline-adjusted estimated premium and actual cost curve visible.

## Speed Priorities

- Use WSS or hot polling for early signal.
- For multi-bot production, prefer one lower-priority central discovery process on a dedicated read-only RPC/WSS pair, publishing `EVENT_DISCOVERY_FEED_FILE`, while each bot keeps isolated execution RPCs and broadcast fanout.
- Use REST as sidecar completeness source.
- Prebuild pending market bundles before the hot window.
- Use Chainstack and Ankr for raw transaction fanout; public RPC is only fallback when dedicated endpoints are absent.
- The shared 48Club file remains loaded before each profile. `BUILDER_BUNDLE_KILL_SWITCH` is the emergency override and cannot be bypassed by planned-buy rows. Unguarded fixed-lead submission is not an approved not-before mechanism. Bot2 can opt an explicit plan into the deployed timestamp guard; other profiles remain unchanged unless separately configured.
- Fast exact-in buys intentionally retain `minOut=1`, prebuilt calldata, and no opening-time Lens quote. This is the speed-first contract: no additional RPC request, no outcome-price hydration, and no re-signing are inserted between the dedicated timer and raw broadcast.
- Bot2/Bot5 Meme range intelligence is completed and frozen at shared first observation, before either profile prepares or pre-signs its buy. DEX Screener/Pyth requests never run in the opening broadcast path; there is no T-50 refresh, signature replacement, or nonce reset. Execution expands around the persisted matched bucket using the profile count: Bot2 uses three names and `30U` caps; paused Bot5 retains three.
- Startup and feed races are resolved before signing: both profiles load the shared lock file during plan preparation, and a later copy of the same first-observation lock can replace only an un-signed, timer-free fallback plan. Once pre-sign or dedicated timer ownership starts, outcome selection is immutable.
- The 2026-07-09 Bot3 live builder test bought `2026 FIFA World Cup Runner-Up?` / `Spain` for `1U` while submitting a `0.001 BNB` 48Club tip bundle. Public fanout won the actual inclusion: buy tx `0xdd499389bef5d57dd80ed23b1f49c4a5f714cc01eb24ceafbb25982cf0ae5746` landed in block `108965568`, txIndex `11`, at `1.1gwei`; builder accepted the bundle in `359ms`, but tip tx `0xa13884e9bcfba3dc1dc819200b5670b6483cf550ffa065317feeb1ad3e048614` was still not found after `maxBlockNumber=108965573`. Therefore concurrent public-fanout mode can prove builder submission latency, but it cannot guarantee the tip is paid or that the builder path wins; use `builder_only` when the operator specifically wants to require builder-paid inclusion.
- The 2026-07-09 Bot2 ASML planned-buy test verified `builder_only`: `ASML Holding N.V. (ASML) price range, end of July 15th?` bought `$1700 - $1750`, `$1750 - $1800`, and `$1800 - $1850` at `10U` each through `presigned_builder_bundle_only`. Buy tx `0x6bea5412dd963b8eeb983dbd96a14987569b0eb96391ff71755052a9ea031d6c` and tip tx `0xe0f7512296d56d3ff562b8f1fb1c46b15d402d38cbdabaf2718ebcdc71526d2c` both succeeded in block `108968007`, txIndex `1` and `2`, with a `0.002 BNB` tip.
- The ASML rank audit showed pure `builder_only` reached block `108968007`, while another same-market buy landed in the earlier open+19s block `108968006`; the hot-path builder acceptance was about `404ms`. The follow-up implementation added builder endpoint keepalive, fastest broadcast-RPC block-number racing for bundle max-block calculation, and `builder_then_fanout` with persisted `builderBundleFanoutDelayMs` / `builderBundleWaitTimedOut` fields for later receipt-level audit. The later MU builder-hybrid audit showed public fallback acceptance at `143ms` and builder acceptance at `360ms`; the current code therefore removes tip signing and default max-block lookup from the broadcast-time builder path and persists `builderBundleTipPreSigned`, `builderBundlePayloadPrebuilt`, request latency, max-block lookup latency, and payload-build latency fields.
- The 2026-07-10 Bot2 `2026 World Cup Winner market volume on 42, July 19th?` incident has a complete timing explanation. The plan's normal action was T+18.850, but `BUILDER_BUNDLE_PREPOSITION_LEAD_MS=1000` resolved the private send to T+18.000; the measured request started at T+18.006 and 48Club accepted it at T+18.260. 48Club then produced block `109095952`, whose marker transaction was txIndex `0`, buy was txIndex `1`, tip was txIndex `2`, and chain timestamp was T+18. The public fallback was skipped. BSC's current `0.45s` cadence means multiple blocks share one integer `block.timestamp`; nearby blocks `109095952/953` both had T+18 and `109095954/955` both had T+19. The submitted `minTimestamp` did not delay execution, while documented `maxTimestamp=T+19` left the bundle valid. The operator sold all six outcomes and disabled the plan.
- A production-region timing stress test then executed 24 state-free canaries. Each canary sent a Multicall3 transaction containing six `FTLensV2.simulateMint` calls (`1,845,910` gas used, close to the incident buy's `2,243,769`) without changing 42 positions. Builder-only results were T-1 `3/3` at `1000ms`, `1/2` at `500ms`, `0/7` at `300ms`, and `0/2` at `150ms`; public-only `150ms` was target-second `4/4`; hybrid Builder `300ms` plus public `150ms` was T-1 `1/6`. The hybrid early case had a mined tip and 48Club marker, so Builder, not public RPC, caused it. Fixed `300ms` is therefore an empirical improvement but not a not-before guarantee and is not approved for production.
- The enforceable replacement is `TimestampGuard.requireTimestamp(targetTimestamp)`. The deployed runtime code hash is pinned in code and verified before pre-sign. Guarded execution reserves consecutive nonces for `[guard,buy,tip]`, sets `minTimestamp=maxTimestamp=targetTimestamp` as a Builder hint/expiry, and relies on the guard transaction, not the Builder fields, for the hard constraint. A reverting guard is not allowlisted, so the atomic bundle cannot execute in a T-1 block.
- 48Club immediately rejects a guarded bundle while its simulation head is still before the target, so Bot2 retries the same pre-signed bundle every `100ms` from `T-500ms` through the target boundary. A 12-round heavy-canary run landed `10/12` in the target second with complete marker/guard/canary/tip proof, missed two rounds without paying tip or Gas, and produced `0` T-1 inclusions.
- The reliability fallback pre-propagates only the buy transaction to Chainstack and Ankr at the configured public action time. Its nonce is one above the private guard nonce, so it cannot execute early. Once an observed canonical block has `block.timestamp >= targetTimestamp`, the bot fans out the guard and re-broadcasts the buy. Four fallback canaries completed `4/4` (`2` target-second, `2` target+1) with `0` T-1. Missing tip nonce state is reset and dependent later pre-signs are cleared after receipt.
- Use T-60s hot/pre-sign, but do not broadcast before the contract's open time by default. The `$GENIUS` incident showed T-750ms can land in the previous BSC block and revert before the market opens.
- The post-open action time is `start + OPEN_BROADCAST_DELAY_MS` when pre-open broadcast is disabled. A dedicated timer is armed inside the hot window; its final `OPEN_BROADCAST_SPIN_MS` is reserved for reducing Node timer jitter before raw-tx fanout.
- Bot1 anti-snipe mode remains speed-first and strict: keep T-60s pre-sign and use `OPEN_BROADCAST_DELAY_MS=19850` with `GAS_PRICE_GWEI=2.2`, so the intended action time is fixed T+19.850s while still requiring the buy to start before the open-window cutoff. The Australia vs Egypt T+19.800 run started broadcast at T+19.805 and first accepted at T+19.851 but still landed in a T+19 timestamp block, so T+19.850 is an operator-chosen midpoint between T+19.800's 19s-block risk and T+19.900's rank loss. Fixed delay cannot guarantee both avoiding 19s premium and ranking first in the first 20s block.
- Bot1 buy broadcast is currently pinned to single Ankr by setting `BROADCAST_RPC_URLS` to the Ankr endpoint only. The read RPC remains Chainstack. This was changed after Argentina vs Cabo Verde showed Ankr was already the first accepted provider while Chainstack acceptance lagged, and the remaining rank miss came from block/tx ordering rather than dual-RPC coverage.
- The next Bot1 single-Ankr validation is Colombia vs Ghana, staged as a profile-local planned buy at T+19.850 and `2.2gwei` for the three named exact-score outcomes. Use its auto-generated Bot1 buy-rank evidence to compare single-Ankr broadcast timing against the prior dual-RPC fills.
- `OPEN_BROADCAST_MODE=block_aware_20s` exists as an optional local post-open timing implementation, but it is not deployed or active in production after the operator chose fixed timing. Do not enable it without fresh operator approval and a new calibration pass.
- Bot2 production buy defaults are intentionally aggressive for the current phase: keep T-60s pre-signing, broadcast the existing pre-signed transaction at `T+18.840s` with `GAS_PRICE_GWEI=1.1`, select the first three display/token-order outcomes at `10U` each, limit each same-start opening to the highest-priority market while `EVENT_MAX_DUE_MARKETS_PER_OPEN=1`, and accept that this can land inside the remaining anti-sniping premium window in exchange for an earlier chain position. This timing targets the first block whose `block.timestamp` is open+19s; recent BSC samples show roughly 2 to 3 blocks per timestamp second, so T+18.840 is a propagation/block-boundary optimization, not a guarantee against entering a late 18s block. As of 2026-07-03, Bot2 automatic buying is restored by clearing `MARKET_BUY_QUESTION_ALLOWLIST_REGEX`; the old Bot2 planned-buy rows remain disabled and should not be re-enabled unless the operator explicitly asks. Future eligible automatic buys now clear stale seen keys from prior pauses/filters before pre-signing or scheduling, so a restored strategy cannot pre-sign but skip the open-broadcast timer because the market was previously marked seen. The previous single-market price-gated mode is preserved as a switchable fallback, but `EVENT_PRICE_GATE_ENABLED=0` in production for this phase.
- Staged Bot5 mirrors the current Bot2 production selection and sell policy but remains a separate signer/profile with an operator-adjusted buy broadcast: `EVENT_PROFILE_ROLE=bot2_like`, shared read-only discovery feed, middle-three `10U` default buys, one market per open, `OPEN_BROADCAST_DELAY_MS=19900`, buy gas `6gwei`, sell gas `0.15gwei`, and its own Chainstack RPC/WSS, wallet, nonce, seen state, fills, and auto-sell state. Bot5 may buy the same event as Bot2; it must not share Bot2's private key, nonce manager, market-follow file, planned-buy file, or Feishu webhook.
- Bot4's OpenRouter Python plus BNB/USDT Daily Futures Volume profile uses staggered per-market execution rather than same-action bundle buys. The profile default remains `OPEN_BROADCAST_DELAY_MS=19900` and `GAS_PRICE_GWEI=0.5`, but the active OpenRouter record now overrides transport to strict atomic dual Builder: it buys `Hy3 (free)` at `20U` and `MiMo - V2.5` at `10U`, privately submits at T+19.300, targets T+20 through Bot4 executor `0xC2B2F78C620228Ea8d1B2E155664ceBbc7212148`, pays a `0.001 BNB` winning-provider tip, and cannot public-fallback. Bot4 global Builder stays disabled. Hermes OpenRouter token usage buying remains paused. The BNB/USDT record independently buys `$150M – $300M` and `$300M – $450M` at `10U` each, overrides to `openBroadcastDelayMs=22000`, uses `gasPriceGwei=0.15`, and routes raw broadcast through Bot4's secondary Chainstack RPC. `MAX_MARKET_STAKE_USDT=30` covers the OpenRouter market, `MAX_STAKE_USDT=20` covers `Hy3 (free)`, and `MAX_BATCH_STAKE_USDT=50` covers the active daily-template batch. `BUNDLE_DUE_MARKETS=0` keeps the actions independent, and `EVENT_OPEN_WINDOW_SECONDS=35` is stale-buy protection rather than the buy timestamp.
- If pre-signing was missed and the bot falls back to just-in-time `fanout_raw`, it must still schedule the same short raw-tx rebroadcast loop as `presigned_fanout_raw`; first RPC acceptance alone is not enough proof that the tx propagated.
- For explicit large-option buys such as `World Cup Winner`, use `EVENT_OUTCOME_SELECTION=names` so the hot path buys only operator-specified outcomes and does not fall back to token-order `middle`.
- For repeated operator-picked markets, prefer `EVENT_PLANNED_BUYS_FILE`: each entry binds one market/template to exact outcome names and a default `stakePerOutcomeUsdt`. Optional `stakeByOutcomeUsdt` entries override individual named outcomes; funding, risk caps, pre-signed swap amounts, receipts, and Gas-ledger allocation use the resolved values instead of multiplying one default blindly. Bot4 OpenRouter currently resolves to `Hy3 (free)=20U` and `MiMo - V2.5=10U`, total `30U`; BNB/USDT remains `10U + 10U`. Planned buys can bypass the single-market-per-open limit only for explicitly planned markets; unplanned markets still obey the global `EVENT_MAX_DUE_MARKETS_PER_OPEN` cap.
- Bot3 (`42space-3`) started live exact-score execution on 2026-06-22 after operator approval, funding, and Router approval. Profile-local planned buys remain the highest-priority execution path; do not infer Bot1/Bot2 intent from Bot3 staged or copied records. Bot3 can additionally enable `BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED=1` for a Bot3-only FIFA/Sports exact-score strategy: when no planned buy matches, it runs a read-only preview, selects the lower-price non-draw side from the original three-score tier rows, converts that side's selected five canonical scorelines into the existing `names` buy path, and uses `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT` per outcome. It still uses Bot3's current pre-sign, broadcast timing, gas, funding guard, receipt, buy-rank evidence, and default pre-start auto-sell chain.
- Bot3 USA vs Bosnia evidence showed gas price was not the reason for ranking behind `0x3a92A09faA9C1aD28b629c681c850b99607E937d`: Bot3 used `1gwei`, broadcast started at `2026-06-27T00:00:18.988Z`, first RPC accepted at `2026-06-27T00:00:19.049Z` with Ankr latency `61ms` and Chainstack latency `364ms`, then landed in block `106577487`. The earlier buyer paid `0.5gwei` but landed in previous block `106577486`; both blocks carried timestamp second `08:00:19` Beijing time. This is a propagation/block-boundary miss, so Bot3 production default was retuned from `OPEN_BROADCAST_DELAY_MS=18985` to `18900` while keeping buy gas `1gwei`.
- Bot1 USA vs Bosnia evidence showed the same issue: Bot1 scheduled T+19.985, actually started raw fanout at `2026-06-27T00:00:19.994Z`, first RPC accepted at `2026-06-27T00:00:20.066Z`, and landed in block `106577489` at txIndex `9` with `3gwei`. The lower-gas `0x604C5E022a66c29194ce43C862D5096e7Ac2E99c` transaction paid `1.1gwei` but landed in the same block at txIndex `1`, while three earlier market buys landed in `08:00:19` blocks. This is not fixed by higher gas price alone. Bot1 was briefly retuned to `18900ms`, then set to `19900ms`, then Spain T+19.700 and Australia T+19.800 both landed in 19s timestamp blocks; current Bot1 fixed timing is `OPEN_BROADCAST_DELAY_MS=19850`, buy gas is `2.2gwei`, and sell gas remains `0.15gwei`.
- Bot3 buy-rank verification uses `npm run bot3:buy-rank`. The script is read-only: it reads Bot3 fills, resolves the target buy, fetches market logs and receipts through RPC, ranks mint transactions by `blockNumber + transactionIndex`, and writes JSON/Markdown evidence under `output/bot3-buy-rank/`. It must not read private keys, broadcast transactions, or print RPC/webhook secrets. Production also runs `42space-bot3-buy-rank-evidence.timer` every two minutes with `--only-new`; it skips already collected tx hashes and writes a new report only after a new Bot3 buy. Use the next generated report to prove whether the T+18.900 timing retune produced rank 1.
- Bot1 buy-rank verification uses the same read-only evidence script with `--profile-env /etc/42space/profiles/42space.env` and writes under `/opt/42space/output/bot1-buy-rank/`. Production now runs `42space-bot1-buy-rank-evidence.timer` every two minutes with `--only-new`; it skips already collected tx hashes and should capture the next Bot1 Colombia vs Ghana fill.
- Planned-buy entries can set `openBroadcastDelayMs` or `openBroadcastDelaySeconds` to override the profile post-open broadcast delay for that market only, can set `gasPriceGwei`/`buyGasPriceGwei` to override buy gas for that market only, can set `broadcastRpcUrls`/`buyBroadcastRpcUrls` for per-record raw transaction broadcast routing, and can set a nested `builderBundle` override for per-record builder submission, BNB tip sizing, and `mode`. Scheduler, pre-sign, immediate discovery, funding reserve, bundle grouping, and buy execution must use the record-level action time/gas/RPC/builder settings so a low-gas planned buy is not mixed with a T+19.900 high-gas planned buy.
- Planned-buy entries can include `kickoffAt`; auto-sell uses it for pre-match remaining-position exits before falling back to profile-level market-start derivation. Planned buys can also carry a scoped `autoSell` override for one-off markets such as Meme FDV ranges, so global FIFA/World Cup pre-start exits do not apply to positions the operator wants to sell manually after the first take-profit.
- Planned-buy entries can set `autoSell.enabled=false` or `autoSell.strategy=hold_to_settlement` to opt that market out of the auto-sell monitor entirely, including ladder/stop-loss/pre-start exits and sell operator preapproval. Use this for settlement/claim tests where the position must remain held until finalisation.
- Planned-buy entries with a higher `stakePerOutcomeUsdt` than the global Bot2 default must also carry that value into the execution caps, including `maxStakeUsdt`, so a one-off `10U` exact-score plan is not blocked by the normal `6U` per-outcome cap during pre-sign.
- Prepared pending plans in live mode must run the same execution-allowed cap validation used by pre-sign and buy execution, so bad stake/cap/risk-ack/private-key configuration is caught before the hot window instead of first surfacing at `T-60s` or `T+19s`.
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
- `event:arm` must start the auto-sell monitor before any optional `ARM_WAIT_FOR_FUNDING` buy-funding wait. The pre-funding monitor and later `watch()` runtime share the same transaction lock; when funding becomes ready, startup Router approval waits for any active auto-sell transaction to finish, pauses new auto-sell ticks during watch startup, and syncs runtime nonce after any approval transaction. Buy funding can block new buys, but it must not block already-held position exits.
- `ARM_FUNDING_NOTIFY_WINDOW_MS` controls how early a waiting-for-funds profile may send a Feishu warning before the next known opening batch. The default remains 30 minutes; Bot4 uses a wider window so BNB shortfall is visible well before its daily 00:00 UTC OpenRouter batch.
- After buy transactions are pre-signed, auto-sell pauses through the open window to avoid consuming the reserved nonce.
- For profiles with fast open exit, market operator approval must mine before buy pre-signing. While such an exit can occur before a later pending buy, pre-sign only the earliest buy, reserve the next nonce for the exit, and release the gate after the RPC sell is accepted. If another buy is due before the randomized exit target, skip the precision exit and let the normal monitor recover later; buy ordering has priority. Never send a post-buy operator approval that can consume a future pre-signed buy nonce.
- If an operator cancels follow for a pending market, the worker drops that pending buy before pre-sign or due execution. If a signed raw transaction already exists, it is discarded and nonce is resynced from pending chain state before later buys continue.
- Auto-sell also checks the known pending buy queue, not just the current transaction lock. By default it pauses from `AUTO_SELL_BUY_GUARD_BEFORE_MS=120000` before a known open through `AUTO_SELL_BUY_GUARD_AFTER_MS=10000` after the open window, so a long sell or approval queue cannot start just before a buy.
- Dashboard manual sell quote and execution are blocked during the pre-sign/open-buy hot window because they run in a separate process and could otherwise create a human workflow that consumes or invalidates the buy nonce.
- Across servers, the production wallet has a single active writer. Do not run two independent signers for the same private key.
- Speed-first gas limit must prioritize avoiding OOG over preserving BNB. The bot wallet's BNB is the gas budget; use pending BNB balance and the configured gas price to set the real signing limit, bounded by wallet balance, current block constraints, and the BSC single-transaction gas cap. Do not confuse gas limit with gas price: the GTA failure was OOG, while the `$光源` failure was an over-cap gas limit rejected before mempool entry.
- During the hot window, broadcast RPC clients should be kept warm in the background; keepalive must never block WSS or due execution.
- Per-market and per-batch caps.
- Manual rescue commands are not exempt from the open-window cap unless `ALLOW_LATE_BUY=1` is intentionally set for an explicit exception.
- Persist seen/skipped/submitted markets to avoid duplicate buying and duplicate gas burn.
- Planned-buy records may clear a prior filtered `seen` key only before their configured action time, so operator-planned future buys are not blocked by old strategy filters while post-submit duplicate protection stays intact.
- Persist receipts and fills atomically.
- Persist broadcast start, first RPC acceptance, gas, and nonce in buy results so delayed buys can be audited without guessing.
- Persist builder-bundle submission fields when enabled: builder provider host, accepted time/latency, bundle hash if returned, tip tx hash, tip amount, tip gas, max block/timestamp, and submission error. If the buy receipt later lands, check the builder tip tx receipt too; write its Gas ledger entry when present and record `not_found` when the public buy landed without the private tip transaction.
- One-off builder tests that use a temporary `RUNTIME_CONFIG_FILE` must explicitly keep the profile-local `GAS_LEDGER_FILE`; otherwise the default ledger path follows the temporary runtime directory. The 2026-07-09 test wrote its Gas row to `/tmp/gas-ledger.jsonl` first and then the row was migrated into Bot3's profile ledger.
- Persist every mined chain-writing transaction into the profile-local Gas ledger. Buy, sell, Router BUSDT approval/reset, market operator approval, fast open-exit, fast open-exit operator approval, dashboard/manual sell, manual minimal buy approval/buy, and orderflow-trigger sell receipts should store exact `gasUsed * effectiveGasPrice` in BNB, plus market/outcome/action allocation metadata. If async receipt watching times out but the follow-up receipt classifier finds a receipt, write Gas from that classified receipt before returning. Historical Gas can be backfilled from tx hashes already present in fills and dashboard action logs; live and backfill pricing must fetch the receipt block by block hash with a block-number fallback, and if the BNB/USDT price is still unavailable at write time, keep the exact BNB value and let `gas:backfill` append the priced USDT row later. Gas summary de-duplication must prefer priced rows for the same tx hash so a later unpriced duplicate cannot remove the USDT cost.
- Persist async receipt timeouts as market decisions. A tx hash that is accepted by an RPC but later has no transaction and no receipt on chain should be recorded as `receipt-dropped`, not left as a generic monitor error.
- Never expose private key in logs, docs, or command history.

## Auto-Sell Policy

Current intended policy:

- Applies only to positions bought after the configured `AUTO_SELL_APPLY_AFTER_ISO` cutover timestamp.
- For `AUTO_SELL_STRATEGY=ladder`, after a successful buy, each outcome becomes ladder-eligible at `T+10s`.
- For ladder profiles, once that outcome's full-exit quote is at least `100%` above cost basis, sell `10%` of that outcome's initial token amount every `10s`.
- Profiles can cap take-profit ladder steps with `AUTO_SELL_TAKE_PROFIT_STEPS`, set a sell-only gas price with `AUTO_SELL_GAS_PRICE_GWEI`, and force a remaining-position exit before market start with `AUTO_SELL_BEFORE_MARKET_START_SECONDS`. For Sports/FIFA exact-score markets whose 42 `startDate` is the market open and whose kickoff is encoded near `endDate`, use `AUTO_SELL_MARKET_START_END_OFFSET_SECONDS` to derive kickoff as `endDate - offset`.
- Dashboard runtime-config saves must preserve `AUTO_SELL_GAS_PRICE_GWEI` separately from buy `GAS_PRICE_GWEI`; if the sell-only field is empty, auto-sell deliberately falls back to buy gas.
- `AUTO_SELL_STRATEGY=open_timed_exit` is a separate profile-scoped exit mode, not a replacement for ladder. It sells the configured percent at market open `startDate + AUTO_SELL_OPEN_EXIT_DELAY_SECONDS`; Bot2 and Bot5 both use randomized T+20.500 to T+21.500 full exit with fixed T+21 normal-monitor fallback. Bot4 daily templates use the same mode with `AUTO_SELL_OPEN_EXIT_DELAY_SECONDS=39600`, so 08:00 Beijing daily opens are sold at 19:00 Beijing unless a planned buy explicitly opts into hold. A planned-buy `autoSell` override can also add a take-profit gate inside open-timed mode: before the timed exit, quote only when the configured step is due, and sell the configured chunk when `AUTO_SELL_LADDER_PROFIT_PERCENT` / `autoSell.ladderProfitPercent` is reached.
- Bot1, Bot2, and Bot5 use `AUTO_SELL_FAST_OPEN_EXIT_ENABLED=1`: after the buy receipt succeeds, the worker reads on-chain outcome balances, pre-signs a no-price-protection sell batch, pauses the older poll-based monitor, and broadcasts inside the profile's randomized `AUTO_SELL_FAST_OPEN_EXIT_MIN_DELAY_MS` to `AUTO_SELL_FAST_OPEN_EXIT_MAX_DELAY_MS` window. Sell signing and broadcast use an RPC-only execution config even when buy transport is strict `builder_only`; sell transactions have no buy target timestamp. Any pre-sign or broadcast failure releases the fast-exit pause immediately so the normal monitor can retry. Market Router operator approval is mined before buy pre-signing, and the serialized fast-exit nonce lane prevents approvals or sells from replacing a later private buy. Bot3 remains on ten-hour `pre_start_exit` and does not use this lane.
- In `open_timed_exit`, the pre-sign auto-sell pause is shortened to `PRE_SIGN_WINDOW_MS + OPEN_BROADCAST_DELAY_MS + max(1000, AUTO_SELL_POLL_MS)`, so nonce protection still covers the T+19 buy but does not block the timed exit.
- `AUTO_SELL_STRATEGY=pre_start_exit` holds the position without take-profit ladder exits, optionally checks the configured stop-loss on every tick when `AUTO_SELL_STOP_LOSS_ENABLED=1`, and sells 100% at `AUTO_SELL_BEFORE_MARKET_START_SECONDS` before the derived or planned market start.
- Bot1 now defaults to `pre_start_exit` with `AUTO_SELL_BEFORE_MARKET_START_SECONDS=36000`, `AUTO_SELL_STOP_LOSS_ENABLED=0`, sell gas `0.15gwei`, and buy gas `2.2gwei`; planned exact-score records with `pre_start_exit` should keep stop-loss disabled unless the operator explicitly re-enables it for that record.
- Bot3 now defaults to `pre_start_exit` with `AUTO_SELL_BEFORE_MARKET_START_SECONDS=36000`, `AUTO_SELL_STOP_LOSS_ENABLED=0`, sell gas `0.15gwei`, and buy gas `1.1gwei`; exact-score planned buys should keep the same pre-start/stop-loss-off behavior unless the operator explicitly requests retained settlement or a per-record buy-gas override.
- Bot3 uses `AUTO_SELL_POLL_MS=30000` for its stop-loss-disabled `pre_start_exit` mode. Bot1 also keeps a 30s normal-monitor cadence, but its default `open_timed_exit` uses a dedicated pre-signed RPC-only timer for the random T+23-27 target; the 30s monitor is fallback/recovery rather than the precision clock.
- Bot4 uses `AUTO_SELL_STRATEGY=open_timed_exit` with `AUTO_SELL_OPEN_EXIT_DELAY_SECONDS=39600`, `AUTO_SELL_OPEN_EXIT_PERCENT=100`, sell gas `0.15gwei`, `AUTO_SELL_STOP_LOSS_ENABLED=0`, and `AUTO_SELL_POLL_MS=60000`. This sells post-cutover daily-template buys at Beijing 19:00 after the 08:00 open; `AUTO_SELL_APPLY_AFTER_ISO` must stay set to the cutover timestamp so old positions are not made immediately eligible. The OpenRouter Python planned buy uses 42 REST `positions.curPrice` targets instead of the old full-exit profit quote: `MiMo - V2.5 >= 0.0017` and `Hy3 (free) >= 0.0020` each sell that outcome `100%`. The monitor checks REST every `1000ms` for the first `600s` after the buy, then returns to the profile `60000ms` interval; below target it does not request a full-exit chain quote. `priceApplyAfterIso` provides a cutover so enabling the rule does not silently sell an older position, while the dashboard can explicitly opt existing positions in. If the operator says to keep a specific event, add a planned-buy `autoSell.enabled=false` / `hold_to_settlement` override before it is bought.
- If one outcome's full-exit quote is down at least `10%` from its current remaining-position cost basis, stop that outcome's ladder and sell all remaining tokens for that outcome. After a partial sell, derive the remaining cost basis from the original cost and current token balance; also track remaining size in local auto-sell state so stale positions API balances cannot compare a half-position quote against full-position cost.
- Other outcomes in the same market continue their own ladders after one outcome stop-losses.
- Automatic sells do not bind price; use `minOut=1`. With `AUTO_SELL_LADDER_PROFIT_PERCENT` enabled above `0`, ladder sells require a successful full-exit quote to confirm the profit gate before execution; set it to `0` for fixed-time ladder exits that do not wait for profit.
- Auto-sell return quotes are strategy-gated to reduce chain RPC load: stop-loss-enabled profiles still quote on each poll, ladder profiles quote at due time only when a profit gate is configured, `open_timed_exit` profiles quote before the timed exit only when a planned take-profit gate or stop-loss is enabled, and `pre_start_exit` profiles with stop-loss disabled do not quote before the pre-start due time.
- 42 docs describe post-resolution claim as permissionless UI/protocol settlement for winning Outcome Token holders, but the current bot codebase does not yet implement a claim command or include a verified finalisation claim ABI. Holding-to-settlement tests must therefore be followed by manual/web claim or a separately verified claim implementation.
- Before the first sell for a market, the bot tries to preapprove Router as operator with low priority. The actual sell path requires preapproved operators by default, so it does not insert surprise `setOperator` transactions into the sell batch.
- Group due outcomes across markets into capped sell batches when possible. Each outcome keeps independent ladder/stop-loss state; batching is execution optimization only.
- Buy hot windows take priority; ladder/stop-loss sells and operator approvals pause when a known buy is near, when open-buy pre-sign/broadcast is active, or when the transaction lock is busy.
- Sell batch size is capped by outcome count, market count, gas estimate, and max transactions per tick. Receipt success is required before updating outcome ladder state.
- If the 42 positions API returns transient 5xx/429/network/invalid-JSON responses during an auto-sell tick, the monitor skips that tick and retries on the next poll. This is not a monitor exception and should not alert unless the outage is prolonged.
- Human dashboard must still allow manual sell.
- Manual sell quote must never execute a sell. The sell command only executes when `--execute` or `--real` is passed.

## Bot3 Retained Settlement Auto-Sell Requirement

This is a Bot3-only requirement for the `42space-3` exact-score profile. It must not change Bot1 (`42space`) or Bot2 (`42space-2`) default sell behavior, runtime env, planned-buy files, dashboards, or state. The production source of truth for the operator-selected Bot3 markets remains `/opt/42space/data/42space-3/planned-buys.json`, whose shape is `{ "plans": [...] }`; any implementation or operational edit must preserve profile-local Bot3 files under `/opt/42space/data/42space-3`.

Implementation status: code and self-tests are complete in `src/event-sniper.js`, and `npm run verify` passes locally and on `/opt/42space`. Production Bot3 retained-position config was applied on 2026-06-26 for the operator-specified exact-score matches: four all-outcome retained matches, plus selected outcomes for Cabo Verde vs Saudi Arabia and Jordan vs Argentina. The affected Bot3 planned-buy records now set `autoSell.stopLossEnabled=false`, retain selected outcomes at `10%`, and keep non-retained outcomes on the 10-hour pre-start full exit. On 2026-06-30 the manually website-bought `France vs Sweden` exact-score positions were enrolled into the same Bot3 retained auto-sell path and currently retain `10%` of the seeded chip size for each of the four selected outcomes.

### Current Bot3 Baseline

- Bot3 exact-score planned buys use per-record `autoSell.strategy=pre_start_exit` and `autoSell.beforeMarketStartSeconds=36000`, meaning the bot exits before the derived match kickoff by 10 hours.
- Bot3 production is planned-buy-only for exact-score execution: ordinary strategy buys are blocked by non-matching question allowlists, while operator-approved profile-local planned-buy records still override that boundary and execute their named outcomes.
- Bot3 currently defaults exact-score auto-sell to `pre_start_exit` with `autoSell.stopLossEnabled=false`; the latest operator-approved match set also keeps per-record stop-loss clearing off.
- The existing `pre_start_exit` behavior sells the full remaining outcome position at the pre-start due time. The new requirement changes that only for explicitly configured retained outcomes.
- Bot3 buy timing remains independent from this requirement. Existing per-record `openBroadcastDelayMs` values, stake sizes, selected outcomes, funding checks, and planned-buy matching should not be changed by the retained-settlement feature.

### Product Goal

For selected Bot3 exact-score matches, the operator can explicitly choose one or more bought outcomes to keep partially until final settlement. At the normal pre-start auto-sell time, Bot3 should sell only the excess chips above the requested retained percentage for those selected outcomes. Outcomes that are not explicitly listed for retention keep the current behavior and sell all remaining chips at the pre-start exit time.

The intended use case is: buy several exact-score outcomes near market open, let Bot3 automatically reduce risk 10 hours before the match, but keep a small operator-selected tail position, typically 10% of the originally bought chips, to hold through settlement.

### Scope Boundary

- Applies only to Bot3 planned buys when a planned-buy record contains the new retained-settlement configuration.
- If the operator bought a Bot3 position manually through the website, there is no Bot fill log to make the market auto-sell eligible. Enroll that position by adding a Bot3 planned-buy-style `autoSell.retainPositions` override for the market and seeding `/opt/42space/data/42space-3/auto-sell-positions.json` from the live positions API. For that manual-web path, `initialSize` is the current detected chip size, so the retain percentage applies to the current website-bought holding.
- Does not create a global default to retain chips for every Bot3 position.
- Does not apply to Bot1 or Bot2 unless a separate future requirement explicitly says so.
- Does not change discovery, buy selection, buy broadcasting, buy gas, Feishu notifications, dashboard filters, or shared discovery-feed behavior.
- Does not implement claim/finalization. Retained chips are held for later manual/web settlement or a separately verified claim implementation.

### Retention Semantics

- Retention is based on chips/token amount, not USDT cost basis and not sell-time market value.
- The retention percentage is calculated from the initial bought size recorded in Bot3 auto-sell position state for that exact market/outcome.
- Example: if Bot3 bought `6121.36` chips of `NOR 1-2 FRA` and retention is `10%`, the retained target is `612.136` chips. At the pre-start exit time, if the current position is still `6121.36`, the bot sells `5509.224` chips and leaves `612.136` chips.
- If the current position is already less than or equal to the retained target because of manual sells or previous automation, the bot should not sell more. It should mark that outcome as retained-to-settlement and record the reason.
- If the current position is greater than the retained target, the bot should sell `currentSize - retainedTargetSize` using the same direct sell path and `minOut=1` no-price-protection behavior used by existing auto-sell exits.
- Rounding must be conservative: never sell below the requested retained percentage. If precision or minimum-step constraints require rounding, round the sell amount down so the retained chips are at least the configured target.

### Configuration Shape

Use explicit per-outcome retention in the Bot3 planned-buy record. The operator will list the match and the outcomes to retain, plus each outcome's chip-retention percentage. A typical record should look conceptually like:

```json
{
  "question": "Norway vs France",
  "outcomes": ["NOR 1-2 FRA", "NOR 1-1 FRA", "NOR 0-2 FRA"],
  "autoSell": {
    "strategy": "pre_start_exit",
    "beforeMarketStartSeconds": 36000,
    "stopLossEnabled": false,
    "retainPositions": [
      { "outcome": "NOR 1-2 FRA", "retainPercent": 10 },
      { "outcome": "NOR 1-1 FRA", "retainPercent": 10 }
    ]
  }
}
```

Accepted retention configuration should be explicit. A whole-match default retention percentage should not be inferred. If the operator wants all three selected outcomes retained, all three outcomes should be listed. This prevents accidental retained exposure on outcomes that were meant to be fully cleared before the match.

### Outcome Matching

- Primary matching should use normalized planned-buy outcome names because planned buys already bind exact outcome strings.
- The implementation may also accept simple score aliases in operational tooling later, but core config should store the resolved full outcome names for auditability.
- If a retained outcome name is not one of that planned-buy's selected outcomes, validation should flag it before the hot sell window. It must not silently retain or sell the wrong outcome.
- If two outcomes normalize to the same text, fail validation rather than guessing.

### Stop-Loss Interaction

- Bot3's current default for these exact-score retained-settlement plans is stop-loss off.
- When `stopLossEnabled=false`, retained outcomes and non-retained outcomes do not trigger stop-loss clearing; only the configured pre-start exit applies.
- If a future Bot3 record explicitly enables stop-loss together with retained positions, stop-loss must not sell below the retained target for retained outcomes unless the operator explicitly configures a separate override. The retained tail is intended to reach settlement.
- For non-retained outcomes, an explicitly enabled stop-loss may continue to behave as the existing strategy says.

### State And Execution Requirements

- Auto-sell state should keep the original `initialSize` and `initialCostBasisUsdt` behavior, and add enough retained-settlement metadata to make audits clear.
- After a partial pre-start retained sell succeeds, the state should not set `remainingSize` to `0`. It should store the remaining retained chip amount and mark the outcome completed for further auto-sell actions, for example with a retained-to-settlement flag.
- The fills log entry should distinguish a full `pre_start_exit` from a retained partial pre-start sell. It should include market, outcome, tokenId, retained percent, retained target chips, sold chips, current chips before sell, due time, tx hash, and execution status.
- Operator preapproval, batch chunking, gas budget checks, buy-window pauses, nonce locks, and transient positions API retry behavior should continue to use the existing auto-sell infrastructure.
- If a retained partial sell is batched with full pre-start exits from other outcomes, each action must preserve its own sell amount and audit fields.

### Validation Requirements

- Self-tests should cover a retained outcome where initial chips are 1000 and retention is 10%, producing a pre-start sell amount of 900.
- Self-tests should cover a non-retained outcome in the same match still selling 100%.
- Self-tests should cover a current position already below the retained target, producing no sell action and marking/returning a retained-skip status.
- Self-tests should cover `stopLossEnabled=false` as the Bot3 default retained-settlement path.
- Self-tests should cover invalid retained outcome names and invalid retain percentages.
- Verification should include `npm run verify` after code changes and a read-only inspection of the Bot3 planned-buy file before any production edit.

### Operational Rules

- Production rollout must update only `/opt/42space/data/42space-3/planned-buys.json` for Bot3 retained positions.
- For manual website buys with no Bot fill record, production rollout must update only Bot3 profile-local files: `/opt/42space/data/42space-3/planned-buys.json` for the auto-sell override and `/opt/42space/data/42space-3/auto-sell-positions.json` for the seeded eligible positions.
- Before production edits, create timestamped backups next to every Bot3 file being edited.
- After production edits, restart only `42space-event@42space-3.service` unless a dashboard display change also requires restarting `42space-dashboard@42space-3.service`.
- Verify Bot3 with `systemctl is-active`, recent `journalctl`, and a readback of the planned-buy retention config. Do not use shell `source` on `/etc/42space/profiles/42space-3.env`; parse env safely or let systemd load it.
- The final operator-facing report should state which match/outcomes retain chips, each retain percentage, and which outcomes still fully exit 10 hours before kickoff.

## World Cup Orderflow-Triggered Sell Requirement

This is a profile-local protective sell monitor for long-dated World Cup country baskets. It does not change normal planned-buy paths, retained-settlement pre-start exits, Bot2/Bot4/Bot5 behavior, or any generic auto-buy strategy.

Each monitor watches only the current held outcomes for that profile and market. As of 2026-07-07, the covered markets are `2026 FIFA World Cup Runner-Up?` (`0x6B7F30fb52B26814BB49312442010450e43e226D`) and `2026 FIFA World Cup 3rd Place ?` (`0x86308B8059183eA443fd1885D5493cF6C5222F1f`) for Bot1 and Bot3. The watched token IDs must be refreshed from live positions if holdings change.

Trigger semantics:

- Use chain-confirmed `MarketTrade` logs from the watched market, not REST activity rows.
- Ignore the profile's own wallet and ignore negative `netCollateral` sell rows.
- Count only positive watched-outcome buy `netCollateral`; BUSDT router transfer is recorded as an audit field, not the primary trigger when event data is available.
- Trigger thresholds are market-specific. Current World Cup Runner-Up and 3rd Place monitors trigger when one transaction buys at least `150U` across watched outcomes.
- Default sell mode is `matched_outcomes`: sell only the watched outcome or outcomes bought in the triggering transaction. Do not liquidate all watched outcomes unless `ORDERFLOW_TRIGGER_SELL_MODE=all_watched` is explicitly configured later.
- Sell `100%` of the selected current profile position with the existing direct sell path and `minOut=1`, using that profile's `AUTO_SELL_GAS_PRICE_GWEI` unless explicitly overridden.
- If `ORDERFLOW_TRIGGER_WATCH_CURRENT_POSITIONS=1`, the service periodically merges the profile's current held token IDs for that market into the watched set. This covers website/manual buys that did not create Bot fill records.
- `soldTokenIds` is audit history, not a permanent blocklist. If an outcome was sold by this strategy and the operator later buys it again on the website, the next trigger can sell the newly held on-chain balance.

Operational boundaries:

- Each profile/market pair runs as a separate systemd service, so it can run while the main worker waits for funding.
- Each service keeps its own state and JSONL audit log under that profile's data directory. The state may contain old `soldTokenIds`, but sell eligibility must be decided from current on-chain balance at execution time.
- The read RPC can be isolated from the normal profile RPC with `ORDERFLOW_TRIGGER_RPC_URL`. In production this value must live in an uncommitted root-only env file such as `/etc/42space/profiles/42space-3-orderflow.env` or `/etc/42space/profiles/42space-orderflow.env`, not in repo-tracked service templates or docs.
- The default lookback is `0`, so a fresh start monitors future blocks only and does not fire on historical large buys.
- Transaction de-duplication must mark a trade as handled only after processing succeeds. If a watched trade fails during receipt fetch, position fetch, plan build, or sell execution, keep it in a persistent retry queue instead of marking it handled.
- Retry/no-position audit records must store a JSON-safe trigger summary rather than the raw viem receipt. Receipt BigInts must never turn a handled no-position result into an infinite retry loop.
- These sidecars do not share the in-process transaction lock with the main event workers. If this strategy becomes permanent or high-frequency, move it into the main worker or a shared transaction scheduler.
- Idle RPC load is one `eth_blockNumber` poll per second plus `eth_getLogs` for the single watched market block range; matched transactions add receipt and sell-plan reads. Every sidecar emits a local `orderflow-trigger-rpc-stats` record once per minute with per-method request/error/latency counts and no RPC URL or credentials.
- RPC optimization is a read-side/background concern. It must not change buy timers, Builder submission, nonce ownership, raw-transaction fanout, sell thresholds, sell percentage, Gas, or the existing direct sell call path.
- A shared WSS scanner may replace duplicate profile polling only after at least 24 hours of shadow operation: zero missed target logs, zero duplicate dispatches, p95 first-seen latency no more than `100ms` slower than the existing scanners, and successful forced-disconnect block-range backfill. The shared scanner remains read-only and has no wallet, signer, nonce, or execution authority; profile-local sidecars retain final trigger validation and sell execution. Cut over one profile/market pair at a time with a service-level rollback.
- On 2026-07-14 the operator explicitly approved immediate Chainstack-only production consolidation after the shadow Ankr WSS began returning `401`. The safety replacement is one shared HTTP audit per second during burn-in, so WSS failure retains approximately the old one-second worst-case discovery cadence while removing five duplicate market polls. The audit may return to 60 seconds only after a clean Chainstack-only production window.

Shared observer read architecture:

- `scripts/shared-rpc-observer.js` subscribes to BSC `newHeads` plus the production-verified raw `MarketTrade` topic for the three covered markets. It does not infer the event ABI from a guessed signature.
- When address mode is enabled, each confirmed new head causes one shared full-block read for all watched addresses. Direct-address transaction matching is local and trails WSS by two blocks to avoid cross-provider propagation races.
- Address-mode ERC20/ERC721/ERC1155 transfer discovery stays HTTP-based because both available Ankr and Chainstack WSS endpoints reject ERC1155 wildcard topic subscriptions, including per-address probes. One 3-second scan uses six topic shapes with all watched addresses as an OR filter; the canonical HTTP endpoint passed the equivalent filters.
- Market WSS uses the Bot1 transaction-monitor Chainstack endpoint. Canonical Chainstack HTTP has a separate cursor and three-block confirmation offset; production burn-in audits every second, while the final steady target remains every 60 seconds. Address mode has an independent 3-second cursor and remains disabled.
- Observer output is limited to `feed.jsonl`, `observer.jsonl`, atomic state, and a 5-second health file. RPC URLs, credentials, profile keys, webhooks, thresholds, and transaction state are excluded.
- The original combined scope was approximately `510 RPC/min` for five orderflow services plus `819 RPC/min` for three address watchers. Address monitoring was paused on 2026-07-11. On 2026-07-14 all five orderflow readers moved to feed mode: each measured `0 RPC/min`, and the temporary one-second shared audit measured `120 RPC/min` with zero errors. This is an immediate `510 -> 120 RPC/min` read-load reduction (`76.5%`) without slowing the HTTP fallback; returning the audit to 60 seconds after burn-in yields the final `510 -> 2 RPC/min` target (`99.6%`).
- Production endpoint fingerprints were reconciled against the operator-provided Chainstack organization without storing its API key. All 17 Chainstack HTTP/WSS endpoints present in running `42space` processes map to nodes in that organization. Bot1 and Bot3 each keep a profile-local Event node, while their orderflow/address readers use separate `Bot 1-transaction monitor sell` and `Bot3-transaction monitor sell` nodes. Consolidation targets only those duplicate read workloads, not the Event or broadcast nodes.
- `orderflow-trigger-sell.js` and `address-tx-watch.js` support an optional persistent observer-feed input. The base orderflow units retain `rpc` as the deterministic rollback default, while all five production orderflow units currently install a per-service `SOURCE=feed` drop-in. Feed consumers reconstruct full transaction semantics from the canonical receipt before applying the existing threshold, matched-outcome, address-direction, enrichment, alert, or sell logic. They retain profile-local state, wallet validation, notification, and execution authority.
- The observer writes a local checkpoint about every five seconds so a feed consumer can persist chain progress even when no relevant event occurs. The JSONL tail cursor stores file identity, byte offset, and partial-line state; it resumes after process restart and recovers from truncation or rotation. Empty polls do not rewrite state.
- First RPC-to-feed activation is gapless: when an existing RPC state has no feed cursor, the reader opens the feed at byte zero and applies a one-time boundary of `lastProcessedBlock - 1`. Older target-market backlog is ignored, while the last RPC block is deliberately replayed for overlap and tx de-duplication covers duplicates. The boundary is cleared only after the initial tail batch is processed and its cursor is saved. Later delayed WSS/audit rows are not filtered by `lastProcessedBlock`, so block-range backfill remains effective. Explicit `ORDERFLOW_TRIGGER_FEED_FROM_START=1` still performs an intentional full historical replay.
- Every production orderflow base unit explicitly defaults to `ORDERFLOW_TRIGGER_SOURCE=rpc` and carries the common feed path plus `100ms` feed poll. Production currently installs `ops/42space-orderflow-feed-source.conf` independently on all five units. Rollback removes only the affected unit's drop-in, daemon-reloads, and restarts that reader; the base unit deterministically returns to direct RPC. Never put `SOURCE=feed` in the Bot1/Bot3 shared RPC credential env files because that would switch multiple markets together.

Auto-sell RPC budget:

- Bot1 and Bot3 main auto-sell scan every 30 seconds with `pre_start_exit` and stop loss disabled. Their current scans check 6 and 17 eligible positions through 42 REST but do not quote on-chain before due time, so recurring Chainstack RPC is zero.
- Bot2 and Bot5 scan every second for `open_timed_exit` plus 10% stop loss, but currently have no open positions, so recurring Chainstack RPC is zero. When they hold positions, the 1-second balance/quote checks are intentional short-lived protection and must not be slowed for quota savings.
- Bot4 scans every 60 seconds and uses 42 REST `curPrice` for configured price targets with stop loss disabled. Its current four-position scan makes no recurring Chainstack quote; chain reads begin only when a target or timed exit is due.
- The separate Bot3 Spain-vs-Belgium value watcher currently reports `no_position`, so it also uses zero Chainstack RPC. For future holdings it keeps the 5-second balance and redeem simulation but caches the operator result once per process, reducing the quote path from three to two `eth_call` requests per cycle. Per-method telemetry records the actual future load.
- Main auto-sell stop-loss quotes may reuse only a positively confirmed entry from the existing process-local `autoSellOperatorReadyMarkets` set. This removes the repeated `isOperator` call after preapproval while retaining the same poll interval, `balanceOf`, redeem simulation, trigger calculation, direct-plan read, and execution-time approval check. Active quote cost therefore falls from three to two `eth_call` requests per position/tick without weakening sell validation. All five Event workers loaded it through a cold one-profile-at-a-time restart after transaction-lock, pending/prepared timing, and nonce preflight; never restart a worker inside a buy hot window merely to realize quota savings.

## Bot3 Final Matchup Guarded Builder Incident

The Bot3-only production record `bot3-world-cup-final-matchup-6x20u-builder-guard-t20-2026-07-10` targeted market `0x951B04c71Ff284C35e7C46554CbD1D7C9FA8F44b`. It selected `France vs Argentina`, `France vs England`, `Spain vs Argentina`, `France vs Norway`, `Spain vs England`, and `Spain vs Norway` at `20U` each, with buy gas `2.1gwei`, a `0.002 BNB` Builder tip, and `first_20s_block` timing.

This plan does not enable Builder globally. At execution-config resolution, its per-record override enables the deployed timestamp guard at `0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557`, starts private `[guard,buy,tip]` retries at `T+19.500`, retries every `100ms` through the `T+20.000` boundary, and keeps the nonce-gapped public fallback path. The Guard forbids execution before the target timestamp but cannot guarantee that 48Club controls the first block carrying that timestamp.

The pre-open readback showed `132.768264655865849357 BUSDT`, `0.022828163752684928 BNB`, Router allowance ready, and both broadcast RPCs healthy. Pre-sign succeeded at `T-57.660s`; Builder retries started at `T+19.521s`, but all six failed. One response exposed the root cause exactly: after charging Guard Gas, Builder saw `0.022782803752684928 BNB` available while the buy transaction's maximum Gas cost alone was `0.0228281634 BNB`. The buy had been signed with Gas limit `10,870,554`, because wallet-budget mode assigned nearly the whole wallet balance to buy Gas without subtracting the Guard/tip reserve.

The public fallback could not repair an intrinsically underfunded signed transaction. Guard tx `0x6d4f54efde108adddcb0fc529222742abf4f82f666d55dae333e8436e6711c91` succeeded, but buy tx `0x66cf61fa5df39b90ed9138e755a8fecdde213e6abba694a3982251bc272966d4` and tip tx `0xb6e20fcaa8f2295b0bb55701e25e67e94e9bf4d5c475e320b777b5675db4ea58` remained absent from both Ankr and Chainstack. The plan was disabled after the target window. No Final Matchup positions or auto-sell rows were created.

The production fix closes both mismatched calculations. Funding preflight now resolves each single planned market through its final per-record execution config, so a globally disabled Builder no longer hides that plan's Guard/tip reserve. Wallet-budget Gas sizing subtracts Builder tip value, tip-transfer Gas, and timestamp-Guard maximum Gas before calculating the buy Gas limit. Pre-sign also asserts that `buy gasLimit * gasPrice + all Guard/tip reserves` is no greater than the pending BNB balance. The check reuses the same balance read and adds no hot-path RPC. Quote-free `minOut=1`, timing, and broadcast paths remain unchanged. Local and remote `npm run verify` pass with planned-Builder funding coverage and a regression test using the incident's wallet balance and `2.1gwei` Gas price. Only Bot3 was restarted after deployment.

The later nonce-157 transaction `0x82bd5acddf8d6b2883e31a2240c6a8a57bf9a9c2203e27c216ca51a619194e69` was independent of the failed Bot3 buy: receipt logs show a `130 BUSDT` swap returning about `129.8071924 USDC`. It explains the later Bot3 wallet BUSDT balance of `2.768264655865849357` and must not be attributed to the Final Matchup plan.

## Bot3 Dual-Builder Atomic Timed Buy

This section records the original Bot3-only rollout. At that stage it did not change Bot1, Bot2, Bot4, or Bot5 and required an event-level Builder override. The later global-default section supersedes that activation rule for Bot2 and Bot3 while preserving per-event override priority.

### Execution Shape

- Replace Bot3's strict `[guard, buy, tip]` bundle with `[timedBuy, tip]`.
- `timedBuy` calls the profile-local `TimedBuyExecutor.executeAfter(targetTimestamp, totalCollateral, routerCalldata)` contract.
- The contract rejects the entire transaction when `block.timestamp < targetTimestamp`. At or after the target, it atomically pulls the exact BUSDT total from Bot3 and executes the existing prebuilt Router multicall. The outcome receiver inside Router calldata remains the Bot3 wallet.
- The Router calldata, exact-in amount, `minOut=1`, buy Gas price, selected outcomes, planned-buy priority, and sell policy are unchanged.
- Hybrid public RPC fallback must not broadcast the atomic transaction while chain time is below the target. It polls the latest block, releases only when the observed block timestamp equals the target, and aborts if chain time has already advanced beyond that target second. Strict `builder_only` never enters this fallback path.
- A strict timed Builder buy cannot fall through to the old just-in-time direct Router signer. Missing or failed atomic pre-sign is an execution error, not permission to bypass the time gate.

### Builder Race

- The same pre-signed atomic buy is submitted concurrently to 48Club and BlockRazor.
- Each Builder receives a tip transaction paying its own official payment address.
- Both tip transactions use `buyNonce + 1`. They have different hashes and recipients but the same sender nonce, so at most one can mine after the common buy transaction.
- Receipt tracking checks every candidate tip hash, records which Builder's tip actually mined, and treats the other candidate as `not_found`. Funding reserve includes one tip, not two, because the mutually exclusive same-nonce tips cannot both settle.
- 48Club retains its `48spSign`, `positionFirst`, and `noMerge` fields when configured. BlockRazor receives only its supported common bundle fields.
- BlockRazor common bundle fields include `positionFirst` and `noMerge`; only `48spSign` is stripped from the BlockRazor request. The provider-specific payload self-test must assert both ordering flags on 48Club and BlockRazor and assert the configured BlockRazor authorization header.
- BlockRazor rejects an exact window expressed as `minTimestamp == maxTimestamp`. For strict atomic buys, its provider payload therefore retains `maxTimestamp` and omits the equal `minTimestamp`; the `TimedBuyExecutor` transaction itself enforces `block.timestamp >= targetTimestamp`, so the combined constraints still define the single target second. 48Club retains the original min/max fields.
- `BLOCKRAZOR_BUILDER_AUTH_TOKEN` remains optional in code, but Bot3 production now supplies a profile-local uncommitted token and sends it in the BlockRazor `Authorization` header. Authentication does not enable Builder globally and does not alter timing, Gas, or tip policy.

### Wallet And Tip Policy

- Bot3's existing wallet signs the buy and both alternative tips. A separate tip wallet is unnecessary because nonce ownership stays simple, only one tip can mine, and the funding calculation reserves buy Gas plus one tip value and its 21,000-Gas transfer.
- Bot3's initial rollout default was `0.001 BNB`; production changed to `0.003 BNB` on 2026-07-13. Per-event `builderBundle.tipBnb` remains authoritative. This rollout does not set or imply a default above `0.005 BNB`.
- This was the initial Bot3 rollout baseline. It was superseded on 2026-07-10 when the live-proven atomic path became the global default for Bot2 and Bot3; explicit planned-buy overrides still win.

### Deployment Evidence

- Contract: `0x14e3f8172388FDDb85918792a63294F4C740343B`.
- Deployment tx: `0xa623c035ef1888d7cd7bc24826e17d4e68fe5a7de36ade493b92d367bd189da8`, block `109149114`, status success.
- Bot3 BUSDT approval tx: `0x1eff93faddc6dee12c59b15c39c8aece32126b3b039f57d4af3c192086758ed7`, block `109149117`, status success, max allowance.
- Runtime code hash: `0xcd33816c6e26d932a0053868325d4e0035e1facb8c1f6b30a804a498537a1a02`; deployed code, owner, operator, Router, and collateral all matched expected values.
- Local and production `npm run verify` passed. The production Bot3 process read back dual Builder enabled, timed executor enabled, legacy timestamp Guard disabled, `builder_then_fanout`, `auto` timing, `500ms` preposition lead, and `0.001 BNB` default tip.
- The original production endpoint warmup returned BSC chain `0x38` from both Builders: 48Club via `eth_chainId` in `316ms`, and BlockRazor without auth via its expected empty-bundle validation in `505ms`. A read-only future-target simulation reverted with decoded `TooEarly(currentTimestamp, notBeforeTimestamp)`, proving the atomic contract rejects pre-target execution.
- On 2026-07-10, the BlockRazor account token was copied from the activated portal and stored in local and Bot3 production secret files with matching SHA-256 prefixes; the token itself was never printed or committed. After restarting only Bot3 event/dashboard services, `status` and `doctor` both reported `authConfigured=true`. An authenticated bundle containing an already-mined raw transaction reached BlockRazor state validation over HTTP 200 in `260ms` and returned the expected `nonce_too_low`, proving the authenticated request path without risking a new transaction.
- All Bot3 event, dashboard, orderflow, and value-trigger services were active after rollout. Other profiles were not restarted.

### CASHCAT Failure And Post-Fix Live Proof

The operator-approved production target was `$CASHCAT FDV by July 11th, 12:00 UTC?` at market `0x89fEbB51DEbed12cBE082443eb5634B3EdaAc5FC`. Bot3 selected `$125M - $150M`, `$150M - $200M`, and `$200M - $300M` at `10U` each, used `2.1gwei`, strict `first_19s_block`, requested `builder_only`, `positionFirst=true`, `noMerge=true`, and mutually exclusive `0.003 BNB` provider tips; auto-sell was disabled with `hold_to_settlement`.

The buy succeeded, but the Builder proof failed. The atomic buy was pre-signed at `2026-07-10T11:59:19.946Z` as tx `0x0fdb7e2113d34382bd3b1ca9849e0e8b4caaed60ce1f39847abb0f07376a36d1`, nonce `162`. 48Club rejected the early submission, and BlockRazor returned `the maxTimestamp should not be less than minTimestamp` for the equal target-second window. A preset bug had overwritten `builder_only` with `builder_then_fanout`, so the public fallback started at T+18.506; Ankr first accepted at T+19.817. The buy landed in block `109167936` at T+20, txIndex `19`, gas used `1,084,596`, and market rank `7`, behind three buyers already in the T+19 block. Neither provider tip transaction mined, so no `0.003 BNB` tip was paid. All three outcome balances read `3063.7` chips, the Gas ledger records `0.0022776516 BNB` / `1.31169956U`, and latest/pending nonce both advanced to `163` without a gap.

The failed attempt produced two deployed fixes. First, strict timing presets preserve `builder_only`, early private submission is reused, and that mode can no longer enter public RPC fanout. Second, BlockRazor receives `positionFirst` and `noMerge` but uses the atomic executor lower bound plus `maxTimestamp` instead of an API-invalid equal min/max pair. Local and production `npm run verify` pass.

JUGGERNAUT supplied the first post-fix proof. Buy tx `0x599a87003e898d8533050f0136e7c0ffdbb68c6e73d69320092e1758cc7f0906` bought four `5U` outcomes at `1.1gwei` in block `109169931`, timestamp T+19, txIndex `2`, and market rank `1`; BlockRazor tip tx `0x0c56233df93dd65a137162817b3b24f77ad298de2774a34cc5299b5b04359bf5` paid `0.003 BNB` at txIndex `3`, while the 48Club same-nonce tip was absent. Both Builders accepted, `positionFirst/noMerge` were present, and public broadcast was skipped. A near-simultaneous early/main timer exposed a duplicate submission and in-memory nonce-release race; both paths now share one in-flight submission promise, and concurrent self-test coverage proves only one Builder request set is created.

Disabling the completed JUGGERNAUT buy plan then exposed a separate sell-policy bug: `plannedBuyForMarket` ignored disabled rows, so the Bot3 global 10-hour `pre_start_exit` policy replaced the intended `hold_to_settlement` and sold all four positions in tx `0x66d1032022548de8b0266145dfdc30013a80b01d25802bff5c1a59ed5635c372`. The wallet recovered about `4.233915 BUSDT` from the original `20U` stake, excluding Gas. The fix adds an explicit `preserveAutoSellAfterDisable` flag: a disabled row remains ineligible for buying but can continue to supply its auto-sell override. Self-tests cover the disabled-buy/retained-sell-policy split.

HOODRAT supplied the second post-fix proof after the race and sell-policy fixes. Buy tx `0x2793e31a0aeb932f9614c79cff7c6b3345d69b4096dbb35d8648c34158b106e1` bought the last six outcomes at `10U` each and `1.1gwei` in block `109171931`, timestamp T+19, txIndex `1`, market rank `1`. BlockRazor tip tx `0x46088ba0d5d76f5c28e83b2778cbafdbdafc586ebf8a215e5ba5de8c17dd9837` paid `0.003 BNB` at txIndex `2`; the 48Club candidate was absent and public RPC was skipped. Each outcome received `5686.76` chips. The operator later sold the six outcomes manually through the website in six independent transactions, recovering about `92.028869 BUSDT` from the `60U` stake before Gas; the absence of Bot3 auto-sell logs and the one-outcome-per-transaction pattern distinguish these manual sells from the worker's batched sell path.

## Bot2 And Bot3 Global Atomic Builder Default

The live-proven Bot3 transport first became the production default for Bot2 and Bot3. Bot1 and Bot5 later adopted the same transport with a T+20 target as documented below; Bot4 keeps it plan-local. Explicit planned-buy fields continue to override profile defaults.

- Both profiles set `BUILDER_BUNDLE_ENABLED=1`, `BUILDER_BUNDLE_MODE=builder_only`, `BUILDER_BUNDLE_TIMING_MODE=first_19s_block`, and `GAS_PRICE_GWEI=1.1`. Bot2 and Bot3 now both use a `0.003 BNB` global tip.
- Bot2 starts private retries at T+18.300 using a `700ms` preposition lead; Bot3 remains T+18.500 with `500ms`. Their existing action offsets remain Bot2 T+18.840 and Bot3 T+18.850, but strict `builder_only` cannot use public fallback.
- 48Club and authenticated BlockRazor are both enabled. Each receives the common pre-signed atomic buy plus its own same-nonce tip candidate; `positionFirst=true`, `noMerge=true`, max-block lookup is disabled, and submission timeout is `700ms`.
- The atomic contract is the hard not-before control. Bot2 and Bot3 legacy timestamp Guards are disabled, so there is no separate Guard nonce and no path that can expose a direct Router buy before the target.
- Bot2 owns executor `0x961E5954B4e1812d87955a2b7A614cCc8B1E7Cc1`. Deployment tx `0x4b5391b4e60e369e8d76ef1fa0c2c7d1bc44d6c5c7eeb2b28b267eb2afa84a11` succeeded in block `109190996`; BUSDT approval tx `0x960e479a2cc10ee27782e538818dc7b724ef542fdb76a6ce46d885e1dfb1f26a` succeeded in block `109190998`.
- Bot2's runtime code hash, owner, operator, Router, collateral, and allowance matched. Bot3's existing executor at `0x14e3f8172388FDDb85918792a63294F4C740343B` also passed the same runtime readback.
- Production profiles were backed up as `/etc/42space/profiles/42space-2.env.bak-20260710145433` and `/etc/42space/profiles/42space-3.env.bak-20260710145433`. The BlockRazor credential was copied secret-to-secret from Bot3 to Bot2 without printing or committing it.
- Local and production `npm run verify` passed. Only the Bot2/Bot3 event and dashboard services were restarted; all four read `active/running`, `NRestarts=0`, and actual process environments matched the target defaults. Final wallet nonces were contiguous at Bot2 `844/844` and Bot3 `180/180`.

## Bot4 OpenRouter Strict T+20 Builder Route

Bot4's recurring OpenRouter Python plan is a plan-local strict Builder route, not a Bot4 global transport change. It buys `Hy3 (free)` at `20U` and `MiMo - V2.5` at `10U`. The final execution configuration is:

- `mode=builder_only`; there is no public RPC fallback for this plan.
- `timingMode=first_20s_block`, target chain second T+20, with Builder window `minTimestamp=T+20` and `maxTimestamp=T+21`.
- private submission starts at T+19.300 (`prepositionLeadMs=700`).
- 48Club and authenticated BlockRazor receive the same atomic timed-buy payload plus mutually exclusive same-nonce provider tips.
- `positionFirst=true`, `noMerge=true`, `tipBnb=0.001`, and buy gas `0.5gwei`.
- the plan schedule remains T+19.900 as the local lane deadline; strict `builder_only` does not publicly broadcast the buy at that time.

Bot4 owns exact-second timed executor `0xC2B2F78C620228Ea8d1B2E155664ceBbc7212148`. Its on-chain `block.timestamp == targetTimestamp` check is authoritative: the buy can execute at T+20 only, not before or at T+21. If both Builders miss that second, the plan skips instead of leaking the raw buy to a public RPC.

This route must not alter the separate BNB/USDT recurring plan. BNB/USDT remains RPC-only at T+22.000 with `0.15gwei`. Bot4 global Builder execution stays disabled; only the OpenRouter record opts in. OpenRouter exits are outcome-price driven through 42 REST, with the configured target selling that outcome fully before the normal open+11h exit; stop loss remains disabled.

Setup acceptance requires verified executor bytecode/ownership/operator/Router/collateral/allowance, ready BUSDT and BNB reserves, no pending nonce gap, successful probes to both Builders, exact market/outcome readiness, healthy Bot4 services, and evidence logic that distinguishes T+19.300 private submission from the T+20 chain target.

The 2026-07-11 live buy completed this acceptance. Tx `0xb1d3f3a42dd2fb1f00ac63f9fe2dba5f6400732cfc18624d8c91cac5386e57b8` landed in block `109263919` at timestamp T+20.000 and txIndex `1`. It was the first market buy overall and first in the first T+20 block. 48Club accepted the bundle in `239ms`; buy and its `0.001 BNB` tip mined together. BlockRazor timed out at `700ms`, its mutually exclusive tip did not mine, and `publicBroadcastSkipped=true`. The evidence collector now treats a failed provider row as an attempted target without requiring success-only payload fields; future failed rows also persist `positionFirst` and `noMerge` for audit.

## 2026-07-14 Failure And Exact-Second Repair

The July 14 opening triggered the deferred Roadmap. OpenRouter pre-signed buy nonce `118` as tx `0xe64a...7c00`, with provider-tip nonce `119`. At T+19.300 the old payload used `minTimestamp=maxTimestamp=T+20`; 48Club rejected with `execution reverted` and later duplicate/early responses, while BlockRazor reported `non-reverting tx in bundle failed` and duplicates. No buy receipt or position was created.

The failed-early-submit recovery then reset only to `buyNonce+1`. Because buy nonce `118` had never landed, the BNB/USDT lane re-signed at nonce `119` and Chainstack correctly rejected it as `gapped-nonce tx`. Its dedicated retry timer also retried faster than `EXECUTION_RETRY_MS`, extending the failure loop until the open window ended. This was one execution-lane defect with two visible failures, not a duplicate-title discovery issue; the second same-title OpenRouter market was safely skipped by the strict wallet lane.

The deployed repair is:

- `ExactTimedBuyExecutor` permits `executeAfter` only when `block.timestamp == targetTimestamp`.
- Exact mode sends `minTimestamp=targetTimestamp` and `maxTimestamp=targetTimestamp+1`; legacy profile executors retain their existing equal-window behavior.
- A failed strict Builder target installs an expiry watcher. At target expiry, an absent buy receipt clears every pre-sign at or after the failed buy nonce and resets runtime nonce from the chain's pending nonce. If the buy landed but its tip did not, the same reconciliation removes stale later pre-signs.
- Dedicated retries honor `EXECUTION_RETRY_MS`; transaction-lock users and later pre-signing wait for recovery. Strict `builder_only` refuses local execution from T+21 onward.

Contract `0xC2B2F78C620228Ea8d1B2E155664ceBbc7212148` deployed in tx `0xaf0977959fba9a5002fd58ae32b4d31911feb64dd729a564367a1932efa1305c` at block `109855802`; max BUSDT approval tx `0xa0836d20a07ac7fc0bcddd630491ba7c7f6811b115e9eba928a15a0258f18378` succeeded at block `109855805`. Runtime hash, owner/operator, Router, collateral, and allowance match. Historical-block `eth_call` accepted exactly at the target timestamp and reverted one second before and after it.

Local and production `npm run verify` pass. Bot4 Event/Dashboard are active with zero restarts, readiness has no failed checks, and chain nonce remains contiguous at `120/120` after the no-broadcast checks. 42 REST confirms that July 15-19 markets all contain exact labels `Hy3 (free)` and `MiMo - V2.5`; the July 15 real-market plan resolves tokenIds `16/64`, stakes `20U/10U`, and total `30U`. An isolated profile-signer pre-sign then built one reusable two-outcome transaction, validated Executor operator access, and never broadcast. The readiness contract continues to assert `positionFirst`/`noMerge`, T+19.300 private submission, and the exact `[T+20,T+21)` Builder window; the next live opening remains the receipt-level Builder acceptance and ranking proof.

## Bot1 And Bot5 Global Atomic T+20 Default

Bot1 and Bot5 use the same core atomic transport as Bot2/Bot3 while retaining profile-local market selection, stake, planned-buy priority, wallet, executor, and nonce ownership. Bot1 targets T+20. Bot5 was re-enabled on 2026-07-12 and retuned to match Bot2's T+19 execution and exit parameters.

- Both profiles set `BUILDER_BUNDLE_ENABLED=1`, `BUILDER_BUNDLE_MODE=builder_only`, `BUILDER_BUNDLE_TIMING_MODE=first_20s_block`, `positionFirst=true`, and `noMerge=true`.
- Bot1 uses `first_20s_block`, T+19.500 private submission, `BUILDER_BUNDLE_TIP_BNB=0.005`, and `GAS_PRICE_GWEI=2.1`.
- Bot5 uses `first_19s_block`, T+18.300 private submission, a `700ms` preposition lead, `BUILDER_BUNDLE_TIP_BNB=0.003`, and `GAS_PRICE_GWEI=1.1`. Strict mode cannot public-fallback.
- Bot5's default fast exit now matches Bot2: RPC-only `100%` sell at a random delay from `24500` through `26000ms`, fixed T+25 normal-monitor fallback, `0.15gwei` sell gas, and -10% full stop loss.
- Bot1 defaults to stop-loss-disabled `open_timed_exit`: after a successful single-market buy receipt, it prepares and pre-signs a `100%` sell, draws an integer delay uniformly from `23000` through `27000ms`, and broadcasts the sell through RPC only. `AUTO_SELL_OPEN_EXIT_DELAY_SECONDS=25` is the normal-monitor fallback, and sell gas remains `0.15gwei`. Planned-buy auto-sell settings override this default; the five existing Runner-Up/3rd Place holdings therefore keep their explicit ten-hour `pre_start_exit` schedule.
- Bot1 owns executor `0xe40b5c53d2C6566219f85431a334BA9692d0d6E4`; deploy tx `0x0544932cfc7ecaca2a42c938ec2392783b468015306b7f47e8ca40dd45f5e754` succeeded in block `109301049`, and approval tx `0x7d2320dfbbbcf6ccdee403a9e6b86117d22656207a058cf45ff4b74bc10630cb` succeeded in block `109301076`.
- Bot5 owns executor `0xe8e714bE74480788cABe470935DEb82236793bc3`; deploy tx `0x2c2d20a249a1bab01f844af9864d28c1fe0a21d4820900f80e0902f7ca7f22a4` succeeded in block `109301234`, and approval tx `0xcc524b61ee2001b3ebf8adc9b3ba7c5fdfbebf57c31d54957e81e8f3a71bc86b` succeeded in block `109301236`.
- Both executors match runtime hash `0xcd33816c6e26d932a0053868325d4e0035e1facb8c1f6b30a804a498537a1a02`; owner, operator, Router, collateral, and max BUSDT allowance passed readback.
- The same BlockRazor account token is reused secret-to-secret. BlockRazor documents unlimited sendBundle BPS and unlimited accepted bundles per block; a six-request authenticated concurrency probe passed `6/6` with `473-558ms` latency. Token revocation remains a shared failure domain, while 48Club remains an independent second path.
- Final nonces are contiguous at Bot1 `241/241` and Bot5 `13/13`. Bot1 has about `74.14 BUSDT / 0.01568 BNB`; Bot5 has about `31.01 BUSDT / 0.03708 BNB`. Both event/dashboard services are active with `NRestarts=0`.
- The deploy helper now polls post-receipt code and allowance readback because Ankr/Chainstack can briefly return stale state immediately after a successful receipt. This prevents a successful deploy or approval from being reported as failed.

Bot5's first live T+20 proof completed on CRCL. Buy tx `0x16e893838769b65a16fd0633e337ad8d1d95e992a872142a06ef01103b5fc97c` landed in block `109355894`, timestamp T+20, txIndex `5`, with the 48Club `0.001 BNB` tip at txIndex `6` and no public fallback. It ranked fourth overall and third in the T+20 block because two same-block competitors paid larger tips (`0.0038807` and `0.0012462 BNB`). Bot1's first live T+20 proof remains pending.

CRCL also exposed a sell-only defect shared by Bot2/Bot5. The fast sell inherited the profile's strict buy Builder config, then failed because a sell has no target-second `maxTimestamp`; its catch path left the normal monitor paused until target+45 seconds. Bot2 therefore sold at T+74 and Bot5 at T+96 instead of their randomized targets. The repaired path strips Builder/timed-executor/guard fields for sell signing and broadcast, releases the pause immediately on failure, and keeps nonce reset behavior. Dedicated buy timers are also exempt from generic expired-market cleanup while scheduled or in flight, preventing the misleading Bot5 T+20 skip race.

CASHCAT supplied the post-fix live proof. Both profiles bought `$150M - $175M`, `$175M - $200M`, and `$200M - $225M` at `10U` each. Bot2 fast-sell tx `0x2f045e69cea989fcbaf8be34fc1ecc76253add1a53827d7933c6d3c01a176c83` succeeded for target T+25.962; Bot5 tx `0xd3c299606beaba85ef7489c0158cd2ba84a22473682aa2d06f086ccb862138f7` succeeded for target T+45.601. No `maxTimestamp` sell error recurred, both profile positions became zero, and latest/pending nonces remained contiguous at Bot2 `853/853` and Bot5 `22/22`. Bot5's buy ranked `8` overall and `5` within T+20 because four same-block Builder tips larger than `0.001 BNB` preceded it. Bot5 Event is therefore stopped and disabled; do not reactivate it by raising the tip without an explicit operator decision.

On 2026-07-12 the GRVT market was cancelled and recreated before open. REST marked original `0xFBB0BacCaB3D847e9e38cC55D1E4d986917be302` resolved and created replacement `0xd2837E2FA107b5bF9F7E3628a67266bE318CBbB4` for `2026-07-12T09:30:00Z`. Because a plan carrying both address and question can match either field, startup chain replay initially retained the retired same-title address alongside the replacement. Both workers were stopped before the old broadcast window, the GRVT plans were changed to exact-address-only matching, state was cleared, and restart returned each profile to one funded/prepared pending record. Pre-open Router operator approvals succeeded in txs `0x5f1b0af90145628f91990ee125a76a672a20e3b1a2c320af56e3028742082bda` and `0xd8c47180864202d8680869e33b38c99e6119e143e6c30f2b40a8b834355709f7`.

The live split proof then completed end to end. Bot2 buy `0x94ee3ceac86772be4c785357a96c4cdc0b62f95000f55c3124569868d140714d` and Bot5 buy `0x04ef851ade7f7f5a4f0c94e68c44648c41d0bfe1633529305399cd5aed7ceaa8` both landed in block `109531855`, timestamp T+19, at txIndex `1` and `3`; their mined `0.003 BNB` provider tips occupied txIndex `2` and `4`. Bot2 sold at randomized T+25.337 through `0xd9ab7d53de9e36c50550b4cb8b75adddd2786b73b9c418694157b8b0a94e28ae`; Bot5 sold at T+24.532 through `0x29b7fa853a32407ef14ddd437bd6c7f7c67442ad78bbed9356c999874f5d366c`. Both receipts succeeded at `0.15gwei`, all six selected token balances are zero, final nonces are Bot2 `863/863` and Bot5 `39/39`, and both plan rows are disabled with `preserveAutoSellAfterDisable=true`.

The two ARROW markets on 2026-07-13 retained outcomes 1-3 for Bot2 and 4-6 for Bot5. The July 14 market bought both profiles in block `109703824` at T+19 and ultimately cleared all selected balances; a transient fast-sell RPC parameter rejection was recovered by the stop-loss monitor. For the July 31 market, Bot2 buy `0xab2b1e9e2288d503f1bc7b00cd07722ff1082cafa01651f3f2d3e179ec7fab81` landed in block `109704489` at txIndex `1`, followed by the mined `0.003 BNB` tip. After Bot2 alone moved to T+21.5-23, sell `0x0c4c4e0f6f21995078dcd2428a64a9933e8aae2ae487b4c3459bdced845b54b9` was accepted at T+22.032 and confirmed successfully. Bot5's pre-signed July 31 candidate never mined because an unrelated wallet nonce-43 swap converted `66 BUSDT` to USDC before the opening; latest/pending nonce remained `45/45`, proving the miss was funding rather than nonce or Builder contention.

The Hakimi market `0x8CEA4bE7Dd0A17131C9De260A4e591DdfA96Ce19` supplied the first dual-profile proof after both sell windows moved to T+20.5-21.5. Bot5 bought display outcomes 4-6 in tx `0x9a5af1cdeba3bc2502156eef313cd4ae5e32f74a17481b2d9813d5509b0b50fc` at txIndex `3`; Bot2 bought outcomes 1-3 in tx `0x935be1164c6cd24bb4acb98d56d56d717ea036967e37fb029b5736d787880a6f` at txIndex `5`. Both landed in T+19 block `109707822`, their BlockRazor `0.003 BNB` tips mined at txIndex `4/6`, and neither used public fallback. RPC-only full exits targeted T+21.014 and T+21.033; sells `0x09940931bfe81ddea9ebce3b7891ee21848299d0a7baee011964b3e5a3d7b593` and `0x4384ecffd046718800d22a814216a0ccb45751cfce109e7fb4954da8f3257364` both succeeded in T+21 block `109707827`. All six selected positions are closed, final nonces are Bot5 `50/50` and Bot2 `875/875`, both plans are disabled with terminal hashes, and both workers remain healthy with zero sell errors.

## Current Risk

Buying has real success history, but source attribution and failed/blocked funding evidence must keep improving before increasing capital.

Execution rehearsal commands must be side-effect isolated even when they load a production profile signer. `presign-test`, `due-test`, and the related forced-time test path disable Feishu and redirect seen, fills, decision, Gas-ledger, runtime-health, alert, and auto-sell state writes to a temporary directory. A dry-run result must never be presented to the operator as a confirmed production buy.
