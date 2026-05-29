#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { formatUnits, parseGwei, parseUnits } from "viem";
import WebSocket from "ws";
import { appendJsonl, loadSeen, normalizeRuntimeConfig, parseArgs, readConfig, saveSeen } from "./config.js";
import {
  approveRouterMax,
  buildDirectSellPlan,
  buildFastBuyBundlePlan,
  buildDirectBuyAllOutcomesPlan,
  buildMarketFromCreationLog,
  buildMarketsFromControllerLogs,
  buyOutcomesBatch,
  calculateFastGasReserve,
  describeFastBundlePlan,
  describeEventPlan,
  describeSellPlan,
  ensureMarketOperatorApproval,
  executeFastBuyBundle,
  estimateFastGasReserve,
  estimateMaxSelectedOutcomeCount,
  estimateSelectedOutcomeCount,
  fetchControllerLogs,
  fetchMarket,
  fetchMarkets,
  fetchOpenPositions,
  getWalletStatus,
  getWalletStatusForAddress,
  makeClients,
  makeWsClient,
  preSignFastBundleTransaction,
  preSignFastBuyTransaction,
  quoteSellOutcome,
  quoteBuyAllOutcomes,
  resolveWalletBudgetGasLimit,
  roundDownSellAmount,
  sellOutcome,
  sellOutcomesBatch,
  warmBroadcastRpcClients,
  withPrebuiltFastExecution,
  watchControllerLogs
} from "./fortytwo.js";
import {
  eventSeenKey,
  eventDurationMs,
  filterEventMarkets,
  getEventMarketDecision,
  selectEventMarket,
  summarizeEventMarket
} from "./event-strategy.js";
import { isMarketFollowBlocked } from "./market-follow.js";

const execFileAsync = promisify(execFile);
const PUBLIC_TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PUBLIC_TEST_RECEIVER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const alertCooldowns = new Map();
const marketDecisionDedupe = new Set();
const WILL_BUY_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SELL_BATCH_BASE_GAS = 1_500_000;
const SELL_BATCH_PER_OUTCOME_GAS = 1_000_000;
const OPERATOR_APPROVAL_GAS = 250_000;

async function main() {
  const [command = "scan", ...rest] = process.argv.slice(2);
  applyDashboardChildPriority(command);
  const args = parseArgs(rest);
  const cfg = readConfig();

  if (command === "scan") {
    await scan(cfg);
    return;
  }
  if (command === "plan") {
    await plan(cfg, args);
    return;
  }
  if (command === "positions") {
    await positions(cfg, args);
    return;
  }
  if (command === "funding") {
    await funding(cfg, args);
    return;
  }
  if (command === "sell") {
    await sell(cfg, args);
    return;
  }
  if (command === "autosell") {
    await autoSell(cfg, args);
    return;
  }
  if (command === "replay") {
    await replay(cfg, args);
    return;
  }
  if (command === "status") {
    await status(cfg, args);
    return;
  }
  if (command === "rehearse") {
    await rehearse(cfg, args);
    return;
  }
  if (command === "bench") {
    await bench(cfg, args);
    return;
  }
  if (command === "rpc") {
    await rpc(cfg);
    return;
  }
  if (command === "presign-test") {
    await presignTest(cfg, args);
    return;
  }
  if (command === "due-test") {
    await dueTest(cfg, args);
    return;
  }
  if (command === "catchup-test") {
    await catchupTest(cfg, args);
    return;
  }
  if (command === "retry-test") {
    await retryTest(cfg, args);
    return;
  }
  if (command === "deadline-test") {
    await deadlineTest(cfg, args);
    return;
  }
  if (command === "self-test") {
    await selfTest(cfg);
    return;
  }
  if (command === "buy") {
    await buy(cfg, args);
    return;
  }
  if (command === "minimal") {
    await minimal(cfg, args);
    return;
  }
  if (command === "arm") {
    await arm(cfg, args);
    return;
  }
  if (command === "preflight") {
    await preflight(cfg);
    return;
  }
  if (command === "approve") {
    await approve(cfg);
    return;
  }
  if (command === "doctor") {
    await doctor(cfg, args);
    return;
  }
  if (command === "watch") {
    await watch(cfg);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function applyDashboardChildPriority(command) {
  if (process.env.DASHBOARD_CHILD_LOW_PRIORITY !== "1") return;
  if (!["status", "positions"].includes(command)) return;
  const nice = Number(process.env.DASHBOARD_CHILD_NICE ?? 10);
  if (!Number.isFinite(nice) || nice === 0) return;
  try {
    os.setPriority(0, nice);
  } catch {
    // Best effort only: dashboard probes must never fail because priority tuning is unavailable.
  }
}

async function scan(cfg) {
  const markets = await loadEventMarkets(cfg);
  const shown = markets.slice(0, cfg.scanLimit);
  console.log(
    JSON.stringify(
      {
        found: markets.length,
        shown: shown.length,
        markets: shown.map(summarizeEventMarket)
      },
      null,
      2
    )
  );
}

async function plan(cfg, args) {
  const eventPlan = await buildEventPlan(cfg, { ...args, forceQuoted: true });
  console.log(JSON.stringify({ level: "event-plan", plan: describeEventPlan(eventPlan) }, null, 2));
}

async function positions(cfg, args) {
  const walletAddress = args.wallet ?? cfg.walletAddress;
  if (!walletAddress) throw new Error("positions requires --wallet or WALLET_ADDRESS");

  const openPositions = await fetchOpenPositions(cfg, {
    user: walletAddress,
    market: args.market,
    limit: Number(args.limit ?? 100)
  });
  const rows = openPositions.map(summarizePosition);
  const totals = rows.reduce(
    (acc, row) => {
      acc.costBasis += row.costBasisUsdt;
      acc.cashPnl += row.cashPnlUsdt;
      acc.markValue += row.markValueUsdt;
      return acc;
    },
    { costBasis: 0, cashPnl: 0, markValue: 0 }
  );

  console.log(
    JSON.stringify(
      {
        level: "event-positions",
        wallet: walletAddress,
        count: rows.length,
        totals: {
          costBasisUsdt: roundUsd(totals.costBasis),
          cashPnlUsdt: roundUsd(totals.cashPnl),
          markValueUsdt: roundUsd(totals.markValue)
        },
        positions: rows
      },
      null,
      2
    )
  );
}

async function funding(cfg, args) {
  const { publicClient, account } = makeClients(cfg);
  const chain = await loadChainEventMarkets(cfg, { lookbackBlocks: cfg.eventLogLookbackBlocks });
  const restMarkets = await loadRestEventMarkets(cfg, { status: "all", limit: cfg.watchScanLimit });
  const knownEventMarkets = mergeKnownEventMarkets(chain.eventMarkets, restMarkets);
  const requirement = computeFundingRequirement(cfg, knownEventMarkets);
  const gasReserve = await estimateFastGasReserve(publicClient, cfg, requirement);
  const walletAddress = args.wallet ?? cfg.walletAddress ?? account?.address;

  let wallet = null;
  if (walletAddress) {
    const status = await getWalletStatusForAddress(publicClient, walletAddress);
    wallet = buildFundingWalletSummary(status, requirement, gasReserve);
  }

  console.log(JSON.stringify({
    level: "event-funding",
    wallet,
    requirement,
    gasReserve,
    readyForArm: wallet
      ? wallet.busdtBalanceReady && wallet.busdtAllowanceReady && wallet.bnbReady
      : null,
    topUp: wallet?.topUp ?? null,
    nextBatch: {
      startDate: requirement.nextBatchStartDate,
      marketCount: requirement.nextBatchMarketCount,
      outcomeCount: requirement.nextBatchOutcomeCount,
      availableOutcomeCount: requirement.nextBatchAvailableOutcomeCount,
      totalStakeUsdt: requirement.nextBatchRequiredBusdt,
      markets: requirement.nextBatchMarkets
    },
    chainReplay: {
      head: chain.head,
      fromBlock: chain.fromBlock,
      controllerLogs: chain.controllerLogs,
      createNewMarketLogs: chain.createNewMarketLogs,
      decodedMarkets: chain.decodedMarkets,
      eventMarkets: chain.eventMarkets.length,
      decodeErrors: chain.decodeErrors
    },
    restReplay: {
      eventMarkets: restMarkets.length,
      futureEventMarkets: restMarkets.filter((market) => msUntilStart(market) > 0).length
    },
    commands: {
      approveIfAllowanceShort: "npm run event:approve",
      armAfterReady: "npm run event:arm",
      positions: walletAddress ? `npm run event:positions -- --wallet ${walletAddress}` : "npm run event:positions -- --wallet 0x...",
      sellQuote: walletAddress ? `npm run event:sell -- --wallet ${walletAddress} --all` : "npm run event:sell -- --wallet 0x... --all"
    }
  }, null, 2));
}

async function sell(cfg, args) {
  configureSellMode(cfg, args);
  if (!cfg.dryRun && cfg.execute && !cfg.privateKey) {
    cfg.privateKey = await promptHidden("PRIVATE_KEY for event:sell (hidden): ");
  }
  const { publicClient, account } = makeClients(cfg);
  const walletAddress = args.wallet ?? cfg.walletAddress ?? account?.address;
  if (!walletAddress) throw new Error("sell requires --wallet, WALLET_ADDRESS, or PRIVATE_KEY");

  if (!cfg.dryRun && cfg.execute && account && walletAddress.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("Real sell wallet must match PRIVATE_KEY-derived address");
  }

  const openPositions = await fetchOpenPositions(cfg, {
    user: walletAddress,
    market: args.market,
    limit: Number(args.limit ?? 500)
  });
  const selected = selectSellPositions(openPositions, args);
  const percent = Number(args.percent ?? 100);
  const amountOt = args.amountOt ?? args.amount;

  if (amountOt && selected.length !== 1) {
    throw new Error("--amount-ot/--amount can only be used when exactly one position is selected");
  }

  const plans = [];
  for (const position of selected) {
    const plan = await quoteSellOutcome(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      amountOt,
      percent,
      slippageBps: cfg.slippageBps
    });
    plans.push({
      position,
      plan
    });
  }

  const executions = [];
  if (!cfg.dryRun && cfg.execute) {
    for (const item of plans) {
      executions.push(await sellOutcome(cfg, item.plan));
    }
  }

  console.log(JSON.stringify({
    level: "event-sell",
    mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
    wallet: walletAddress,
    selectedCount: selected.length,
    totals: summarizeSellPlans(plans.map((item) => item.plan)),
    positions: plans.map(({ position, plan }) => ({
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      marketAddress: position.marketAddress,
      tokenId: position.tokenId,
      costBasisUsdt: roundUsd(Number(position.costBasis ?? 0)),
      cashPnlUsdt: roundUsd(Number(position.cashPnl ?? 0)),
      quote: describeSellPlan(plan, { dryRun: cfg.dryRun || !cfg.execute })
    })),
    executions
  }, null, 2));
}

function configureSellMode(cfg, args = {}) {
  if (args.execute || args.real) {
    cfg.dryRun = false;
    cfg.execute = true;
    cfg.riskAck = "YES";
    cfg.eligibilityAck = "YES";
    return "execute";
  }
  cfg.dryRun = true;
  cfg.execute = false;
  return "dry-run";
}

async function autoSell(cfg, args) {
  if (args.execute || args.real) {
    cfg.dryRun = false;
    cfg.execute = true;
    cfg.riskAck = "YES";
    cfg.eligibilityAck = "YES";
  }
  if (!cfg.dryRun && cfg.execute && !cfg.privateKey) {
    cfg.privateKey = await promptHidden("PRIVATE_KEY for event:autosell (hidden): ");
  }
  const seen = loadSeen(cfg.autoSellStateFile);
  const result = await runAutoSellOnce(cfg, {
    seen,
    source: "manual"
  });
  console.log(JSON.stringify({
    level: "event-auto-sell",
    mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
    ...result
  }, null, 2));
}

async function replay(cfg, args) {
  const { publicClient } = makeClients(cfg);
  const head = await publicClient.getBlockNumber();
  const lookback = BigInt(args.lookbackBlocks ?? cfg.replayLookbackBlocks);
  const fromBlock = head > lookback ? head - lookback : 0n;
  const logs = await fetchControllerLogs(publicClient, { fromBlock, toBlock: head, chunkSize: cfg.logChunkBlocks });
  const { decoded, decodeErrors } = await decodeControllerMarketLogs(publicClient, logs, {
    createdAt: new Date().toISOString(),
    fallback: true
  });

  const eventMarkets = sortMarketsByChainDesc(filterEventMarkets(decoded, cfg));
  const latestEvent = eventMarkets[0] ?? null;
  const latestEventForPlan = latestEvent ? await maybeHydrateMarketOdds(cfg, latestEvent) : null;
  const fastPlan = latestEventForPlan ? buildDirectBuyAllOutcomesPlan(latestEventForPlan, cfg) : null;

  console.log(
    JSON.stringify(
      {
        level: "replay",
        head: head.toString(),
        fromBlock: fromBlock.toString(),
        controllerLogs: logs.length,
        createNewMarketLogs: countCreationLogs(logs),
        decodedMarkets: decoded.length,
        eventMarkets: eventMarkets.length,
        latestEvent: latestEvent
          ? {
              question: latestEvent.question,
              address: latestEvent.address,
              startDate: latestEvent.startDate,
              endDate: latestEvent.endDate,
              outcomeCount: latestEvent.outcomes.length,
              transactionHash: latestEvent.transactionHash,
              blockNumber: latestEvent.blockNumber
            }
          : null,
        fastPlan: fastPlan ? describeEventPlan(fastPlan) : null,
        decodeErrors
      },
      null,
      2
    )
  );
}

async function status(cfg, args) {
  const { publicClient } = makeClients(cfg);
  const [liveMarkets, restMarkets, chain] = await Promise.all([
    loadEventMarkets(cfg, { limit: cfg.watchScanLimit }),
    loadRestEventMarkets(cfg, { status: "all", limit: cfg.watchScanLimit }),
    loadChainEventMarkets(cfg, args)
  ]);
  const knownEventMarkets = mergeKnownEventMarkets(chain.eventMarkets, restMarkets);
  const funding = computeFundingRequirement(cfg, knownEventMarkets);
  const walletAddress = args.wallet ?? cfg.walletAddress;
  let wallet = null;
  let executablePlan = null;
  if (walletAddress) {
    try {
      const statusResult = await getWalletStatusForAddress(publicClient, walletAddress);
      executablePlan = selectAffordableMarketSummaries(cfg, funding.nextBatchMarkets, statusResult);
      const executableFunding = fundingForMarketSummaries(cfg, executablePlan.selected, funding);
      const gasReserveForWallet = await estimateFastGasReserve(publicClient, cfg, executableFunding);
      wallet = {
        ...statusResult,
        requiredBusdt: funding.requiredBusdt,
        minimumExecutableBusdt: funding.minimumExecutableBusdt,
        executableBusdt: executablePlan.totalStakeUsdt,
        executableMarketCount: executablePlan.selected.length,
        unfundedMarketCount: executablePlan.skipped.length,
        partialFunding: executablePlan.selected.length > 0 && executablePlan.skipped.length > 0,
        requiredBusdtUpperBound: funding.upperBoundRequiredBusdt,
        fundingMode: funding.mode,
        requiredBnbGasReserve: gasReserveForWallet.requiredBnb,
        gasReserveMode: gasReserveForWallet.mode,
        allowanceReady: executablePlan.selected.length > 0,
        balanceReady: executablePlan.selected.length > 0,
        bnbReady: Number(statusResult.bnbBalance) >= Number(gasReserveForWallet.requiredBnb),
        allowanceReadyForUpperBound: Number(statusResult.busdtAllowanceToRouter) >= funding.upperBoundRequiredBusdt,
        balanceReadyForUpperBound: Number(statusResult.busdtBalance) >= funding.upperBoundRequiredBusdt
      };
    } catch (error) {
      wallet = { ok: false, message: errorMessage(error) };
    }
  }
  const gasReserve = await estimateFastGasReserve(
    publicClient,
    cfg,
    executablePlan?.selected?.length ? fundingForMarketSummaries(cfg, executablePlan.selected, funding) : funding
  );
  const executableAddressSet = new Set((executablePlan?.selected ?? []).map((market) => String(market.address).toLowerCase()));
  const unfundedAddressSet = new Set((executablePlan?.skipped ?? []).map((market) => String(market.address).toLowerCase()));

  const futureMarkets = knownEventMarkets
    .filter((market) => msUntilStart(market) > 0)
    .sort(compareMarketBuyPriority);
  const latestLive = liveMarkets[0] ?? null;
  const latestLivePlan = latestLive ? safeDescribeDirectPlan(latestLive, cfg) : null;
  const future = await Promise.all(futureMarkets.slice(0, cfg.scanLimit).map(async (market) => {
    const record = await preparePendingRecord(cfg, market, null);
    return {
      question: market.question,
      address: market.address,
      startDate: market.startDate,
      endDate: market.endDate,
      msUntilStart: msUntilStart(market),
      outcomeCount: selectedOutcomeCount(market, cfg),
      availableOutcomeCount: market.outcomes?.length ?? 0,
      totalStakeUsdt: selectedStakeUsdt(market, cfg),
      durationHours: marketDurationHours(market),
      durationText: formatDuration(market),
      fundingState: executableAddressSet.has(String(market.address).toLowerCase())
        ? "funded"
        : (unfundedAddressSet.has(String(market.address).toLowerCase()) ? "insufficient-funds" : "future"),
      prepared: Boolean(record.preparedPlan),
      prepareError: record.prepareError,
      transactionHash: market.transactionHash,
      blockNumber: market.blockNumber
    };
  }));

  console.log(JSON.stringify({
    level: "event-status",
    mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
    wallet,
    funding,
    gasReserve,
    autoSellCircuit: summarizeAutoSellCircuit(cfg),
    requiredBusdtUpperBound: funding.upperBoundRequiredBusdt,
    watchConfig: {
      eventDiscovery: cfg.eventDiscovery,
      wsProvider: wsProviderLabel(cfg.wsUrl),
      eventBuyMode: cfg.eventBuyMode,
      watchFundingMode: cfg.watchFundingMode,
      bundleDueMarkets: cfg.bundleDueMarkets,
      restDiscoveryEnabled: cfg.restDiscoveryEnabled,
      restDiscoveryPollMs: cfg.restDiscoveryPollMs,
      stakePerOutcomeUsdt: cfg.stakePerOutcomeUsdt,
      eventOutcomeSelection: cfg.eventOutcomeSelection,
      eventOutcomeCount: cfg.eventOutcomeCount,
      eventOutcomeSelectionFallback: cfg.eventOutcomeSelectionFallback,
      filterMode: cfg.filterMode ?? "production",
      autoSellEnabled: cfg.autoSellEnabled,
      autoSellStrategy: cfg.autoSellStrategy,
      autoSellStartDelaySeconds: cfg.autoSellStartDelaySeconds,
      autoSellIntervalSeconds: cfg.autoSellIntervalSeconds,
      autoSellChunkPercent: cfg.autoSellChunkPercent,
      autoSellApplyAfterIso: cfg.autoSellApplyAfterIso,
      autoSellStopLossEnabled: cfg.autoSellStopLossEnabled,
      autoSellStopLossPercent: cfg.autoSellStopLossPercent,
      autoSellStopLossSellPercent: cfg.autoSellStopLossSellPercent,
      autoSellPollMs: cfg.autoSellPollMs,
      autoSellBuyGuardBeforeMs: cfg.autoSellBuyGuardBeforeMs,
      autoSellBuyGuardAfterMs: cfg.autoSellBuyGuardAfterMs,
      autoSellPreapproveOperator: cfg.autoSellPreapproveOperator,
      autoSellRequirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator,
      autoSellMaxOutcomesPerTx: cfg.autoSellMaxOutcomesPerTx,
      autoSellMaxMarketsPerTx: cfg.autoSellMaxMarketsPerTx,
      autoSellMaxGasPerTx: cfg.autoSellMaxGasPerTx,
      autoSellMaxTxPerTick: cfg.autoSellMaxTxPerTick,
      maxBatchStakeUsdt: cfg.maxBatchStakeUsdt,
      maxOutcomesPerMarket: cfg.maxOutcomesPerMarket,
      maxMarketStakeUsdt: cfg.maxMarketStakeUsdt,
      gasPriceGwei: cfg.gasPriceGwei || null,
      minEventDurationHours: cfg.minEventDurationHours,
      marketFollowFile: cfg.marketFollowFile,
      fastSkipPreflight: cfg.fastSkipPreflight,
      fastSkipDueRestHydration: cfg.fastSkipDueRestHydration,
      fanoutBroadcast: cfg.fanoutBroadcast,
      broadcastRpcCount: cfg.broadcastRpcUrls.length,
      preSignFastTx: cfg.preSignFastTx,
      preSignWindowMs: cfg.preSignWindowMs,
      preSignRetryMs: cfg.preSignRetryMs,
      allowPreopenBroadcast: cfg.allowPreopenBroadcast,
      prebroadcastMs: cfg.prebroadcastMs,
      openBroadcastDelayMs: cfg.openBroadcastDelayMs,
      openBroadcastScheduleAheadMs: cfg.openBroadcastScheduleAheadMs,
      openBroadcastSpinMs: cfg.openBroadcastSpinMs,
      nonceSyncBeforePreSign: cfg.nonceSyncBeforePreSign,
      nonceSyncMinIntervalMs: cfg.nonceSyncMinIntervalMs,
      asyncReceiptWatch: cfg.asyncReceiptWatch,
      receiptWatchTimeoutMs: cfg.receiptWatchTimeoutMs,
      receiptWatchPollingMs: cfg.receiptWatchPollingMs,
      executionRetryMs: cfg.executionRetryMs,
      eventOpenWindowSeconds: cfg.eventOpenWindowSeconds,
      pollMs: cfg.pollMs,
      hotPollMs: cfg.hotPollMs,
      preopenHotMs: cfg.preopenHotMs,
      prebroadcastMs: cfg.prebroadcastMs,
      effectivePrebroadcastMs: effectivePrebroadcastMs(cfg),
      allowPreopenBroadcast: cfg.allowPreopenBroadcast,
      wsReceiptFallbackMs: cfg.wsReceiptFallbackMs,
      wsReceiptFallbackRetries: cfg.wsReceiptFallbackRetries,
      autoSellEnabled: cfg.autoSellEnabled,
      autoSellStrategy: cfg.autoSellStrategy,
      autoSellStartDelaySeconds: cfg.autoSellStartDelaySeconds,
      autoSellIntervalSeconds: cfg.autoSellIntervalSeconds,
      autoSellChunkPercent: cfg.autoSellChunkPercent,
      autoSellApplyAfterIso: cfg.autoSellApplyAfterIso,
      autoSellStopLossEnabled: cfg.autoSellStopLossEnabled,
      autoSellStopLossPercent: cfg.autoSellStopLossPercent,
      autoSellStopLossSellPercent: cfg.autoSellStopLossSellPercent,
      autoSellPollMs: cfg.autoSellPollMs,
      autoSellBuyGuardBeforeMs: cfg.autoSellBuyGuardBeforeMs,
      autoSellBuyGuardAfterMs: cfg.autoSellBuyGuardAfterMs,
      autoSellPreapproveOperator: cfg.autoSellPreapproveOperator,
      autoSellRequirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator,
      autoSellMaxOutcomesPerTx: cfg.autoSellMaxOutcomesPerTx,
      autoSellMaxMarketsPerTx: cfg.autoSellMaxMarketsPerTx,
      autoSellMaxGasPerTx: cfg.autoSellMaxGasPerTx,
      autoSellMaxTxPerTick: cfg.autoSellMaxTxPerTick
    },
    live: {
      count: liveMarkets.length,
      latestPlan: latestLivePlan
    },
    chainReplay: {
      head: chain.head,
      fromBlock: chain.fromBlock,
      controllerLogs: chain.controllerLogs,
      createNewMarketLogs: chain.createNewMarketLogs,
      decodedMarkets: chain.decodedMarkets,
      eventMarkets: chain.eventMarkets.length,
      decodeErrors: chain.decodeErrors
    },
    restReplay: {
      eventMarkets: restMarkets.length,
      futureEventMarkets: restMarkets.filter((market) => msUntilStart(market) > 0).length
    },
    future
  }, null, 2));
}

async function rehearse(cfg, args) {
  cfg.dryRun = true;
  cfg.execute = false;
  cfg.eventBuyMode = "fast";
  const chain = await loadChainEventMarkets(cfg, args);
  const futureMarkets = chain.eventMarkets
    .filter((market) => msUntilStart(market) > 0)
    .sort(compareStartAsc);
  const market = args.market
    ? selectEventMarket(chain.eventMarkets, args)
    : futureMarkets[0] ?? chain.eventMarkets[0];
  if (!market) throw new Error("No Event Market found for rehearsal");

  const forcedMarket = {
    ...market,
    startDate: new Date(Date.now() - 1000).toISOString()
  };
  const record = await preparePendingRecord(cfg, forcedMarket, null);
  const eventPlan = record.preparedPlan ?? buildDirectBuyAllOutcomesPlan(forcedMarket, cfg);
  console.log(JSON.stringify({
    level: "event-rehearsal",
    sourceMarket: {
      question: market.question,
      address: market.address,
      originalStartDate: market.startDate,
      forcedStartDate: forcedMarket.startDate,
      msUntilOriginalStart: msUntilStart(market),
      outcomeCount: selectedOutcomeCount(market, cfg),
      availableOutcomeCount: market.outcomes?.length ?? 0,
      transactionHash: market.transactionHash,
      blockNumber: market.blockNumber
    },
    prepared: Boolean(record.preparedPlan),
    prebuiltCalldata: Boolean(record.prebuiltCalldata),
    prepareError: record.prepareError,
    plan: describeEventPlan(eventPlan)
  }, null, 2));
}

function safeDescribeDirectPlan(market, cfg) {
  try {
    return describeEventPlan(buildDirectBuyAllOutcomesPlan(market, cfg));
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
      market: {
        question: market.question,
        address: market.address,
        startDate: market.startDate,
        endDate: market.endDate,
        outcomeCount: selectedOutcomeCount(market, cfg),
        availableOutcomeCount: market.outcomes?.length ?? 0,
        totalStakeUsdt: roundUsd(selectedStakeUsdt(market, cfg))
      }
    };
  }
}

async function bench(cfg, args) {
  const samples = Number(args.samples ?? 3);
  const results = [];
  const chainStart = performance.now();
  const chain = await loadChainEventMarkets(cfg, args);
  const chainMs = performance.now() - chainStart;
  const futureMarkets = chain.eventMarkets
    .filter((market) => msUntilStart(market) > 0)
    .sort(compareStartAsc);
  const startDate = args.startDate ?? futureMarkets[0]?.startDate;
  if (!startDate) throw new Error("No future Event Market found for benchmark");
  const startMs = new Date(startDate).getTime();
  const batch = futureMarkets.filter((market) => new Date(market.startDate).getTime() === startMs);
  if (batch.length === 0) throw new Error(`No Event Markets found at startDate ${startDate}`);

  const benchCfg = {
    ...cfg,
    privateKey: PUBLIC_TEST_PRIVATE_KEY,
    dryRun: false,
    execute: true,
    riskAck: "YES",
    eligibilityAck: "YES",
    eventBuyMode: "fast",
    fastGasWalletBudget: false
  };
  const hydrationStart = performance.now();
  const hydratedBatch = await Promise.all(batch.map((market) => maybeHydrateMarketOdds(benchCfg, market)));
  const oddsHydrationMs = performance.now() - hydrationStart;

  for (let i = 0; i < samples; i += 1) {
    const planStart = performance.now();
    const plans = hydratedBatch.map((market) =>
      withPrebuiltFastExecution(buildDirectBuyAllOutcomesPlan(market, benchCfg), PUBLIC_TEST_RECEIVER)
    );
    const planBuildMs = performance.now() - planStart;

    const bundleStart = performance.now();
    const bundle = buildFastBuyBundlePlan(benchCfg, plans, PUBLIC_TEST_RECEIVER);
    const bundleBuildMs = performance.now() - bundleStart;

    const signStart = performance.now();
    const runtime = { receiverAddress: PUBLIC_TEST_RECEIVER, nextNonce: 1000 + i };
    const signed = await preSignFastBundleTransaction(benchCfg, bundle, runtime);
    const preSignMs = performance.now() - signStart;

    results.push({
      sample: i + 1,
      planBuildMs: roundMs(planBuildMs),
      bundleBuildMs: roundMs(bundleBuildMs),
      preSignMs: roundMs(preSignMs),
      totalHotPathMs: roundMs(planBuildMs + bundleBuildMs + preSignMs),
      txHash: signed.txHash,
      nonce: signed.nonce,
      rawLength: signed.serializedTransaction.length
    });
  }

  console.log(JSON.stringify({
    level: "event-bench",
    note: "offline benchmark only; uses a public test private key and does not broadcast",
    chainLoadMs: roundMs(chainMs),
    oddsHydrationMs: roundMs(oddsHydrationMs),
    head: chain.head,
    fromBlock: chain.fromBlock,
    marketBatch: {
      startDate,
      marketCount: batch.length,
      outcomeCount: batchSelectedOutcomeCount(batch, cfg),
      availableOutcomeCount: batch.reduce((sum, market) => sum + (market.outcomes?.length ?? 0), 0),
      totalStakeUsdt: batchSelectedStakeUsdt(batch, cfg),
      markets: batch.map((market) => ({
        question: market.question,
        address: market.address,
        outcomeCount: selectedOutcomeCount(market, cfg),
        availableOutcomeCount: market.outcomes?.length ?? 0
      }))
    },
    config: {
      stakePerOutcomeUsdt: cfg.stakePerOutcomeUsdt,
      eventOutcomeSelection: cfg.eventOutcomeSelection,
      eventOutcomeCount: cfg.eventOutcomeCount,
      eventOutcomeSelectionFallback: cfg.eventOutcomeSelectionFallback,
      autoSellEnabled: cfg.autoSellEnabled,
      autoSellStrategy: cfg.autoSellStrategy,
      autoSellStartDelaySeconds: cfg.autoSellStartDelaySeconds,
      autoSellIntervalSeconds: cfg.autoSellIntervalSeconds,
      autoSellChunkPercent: cfg.autoSellChunkPercent,
      autoSellPollMs: cfg.autoSellPollMs,
      autoSellBuyGuardBeforeMs: cfg.autoSellBuyGuardBeforeMs,
      autoSellBuyGuardAfterMs: cfg.autoSellBuyGuardAfterMs,
      autoSellPreapproveOperator: cfg.autoSellPreapproveOperator,
      autoSellRequirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator,
      autoSellMaxOutcomesPerTx: cfg.autoSellMaxOutcomesPerTx,
      autoSellMaxMarketsPerTx: cfg.autoSellMaxMarketsPerTx,
      autoSellMaxGasPerTx: cfg.autoSellMaxGasPerTx,
      autoSellMaxTxPerTick: cfg.autoSellMaxTxPerTick,
      maxBatchStakeUsdt: cfg.maxBatchStakeUsdt,
      fastGasLimit: cfg.fastGasLimit,
      bundleFastGasLimit: cfg.bundleFastGasLimit,
      gasPriceGwei: cfg.gasPriceGwei,
      fanoutBroadcast: cfg.fanoutBroadcast,
      broadcastRpcCount: cfg.broadcastRpcUrls.length
    },
    samples: results,
    summary: summarizeBenchResults(results)
  }, null, 2));
}

async function rpc(cfg) {
  const warmup = await warmBroadcastRpcClients(cfg);
  console.log(JSON.stringify({
    level: "event-broadcast-rpc",
    fanoutBroadcast: cfg.fanoutBroadcast,
    broadcastRpcCount: cfg.broadcastRpcUrls.length,
    broadcastTimeoutMs: cfg.broadcastTimeoutMs,
    rpcWarmupTimeoutMs: cfg.rpcWarmupTimeoutMs,
    warmup
  }, null, 2));
}

async function presignTest(cfg, args) {
  const { chain, batch, startDate, testCfg, runtime, records } = await buildPresignTestRecords(cfg, args);

  const signStart = performance.now();
  const preSignMode = records.length > 1 ? "bundle" : "single";
  if (preSignMode === "bundle") {
    await attachPreSignedFastBundleTransaction(testCfg, records, runtime);
  } else {
    await attachPreSignedFastTransaction(testCfg, records[0], runtime);
  }
  const signMs = performance.now() - signStart;
  const cachedStart = performance.now();
  const cachedBundle = preSignMode === "bundle" ? reusablePreSignedBundle(records) : null;
  const cachedLookupMs = performance.now() - cachedStart;
  const signed = preSignMode === "bundle"
    ? records[0]?.preSignedFastBundleTransaction ?? null
    : records[0]?.preSignedFastTransaction ?? null;
  if (!signed || (preSignMode === "bundle" && !cachedBundle)) {
    throw new Error(`Pre-sign test expected a reusable pre-signed ${preSignMode} transaction`);
  }

  console.log(JSON.stringify({
    level: "event-presign-test",
    note: "offline presign/cache test only; uses a public test private key and does not broadcast",
    chainLoad: {
      source: chain.discoverySource,
      head: chain.head,
      fromBlock: chain.fromBlock,
      restEventMarkets: chain.restEventMarkets
    },
    marketBatch: {
      startDate,
      marketCount: batch.length,
      outcomeCount: batchSelectedOutcomeCount(batch, testCfg),
      availableOutcomeCount: batch.reduce((sum, market) => sum + (market.outcomes?.length ?? 0), 0),
      totalStakeUsdt: batchSelectedStakeUsdt(batch, testCfg),
      markets: batch.map((market) => ({
        question: market.question,
        address: market.address,
        outcomeCount: selectedOutcomeCount(market, testCfg),
        availableOutcomeCount: market.outcomes?.length ?? 0
      }))
    },
    preparedRecordCount: records.length,
    prebuiltRecordCount: records.filter((record) => record.prebuiltCalldata).length,
    signed: signed
      ? {
          mode: preSignMode,
          txHash: signed.txHash,
          nonce: signed.nonce,
          rawLength: signed.serializedTransaction.length,
          marketCount: signed.marketCount ?? records.length,
          outcomeCount: signed.outcomeCount ?? batchSelectedOutcomeCount(batch, testCfg)
        }
      : null,
    cache: {
      reusable: preSignMode === "bundle" ? Boolean(cachedBundle) : Boolean(signed),
      sameTxHash: preSignMode === "bundle"
        ? Boolean(cachedBundle && signed && cachedBundle.preSignedFastBundleTransaction.txHash === signed.txHash)
        : Boolean(signed),
      marketCount: cachedBundle?.marketCount ?? records.length,
      outcomeCount: cachedBundle?.outcomeCount ?? batchSelectedOutcomeCount(batch, testCfg)
    },
    runtime: {
      startNonce: 1000,
      nextNonceAfterPresign: runtime.nextNonce
    },
    timing: {
      preSignBundleMs: roundMs(signMs),
      cachedBundleLookupMs: roundMs(cachedLookupMs)
    }
  }, null, 2));
}

