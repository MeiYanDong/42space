# Execution And Risk Plan

## Objective

Make the buy path simple, fast, and bounded.

## Current Buy Policy

- Select the middle 3 outcomes by display/token order.
- For FDV/market-cap range events, buy the middle 3 market-cap ranges.
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
7. Schedule the signed raw transaction for the exact post-open action time and keep rebroadcasting through dedicated RPCs; if the hot path has to sign just-in-time, rebroadcast that raw transaction too.
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
- Use T-60s hot/pre-sign, but do not broadcast before the contract's open time by default. The `$GENIUS` incident showed T-750ms can land in the previous BSC block and revert before the market opens.
- The post-open action time is `start + OPEN_BROADCAST_DELAY_MS` when pre-open broadcast is disabled. A dedicated timer is armed inside the hot window; its final `OPEN_BROADCAST_SPIN_MS` is reserved for reducing Node timer jitter before raw-tx fanout.
- Bot1 anti-snipe mode remains speed-first and strict: keep T-60s pre-sign and use `OPEN_BROADCAST_DELAY_MS=19850` with `GAS_PRICE_GWEI=2.2`, so the intended action time is fixed T+19.850s while still requiring the buy to start before the open-window cutoff. The Australia vs Egypt T+19.800 run started broadcast at T+19.805 and first accepted at T+19.851 but still landed in a T+19 timestamp block, so T+19.850 is an operator-chosen midpoint between T+19.800's 19s-block risk and T+19.900's rank loss. Fixed delay cannot guarantee both avoiding 19s premium and ranking first in the first 20s block.
- Bot1 buy broadcast is currently pinned to single Ankr by setting `BROADCAST_RPC_URLS` to the Ankr endpoint only. The read RPC remains Chainstack. This was changed after Argentina vs Cabo Verde showed Ankr was already the first accepted provider while Chainstack acceptance lagged, and the remaining rank miss came from block/tx ordering rather than dual-RPC coverage.
- The next Bot1 single-Ankr validation is Colombia vs Ghana, staged as a profile-local planned buy at T+19.850 and `2.2gwei` for the three named exact-score outcomes. Use its auto-generated Bot1 buy-rank evidence to compare single-Ankr broadcast timing against the prior dual-RPC fills.
- `OPEN_BROADCAST_MODE=block_aware_20s` exists as an optional local post-open timing implementation, but it is not deployed or active in production after the operator chose fixed timing. Do not enable it without fresh operator approval and a new calibration pass.
- Bot2 production buy defaults are intentionally aggressive for the current phase: keep T-60s pre-signing, broadcast the existing pre-signed transaction at `T+18.840s` with `GAS_PRICE_GWEI=1.1`, limit each same-start opening to the highest-priority market while `EVENT_MAX_DUE_MARKETS_PER_OPEN=1`, and accept that this can land inside the remaining anti-sniping premium window in exchange for an earlier chain position. This timing targets the first block whose `block.timestamp` is open+19s; recent BSC samples show roughly 2 to 3 blocks per timestamp second, so T+18.840 is a propagation/block-boundary optimization, not a guarantee against entering a late 18s block. As of 2026-07-03, Bot2 automatic buying is restored by clearing `MARKET_BUY_QUESTION_ALLOWLIST_REGEX`; the old Bot2 planned-buy rows remain disabled and should not be re-enabled unless the operator explicitly asks. Future eligible automatic buys now clear stale seen keys from prior pauses/filters before pre-signing or scheduling, so a restored strategy cannot pre-sign but skip the open-broadcast timer because the market was previously marked seen. The previous single-market price-gated mode is preserved as a switchable fallback, but `EVENT_PRICE_GATE_ENABLED=0` in production for this phase.
- Staged Bot5 mirrors the current Bot2 production selection and sell policy but remains a separate signer/profile with an operator-adjusted buy broadcast: `EVENT_PROFILE_ROLE=bot2_like`, shared read-only discovery feed, middle-three `10U` default buys, one market per open, `OPEN_BROADCAST_DELAY_MS=19900`, buy gas `6gwei`, sell gas `0.15gwei`, and its own Chainstack RPC/WSS, wallet, nonce, seen state, fills, and auto-sell state. Bot5 may buy the same event as Bot2; it must not share Bot2's private key, nonce manager, market-follow file, planned-buy file, or Feishu webhook.
- Bot4's OpenRouter Python plus BNB/USDT Daily Futures Volume profile uses staggered single-market pre-signing instead of same-action bundle buys. The profile default is `OPEN_BROADCAST_DELAY_MS=19900` and `GAS_PRICE_GWEI=0.5`; the OpenRouter Python planned-buy record also uses `gasPriceGwei=0.5`, buys `DeepSeek V4 Flash`, `Owl Alpha`, and `Hy3 preview` at `10U` each, and targets T+19.900. Hermes OpenRouter token usage buying is paused after the template/outcome change. The BNB/USDT planned-buy record buys `$150M – $300M` and `$300M – $450M` at `10U` each, overrides to `openBroadcastDelayMs=22000`, uses `gasPriceGwei=0.15`, and routes raw broadcast through Bot4's secondary Chainstack RPC. `MAX_MARKET_STAKE_USDT=30` covers the three-outcome OpenRouter market and `MAX_BATCH_STAKE_USDT=50` covers the active daily-template batch. `BUNDLE_DUE_MARKETS=0` keeps the transactions independent, and `EVENT_OPEN_WINDOW_SECONDS=35` is required only as stale-buy protection so staggered transactions are not rejected as old; the window is not the buy timestamp.
- If pre-signing was missed and the bot falls back to just-in-time `fanout_raw`, it must still schedule the same short raw-tx rebroadcast loop as `presigned_fanout_raw`; first RPC acceptance alone is not enough proof that the tx propagated.
- For explicit large-option buys such as `World Cup Winner`, use `EVENT_OUTCOME_SELECTION=names` so the hot path buys only operator-specified outcomes and does not fall back to token-order `middle`.
- For repeated operator-picked match markets such as World Cup exact scores, prefer `EVENT_PLANNED_BUYS_FILE`: each entry binds one market to exact outcome names and per-outcome stake, and the prepared plan carries those names/amounts through pre-sign and broadcast. Planned buys can bypass the single-market-per-open limit only for explicitly planned markets; unplanned markets still obey the global `EVENT_MAX_DUE_MARKETS_PER_OPEN` cap.
- Bot3 (`42space-3`) started live exact-score execution on 2026-06-22 after operator approval, funding, and Router approval. Profile-local planned buys remain the highest-priority execution path; do not infer Bot1/Bot2 intent from Bot3 staged or copied records. Bot3 can additionally enable `BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED=1` for a Bot3-only FIFA/Sports exact-score strategy: when no planned buy matches, it runs a read-only preview, selects the lowest price non-draw win-side tier, converts the selected three canonical scorelines into the existing `names` buy path, and uses `BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT=1` per outcome for the first live practice phase. It still uses Bot3's current pre-sign, broadcast timing, gas, funding guard, receipt, buy-rank evidence, and default pre-start auto-sell chain.
- Bot3 USA vs Bosnia evidence showed gas price was not the reason for ranking behind `0x3a92A09faA9C1aD28b629c681c850b99607E937d`: Bot3 used `1gwei`, broadcast started at `2026-06-27T00:00:18.988Z`, first RPC accepted at `2026-06-27T00:00:19.049Z` with Ankr latency `61ms` and Chainstack latency `364ms`, then landed in block `106577487`. The earlier buyer paid `0.5gwei` but landed in previous block `106577486`; both blocks carried timestamp second `08:00:19` Beijing time. This is a propagation/block-boundary miss, so Bot3 production default was retuned from `OPEN_BROADCAST_DELAY_MS=18985` to `18900` while keeping buy gas `1gwei`.
- Bot1 USA vs Bosnia evidence showed the same issue: Bot1 scheduled T+19.985, actually started raw fanout at `2026-06-27T00:00:19.994Z`, first RPC accepted at `2026-06-27T00:00:20.066Z`, and landed in block `106577489` at txIndex `9` with `3gwei`. The lower-gas `0x604C5E022a66c29194ce43C862D5096e7Ac2E99c` transaction paid `1.1gwei` but landed in the same block at txIndex `1`, while three earlier market buys landed in `08:00:19` blocks. This is not fixed by higher gas price alone. Bot1 was briefly retuned to `18900ms`, then set to `19900ms`, then Spain T+19.700 and Australia T+19.800 both landed in 19s timestamp blocks; current Bot1 fixed timing is `OPEN_BROADCAST_DELAY_MS=19850`, buy gas is `2.2gwei`, and sell gas remains `0.15gwei`.
- Bot3 buy-rank verification uses `npm run bot3:buy-rank`. The script is read-only: it reads Bot3 fills, resolves the target buy, fetches market logs and receipts through RPC, ranks mint transactions by `blockNumber + transactionIndex`, and writes JSON/Markdown evidence under `output/bot3-buy-rank/`. It must not read private keys, broadcast transactions, or print RPC/webhook secrets. Production also runs `42space-bot3-buy-rank-evidence.timer` every two minutes with `--only-new`; it skips already collected tx hashes and writes a new report only after a new Bot3 buy. Use the next generated report to prove whether the T+18.900 timing retune produced rank 1.
- Bot1 buy-rank verification uses the same read-only evidence script with `--profile-env /etc/42space/profiles/42space.env` and writes under `/opt/42space/output/bot1-buy-rank/`. Production now runs `42space-bot1-buy-rank-evidence.timer` every two minutes with `--only-new`; it skips already collected tx hashes and should capture the next Bot1 Colombia vs Ghana fill.
- Planned-buy entries can set `openBroadcastDelayMs` or `openBroadcastDelaySeconds` to override the profile post-open broadcast delay for that market only, can set `gasPriceGwei`/`buyGasPriceGwei` to override buy gas for that market only, and can set `broadcastRpcUrls`/`buyBroadcastRpcUrls` for per-record raw transaction broadcast routing. Scheduler, pre-sign, immediate discovery, funding reserve, bundle grouping, and buy execution must use the record-level action time/gas/RPC so a low-gas planned buy is not mixed with a T+19.900 high-gas planned buy.
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
- `AUTO_SELL_STRATEGY=open_timed_exit` is a separate profile-scoped exit mode, not a replacement for ladder. It sells the configured percent at market open `startDate + AUTO_SELL_OPEN_EXIT_DELAY_SECONDS`; Bot2 uses this for T+18.840s buys and staged Bot5 uses it for T+19.900s buys, both followed by a T+25s full exit. Bot4 daily templates use the same mode with `AUTO_SELL_OPEN_EXIT_DELAY_SECONDS=39600`, so 08:00 Beijing daily opens are sold at 19:00 Beijing unless a planned buy explicitly opts into hold.
- Bot2 and staged Bot5 can enable `AUTO_SELL_FAST_OPEN_EXIT_ENABLED=1` to accelerate that same `open_timed_exit` intent: after the buy receipt succeeds, the worker reads on-chain outcome balances, pre-signs a no-price-protection sell batch, pauses the older poll-based monitor, and broadcasts inside a randomized `AUTO_SELL_FAST_OPEN_EXIT_MIN_DELAY_MS` to `AUTO_SELL_FAST_OPEN_EXIT_MAX_DELAY_MS` window. This is profile-scoped via env and does not change Bot1/Bot3 behavior.
- In `open_timed_exit`, the pre-sign auto-sell pause is shortened to `PRE_SIGN_WINDOW_MS + OPEN_BROADCAST_DELAY_MS + max(1000, AUTO_SELL_POLL_MS)`, so nonce protection still covers the T+19 buy but does not block the timed exit.
- `AUTO_SELL_STRATEGY=pre_start_exit` holds the position without take-profit ladder exits, optionally checks the configured stop-loss on every tick when `AUTO_SELL_STOP_LOSS_ENABLED=1`, and sells 100% at `AUTO_SELL_BEFORE_MARKET_START_SECONDS` before the derived or planned market start.
- Bot1 now defaults to `pre_start_exit` with `AUTO_SELL_BEFORE_MARKET_START_SECONDS=36000`, `AUTO_SELL_STOP_LOSS_ENABLED=0`, sell gas `0.15gwei`, and buy gas `2.2gwei`; planned exact-score records with `pre_start_exit` should keep stop-loss disabled unless the operator explicitly re-enables it for that record.
- Bot3 now defaults to `pre_start_exit` with `AUTO_SELL_BEFORE_MARKET_START_SECONDS=36000`, `AUTO_SELL_STOP_LOSS_ENABLED=0`, sell gas `0.15gwei`, and buy gas `1.1gwei`; exact-score planned buys should keep the same pre-start/stop-loss-off behavior unless the operator explicitly requests retained settlement or a per-record buy-gas override.
- Bot1 and Bot3 use `AUTO_SELL_POLL_MS=30000` while they are in stop-loss-disabled `pre_start_exit` mode; 30s polling is enough for 10h-before-kickoff exits and avoids unnecessary idle position checks.
- Bot4 uses `AUTO_SELL_STRATEGY=open_timed_exit` with `AUTO_SELL_OPEN_EXIT_DELAY_SECONDS=39600`, `AUTO_SELL_OPEN_EXIT_PERCENT=100`, sell gas `0.15gwei`, and `AUTO_SELL_STOP_LOSS_ENABLED=0`. This sells post-cutover daily-template buys at Beijing 19:00 after the 08:00 open; `AUTO_SELL_APPLY_AFTER_ISO` must stay set to the cutover timestamp so old positions are not made immediately eligible. If the operator says to keep a specific event, add a planned-buy `autoSell.enabled=false` / `hold_to_settlement` override before it is bought.
- If one outcome's full-exit quote is down at least `10%` from its current remaining-position cost basis, stop that outcome's ladder and sell all remaining tokens for that outcome. After a partial sell, derive the remaining cost basis from the original cost and current token balance; also track remaining size in local auto-sell state so stale positions API balances cannot compare a half-position quote against full-position cost.
- Other outcomes in the same market continue their own ladders after one outcome stop-losses.
- Automatic sells do not bind price; use `minOut=1`. With `AUTO_SELL_LADDER_PROFIT_PERCENT` enabled above `0`, ladder sells require a successful full-exit quote to confirm the profit gate before execution; set it to `0` for fixed-time ladder exits that do not wait for profit.
- Auto-sell return quotes are strategy-gated to reduce chain RPC load: stop-loss-enabled profiles still quote on each poll, ladder profiles quote at due time only when a profit gate is configured, and `pre_start_exit` profiles with stop-loss disabled do not quote before the pre-start due time.
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

## Bot3 Runner-Up Orderflow-Triggered Sell Requirement

This is a Bot3-only protective sell monitor for the `2026 FIFA World Cup Runner-Up?` market. It does not change Bot3's normal planned-buy path, retained-settlement pre-start exits, Bot1/Bot2/Bot4 behavior, or any generic auto-buy strategy.

The monitor watches only the Bot3-held Runner-Up outcomes currently present in live positions: France, England, Argentina, and Spain on market `0x6B7F30fb52B26814BB49312442010450e43e226D`. Although the operator phrased the request as "five options", Bot3 currently holds four Runner-Up outcomes; the five-option basket belongs to the separate 3rd Place market and must not be touched by this monitor.

Trigger semantics:

- Use chain-confirmed `MarketTrade` logs from the watched market, not REST activity rows.
- Ignore Bot3's own wallet and ignore negative `netCollateral` sell rows.
- Count only positive watched-outcome buy `netCollateral`; BUSDT router transfer is recorded as an audit field, not the primary trigger when event data is available.
- Trigger when one transaction buys at least `200U` across watched outcomes.
- Default sell mode is `matched_outcomes`: sell only the watched outcome or outcomes bought in the triggering transaction. Do not liquidate all Runner-Up outcomes unless `ORDERFLOW_TRIGGER_SELL_MODE=all_watched` is explicitly configured later.
- Sell `100%` of the selected current Bot3 position with the existing direct sell path and `minOut=1`, using Bot3's `AUTO_SELL_GAS_PRICE_GWEI` unless explicitly overridden.