async function dueTest(cfg, args) {
  const { chain, batch, startDate, testCfg, runtime, records } = await buildPresignTestRecords(cfg, args);
  const preSignMode = records.length > 1 ? "bundle" : "single";
  if (preSignMode === "bundle") {
    await attachPreSignedFastBundleTransaction(testCfg, records, runtime);
  } else {
    await attachPreSignedFastTransaction(testCfg, records[0], runtime);
  }
  const cachedBundle = preSignMode === "bundle" ? reusablePreSignedBundle(records) : null;
  const signed = preSignMode === "bundle"
    ? cachedBundle?.preSignedFastBundleTransaction ?? null
    : records[0]?.preSignedFastTransaction ?? null;
  if (!signed) throw new Error(`Due test expected a reusable pre-signed ${preSignMode} transaction`);

  const dueCfg = {
    ...testCfg,
    dryRun: true,
    execute: false,
    stateFile: `/tmp/42space-due-test-seen-${Date.now()}.json`,
    fillsFile: `/tmp/42space-due-test-fills-${Date.now()}.jsonl`
  };
  const forcedStartDate = new Date(Date.now() - 1000).toISOString();
  const pending = new Map();
  const seen = new Set();
  for (const record of records) {
    record.market = { ...record.market, startDate: forcedStartDate };
    pending.set(eventSeenKey(record.market, dueCfg), record);
  }

  const drainStart = performance.now();
  await drainDuePendingMarkets(dueCfg, seen, pending, runtime);
  const drainMs = performance.now() - drainStart;

  console.log(JSON.stringify({
    level: "event-due-test",
    note: "offline due-path test only; uses a public test private key for pre-signing and dry-run execution, no broadcast",
    chainLoad: {
      source: chain.discoverySource,
      head: chain.head,
      fromBlock: chain.fromBlock,
      restEventMarkets: chain.restEventMarkets
    },
    marketBatch: {
      originalStartDate: startDate,
      forcedStartDate,
      marketCount: batch.length,
      outcomeCount: batchSelectedOutcomeCount(batch, dueCfg),
      availableOutcomeCount: batch.reduce((sum, market) => sum + (market.outcomes?.length ?? 0), 0),
      totalStakeUsdt: batchSelectedStakeUsdt(batch, dueCfg)
    },
    preSigned: {
      mode: preSignMode,
      txHash: signed.txHash,
      nonce: signed.nonce,
      marketCount: cachedBundle?.marketCount ?? records.length,
      outcomeCount: cachedBundle?.outcomeCount ?? batchSelectedOutcomeCount(batch, dueCfg)
    },
    duePath: {
      pendingRemaining: pending.size,
      seenCount: seen.size,
      dryRun: dueCfg.dryRun,
      fillsFile: dueCfg.fillsFile,
      stateFile: dueCfg.stateFile,
      usedCachedBundleBeforeDrain: Boolean(cachedBundle)
    },
    runtime: {
      startNonce: 1000,
      nextNonceAfterDueTest: runtime.nextNonce
    },
    timing: {
      drainDueMs: roundMs(drainMs)
    }
  }, null, 2));
}

async function catchupTest(cfg, args) {
  const { chain, batch, startDate, testCfg } = await buildPresignTestRecords(cfg, args);
  const now = Date.now();
  const ageMs = Number(args.ageMs ?? 1000);
  const catchUpCfg = {
    ...testCfg,
    dryRun: true,
    execute: false,
    armCatchUpAfterFunding: true,
    armCatchUpWindowMs: Number(args.windowMs ?? cfg.armCatchUpWindowMs),
    stateFile: `/tmp/42space-catchup-test-seen-${now}.json`,
    fillsFile: `/tmp/42space-catchup-test-fills-${now}.jsonl`
  };
  const forcedStartDate = new Date(now - ageMs).toISOString();
  const markets = batch.map((market) => ({
    ...market,
    status: "live",
    startDate: forcedStartDate
  }));
  const fundingRecovery = {
    enabled: true,
    waitingSince: now - Math.max(ageMs, catchUpCfg.armCatchUpWindowMs),
    fundingReadyAt: now
  };
  const catchUpMarkets = markets.filter((market) =>
    shouldCatchUpLiveMarket(catchUpCfg, market, { fundingRecovery })
  );
  const seen = new Set();
  const pending = new Map();
  const catchUpStart = performance.now();
  await handleDiscoveredMarkets(catchUpCfg, seen, pending, catchUpMarkets, null, {
    source: "catchup-test",
    hydrateDueOdds: true,
    hydrationSkipReason: "catchup_test"
  });
  const catchUpMs = performance.now() - catchUpStart;

  console.log(JSON.stringify({
    level: "event-catchup-test",
    note: "offline catch-up test only; forces next future batch to look just-started and dry-runs execution, no broadcast",
    chainLoad: {
      source: chain.discoverySource,
      head: chain.head,
      fromBlock: chain.fromBlock,
      restEventMarkets: chain.restEventMarkets
    },
    marketBatch: {
      originalStartDate: startDate,
      forcedStartDate,
      forcedAgeMs: ageMs,
      catchUpWindowMs: catchUpCfg.armCatchUpWindowMs,
      marketCount: batch.length,
      catchUpCandidateCount: catchUpMarkets.length,
      outcomeCount: batchSelectedOutcomeCount(batch, catchUpCfg),
      availableOutcomeCount: batch.reduce((sum, market) => sum + (market.outcomes?.length ?? 0), 0),
      totalStakeUsdt: batchSelectedStakeUsdt(batch, catchUpCfg)
    },
    catchUpPath: {
      seenCount: seen.size,
      pendingRemaining: pending.size,
      dryRun: catchUpCfg.dryRun,
      fillsFile: catchUpCfg.fillsFile,
      stateFile: catchUpCfg.stateFile
    },
    timing: {
      catchUpMs: roundMs(catchUpMs)
    }
  }, null, 2));
}

async function retryTest(cfg, args) {
  const { chain, batch, startDate, testCfg, records } = await buildPresignTestRecords(cfg, args);
  const retryCfg = {
    ...testCfg,
    dryRun: true,
    execute: false,
    executionRetryMs: Number(args.executionRetryMs ?? cfg.executionRetryMs)
  };
  const record = records[0];
  record.market = { ...record.market, startDate: new Date(Date.now() - 1000).toISOString() };

  const beforeRetryWaitMs = msUntilRecordAction(record, retryCfg);
  if (beforeRetryWaitMs !== 0) {
    throw new Error(`Retry test expected due record before failure, got ${beforeRetryWaitMs}ms`);
  }

  markExecutionRetry(record, retryCfg, new Error("simulated execution failure"));
  const afterFailureWaitMs = msUntilRecordAction(record, retryCfg);
  if (afterFailureWaitMs <= 0 || afterFailureWaitMs > retryCfg.executionRetryMs) {
    throw new Error(`Retry test expected retry wait within ${retryCfg.executionRetryMs}ms, got ${afterFailureWaitMs}ms`);
  }
  await sleep(retryCfg.executionRetryMs + 25);
  const afterCooldownWaitMs = msUntilRecordAction(record, retryCfg);
  if (afterCooldownWaitMs !== 0) {
    throw new Error(`Retry test expected due record after cooldown, got ${afterCooldownWaitMs}ms`);
  }

  const marks = {
    dryRun: executionMarksSeen({ dryRun: true }),
    success: executionMarksSeen({ status: "success" }),
    broadcast: executionMarksSeen({ status: "broadcast" }),
    reverted: executionMarksSeen({ status: "reverted" })
  };
  if (!marks.dryRun || !marks.success || !marks.broadcast || marks.reverted) {
    throw new Error(`Retry test completion classifier failed: ${JSON.stringify(marks)}`);
  }

  console.log(JSON.stringify({
    level: "event-retry-test",
    note: "offline retry classifier test only; broadcast is treated as submitted",
    chainLoad: {
      head: chain.head,
      fromBlock: chain.fromBlock
    },
    marketBatch: {
      originalStartDate: startDate,
      marketCount: batch.length,
      testedMarket: pendingMarket(record).address
    },
    retry: {
      executionRetryMs: retryCfg.executionRetryMs,
      beforeRetryWaitMs,
      afterFailureWaitMs: roundMs(afterFailureWaitMs),
      afterCooldownWaitMs,
      executionAttempts: record.executionAttempts,
      hasExecutionError: Boolean(record.executionError)
    },
    completionClassifier: marks
  }, null, 2));
}

async function deadlineTest(cfg, args) {
  const now = Date.now();
  const testCfg = {
    ...cfg,
    dryRun: true,
    execute: false,
    eventOpenWindowSeconds: Number(args.windowSeconds ?? cfg.eventOpenWindowSeconds),
    stateFile: `/tmp/42space-deadline-test-seen-${now}.json`,
    fillsFile: `/tmp/42space-deadline-test-fills-${now}.jsonl`
  };
  const staleMarket = {
    address: "0x0000000000000000000000000000000000000042",
    question: "Deadline test Event Market",
    status: "live",
    createdAt: new Date(now - 120000).toISOString(),
    startDate: new Date(now - (testCfg.eventOpenWindowSeconds * 1000 + 1000)).toISOString(),
    endDate: new Date(now + 3600000).toISOString(),
    outcomes: [
      { tokenId: "1", name: "A", price: 0.5, payout: 2 },
      { tokenId: "2", name: "B", price: 0.5, payout: 2 }
    ],
    categories: ["Crypto"],
    tags: ["Normal"]
  };
  const pending = new Map();
  const seen = new Set();
  pending.set(eventSeenKey(staleMarket, testCfg), {
    market: staleMarket,
    preparedPlan: null,
    executionAttempts: 1,
    executionRetryAfterMs: now - 1
  });

  await drainDuePendingMarkets(testCfg, seen, pending, null);
  const expectedKey = eventSeenKey(staleMarket, testCfg);
  if (pending.size !== 0 || !seen.has(expectedKey)) {
    throw new Error(`Deadline test expected stale market skipped; pending=${pending.size} seen=${seen.size}`);
  }

  console.log(JSON.stringify({
    level: "event-deadline-test",
    note: "offline open-window deadline test only; no broadcast",
    eventOpenWindowSeconds: testCfg.eventOpenWindowSeconds,
    skipped: seen.has(expectedKey),
    pendingRemaining: pending.size,
    fillsFile: testCfg.fillsFile,
    stateFile: testCfg.stateFile
  }, null, 2));
}