Operational boundaries:

- The monitor is a separate systemd service, `42space-bot3-runner-up-orderflow-sell.service`, so it can run while Bot3's main worker waits for funding.
- The service keeps its own state and JSONL audit log under `/opt/42space/data/42space-3`.
- The read RPC can be isolated from Bot3's normal profile RPC with `ORDERFLOW_TRIGGER_RPC_URL`. In production this value must live in an uncommitted root-only env file such as `/etc/42space/profiles/42space-3-orderflow.env`, not in repo-tracked service templates or docs.
- The default lookback is `0`, so a fresh start monitors future blocks only and does not fire on historical large buys.
- Transaction de-duplication must mark a trade as handled only after processing succeeds. If a watched trade fails during receipt fetch, position fetch, plan build, or sell execution, keep it in a persistent retry queue instead of marking it handled.
- This sidecar does not share the in-process transaction lock with `42space-event@42space-3.service`; because Bot3 currently has no funded future batch, nonce contention risk is limited. If this strategy becomes permanent or high-frequency, move it into the main Bot3 worker or a shared transaction scheduler.
- RPC load is bounded to one `eth_blockNumber` poll per second plus `eth_getLogs` for the single watched market block range.

## Current Risk

Buying has real success history, but source attribution and failed/blocked funding evidence must keep improving before increasing capital.