async function selfTest(cfg) {
  const testCfg = {
    ...cfg,
    privateKey: PUBLIC_TEST_PRIVATE_KEY,
    walletAddress: PUBLIC_TEST_RECEIVER,
    dryRun: true,
    execute: false,
    eventBuyMode: "fast",
    eventOutcomeSelection: "lowest_odds",
    eventOutcomeCount: 5,
    eventOutcomeSelectionFallback: "token_order",
    stakePerOutcomeUsdt: 5,
    maxStakeUsdt: 25,
    maxMarketStakeUsdt: 25,
    maxBatchStakeUsdt: 100,
    maxOutcomesPerMarket: 12,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: ["8 hour", "automated"],
    minEventDurationHours: 48,
    autoSellStrategy: "ladder",
    autoSellStartDelaySeconds: 10,
    autoSellIntervalSeconds: 10,
    autoSellChunkPercent: 10,
    autoSellStopLossEnabled: true,
    autoSellStopLossPercent: 10,
    autoSellStopLossSellPercent: 100,
    autoSellBuyGuardBeforeMs: 120000,
    autoSellBuyGuardAfterMs: 10000,
    autoSellPreapproveOperator: true,
    autoSellApprovalsPerTick: 1,
    autoSellRequirePreapprovedOperator: true,
    autoSellMaxOutcomesPerTx: 8,
    autoSellMaxMarketsPerTx: 4,
    autoSellMaxGasPerTx: 12000000,
    autoSellMaxTxPerTick: 1,
    autoSellMinBnbReserve: 0.003,
    autoSellFailureCooldownMs: 3600000,
    autoSellMaxConsecutiveFailures: 2,
    autoSellCircuitBreakerEnabled: true,
    autoSellCircuitFailureLimit: 2,
    autoSellCircuitWindowMs: 600000,
    autoSellCircuitPauseMs: 3600000,
    autoSellErrorMessageMaxChars: 500,
    autoSellAlertCooldownMs: 3600000,
    autoSellEligibleTailBytes: 4194304
  };
  const passed = [];

  const lowestOddsPlan = buildDirectBuyAllOutcomesPlan(mockEventMarket(), testCfg);
  assertSelfTest(
    lowestOddsPlan.selection?.rankSource === "payout",
    `expected payout ranking, got ${lowestOddsPlan.selection?.rankSource}`
  );
  assertArrayEqual(
    lowestOddsPlan.outcomes.map((outcome) => String(outcome.tokenId)),
    ["8", "2", "16", "32", "4"],
    "lowest-odds token selection"
  );
  passed.push("lowest-odds selection uses lowest payout");

  const noOddsPlan = buildDirectBuyAllOutcomesPlan(mockEventMarket({
    address: "0x0000000000000000000000000000000000000043",
    outcomes: tokenOrderOutcomes()
  }), testCfg);
  assertSelfTest(
    noOddsPlan.selection?.rankSource === "token_order",
    `expected token_order fallback, got ${noOddsPlan.selection?.rankSource}`
  );
  assertSelfTest(
    noOddsPlan.selection?.fallbackReason === "missing_complete_odds_data",
    `expected missing odds fallback, got ${noOddsPlan.selection?.fallbackReason}`
  );
  assertArrayEqual(
    noOddsPlan.outcomes.map((outcome) => String(outcome.tokenId)),
    ["1", "2", "4", "8", "16"],
    "token-order fallback selection"
  );
  passed.push("speed fallback selects token order when odds are missing");

  let strictOddsError = "";
  try {
    buildDirectBuyAllOutcomesPlan(mockEventMarket({
      address: "0x0000000000000000000000000000000000000143",
      outcomes: tokenOrderOutcomes()
    }), {
      ...testCfg,
      eventOutcomeSelectionFallback: "error"
    });
  } catch (error) {
    strictOddsError = errorMessage(error);
  }
  assertSelfTest(
    strictOddsError.includes("Cannot select lowest odds"),
    `expected strict odds mode to reject missing odds, got ${strictOddsError || "no error"}`
  );
  passed.push("strict odds mode rejects token-order fallback");

  const lockRuntime = { txLock: { owner: null, since: null } };
  const lockResult = await withRuntimeTransactionLock(lockRuntime, "self-test", async () => {
    assertSelfTest(lockRuntime.txLock.owner === "self-test", "transaction lock owner not set");
    return "ok";
  });
  assertSelfTest(lockResult === "ok" && lockRuntime.txLock.owner === null, "transaction lock did not release");
  lockRuntime.txLock.owner = "buy-single";
  let busyError = "";
  try {
    await withRuntimeTransactionLock(lockRuntime, "auto-sell", async () => "bad");
  } catch (error) {
    busyError = errorMessage(error);
  } finally {
    lockRuntime.txLock.owner = null;
  }
  assertSelfTest(busyError.includes("transaction lock busy"), `expected busy lock error, got ${busyError || "no error"}`);
  pauseRuntimeAutoSell(lockRuntime, testCfg, "self-test-presign");
  assertSelfTest(
    runtimeAutoSellPauseInfo(lockRuntime)?.reason === "self-test-presign",
    "auto-sell pause was not recorded"
  );
  passed.push("transaction lock and auto-sell pause protect hot buy window");

  const sellQuoteCfg = { ...testCfg, dryRun: false, execute: true };
  configureSellMode(sellQuoteCfg, {});
  assertSelfTest(sellQuoteCfg.dryRun && !sellQuoteCfg.execute, "sell quote should force dry-run without --execute");
  const sellExecuteCfg = { ...testCfg, dryRun: true, execute: false };
  configureSellMode(sellExecuteCfg, { execute: true });
  assertSelfTest(!sellExecuteCfg.dryRun && sellExecuteCfg.execute, "sell execute should require explicit --execute");
  passed.push("manual sell quote cannot inherit execute mode");

  const stopLossTrigger = resolveAutoSellTrigger(testCfg, { profitMultiple: 0.899, lossPercent: 10.1 });
  assertSelfTest(
    stopLossTrigger?.type === "stop_loss" && stopLossTrigger.sellPercent === 100,
    `expected 10% loss to sell 100%, got ${JSON.stringify(stopLossTrigger)}`
  );
  const takeProfitTrigger = resolveAutoSellTrigger(testCfg, { profitMultiple: 2.01, lossPercent: 0 });
  assertSelfTest(
    !takeProfitTrigger,
    `2x take-profit should be disabled, got ${JSON.stringify(takeProfitTrigger)}`
  );
  const noAutoSellTrigger = resolveAutoSellTrigger(testCfg, { profitMultiple: 1.1, lossPercent: 9.9 });
  assertSelfTest(!noAutoSellTrigger, `expected no auto-sell trigger, got ${JSON.stringify(noAutoSellTrigger)}`);
  passed.push("auto-sell disables take-profit and keeps 10% stop-loss");

  const hotRuntime = {
    pendingBuyRecords: new Map([
      ["hot", { market: mockEventMarket({ startDate: new Date(Date.now() + 30000).toISOString() }) }]
    ])
  };
  assertSelfTest(
    runtimeBuyHotWindowInfo(testCfg, hotRuntime)?.reason === "buy-hot-window",
    "auto-sell should detect the buy hot window before open"
  );
  const coldRuntime = {
    pendingBuyRecords: new Map([
      ["cold", { market: mockEventMarket({ startDate: new Date(Date.now() + 10 * 60000).toISOString() }) }]
    ])
  };
  assertSelfTest(!runtimeBuyHotWindowInfo(testCfg, coldRuntime), "auto-sell should not block far-future openings");
  const sampleSellEntries = Array.from({ length: 14 }, (_, index) => ({
    item: {
      plan: { market: `0x${String(index % 7).padStart(40, "0")}` },
      marketAddress: `0x${String(index % 7).padStart(40, "0")}`
    },
    action: {}
  }));
  const sellChunks = chunkAutoSellItems(testCfg, sampleSellEntries);
  assertSelfTest(
    sellChunks.length > 1 &&
      sellChunks.every((chunk) =>
        chunk.length <= testCfg.autoSellMaxOutcomesPerTx &&
        new Set(chunk.map((entry) => String(entry.item.plan.market).toLowerCase())).size <= testCfg.autoSellMaxMarketsPerTx &&
        estimateAutoSellBatchGas(chunk.length) <= testCfg.autoSellMaxGasPerTx
    ),
    `auto-sell should chunk 14 outcomes into capped batches, got ${sellChunks.map((chunk) => chunk.length).join(",")}`
  );
  assertSelfTest(
    isSuccessfulBuyFill({ result: { dryRun: false, status: "broadcast" }, plan: { market: { address: "0x0000000000000000000000000000000000000001" } } }),
    "broadcast buy fills should make positions eligible for auto-sell monitoring"
  );
  const tailTestId = `${Date.now()}-${process.pid}`;
  const tailFillsFile = path.join(os.tmpdir(), `42space-tail-fills-${tailTestId}.jsonl`);
  const tailPositionStateFile = path.join(os.tmpdir(), `42space-tail-positions-${tailTestId}.json`);
  try {
    const tailRows = [
      { id: "old", at: "2030-01-01T00:00:00.000Z", pad: "x".repeat(2048) },
      {
        id: "buy",
        at: "2030-01-01T00:00:01.000Z",
        result: { dryRun: false, status: "broadcast" },
        plan: { market: { address: "0x0000000000000000000000000000000000000011" } }
      },
      {
        id: "receipt",
        at: "2030-01-01T00:00:02.000Z",
        level: "event-receipt",
        status: "success",
        context: { market: "0x0000000000000000000000000000000000000012" }
      }
    ];
    fs.writeFileSync(tailFillsFile, `${tailRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    saveAutoSellPositionState(tailPositionStateFile, {
      positions: {
        "wallet:market:token": {
          marketAddress: "0x0000000000000000000000000000000000000013",
          tokenId: "1",
          buyAt: "2030-01-01T00:00:03.000Z"
        }
      }
    });
    const tailEligibleMarkets = loadAutoSellEligibleMarkets({
      ...testCfg,
      fillsFile: tailFillsFile,
      autoSellPositionStateFile: tailPositionStateFile,
      autoSellEligibleTailBytes: 700
    });
    assertSelfTest(!tailEligibleMarkets.has("0x0000000000000000000000000000000000000010"), "tail reader should not parse stale prefix rows");
    assertSelfTest(tailEligibleMarkets.has("0x0000000000000000000000000000000000000011"), "tail reader should retain broadcast buy fills");
    assertSelfTest(tailEligibleMarkets.has("0x0000000000000000000000000000000000000012"), "tail reader should retain receipt buy fills");
    assertSelfTest(tailEligibleMarkets.has("0x0000000000000000000000000000000000000013"), "position state should keep auto-sell eligibility when fills are tailed");
  } finally {
    fs.rmSync(tailFillsFile, { force: true });
    fs.rmSync(tailPositionStateFile, { force: true });
    fs.rmSync(`${tailPositionStateFile}.bak`, { force: true });
  }
  passed.push("auto-sell buy guard, chunking, and tailed broadcast eligibility are enforced");

  const noisyAutoSellError = autoSellErrorMessage(
    { ...testCfg, autoSellErrorMessageMaxChars: 160 },
    { message: `execution reverted data: 0x${"a".repeat(512)} Request Arguments: calldata=0x${"b".repeat(512)}` }
  );
  assertSelfTest(noisyAutoSellError.length < 220, `auto-sell error should be compact, got ${noisyAutoSellError.length} chars`);
  assertSelfTest(!noisyAutoSellError.includes("a".repeat(96)), "auto-sell error should truncate long hex calldata");

  const circuitState = defaultAutoSellCircuitState();
  const circuitNow = Date.parse("2030-01-01T00:00:00.000Z");
  const firstFailure = recordAutoSellFailure(testCfg, circuitState, {
    keys: ["wallet:market:token"],
    status: "receipt-reverted",
    message: "receipt reverted",
    now: circuitNow,
    countGlobal: true
  });
  assertSelfTest(!firstFailure.opened, "first auto-sell failure should not open the circuit");
  const secondFailure = recordAutoSellFailure(testCfg, circuitState, {
    keys: ["wallet:market:token"],
    status: "receipt-reverted",
    message: "receipt reverted again",
    now: circuitNow + 1000,
    countGlobal: true
  });
  assertSelfTest(secondFailure.opened, "second auto-sell failure should open the circuit");
  assertSelfTest(
    autoSellCircuitPauseInfo(circuitState, circuitNow + 1000)?.reason === "consecutive-auto-sell-failures",
    "auto-sell circuit pause reason should be recorded"
  );
  assertSelfTest(
    autoSellFailureCooldownInfo(circuitState, "wallet:market:token", circuitNow + 1000)?.consecutiveFailures === 2,
    "auto-sell position failure cooldown should be recorded"
  );
  recordAutoSellSuccess(circuitState, ["wallet:market:token"]);
  assertSelfTest(!circuitState.failures["wallet:market:token"], "auto-sell success should clear per-position failure state");
  passed.push("auto-sell circuit breaker, cooldown, and error compaction are enforced");

  assertSelfTest(
    formatUnits(roundDownSellAmount(parseUnits("108.884", 18)), 18) === "108.88",
    "auto-sell amount should round down to the 0.01 outcome-token curve tick"
  );
  assertSelfTest(
    roundDownSellAmount(parseUnits("0.009", 18)) === 0n,
    "sub-tick auto-sell amount should not be sent"
  );
  passed.push("sell amounts are normalized to the market curve tick");

  assertSelfTest(
    effectivePrebroadcastMs({ ...testCfg, prebroadcastMs: 750, allowPreopenBroadcast: false }) === 0,
    "pre-open broadcast must be disabled unless explicitly allowed"
  );
  assertSelfTest(
    effectivePrebroadcastMs({ ...testCfg, prebroadcastMs: 750, allowPreopenBroadcast: true }) === 750,
    "pre-open broadcast explicit opt-in should preserve configured lead time"
  );
  const fixedStart = "2030-01-01T00:00:00.000Z";
  const fixedStartMs = Date.parse(fixedStart);
  assertSelfTest(
    marketActionTimeMs({ startDate: fixedStart }, { ...testCfg, allowPreopenBroadcast: false, openBroadcastDelayMs: 25 }) === fixedStartMs + 25,
    "post-open action time should be start plus configured delay"
  );
  assertSelfTest(
    marketActionTimeMs({ startDate: fixedStart }, { ...testCfg, allowPreopenBroadcast: true, prebroadcastMs: 750, openBroadcastDelayMs: 25 }) === fixedStartMs - 750,
    "explicit pre-open action time should ignore post-open delay"
  );
  assertSelfTest(
    isTerminalMinedFailure({ usedPreSignedTransaction: true, status: "reverted", blockNumber: "100" }),
    "mined reverted pre-signed tx should be treated as terminal"
  );
  assertSelfTest(
    !isTerminalMinedFailure({ usedPreSignedTransaction: true, status: "broadcast", blockNumber: null }),
    "broadcast-only tx should not be treated as terminal"
  );
  assertSelfTest(
    executionMarksSeen({ status: "broadcast" }),
    "RPC-accepted broadcast should be treated as submitted"
  );
  passed.push("pre-open broadcast is opt-in after boundary-block revert");

  const staleManualMarket = mockEventMarket({
    startDate: new Date(Date.now() - (testCfg.eventOpenWindowSeconds * 1000 + 1000)).toISOString()
  });
  let manualBuyWindowError = "";
  try {
    assertPlanWithinOpenWindow(testCfg, staleManualMarket, "self-test-buy");
  } catch (error) {
    manualBuyWindowError = errorMessage(error);
  }
  assertSelfTest(
    manualBuyWindowError.includes("Refusing self-test-buy"),
    `manual buy should reject markets past open window, got ${manualBuyWindowError || "no error"}`
  );
  assertPlanWithinOpenWindow({ ...testCfg, allowLateBuy: true }, staleManualMarket, "self-test-late-buy");
  passed.push("manual buy path enforces the open-window deadline");

  const nineOutcomeGasReserve = calculateFastGasReserve(
    { ...testCfg, fastGasLimit: 8000000, gasPriceGwei: "3" },
    { nextBatchOutcomeCount: 9 }
  );
  assertSelfTest(
    BigInt(nineOutcomeGasReserve.gasLimit) >= 7000000n,
    `9-outcome first-buy fast gas limit too low: ${nineOutcomeGasReserve.gasLimit}`
  );
  const bundleGasReserve = calculateFastGasReserve(
    { ...testCfg, fastGasLimit: 8000000, bundleFastGasLimit: 20000000, bundleDueMarkets: true, gasPriceGwei: "3" },
    { nextBatchMarketCount: 3, nextBatchOutcomeCount: 15 }
  );
  assertSelfTest(
    BigInt(bundleGasReserve.gasLimit) >= 11700000n,
    `15-outcome bundle fast gas limit too low: ${bundleGasReserve.gasLimit}`
  );
  const walletBudgetGasLimit = resolveWalletBudgetGasLimit(
    {
      ...testCfg,
      fastGasWalletBudget: true,
      fastGasWalletBudgetBps: 10000,
      fastGasBlockLimitBps: 10000,
      fastGasTxLimit: 16777216
    },
    {
      desiredGasLimit: 7000000n,
      walletBalance: 37_000_000_000_000_000n,
      gasPrice: 2_000_000_000n,
      blockGasLimit: 140_000_000n
    }
  );
  assertSelfTest(
    walletBudgetGasLimit === 16_777_216n,
    `wallet-budget gas limit should cap to BSC tx max, got ${walletBudgetGasLimit}`
  );
  const fixedGasLimit = resolveWalletBudgetGasLimit(
    { ...testCfg, fastGasWalletBudget: false, fastGasTxLimit: 16777216 },
    { desiredGasLimit: 20_000_000n }
  );
  assertSelfTest(
    fixedGasLimit === 16_777_216n,
    `fixed fast gas limit should cap to BSC tx max, got ${fixedGasLimit}`
  );
  passed.push("fast gas limit uses wallet BNB budget capped by BSC tx max");

  const priceMarkets = filterEventMarkets([mockEventMarket({
    address: "0x0000000000000000000000000000000000000044",
    question: "BTC price range - 8 Hours",
    curve: "0x495B31876c092c236d1b0Df5Cc953D45d41301F1",
    categories: ["Price"],
    tags: ["8 hour"]
  })], testCfg);
  assertSelfTest(priceMarkets.length === 0, "Price market filter should exclude BTC price range markets");
  const priceTagDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000000244",
    question: "Tagged price market",
    categories: ["Crypto"],
    tags: ["Price"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 72 * 3600000).toISOString()
  }), {
    ...testCfg,
    minEventDurationHours: 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: ["Price"]
  });
  assertSelfTest(
    !priceTagDecision.eligible && priceTagDecision.reason === "price-market",
    `Price-tagged market should be excluded as Price, got ${JSON.stringify(priceTagDecision)}`
  );
  const priceOnlyRuntimeConfig = normalizeRuntimeConfig({
    filterMode: "price_only_test",
    eventOutcomeCount: 2,
    stakePerOutcomeUsdt: 1,
    maxMarketStakeUsdt: 2,
    maxBatchStakeUsdt: 20,
    minEventDurationHours: 0,
    gasPriceGwei: "0.15",
    autoSellEnabled: true,
    autoSellStartDelaySeconds: 10,
    autoSellIntervalSeconds: 10,
    autoSellChunkPercent: 10,
    autoSellStopLossEnabled: true,
    autoSellStopLossPercent: 10,
    autoSellStopLossSellPercent: 100
  });
  assertSelfTest(
    priceOnlyRuntimeConfig.marketTagBlocklist?.includes("Price"),
    `price_only_test runtime config should block Price tags, got ${JSON.stringify(priceOnlyRuntimeConfig.marketTagBlocklist)}`
  );
  passed.push("Price category/tag markets are excluded from Event Market bot");

  const defaultFollowMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000000344",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 72 * 3600000).toISOString()
  });
  const blockedFollowDecision = getEventMarketDecision(defaultFollowMarket, {
    ...testCfg,
    marketFollowState: {
      followed: {},
      blocked: {
        "0x0000000000000000000000000000000000000344": {
          market: "0x0000000000000000000000000000000000000344",
          title: "Blocked follow market"
        }
      }
    }
  });
  assertSelfTest(
    !blockedFollowDecision.eligible && blockedFollowDecision.reason === "follow-blocked",
    `Cancelled follow should block default buy, got ${JSON.stringify(blockedFollowDecision)}`
  );

  const manualShortDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000000345",
    question: "Manual short event",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), {
    ...testCfg,
    marketFollowState: {
      followed: {
        "0x0000000000000000000000000000000000000345": {
          market: "0x0000000000000000000000000000000000000345",
          title: "Manual short event"
        }
      },
      blocked: {}
    }
  });
  assertSelfTest(
    manualShortDecision.eligible && manualShortDecision.reason === "manual-followed",
    `Manual follow should allow an otherwise filtered strategy market, got ${JSON.stringify(manualShortDecision)}`
  );
  passed.push("Market follow state can allow or block auto-buy decisions");

  const longEventMarkets = filterEventMarkets([mockEventMarket({
    address: "0x0000000000000000000000000000000000000045",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 49 * 3600000).toISOString()
  })], testCfg);
  assertSelfTest(longEventMarkets.length === 1, "48h+ Event Market should pass duration filter");
  passed.push("48h+ Event Markets pass duration filter");

  const shortEventMarkets = filterEventMarkets([mockEventMarket({
    address: "0x0000000000000000000000000000000000000046",
    question: "Which outcome will have the 2nd highest mCap, May 28th?",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  })], testCfg);
  assertSelfTest(shortEventMarkets.length === 0, "24h Event Market should fail duration filter");
  passed.push("short Event Markets are excluded by duration filter");

  const dailyVolumeMarkets = filterEventMarkets([mockEventMarket({
    address: "0x0000000000000000000000000000000000000146",
    question: "BNB/USDT Futures Daily Volume, May 27th?",
    categories: ["Crypto"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  })], testCfg);
  assertSelfTest(dailyVolumeMarkets.length === 0, "Daily futures volume template should fail duration filter");
  passed.push("daily futures volume template is excluded by duration filter");

  const openRouterDailyMarkets = filterEventMarkets([mockEventMarket({
    address: "0x0000000000000000000000000000000000000147",
    question: "Total Daily Token Usage by OpenClaw via OpenRouter on May 27th?",
    categories: ["AI"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  })], testCfg);
  assertSelfTest(openRouterDailyMarkets.length === 0, "OpenRouter daily usage template should fail duration filter");
  passed.push("OpenRouter daily usage template is excluded by duration filter");

  const missingEndMarkets = filterEventMarkets([mockEventMarket({
    address: "0x0000000000000000000000000000000000000047",
    endDate: null
  })], testCfg);
  assertSelfTest(missingEndMarkets.length === 0, "Missing endDate should fail duration filter");
  passed.push("missing endDate is excluded by duration filter");

  const restState = createRestDiscoveryState();
  const restSeedMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000000148",
    question: "Seeded short market",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  });
  const restNewFilteredMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000000149",
    question: "New short market",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  });
  rememberRestDiscoveryMarkets(restState, [restSeedMarket]);
  assertSelfTest(
    restState.knownMarketKeys.has(restDiscoveryMarketKey(restSeedMarket)),
    "REST raw discovery should remember seed markets"
  );
  assertSelfTest(
    !restState.knownMarketKeys.has(restDiscoveryMarketKey(restNewFilteredMarket)) &&
      !marketFilterDecision(restNewFilteredMarket, testCfg).eligible,
    "REST raw discovery should still notice newly filtered markets"
  );
  passed.push("REST raw discovery tracks filtered markets after seed");

  assertSelfTest(
    routerApprovalRequiredUsdt(testCfg) === 100,
    `expected router approval threshold 100, got ${routerApprovalRequiredUsdt(testCfg)}`
  );
  passed.push("startup router approval threshold covers batch cap");

  const sameStart = new Date(Date.now() + 60000).toISOString();
  const affordability = selectAffordableRecords(testCfg, [
    { market: mockEventMarket({ question: "6 day event", startDate: sameStart, endDate: new Date(Date.now() + 6 * 86400000).toISOString() }) },
    { market: mockEventMarket({ question: "10 day event", startDate: sameStart, endDate: new Date(Date.now() + 10 * 86400000).toISOString() }) },
    { market: mockEventMarket({ question: "8 day event", startDate: sameStart, endDate: new Date(Date.now() + 8 * 86400000).toISOString() }) }
  ], {
    busdtBalance: "55",
    busdtAllowanceToRouter: "1000"
  });
  assertSelfTest(affordability.selected.length === 2, `expected 2 affordable records, got ${affordability.selected.length}`);
  assertArrayEqual(
    affordability.selected.map((record) => pendingMarket(record).question),
    ["10 day event", "8 day event"],
    "same-start affordability priority"
  );
  passed.push("partial funding buys highest-priority complete markets first");

  const preSignedBundleTx = { txHash: "0xpresigned", nonce: 1000 };
  const originalBundle = {
    markets: [
      { address: "0x0000000000000000000000000000000000000051" },
      { address: "0x0000000000000000000000000000000000000052" }
    ],
    preSignedFastBundleTransaction: preSignedBundleTx
  };
  const preSignedRecordA = {
    market: mockEventMarket({ address: "0x0000000000000000000000000000000000000051" }),
    preSignedFastBundleTransaction: preSignedBundleTx,
    preSignedFastBundle: originalBundle
  };
  const preSignedRecordB = {
    market: mockEventMarket({ address: "0x0000000000000000000000000000000000000052" }),
    preSignedFastBundleTransaction: preSignedBundleTx,
    preSignedFastBundle: originalBundle
  };
  const changedRecord = {
    market: mockEventMarket({ address: "0x0000000000000000000000000000000000000053" }),
    preSignedFastBundleTransaction: preSignedBundleTx,
    preSignedFastBundle: originalBundle
  };
  assertSelfTest(reusablePreSignedBundle([preSignedRecordA, preSignedRecordB]), "matching pre-signed bundle should be reusable");
  assertSelfTest(!reusablePreSignedBundle([preSignedRecordA, changedRecord]), "changed pre-signed bundle should not be reusable");
  assertSelfTest(
    groupPreSignedBundleRecords([preSignedRecordA, preSignedRecordB]).length === 1,
    "due path should isolate reusable pre-signed bundle records"
  );
  passed.push("stale pre-signed bundles are not reused after market set changes");

  const feishuAlert = buildFeishuAlertView({
    title: "[42space-2] 买入已广播",
    fields: {
      type: "single",
      market: "0x0000000000000000000000000000000000000054",
      question: "Self test Event Market",
      status: "broadcast",
      stake: "25U",
      rankSource: "token_order",
      fallback: "missing_complete_odds_data",
      tx: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    }
  });
  const feishuText = formatFeishuAlertText(feishuAlert);
  assertSelfTest(feishuText.includes("状态：已发出"), "Feishu buy alert should show a readable status");
  assertSelfTest(feishuText.includes("事件：Self test Event Market"), "Feishu buy alert should show the market title");
  assertSelfTest(feishuText.includes("选择："), "Feishu buy alert should keep diagnostics as a Chinese note");
  assertSelfTest(!feishuText.includes("rankSource"), "Feishu buy alert should not expose rankSource");
  assertSelfTest(!feishuText.includes("fallback:"), "Feishu buy alert should not expose fallback as a raw field");
  assertSelfTest(!feishuText.includes("type:"), "Feishu buy alert should not expose type as a raw field");
  assertSelfTest(
    buildFeishuCardPayload(feishuAlert).msg_type === "interactive",
    "Feishu primary alert payload should be an interactive card"
  );
  assertSelfTest(
    buildFeishuTextPayload(feishuAlert).content.text.includes("状态：已发出"),
    "Feishu text fallback should stay readable"
  );
  passed.push("Feishu alerts render as operator cards with clean text fallback");

  const fundingFeishuAlert = buildFeishuAlertView({
    title: "[42space-2] 资金不足，等待补款",
    level: "warn",
    fields: {
      shortfall: "BUSDT 差 1U / BNB 差 0.001",
      nextStart: "2030-01-01T00:30:00.000Z",
      msUntilNextStart: 1800000,
      retryMs: 1000,
      requiredBusdt: 2,
      wallet: "0x0000000000000000000000000000000000000055",
      action: "补资金后自动恢复"
    }
  });
  const fundingFeishuText = formatFeishuAlertText(fundingFeishuAlert);
  assertSelfTest(fundingFeishuText.includes("状态：暂不会买入"), "funding alert should show operator state");
  assertSelfTest(fundingFeishuText.includes("缺口：BUSDT 差 1U"), "funding alert should show funding gap");
  assertSelfTest(fundingFeishuText.includes("处理：补资金后自动恢复"), "funding alert should show next action");
  assertSelfTest(!fundingFeishuText.includes("retryMs"), "funding alert should not expose retryMs");
  assertSelfTest(!fundingFeishuText.includes("requiredBusdt"), "funding alert should not expose requiredBusdt");
  assertSelfTest(!fundingFeishuText.includes("wallet"), "funding alert should not expose wallet as a raw field");
  assertSelfTest(!fundingFeishuText.includes("Watch preflight failed"), "funding alert should not expose raw preflight text");
  assertSelfTest(!fundingFeishuText.includes("重试"), "funding alert should not expose retry timing");

  const farFundingStatus = { funding: { nextBatchStartDate: new Date(Date.now() + 31 * 60 * 1000).toISOString() } };
  const nearFundingStatus = { funding: { nextBatchStartDate: new Date(Date.now() + 29 * 60 * 1000).toISOString() } };
  assertSelfTest(!shouldNotifyFundingWait(farFundingStatus), "far low-funds state should stay in logs/dashboard only");
  assertSelfTest(shouldNotifyFundingWait(nearFundingStatus), "near-opening low-funds state should notify Feishu");

  const alertStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-alert-state-test-"));
  try {
    const alertCfg = { ...testCfg, alertStateFile: path.join(alertStateDir, "alert-state.json") };
    const alertKey = `self-test-alert-${Date.now()}`;
    assertSelfTest(
      shouldSendFeishuAlert(alertCfg, { dedupeKey: alertKey, fingerprint: "same", title: "测试告警" }),
      "first fingerprint alert should send"
    );
    assertSelfTest(
      !shouldSendFeishuAlert(alertCfg, { dedupeKey: alertKey, fingerprint: "same", title: "测试告警" }),
      "same fingerprint alert should be suppressed"
    );
    assertSelfTest(
      shouldSendFeishuAlert(alertCfg, { dedupeKey: alertKey, fingerprint: "changed", title: "测试告警" }),
      "changed fingerprint alert should send"
    );
  } finally {
    fs.rmSync(alertStateDir, { recursive: true, force: true });
  }
  passed.push("Feishu funding cards are concise and state-change dedupe is persistent");

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-self-test-"));
  try {
    const stateFile = path.join(stateDir, "seen.json");
    saveSeen(stateFile, new Set(["market-a", "market-b"]));
    assertSelfTest(loadSeen(stateFile).has("market-a"), "saved seen file should load");
    saveSeen(stateFile, new Set(["market-c"]));
    fs.writeFileSync(stateFile, "{ broken json", { mode: 0o600 });
    const recovered = loadSeen(stateFile);
    assertSelfTest(
      recovered.has("market-a") && recovered.has("market-b"),
      "corrupt seen file should recover from backup"
    );
    passed.push("seen state write is atomic and backup-recoverable");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    level: "event-self-test",
    passed: passed.length,
    checks: passed,
    at: new Date().toISOString()
  }, null, 2));
}

function mockEventMarket(overrides = {}) {
  const now = Date.now();
  return {
    address: "0x0000000000000000000000000000000000000042",
    question: "Self test Event Market",
    status: "live",
    createdAt: new Date(now).toISOString(),
    startDate: new Date(now + 60000).toISOString(),
    endDate: new Date(now + 3600000).toISOString(),
    contractVersion: 2,
    collateral: "0x55d398326f99059fF775485246999027B3197955",
    parentTokenId: "0",
    curve: "0xDC26047458FEa8Bd45164217CCb7eE90b9bE10B8",
    categories: ["Crypto"],
    tags: ["Normal"],
    outcomes: [
      { tokenId: "1", name: "A", payout: 6, price: 0.1667 },
      { tokenId: "2", name: "B", payout: 2, price: 0.5 },
      { tokenId: "4", name: "C", payout: 5, price: 0.2 },
      { tokenId: "8", name: "D", payout: 1, price: 1 },
      { tokenId: "16", name: "E", payout: 3, price: 0.3333 },
      { tokenId: "32", name: "F", payout: 4, price: 0.25 }
    ],
    ...overrides
  };
}

function tokenOrderOutcomes() {
  return [
    { tokenId: "1", name: "A" },
    { tokenId: "2", name: "B" },
    { tokenId: "4", name: "C" },
    { tokenId: "8", name: "D" },
    { tokenId: "16", name: "E" },
    { tokenId: "32", name: "F" }
  ];
}

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}

function assertArrayEqual(actual, expected, label) {
  const same = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  if (!same) {
    throw new Error(`Self-test failed: ${label}; expected ${expected.join(",")}, got ${actual.join(",")}`);
  }
}

async function buildPresignTestRecords(cfg, args) {
  const chain = await loadChainEventMarkets(cfg, args);
  let discoverySource = "chain";
  let futureMarkets = chain.eventMarkets
    .filter((market) => msUntilStart(market) > 0)
    .sort(compareStartAsc);
  let restEventMarkets = [];
  if (futureMarkets.length === 0 || args.source === "rest") {
    restEventMarkets = await loadRestEventMarkets(cfg, { status: "all", limit: cfg.watchScanLimit });
    const restFutureMarkets = restEventMarkets
      .filter((market) => msUntilStart(market) > 0)
      .sort(compareStartAsc);
    if (restFutureMarkets.length > 0) {
      discoverySource = "rest";
      futureMarkets = restFutureMarkets;
    }
  }
  chain.discoverySource = discoverySource;
  chain.restEventMarkets = restEventMarkets.length;
  const startDate = args.startDate ?? futureMarkets[0]?.startDate;
  if (!startDate) throw new Error("No future Event Market found for pre-sign test");
  const startMs = new Date(startDate).getTime();
  const testCfg = {
    ...cfg,
    privateKey: PUBLIC_TEST_PRIVATE_KEY,
    dryRun: false,
    execute: true,
    riskAck: "YES",
    eligibilityAck: "YES",
    eventBuyMode: "fast",
    preSignFastTx: true,
    fastGasWalletBudget: false
  };
  const sameStartBatch = futureMarkets.filter((market) => new Date(market.startDate).getTime() === startMs);
  const batch = selectBatchWithinStakeCap(sameStartBatch, testCfg);
  if (batch.length === 0) {
    throw new Error(
      `No same-start Event Market fits MAX_BATCH_STAKE_USDT ${testCfg.maxBatchStakeUsdt} for pre-sign test at ${startDate}`
    );
  }
  const runtime = { receiverAddress: PUBLIC_TEST_RECEIVER, nextNonce: 1000 };
  const records = await Promise.all(batch.map((market) => preparePendingRecord(testCfg, market, runtime)));
  const prepareErrors = records.filter((record) => record.prepareError).map((record) => ({
    market: pendingMarket(record).address,
    error: record.prepareError
  }));
  if (prepareErrors.length > 0) {
    throw new Error(`Pre-sign test prepare failed: ${JSON.stringify(prepareErrors)}`);
  }
  return { chain, batch, startDate, testCfg, runtime, records };
}

function selectBatchWithinStakeCap(markets, cfg) {
  let remaining = cfg.maxBatchStakeUsdt;
  const selected = [];
  for (const market of sortMarketsByStartAsc(markets)) {
    const stake = selectedStakeUsdt(market, cfg);
    if (stake <= 0 || stake > remaining) continue;
    selected.push(market);
    remaining = roundUsd(remaining - stake);
  }
  return selected;
}

async function buy(cfg, args) {
  const eventPlan = await buildEventPlan(cfg, args);
  const result = await executeOrPrint(eventPlan, cfg, null);
  appendJsonl(cfg.fillsFile, {
    plan: describeEventPlan(eventPlan),
    result,
    at: new Date().toISOString()
  });
}

async function minimal(cfg, args) {
  cfg.stakePerOutcomeUsdt = Number(args.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  cfg.eventBuyMode = "fast";
  cfg.fastSkipPreflight = false;
  cfg.waitForReceipt = true;
  cfg.dryRun = true;
  cfg.execute = false;

  if (!cfg.privateKey) {
    cfg.privateKey = await promptHidden("PRIVATE_KEY (hidden): ");
  }
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is required");

  const eventPlan = await buildEventPlan(cfg, args);
  const status = await getWalletStatus(cfg);
  const described = describeEventPlan(eventPlan);
  console.log(JSON.stringify({
    level: "minimal-preview",
    wallet: {
      address: status.address,
      bnbBalance: status.bnbBalance,
      busdtBalance: status.busdtBalance,
      busdtAllowanceToRouter: status.busdtAllowanceToRouter
    },
    plan: described
  }, null, 2));

  await requireExactConfirmation(
    `Type BUY ELIGIBLE to approve if needed and buy ${eventPlan.outcomes.length} selected outcomes in "${eventPlan.market.question}" for ${eventPlan.stakePerOutcomeUsdt}U each, total ${eventPlan.totalStakeUsdt}U, and confirm you are not in a 42 restricted jurisdiction: `,
    "确认买入"
  );

  cfg.dryRun = false;
  cfg.execute = true;
  cfg.riskAck = "YES";
  cfg.eligibilityAck = "YES";

  const approval = await approveRouterMax(cfg, { requiredUsdt: eventPlan.totalStakeUsdt });
  console.log(JSON.stringify({ level: "minimal-approval", approval }, null, 2));

  const runtime = await createRuntime(cfg);
  const result = await withRuntimeTransactionLock(
    runtime,
    "buy-single",
    () => buyOutcomesBatch(cfg, eventPlan, runtime)
  );
  appendJsonl(cfg.fillsFile, {
    plan: described,
    result,
    at: new Date().toISOString()
  });
  console.log(JSON.stringify({ level: "minimal-executed", plan: described, result }, null, 2));
}

async function arm(cfg, args) {
  cfg.stakePerOutcomeUsdt = Number(args.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  cfg.eventBuyMode = "fast";
  cfg.dryRun = false;
  cfg.execute = true;
  cfg.riskAck = "YES";
  cfg.eligibilityAck = "YES";
  cfg.fastSkipPreflight = true;

  if (!cfg.privateKey) {
    cfg.privateKey = await promptHidden("PRIVATE_KEY for long-running event:watch (hidden): ");
  }
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is required for event:arm");

  console.log(JSON.stringify({
    level: "event-arm",
    mode: "execute",
    eventDiscovery: cfg.eventDiscovery,
    wsProvider: wsProviderLabel(cfg.wsUrl),
    eventBuyMode: cfg.eventBuyMode,
    restDiscoveryEnabled: cfg.restDiscoveryEnabled,
    restDiscoveryPollMs: cfg.restDiscoveryPollMs,
    stakePerOutcomeUsdt: cfg.stakePerOutcomeUsdt,
    eventOutcomeSelection: cfg.eventOutcomeSelection,
    eventOutcomeCount: cfg.eventOutcomeCount,
    eventOutcomeSelectionFallback: cfg.eventOutcomeSelectionFallback,
    maxOutcomesPerMarket: cfg.maxOutcomesPerMarket,
    maxMarketStakeUsdt: cfg.maxMarketStakeUsdt,
    maxBatchStakeUsdt: cfg.maxBatchStakeUsdt,
    fastSkipPreflight: cfg.fastSkipPreflight,
    fastSkipDueRestHydration: cfg.fastSkipDueRestHydration,
    waitForReceipt: cfg.waitForReceipt,
    fanoutBroadcast: cfg.fanoutBroadcast,
    broadcastRpcCount: cfg.broadcastRpcUrls.length,
    executionRetryMs: cfg.executionRetryMs,
    eventOpenWindowSeconds: cfg.eventOpenWindowSeconds,
    preSignFastTx: cfg.preSignFastTx,
    preSignWindowMs: cfg.preSignWindowMs,
    preSignRetryMs: cfg.preSignRetryMs,
    allowPreopenBroadcast: cfg.allowPreopenBroadcast,
    prebroadcastMs: cfg.prebroadcastMs,
    openBroadcastDelayMs: cfg.openBroadcastDelayMs,
    openBroadcastScheduleAheadMs: cfg.openBroadcastScheduleAheadMs,
    openBroadcastSpinMs: cfg.openBroadcastSpinMs,
    armWaitForFunding: cfg.armWaitForFunding,
    armFundingRetryMs: cfg.armFundingRetryMs,
    armFundingHotRetryMs: cfg.armFundingHotRetryMs,
    armFundingHotWindowMs: cfg.armFundingHotWindowMs,
    armCatchUpAfterFunding: cfg.armCatchUpAfterFunding,
    armCatchUpWindowMs: cfg.armCatchUpWindowMs,
    autoApproveRouterOnStart: cfg.autoApproveRouterOnStart,
    autoSellEnabled: cfg.autoSellEnabled,
    autoSellStrategy: cfg.autoSellStrategy,
    autoSellStartDelaySeconds: cfg.autoSellStartDelaySeconds,
    autoSellIntervalSeconds: cfg.autoSellIntervalSeconds,
    autoSellChunkPercent: cfg.autoSellChunkPercent,
    autoSellApplyAfterIso: cfg.autoSellApplyAfterIso,
    autoSellStopLossEnabled: cfg.autoSellStopLossEnabled,
    autoSellStopLossPercent: cfg.autoSellStopLossPercent,
    autoSellStopLossSellPercent: cfg.autoSellStopLossSellPercent,
    autoSellPollMs: cfg.autoSellPollMs,
    autoSellBuyGuardBeforeMs: cfg.autoSellBuyGuardBeforeMs,
    autoSellBuyGuardAfterMs: cfg.autoSellBuyGuardAfterMs,
    autoSellPreapproveOperator: cfg.autoSellPreapproveOperator,
    autoSellRequirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator,
    autoSellMaxOutcomesPerTx: cfg.autoSellMaxOutcomesPerTx,
    autoSellMaxMarketsPerTx: cfg.autoSellMaxMarketsPerTx,
    autoSellMaxGasPerTx: cfg.autoSellMaxGasPerTx,
    autoSellMaxTxPerTick: cfg.autoSellMaxTxPerTick,
    note: "private key is held only in this process; it is not written to disk"
  }, null, 2));

  let fundingRecovery = null;
  if (cfg.armWaitForFunding) {
    const waitingSince = Date.now();
    const fundingStatus = await waitForWatchFunding(cfg);
    fundingRecovery = {
      enabled: cfg.armCatchUpAfterFunding,
      waitingSince,
      fundingReadyAt: Date.now(),
      fundingStatus
    };
  }

  notifyFeishu(cfg, {
    title: "bot 已启动",
    fields: {
      mode: "execute",
      discovery: cfg.eventDiscovery,
      stake: `${cfg.eventOutcomeCount}档 / ${cfg.stakePerOutcomeUsdt}U`,
      autoSell: autoSellSummaryText(cfg)
    },
    dedupeKey: "bot-start",
    cooldownMs: cfg.feishuAlertCooldownMs
  });

  await watch(cfg, { fundingRecovery });
}

async function preflight(cfg) {
  const { publicClient } = makeClients(cfg);
  const status = await getWalletStatus(cfg);
  const chain = await loadChainEventMarkets(cfg, { lookbackBlocks: cfg.eventLogLookbackBlocks });
  const funding = computeFundingRequirement(cfg, chain.eventMarkets);
  const gasReserve = await estimateFastGasReserve(publicClient, cfg, funding);
  console.log(
    JSON.stringify(
      {
        level: "wallet-preflight",
        status,
        funding,
        gasReserve,
        allowanceReady: Number(status.busdtAllowanceToRouter) >= funding.requiredBusdt,
        balanceReady: Number(status.busdtBalance) >= funding.requiredBusdt,
        bnbReady: Number(status.bnbBalance) >= Number(gasReserve.requiredBnb),
        allowanceReadyForUpperBound: Number(status.busdtAllowanceToRouter) >= funding.upperBoundRequiredBusdt,
        balanceReadyForUpperBound: Number(status.busdtBalance) >= funding.upperBoundRequiredBusdt
      },
      null,
      2
    )
  );
}

async function approve(cfg) {
  const result = await approveRouterMax(cfg, { requiredUsdt: routerApprovalRequiredUsdt(cfg) });
  console.log(JSON.stringify({ level: "router-approval", result }, null, 2));
}

async function doctor(cfg, args = {}) {
  const { publicClient, account } = makeClients(cfg);
  let funding = computeFundingRequirement(cfg, []);
  let gasReserve = null;
  let chainFundingSource = null;
  let chainFundingError = null;
  let restFundingSource = null;
  try {
    const [chain, restMarkets] = await Promise.all([
      loadChainEventMarkets(cfg, { lookbackBlocks: cfg.eventLogLookbackBlocks }),
      loadRestEventMarkets(cfg, { status: "all", limit: cfg.watchScanLimit })
    ]);
    funding = computeFundingRequirement(cfg, mergeKnownEventMarkets(chain.eventMarkets, restMarkets));
    chainFundingSource = {
      head: chain.head,
      fromBlock: chain.fromBlock,
      controllerLogs: chain.controllerLogs,
      eventMarkets: chain.eventMarkets.length,
      decodeErrors: chain.decodeErrors.length
    };
    restFundingSource = {
      eventMarkets: restMarkets.length,
      futureEventMarkets: restMarkets.filter((market) => msUntilStart(market) > 0).length
    };
  } catch (error) {
    chainFundingError = errorMessage(error);
  }
  try {
    gasReserve = await estimateFastGasReserve(publicClient, cfg, funding);
  } catch (error) {
    gasReserve = { ok: false, message: errorMessage(error) };
  }
  const checks = {
    config: {
      dryRun: cfg.dryRun,
      execute: cfg.execute,
      privateKeyPresent: Boolean(cfg.privateKey),
      riskAck: cfg.riskAck === "YES",
      eligibilityAck: cfg.eligibilityAck === "YES",
      eventBuyMode: cfg.eventBuyMode,
      eventDiscovery: cfg.eventDiscovery,
      wsProvider: wsProviderLabel(cfg.wsUrl),
      watchFundingMode: cfg.watchFundingMode,
      bundleDueMarkets: cfg.bundleDueMarkets,
      fastSkipPreflight: cfg.fastSkipPreflight,
      fastSkipDueRestHydration: cfg.fastSkipDueRestHydration,
      fanoutBroadcast: cfg.fanoutBroadcast,
      broadcastRpcCount: cfg.broadcastRpcUrls.length,
      preSignFastTx: cfg.preSignFastTx,
      preSignWindowMs: cfg.preSignWindowMs,
      preSignRetryMs: cfg.preSignRetryMs,
      nonceSyncBeforePreSign: cfg.nonceSyncBeforePreSign,
      nonceSyncMinIntervalMs: cfg.nonceSyncMinIntervalMs,
      waitForReceipt: cfg.waitForReceipt,
      asyncReceiptWatch: cfg.asyncReceiptWatch,
      receiptWatchTimeoutMs: cfg.receiptWatchTimeoutMs,
      receiptWatchPollingMs: cfg.receiptWatchPollingMs,
      executionRetryMs: cfg.executionRetryMs,
      stakePerOutcomeUsdt: cfg.stakePerOutcomeUsdt,
      eventOutcomeSelection: cfg.eventOutcomeSelection,
      eventOutcomeCount: cfg.eventOutcomeCount,
      eventOutcomeSelectionFallback: cfg.eventOutcomeSelectionFallback,
      maxBatchStakeUsdt: cfg.maxBatchStakeUsdt,
      maxOutcomesPerMarket: cfg.maxOutcomesPerMarket,
      autoApproveRouterOnStart: cfg.autoApproveRouterOnStart,
      routerApprovalRequiredUsdt: routerApprovalRequiredUsdt(cfg),
      requiredBusdt: funding.requiredBusdt,
      requiredBusdtUpperBound: funding.upperBoundRequiredBusdt
    },
    funding,
    gasReserve,
    chainFundingSource,
    restFundingSource,
    docs: {
      restTradingApi: "not documented; contract route required",
      chainId: 56
    },
    rpc: await checkRpc(publicClient),
    broadcastRpc: await warmBroadcastRpcClients(cfg),
    ws: cfg.eventDiscovery === "ws" ? await checkWs(cfg) : { skipped: true },
    wallet: null,
    latestEventPlan: null,
    blockers: []
  };

  const walletAddress = args.wallet ?? cfg.walletAddress ?? account?.address;
  if (walletAddress) {
    try {
      const status = await getWalletStatusForAddress(publicClient, walletAddress);
      checks.wallet = {
        address: status.address,
        readOnly: !account || status.address.toLowerCase() !== account.address.toLowerCase(),
        bnbBalance: status.bnbBalance,
        busdtBalance: status.busdtBalance,
        busdtAllowanceToRouter: status.busdtAllowanceToRouter,
        router: status.router,
        allowanceReady: Number(status.busdtAllowanceToRouter) >= funding.requiredBusdt,
        balanceReady: Number(status.busdtBalance) >= funding.requiredBusdt,
        bnbReady: gasReserve?.requiredBnb ? Number(status.bnbBalance) >= Number(gasReserve.requiredBnb) : null,
        allowanceReadyForUpperBound: Number(status.busdtAllowanceToRouter) >= funding.upperBoundRequiredBusdt,
        allowanceReadyForConfiguredApproval: Number(status.busdtAllowanceToRouter) >= routerApprovalRequiredUsdt(cfg),
        balanceReadyForUpperBound: Number(status.busdtBalance) >= funding.upperBoundRequiredBusdt
      };
    } catch (error) {
      checks.wallet = { ok: false, message: errorMessage(error) };
    }
  }
  if (!cfg.privateKey) checks.blockers.push("PRIVATE_KEY is not loaded from .env/.env.local/secrets; event:arm will prompt for it interactively");

  if (!cfg.dryRun && !cfg.execute) checks.blockers.push("EXECUTE=1 is required when DRY_RUN=0");
  if (!cfg.dryRun && cfg.riskAck !== "YES") checks.blockers.push("I_UNDERSTAND_42_PRICE_MARKET_RISK=YES is required");
  if (!cfg.dryRun && cfg.eligibilityAck !== "YES") checks.blockers.push("I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES is required");
  if (chainFundingError) checks.blockers.push(`Could not compute next-batch funding from chain logs: ${chainFundingError}`);
  if (gasReserve?.ok === false) checks.blockers.push(`Could not estimate fast gas reserve: ${gasReserve.message}`);
  if (checks.wallet && checks.wallet.allowanceReady === false) checks.blockers.push("BUSDT allowance is below required next buy batch; run event:approve");
  if (checks.wallet && checks.wallet.balanceReady === false) checks.blockers.push("BUSDT balance is below required next buy batch");
  if (checks.wallet && checks.wallet.bnbReady === false) checks.blockers.push("BNB balance is below required fast gas reserve");

  try {
    const eventPlan = await buildEventPlan(cfg, { forceQuoted: false });
    checks.latestEventPlan = describeEventPlan(eventPlan);
  } catch (error) {
    checks.latestEventPlan = { ok: false, message: errorMessage(error) };
    checks.blockers.push("No buildable latest Event Market plan");
  }

  console.log(JSON.stringify({ level: "event-doctor", checks }, null, 2));
}

async function checkRpc(publicClient) {
  try {
    const [blockNumber, gasPrice] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getGasPrice()
    ]);
    return {
      ok: true,
      blockNumber: blockNumber.toString(),
      gasPriceWei: gasPrice.toString()
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

async function checkWs(cfg) {
  if (!cfg.doctorCheckWs) {
    return {
      skipped: true,
      configured: Boolean(cfg.wsUrl),
      url: redactSecretUrls(cfg.wsUrl),
      note: "set DOCTOR_CHECK_WS=1 to open a live WSS check"
    };
  }

  try {
    const blockNumber = await getWsBlockNumberOnce(cfg.wsUrl, 2500);
    return {
      ok: true,
      blockNumber: blockNumber.toString(),
      url: redactSecretUrls(cfg.wsUrl)
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error), url: redactSecretUrls(cfg.wsUrl) };
  }
}

function getWsBlockNumberOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let finished = false;
    const timer = setTimeout(() => finish(new Error("WSS blockNumber timeout")), timeoutMs);

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
        socket.terminate?.();
      } catch {
        // best-effort close for one-shot doctor checks.
      }
      if (error) reject(error);
      else resolve(value);
    }

    socket.on("open", () => {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: []
      }));
    });
    socket.on("message", (data) => {
      try {
        const parsed = JSON.parse(String(data));
        if (parsed.error) {
          finish(new Error(parsed.error.message ?? JSON.stringify(parsed.error)));
          return;
        }
        finish(null, BigInt(parsed.result));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("WSS closed before blockNumber response")));
  });
}

async function createRuntime(cfg) {
  if (cfg.dryRun || !cfg.execute || cfg.eventBuyMode !== "fast") return null;
  const { publicClient, account } = makeClients(cfg);
  if (!account) return null;
  const runtime = {
    receiverAddress: cfg.walletAddress || account.address,
    pendingBuyRecords: null,
    autoSellOperatorReadyMarkets: new Set(),
    txLock: {
      owner: null,
      since: null
    }
  };
  if (cfg.fastNonceManager) {
    runtime.nextNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending"
    });
  }
  return runtime;
}

function runtimeTransactionBusy(runtime) {
  return Boolean(runtime?.txLock?.owner);
}

function runtimeTransactionLockInfo(runtime) {
  if (!runtimeTransactionBusy(runtime)) return null;
  return {
    owner: runtime.txLock.owner,
    since: runtime.txLock.since
  };
}

function pauseRuntimeAutoSell(runtime, cfg, reason) {
  if (!runtime) return;
  const holdMs = Math.max(
    cfg.autoSellPollMs,
    cfg.preSignWindowMs + eventOpenWindowMs(cfg) + 5000
  );
  const until = Date.now() + holdMs;
  runtime.autoSellPausedUntil = Math.max(runtime.autoSellPausedUntil ?? 0, until);
  runtime.autoSellPauseReason = reason;
}

function runtimeAutoSellPauseInfo(runtime) {
  const until = Number(runtime?.autoSellPausedUntil ?? 0);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return {
    reason: runtime.autoSellPauseReason ?? "open-buy-window",
    until: new Date(until).toISOString()
  };
}

function attachRuntimePendingBuyRecords(runtime, pending) {
  if (!runtime) return;
  runtime.pendingBuyRecords = pending ?? null;
}

function runtimeBuyHotWindowInfo(cfg, runtime) {
  const pending = runtime?.pendingBuyRecords;
  if (!pending || pending.size === 0) return null;
  const now = Date.now();
  const beforeMs = Number(cfg.autoSellBuyGuardBeforeMs ?? 0);
  const afterMs = Number(cfg.autoSellBuyGuardAfterMs ?? 0);

  for (const record of pending.values()) {
    const market = pendingMarket(record);
    const startMs = Date.parse(market?.startDate ?? "");
    if (!Number.isFinite(startMs)) continue;
    const guardStart = startMs - beforeMs;
    const guardEnd = startMs + eventOpenWindowMs(cfg) + afterMs;
    if (now < guardStart || now > guardEnd) continue;
    return {
      reason: "buy-hot-window",
      market: market.address ?? null,
      question: market.question ?? null,
      startDate: market.startDate ?? null,
      msUntilOpen: startMs - now,
      guardBeforeMs: beforeMs,
      guardAfterMs: afterMs,
      openWindowSeconds: cfg.eventOpenWindowSeconds
    };
  }
  return null;
}

function runtimeAutoSellBlockInfo(cfg, runtime) {
  if (runtimeTransactionBusy(runtime)) {
    return {
      skippedReason: "transaction-busy",
      lock: runtimeTransactionLockInfo(runtime)
    };
  }
  const pause = runtimeAutoSellPauseInfo(runtime);
  if (pause) {
    return {
      skippedReason: "open-buy-window",
      pause
    };
  }
  const hotWindow = runtimeBuyHotWindowInfo(cfg, runtime);
  if (hotWindow) {
    return {
      skippedReason: "buy-hot-window",
      hotWindow
    };
  }
  return null;
}

async function withRuntimeTransactionLock(runtime, owner, fn) {
  if (!runtime?.txLock) return fn();
  if (runtime.txLock.owner) {
    const error = new Error(`transaction lock busy: ${runtime.txLock.owner}`);
    error.code = "TRANSACTION_LOCK_BUSY";
    throw error;
  }
  runtime.txLock.owner = owner;
  runtime.txLock.since = new Date().toISOString();
  try {
    return await fn();
  } finally {
    runtime.txLock.owner = null;
    runtime.txLock.since = null;
  }
}

async function watch(cfg, options = {}) {
  const seen = loadSeen(cfg.stateFile);
  await ensureStartupRouterApproval(cfg);
  const watchPreflight = await validateWatchFunding(cfg);
  const broadcastWarmup = await maybeWarmBroadcastRpcs(cfg);
  const runtime = await createRuntime(cfg);
  const initialPending = new Map();
  attachRuntimePendingBuyRecords(runtime, initialPending);
  const startupWarnings = [];
  const wsStartupSeedDeferred = cfg.eventDiscovery === "ws" && !cfg.watchBuyExisting;

  if (!wsStartupSeedDeferred) {
    startupWarnings.push(...(await seedStartupMarkets(cfg, seen, initialPending, runtime, options)));
  }

  const autoSellMonitor = startAutoSellMonitor(cfg, runtime);

  console.log(
    JSON.stringify(
      {
        mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
        stakePerOutcomeUsdt: cfg.stakePerOutcomeUsdt,
        maxMarketStakeUsdt: cfg.maxMarketStakeUsdt,
        maxBatchStakeUsdt: cfg.maxBatchStakeUsdt,
        maxOutcomesPerMarket: cfg.maxOutcomesPerMarket,
        eventDiscovery: cfg.eventDiscovery,
        wsProvider: wsProviderLabel(cfg.wsUrl),
        eventBuyMode: cfg.eventBuyMode,
        eventOutcomeSelection: cfg.eventOutcomeSelection,
        eventOutcomeCount: cfg.eventOutcomeCount,
        eventOutcomeSelectionFallback: cfg.eventOutcomeSelectionFallback,
        filterMode: cfg.filterMode ?? "production",
        minEventDurationHours: cfg.minEventDurationHours,
        marketCategoryBlocklist: cfg.marketCategoryBlocklist,
        marketTagBlocklist: cfg.marketTagBlocklist,
        marketFollowFile: cfg.marketFollowFile,
        restDiscoveryEnabled: cfg.restDiscoveryEnabled,
        restDiscoveryPollMs: cfg.restDiscoveryPollMs,
        fastSkipPreflight: cfg.fastSkipPreflight,
        fastSkipDueRestHydration: cfg.fastSkipDueRestHydration,
        waitForReceipt: cfg.waitForReceipt,
        gasPriceGwei: cfg.gasPriceGwei || null,
        fastGasLimit: cfg.fastGasLimit || null,
        bundleFastGasLimit: cfg.bundleFastGasLimit || null,
        logChunkBlocks: cfg.logChunkBlocks,
      bundleDueMarkets: cfg.bundleDueMarkets,
      fastNonceManager: cfg.fastNonceManager,
      fastSkipDueRestHydration: cfg.fastSkipDueRestHydration,
      preSignFastTx: cfg.preSignFastTx,
        preSignWindowMs: cfg.preSignWindowMs,
        preSignRetryMs: cfg.preSignRetryMs,
        nonceSyncBeforePreSign: cfg.nonceSyncBeforePreSign,
        nonceSyncMinIntervalMs: cfg.nonceSyncMinIntervalMs,
        nextNonce: runtime?.nextNonce ?? null,
        asyncReceiptWatch: cfg.asyncReceiptWatch,
        autoApproveRouterOnStart: cfg.autoApproveRouterOnStart,
        routerApprovalRequiredUsdt: routerApprovalRequiredUsdt(cfg),
        receiptWatchTimeoutMs: cfg.receiptWatchTimeoutMs,
        receiptWatchPollingMs: cfg.receiptWatchPollingMs,
        executionRetryMs: cfg.executionRetryMs,
        eventOpenWindowSeconds: cfg.eventOpenWindowSeconds,
        allowPreopenBroadcast: cfg.allowPreopenBroadcast,
        receiverReady: Boolean(runtime?.receiverAddress || cfg.walletAddress),
        watchPreflight,
        broadcastWarmup,
        startupWarnings,
        wsStartupSeedDeferred,
        fundingRecovery: describeFundingRecovery(options.fundingRecovery),
        pollMs: cfg.pollMs,
        hotPollMs: cfg.hotPollMs,
        preopenHotMs: cfg.preopenHotMs,
        prebroadcastMs: cfg.prebroadcastMs,
        openBroadcastDelayMs: cfg.openBroadcastDelayMs,
        openBroadcastScheduleAheadMs: cfg.openBroadcastScheduleAheadMs,
        openBroadcastSpinMs: cfg.openBroadcastSpinMs,
        rpcKeepaliveMs: cfg.rpcKeepaliveMs,
        rebroadcastIntervalMs: cfg.rebroadcastIntervalMs,
        rebroadcastDurationMs: cfg.rebroadcastDurationMs,
        wsReceiptFallbackMs: cfg.wsReceiptFallbackMs,
        wsReceiptFallbackRetries: cfg.wsReceiptFallbackRetries,
        autoSell: autoSellMonitor
          ? {
              enabled: true,
              strategy: cfg.autoSellStrategy,
              startDelaySeconds: cfg.autoSellStartDelaySeconds,
              intervalSeconds: cfg.autoSellIntervalSeconds,
              chunkPercent: cfg.autoSellChunkPercent,
              stopLossEnabled: cfg.autoSellStopLossEnabled,
              stopLossPercent: cfg.autoSellStopLossPercent,
              stopLossSellPercent: cfg.autoSellStopLossSellPercent,
              pollMs: cfg.autoSellPollMs,
              buyGuardBeforeMs: cfg.autoSellBuyGuardBeforeMs,
              buyGuardAfterMs: cfg.autoSellBuyGuardAfterMs,
              preapproveOperator: cfg.autoSellPreapproveOperator,
              requirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator,
              maxOutcomesPerTx: cfg.autoSellMaxOutcomesPerTx,
              maxMarketsPerTx: cfg.autoSellMaxMarketsPerTx,
              maxGasPerTx: cfg.autoSellMaxGasPerTx,
              maxTxPerTick: cfg.autoSellMaxTxPerTick
            }
          : { enabled: false }
      },
      null,
      2
    )
  );

  if (cfg.eventDiscovery === "ws") {
    await watchWs(cfg, seen, runtime, initialPending, {
      seedStartup: wsStartupSeedDeferred,
      fundingRecovery: options.fundingRecovery
    });
    return;
  }
  if (cfg.eventDiscovery === "chain") {
    await watchChain(cfg, seen, runtime, initialPending);
    return;
  }

  await watchRest(cfg, seen, runtime, initialPending);
}

async function maybeWarmBroadcastRpcs(cfg) {
  if (cfg.dryRun || !cfg.execute) {
    return { skipped: true, reason: "dry-run" };
  }
  return warmBroadcastRpcClients(cfg);
}

function startAutoSellMonitor(cfg, runtime = null) {
  if (!cfg.autoSellEnabled) return null;
  const seen = loadSeen(cfg.autoSellStateFile);
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runAutoSellOnce(cfg, {
        seen,
        runtime,
        source: "monitor"
      });
      if (result.executed > 0 || result.errors.length > 0 || result.circuitBreaker?.opened) {
        const circuitOpened = result.circuitBreaker?.opened;
        console.log(JSON.stringify({
          level: "event-auto-sell-monitor",
          mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
          ...result
        }));
        if (result.errors.length > 0 || circuitOpened) {
          notifyFeishu(cfg, {
            title: circuitOpened ? "自动卖出已暂停" : "自动卖出有错误",
            level: "warn",
            fields: {
              errors: result.errors.length,
              circuit: result.circuitBreaker?.status ?? "",
              reason: result.circuitBreaker?.reason ?? result.errors[0]?.message ?? "",
              pausedUntil: result.circuitBreaker?.pausedUntil ?? "",
              first: result.errors[0]?.question ?? result.actions[0]?.question ?? "",
              action: circuitOpened ? "等待冷却后自动恢复" : "已进入失败冷却，查看控制台"
            },
            dedupeKey: circuitOpened
              ? `auto-sell-circuit-${result.circuitBreaker.reason ?? "open"}`
              : "auto-sell-errors",
            cooldownMs: cfg.autoSellAlertCooldownMs,
            fingerprint: autoSellAlertFingerprint(result),
            repeatMs: 0
          });
        }
      }
    } catch (error) {
      const message = autoSellErrorMessage(cfg, error);
      console.error(JSON.stringify({
        level: "event-auto-sell-error",
        source: "monitor",
        message,
        at: new Date().toISOString()
      }));
      notifyFeishu(cfg, {
        title: "自动卖出监控异常",
        level: "warn",
        fields: { message },
        dedupeKey: "auto-sell-monitor-error",
        cooldownMs: cfg.autoSellAlertCooldownMs,
        fingerprint: `monitor-error:${message}`,
        repeatMs: 0
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, cfg.autoSellPollMs);
  void tick();
  return timer;
}

async function runAutoSellOnce(cfg, { seen = loadSeen(cfg.autoSellStateFile), runtime = null, source = "manual" } = {}) {
  const { publicClient, account } = makeClients(cfg);
  const walletAddress = cfg.walletAddress || account?.address;
  if (!walletAddress) throw new Error("AUTO_SELL requires WALLET_ADDRESS or PRIVATE_KEY-derived account");
  if (!cfg.dryRun && cfg.execute && !account) throw new Error("PRIVATE_KEY is required for real AUTO_SELL");
  void seen;

  const result = {
    source,
    wallet: walletAddress,
    checked: 0,
    alreadyHandled: 0,
    ineligibleExisting: 0,
    triggered: 0,
    executed: 0,
    skipped: 0,
    cooldowns: 0,
    errors: [],
    actions: []
  };
  const now = Date.now();
  const circuitState = loadAutoSellCircuitState(cfg.autoSellCircuitStateFile);
  const startupBlock = runtimeAutoSellBlockInfo(cfg, runtime);
  if (startupBlock) {
    Object.assign(result, startupBlock);
    return result;
  }
  const circuitPause = autoSellCircuitPauseInfo(circuitState, now);
  if (circuitPause) {
    result.skippedReason = "auto-sell-circuit-open";
    result.circuitBreaker = {
      status: "open",
      reason: circuitPause.reason,
      pausedUntil: circuitPause.until
    };
    return result;
  }

  const openPositions = await fetchOpenPositions(cfg, {
    user: walletAddress,
    limit: cfg.autoSellPositionLimit
  });
  const eligibleMarkets = loadAutoSellEligibleMarkets(cfg);
  const ladderState = loadAutoSellPositionState(cfg.autoSellPositionStateFile);
  const allItems = [];

  for (const position of openPositions) {
    if (!isAutoSellablePosition(position)) {
      result.skipped += 1;
      continue;
    }

    const marketKey = String(position.marketAddress).toLowerCase();
    const buyAt = eligibleMarkets.get(marketKey);
    if (!buyAt) {
      result.ineligibleExisting += 1;
      continue;
    }

    result.checked += 1;
    const key = autoSellPositionKey(walletAddress, position);
    const cooldown = autoSellFailureCooldownInfo(circuitState, key, now);
    if (cooldown) {
      result.skipped += 1;
      result.cooldowns += 1;
      continue;
    }

    try {
      const entry = ensureAutoSellPositionState(ladderState, key, position, buyAt);
      if (entry.completed || entry.stopLossSold) {
        result.alreadyHandled += 1;
        continue;
      }

      const action = await buildLadderAutoSellAction(cfg, publicClient, walletAddress, position, entry, now);
      if (!action) continue;

      result.triggered += 1;
      allItems.push({ key, entry, position, ...action });
    } catch (error) {
      const message = autoSellErrorMessage(cfg, error);
      const failure = recordAutoSellFailure(cfg, circuitState, {
        keys: [key],
        status: isInsufficientFundsErrorMessage(message) ? "insufficient-bnb" : "position-error",
        message,
        now,
        countGlobal: isInsufficientFundsErrorMessage(message)
      });
      saveAutoSellCircuitState(cfg.autoSellCircuitStateFile, circuitState);
      if (failure.opened) result.circuitBreaker = failure.circuitBreaker;
      const item = {
        marketAddress: position.marketAddress,
        tokenId: String(position.tokenId),
        question: position.question?.title ?? null,
        outcome: position.outcome?.name ?? null,
        message,
        cooldownUntil: failure.cooldowns[0]?.until ?? null
      };
      result.errors.push(item);
      console.error(JSON.stringify({
        level: "event-auto-sell-position-error",
        source,
        ...item,
        at: new Date().toISOString()
      }));
    }
  }

  let txsSent = 0;
  if (!cfg.dryRun && cfg.execute && cfg.autoSellPreapproveOperator) {
    txsSent += await preapproveAutoSellOperators(cfg, {
      openPositions,
      eligibleMarkets,
      runtime,
      result,
      source,
      walletAddress,
      circuitState
    });
  }

  const allActions = allItems.map(({ plan, entry, position, ...action }) => ({
    ...action,
    status: cfg.dryRun || !cfg.execute ? "dry-run" : "pending"
  }));
  if (cfg.dryRun || !cfg.execute) {
    result.actions.push(...allActions);
    if (allActions.length > 0) {
      appendAutoSellBatchLog(cfg, { source, walletAddress, markets: marketsFromItems(allItems), actions: allActions, execution: null });
    }
    return result;
  }

  const readyItems = [];
  const waitingForApproval = [];
  for (let index = 0; index < allItems.length; index += 1) {
    const item = allItems[index];
    const action = allActions[index];
    if (cfg.autoSellRequirePreapprovedOperator && !item.plan.operatorApproved) {
      action.status = "skipped-operator-approval-needed";
      waitingForApproval.push(action);
      continue;
    }
    readyItems.push({ item, action });
  }
  if (waitingForApproval.length > 0) {
    result.skipped += waitingForApproval.length;
    result.actions.push(...waitingForApproval);
    appendAutoSellBatchLog(cfg, {
      source,
      walletAddress,
      markets: [...new Set(waitingForApproval.map((action) => action.marketAddress))],
      actions: waitingForApproval,
      execution: { status: "skipped-operator-approval-needed" }
    });
  }

  const postApprovalPause = autoSellCircuitPauseInfo(circuitState, Date.now());
  if (postApprovalPause) {
    const skippedActions = readyItems.map(({ action }) => ({
      ...action,
      status: "skipped-auto-sell-circuit-open",
      pausedUntil: postApprovalPause.until,
      pauseReason: postApprovalPause.reason
    }));
    result.skipped += skippedActions.length;
    result.actions.push(...skippedActions);
    result.circuitBreaker = {
      status: "open",
      reason: postApprovalPause.reason,
      pausedUntil: postApprovalPause.until
    };
    if (skippedActions.length > 0) {
      appendAutoSellBatchLog(cfg, {
        source,
        walletAddress,
        markets: [...new Set(skippedActions.map((action) => action.marketAddress))],
        actions: skippedActions,
        execution: { status: "skipped-auto-sell-circuit-open", circuitBreaker: result.circuitBreaker }
      });
    }
    return result;
  }

  const chunks = chunkAutoSellItems(cfg, readyItems);
  for (const chunk of chunks) {
    const items = chunk.map((entry) => entry.item);
    const actions = chunk.map((entry) => entry.action);
    let execution = null;

    try {
      const block = runtimeAutoSellBlockInfo(cfg, runtime);
      if (block) {
        for (const action of actions) {
          action.status = `skipped-${block.skippedReason}`;
          if (block.lock) action.lock = block.lock;
          if (block.pause) action.pause = block.pause;
          if (block.hotWindow) action.hotWindow = block.hotWindow;
        }
        result.skipped += actions.length;
        result.actions.push(...actions);
        appendAutoSellBatchLog(cfg, { source, walletAddress, markets: marketsFromItems(items), actions, execution: block });
        continue;
      }

      const activeCircuitPause = autoSellCircuitPauseInfo(circuitState, Date.now());
      if (activeCircuitPause) {
        for (const action of actions) {
          action.status = "skipped-auto-sell-circuit-open";
          action.pausedUntil = activeCircuitPause.until;
          action.pauseReason = activeCircuitPause.reason;
        }
        result.skipped += actions.length;
        result.actions.push(...actions);
        result.circuitBreaker = {
          status: "open",
          reason: activeCircuitPause.reason,
          pausedUntil: activeCircuitPause.until
        };
        appendAutoSellBatchLog(cfg, {
          source,
          walletAddress,
          markets: marketsFromItems(items),
          actions,
          execution: { status: "skipped-auto-sell-circuit-open", circuitBreaker: result.circuitBreaker }
        });
        continue;
      }

      if (txsSent >= cfg.autoSellMaxTxPerTick) {
        for (const action of actions) action.status = "deferred-tx-limit";
        result.skipped += actions.length;
        result.actions.push(...actions);
        appendAutoSellBatchLog(cfg, {
          source,
          walletAddress,
          markets: marketsFromItems(items),
          actions,
          execution: { status: "deferred-tx-limit", maxTxPerTick: cfg.autoSellMaxTxPerTick }
        });
        continue;
      }

      try {
        await ensureAutoSellGasBudget(cfg, publicClient, walletAddress, estimateAutoSellBatchGas(items.length));
      } catch (error) {
        const message = autoSellErrorMessage(cfg, error);
        const failure = recordAutoSellFailure(cfg, circuitState, {
          keys: items.map((item) => item.key),
          status: isInsufficientFundsErrorMessage(message) ? "insufficient-bnb" : "gas-budget-error",
          message,
          now: Date.now(),
          countGlobal: true
        });
        saveAutoSellCircuitState(cfg.autoSellCircuitStateFile, circuitState);
        for (const action of actions) {
          action.status = "skipped-gas-budget";
          action.message = message;
          action.cooldownUntil = failure.cooldowns.find((entry) => entry.key === autoSellActionPositionKey(walletAddress, action))?.until ?? null;
        }
        result.skipped += actions.length;
        result.errors.push({
          markets: marketsFromItems(items),
          count: items.length,
          message,
          circuitBreaker: failure.circuitBreaker ?? null
        });
        if (failure.opened) result.circuitBreaker = failure.circuitBreaker;
        result.actions.push(...actions);
        appendAutoSellBatchLog(cfg, {
          source,
          walletAddress,
          markets: marketsFromItems(items),
          actions,
          execution: {
            status: "skipped-gas-budget",
            message,
            circuitBreaker: failure.circuitBreaker ?? null
          }
        });
        continue;
      }

      execution = await withRuntimeTransactionLock(runtime, "auto-sell-batch", () =>
        sellOutcomesBatch(
          cfg,
          items.map((item) => item.plan),
          { requirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator }
        )
      );
      txsSent += 1;
      await syncRuntimeNonceAfterExternalTx(cfg, runtime, "auto-sell-batch");
      for (const action of actions) {
        action.txHash = execution.txHash;
        action.status = execution.status;
      }
      if (execution.status === "success") {
        recordAutoSellSuccess(circuitState, items.map((item) => item.key));
        saveAutoSellCircuitState(cfg.autoSellCircuitStateFile, circuitState);
        for (const item of items) markAutoSellActionApplied(cfg, item.entry, item);
        saveAutoSellPositionState(cfg.autoSellPositionStateFile, ladderState);
        result.executed += actions.length;
      } else {
        const message = `auto-sell receipt status ${execution.status}`;
        const failure = recordAutoSellFailure(cfg, circuitState, {
          keys: items.map((item) => item.key),
          status: `receipt-${execution.status}`,
          message,
          txHash: execution.txHash ?? null,
          now: Date.now(),
          countGlobal: true
        });
        saveAutoSellCircuitState(cfg.autoSellCircuitStateFile, circuitState);
        if (failure.opened) result.circuitBreaker = failure.circuitBreaker;
        for (const action of actions) {
          action.cooldownUntil = failure.cooldowns.find((entry) => entry.key === autoSellActionPositionKey(walletAddress, action))?.until ?? null;
        }
        result.errors.push({
          markets: marketsFromItems(items),
          count: items.length,
          message,
          circuitBreaker: failure.circuitBreaker ?? null
        });
      }

      result.actions.push(...actions);
      appendAutoSellBatchLog(cfg, { source, walletAddress, markets: marketsFromItems(items), actions, execution });
    } catch (error) {
      const message = autoSellErrorMessage(cfg, error);
      const failure = recordAutoSellFailure(cfg, circuitState, {
        keys: items.map((item) => item.key),
        status: isInsufficientFundsErrorMessage(message) ? "insufficient-bnb" : "tx-error",
        message,
        now: Date.now(),
        countGlobal: true
      });
      saveAutoSellCircuitState(cfg.autoSellCircuitStateFile, circuitState);
      if (failure.opened) result.circuitBreaker = failure.circuitBreaker;
      const item = {
        markets: marketsFromItems(items),
        count: items.length,
        message,
        circuitBreaker: failure.circuitBreaker ?? null
      };
      result.errors.push(item);
      console.error(JSON.stringify({
        level: "event-auto-sell-batch-error",
        source,
        ...item,
        at: new Date().toISOString()
      }));
      for (const action of actions) {
        action.status = "error";
        action.message = message;
        action.cooldownUntil = failure.cooldowns.find((entry) => entry.key === autoSellActionPositionKey(walletAddress, action))?.until ?? null;
      }
      result.actions.push(...actions);
      appendAutoSellBatchLog(cfg, { source, walletAddress, markets: marketsFromItems(items), actions, execution });
    }
  }

  return result;
}

async function preapproveAutoSellOperators(cfg, { openPositions, eligibleMarkets, runtime, result, source, walletAddress, circuitState }) {
  if (cfg.autoSellApprovalsPerTick <= 0) return 0;
  const { publicClient } = makeClients(cfg);
  const markets = [];
  const seenMarkets = new Set();
  for (const position of openPositions) {
    if (!isAutoSellablePosition(position)) continue;
    const marketKey = String(position.marketAddress).toLowerCase();
    if (!eligibleMarkets.has(marketKey) || seenMarkets.has(marketKey)) continue;
    if (runtime?.autoSellOperatorReadyMarkets?.has(marketKey)) continue;
    seenMarkets.add(marketKey);
    markets.push(position.marketAddress);
  }

  let sent = 0;
  for (const market of markets) {
    if (sent >= cfg.autoSellApprovalsPerTick) break;
    const block = runtimeAutoSellBlockInfo(cfg, runtime);
    if (block) {
      result.operatorApprovalSkipped = block;
      break;
    }
    try {
      await ensureAutoSellGasBudget(cfg, publicClient, walletAddress, OPERATOR_APPROVAL_GAS);
      const execution = await withRuntimeTransactionLock(runtime, "operator-preapproval", () =>
        ensureMarketOperatorApproval(cfg, market)
      );
      if (execution.txHash) {
        sent += 1;
        await syncRuntimeNonceAfterExternalTx(cfg, runtime, "operator-preapproval");
      }
      if (execution.operatorApproved) {
        runtime?.autoSellOperatorReadyMarkets?.add(String(market).toLowerCase());
      }
      const row = {
        level: "event-operator-preapproval",
        source,
        wallet: walletAddress,
        market,
        execution,
        at: new Date().toISOString()
      };
      appendJsonl(cfg.fillsFile, row);
      if (!result.operatorApprovals) result.operatorApprovals = [];
      result.operatorApprovals.push({
        market,
        status: execution.status,
        txHash: execution.txHash ?? null,
        approved: execution.operatorApproved
      });
      if (execution.status !== "ready" && execution.status !== "success") {
        result.errors.push({
          marketAddress: market,
          message: `operator approval status ${execution.status}`
        });
      }
    } catch (error) {
      const message = autoSellErrorMessage(cfg, error);
      const failure = circuitState ? recordAutoSellFailure(cfg, circuitState, {
        keys: [`operator:${String(market).toLowerCase()}`],
        status: isInsufficientFundsErrorMessage(message) ? "insufficient-bnb" : "operator-preapproval-error",
        message,
        now: Date.now(),
        countGlobal: true
      }) : { opened: false, cooldowns: [] };
      if (circuitState) saveAutoSellCircuitState(cfg.autoSellCircuitStateFile, circuitState);
      if (failure.opened) result.circuitBreaker = failure.circuitBreaker;
      const item = {
        marketAddress: market,
        message,
        circuitBreaker: failure.circuitBreaker ?? null
      };
      result.errors.push(item);
      console.error(JSON.stringify({
        level: "event-operator-preapproval-error",
        source,
        ...item,
        at: new Date().toISOString()
      }));
      if (failure.opened) break;
    }
  }
  return sent;
}

function chunkAutoSellItems(cfg, entries) {
  const chunks = [];
  let current = [];
  let currentMarkets = new Set();

  for (const entry of entries) {
    const market = String(entry.item.plan.market).toLowerCase();
    const nextMarkets = new Set(currentMarkets);
    nextMarkets.add(market);
    const nextCount = current.length + 1;
    const nextGas = estimateAutoSellBatchGas(nextCount);
    const shouldSplit = current.length > 0 && (
      nextCount > cfg.autoSellMaxOutcomesPerTx ||
      nextMarkets.size > cfg.autoSellMaxMarketsPerTx ||
      nextGas > cfg.autoSellMaxGasPerTx
    );

    if (shouldSplit) {
      chunks.push(current);
      current = [];
      currentMarkets = new Set();
    }
    current.push(entry);
    currentMarkets.add(market);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function estimateAutoSellBatchGas(outcomeCount) {
  return SELL_BATCH_BASE_GAS + SELL_BATCH_PER_OUTCOME_GAS * Number(outcomeCount);
}

function marketsFromItems(items) {
  return [...new Set(items.map((item) => item.marketAddress ?? item.plan?.market).filter(Boolean))];
}

async function buildLadderAutoSellAction(cfg, publicClient, walletAddress, position, entry, now) {
  const dueAt = autoSellStepDueAt(cfg, entry);
  const due = now >= dueAt;
  const costBasisUsdt = Number(position.costBasis ?? 0);
  let quote = null;
  let quoteError = null;
  let fullExitValueUsdt = null;
  let lossPercent = null;

  try {
    quote = await quoteSellOutcome(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      percent: 100,
      slippageBps: cfg.slippageBps
    });
    fullExitValueUsdt = rawUsdt(quote.expectedCollateralToUser);
    lossPercent = costBasisUsdt > 0
      ? Math.max(0, (1 - fullExitValueUsdt / costBasisUsdt) * 100)
      : 0;
  } catch (error) {
    quoteError = autoSellErrorMessage(cfg, error);
  }

  if (
    quote &&
    cfg.autoSellStopLossEnabled &&
    lossPercent !== null &&
    lossPercent >= cfg.autoSellStopLossPercent
  ) {
    const plan = await buildDirectSellPlan(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      percent: cfg.autoSellStopLossSellPercent
    });
    return {
      plan,
      trigger: "stop_loss",
      triggerLabel: "止损",
      percent: cfg.autoSellStopLossSellPercent,
      step: entry.nextStep,
      dueAt: new Date(dueAt).toISOString(),
      sellAmountOt: formatUnits(plan.amount, 18),
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      costBasisUsdt: roundUsd(costBasisUsdt),
      fullExitValueUsdt: roundUsd(fullExitValueUsdt),
      lossPercent: roundUsd(lossPercent),
      stopLossPercent: cfg.autoSellStopLossPercent,
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError,
      txHash: null
    };
  }

  if (!due) return null;

  const amountOt = autoSellStepAmountOt(cfg, entry, position);
  if (!amountOt) return null;
  const plan = await buildDirectSellPlan(publicClient, {
    market: position.marketAddress,
    tokenId: position.tokenId,
    owner: walletAddress,
    amountOt
  });
  return {
    plan,
    trigger: "ladder_step",
    triggerLabel: "分批卖出",
    percent: cfg.autoSellChunkPercent,
    step: entry.nextStep,
    totalSteps: autoSellTotalSteps(cfg),
    dueAt: new Date(dueAt).toISOString(),
    sellAmountOt: formatUnits(plan.amount, 18),
    marketAddress: position.marketAddress,
    tokenId: String(position.tokenId),
    question: position.question?.title ?? null,
    outcome: position.outcome?.name ?? null,
    costBasisUsdt: roundUsd(costBasisUsdt),
    fullExitValueUsdt: fullExitValueUsdt === null ? null : roundUsd(fullExitValueUsdt),
    lossPercent: lossPercent === null ? null : roundUsd(lossPercent),
    minCollateralOutUsdt: "0.000000000000000001",
    noPriceProtection: true,
    quoteError,
    txHash: null
  };
}

function appendAutoSellBatchLog(cfg, { source, walletAddress, market = null, markets = null, actions, execution }) {
  appendJsonl(cfg.fillsFile, {
    level: "event-auto-sell",
    source,
    mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
    wallet: walletAddress,
    market,
    markets,
    strategy: cfg.autoSellStrategy,
    actions: sanitizeAutoSellLogValue(cfg, actions),
    execution: sanitizeAutoSellLogValue(cfg, execution),
    at: new Date().toISOString()
  });
}

function markAutoSellActionApplied(cfg, entry, item) {
  entry.lastSoldAt = new Date().toISOString();
  entry.lastTrigger = item.trigger;
  if (item.trigger === "stop_loss") {
    entry.stopLossSold = true;
    entry.completed = true;
    return;
  }
  entry.nextStep = Number(entry.nextStep ?? 1) + 1;
  if (entry.nextStep > autoSellTotalSteps(cfg)) {
    entry.completed = true;
  }
}

function ensureAutoSellPositionState(state, key, position, buyAt) {
  if (!state.positions) state.positions = {};
  if (!state.positions[key]) {
    state.positions[key] = {
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      buyAt,
      detectedAt: new Date().toISOString(),
      initialSize: String(position.size ?? "0"),
      nextStep: 1,
      completed: false,
      stopLossSold: false
    };
  }
  return state.positions[key];
}

function autoSellPositionKey(walletAddress, position) {
  return [
    String(walletAddress).toLowerCase(),
    String(position.marketAddress).toLowerCase(),
    String(position.tokenId)
  ].join(":");
}

function autoSellStepDueAt(cfg, entry) {
  const buyAt = new Date(entry.buyAt).getTime();
  const step = Math.max(1, Number(entry.nextStep ?? 1));
  return buyAt +
    cfg.autoSellStartDelaySeconds * 1000 +
    (step - 1) * cfg.autoSellIntervalSeconds * 1000;
}

function autoSellStepAmountOt(cfg, entry, position) {
  const current = parseUnits(String(position.size ?? "0"), 18);
  if (current <= 0n) return null;
  const totalSteps = autoSellTotalSteps(cfg);
  const step = Math.max(1, Number(entry.nextStep ?? 1));
  if (step >= totalSteps) return formatUnits(current, 18);

  const initial = parseUnits(String(entry.initialSize ?? position.size ?? "0"), 18);
  const bps = BigInt(Math.floor(Number(cfg.autoSellChunkPercent) * 100));
  let amount = (initial * bps) / 10_000n;
  if (amount <= 0n) return null;
  if (amount > current) amount = current;
  return formatUnits(amount, 18);
}

function autoSellTotalSteps(cfg) {
  return Math.ceil(100 / Number(cfg.autoSellChunkPercent));
}

function loadAutoSellEligibleMarkets(cfg) {
  const applyAfterMs = cfg.autoSellApplyAfterIso
    ? new Date(cfg.autoSellApplyAfterIso).getTime()
    : 0;
  const markets = new Map();
  for (const row of readJsonlTailRows(cfg.fillsFile, cfg.autoSellEligibleTailBytes)) {
    const at = new Date(row.at ?? 0).getTime();
    if (!Number.isFinite(at) || at < applyAfterMs) continue;
    if (!isSuccessfulBuyFill(row)) continue;
    for (const market of boughtMarketsFromFill(row)) {
      const key = String(market).toLowerCase();
      if (!markets.has(key) || new Date(markets.get(key)).getTime() < at) {
        markets.set(key, new Date(at).toISOString());
      }
    }
  }
  addAutoSellPositionStateEligibleMarkets(cfg, markets, applyAfterMs);
  return markets;
}

function readJsonlTailRows(file, maxBytes) {
  if (!fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  if (stat.size === 0) return [];
  const bytes = Math.max(1024, Number(maxBytes) || 4194304);
  const start = Math.max(0, stat.size - bytes);
  const length = stat.size - start;
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function addAutoSellPositionStateEligibleMarkets(cfg, markets, applyAfterMs) {
  const state = loadAutoSellPositionState(cfg.autoSellPositionStateFile);
  for (const entry of Object.values(state.positions ?? {})) {
    const market = entry?.marketAddress;
    const at = new Date(entry?.buyAt ?? 0).getTime();
    if (!market || !Number.isFinite(at) || at < applyAfterMs) continue;
    const key = String(market).toLowerCase();
    if (!markets.has(key) || new Date(markets.get(key)).getTime() < at) {
      markets.set(key, new Date(at).toISOString());
    }
  }
}

function isSuccessfulBuyFill(row) {
  if (row?.result && !row.result.dryRun) {
    if (row.result.status !== "success" && row.result.status !== "broadcast") return false;
    return Boolean(row?.plan?.market?.address || row?.bundle?.markets?.length);
  }
  if (row?.level === "event-receipt" && row.status === "success") {
    return Boolean(row?.context?.market || row?.context?.markets?.length);
  }
  return false;
}

function boughtMarketsFromFill(row) {
  if (row?.plan?.market?.address) return [row.plan.market.address];
  if (Array.isArray(row?.bundle?.markets)) {
    return row.bundle.markets.map((market) => market.address).filter(Boolean);
  }
  if (row?.context?.market) return [row.context.market];
  if (Array.isArray(row?.context?.markets)) return row.context.markets.filter(Boolean);
  return [];
}

function loadAutoSellPositionState(file) {
  if (!fs.existsSync(file)) return { positions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { positions: parsed.positions ?? {} }
      : { positions: {} };
  } catch (error) {
    const backup = `${file}.bak`;
    if (fs.existsSync(backup)) {
      const parsed = JSON.parse(fs.readFileSync(backup, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { positions: parsed.positions ?? {} }
        : { positions: {} };
    }
    throw new Error(`Failed to load auto-sell position state ${file}: ${error.message}`);
  }
}

function saveAutoSellPositionState(file, state) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const backup = `${file}.bak`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function loadAutoSellCircuitState(file) {
  if (!fs.existsSync(file)) return defaultAutoSellCircuitState();
  try {
    return normalizeAutoSellCircuitState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    const backup = `${file}.bak`;
    if (fs.existsSync(backup)) {
      return normalizeAutoSellCircuitState(JSON.parse(fs.readFileSync(backup, "utf8")));
    }
    throw new Error(`Failed to load auto-sell circuit state ${file}: ${error.message}`);
  }
}

function saveAutoSellCircuitState(file, state) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const backup = `${file}.bak`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalizeAutoSellCircuitState(state), null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function defaultAutoSellCircuitState() {
  return {
    version: 1,
    pausedUntil: null,
    pauseReason: null,
    pauseMessage: null,
    pauseOpenedAt: null,
    failures: {},
    recentFailures: []
  };
}

function normalizeAutoSellCircuitState(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    version: 1,
    pausedUntil: raw.pausedUntil ?? null,
    pauseReason: raw.pauseReason ?? null,
    pauseMessage: raw.pauseMessage ?? null,
    pauseOpenedAt: raw.pauseOpenedAt ?? null,
    failures: raw.failures && typeof raw.failures === "object" && !Array.isArray(raw.failures)
      ? raw.failures
      : {},
    recentFailures: Array.isArray(raw.recentFailures) ? raw.recentFailures.slice(-100) : []
  };
}

function autoSellCircuitPauseInfo(state, now = Date.now()) {
  const untilMs = Date.parse(state?.pausedUntil ?? "");
  if (!Number.isFinite(untilMs) || untilMs <= now) return null;
  return {
    reason: state.pauseReason ?? "circuit-breaker",
    message: state.pauseMessage ?? null,
    until: new Date(untilMs).toISOString()
  };
}

function summarizeAutoSellCircuit(cfg) {
  try {
    const state = loadAutoSellCircuitState(cfg.autoSellCircuitStateFile);
    const pause = autoSellCircuitPauseInfo(state);
    return {
      enabled: cfg.autoSellCircuitBreakerEnabled,
      status: pause ? "open" : "closed",
      reason: pause?.reason ?? null,
      pausedUntil: pause?.until ?? null,
      failureKeys: Object.keys(state.failures ?? {}).length,
      recentFailures: Array.isArray(state.recentFailures) ? state.recentFailures.length : 0,
      maxConsecutiveFailures: cfg.autoSellMaxConsecutiveFailures,
      failureCooldownMs: cfg.autoSellFailureCooldownMs,
      circuitFailureLimit: cfg.autoSellCircuitFailureLimit,
      circuitWindowMs: cfg.autoSellCircuitWindowMs,
      circuitPauseMs: cfg.autoSellCircuitPauseMs,
      minBnbReserve: cfg.autoSellMinBnbReserve
    };
  } catch (error) {
    return {
      enabled: cfg.autoSellCircuitBreakerEnabled,
      status: "error",
      message: autoSellErrorMessage(cfg, error)
    };
  }
}

function autoSellFailureCooldownInfo(state, key, now = Date.now()) {
  const entry = state?.failures?.[key];
  if (!entry) return null;
  const untilMs = Date.parse(entry.cooldownUntil ?? "");
  if (!Number.isFinite(untilMs) || untilMs <= now) return null;
  return {
    reason: "failure-cooldown",
    until: new Date(untilMs).toISOString(),
    consecutiveFailures: Number(entry.consecutive ?? 0),
    message: entry.lastMessage ?? null
  };
}

function recordAutoSellSuccess(state, keys) {
  if (!state?.failures) return;
  for (const key of uniqueAutoSellKeys(keys)) {
    delete state.failures[key];
  }
}

function recordAutoSellFailure(cfg, state, {
  keys,
  status,
  message,
  txHash = null,
  now = Date.now(),
  countGlobal = false
} = {}) {
  const normalized = normalizeAutoSellCircuitState(state);
  Object.assign(state, normalized);
  const compactMessage = compactAutoSellMessage(message, cfg.autoSellErrorMessageMaxChars);
  const cooldowns = [];
  const uniqueKeys = uniqueAutoSellKeys(keys);

  for (const key of uniqueKeys) {
    const current = state.failures[key] ?? {};
    const previousCooldownMs = Date.parse(current.cooldownUntil ?? "");
    const previousConsecutive = Number(current.consecutive ?? 0);
    const consecutive = Number.isFinite(previousCooldownMs) && previousCooldownMs <= now
      ? 1
      : previousConsecutive + 1;
    const next = {
      ...current,
      consecutive,
      lastStatus: status,
      lastMessage: compactMessage,
      lastTxHash: txHash,
      lastFailedAt: new Date(now).toISOString()
    };
    if (consecutive >= cfg.autoSellMaxConsecutiveFailures && cfg.autoSellFailureCooldownMs > 0) {
      next.cooldownUntil = new Date(now + cfg.autoSellFailureCooldownMs).toISOString();
      cooldowns.push({ key, until: next.cooldownUntil, consecutive });
    }
    state.failures[key] = next;
  }

  let opened = false;
  let circuitBreaker = null;
  const insufficientBnb = status === "insufficient-bnb" || isInsufficientFundsErrorMessage(compactMessage);
  if (insufficientBnb) {
    opened = openAutoSellCircuit(cfg, state, {
      reason: "insufficient-bnb",
      message: compactMessage,
      now
    });
  } else if (countGlobal && cfg.autoSellCircuitBreakerEnabled) {
    state.recentFailures = (state.recentFailures ?? [])
      .filter((entry) => {
        const at = Date.parse(entry.at ?? "");
        return Number.isFinite(at) && now - at <= cfg.autoSellCircuitWindowMs;
      });
    state.recentFailures.push({
      at: new Date(now).toISOString(),
      status,
      message: compactMessage,
      txHash
    });
    if (state.recentFailures.length >= cfg.autoSellCircuitFailureLimit) {
      opened = openAutoSellCircuit(cfg, state, {
        reason: "consecutive-auto-sell-failures",
        message: compactMessage,
        now
      });
    }
  }

  const pause = autoSellCircuitPauseInfo(state, now);
  if (pause) {
    circuitBreaker = {
      status: "open",
      reason: pause.reason,
      pausedUntil: pause.until,
      message: pause.message,
      opened
    };
  }
  pruneAutoSellCircuitState(state, now);
  return { opened, cooldowns, circuitBreaker };
}

function openAutoSellCircuit(cfg, state, { reason, message, now }) {
  const pausedUntilMs = now + cfg.autoSellCircuitPauseMs;
  const previousPausedUntilMs = Date.parse(state.pausedUntil ?? "");
  const opened = !Number.isFinite(previousPausedUntilMs) || pausedUntilMs > previousPausedUntilMs;
  state.pausedUntil = new Date(pausedUntilMs).toISOString();
  state.pauseReason = reason;
  state.pauseMessage = compactAutoSellMessage(message, cfg.autoSellErrorMessageMaxChars);
  state.pauseOpenedAt = new Date(now).toISOString();
  return opened;
}

function pruneAutoSellCircuitState(state, now = Date.now()) {
  const keepAfter = now - 24 * 60 * 60 * 1000;
  state.recentFailures = (state.recentFailures ?? []).filter((entry) => {
    const at = Date.parse(entry.at ?? "");
    return Number.isFinite(at) && at >= keepAfter;
  }).slice(-100);
  for (const [key, entry] of Object.entries(state.failures ?? {})) {
    const lastFailedAt = Date.parse(entry.lastFailedAt ?? "");
    const cooldownUntil = Date.parse(entry.cooldownUntil ?? "");
    const stillCooling = Number.isFinite(cooldownUntil) && cooldownUntil > now;
    const recentlyFailed = Number.isFinite(lastFailedAt) && lastFailedAt >= keepAfter;
    if (!stillCooling && !recentlyFailed) delete state.failures[key];
  }
}

function uniqueAutoSellKeys(keys) {
  const result = [];
  const seen = new Set();
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const normalized = String(key ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function ensureAutoSellGasBudget(cfg, publicClient, walletAddress, gasUnits) {
  if (cfg.dryRun || !cfg.execute) return null;
  const gasLimit = BigInt(Math.max(0, Number(gasUnits ?? 0)));
  const gasPriceWei = cfg.gasPriceGwei
    ? parseGwei(String(cfg.gasPriceGwei))
    : await publicClient.getGasPrice();
  const estimatedTxCostWei = gasLimit * gasPriceWei;
  const minReserveWei = parseUnits(String(cfg.autoSellMinBnbReserve ?? 0), 18);
  const requiredWei = estimatedTxCostWei + minReserveWei;
  const balanceWei = await publicClient.getBalance({ address: walletAddress });
  if (balanceWei < requiredWei) {
    const error = new Error(
      `AUTO_SELL gas guard: BNB balance ${formatUnits(balanceWei, 18)} below required ${formatUnits(requiredWei, 18)} ` +
      `(estimatedGas=${gasLimit.toString()}, gasPriceGwei=${formatUnits(gasPriceWei, 9)}, minReserveBnb=${cfg.autoSellMinBnbReserve})`
    );
    error.code = "AUTO_SELL_INSUFFICIENT_BNB";
    throw error;
  }
  return {
    balanceBnb: formatUnits(balanceWei, 18),
    requiredBnb: formatUnits(requiredWei, 18),
    estimatedTxCostBnb: formatUnits(estimatedTxCostWei, 18),
    gasLimit: gasLimit.toString(),
    gasPriceGwei: formatUnits(gasPriceWei, 9)
  };
}

function autoSellActionPositionKey(walletAddress, action) {
  return [
    String(walletAddress).toLowerCase(),
    String(action.marketAddress).toLowerCase(),
    String(action.tokenId)
  ].join(":");
}

function autoSellErrorMessage(cfg, error) {
  return compactAutoSellMessage(errorMessage(error), cfg.autoSellErrorMessageMaxChars);
}

function autoSellAlertFingerprint(result = {}) {
  const firstError = result.errors?.[0] ?? {};
  return [
    result.circuitBreaker?.opened ? "circuit" : "error",
    result.circuitBreaker?.reason ?? "",
    result.circuitBreaker?.pausedUntil ?? "",
    firstError.marketAddress ?? firstError.market ?? "",
    firstError.tokenId ?? "",
    compactAutoSellMessage(firstError.message ?? result.circuitBreaker?.reason ?? "", 160)
  ].join(":");
}

function compactAutoSellMessage(message, maxChars = 500) {
  const limit = Math.max(80, Number(maxChars) || 500);
  let text = redactSecretUrls(String(message ?? ""));
  text = text.replace(/0x[a-fA-F0-9]{96,}/g, (hex) =>
    `${hex.slice(0, 18)}...${hex.slice(-12)}[hex:${hex.length}]`
  );
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function sanitizeAutoSellLogValue(cfg, value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compactAutoSellMessage(value, cfg.autoSellErrorMessageMaxChars);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (depth >= 5) return "[truncated-depth]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAutoSellLogValue(cfg, item, depth + 1));
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeAutoSellLogValue(cfg, item, depth + 1);
  }
  return result;
}

function isInsufficientFundsErrorMessage(message) {
  return /insufficient funds|gas \* price|exceeds the balance|not enough (?:bnb|native)|AUTO_SELL_INSUFFICIENT_BNB|AUTO_SELL gas guard|BNB balance .*below required/i.test(String(message));
}

function isAutoSellablePosition(position) {
  if (!position) return false;
  if (position.isFinalized || position.isClaimed) return false;
  if (!position.marketAddress || position.tokenId === undefined || position.tokenId === null) return false;
  return Number(position.costBasis ?? 0) > 0 && Number(position.size ?? 0) > 0;
}

function resolveAutoSellTrigger(cfg, { profitMultiple, lossPercent }) {
  void profitMultiple;
  if (cfg.autoSellStopLossEnabled && lossPercent >= cfg.autoSellStopLossPercent) {
    return {
      type: "stop_loss",
      label: "止损",
      sellPercent: cfg.autoSellStopLossSellPercent
    };
  }
  return null;
}

function autoSellKey(walletAddress, position, cfg, trigger = null) {
  const triggerType = trigger?.type ?? "take_profit";
  const triggerValue = triggerType === "stop_loss"
    ? `sl${cfg.autoSellStopLossPercent}`
    : `tp${cfg.autoSellProfitMultiplier}`;
  const sellPercent = trigger?.sellPercent ?? (
    triggerType === "stop_loss" ? cfg.autoSellStopLossSellPercent : cfg.autoSellPercent
  );
  return [
    String(walletAddress).toLowerCase(),
    String(position.marketAddress).toLowerCase(),
    String(position.tokenId),
    triggerType,
    triggerValue,
    `sell${sellPercent}`
  ].join(":");
}

function autoSellSummaryText(cfg) {
  if (!cfg.autoSellEnabled) return "off";
  if (cfg.autoSellStrategy === "ladder") {
    return `买后${cfg.autoSellStartDelaySeconds}s起每${cfg.autoSellIntervalSeconds}s卖${cfg.autoSellChunkPercent}%; 亏${cfg.autoSellStopLossPercent}%全卖`;
  }
  const takeProfit = `旧策略 ${cfg.autoSellProfitMultiplier}x 卖 ${cfg.autoSellPercent}%`;
  const stopLoss = cfg.autoSellStopLossEnabled
    ? `亏 ${cfg.autoSellStopLossPercent}% 卖 ${cfg.autoSellStopLossSellPercent}%`
    : "止损 off";
  return `${takeProfit}; ${stopLoss}`;
}

function rawUsdt(value) {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  return Number(formatUnits(raw, 18));
}

async function syncRuntimeNonceAfterExternalTx(cfg, runtime, reason) {
  if (!runtime || runtime.nextNonce === undefined || cfg.dryRun || !cfg.execute) return;
  const { publicClient, account } = makeClients(cfg);
  if (!account) return;
  const pendingNonce = Number(await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  }));
  const previousNonce = runtime.nextNonce;
  runtime.nextNonce = Math.max(runtime.nextNonce, pendingNonce);
  runtime.lastNonceSyncAt = Date.now();
  if (runtime.nextNonce !== previousNonce) {
    console.error(JSON.stringify({
      level: "warn",
      source: "nonce-sync-after-external-tx",
      reason,
      previousNonce,
      nextNonce: runtime.nextNonce,
      pendingNonce,
      at: new Date().toISOString()
    }));
  }
}

async function waitForWatchFunding(cfg) {
  while (true) {
    let retryMs = cfg.armFundingRetryMs;
    try {
      const fundingStatus = await getWatchFundingStatus(cfg);
      if (fundingStatus.skipped || fundingStatus.ready) {
        console.log(JSON.stringify({
          level: "event-arm-funding-ready",
          address: fundingStatus.address ?? null,
          requiredBusdt: fundingStatus.funding?.requiredBusdt ?? null,
          executableBusdt: fundingStatus.executablePlan?.totalStakeUsdt ?? null,
          executableMarketCount: fundingStatus.executablePlan?.selected?.length ?? null,
          unfundedMarketCount: fundingStatus.executablePlan?.skipped?.length ?? null,
          partialFunding: fundingStatus.wallet?.partialFunding ?? false,
          requiredBnbGasReserve: fundingStatus.gasReserve?.requiredBnb ?? null,
          at: new Date().toISOString()
        }));
        notifyFeishu(cfg, {
          title: "资金检查通过",
          fields: buildFundingReadyAlertFields(fundingStatus),
          dedupeKey: "funding-ready",
          cooldownMs: cfg.feishuAlertCooldownMs,
          fingerprint: fundingReadyAlertFingerprint(fundingStatus),
          repeatMs: 0
        });
        return fundingStatus;
      }
      retryMs = nextFundingRetryMs(cfg, fundingStatus);
      const waitAlertFields = buildFundingWaitingAlertFields(fundingStatus, retryMs);
      console.error(JSON.stringify({
        level: "event-arm-waiting-for-funds",
        message: fundingStatus.message,
        wallet: fundingStatus.wallet,
        funding: fundingStatus.funding,
        gasReserve: fundingStatus.gasReserve,
        retryMs,
        msUntilNextStart: fundingMsUntilStart(fundingStatus),
        at: new Date().toISOString()
      }));
      if (shouldNotifyFundingWait(fundingStatus)) {
        notifyFeishu(cfg, {
          title: "开盘前资金不足",
          level: "warn",
          fields: waitAlertFields,
          dedupeKey: "waiting-for-funds",
          cooldownMs: cfg.feishuAlertCooldownMs,
          fingerprint: fundingWaitingAlertFingerprint(fundingStatus),
          repeatMs: 0
        });
      }
    } catch (error) {
      const message = errorMessage(error);
      console.error(JSON.stringify({
        level: "event-arm-waiting-error",
        message,
        retryMs,
        at: new Date().toISOString()
      }));
      notifyFeishu(cfg, {
        title: "资金检查异常",
        level: "warn",
        fields: { message, retryMs, action: "查看日志或 RPC 状态" },
        dedupeKey: "funding-check-error",
        cooldownMs: cfg.feishuAlertCooldownMs,
        fingerprint: `funding-error:${compactAutoSellMessage(message, 180)}`,
        repeatMs: 0
      });
    }
    await sleep(retryMs);
  }
}

function nextFundingRetryMs(cfg, fundingStatus) {
  const msUntilNextStart = fundingMsUntilStart(fundingStatus);
  if (
    msUntilNextStart !== null &&
    cfg.armFundingHotWindowMs > 0 &&
    msUntilNextStart >= 0 &&
    msUntilNextStart <= cfg.armFundingHotWindowMs
  ) {
    return Math.min(cfg.armFundingRetryMs, cfg.armFundingHotRetryMs);
  }
  return cfg.armFundingRetryMs;
}

function fundingMsUntilStart(fundingStatus) {
  const startDate = fundingStatus?.funding?.nextBatchStartDate;
  if (!startDate) return null;
  const ts = Date.parse(startDate);
  if (!Number.isFinite(ts)) return null;
  return ts - Date.now();
}

function buildFundingReadyAlertFields(fundingStatus) {
  return {
    requiredBusdt: fundingStatus?.funding?.requiredBusdt ?? "",
    executableBusdt: fundingStatus?.executablePlan?.totalStakeUsdt ?? "",
    executableMarkets: fundingStatus?.executablePlan?.selected?.length ?? "",
    totalMarkets: fundingStatus?.funding?.nextBatchMarketCount ?? "",
    unfundedMarkets: fundingStatus?.executablePlan?.skipped?.length ?? "",
    requiredBnb: fundingStatus?.gasReserve?.requiredBnb ?? "",
    nextStart: fundingStatus?.funding?.nextBatchStartDate ?? "",
    partialFunding: fundingStatus?.wallet?.partialFunding ? "yes" : "",
    action: "无需操作"
  };
}

function buildFundingWaitingAlertFields(fundingStatus, retryMs) {
  return {
    message: fundingStatus?.message ?? "",
    shortfall: fundingShortfallText(fundingStatus),
    nextStart: fundingStatus?.funding?.nextBatchStartDate ?? "",
    msUntilNextStart: fundingMsUntilStart(fundingStatus),
    executableMarkets: fundingStatus?.executablePlan?.selected?.length ?? "",
    totalMarkets: fundingStatus?.funding?.nextBatchMarketCount ?? "",
    retryMs,
    action: fundingWaitActionText(fundingStatus)
  };
}

function fundingReadyAlertFingerprint(fundingStatus) {
  return [
    "ready",
    fundingStatus?.skipped ? "skipped" : "checked",
    fundingStatus?.funding?.nextBatchStartDate ?? "no-start",
    fundingStatus?.executablePlan?.selected?.length ?? 0,
    fundingStatus?.funding?.nextBatchMarketCount ?? 0,
    fundingStatus?.wallet?.partialFunding ? "partial" : "full"
  ].join(":");
}

function fundingWaitingAlertFingerprint(fundingStatus) {
  return [
    "waiting",
    fundingReminderStage(fundingStatus),
    fundingShortfallFingerprint(fundingStatus),
    fundingStatus?.funding?.nextBatchStartDate ?? "no-start",
    fundingStatus?.executablePlan?.selected?.length ?? 0,
    fundingStatus?.funding?.nextBatchMarketCount ?? 0
  ].join(":");
}

function fundingReminderStage(fundingStatus) {
  const ms = fundingMsUntilStart(fundingStatus);
  if (ms === null || ms < 0) return "normal";
  if (ms <= 5 * 60 * 1000) return "t-5m";
  if (ms <= 30 * 60 * 1000) return "t-30m";
  return "normal";
}

function shouldNotifyFundingWait(fundingStatus) {
  return fundingReminderStage(fundingStatus) !== "normal";
}

function fundingShortfallFingerprint(fundingStatus) {
  const shortfall = fundingShortfallNumbers(fundingStatus);
  return [
    shortfall.busdt > 0 ? `busdt-${roundToken(shortfall.busdt, 2)}` : "busdt-ok",
    shortfall.allowance > 0 ? `allow-${roundToken(shortfall.allowance, 2)}` : "allow-ok",
    shortfall.bnb > 0 ? `bnb-${roundToken(shortfall.bnb, 5)}` : "bnb-ok"
  ].join(":");
}

function fundingShortfallText(fundingStatus) {
  const shortfall = fundingShortfallNumbers(fundingStatus);
  const parts = [];
  if (shortfall.busdt > 0) parts.push(`BUSDT 差 ${roundToken(shortfall.busdt, 4)}U`);
  if (shortfall.allowance > 0) parts.push(`授权差 ${roundToken(shortfall.allowance, 4)}U`);
  if (shortfall.bnb > 0) parts.push(`BNB 差 ${roundToken(shortfall.bnb, 8)}`);
  return parts.join(" / ") || compactAutoSellMessage(fundingStatus?.message ?? "资金未满足", 180);
}

function fundingShortfallNumbers(fundingStatus) {
  const wallet = fundingStatus?.wallet ?? {};
  const requiredBusdt = fundingRequiredBusdt(fundingStatus);
  const requiredBnb = Number(fundingStatus?.gasReserve?.requiredBnb ?? 0);
  const busdtBalance = Number(wallet.busdtBalance ?? 0);
  const busdtAllowance = Number(wallet.busdtAllowanceToRouter ?? 0);
  const bnbBalance = Number(wallet.bnbBalance ?? 0);
  return {
    busdt: Math.max(0, requiredBusdt - busdtBalance),
    allowance: Math.max(0, requiredBusdt - busdtAllowance),
    bnb: Math.max(0, requiredBnb - bnbBalance)
  };
}

function fundingRequiredBusdt(fundingStatus) {
  const hasKnownBatch = Number(fundingStatus?.funding?.nextBatchMarketCount ?? 0) > 0;
  if (hasKnownBatch) return Number(fundingStatus?.funding?.minimumExecutableBusdt ?? 0);
  return Number(
    fundingStatus?.funding?.upperBoundRequiredBusdt ??
    fundingStatus?.funding?.requiredBusdt ??
    0
  );
}

function fundingWaitActionText(fundingStatus) {
  if (!fundingStatus?.balanceReady) return "补 BUSDT 后自动恢复";
  if (!fundingStatus?.allowanceReady) return "补授权后自动恢复";
  if (!fundingStatus?.bnbReady) return "补 BNB 后自动恢复";
  return "等待下一次检查";
}

function describeFundingRecovery(fundingRecovery) {
  if (!fundingRecovery?.enabled) return null;
  return {
    enabled: true,
    waitingSince: new Date(fundingRecovery.waitingSince).toISOString(),
    fundingReadyAt: new Date(fundingRecovery.fundingReadyAt).toISOString()
  };
}

async function getWatchFundingStatus(cfg) {
  if (cfg.dryRun || !cfg.execute || cfg.eventBuyMode !== "fast") {
    return { skipped: true, ready: true };
  }
  const { publicClient } = makeClients(cfg);
  const [chain, restMarkets] = await Promise.all([
    loadChainEventMarkets(cfg, { lookbackBlocks: cfg.eventLogLookbackBlocks }),
    loadRestEventMarkets(cfg, { status: "all", limit: cfg.watchScanLimit })
  ]);
  const funding = computeFundingRequirement(cfg, mergeKnownEventMarkets(chain.eventMarkets, restMarkets));
  const walletStatus = await getWalletStatus(cfg);
  const executablePlan = selectAffordableMarketSummaries(cfg, funding.nextBatchMarkets, walletStatus);
  const hasKnownBatch = funding.nextBatchMarketCount > 0;
  const minimumRequired = hasKnownBatch ? funding.minimumExecutableBusdt : funding.upperBoundRequiredBusdt;
  const balanceReady = hasKnownBatch
    ? executablePlan.selected.length > 0
    : Number(walletStatus.busdtBalance) >= minimumRequired;
  const allowanceReady = hasKnownBatch
    ? executablePlan.selected.length > 0
    : Number(walletStatus.busdtAllowanceToRouter) >= minimumRequired;
  const executableFunding = executablePlan.selected.length > 0
    ? fundingForMarketSummaries(cfg, executablePlan.selected, funding)
    : funding;
  const gasReserve = await estimateFastGasReserve(publicClient, cfg, executableFunding);
  const bnbReady = Number(walletStatus.bnbBalance) >= Number(gasReserve.requiredBnb);
  const ready = balanceReady && allowanceReady && bnbReady;
  const message = ready
    ? null
    : `Watch preflight failed: BUSDT balance ${walletStatus.busdtBalance}, allowance ${walletStatus.busdtAllowanceToRouter}, minimum ${minimumRequired}, selected ${executablePlan.selected.length}/${funding.nextBatchMarketCount || 1} (${funding.reason}); BNB balance ${walletStatus.bnbBalance}, required gas reserve ${gasReserve.requiredBnb} (${gasReserve.mode})`;
  return {
    address: walletStatus.address,
    funding,
    gasReserve,
    executableFunding,
    executablePlan,
    ready,
    balanceReady,
    allowanceReady,
    bnbReady,
    message,
    wallet: {
      address: walletStatus.address,
      bnbBalance: walletStatus.bnbBalance,
      busdtBalance: walletStatus.busdtBalance,
      busdtAllowanceToRouter: walletStatus.busdtAllowanceToRouter,
      minimumExecutableBusdt: funding.minimumExecutableBusdt,
      executableBusdt: executablePlan.totalStakeUsdt,
      executableMarketCount: executablePlan.selected.length,
      unfundedMarketCount: executablePlan.skipped.length,
      partialFunding: executablePlan.selected.length > 0 && executablePlan.skipped.length > 0,
      balanceReady,
      allowanceReady,
      bnbReady
    }
  };
}

async function validateWatchFunding(cfg) {
  const fundingStatus = await getWatchFundingStatus(cfg);
  if (!fundingStatus.ready) throw new Error(fundingStatus.message);
  return fundingStatus;
}

async function seedStartupMarkets(cfg, seen, pending, runtime = null, options = {}) {
  const warnings = [];
  if (cfg.watchBuyExisting) return warnings;

  const restSeed = await seedExistingRestMarkets(cfg, seen, pending, runtime, options);
  if (!restSeed.ok) warnings.push({ source: "rest-seed", message: restSeed.message });
  console.log(
    JSON.stringify({
      level: "startup",
      seededExistingMarkets: restSeed.seededExistingMarkets,
      catchUpLiveMarkets: restSeed.catchUpLiveMarkets,
      pendingFutureMarkets: pending.size,
      preparedFutureMarkets: restSeed.preparedFutureMarkets,
      mode: "waiting-for-new-event-markets",
      restSeedOk: restSeed.ok,
      warning: restSeed.ok ? null : restSeed.message
    })
  );

  if (cfg.eventDiscovery !== "rest") {
    try {
      const seeded = await seedRecentChainMarkets(cfg, seen, pending, runtime, options);
      if (seeded.checkedLogs > 0) {
        console.log(JSON.stringify({ level: "startup-chain-replay", ...seeded }));
      }
    } catch (error) {
      const message = errorMessage(error);
      warnings.push({ source: "chain-replay", message });
      console.error(JSON.stringify({
        level: "warn",
        source: "startup-chain-replay",
        message,
        at: new Date().toISOString()
      }));
    }
  }

  return warnings;
}

async function seedExistingRestMarkets(cfg, seen, pending, runtime = null, options = {}) {
  let currentMarkets = [];
  try {
    currentMarkets = await loadRestEventMarkets(cfg, { status: "all", limit: cfg.watchScanLimit });
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
      seededExistingMarkets: 0,
      catchUpLiveMarkets: 0,
      preparedFutureMarkets: 0
    };
  }

  let seededExistingMarkets = 0;
  const catchUpMarkets = [];
  let preparedFutureMarkets = 0;
  for (const market of currentMarkets) {
    if (msUntilStart(market) > 0) {
      const record = await preparePendingRecord(cfg, market, runtime);
      if (record.preparedPlan) preparedFutureMarkets += 1;
      pending.set(eventSeenKey(market, cfg), record);
      recordMarketDecision(cfg, pendingMarket(record), "pending", {
        source: "startup-rest-seed",
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null,
        message: record.prepareError ?? null
      });
    } else if (shouldCatchUpLiveMarket(cfg, market, options)) {
      catchUpMarkets.push(market);
    } else {
      markSkippedIfExpired(cfg, seen, market, "startup-rest-open-window") ||
        seen.add(eventSeenKey(market, cfg));
      seededExistingMarkets += 1;
    }
  }
  if (catchUpMarkets.length > 0) {
    await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByStartAsc(catchUpMarkets), runtime, {
      source: "startup-rest-catchup",
      hydrateDueOdds: true,
      hydrationSkipReason: "funding_recovery_catchup"
    });
  }
  saveSeen(cfg.stateFile, seen);
  return {
    ok: true,
    message: null,
    seededExistingMarkets,
    catchUpLiveMarkets: catchUpMarkets.length,
    preparedFutureMarkets
  };
}

async function seedRecentChainMarkets(cfg, seen, pending, runtime = null, options = {}) {
  const chain = await loadChainEventMarkets(cfg, { lookbackBlocks: cfg.eventLogLookbackBlocks });
  let seededSeen = 0;
  let pendingFuture = 0;
  let preparedFuture = 0;
  const catchUpMarkets = [];
  let skipped = 0;

  for (const market of sortMarketsByChainDesc(chain.decoded)) {
    const key = eventSeenKey(market, cfg);
    if (seen.has(key) || pending.has(key)) continue;
    const decision = marketFilterDecision(market, cfg);
    if (!decision.eligible) {
      recordMarketDecision(cfg, market, "filtered", {
        source: "startup-chain-replay",
        decision
      });
      seen.add(key);
      skipped += 1;
    } else if (msUntilStart(market) > 0) {
      const record = await preparePendingRecord(cfg, market, runtime);
      if (record.preparedPlan) preparedFuture += 1;
      pending.set(key, record);
      pendingFuture += 1;
      recordMarketDecision(cfg, pendingMarket(record), "pending", {
        source: "startup-chain-replay",
        decision,
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null,
        message: record.prepareError ?? null
      });
    } else if (shouldCatchUpLiveMarket(cfg, market, options)) {
      catchUpMarkets.push(market);
    } else {
      markSkippedIfExpired(cfg, seen, market, "startup-chain-open-window") ||
        seen.add(key);
      seededSeen += 1;
    }
  }
  if (catchUpMarkets.length > 0) {
    await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByStartAsc(catchUpMarkets), runtime, {
      source: "startup-chain-catchup",
      hydrateDueOdds: true,
      hydrationSkipReason: "funding_recovery_catchup"
    });
  }
  skipped += chain.decodeErrors.length;
  saveSeen(cfg.stateFile, seen);
  return {
    fromBlock: chain.fromBlock,
    toBlock: chain.head,
    checkedLogs: chain.controllerLogs,
    createNewMarketLogs: chain.createNewMarketLogs,
    seededSeen,
    catchUpLiveMarkets: catchUpMarkets.length,
    pendingFuture,
    preparedFuture,
    skipped,
    decodeErrors: chain.decodeErrors.length
  };
}

function shouldCatchUpLiveMarket(cfg, market, options = {}) {
  const recovery = options.fundingRecovery;
  if (!cfg.armCatchUpAfterFunding || !recovery?.enabled) return false;
  const start = new Date(market.startDate).getTime();
  if (!Number.isFinite(start)) return false;
  const now = Date.now();
  if (start > now) return false;

  const end = new Date(market.endDate).getTime();
  if (Number.isFinite(end) && now >= end) return false;
  if (cfg.allowLateBuy) return true;
  if (cfg.armCatchUpWindowMs <= 0) return false;
  return now - start <= Math.min(cfg.armCatchUpWindowMs, eventOpenWindowMs(cfg));
}

async function watchWs(cfg, seen, runtime, initialPending = new Map(), options = {}) {
  const { seedStartup = false } = options;
  const { publicClient } = makeClients(cfg);
  const wsClient = makeWsClient(cfg);
  const pending = new Map(initialPending);
  attachRuntimePendingBuyRecords(runtime, pending);
  const queue = [];
  const txBuffers = new Map();
  const wakeSignal = createWakeSignal();
  const restDiscovery = createRestDiscoveryState();
  const rpcKeepalive = createRpcKeepaliveState();
  const dueExecution = createDueExecutionState();
  let wsFailed = false;
  let consecutiveErrors = 0;

  const unwatch = watchControllerLogs(wsClient, {
    onLogs: (logs) => {
      queue.push(...logs);
      wakeSignal.wake();
    },
    onError: (error) => {
      wsFailed = true;
      wakeSignal.wake();
      console.error(JSON.stringify({ level: "error", message: errorMessage(error), at: new Date().toISOString() }));
      notifyFeishu(cfg, {
        title: "WS 监听异常",
        level: "warn",
        fields: { message: errorMessage(error) },
        dedupeKey: "ws-subscription-error",
        cooldownMs: cfg.feishuAlertCooldownMs
      });
    }
  });

  console.log(JSON.stringify({ level: "ws-watch", url: redactSecretUrls(cfg.wsUrl) }));

  if (seedStartup) {
    const warnings = await seedStartupMarkets(cfg, seen, pending, runtime, options);
    scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
    console.log(JSON.stringify({
      level: "startup-after-ws-subscribe",
      pendingFutureMarkets: pending.size,
      startupWarnings: warnings
    }));
  }

  while (true) {
    try {
      await preSignHotPendingMarkets(cfg, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      await drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, dueExecution, "ws-loop");

      while (queue.length > 0) addBufferedControllerLog(txBuffers, queue.shift());
      await drainControllerLogBuffers(publicClient, txBuffers, cfg, seen, pending, runtime);
      await preSignHotPendingMarkets(cfg, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      maybeStartBroadcastRpcKeepalive(cfg, pending, rpcKeepalive);
      await drainRestDiscoveryCandidates(cfg, seen, pending, runtime, restDiscovery);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      maybeStartRestDiscoveryPoll(cfg, seen, pending, restDiscovery, wakeSignal);

      if (wsFailed) throw new Error("WebSocket event subscription failed");
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      console.error(JSON.stringify({ level: "error", message: errorMessage(error), at: new Date().toISOString() }));
      if (consecutiveErrors >= 3) {
        unwatch?.();
        console.error(JSON.stringify({
          level: "warn",
          message: "ws discovery failed repeatedly; falling back to chain polling",
          at: new Date().toISOString()
        }));
        notifyFeishu(cfg, {
          title: "WS 已降级",
          level: "warn",
          fields: { fallback: "chain polling" },
          dedupeKey: "ws-fallback-chain",
          cooldownMs: cfg.feishuAlertCooldownMs
        });
        await watchChain(cfg, seen, runtime, pending);
        return;
      }
    }
    await wakeSignal.wait(nextWatchSleepMs(cfg, pending));
  }
}

function createRpcKeepaliveState() {
  return {
    nextRunAt: 0,
    running: false
  };
}

function createDueExecutionState() {
  return {
    timers: new Map(),
    running: false,
    rerun: false
  };
}

async function drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, state, source = "due-loop") {
  if (!state) return drainDuePendingMarkets(cfg, seen, pending, runtime);
  if (state.running) {
    state.rerun = true;
    return false;
  }
  state.running = true;
  try {
    let didWork = false;
    do {
      state.rerun = false;
      didWork = (await drainDuePendingMarkets(cfg, seen, pending, runtime)) || didWork;
    } while (state.rerun);
    return didWork;
  } finally {
    state.running = false;
    scheduleDuePendingMarkets(cfg, seen, pending, runtime, state, source);
  }
}

function scheduleDuePendingMarkets(cfg, seen, pending, runtime, state, source = "due-scheduler") {
  if (!state?.timers || !pending) return;
  const now = Date.now();
  const scheduleAheadMs = Number(cfg.openBroadcastScheduleAheadMs ?? 0);
  const activeKeys = new Set();

  for (const [key, record] of pending.entries()) {
    activeKeys.add(key);
    if (seen.has(key)) continue;
    const targetMs = marketActionTimeMs(pendingMarket(record), cfg);
    if (!Number.isFinite(targetMs)) continue;
    const waitMs = targetMs - now;
    if (waitMs < -eventOpenWindowMs(cfg)) continue;
    if (scheduleAheadMs > 0 && waitMs > scheduleAheadMs) continue;

    const existing = state.timers.get(key);
    if (existing?.targetMs === targetMs) continue;
    if (existing?.timer) clearTimeout(existing.timer);

    const delayMs = Math.max(0, waitMs - Number(cfg.openBroadcastSpinMs ?? 0));
    const timer = setTimeout(() => {
      void waitUntilBroadcastTarget(targetMs, Number(cfg.openBroadcastSpinMs ?? 0))
        .then(() => {
          if (!pending.has(key) || seen.has(key)) return false;
          return drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, state, "open-timer");
        })
        .catch((error) => {
          console.error(JSON.stringify({
            level: "warn",
            source: "open-broadcast-timer",
            message: errorMessage(error),
            market: pendingMarket(record)?.address,
            at: new Date().toISOString()
          }));
        })
        .finally(() => {
          state.timers.delete(key);
        });
    }, delayMs);
    timer.unref?.();
    state.timers.set(key, { targetMs, timer });
    console.log(JSON.stringify({
      level: "open-broadcast-scheduled",
      source,
      market: pendingMarket(record)?.address,
      question: pendingMarket(record)?.question,
      startDate: pendingMarket(record)?.startDate,
      targetAt: new Date(targetMs).toISOString(),
      waitMs: Math.max(0, waitMs),
      delayMs,
      spinMs: cfg.openBroadcastSpinMs,
      postOpenDelayMs: effectivePostOpenBroadcastDelayMs(cfg)
    }));
  }

  for (const [key, scheduled] of [...state.timers.entries()]) {
    if (activeKeys.has(key) && !seen.has(key)) continue;
    clearTimeout(scheduled.timer);
    state.timers.delete(key);
  }
}

async function waitUntilBroadcastTarget(targetMs, spinMs) {
  const spinBudgetMs = Math.max(0, Number(spinMs ?? 0));
  while (Date.now() < targetMs) {
    const remaining = targetMs - Date.now();
    if (remaining > spinBudgetMs) {
      await sleep(Math.max(1, remaining - spinBudgetMs));
      continue;
    }
    const spinStart = Date.now();
    while (Date.now() < targetMs && Date.now() - spinStart <= spinBudgetMs) {
      // Busy spin only inside the final configured milliseconds before open.
    }
    if (Date.now() < targetMs) await sleep(0);
  }
}

function maybeStartBroadcastRpcKeepalive(cfg, pending, state) {
  const intervalMs = Number(cfg.rpcKeepaliveMs ?? 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  if (!hasHotPendingMarket(cfg, pending)) return;
  const now = Date.now();
  if (state.running || now < state.nextRunAt) return;

  state.running = true;
  void warmBroadcastRpcClients(cfg, { includeGasPrice: false })
    .then((result) => {
      const failed = result.results?.filter((item) => !item.ok) ?? [];
      if (failed.length > 0) {
        console.error(JSON.stringify({
          level: "warn",
          source: "broadcast-rpc-keepalive",
          okCount: result.okCount,
          rpcCount: result.rpcCount,
          failed: failed.map((item) => ({ provider: item.provider, error: item.error })),
          at: new Date().toISOString()
        }));
      }
    })
    .catch((error) => {
      console.error(JSON.stringify({
        level: "warn",
        source: "broadcast-rpc-keepalive",
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
    })
    .finally(() => {
      state.nextRunAt = Date.now() + intervalMs;
      state.running = false;
    });
}

function hasHotPendingMarket(cfg, pending) {
  if (!pending || pending.size === 0) return false;
  return [...pending.values()].some((record) => {
    const waitMs = msUntilRecordAction(record, cfg);
    return waitMs <= cfg.preopenHotMs && waitMs >= -eventOpenWindowMs(cfg);
  });
}

async function watchRest(cfg, seen, runtime = null, initialPending = new Map()) {
  const pending = new Map(initialPending);
  attachRuntimePendingBuyRecords(runtime, pending);
  const dueExecution = createDueExecutionState();
  while (true) {
    try {
      await preSignHotPendingMarkets(cfg, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      await drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, dueExecution, "rest-loop");

      const markets = await loadEventMarkets(cfg, { limit: cfg.watchScanLimit });
      for (const market of [...markets].reverse()) {
        const executed = await maybeExecuteMarket(cfg, seen, market, { allowFuturePending: false, runtime });
        if (!executed && !seen.has(eventSeenKey(market, cfg)) && msUntilStart(market) > 0) {
          pending.set(eventSeenKey(market, cfg), await preparePendingRecord(cfg, market, runtime));
        }
      }
      await preSignHotPendingMarkets(cfg, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: errorMessage(error), at: new Date().toISOString() }));
    }
    await sleep(nextWatchSleepMs(cfg, pending));
  }
}

function createRestDiscoveryState() {
  return {
    nextPollAt: 0,
    running: false,
    seeded: false,
    knownMarketKeys: new Set(),
    candidates: []
  };
}

function maybeStartRestDiscoveryPoll(cfg, seen, pending, state, wakeSignal = null) {
  if (!cfg.restDiscoveryEnabled || cfg.eventDiscovery === "rest") return;
  const now = Date.now();
  if (state.running || now < state.nextPollAt) return;

  state.running = true;
  void runRestDiscoveryPoll(cfg, seen, pending, state)
    .catch((error) => {
      console.error(JSON.stringify({
        level: "warn",
        source: "rest-discovery-poll",
        message: errorMessage(error),
        retryInMs: cfg.restDiscoveryPollMs,
        at: new Date().toISOString()
      }));
      notifyFeishu(cfg, {
        title: "REST 补漏异常",
        level: "warn",
        fields: { message: errorMessage(error) },
        dedupeKey: "rest-discovery-error",
        cooldownMs: cfg.feishuAlertCooldownMs
      });
    })
    .finally(() => {
      state.nextPollAt = Date.now() + cfg.restDiscoveryPollMs;
      state.running = false;
      wakeSignal?.wake?.();
    });
}

async function runRestDiscoveryPoll(cfg, seen, pending, state) {
  const markets = await loadRawRestMarkets(cfg, { status: "all", limit: cfg.watchScanLimit });
  if (!state.seeded) {
    rememberRestDiscoveryMarkets(state, markets);
    state.seeded = true;
    console.log(JSON.stringify({
      level: "rest-discovery-seed",
      markets: markets.length,
      latestCreatedAt: markets[0]?.createdAt ?? null,
      latestQuestion: markets[0]?.question ?? null,
      at: new Date().toISOString()
    }));
    return;
  }

  const candidates = markets.filter((market) => {
    const rawKey = restDiscoveryMarketKey(market);
    if (!rawKey || state.knownMarketKeys.has(rawKey)) return false;
    const key = eventSeenKey(market, cfg);
    return !seen.has(key) && !pending.has(key);
  });
  rememberRestDiscoveryMarkets(state, markets);

  if (candidates.length === 0) return;
  const eligible = candidates.filter((market) => marketFilterDecision(market, cfg).eligible).length;
  console.log(JSON.stringify({
    level: "rest-discovery-poll",
    candidates: candidates.length,
    eligible,
    filtered: candidates.length - eligible,
    at: new Date().toISOString()
  }));
  state.candidates.push(...candidates);
}

async function drainRestDiscoveryCandidates(cfg, seen, pending, runtime, state) {
  if (!state.candidates?.length) return;
  const candidates = state.candidates.splice(0);
  const fresh = candidates.filter((market) => {
    const key = eventSeenKey(market, cfg);
    return !seen.has(key) && !pending.has(key);
  });
  if (fresh.length === 0) return;
  await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByStartAsc(fresh), runtime, {
    source: "rest-discovery-poll",
    hydrateDueOdds: true,
    hydrationSkipReason: "rest_discovery_poll"
  });
}

async function maybePollRestDiscovery(cfg, seen, pending, runtime, state) {
  if (!cfg.restDiscoveryEnabled || cfg.eventDiscovery === "rest") return;
  const now = Date.now();
  if (state.running || now < state.nextPollAt) return;

  state.running = true;
  try {
    const markets = await loadRawRestMarkets(cfg, { status: "all", limit: cfg.watchScanLimit });
    if (!state.seeded) {
      rememberRestDiscoveryMarkets(state, markets);
      state.seeded = true;
      console.log(JSON.stringify({
        level: "rest-discovery-seed",
        markets: markets.length,
        latestCreatedAt: markets[0]?.createdAt ?? null,
        latestQuestion: markets[0]?.question ?? null,
        at: new Date().toISOString()
      }));
      return;
    }

    const candidates = markets.filter((market) => {
      const rawKey = restDiscoveryMarketKey(market);
      if (!rawKey || state.knownMarketKeys.has(rawKey)) return false;
      const key = eventSeenKey(market, cfg);
      return !seen.has(key) && !pending.has(key);
    });
    rememberRestDiscoveryMarkets(state, markets);

    if (candidates.length > 0) {
      const eligible = candidates.filter((market) => marketFilterDecision(market, cfg).eligible).length;
      console.log(JSON.stringify({
        level: "rest-discovery-poll",
        candidates: candidates.length,
        eligible,
        filtered: candidates.length - eligible,
        at: new Date().toISOString()
      }));
      await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByStartAsc(candidates), runtime, {
        source: "rest-discovery-poll",
        hydrateDueOdds: true,
        hydrationSkipReason: "rest_discovery_poll"
      });
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      source: "rest-discovery-poll",
      message: errorMessage(error),
      retryInMs: cfg.restDiscoveryPollMs,
      at: new Date().toISOString()
    }));
    notifyFeishu(cfg, {
      title: "REST 补漏异常",
      level: "warn",
      fields: { message: errorMessage(error) },
      dedupeKey: "rest-discovery-error",
      cooldownMs: cfg.feishuAlertCooldownMs
    });
  } finally {
    state.nextPollAt = Date.now() + cfg.restDiscoveryPollMs;
    state.running = false;
  }
}

function rememberRestDiscoveryMarkets(state, markets) {
  for (const market of markets) {
    const key = restDiscoveryMarketKey(market);
    if (key) state.knownMarketKeys.add(key);
  }
  if (state.knownMarketKeys.size <= 2000) return;
  const keep = markets.map(restDiscoveryMarketKey).filter(Boolean);
  state.knownMarketKeys = new Set(keep);
}

function restDiscoveryMarketKey(market) {
  if (market?.address) return String(market.address).toLowerCase();
  if (market?.question || market?.createdAt) return `${market.question ?? ""}:${market.createdAt ?? ""}`;
  return null;
}

async function watchChain(cfg, seen, runtime = null, initialPending = new Map()) {
  const { publicClient } = makeClients(cfg);
  let fromBlock = await waitForInitialChainBlock(cfg, publicClient);
  if (cfg.eventLogLookbackBlocks > 0) {
    fromBlock -= BigInt(cfg.eventLogLookbackBlocks);
  }
  let consecutiveErrors = 0;
  const pending = new Map(initialPending);
  attachRuntimePendingBuyRecords(runtime, pending);
  const restDiscovery = createRestDiscoveryState();
  const dueExecution = createDueExecutionState();

  console.log(JSON.stringify({ level: "chain-watch", fromBlock: fromBlock.toString() }));

  while (true) {
    try {
      await preSignHotPendingMarkets(cfg, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      await drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, dueExecution, "chain-loop");
      await drainRestDiscoveryCandidates(cfg, seen, pending, runtime, restDiscovery);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      maybeStartRestDiscoveryPoll(cfg, seen, pending, restDiscovery);

      const toBlock = await publicClient.getBlockNumber();
      if (toBlock >= fromBlock) {
        const logs = await fetchControllerLogs(publicClient, { fromBlock, toBlock, chunkSize: cfg.logChunkBlocks });
        const { decoded, decodeErrors } = await decodeControllerMarketLogs(publicClient, logs, {
          createdAt: new Date().toISOString(),
          fallback: true
        });
        await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByChainDesc(decoded), runtime, {
          source: "chain-watch"
        });
        for (const error of decodeErrors) {
          console.error(JSON.stringify({ level: "warn", source: "chain-decode", ...error }));
        }
        await preSignHotPendingMarkets(cfg, pending, runtime);
        scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
        fromBlock = toBlock + 1n;
        consecutiveErrors = 0;
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: errorMessage(error), at: new Date().toISOString() }));
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        console.error(JSON.stringify({
          level: "warn",
          message: "chain discovery failed repeatedly; falling back to REST polling",
          at: new Date().toISOString()
        }));
        notifyFeishu(cfg, {
          title: "链上轮询已降级",
          level: "warn",
          fields: { fallback: "REST polling" },
          dedupeKey: "chain-fallback-rest",
          cooldownMs: cfg.feishuAlertCooldownMs
        });
        await watchRest(cfg, seen, runtime, pending);
        return;
      }
    }
    await sleep(nextWatchSleepMs(cfg, pending));
  }
}

async function waitForInitialChainBlock(cfg, publicClient) {
  while (true) {
    try {
      return await publicClient.getBlockNumber();
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        source: "chain-watch-startup",
        message: errorMessage(error),
        retryInMs: cfg.watchStartupRetryMs,
        at: new Date().toISOString()
      }));
      await sleep(cfg.watchStartupRetryMs);
    }
  }
}

async function drainControllerLogBuffers(publicClient, txBuffers, cfg, seen, pending, runtime) {
  const now = Date.now();
  for (const [txHash, bucket] of [...txBuffers]) {
    if (!bucket.logs.some(isCreationLog)) continue;

    const hasOutcomeData = bucket.logs.some(
      (log) => log.eventName === "CreateNewQuestionV2" || log.eventName === "AddOutcome"
    );
    const fallback = hasOutcomeData || now - bucket.firstSeenMs >= cfg.wsReceiptFallbackMs;
    const { decoded, decodeErrors } = await decodeControllerMarketLogs(publicClient, bucket.logs, {
      createdAt: new Date().toISOString(),
      fallback
    });
    if (decoded.length === 0) {
      if (!fallback) continue;
      bucket.fallbackAttempts = (bucket.fallbackAttempts ?? 0) + 1;
      if (bucket.fallbackAttempts <= cfg.wsReceiptFallbackRetries) {
        console.error(JSON.stringify({
          level: "warn",
          source: "ws-receipt-fallback",
          transactionHash: txHash,
          attempts: bucket.fallbackAttempts,
          errors: decodeErrors
        }));
        continue;
      }
    }

    txBuffers.delete(txHash);
    await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByChainDesc(decoded), runtime, {
      source: "ws-watch"
    });
    for (const error of decodeErrors) {
      console.error(JSON.stringify({ level: "warn", source: "ws-decode", ...error }));
    }
  }
}

async function drainDuePendingMarkets(cfg, seen, pending, runtime) {
  skipExpiredPendingMarkets(cfg, seen, pending, "pending-open-window");
  await dropFollowBlockedPendingRecords(cfg, seen, pending, runtime, "pending-follow-blocked");
  const dueRecords = [...pending.values()].filter((record) => {
    return msUntilRecordAction(record, cfg) <= 0;
  });
  if (dueRecords.length === 0) return false;

  let didWork = false;
  const fundingBlockedKeys = new Set();
  if (cfg.bundleDueMarkets && cfg.eventBuyMode === "fast") {
    const handled = new Set();
    const preSignedGroups = groupPreSignedBundleRecords(dueRecords);
    for (const records of preSignedGroups) {
      const ok = await executeDueBundle(cfg, seen, pending, runtime, records);
      didWork = true;
      if (ok || records.every((record) => seen.has(eventSeenKey(pendingMarket(record), cfg)))) {
        for (const record of records) handled.add(eventSeenKey(pendingMarket(record), cfg));
      }
    }
    for (const key of handled) pending.delete(key);

    const grouped = groupRecordsByStartDate(dueRecords.filter((record) => {
      const key = eventSeenKey(pendingMarket(record), cfg);
      return !handled.has(key) && !hasPreSignedBundle(record);
    }));
    for (const records of grouped.values()) {
      if (!records.every((record) => record.preparedPlan)) continue;
      const affordable = await selectAffordableDueRecords(cfg, records, "due-bundle");
      for (const record of affordable.skipped) {
        fundingBlockedKeys.add(eventSeenKey(pendingMarket(record), cfg));
      }
      markFundingBlockedRecords(cfg, affordable.skipped, affordable.walletStatus, "due-bundle");
      if (affordable.selected.length <= 1) continue;
      const ok = await executeDueBundle(cfg, seen, pending, runtime, affordable.selected);
      didWork = true;
      if (ok) {
        for (const record of affordable.selected) handled.add(eventSeenKey(pendingMarket(record), cfg));
      }
    }
    for (const key of handled) pending.delete(key);
  }

  for (const record of [...pending.values()]) {
    const market = pendingMarket(record);
    if (fundingBlockedKeys.has(eventSeenKey(market, cfg))) continue;
    if (msUntilRecordAction(record, cfg) > 0) continue;
    if (hasPreSignedBundle(record)) continue;
    if (!hasPreSignedSingle(record)) {
      const affordable = await selectAffordableDueRecords(cfg, [record], "due-single");
      if (affordable.selected.length === 0) {
        markFundingBlockedRecords(cfg, affordable.skipped, affordable.walletStatus, "due-single");
        continue;
      }
    }
    const executed = await maybeExecuteMarket(cfg, seen, market, {
      allowFuturePending: false,
      runtime,
      preparedPlan: record.preparedPlan,
      preSignedFastTransaction: record.preSignedFastTransaction,
      hydrateOdds: false,
      hydrationSkipReason: "due_pending_record",
      retryRecord: record
    });
    didWork = true;
    if (executed || seen.has(eventSeenKey(market, cfg))) {
      pending.delete(eventSeenKey(market, cfg));
    }
  }
  return didWork;
}

function groupPreSignedBundleRecords(records) {
  const byHash = new Map();
  for (const record of records) {
    const hash = record?.preSignedFastBundleTransaction?.txHash;
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(record);
  }
  return [...byHash.values()].filter((group) => reusablePreSignedBundle(group));
}

async function executeDueBundle(cfg, seen, pending, runtime, records) {
  const markets = records.map((record) => pendingMarket(record));
  const blockedRecords = records.filter((record) => isMarketFollowBlocked(pendingMarket(record), cfg));
  if (blockedRecords.length > 0) {
    clearPreSignedBundleRecords(records, "follow-blocked");
    await resetRuntimeNonceToPending(cfg, runtime, "bundle_follow_blocked");
    for (const record of blockedRecords) {
      markFollowBlockedPendingRecord(cfg, seen, pending, record, "bundle-follow-blocked");
    }
    saveSeen(cfg.stateFile, seen);
    return false;
  }
  if (records.some((record) => markSkippedIfExpired(cfg, seen, pendingMarket(record), "bundle-open-window"))) {
    saveSeen(cfg.stateFile, seen);
    return false;
  }
  try {
    let bundle = reusablePreSignedBundle(records);
    if (!bundle) {
      if (records.some(hasPreSignedBundle)) {
        clearPreSignedBundleRecords(records, "bundle_changed_before_open");
        await resetRuntimeNonceToPending(cfg, runtime, "bundle_changed_before_open");
      }
      bundle = buildFastBuyBundlePlan(
        cfg,
        records.map((record) => record.preparedPlan),
        runtime?.receiverAddress || cfg.walletAddress || "0x0000000000000000000000000000000000000001"
      );
    }
    const result = await executeOrPrintBundle(bundle, cfg, runtime);
    appendJsonl(cfg.fillsFile, {
      bundle: describeFastBundlePlan(bundle),
      result,
      at: new Date().toISOString()
    });
    if (!executionMarksSeen(result)) {
      const terminal = isTerminalMinedFailure(result);
      const preopen = terminal && records.some((record) => isPreopenBroadcastResult(result, pendingMarket(record)));
      if (terminal && preopen && records.some((record) => !isPastEventOpenWindow(cfg, pendingMarket(record)))) {
        clearPreSignedBundleRecords(records, `terminal_${result.status}_preopen`);
        await resetRuntimeNonceToPending(cfg, runtime, `bundle_terminal_${result.status}_preopen`);
      } else if (terminal) {
        for (const market of markets) seen.add(eventSeenKey(market, cfg));
        saveSeen(cfg.stateFile, seen);
      }
      if (!terminal || preopen) {
        for (const record of records) markExecutionRetry(record, cfg, new Error(`execution status ${result.status ?? "unknown"}`));
      }
      for (const market of markets) {
        recordMarketDecision(cfg, market, "execution-unconfirmed", {
          source: "bundle-execution",
          message: `execution status ${result.status ?? "unknown"}`,
          txHash: result.txHash ?? null
        });
      }
      console.error(JSON.stringify({
        level: "warn",
        source: "bundle-execution",
        message: `Execution not confirmed successful: ${result.status ?? "unknown"}`,
        markets: markets.map((market) => market.address),
        retryInMs: terminal && !preopen ? null : cfg.executionRetryMs,
        at: new Date().toISOString()
      }));
      return false;
    }
    for (const record of records) clearExecutionRetry(record);
    for (const market of markets) {
      seen.add(eventSeenKey(market, cfg));
      recordMarketDecision(cfg, market, buyDecisionAction(result), {
        source: "bundle-execution",
        mode: result?.dryRun ? "dry-run" : "execute",
        txHash: result.txHash ?? null
      });
    }
    saveSeen(cfg.stateFile, seen);
    notifyFeishu(cfg, {
      title: result?.status === "broadcast" ? "买入已广播" : "买入成功",
      fields: {
        type: "bundle",
        markets: markets.length,
        status: result?.status ?? "",
        stake: `${bundle.totalStakeUsdt}U`,
        rankSource: [...new Set(bundle.markets.map((market) => market.selection?.rankSource).filter(Boolean))].join(","),
        fallback: [...new Set(bundle.markets.map((market) => market.selection?.fallbackReason).filter(Boolean))].join(","),
        tx: result.txHash
      }
    });
    return true;
  } catch (error) {
    for (const record of records) markExecutionRetry(record, cfg, error);
    for (const market of markets) {
      recordMarketDecision(cfg, market, "execution-error", {
        source: "bundle-execution",
        message: errorMessage(error)
      });
    }
    console.error(JSON.stringify({
      level: "warn",
      source: "bundle-execution",
      message: errorMessage(error),
      markets: markets.map((market) => market.address),
      retryInMs: cfg.executionRetryMs,
      at: new Date().toISOString()
    }));
    notifyFeishu(cfg, {
      title: "买入失败",
      level: "warn",
      fields: {
        type: "bundle",
        markets: markets.length,
        message: errorMessage(error)
      }
    });
    return false;
  }
}

async function preSignHotPendingMarkets(cfg, pending, runtime) {
  if (!shouldPreSignFastTransactions(cfg, runtime)) return;
  const now = Date.now();
  const fundingBlockedKeys = new Set();
  if (cfg.bundleDueMarkets && cfg.eventBuyMode === "fast") {
    const grouped = groupRecordsByStartDate([...pending.values()].filter((record) => {
      if (isMarketFollowBlocked(pendingMarket(record), cfg)) return false;
      if (
        !record.preparedPlan ||
        record.preSignedFastBundleTransaction ||
        !canRetryPreSign(record.bundlePreSignError, record.bundlePreSignRetryAfterMs, now, cfg)
      ) return false;
      const actionWaitMs = msUntilAction(pendingMarket(record), cfg);
      return actionWaitMs > 0 && actionWaitMs <= cfg.preSignWindowMs;
    }));

    for (const records of grouped.values()) {
      const affordable = await selectAffordableDueRecords(cfg, records, "pre-sign-bundle");
      for (const record of affordable.skipped) {
        fundingBlockedKeys.add(eventSeenKey(pendingMarket(record), cfg));
      }
      markFundingBlockedRecords(cfg, affordable.skipped, affordable.walletStatus, "pre-sign-bundle");
      if (affordable.selected.length <= 1) continue;
      await syncRuntimeNonceBeforePreSign(cfg, runtime, { reason: "bundle" });
      await attachPreSignedFastBundleTransaction(cfg, affordable.selected, runtime);
    }
  }

  const records = [...pending.values()]
    .filter((record) => {
      if (fundingBlockedKeys.has(eventSeenKey(pendingMarket(record), cfg))) return false;
      if (isMarketFollowBlocked(pendingMarket(record), cfg)) return false;
      if (
        !record.preparedPlan ||
        record.preSignedFastTransaction ||
        record.preSignedFastBundleTransaction ||
        !canRetryPreSign(record.preSignError, record.preSignRetryAfterMs, now, cfg)
      ) return false;
      const actionWaitMs = msUntilAction(pendingMarket(record), cfg);
      return actionWaitMs > 0 && actionWaitMs <= cfg.preSignWindowMs;
    })
    .sort((a, b) => compareStartAsc(pendingMarket(a), pendingMarket(b)));

  for (const record of records) {
    await syncRuntimeNonceBeforePreSign(cfg, runtime, { reason: "single" });
    await attachPreSignedFastTransaction(cfg, record, runtime);
  }
}

async function syncRuntimeNonceBeforePreSign(cfg, runtime, { reason }) {
  if (
    !cfg.nonceSyncBeforePreSign ||
    !runtime ||
    runtime.nextNonce === undefined ||
    cfg.dryRun ||
    !cfg.execute
  ) return;

  const now = Date.now();
  if (
    runtime.lastNonceSyncAt &&
    now - runtime.lastNonceSyncAt < cfg.nonceSyncMinIntervalMs
  ) return;

  const { publicClient, account } = makeClients(cfg);
  if (!account) return;
  const pendingNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  });
  runtime.lastNonceSyncAt = Date.now();
  if (pendingNonce > runtime.nextNonce) {
    const previousNonce = runtime.nextNonce;
    runtime.nextNonce = pendingNonce;
    console.error(JSON.stringify({
      level: "warn",
      source: "nonce-sync-before-presign",
      reason,
      previousNonce,
      pendingNonce,
      at: new Date().toISOString()
    }));
  }
}

async function attachPreSignedFastBundleTransaction(cfg, records, runtime) {
  if (!records.every((record) => record.preparedPlan)) return;
  if (records.some((record) => record.preSignedFastBundleTransaction)) return;
  if (runtimeTransactionBusy(runtime)) {
    const retryAfterMs = Date.now() + cfg.preSignRetryMs;
    for (const record of records) {
      record.bundlePreSignError = `transaction lock busy: ${runtime.txLock.owner}`;
      record.bundlePreSignAttempts = (record.bundlePreSignAttempts ?? 0) + 1;
      record.bundlePreSignRetryAfterMs = retryAfterMs;
    }
    return;
  }
  pauseRuntimeAutoSell(runtime, cfg, "bundle-presign-start");
  try {
    const bundle = buildFastBuyBundlePlan(
      cfg,
      records.map((record) => record.preparedPlan),
      runtime?.receiverAddress || cfg.walletAddress || "0x0000000000000000000000000000000000000001"
    );
    const signed = await withRuntimeTransactionLock(
      runtime,
      "pre-sign-bundle",
      () => preSignFastBundleTransaction(cfg, bundle, runtime)
    );
    pauseRuntimeAutoSell(runtime, cfg, "bundle-presigned-buy");
    for (const record of records) {
      record.preSignedFastBundleTransaction = signed;
      record.preSignedFastBundle = { ...bundle, preSignedFastBundleTransaction: signed };
      record.bundlePreSignedAt = new Date().toISOString();
      record.bundlePreSignError = null;
      record.bundlePreSignRetryAfterMs = null;
    }
    console.log(JSON.stringify({
      level: "pre-signed-fast-bundle-tx",
      txHash: signed.txHash,
      nonce: signed.nonce,
      marketCount: signed.marketCount,
      outcomeCount: signed.outcomeCount,
      markets: bundle.markets.map((market) => market.address),
      startDate: pendingMarket(records[0]).startDate,
      msUntilAction: msUntilAction(pendingMarket(records[0]), cfg)
    }));
  } catch (error) {
    const retryAfterMs = Date.now() + cfg.preSignRetryMs;
    for (const record of records) {
      record.bundlePreSignError = errorMessage(error);
      record.bundlePreSignAttempts = (record.bundlePreSignAttempts ?? 0) + 1;
      record.bundlePreSignRetryAfterMs = retryAfterMs;
    }
    console.error(JSON.stringify({
      level: "warn",
      source: "pre-sign-bundle",
      message: errorMessage(error),
      attempts: records[0]?.bundlePreSignAttempts ?? 1,
      retryInMs: cfg.preSignRetryMs,
      startDate: pendingMarket(records[0])?.startDate ?? null
    }));
  }
}

function reusablePreSignedBundle(records) {
  const first = records.find((record) => record.preSignedFastBundle);
  const bundle = first?.preSignedFastBundle;
  if (!bundle?.preSignedFastBundleTransaction) return null;

  const expectedHash = bundle.preSignedFastBundleTransaction.txHash;
  const expectedMarkets = new Set(bundle.markets.map((market) => String(market.address).toLowerCase()));
  if (expectedMarkets.size !== records.length) return null;

  const allSame = records.every((record) => {
    const market = pendingMarket(record);
    return (
      expectedMarkets.has(String(market.address).toLowerCase()) &&
      record.preSignedFastBundleTransaction?.txHash === expectedHash &&
      record.preSignedFastBundle?.preSignedFastBundleTransaction?.txHash === expectedHash
    );
  });
  return allSame ? bundle : null;
}

function hasPreSignedBundle(record) {
  return Boolean(record?.preSignedFastBundleTransaction || record?.preSignedFastBundle);
}

function clearPreSignedBundleRecords(records, reason) {
  let cleared = false;
  for (const record of records) {
    if (!hasPreSignedBundle(record)) continue;
    record.preSignedFastBundleTransaction = null;
    record.preSignedFastBundle = null;
    record.bundlePreSignedAt = null;
    record.bundlePreSignDiscardReason = reason;
    cleared = true;
  }
  if (!cleared) return;
  console.error(JSON.stringify({
    level: "warn",
    source: "pre-sign-bundle-discarded",
    reason,
    markets: records.map((record) => pendingMarket(record).address),
    at: new Date().toISOString()
  }));
}

function hasPreSignedSingle(record) {
  return Boolean(record?.preSignedFastTransaction);
}

function clearPreSignedSingleRecord(record, reason, result = null) {
  if (!hasPreSignedSingle(record)) return;
  const market = pendingMarket(record);
  record.preSignedFastTransaction = null;
  record.preSignedAt = null;
  record.preSignDiscardReason = reason;
  console.error(JSON.stringify({
    level: "warn",
    source: "pre-sign-single-discarded",
    reason,
    market: market?.address,
    question: market?.question,
    txHash: result?.txHash ?? null,
    status: result?.status ?? null,
    blockNumber: result?.blockNumber ?? null,
    at: new Date().toISOString()
  }));
}

async function resetRuntimeNonceToPending(cfg, runtime, reason) {
  if (!runtime || runtime.nextNonce === undefined || cfg.dryRun || !cfg.execute) return;
  const { publicClient, account } = makeClients(cfg);
  if (!account) return;
  const pendingNonce = Number(await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  }));
  const previousNonce = runtime.nextNonce;
  runtime.nextNonce = pendingNonce;
  runtime.lastNonceSyncAt = Date.now();
  if (previousNonce !== pendingNonce) {
    console.error(JSON.stringify({
      level: "warn",
      source: "nonce-reset-after-presign-discard",
      reason,
      previousNonce,
      pendingNonce,
      at: new Date().toISOString()
    }));
  }
}

async function handleDiscoveredMarkets(cfg, seen, pending, markets, runtime, options = {}) {
  const immediateRecords = [];
  const source = options.source ?? "discovery";
  for (const market of markets) {
    const key = eventSeenKey(market, cfg);
    if (seen.has(key) || pending.has(key)) continue;
    const decision = marketFilterDecision(market, cfg);
    if (!decision.eligible) {
      recordMarketDecision(cfg, market, "filtered", { source, decision });
      seen.add(key);
      saveSeen(cfg.stateFile, seen);
      continue;
    }
    recordMarketDecision(cfg, market, "discovered", { source, decision });
    if (markSkippedIfExpired(cfg, seen, market, "discovery-open-window")) {
      saveSeen(cfg.stateFile, seen);
      continue;
    }

    const dueNow = msUntilAction(market, cfg) <= 0;
    const shouldHydrateDueOdds = Boolean(options.hydrateDueOdds);
    const record = await preparePendingRecord(cfg, market, runtime, {
      hydrateOdds: !(dueNow && cfg.fastSkipDueRestHydration && !shouldHydrateDueOdds),
      hydrationSkipReason: dueNow ? (options.hydrationSkipReason ?? "due_fast_path") : null
    });
    if (record.prepareError) {
      recordMarketDecision(cfg, pendingMarket(record), "prepare-error", {
        source,
        decision,
        message: record.prepareError
      });
    }
    if (dueNow) {
      recordMarketDecision(cfg, pendingMarket(record), "due", {
        source,
        decision,
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null
      });
      notifyWillBuyMarket(cfg, pendingMarket(record), record, {
        source,
        state: "立即买入"
      });
      immediateRecords.push(record);
      continue;
    }

    await maybeExecuteMarket(cfg, seen, market, {
      allowFuturePending: true,
      runtime,
      preparedPlan: record.preparedPlan,
      preSignedFastTransaction: record.preSignedFastTransaction,
      retryRecord: record
    });
    if (!seen.has(key)) {
      pending.set(key, record);
      recordMarketDecision(cfg, pendingMarket(record), "pending", {
        source,
        decision,
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null
      });
      notifyWillBuyMarket(cfg, pendingMarket(record), record, {
        source,
        state: "待开盘"
      });
    }
  }

  if (immediateRecords.length === 0) return;
  const fundingBlockedKeys = new Set();
  if (cfg.bundleDueMarkets && cfg.eventBuyMode === "fast") {
    const grouped = groupRecordsByStartDate(immediateRecords);
    const bundled = new Set();
    for (const records of grouped.values()) {
      if (records.length <= 1 || !records.every((record) => record.preparedPlan)) continue;
      const affordable = await selectAffordableDueRecords(cfg, records, "immediate-bundle");
      for (const record of affordable.skipped) {
        fundingBlockedKeys.add(eventSeenKey(pendingMarket(record), cfg));
      }
      markFundingBlockedRecords(cfg, affordable.skipped, affordable.walletStatus, "immediate-bundle");
      if (affordable.selected.length <= 1) continue;
      const ok = await executeDueBundle(cfg, seen, pending, runtime, affordable.selected);
      if (ok) {
        for (const record of affordable.selected) bundled.add(eventSeenKey(pendingMarket(record), cfg));
      }
    }
    if (bundled.size > 0) {
      console.log(JSON.stringify({
        level: "immediate-discovery-bundle",
        marketCount: bundled.size,
        at: new Date().toISOString()
      }));
    }
  }

  for (const record of immediateRecords) {
    const market = pendingMarket(record);
    const key = eventSeenKey(market, cfg);
    if (seen.has(key)) continue;
    if (fundingBlockedKeys.has(key)) continue;
    const executed = await maybeExecuteMarket(cfg, seen, market, {
      allowFuturePending: false,
      runtime,
      preparedPlan: record.preparedPlan,
      preSignedFastTransaction: record.preSignedFastTransaction,
      hydrateOdds: false,
      hydrationSkipReason: "immediate_discovery_fast_path",
      retryRecord: record
    });
    if (!executed && !seen.has(key)) pending.set(key, record);
  }
}

function notifyWillBuyMarket(cfg, market, record, { source, state } = {}) {
  if (cfg.dryRun || !cfg.execute) return;
  if (!record?.preparedPlan) return;
  if (!shouldNotifyWillBuySource(source)) return;
  const plan = record.preparedPlan;
  notifyFeishu(cfg, {
    title: "新盘准备买入",
    fields: {
      状态: state,
      来源: formatAlertSource(source),
      事件: market.question,
      开盘: market.startDate,
      结束: market.endDate,
      时长: formatDuration(market),
      买入: `${plan.outcomes?.length ?? selectedOutcomeCount(market, cfg)}档 / ${roundUsd(plan.totalStakeUsdt ?? selectedStakeUsdt(market, cfg))}U`,
      排序: plan.selection?.rankSource ?? "",
      兜底: plan.selection?.fallbackReason ?? ""
    },
    dedupeKey: `will-buy:${String(market.address).toLowerCase()}`,
    cooldownMs: WILL_BUY_ALERT_COOLDOWN_MS
  });
}

function shouldNotifyWillBuySource(source) {
  return !String(source ?? "").startsWith("startup-");
}

function formatAlertSource(source) {
  const value = String(source ?? "");
  const lower = value.toLowerCase();
  const hasWebsite = lower.includes("rest") || value.includes("官网") || lower.includes("website");
  const hasChain = lower.includes("ws") || lower.includes("chain") || lower.includes("controller") || value.includes("链上");
  if (hasWebsite && hasChain) return "官网 + 链上";
  if (hasWebsite) return "官网";
  if (hasChain) return "链上";
  return value || "监控";
}

async function decodeControllerMarketLogs(publicClient, logs, { createdAt, fallback = true } = {}) {
  const built = buildMarketsFromControllerLogs(logs, { createdAt });
  const decoded = [...built.markets];
  const decodeErrors = [];

  if (!fallback) return { decoded, decodeErrors: built.errors };

  for (const error of built.errors) {
    const creationLog = findCreationLog(logs, error);
    if (!creationLog) {
      decodeErrors.push(error);
      continue;
    }
    try {
      decoded.push(await buildMarketFromCreationLog(publicClient, creationLog));
    } catch (fallbackError) {
      decodeErrors.push({ ...error, fallbackMessage: errorMessage(fallbackError) });
    }
  }

  return { decoded, decodeErrors };
}

async function loadChainEventMarkets(cfg, args = {}) {
  const { publicClient } = makeClients(cfg);
  const headBlock = await publicClient.getBlockNumber();
  const lookback = BigInt(args.lookbackBlocks ?? cfg.replayLookbackBlocks);
  const fromBlock = headBlock > lookback ? headBlock - lookback : 0n;
  const logs = await fetchControllerLogs(publicClient, {
    fromBlock,
    toBlock: headBlock,
    chunkSize: cfg.logChunkBlocks
  });
  const { decoded, decodeErrors } = await decodeControllerMarketLogs(publicClient, logs, {
    createdAt: new Date().toISOString(),
    fallback: true
  });
  const eventMarkets = sortMarketsByChainDesc(filterEventMarkets(decoded, cfg));
  return {
    head: headBlock.toString(),
    fromBlock: fromBlock.toString(),
    controllerLogs: logs.length,
    createNewMarketLogs: countCreationLogs(logs),
    decoded,
    decodedMarkets: decoded.length,
    eventMarkets,
    decodeErrors
  };
}

function addBufferedControllerLog(txBuffers, log) {
  if (!log?.transactionHash) return;
  const key = log.transactionHash;
  const bucket = txBuffers.get(key) ?? { firstSeenMs: Date.now(), logs: [] };
  const id = `${log.blockNumber?.toString() ?? ""}:${log.logIndex?.toString() ?? ""}:${log.eventName ?? ""}`;
  if (!bucket.logs.some((item) => `${item.blockNumber?.toString() ?? ""}:${item.logIndex?.toString() ?? ""}:${item.eventName ?? ""}` === id)) {
    bucket.logs.push(log);
  }
  txBuffers.set(key, bucket);
}

function findCreationLog(logs, error) {
  return logs.find(
    (log) =>
      isCreationLog(log) &&
      String(log.transactionHash).toLowerCase() === String(error.transactionHash).toLowerCase() &&
      String(log.args?.market).toLowerCase() === String(error.market).toLowerCase()
  );
}

function isCreationLog(log) {
  return log?.eventName === "CreateNewMarket";
}

function countCreationLogs(logs) {
  return logs.filter(isCreationLog).length;
}

function sortMarketsByChainDesc(markets) {
  return [...markets].sort((a, b) => {
    const blockDelta = BigInt(b.blockNumber ?? 0) - BigInt(a.blockNumber ?? 0);
    if (blockDelta !== 0n) return blockDelta > 0n ? 1 : -1;
    const txDelta = BigInt(b.transactionIndex ?? 0) - BigInt(a.transactionIndex ?? 0);
    if (txDelta !== 0n) return txDelta > 0n ? 1 : -1;
    const logDelta = BigInt(b.logIndex ?? 0) - BigInt(a.logIndex ?? 0);
    if (logDelta !== 0n) return logDelta > 0n ? 1 : -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function sortMarketsByStartAsc(markets) {
  return [...markets].sort(compareMarketBuyPriority);
}

function compareStartAsc(a, b) {
  return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
}

function compareMarketBuyPriority(a, b) {
  const startDelta = compareStartAsc(a, b);
  if (startDelta !== 0) return startDelta;
  const durationDelta = safeDurationMs(b) - safeDurationMs(a);
  if (durationDelta !== 0) return durationDelta;
  const createdDelta = new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime();
  if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
  return String(a.address ?? "").localeCompare(String(b.address ?? ""));
}

function safeDurationMs(market) {
  const duration = eventDurationMs(market);
  return Number.isFinite(duration) ? duration : 0;
}

function marketDurationHours(market) {
  const duration = eventDurationMs(market);
  return Number.isFinite(duration) ? roundToken(duration / 3600000, 2) : null;
}

function formatDuration(market) {
  const hours = marketDurationHours(market);
  if (hours === null) return "";
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}天`;
  if (hours >= 24) return `${roundToken(hours / 24, 1)}天`;
  return `${hours}小时`;
}

function marketFilterDecision(market, cfg) {
  const decision = getEventMarketDecision(market, cfg);
  if (!decision.eligible) return decision;
  if (filterEventMarkets([market], cfg).length > 0) return decision;
  return {
    ...decision,
    eligible: false,
    reason: "created-at-floor",
    reasonText: "早于监控起点",
    tags: ["监控起点前"]
  };
}

function recordMarketDecision(cfg, market, action, details = {}) {
  if (!cfg?.decisionFile || !market?.address) return;
  const decision = details.decision ?? marketFilterDecision(market, cfg);
  const dedupeKey = details.dedupeKey ?? [
    String(market.address).toLowerCase(),
    action,
    details.source ?? "",
    decision.reason,
    details.message ?? ""
  ].join(":");
  if (details.once !== false) {
    if (marketDecisionDedupe.has(dedupeKey)) return;
    marketDecisionDedupe.add(dedupeKey);
  }
  appendJsonl(cfg.decisionFile, {
    level: "event-market-decision",
    action,
    mode: details.mode ?? (cfg.dryRun || !cfg.execute ? "dry-run" : "execute"),
    source: details.source ?? null,
    market: market.address,
    question: market.question,
    status: market.status,
    categories: market.categories ?? [],
    tags: market.tags ?? [],
    curve: market.curve ?? null,
    contractVersion: market.contractVersion ?? null,
    startDate: market.startDate,
    endDate: market.endDate,
    durationHours: marketDurationHours(market),
    eligible: Boolean(decision.eligible),
    reason: decision.reason,
    reasonText: decision.reasonText,
    outcomeCount: details.outcomeCount ?? selectedOutcomeCount(market, cfg),
    stakeUsdt: details.stakeUsdt ?? selectedStakeUsdt(market, cfg),
    rankSource: details.rankSource ?? null,
    fallbackReason: details.fallbackReason ?? null,
    txHash: details.txHash ?? null,
    message: details.message ?? null,
    at: new Date().toISOString()
  });
}

function groupRecordsByStartDate(records) {
  const groups = new Map();
  for (const record of records) {
    const market = pendingMarket(record);
    const key = new Date(market.startDate).getTime();
    if (!Number.isFinite(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

function selectedOutcomeCount(market, cfg) {
  return estimateSelectedOutcomeCount(market, cfg);
}

function selectedStakeUsdt(market, cfg) {
  return cfg.stakePerOutcomeUsdt * selectedOutcomeCount(market, cfg);
}

function batchSelectedOutcomeCount(markets, cfg) {
  return markets.reduce((sum, market) => sum + selectedOutcomeCount(market, cfg), 0);
}

function batchSelectedStakeUsdt(markets, cfg) {
  return roundUsd(markets.reduce((sum, market) => sum + selectedStakeUsdt(market, cfg), 0));
}

function routerApprovalRequiredUsdt(cfg) {
  return roundUsd(Math.max(
    cfg.maxMarketStakeUsdt,
    cfg.maxBatchStakeUsdt,
    cfg.stakePerOutcomeUsdt * estimateMaxSelectedOutcomeCount(cfg)
  ));
}

async function selectAffordableDueRecords(cfg, records, source) {
  const sorted = sortRecordsByBuyPriority(records);
  if (cfg.dryRun || !cfg.execute) {
    return { selected: sorted, skipped: [], walletStatus: null, source, totalStakeUsdt: batchRecordStakeUsdt(sorted, cfg) };
  }
  const walletStatus = await getWalletStatus(cfg);
  return {
    ...selectAffordableRecords(cfg, sorted, walletStatus),
    walletStatus,
    source
  };
}

function selectAffordableRecords(cfg, records, walletStatus) {
  const budget = walletBudgetUsdt(cfg, walletStatus);
  let remaining = budget;
  const selected = [];
  const skipped = [];
  for (const record of sortRecordsByBuyPriority(records)) {
    const cost = recordStakeUsdt(record, cfg);
    const candidate = [...selected, record];
    if (cost > 0 && cost <= remaining && walletHasBnbForRecords(cfg, candidate, walletStatus)) {
      selected.push(record);
      remaining = roundUsd(remaining - cost);
    } else {
      skipped.push(record);
    }
  }
  return {
    selected,
    skipped,
    budgetUsdt: budget,
    remainingUsdt: remaining,
    totalStakeUsdt: batchRecordStakeUsdt(selected, cfg)
  };
}

function selectAffordableMarketSummaries(cfg, markets, walletStatus) {
  const budget = walletBudgetUsdt(cfg, walletStatus);
  let remaining = budget;
  const selected = [];
  const skipped = [];
  for (const market of [...(markets ?? [])]) {
    const cost = Number(market.totalStakeUsdt ?? selectedStakeUsdt(market, cfg));
    const candidate = [...selected, market];
    if (cost > 0 && cost <= remaining && walletHasBnbForMarkets(cfg, candidate, walletStatus)) {
      selected.push(market);
      remaining = roundUsd(remaining - cost);
    } else {
      skipped.push(market);
    }
  }
  return {
    selected,
    skipped,
    budgetUsdt: budget,
    remainingUsdt: remaining,
    totalStakeUsdt: roundUsd(selected.reduce((sum, market) => sum + Number(market.totalStakeUsdt ?? selectedStakeUsdt(market, cfg)), 0))
  };
}

function walletHasBnbForRecords(cfg, records, walletStatus) {
  return walletHasBnbForMarkets(cfg, records.map((record) => pendingMarket(record)), walletStatus);
}

function walletHasBnbForMarkets(cfg, markets, walletStatus) {
  if (!walletStatus?.bnbBalance) return true;
  try {
    const reserve = calculateFastGasReserve(cfg, fundingForMarketSummaries(cfg, markets));
    return Number(walletStatus.bnbBalance) >= Number(reserve.requiredBnb);
  } catch {
    return true;
  }
}

function walletBudgetUsdt(cfg, walletStatus) {
  if (!walletStatus) return 0;
  return roundUsd(Math.max(0, Math.min(
    Number(walletStatus.busdtBalance ?? 0),
    Number(walletStatus.busdtAllowanceToRouter ?? 0),
    Number(cfg.maxBatchStakeUsdt ?? Infinity)
  )));
}

function fundingForMarketSummaries(cfg, markets, baseFunding = {}) {
  const sorted = [...(markets ?? [])];
  const requiredBusdt = roundUsd(sorted.reduce((sum, market) => {
    return sum + Number(market.totalStakeUsdt ?? selectedStakeUsdt(market, cfg));
  }, 0));
  return {
    ...baseFunding,
    reason: sorted.length > 0 ? "affordable_opening_subset" : (baseFunding.reason ?? "single_market_upper_bound"),
    requiredBusdt,
    nextBatchRequiredBusdt: requiredBusdt,
    nextBatchMarketCount: sorted.length,
    nextBatchOutcomeCount: sorted.reduce((sum, market) => sum + Number(market.outcomeCount ?? selectedOutcomeCount(market, cfg)), 0),
    nextBatchAvailableOutcomeCount: sorted.reduce((sum, market) => sum + Number(market.availableOutcomeCount ?? market.outcomes?.length ?? 0), 0),
    nextBatchStartDate: sorted[0]?.startDate ?? baseFunding.nextBatchStartDate ?? null,
    nextBatchMarkets: sorted
  };
}

function markFundingBlockedRecords(cfg, records, walletStatus, source) {
  for (const record of records) {
    const market = pendingMarket(record);
    const cost = recordStakeUsdt(record, cfg);
    const block = fundingBlockDetails(cfg, record, walletStatus);
    markExecutionRetry(record, cfg, new Error(`funding short for ${cost}U market`));
    if (record.lastFundingBlockedLogAt && Date.now() - record.lastFundingBlockedLogAt < cfg.feishuAlertCooldownMs) continue;
    record.lastFundingBlockedLogAt = Date.now();
    const row = {
      level: "event-funding-blocked",
      source,
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      requiredUsdt: cost,
      busdtBalance: walletStatus?.busdtBalance ?? null,
      busdtAllowanceToRouter: walletStatus?.busdtAllowanceToRouter ?? null,
      bnbBalance: walletStatus?.bnbBalance ?? null,
      requiredBnbGasReserve: block.requiredBnbGasReserve,
      reason: block.reason,
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    recordMarketDecision(cfg, market, "funding-blocked", {
      source,
      message: row.reason,
      stakeUsdt: cost,
      dedupeKey: `${String(market.address).toLowerCase()}:funding-blocked:${source}`
    });
    console.error(JSON.stringify(row));
  }
}

function fundingBlockDetails(cfg, record, walletStatus) {
  const cost = recordStakeUsdt(record, cfg);
  const busdtBalance = Number(walletStatus?.busdtBalance ?? 0);
  const allowance = Number(walletStatus?.busdtAllowanceToRouter ?? 0);
  if (busdtBalance < cost) {
    return {
      reason: `BUSDT balance ${roundUsd(busdtBalance)} is below required ${cost}U`,
      requiredBnbGasReserve: null
    };
  }
  if (allowance < cost) {
    return {
      reason: `BUSDT allowance ${roundUsd(allowance)} is below required ${cost}U`,
      requiredBnbGasReserve: null
    };
  }
  try {
    const reserve = calculateFastGasReserve(cfg, fundingForMarketSummaries(cfg, [pendingMarket(record)]));
    const bnbBalance = Number(walletStatus?.bnbBalance ?? 0);
    if (bnbBalance < Number(reserve.requiredBnb)) {
      return {
        reason: `BNB balance ${walletStatus?.bnbBalance ?? 0} is below required gas reserve ${reserve.requiredBnb}`,
        requiredBnbGasReserve: reserve.requiredBnb
      };
    }
    return {
      reason: "current wallet balance only covers higher-priority complete markets in this opening batch",
      requiredBnbGasReserve: reserve.requiredBnb
    };
  } catch {
    return {
      reason: "current wallet balance only covers higher-priority complete markets in this opening batch",
      requiredBnbGasReserve: null
    };
  }
}

function sortRecordsByBuyPriority(records) {
  return [...records].sort((a, b) => compareMarketBuyPriority(pendingMarket(a), pendingMarket(b)));
}

function recordStakeUsdt(record, cfg) {
  return Number(record?.preparedPlan?.totalStakeUsdt ?? selectedStakeUsdt(pendingMarket(record), cfg));
}

function batchRecordStakeUsdt(records, cfg) {
  return roundUsd(records.reduce((sum, record) => sum + recordStakeUsdt(record, cfg), 0));
}

async function ensureStartupRouterApproval(cfg) {
  if (cfg.dryRun || !cfg.execute || !cfg.autoApproveRouterOnStart) {
    return {
      skipped: true,
      reason: cfg.autoApproveRouterOnStart ? "not-execute-mode" : "disabled"
    };
  }

  const requiredUsdt = routerApprovalRequiredUsdt(cfg);
  const result = await approveRouterMax(cfg, { requiredUsdt });
  const summary = {
    level: "event-router-approval-startup",
    requiredUsdt,
    alreadyReady: result.alreadyReady ?? false,
    approved: Boolean(result.approved),
    currentAllowance: result.currentAllowance,
    requiredAllowance: result.requiredAllowance,
    approveHash: result.approveHash ?? null,
    resetHash: result.resetHash ?? null,
    at: new Date().toISOString()
  };
  console.log(JSON.stringify(summary, null, 2));
  notifyFeishu(cfg, {
    title: summary.approved ? "Router 授权已补齐" : "Router 授权已就绪",
    fields: {
      required: `${requiredUsdt}U`,
      approved: summary.approved ? "yes" : "ready",
      tx: summary.approveHash ?? ""
    },
    dedupeKey: "router-approval-startup",
    cooldownMs: cfg.feishuAlertCooldownMs
  });
  return result;
}

function computeFundingRequirement(cfg, eventMarkets = []) {
  const upperBoundRequiredBusdt = roundUsd(cfg.stakePerOutcomeUsdt * estimateMaxSelectedOutcomeCount(cfg));
  const futureMarkets = eventMarkets
    .filter((market) => msUntilStart(market) > 0)
    .sort(compareMarketBuyPriority);

  const nextBatchStartMs = futureMarkets.length > 0
    ? new Date(futureMarkets[0].startDate).getTime()
    : null;
  const nextBatch = Number.isFinite(nextBatchStartMs)
    ? futureMarkets.filter((market) => new Date(market.startDate).getTime() === nextBatchStartMs)
    : [];
  const nextBatchRequiredBusdt = roundUsd(nextBatch.reduce((sum, market) => {
    return sum + selectedStakeUsdt(market, cfg);
  }, 0));
  const minimumExecutableBusdt = nextBatch.length > 0
    ? roundUsd(Math.min(...nextBatch.map((market) => selectedStakeUsdt(market, cfg))))
    : upperBoundRequiredBusdt;
  const useNextBatch = cfg.watchFundingMode === "next_batch" && nextBatch.length > 0;
  const requiredBusdt = useNextBatch ? nextBatchRequiredBusdt : upperBoundRequiredBusdt;

  return {
    mode: cfg.watchFundingMode,
    reason: useNextBatch ? "known_next_opening_batch" : "single_market_upper_bound",
    requiredBusdt,
    minimumExecutableBusdt,
    upperBoundRequiredBusdt,
    nextBatchRequiredBusdt,
    nextBatchMarketCount: nextBatch.length,
    nextBatchOutcomeCount: batchSelectedOutcomeCount(nextBatch, cfg),
    nextBatchAvailableOutcomeCount: nextBatch.reduce((sum, market) => sum + (market.outcomes?.length ?? 0), 0),
    nextBatchStartDate: nextBatch[0]?.startDate ?? null,
    nextBatchMarkets: nextBatch.map((market) => ({
      question: market.question,
      address: market.address,
      startDate: market.startDate,
      endDate: market.endDate,
      durationHours: marketDurationHours(market),
      outcomeCount: selectedOutcomeCount(market, cfg),
      availableOutcomeCount: market.outcomes?.length ?? 0,
      totalStakeUsdt: roundUsd(selectedStakeUsdt(market, cfg))
    }))
  };
}

function buildFundingWalletSummary(status, requirement, gasReserve) {
  const busdtBalance = Number(status.busdtBalance);
  const busdtAllowance = Number(status.busdtAllowanceToRouter);
  const requiredBusdt = Number(requirement.requiredBusdt);
  const requiredBnb = Number(gasReserve.requiredBnb);
  const bnbBalance = Number(status.bnbBalance);
  const missingBusdt = Math.max(0, requiredBusdt - busdtBalance);
  const missingAllowance = Math.max(0, requiredBusdt - busdtAllowance);
  const missingBnb = Math.max(0, requiredBnb - bnbBalance);

  return {
    address: status.address,
    blockNumber: status.blockNumber,
    bnbBalance: status.bnbBalance,
    busdtBalance: status.busdtBalance,
    busdtAllowanceToRouter: status.busdtAllowanceToRouter,
    requiredBusdt: requirement.requiredBusdt,
    requiredBnbGasReserve: gasReserve.requiredBnb,
    gasReserveMode: gasReserve.mode,
    busdtBalanceReady: missingBusdt === 0,
    busdtAllowanceReady: missingAllowance === 0,
    bnbReady: missingBnb === 0,
    topUp: {
      missingBusdt: roundToken(missingBusdt, 6),
      missingBnb: roundToken(missingBnb, 9),
      missingAllowanceUsdt: roundToken(missingAllowance, 6),
      note: missingAllowance > 0 ? "BUSDT balance may be enough after top-up, but router allowance is still short; run event:approve from this wallet" : null
    }
  };
}

async function preparePendingRecord(cfg, market, runtime = null, options = {}) {
  const record = {
    market,
    preparedPlan: null,
    preparedAt: null,
    prepareError: null,
    preSignedFastTransaction: null,
    preSignedAt: null,
    preSignError: null,
    preSignAttempts: 0,
    preSignRetryAfterMs: null,
    preSignedFastBundleTransaction: null,
    preSignedFastBundle: null,
    bundlePreSignedAt: null,
    bundlePreSignError: null,
    bundlePreSignAttempts: 0,
    bundlePreSignRetryAfterMs: null,
    executionError: null,
    executionAttempts: 0,
    executionRetryAfterMs: null
  };
  if (cfg.eventBuyMode !== "fast") return record;

  try {
    const hydrateOdds = options.hydrateOdds !== false;
    const preparedMarket = hydrateOdds
      ? await maybeHydrateMarketOdds(cfg, market)
      : {
          ...market,
          oddsHydrationSkipped: options.hydrationSkipReason ?? "disabled"
        };
    record.market = preparedMarket;
    let plan = buildDirectBuyAllOutcomesPlan(preparedMarket, cfg);
    const receiver = runtime?.receiverAddress || cfg.walletAddress;
    if (receiver) {
      plan = withPrebuiltFastExecution(plan, receiver);
    }
    record.preparedPlan = plan;
    record.preparedAt = new Date().toISOString();
    record.prebuiltCalldata = Boolean(plan.prebuiltFastExecution);
  } catch (error) {
    record.prepareError = errorMessage(error);
  }
  return record;
}

async function maybeHydrateMarketOdds(cfg, market) {
  if (!needsRestOddsHydration(cfg, market)) return market;
  try {
    const restMarket = await fetchMarket(cfg, market.address);
    if (!restMarket?.outcomes?.length) return market;
    return mergeRestMarket(market, restMarket);
  } catch (error) {
    return {
      ...market,
      oddsHydrationError: errorMessage(error)
    };
  }
}

function needsRestOddsHydration(cfg, market) {
  if (cfg.eventOutcomeSelection !== "lowest_odds") return false;
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) return false;
  return !hasCompleteOutcomeField(market, "payout") && !hasCompleteOutcomeField(market, "price");
}

function hasCompleteOutcomeField(market, field) {
  return (market.outcomes ?? []).every((outcome) => {
    if (outcome[field] === null || outcome[field] === undefined || outcome[field] === "") return false;
    return Number.isFinite(Number(outcome[field]));
  });
}

function mergeRestMarket(chainMarket, restMarket) {
  return {
    ...chainMarket,
    ...restMarket,
    address: chainMarket.address,
    status: chainMarket.status ?? restMarket.status,
    createdAt: chainMarket.createdAt ?? restMarket.createdAt,
    startDate: chainMarket.startDate ?? restMarket.startDate,
    endDate: chainMarket.endDate ?? restMarket.endDate,
    transactionHash: chainMarket.transactionHash,
    blockNumber: chainMarket.blockNumber,
    transactionIndex: chainMarket.transactionIndex,
    logIndex: chainMarket.logIndex,
    oddsHydratedFrom: "42 REST market detail"
  };
}

function shouldPreSignFastTransactions(cfg, runtime) {
  return Boolean(
    cfg.preSignFastTx &&
    runtime &&
    cfg.eventBuyMode === "fast" &&
    !cfg.dryRun &&
    cfg.execute
  );
}

async function attachPreSignedFastTransaction(cfg, record, runtime) {
  if (!record.preparedPlan || record.preSignedFastTransaction) return record;
  if (runtimeTransactionBusy(runtime)) {
    record.preSignError = `transaction lock busy: ${runtime.txLock.owner}`;
    record.preSignAttempts = (record.preSignAttempts ?? 0) + 1;
    record.preSignRetryAfterMs = Date.now() + cfg.preSignRetryMs;
    return record;
  }
  pauseRuntimeAutoSell(runtime, cfg, "single-presign-start");
  try {
    record.preSignedFastTransaction = await withRuntimeTransactionLock(
      runtime,
      "pre-sign-single",
      () => preSignFastBuyTransaction(cfg, record.preparedPlan, runtime)
    );
    pauseRuntimeAutoSell(runtime, cfg, "single-presigned-buy");
    record.preSignedAt = new Date().toISOString();
    record.preSignError = null;
    record.preSignRetryAfterMs = null;
    console.log(JSON.stringify({
      level: "pre-signed-fast-tx",
      market: record.market.address,
      question: record.market.question,
      startDate: record.market.startDate,
      txHash: record.preSignedFastTransaction.txHash,
      nonce: record.preSignedFastTransaction.nonce,
      msUntilAction: msUntilAction(record.market, cfg)
    }));
  } catch (error) {
    record.preSignError = errorMessage(error);
    record.preSignAttempts = (record.preSignAttempts ?? 0) + 1;
    record.preSignRetryAfterMs = Date.now() + cfg.preSignRetryMs;
    console.error(JSON.stringify({
      level: "warn",
      source: "pre-sign-market",
      message: record.preSignError,
      attempts: record.preSignAttempts,
      retryInMs: cfg.preSignRetryMs,
      market: record.market.address,
      startDate: record.market.startDate
    }));
  }
  return record;
}

function canRetryPreSign(error, retryAfterMs, now, cfg) {
  if (!error) return true;
  if (cfg.preSignRetryMs <= 0) return false;
  return Number(retryAfterMs ?? 0) <= now;
}

function markExecutionRetry(record, cfg, error) {
  if (!record) return;
  record.executionError = errorMessage(error);
  record.executionAttempts = (record.executionAttempts ?? 0) + 1;
  record.executionRetryAfterMs = Date.now() + cfg.executionRetryMs;
}

function skipExpiredPendingMarkets(cfg, seen, pending, source) {
  let skipped = false;
  for (const [key, record] of [...pending.entries()]) {
    const market = pendingMarket(record);
    if (!markSkippedIfExpired(cfg, seen, market, source)) continue;
    pending.delete(key);
    skipped = true;
  }
  if (skipped) saveSeen(cfg.stateFile, seen);
}

async function dropFollowBlockedPendingRecords(cfg, seen, pending, runtime, source) {
  let resetNonce = false;
  let dropped = false;
  for (const record of [...pending.values()]) {
    const market = pendingMarket(record);
    if (!isMarketFollowBlocked(market, cfg)) continue;
    if (hasPreSignedSingle(record) || hasPreSignedBundle(record)) resetNonce = true;
    clearPreSignedSingleRecord(record, "follow-blocked");
    clearPreSignedBundleRecords([record], "follow-blocked");
    markFollowBlockedPendingRecord(cfg, seen, pending, record, source);
    dropped = true;
  }
  if (resetNonce) await resetRuntimeNonceToPending(cfg, runtime, "follow_blocked_pending");
  if (dropped) saveSeen(cfg.stateFile, seen);
}

function markFollowBlockedPendingRecord(cfg, seen, pending, record, source) {
  const market = pendingMarket(record);
  const key = eventSeenKey(market, cfg);
  pending.delete(key);
  seen.add(key);
  const message = "已取消关注，禁止买入";
  appendJsonl(cfg.fillsFile, {
    level: "event-skip-follow-blocked",
    source,
    market: market.address,
    question: market.question,
    startDate: market.startDate,
    reason: message,
    at: new Date().toISOString()
  });
  recordMarketDecision(cfg, market, "skipped", {
    source,
    message,
    dedupeKey: `${String(market.address).toLowerCase()}:skipped-follow-blocked`
  });
  console.error(JSON.stringify({
    level: "warn",
    source,
    market: market.address,
    question: market.question,
    message,
    at: new Date().toISOString()
  }));
}

function markSkippedIfExpired(cfg, seen, market, source) {
  if (!isPastEventOpenWindow(cfg, market)) return false;
  const key = eventSeenKey(market, cfg);
  if (seen.has(key)) return true;
  const ageMs = marketOpenAgeMs(market);
  const row = {
    level: "event-skip-open-window",
    source,
    market: market.address,
    question: market.question,
    startDate: market.startDate,
    ageMs,
    eventOpenWindowSeconds: cfg.eventOpenWindowSeconds,
    reason: `market is ${Math.round(ageMs / 1000)}s past open; max ${cfg.eventOpenWindowSeconds}s`,
    at: new Date().toISOString()
  };
  seen.add(key);
  appendJsonl(cfg.fillsFile, row);
  recordMarketDecision(cfg, market, "skipped", {
    source,
    message: row.reason,
    dedupeKey: `${String(market.address).toLowerCase()}:skipped-open-window`
  });
  console.error(JSON.stringify(row));
  return true;
}

function isPastEventOpenWindow(cfg, market) {
  if (cfg.allowLateBuy) return false;
  const ageMs = marketOpenAgeMs(market);
  return Number.isFinite(ageMs) && ageMs > eventOpenWindowMs(cfg);
}

function assertPlanWithinOpenWindow(cfg, market, source = "buy") {
  if (!isPastEventOpenWindow(cfg, market)) return;
  const ageMs = marketOpenAgeMs(market);
  throw new Error(
    `Refusing ${source}: market is ${Math.round(ageMs / 1000)}s past open; max ${cfg.eventOpenWindowSeconds}s`
  );
}

function marketOpenAgeMs(market) {
  const start = new Date(market?.startDate).getTime();
  if (!Number.isFinite(start)) return NaN;
  return Date.now() - start;
}

function eventOpenWindowMs(cfg) {
  return cfg.eventOpenWindowSeconds * 1000;
}

function clearExecutionRetry(record) {
  if (!record) return;
  record.executionError = null;
  record.executionRetryAfterMs = null;
}

function executionMarksSeen(result) {
  if (result?.dryRun) return true;
  return result?.status === "success" || result?.status === "broadcast";
}

function buyDecisionAction(result) {
  if (result?.dryRun) return "dry-run-bought";
  if (result?.status === "broadcast") return "broadcast";
  return "bought";
}

function pendingMarket(record) {
  return record?.market ?? record;
}

function selectSellPositions(openPositions, args) {
  let selected = openPositions;
  if (args.market) {
    selected = selected.filter((position) =>
      String(position.marketAddress).toLowerCase() === String(args.market).toLowerCase()
    );
  }
  if (args.tokenId) {
    selected = selected.filter((position) => String(position.tokenId) === String(args.tokenId));
  }
  if (args.tokenIds) {
    const wanted = new Set(String(args.tokenIds).split(",").map((item) => item.trim()).filter(Boolean));
    selected = selected.filter((position) => wanted.has(String(position.tokenId)));
  }
  if (!args.all && selected.length !== 1) {
    const choices = selected.map((position) => ({
      marketAddress: position.marketAddress,
      tokenId: position.tokenId,
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      size: position.size
    }));
    throw new Error(
      `sell needs exactly one position unless --all is set; matched ${selected.length}: ${JSON.stringify(choices)}`
    );
  }
  if (selected.length === 0) throw new Error("No matching open positions found");
  return selected;
}

function summarizeSellPlans(plans) {
  const totals = plans.reduce(
    (acc, plan) => {
      acc.expectedCollateralToUser += Number(plan.expectedCollateralToUser) / 1e18;
      acc.minCollateralOut += Number(plan.minCollateralOut) / 1e18;
      acc.collateralToIntegrator += Number(plan.collateralToIntegrator) / 1e18;
      return acc;
    },
    { expectedCollateralToUser: 0, minCollateralOut: 0, collateralToIntegrator: 0 }
  );
  return {
    expectedCollateralToUserUsdt: roundUsd(totals.expectedCollateralToUser),
    minCollateralOutUsdt: roundUsd(totals.minCollateralOut),
    collateralToIntegratorUsdt: roundUsd(totals.collateralToIntegrator),
    positionsNeedingOperatorApproval: plans.filter((plan) => !plan.operatorApproved).length
  };
}

function summarizePosition(position) {
  const costBasisUsdt = Number(position.costBasis ?? 0);
  const cashPnlUsdt = Number(position.cashPnl ?? 0);
  const realizedPnlUsdt = Number(position.realizedPnl ?? 0);
  return {
    marketAddress: position.marketAddress,
    question: position.question?.title ?? null,
    outcome: position.outcome?.name ?? null,
    tokenId: position.tokenId,
    size: Number(position.size ?? 0),
    avgPrice: Number(position.avgPrice ?? 0),
    curPrice: Number(position.curPrice ?? 0),
    costBasisUsdt: roundUsd(costBasisUsdt),
    cashPnlUsdt: roundUsd(cashPnlUsdt),
    realizedPnlUsdt: roundUsd(realizedPnlUsdt),
    markValueUsdt: roundUsd(costBasisUsdt + cashPnlUsdt),
    percentPnl: roundUsd(Number(position.percentPnl ?? 0)),
    payoutIfRightUsdt: roundUsd(Number(position.outcome?.payout ?? 0)),
    isFinalized: Boolean(position.isFinalized),
    isClaimed: Boolean(position.isClaimed),
    isWinner: position.isWinner
  };
}

function roundUsd(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function roundToken(value, decimals = 6) {
  const scale = 10 ** decimals;
  return Math.round(Number(value) * scale) / scale;
}

function roundMs(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function summarizeBenchResults(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const totalHotPath = results.map((item) => item.totalHotPathMs);
  const preSign = results.map((item) => item.preSignMs);
  return {
    samples: results.length,
    avgTotalHotPathMs: roundMs(avg(totalHotPath)),
    minTotalHotPathMs: roundMs(Math.min(...totalHotPath)),
    maxTotalHotPathMs: roundMs(Math.max(...totalHotPath)),
    avgPreSignMs: roundMs(avg(preSign)),
    minPreSignMs: roundMs(Math.min(...preSign)),
    maxPreSignMs: roundMs(Math.max(...preSign))
  };
}

function avg(values) {
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

async function maybeExecuteMarket(
  cfg,
  seen,
  market,
  {
    allowFuturePending = false,
    runtime = null,
    preparedPlan = null,
    preSignedFastTransaction = null,
    hydrateOdds = true,
    hydrationSkipReason = null,
    retryRecord = null
  } = {}
) {
  const key = eventSeenKey(market, cfg);
  if (seen.has(key)) return false;
  if (isMarketFollowBlocked(market, cfg)) {
    seen.add(key);
    saveSeen(cfg.stateFile, seen);
    const message = "已取消关注，禁止买入";
    appendJsonl(cfg.fillsFile, {
      level: "event-skip-follow-blocked",
      source: "single-follow-blocked",
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      reason: message,
      at: new Date().toISOString()
    });
    recordMarketDecision(cfg, market, "skipped", {
      source: "single-follow-blocked",
      message,
      dedupeKey: `${String(market.address).toLowerCase()}:skipped-follow-blocked`
    });
    return false;
  }
  if (markSkippedIfExpired(cfg, seen, market, "single-open-window")) {
    saveSeen(cfg.stateFile, seen);
    return false;
  }

  const waitMs = msUntilStart(market);
  const actionWaitMs = msUntilAction(market, cfg);
  if (actionWaitMs > 0) {
    if (allowFuturePending) {
      console.log(JSON.stringify({
        level: "pending-start",
        market: market.address,
        question: market.question,
        startDate: market.startDate,
        prepared: Boolean(preparedPlan),
        prebuiltCalldata: Boolean(preparedPlan?.prebuiltFastExecution),
        preSigned: Boolean(preSignedFastTransaction),
        waitMs,
        actionWaitMs,
        prebroadcastMs: cfg.prebroadcastMs
      }));
    }
    return false;
  }

  const prebroadcastMs = effectivePrebroadcastMs(cfg);
  if (waitMs > 0 && prebroadcastMs > 0) {
    console.log(JSON.stringify({
      level: "prebroadcast-window",
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      waitMs,
      prebroadcastMs
    }));
  }

  let eventPlan = preparedPlan ?? await buildEventPlanForMarket(cfg, market, {
    hydrateOdds,
    hydrationSkipReason
  });
  if (preSignedFastTransaction) {
    eventPlan = { ...eventPlan, preSignedFastTransaction };
  }
  let result;
  try {
    result = await executeOrPrint(eventPlan, cfg, runtime);
  } catch (error) {
    markExecutionRetry(retryRecord, cfg, error);
    const row = {
      level: "event-execution-error",
      market: market.address,
      question: market.question,
      message: errorMessage(error),
      retryInMs: cfg.executionRetryMs,
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    recordMarketDecision(cfg, market, "execution-error", {
      source: "single-execution",
      message: errorMessage(error)
    });
    console.error(JSON.stringify(row));
    notifyFeishu(cfg, {
      title: "买入失败",
      level: "warn",
      fields: {
        type: "single",
        market: market.address,
        question: market.question,
        message: errorMessage(error)
      }
    });
    return false;
  }
  appendJsonl(cfg.fillsFile, {
    plan: describeEventPlan(eventPlan),
    result,
    at: new Date().toISOString()
  });
  if (!executionMarksSeen(result)) {
    const terminal = isTerminalMinedFailure(result);
    const preopen = terminal && isPreopenBroadcastResult(result, market);
    if (terminal && preopen && !isPastEventOpenWindow(cfg, market)) {
      clearPreSignedSingleRecord(retryRecord, `terminal_${result.status}_preopen`, result);
      await resetRuntimeNonceToPending(cfg, runtime, `single_terminal_${result.status}_preopen`);
      markExecutionRetry(retryRecord, cfg, new Error(`execution status ${result.status ?? "unknown"}`));
    } else if (terminal) {
      seen.add(key);
      saveSeen(cfg.stateFile, seen);
      clearExecutionRetry(retryRecord);
    } else {
      markExecutionRetry(retryRecord, cfg, new Error(`execution status ${result.status ?? "unknown"}`));
    }
    recordMarketDecision(cfg, market, "execution-unconfirmed", {
      source: "single-execution",
      message: `execution status ${result.status ?? "unknown"}`,
      txHash: result.txHash ?? null
    });
    console.error(JSON.stringify({
      level: "warn",
      source: "single-execution",
      market: market.address,
      message: `Execution not confirmed successful: ${result.status ?? "unknown"}`,
      retryInMs: terminal && !preopen ? null : cfg.executionRetryMs,
      at: new Date().toISOString()
    }));
    notifyFeishu(cfg, {
      title: "买入未确认成功",
      level: "warn",
      fields: {
        type: "single",
        market: market.address,
        status: result.status ?? "unknown",
        tx: result.txHash ?? ""
      }
    });
    return false;
  }
  clearExecutionRetry(retryRecord);
  seen.add(key);
  saveSeen(cfg.stateFile, seen);
  recordMarketDecision(cfg, market, buyDecisionAction(result), {
    source: "single-execution",
    mode: result?.dryRun ? "dry-run" : "execute",
    rankSource: eventPlan.selection?.rankSource ?? null,
    fallbackReason: eventPlan.selection?.fallbackReason ?? null,
    txHash: result.txHash ?? null
  });
  notifyFeishu(cfg, {
    title: result?.status === "broadcast" ? "买入已广播" : "买入成功",
    fields: {
      type: "single",
      market: market.address,
      question: market.question,
      status: result?.status ?? "",
      stake: `${eventPlan.totalStakeUsdt}U`,
      rankSource: eventPlan.selection?.rankSource ?? "",
      fallback: eventPlan.selection?.fallbackReason ?? "",
      tx: result.txHash
    }
  });
  return true;
}

async function buildEventPlan(cfg, args = {}) {
  if (args.market) {
    const market = await fetchMarket(cfg, args.market);
    return buildEventPlanForMarket(cfg, market, args);
  }
  const markets = await loadEventMarkets(cfg, { status: args.market ? "all" : "live" });
  const market = selectEventMarket(markets, args);
  return buildEventPlanForMarket(cfg, market, args);
}

async function buildEventPlanForMarket(cfg, market, args = {}) {
  const { publicClient } = makeClients(cfg);
  const hydrateOdds = args.hydrateOdds !== false;
  const planMarket = hydrateOdds
    ? await maybeHydrateMarketOdds(cfg, market)
    : {
        ...market,
        oddsHydrationSkipped: args.hydrationSkipReason ?? "disabled"
      };
  if (args.forceQuoted || args.quoted || cfg.eventBuyMode === "quoted") {
    return quoteBuyAllOutcomes(publicClient, planMarket, cfg, {
      stakePerOutcomeUsdt: args.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt
    });
  }
  return buildDirectBuyAllOutcomesPlan(planMarket, cfg, {
    stakePerOutcomeUsdt: args.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt
  });
}

async function loadEventMarkets(cfg, { status = "live", limit = 500 } = {}) {
  const markets = await fetchMarkets(cfg, {
    status,
    topic: "",
    order: "created_at",
    ascending: false,
    limit
  });
  return filterEventMarkets(markets, cfg);
}

async function loadRestEventMarkets(cfg, { status = "all", limit = 500 } = {}) {
  return loadEventMarkets(cfg, { status, limit });
}

async function loadRawRestMarkets(cfg, { status = "all", limit = 500 } = {}) {
  return fetchMarkets(cfg, {
    status,
    topic: "",
    order: "created_at",
    ascending: false,
    limit
  });
}

function mergeKnownEventMarkets(...groups) {
  const byAddress = new Map();
  for (const market of groups.flat()) {
    if (!market?.address) continue;
    const key = String(market.address).toLowerCase();
    const existing = byAddress.get(key);
    byAddress.set(key, existing ? mergeKnownEventMarket(existing, market) : market);
  }
  return [...byAddress.values()];
}

function mergeKnownEventMarket(left, right) {
  const richerOutcomes = chooseRicherOutcomes(left.outcomes, right.outcomes);
  return {
    ...left,
    ...right,
    address: left.address ?? right.address,
    transactionHash: left.transactionHash ?? right.transactionHash,
    blockNumber: left.blockNumber ?? right.blockNumber,
    transactionIndex: left.transactionIndex ?? right.transactionIndex,
    logIndex: left.logIndex ?? right.logIndex,
    outcomes: richerOutcomes
  };
}

function chooseRicherOutcomes(left = [], right = []) {
  const leftScore = outcomeDataScore(left);
  const rightScore = outcomeDataScore(right);
  return rightScore >= leftScore ? right : left;
}

function outcomeDataScore(outcomes = []) {
  return outcomes.length * 10 +
    outcomes.filter((outcome) => outcome.payout !== undefined && outcome.payout !== null).length * 2 +
    outcomes.filter((outcome) => outcome.price !== undefined && outcome.price !== null).length;
}

async function executeOrPrint(eventPlan, cfg, runtime = null) {
  const described = describeEventPlan(eventPlan);
  if (cfg.dryRun || !cfg.execute) {
    console.log(JSON.stringify({ level: "event-plan", plan: described }, null, 2));
    return { dryRun: true };
  }
  assertPlanWithinOpenWindow(cfg, eventPlan.market, "single-buy");

  const result = await withRuntimeTransactionLock(
    runtime,
    "buy-single",
    () => buyOutcomesBatch(broadcastOnlyExecutionCfg(cfg), eventPlan, runtime)
  );
  console.log(JSON.stringify({ level: "executed", plan: described, result }, null, 2));
  maybeTrackReceipt(cfg, result, {
    type: "single",
    market: eventPlan.market.address,
    question: eventPlan.market.question,
    marketDetails: [eventPlan.market]
  });
  return result;
}

async function executeOrPrintBundle(bundle, cfg, runtime = null) {
  const described = describeFastBundlePlan(bundle, { dryRun: cfg.dryRun || !cfg.execute });
  if (cfg.dryRun || !cfg.execute) {
    console.log(JSON.stringify({ level: "event-bundle-plan", bundle: described }, null, 2));
    return { dryRun: true, bundled: true };
  }
  for (const market of bundle.markets) {
    assertPlanWithinOpenWindow(cfg, market, "bundle-buy");
  }

  const result = await withRuntimeTransactionLock(
    runtime,
    "buy-bundle",
    () => executeFastBuyBundle(broadcastOnlyExecutionCfg(cfg), bundle, runtime)
  );
  console.log(JSON.stringify({ level: "bundle-executed", bundle: described, result }, null, 2));
  maybeTrackReceipt(cfg, result, {
    type: "bundle",
    markets: bundle.markets.map((market) => market.address),
    marketCount: bundle.marketCount,
    outcomeCount: bundle.outcomeCount,
    marketDetails: bundle.markets
  });
  return result;
}

function broadcastOnlyExecutionCfg(cfg) {
  return {
    ...cfg,
    waitForReceipt: false,
    asyncReceiptWatch: true
  };
}

function maybeTrackReceipt(cfg, result, context = {}) {
  if (
    !cfg.asyncReceiptWatch ||
    cfg.dryRun ||
    !cfg.execute ||
    !result?.txHash ||
    result.waitedForReceipt ||
    result.blockNumber
  ) return;

  void trackReceipt(cfg, result.txHash, context).catch((error) => {
    const row = {
      level: "event-receipt",
      status: "error",
      txHash: result.txHash,
      message: errorMessage(error),
      context: receiptLogContext(context),
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    console.error(JSON.stringify(row));
  });
}

async function trackReceipt(cfg, txHash, context) {
  const { publicClient } = makeClients(cfg);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: cfg.receiptWatchTimeoutMs,
    pollingInterval: cfg.receiptWatchPollingMs
  });
  const row = {
    level: "event-receipt",
    status: receipt.status,
    txHash,
    blockNumber: receipt.blockNumber?.toString() ?? null,
    gasUsed: receipt.gasUsed?.toString() ?? null,
    effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
    context: receiptLogContext(context),
    at: new Date().toISOString()
  };
  appendJsonl(cfg.fillsFile, row);
  console.log(JSON.stringify(row));
  recordReceiptMarketDecisions(cfg, context, receipt, txHash);
  if (receipt.status !== "success") {
    notifyFeishu(cfg, {
      title: "交易 receipt 非成功",
      level: "warn",
      fields: {
        tx: txHash,
        status: receipt.status,
        context: context.type ?? ""
      },
      dedupeKey: `receipt-failed:${txHash}`,
      cooldownMs: cfg.feishuAlertCooldownMs
    });
  }
}

function receiptLogContext(context = {}) {
  const { marketDetails, ...logContext } = context;
  return logContext;
}

function recordReceiptMarketDecisions(cfg, context = {}, receipt, txHash) {
  const markets = Array.isArray(context.marketDetails) ? context.marketDetails : [];
  const action = receipt.status === "success" ? "receipt-success" : "receipt-failed";
  for (const market of markets) {
    recordMarketDecision(cfg, market, action, {
      source: "receipt-watch",
      txHash,
      message: receipt.status === "success" ? null : `receipt status ${receipt.status}`,
      once: false
    });
  }
}

function notifyFeishu(
  cfg,
  { title, level = "info", fields = {}, dedupeKey = null, cooldownMs = 0, fingerprint = null, repeatMs = 0 } = {}
) {
  if (!cfg.feishuAlertsEnabled || !cfg.feishuWebhook || !title) return;
  if (!shouldSendFeishuAlert(cfg, { dedupeKey, cooldownMs, fingerprint, repeatMs, title })) return;

  const alert = buildFeishuAlertView({ title: alertTitle(cfg, title), level, fields });
  void sendFeishuAlert(cfg.feishuWebhook, alert).catch((error) => {
    console.error(JSON.stringify({
      level: "warn",
      source: "feishu-alert-error",
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
  });
}

function shouldSendFeishuAlert(cfg, { dedupeKey, cooldownMs = 0, fingerprint = null, repeatMs = 0, title = "" } = {}) {
  if (!dedupeKey && !fingerprint) return true;
  const key = String(dedupeKey ?? title);
  const now = Date.now();
  const memoryEntry = readMemoryAlertState(key);

  try {
    const state = loadAlertState(cfg.alertStateFile);
    const entry = state.alerts[key] ?? {};
    if (isAlertSuppressed(entry, { now, cooldownMs, fingerprint, repeatMs })) return false;
    state.alerts[key] = {
      fingerprint: fingerprint ?? entry.fingerprint ?? "",
      lastSentAt: new Date(now).toISOString(),
      title: String(title ?? "").slice(0, 120)
    };
    saveAlertState(cfg.alertStateFile, state);
    writeMemoryAlertState(key, state.alerts[key]);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      source: "feishu-alert-state-error",
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
    if (isAlertSuppressed(memoryEntry, { now, cooldownMs, fingerprint, repeatMs })) return false;
    writeMemoryAlertState(key, {
      fingerprint: fingerprint ?? memoryEntry.fingerprint ?? "",
      lastSentAt: new Date(now).toISOString(),
      title: String(title ?? "").slice(0, 120)
    });
    return true;
  }
}

function isAlertSuppressed(entry = {}, { now, cooldownMs = 0, fingerprint = null, repeatMs = 0 } = {}) {
  const lastSentMs = alertEntryTimeMs(entry);
  if (fingerprint) {
    if (entry.fingerprint === fingerprint) {
      if (!Number.isFinite(lastSentMs)) return false;
      const repeatWindow = Number(repeatMs ?? 0);
      return repeatWindow <= 0 || now - lastSentMs < repeatWindow;
    }
    return false;
  }
  const cooldown = Number(cooldownMs ?? 0);
  return cooldown > 0 && Number.isFinite(lastSentMs) && now - lastSentMs < cooldown;
}

function readMemoryAlertState(key) {
  const entry = alertCooldowns.get(key);
  if (!entry) return {};
  if (typeof entry === "number") return { lastSentAt: new Date(entry).toISOString() };
  return entry;
}

function writeMemoryAlertState(key, entry) {
  alertCooldowns.set(key, entry);
}

function loadAlertState(file) {
  if (!file || !fs.existsSync(file)) return defaultAlertState();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return defaultAlertState();
  }
  if (!parsed || typeof parsed !== "object" || !parsed.alerts || typeof parsed.alerts !== "object") {
    return defaultAlertState();
  }
  return {
    version: 1,
    alerts: parsed.alerts,
    updatedAt: parsed.updatedAt ?? null
  };
}

function saveAlertState(file, state) {
  if (!file) return;
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  const next = {
    version: 1,
    alerts: state.alerts ?? {},
    updatedAt: new Date().toISOString()
  };
  const tmp = path.join(dir && dir !== "." ? dir : ".", `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function defaultAlertState() {
  return { version: 1, alerts: {}, updatedAt: null };
}

function alertEntryTimeMs(entry = {}) {
  const time = Date.parse(entry.lastSentAt ?? "");
  return Number.isFinite(time) ? time : NaN;
}

function alertTitle(cfg, title) {
  const botName = cfg.botName ? String(cfg.botName).trim() : "";
  if (!botName) return title;
  if (String(title).startsWith(`[${botName}]`)) return title;
  return `[${botName}] ${title}`;
}

async function sendFeishuAlert(webhook, alert) {
  try {
    await postFeishuPayload(webhook, buildFeishuCardPayload(alert));
    return;
  } catch (cardError) {
    await postFeishuPayload(webhook, buildFeishuTextPayload(alert)).catch((textError) => {
      throw new Error(`card failed: ${errorMessage(cardError)}; text fallback failed: ${errorMessage(textError)}`);
    });
  }
}

async function postFeishuPayload(webhook, payload) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu webhook ${response.status}: ${body.slice(0, 200)}`);
  }
  const parsed = parseJsonOrNull(body);
  const code = parsed?.code ?? parsed?.StatusCode;
  if (code !== undefined && Number(code) !== 0) {
    const message = parsed?.msg ?? parsed?.StatusMessage ?? body;
    throw new Error(`Feishu webhook code ${code}: ${String(message).slice(0, 200)}`);
  }
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildFeishuTextPayload(alert) {
  return {
    msg_type: "text",
    content: { text: formatFeishuAlertText(alert) }
  };
}

function buildFeishuCardPayload(alert) {
  const content = formatFeishuAlertFacts(alert);
  const note = [alert.note, `时间：${alert.time}`].filter(Boolean).join(" · ");
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: alertCardTemplate(alert.level),
        title: {
          tag: "plain_text",
          content: truncateAlertText(alert.title, 80)
        }
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content
          }
        },
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: truncateAlertText(note, 220)
            }
          ]
        }
      ]
    }
  };
}

function buildFeishuAlertView({ title, level = "info", fields = {} }) {
  const baseTitle = stripAlertBotPrefix(title);
  const view =
    buildFeishuBotStartView(baseTitle, fields) ??
    buildFeishuWillBuyView(baseTitle, fields) ??
    buildFeishuBuyResultView(baseTitle, fields) ??
    buildFeishuReceiptView(baseTitle, fields) ??
    buildFeishuFundingView(baseTitle, fields) ??
    buildFeishuRouterApprovalView(baseTitle, fields) ??
    buildFeishuAutoSellView(baseTitle, fields) ??
    buildFeishuOpsView(baseTitle, fields) ??
    { facts: buildGenericAlertFacts(fields), note: "" };

  const facts = compactAlertFacts(view.facts).slice(0, 5);
  return {
    title: truncateAlertText(title, 96),
    level,
    facts: facts.length > 0 ? facts : [{ label: "状态", value: "已记录" }],
    note: formatReadableAlertValue(view.note),
    time: formatAlertTime(new Date())
  };
}

function buildFeishuBotStartView(title, fields) {
  if (!title.includes("bot 已启动")) return null;
  return {
    facts: [
      alertFact("状态", "运行中"),
      alertFact("模式", formatModeLabel(fieldValue(fields, ["mode"]))),
      alertFact("监听", formatDiscoveryLabel(fieldValue(fields, ["discovery"]))),
      alertFact("买入", fieldValue(fields, ["stake"])),
      alertFact("自动卖出", formatAutoSellStatus(fieldValue(fields, ["autoSell"])))
    ]
  };
}

function buildFeishuWillBuyView(title, fields) {
  if (!title.includes("新盘准备买入")) return null;
  const start = fieldValue(fields, ["开盘", "startDate"]);
  const duration = fieldValue(fields, ["时长", "duration"]);
  return {
    facts: [
      alertFact("状态", formatWillBuyState(fieldValue(fields, ["状态", "state"]))),
      alertFact("事件", fieldValue(fields, ["事件", "question"])),
      alertFact("买入", fieldValue(fields, ["买入", "stake"])),
      alertFact("时间", [formatAlertDateTime(start), duration].filter(Boolean).join(" · ")),
      alertFact("来源", formatAlertSource(fieldValue(fields, ["来源", "source"])))
    ],
    note: formatSelectionNote(fields)
  };
}

function buildFeishuBuyResultView(title, fields) {
  if (!title.includes("买入已广播") && !title.includes("买入成功") && !title.includes("买入失败") && !title.includes("买入未确认成功")) {
    return null;
  }
  const problem = title.includes("失败") || title.includes("未确认");
  const status = problem
    ? formatBuyProblemStatus(title, fields)
    : formatExecutionStatus(fieldValue(fields, ["status"]) || (title.includes("已广播") ? "broadcast" : "success"));
  return {
    facts: [
      alertFact("状态", status),
      alertFact(formatMarketFactLabel(fields), formatMarketFactValue(fields)),
      alertFact("投入", fieldValue(fields, ["stake"])),
      alertFact(problem ? "原因" : "交易", problem ? formatBuyProblemReason(fields) : formatTxLabel(fieldValue(fields, ["tx"]))),
      alertFact(problem ? "交易" : "", problem ? formatTxLabel(fieldValue(fields, ["tx"])) : "")
    ],
    note: problem ? "" : formatSelectionNote(fields)
  };
}

function buildFeishuReceiptView(title, fields) {
  if (!title.includes("买入确认成功") && !title.includes("交易 receipt 非成功")) return null;
  const failed = title.includes("非成功");
  return {
    facts: [
      alertFact("状态", failed ? "链上回执非成功" : "链上已确认"),
      alertFact("交易", formatTxLabel(fieldValue(fields, ["tx"]))),
      alertFact(failed ? "回执" : "区块", failed ? formatExecutionStatus(fieldValue(fields, ["status"])) : fieldValue(fields, ["block"])),
      alertFact("类型", formatContextLabel(fieldValue(fields, ["context"])))
    ]
  };
}

function buildFeishuFundingView(title, fields) {
  if (!title.includes("资金检查通过") && !title.includes("资金不足") && !title.includes("资金检查异常")) return null;
  if (title.includes("资金检查通过")) {
    return {
      facts: [
        alertFact("状态", "资金可执行"),
        alertFact("可买", formatExecutableFunding(fields)),
        alertFact("下一场", formatFundingNextStart(fields)),
        alertFact("BNB 预留", formatAmountWithUnit(fieldValue(fields, ["requiredBnb"]), "BNB")),
        alertFact("处理", fieldValue(fields, ["action"]))
      ]
    };
  }
  return {
    facts: [
      alertFact("状态", title.includes("异常") ? "检查异常" : "暂不会买入"),
      alertFact(title.includes("异常") ? "原因" : "缺口", title.includes("异常") ? fieldValue(fields, ["message", "reason"]) : fieldValue(fields, ["shortfall"])),
      alertFact("下一场", formatFundingNextStart(fields)),
      alertFact("处理", fieldValue(fields, ["action"]) || (title.includes("异常") ? "查看日志" : "补资金后自动恢复"))
    ]
  };
}

function buildFeishuRouterApprovalView(title, fields) {
  if (!title.includes("Router 授权")) return null;
  return {
    facts: [
      alertFact("状态", title.includes("补齐") ? "已补齐" : "已就绪"),
      alertFact("额度", fieldValue(fields, ["required"])),
      alertFact("授权", formatApprovalLabel(fieldValue(fields, ["approved"]))),
      alertFact("交易", formatTxLabel(fieldValue(fields, ["tx"])))
    ]
  };
}

function buildFeishuAutoSellView(title, fields) {
  if (!title.includes("自动卖出")) return null;
  const paused = title.includes("暂停");
  return {
    facts: [
      alertFact("状态", formatAutoSellAlertState(title)),
      alertFact("影响", paused ? "暂停自动卖出" : "部分卖出失败"),
      alertFact("事件", fieldValue(fields, ["first"])),
      alertFact("原因", fieldValue(fields, ["reason", "message"])),
      alertFact(paused ? "恢复" : "处理", paused ? formatAlertDateTime(fieldValue(fields, ["pausedUntil"])) : fieldValue(fields, ["action"]))
    ]
  };
}

function buildFeishuOpsView(title, fields) {
  if (
    !title.includes("WS") &&
    !title.includes("链上轮询") &&
    !title.includes("REST 补漏")
  ) {
    return null;
  }
  return {
    facts: [
      alertFact("状态", formatOpsState(title)),
      alertFact("当前", formatFallbackTarget(fieldValue(fields, ["fallback"]))),
      alertFact("原因", fieldValue(fields, ["message", "reason"])),
      alertFact("重试", formatDurationMs(fieldValue(fields, ["retryMs"])))
    ]
  };
}

function buildGenericAlertFacts(fields) {
  const facts = [];
  appendAlertFact(facts, "状态", fieldValue(fields, ["状态", "status"]));
  appendAlertFact(facts, "事件", fieldValue(fields, ["事件", "question"]));
  appendAlertFact(facts, "原因", fieldValue(fields, ["message", "reason"]));
  appendAlertFact(facts, "交易", formatTxLabel(fieldValue(fields, ["tx", "txHash"])));
  appendAlertFact(facts, "重试", formatDurationMs(fieldValue(fields, ["retryMs"])));
  appendAlertFact(facts, "来源", formatAlertSource(fieldValue(fields, ["来源", "source"])));

  for (const [key, value] of Object.entries(fields ?? {})) {
    if (facts.length >= 5) break;
    if (!isChineseAlertField(key) || isInternalAlertField(key)) continue;
    appendAlertFact(facts, key, value);
  }
  return facts;
}

function appendAlertFact(facts, label, value) {
  const fact = alertFact(label, value);
  if (fact) facts.push(fact);
}

function alertFact(label, value) {
  return { label, value };
}

function compactAlertFacts(facts = []) {
  const compacted = [];
  const seen = new Set();
  for (const fact of facts) {
    if (!fact?.label) continue;
    const value = formatReadableAlertValue(fact.value);
    if (!value) continue;
    const key = `${fact.label}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push({
      label: String(fact.label),
      value
    });
  }
  return compacted;
}

function formatFeishuAlertText(alert) {
  const prefix = alert.level === "info" ? "" : `${alertLevelLabel(alert.level)} · `;
  const lines = [`${prefix}${alert.title}`, ...formatFeishuAlertFacts(alert, { markdown: false }).split("\n")];
  if (alert.note) lines.push(`说明：${alert.note}`);
  lines.push(`时间：${alert.time}`);
  return lines.join("\n").slice(0, 3000);
}

function formatFeishuAlertFacts(alert, { markdown = true } = {}) {
  return alert.facts
    .map((fact, index) => {
      const line = `${fact.label}：${fact.value}`;
      return markdown && index === 0 ? `**${line}**` : line;
    })
    .join("\n")
    .slice(0, 2600);
}

function alertLevelLabel(level) {
  if (level === "warn") return "警告";
  if (level === "error") return "错误";
  return "提醒";
}

function alertCardTemplate(level) {
  if (level === "warn") return "orange";
  if (level === "error") return "red";
  return "blue";
}

function formatReadableAlertValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  if (typeof value === "object") {
    return "详情见日志";
  }
  return truncateAlertText(redactSecretUrls(String(value)), 500);
}

function stripAlertBotPrefix(title) {
  return String(title ?? "").replace(/^\[[^\]]+\]\s*/, "");
}

function fieldValue(fields, keys) {
  for (const key of keys) {
    const value = fields?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function isChineseAlertField(key) {
  return /[\u4e00-\u9fff]/.test(String(key));
}

function isInternalAlertField(key) {
  return ["排序", "兜底"].includes(String(key));
}

function formatModeLabel(value) {
  if (value === "execute") return "实盘";
  if (value === "dry-run") return "演练";
  return value;
}

function formatDiscoveryLabel(value) {
  if (value === "ws") return "WS 监听";
  if (value === "chain") return "链上轮询";
  if (value === "rest") return "官网轮询";
  return value;
}

function formatAutoSellStatus(value) {
  if (value === "off") return "关闭";
  return value;
}

function formatWillBuyState(value) {
  if (value === "pending") return "待开盘";
  if (value === "immediate") return "立即买入";
  return value;
}

function formatExecutionStatus(value) {
  if (value === "broadcast") return "已发出 · 等待确认";
  if (value === "success") return "已确认";
  if (value === "reverted") return "链上回滚";
  if (value === "failed") return "失败";
  if (value === "unknown") return "未知";
  return value;
}

function formatBuyProblemStatus(title, fields) {
  if (title.includes("未确认")) return "未确认成功";
  return formatExecutionStatus(fieldValue(fields, ["status"])) || "失败";
}

function formatBuyProblemReason(fields) {
  return fieldValue(fields, ["message"]) ||
    formatExecutionStatus(fieldValue(fields, ["status"])) ||
    "详情见日志";
}

function formatMarketFactLabel(fields) {
  if (fieldValue(fields, ["question"])) return "事件";
  return "市场";
}

function formatMarketFactValue(fields) {
  const question = fieldValue(fields, ["question"]);
  if (question) return question;
  const marketCount = fieldValue(fields, ["markets"]);
  if (marketCount) return `${marketCount} 个同期开盘市场`;
  return formatAddressLabel(fieldValue(fields, ["market"]));
}

function formatSelectionNote(fields) {
  const fallback = fieldValue(fields, ["fallback", "fallbackReason", "兜底"]);
  const rankSource = fieldValue(fields, ["rankSource", "排序"]);
  if (fallback) return `选择：${formatFallbackReason(fallback, rankSource)}`;
  if (rankSource && rankSource !== "payout") return `选择：${formatRankSource(rankSource)}`;
  return "";
}

function formatRankSource(value) {
  if (value === "payout") return "按实时赔率";
  if (value === "token_order") return "按链上顺序";
  return formatInternalLabel(value);
}

function formatFallbackReason(value, rankSource = "") {
  if (value === "missing_complete_odds_data") return `赔率不完整，已${formatRankSource(rankSource || "token_order")}`;
  if (value === "missing_odds_data") return `缺少赔率，已${formatRankSource(rankSource || "token_order")}`;
  return formatInternalLabel(value);
}

function formatContextLabel(value) {
  if (value === "single") return "单市场";
  if (value === "bundle") return "批量";
  return "";
}

function formatExecutableFunding(fields) {
  const markets = fieldValue(fields, ["executableMarkets"]);
  const total = fieldValue(fields, ["totalMarkets"]);
  const unfunded = fieldValue(fields, ["unfundedMarkets"]);
  const busdt = formatAmountWithUnit(fieldValue(fields, ["executableBusdt"]), "BUSDT");
  const marketText = markets && total ? `${markets}/${total} 场` : (markets ? `${markets} 场` : "");
  const suffix = unfunded && Number(unfunded) > 0 ? " · 部分可买" : "";
  if (marketText && busdt) return `${marketText} / ${busdt}${suffix}`;
  if (marketText) return `${marketText}${suffix}`;
  if (busdt) return busdt;
  if (fieldValue(fields, ["partialFunding"])) return "部分可买";
  return "";
}

function formatFundingNextStart(fields) {
  const start = formatAlertDateTime(fieldValue(fields, ["nextStart", "startDate"]));
  const wait = formatDurationMs(fieldValue(fields, ["msUntilNextStart"]));
  if (start && wait) return `${start} · ${wait}`;
  if (start) return start;
  return "";
}

function formatAmountWithUnit(value, unit) {
  const formatted = formatReadableAlertValue(value);
  if (!formatted) return "";
  if (/[A-Za-z\u4e00-\u9fff%]/.test(formatted)) return formatted;
  return `${formatted} ${unit}`;
}

function formatApprovalLabel(value) {
  if (value === "yes") return "已发送授权";
  if (value === "ready") return "已就绪";
  return value;
}

function formatAutoSellAlertState(title) {
  if (title.includes("暂停")) return "已暂停";
  if (title.includes("错误") || title.includes("异常")) return "需要检查";
  if (title.includes("触发")) return "已触发";
  return "已记录";
}

function formatAutoSellExecution(fields) {
  const triggered = fieldValue(fields, ["triggered"]);
  const executed = fieldValue(fields, ["executed"]);
  const parts = [];
  if (triggered !== "") parts.push(`触发 ${triggered}`);
  if (executed !== "") parts.push(`成交 ${executed}`);
  return parts.join(" / ");
}

function formatNonZeroCount(value) {
  if (value === "" || Number(value) === 0) return "";
  return value;
}

function formatOpsState(title) {
  if (title.includes("已降级")) return "已自动降级";
  if (title.includes("异常")) return "监听异常";
  return "需要检查";
}

function formatFallbackTarget(value) {
  if (value === "chain polling") return "链上轮询";
  if (value === "REST polling") return "官网轮询";
  return value;
}

function formatTxLabel(value) {
  const tx = formatReadableAlertValue(value);
  if (!tx) return "";
  return shortHex(tx);
}

function formatAddressLabel(value) {
  const text = formatReadableAlertValue(value);
  if (!text) return "";
  return shortHex(text);
}

function shortHex(value) {
  const text = String(value);
  if (!/^0x[0-9a-fA-F]{16,}$/.test(text)) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatAlertDateTime(value) {
  const text = formatReadableAlertValue(value);
  if (!text) return "";
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return text;
  return new Date(time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatAlertTime(date) {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatDurationMs(value) {
  if (value === undefined || value === null || value === "") return "";
  const ms = Number(value);
  if (!Number.isFinite(ms)) return value;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${roundToken(ms / 1000, 1)}秒`;
  return `${roundToken(ms / 60000, 1)}分钟`;
}

function formatInternalLabel(value) {
  return formatReadableAlertValue(value).replace(/_/g, " ");
}

function truncateAlertText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWakeSignal() {
  let wakeCurrent = null;
  return {
    wake() {
      const wake = wakeCurrent;
      wakeCurrent = null;
      wake?.();
    },
    wait(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          if (wakeCurrent === done) wakeCurrent = null;
          resolve();
        }
        if (wakeCurrent) wakeCurrent();
        wakeCurrent = done;
      });
    }
  };
}

async function promptHidden(question) {
  if (process.platform === "darwin" && process.env.NO_GUI_PROMPT !== "1") {
    return promptMacDialog(question, { hidden: true });
  }
  if (process.stdin.isTTY) return promptHiddenTty(question);
  throw new Error("PRIVATE_KEY is required; set it in environment or run from a TTY");
}

async function requireExactConfirmation(question, expected) {
  if (process.platform === "darwin" && process.env.NO_GUI_PROMPT !== "1") {
    await confirmMacDialog(question, expected);
    return;
  }
  const answer = await promptLine(`${question}`);
  if (answer.trim() !== expected) {
    throw new Error(`Confirmation mismatch; expected ${expected}`);
  }
}

async function promptMacDialog(question, { hidden }) {
  const hiddenClause = hidden ? " with hidden answer" : "";
  const script = `text returned of (display dialog ${appleString(question)} default answer ""${hiddenClause} buttons {"取消", "继续"} default button "继续" cancel button "取消")`;
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}

async function confirmMacDialog(question, confirmLabel) {
  const script = `display dialog ${appleString(question)} buttons {"取消", ${appleString(confirmLabel)}} default button ${appleString(confirmLabel)} cancel button "取消"`;
  await execFileAsync("osascript", ["-e", script], {
    timeout: 120000,
    maxBuffer: 1024 * 1024
  });
}

async function promptLine(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function promptHiddenTty(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = "";

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
    }

    function onData(chunk) {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Interrupted"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function appleString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function nextWatchSleepMs(cfg, pending) {
  const defaultMs = cfg.pollMs;
  if (!pending || pending.size === 0) return defaultMs;

  let minActionWaitMs = Infinity;
  for (const record of pending.values()) {
    minActionWaitMs = Math.min(minActionWaitMs, msUntilRecordAction(record, cfg));
  }
  if (!Number.isFinite(minActionWaitMs)) return defaultMs;
  if (minActionWaitMs <= cfg.preopenHotMs) {
    return Math.max(1, Math.min(defaultMs, cfg.hotPollMs, minActionWaitMs));
  }
  return defaultMs;
}

function msUntilStart(market) {
  const start = new Date(market.startDate).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, start - Date.now());
}

function msUntilAction(market, cfg) {
  return Math.max(0, marketActionTimeMs(market, cfg) - Date.now());
}

function msUntilRecordAction(record, cfg) {
  const actionWaitMs = msUntilAction(pendingMarket(record), cfg);
  const retryWaitMs = Math.max(0, Number(record?.executionRetryAfterMs ?? 0) - Date.now());
  return Math.max(actionWaitMs, retryWaitMs);
}

function marketActionTimeMs(market, cfg) {
  const start = new Date(market?.startDate).getTime();
  if (!Number.isFinite(start)) return Date.now();
  const prebroadcastMs = effectivePrebroadcastMs(cfg);
  if (prebroadcastMs > 0) return start - prebroadcastMs;
  return start + effectivePostOpenBroadcastDelayMs(cfg);
}

function effectivePrebroadcastMs(cfg) {
  return cfg.allowPreopenBroadcast ? Number(cfg.prebroadcastMs ?? 0) : 0;
}

function effectivePostOpenBroadcastDelayMs(cfg) {
  return effectivePrebroadcastMs(cfg) > 0 ? 0 : Number(cfg.openBroadcastDelayMs ?? 0);
}

function isTerminalMinedFailure(result) {
  if (!result?.usedPreSignedTransaction) return false;
  if (!result.blockNumber) return false;
  return result.status && result.status !== "success" && result.status !== "broadcast";
}

function isPreopenBroadcastResult(result, market) {
  const broadcastAt = Date.parse(result?.broadcastStartedAt ?? "");
  const startAt = Date.parse(market?.startDate ?? "");
  return Number.isFinite(broadcastAt) && Number.isFinite(startAt) && broadcastAt < startAt;
}

function errorMessage(error) {
  const message = error?.message ?? String(error);
  const cause = error?.cause?.message ? `: ${error.cause.message}` : "";
  return redactSecretUrls(`${message}${cause}`);
}

function wsProviderLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function redactSecretUrls(message) {
  return String(message).replace(/(?:https?|wss?):\/\/[^\s")]+/g, (raw) => {
    try {
      const url = new URL(raw);
      if (/chainstack|ankr|rpc|open\.feishu\.cn/i.test(url.hostname)) {
        return `${url.protocol}//${url.hostname}/***`;
      }
      return raw;
    } catch {
      return "[redacted-url]";
    }
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", message: errorMessage(error) }, null, 2));
  process.exitCode = 1;
});
