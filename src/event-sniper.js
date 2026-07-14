#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { decodeFunctionData, formatUnits, parseGwei, parseUnits } from "viem";
import WebSocket from "ws";
import { appendJsonl, loadSeen, normalizeRuntimeConfig, parseArgs, readConfig, saveSeen } from "./config.js";
import { appendGasLedgerEntries, bnbUsdtPriceForBlock, buildGasLedgerEntry } from "./gas-ledger.js";
import {
  approveRouterMax,
  applyBuilderBundleTimingPreset,
  assertExecutionAllowed,
  buildDirectSellPlan,
  buildFastBuyBundlePlan,
  buildBuilderBundleDryRun,
  buildDirectBuyAllOutcomesPlan,
  buildMarketFromCreationLog,
  buildMarketsFromControllerLogs,
  buyOutcomesBatch,
  broadcastPreSignedFastTransaction,
  broadcastSignedTransaction,
  calculateFastGasReserve,
  clearTimestampGuardFallbackTransactions,
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
  getTimestampGuardFallbackTransactions,
  makeClients,
  makeWsClient,
  preSignSellOutcomesBatch,
  preSignFastBundleTransaction,
  preSignFastBuyTransaction,
  quoteSellOutcome,
  quoteBuyAllOutcomes,
  resolveBuilderBundleTimingPreset,
  resolveWalletBudgetGasLimit,
  roundDownSellAmount,
  sellOutcome,
  sellOutcomesBatch,
  simulateMintAmount,
  submitPreSignedBuilderBundle,
  warmBuilderBundleClient,
  warmBroadcastRpcClients,
  withPrebuiltFastExecution,
  watchControllerLogs
} from "./fortytwo.js";
import {
  eventSeenKey,
  eventDurationMs,
  filterEventMarkets,
  getEventMarketDecision,
  getEventMarketDisplayDecision,
  isPriceMarket,
  selectEventMarket,
  summarizeEventMarket
} from "./event-strategy.js";
import { isMemeIntelMarket, isSportsExactScoreMarket, isSportsSideMarketQuestion } from "./event-intel.js";
import {
  annotateBot3FifaExactScorePlan,
  BOT3_FIFA_EXACT_SCORE_AUTO_OUTCOME_COUNT,
  bot3FifaExactScoreAutoBuyActive,
  bot3FifaExactScoreConfigForMarket,
  previewBot3FifaExactScoreMarket
} from "./bot3-fifa-exact-score.js";
import { FOLLOW_RULE_EVENT_LIBRARY, FOLLOW_RULE_LIBRARY_CONFIG } from "./event-library.js";
import { isMarketFollowBlocked } from "./market-follow.js";
import {
  lockedMemeRangeOutcomeNames,
  runMemeRangeSelectionSelfTest
} from "./meme-range-selection.js";
import { encodeTimedBuyExecutorCall, TIMED_BUY_EXECUTOR_ABI } from "./timed-buy-executor.js";

const execFileAsync = promisify(execFile);
const PUBLIC_TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PUBLIC_TEST_RECEIVER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const alertCooldowns = new Map();
const marketDecisionDedupe = new Set();
const builderTargetExpiryWatches = new Set();
const plannedBuysFileCache = new Map();
const memeRangeSelectionFileCache = new Map();
const autoSellBuyRecordsCache = new Map();
const WILL_BUY_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const SELL_BATCH_BASE_GAS = 1_500_000;
const SELL_BATCH_PER_OUTCOME_GAS = 1_000_000;
const OPERATOR_APPROVAL_GAS = 250_000;
const AUTO_SELL_TRANSIENT_POSITIONS_ALERT_AFTER = 12;
const RUNTIME_HEALTH_INTERVAL_MS = 5000;
let runtimeHealthWriteWarningAt = 0;

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
  if (command === "bot3-fifa-preview") {
    await bot3FifaPreview(cfg, args);
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
  if (command === "premium-probe") {
    await premiumProbe(cfg, args);
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

async function bot3FifaPreview(cfg, args = {}) {
  const limit = Number(args.limit ?? cfg.watchScanLimit ?? 50);
  if (args.market) {
    const market = await fetchMarket(cfg, args.market);
    console.log(JSON.stringify({
      level: "bot3-fifa-exact-score-preview",
      enabled: bot3FifaExactScoreAutoBuyActive(cfg),
      preview: previewBot3FifaExactScoreMarket(market)
    }, null, 2));
    return;
  }

  const markets = await loadRawRestMarkets(cfg, { status: args.status ?? "all", limit });
  const previews = sortMarketsByStartAsc(markets)
    .map((market) => previewBot3FifaExactScoreMarket(market))
    .filter((preview) => preview.skipReason !== "not_fifa_sports_exact_score")
    .slice(0, Number(args.show ?? 20));
  console.log(JSON.stringify({
    level: "bot3-fifa-exact-score-previews",
    enabled: bot3FifaExactScoreAutoBuyActive(cfg),
    checked: markets.length,
    shown: previews.length,
    previews
  }, null, 2));
}

async function positions(cfg, args) {
  const walletAddress = args.wallet ?? cfg.walletAddress;
  if (!walletAddress) throw new Error("positions requires --wallet or WALLET_ADDRESS");

  const openPositions = await fetchOpenPositions(cfg, {
    user: walletAddress,
    market: args.market,
    limit: Number(args.limit ?? 100)
  });
  const rows = openPositions.map((position) => summarizePosition(position, cfg));
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
  const gasReserve = await estimateFundingGasReserve(publicClient, cfg, requirement);
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
      const execution = await sellOutcome(cfg, item.plan);
      executions.push(execution);
      await appendGasLedgerFromExecution(cfg, execution, {
        action: "sell",
        source: "manual-sell-cli",
        wallet: walletAddress,
        allocations: gasAllocationsFromSellItem(item)
      });
      await appendGasLedgerFromExecution(cfg, execution, {
        action: "approval",
        source: "manual-sell-cli-approval",
        wallet: walletAddress,
        txHashKey: "operatorApprovalHash",
        fieldPrefix: "operatorApproval",
        allocations: gasAllocationsFromSellItem(item).map((allocation) => ({
          ...allocation,
          action: "approval",
          weight: 1
        }))
      });
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
      const gasReserveForWallet = await estimateFundingGasReserve(publicClient, cfg, executableFunding);
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
  const gasReserve = await estimateFundingGasReserve(
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
      selectedOutcomes: record.preparedPlan?.outcomes?.map((outcome) => outcome.name) ?? [],
      selection: record.preparedPlan?.selection ?? null,
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
      botName: cfg.botName,
      profileRole: cfg.profileRole || "",
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
      memeRangeSelectionEnabled: cfg.memeRangeSelectionEnabled,
      memeRangeSelectionFile: cfg.memeRangeSelectionFile,
      memeRangeSelectionOutcomeCount: cfg.memeRangeSelectionOutcomeCount,
      memeRangeSelectionPolicy: cfg.memeRangeSelectionEnabled
        ? "first_observation_lock_then_middle_fallback"
        : "disabled",
      filterMode: cfg.filterMode ?? "production",
      marketQuestionAllowlistRegex: cfg.marketQuestionAllowlistRegex?.source ?? null,
      autoSellEnabled: cfg.autoSellEnabled,
      autoSellStrategy: cfg.autoSellStrategy,
      autoSellStartDelaySeconds: cfg.autoSellStartDelaySeconds,
      autoSellIntervalSeconds: cfg.autoSellIntervalSeconds,
      autoSellChunkPercent: cfg.autoSellChunkPercent,
      autoSellLadderProfitPercent: cfg.autoSellLadderProfitPercent,
      autoSellTakeProfitSteps: cfg.autoSellTakeProfitSteps,
      autoSellApplyAfterIso: cfg.autoSellApplyAfterIso,
      autoSellOpenExitDelaySeconds: cfg.autoSellOpenExitDelaySeconds,
      autoSellOpenExitPercent: cfg.autoSellOpenExitPercent,
      autoSellFastOpenExitEnabled: cfg.autoSellFastOpenExitEnabled,
      autoSellFastOpenExitMinDelayMs: cfg.autoSellFastOpenExitMinDelayMs,
      autoSellFastOpenExitMaxDelayMs: cfg.autoSellFastOpenExitMaxDelayMs,
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
      builderBundle: builderBundleConfigSummary(cfg),
      preSignFastTx: cfg.preSignFastTx,
      preSignWindowMs: cfg.preSignWindowMs,
      preSignRetryMs: cfg.preSignRetryMs,
      allowPreopenBroadcast: cfg.allowPreopenBroadcast,
      prebroadcastMs: cfg.prebroadcastMs,
      openBroadcastDelayMs: cfg.openBroadcastDelayMs,
      openBroadcastMode: cfg.openBroadcastMode,
      openBroadcastBlockTargetOffsetMs: cfg.openBroadcastBlockTargetOffsetMs,
      openBroadcastBlockAwareLeadMs: cfg.openBroadcastBlockAwareLeadMs,
      openBroadcastBlockAwareMaxWaitMs: cfg.openBroadcastBlockAwareMaxWaitMs,
      openBroadcastBlockAwarePreTargetCount: cfg.openBroadcastBlockAwarePreTargetCount,
      openBroadcastBlockAwarePreTargetSendMs: cfg.openBroadcastBlockAwarePreTargetSendMs,
      openBroadcastBlockAwareHeadMaxAgeMs: cfg.openBroadcastBlockAwareHeadMaxAgeMs,
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
      autoSellLadderProfitPercent: cfg.autoSellLadderProfitPercent,
      autoSellTakeProfitSteps: cfg.autoSellTakeProfitSteps,
      autoSellApplyAfterIso: cfg.autoSellApplyAfterIso,
      autoSellOpenExitDelaySeconds: cfg.autoSellOpenExitDelaySeconds,
      autoSellOpenExitPercent: cfg.autoSellOpenExitPercent,
      autoSellFastOpenExitEnabled: cfg.autoSellFastOpenExitEnabled,
      autoSellFastOpenExitMinDelayMs: cfg.autoSellFastOpenExitMinDelayMs,
      autoSellFastOpenExitMaxDelayMs: cfg.autoSellFastOpenExitMaxDelayMs,
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
      autoSellLadderProfitPercent: cfg.autoSellLadderProfitPercent,
      autoSellTakeProfitSteps: cfg.autoSellTakeProfitSteps,
      autoSellFastOpenExitEnabled: cfg.autoSellFastOpenExitEnabled,
      autoSellFastOpenExitMinDelayMs: cfg.autoSellFastOpenExitMinDelayMs,
      autoSellFastOpenExitMaxDelayMs: cfg.autoSellFastOpenExitMaxDelayMs,
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

async function premiumProbe(cfg, args) {
  const { publicClient } = makeClients(cfg);
  const probeCfg = {
    ...cfg,
    dryRun: true,
    execute: false,
    eventBuyMode: "quoted",
    eventOutcomeSelection: "lowest_odds",
    eventOutcomeCount: 1,
    stakePerOutcomeUsdt: Number(args.stake ?? args.stakeUsdt ?? 1),
    maxMarketStakeUsdt: Math.max(Number(args.stake ?? args.stakeUsdt ?? 1), Number(cfg.maxMarketStakeUsdt ?? 1)),
    maxOutcomesPerMarket: cfg.maxOutcomesPerMarket
  };
  if (!Number.isFinite(probeCfg.stakePerOutcomeUsdt) || probeCfg.stakePerOutcomeUsdt <= 0) {
    throw new Error("--stake must be a positive number");
  }

  const { markets, startDate, discovery } = await loadPremiumProbeBatch(probeCfg, args);
  if (markets.length === 0) throw new Error("No upcoming probeable Event Markets found");

  const startMs = new Date(startDate).getTime();
  const waitMs = startMs - Date.now();
  const wait = args.noWait ? false : true;
  const maxWaitMs = args.maxWaitMs === undefined ? Infinity : Number(args.maxWaitMs);
  const outputBase = premiumProbeOutputBase(args.outputDir ?? "output", startDate);
  const jsonlFile = `${outputBase}.jsonl`;
  const mdFile = `${outputBase}.md`;

  const header = {
    level: "event-premium-probe",
    mode: "read-only",
    note: "simulateMint only; no signing, broadcast, seen/fills/runtime mutation",
    startDate,
    waitMs: Math.max(0, waitMs),
    wait,
    marketCount: markets.length,
    stakeUsdt: probeCfg.stakePerOutcomeUsdt,
    files: { jsonlFile, mdFile },
    discovery,
    markets: markets.map((market) => ({
      question: market.question,
      address: market.address,
      status: market.status,
      outcomeCount: market.outcomes?.length ?? 0
    }))
  };
  console.log(JSON.stringify(header, null, 2));

  if (waitMs > 0) {
    if (!wait || (Number.isFinite(maxWaitMs) && maxWaitMs >= 0 && waitMs > maxWaitMs)) {
      writePremiumProbeFiles({ header, samples: [], summaries: [], aggregate: [], jsonlFile, mdFile });
      return;
    }
    await sleepUntil(startMs);
  }

  const samples = [];
  let nextSampleAt = Math.max(Date.now(), startMs);
  let validBaselineSamples = 0;
  while (true) {
    await sleepUntil(nextSampleAt);
    const localNow = Date.now();
    const sample = await samplePremiumProbeBatch(publicClient, probeCfg, markets, startMs, localNow);
    samples.push(...sample.rows);
    if (sample.rows.some((row) => row.ok && Number(row.chainOffsetSeconds) >= 20)) {
      validBaselineSamples += 1;
    }

    const localOffsetMs = localNow - startMs;
    const maxLocalOffsetMs = Number(args.maxOffsetMs ?? 23000);
    if ((validBaselineSamples >= 3 && localOffsetMs >= 20000) || localOffsetMs >= maxLocalOffsetMs) break;
    const intervalMs = localOffsetMs < 15000 ? 1000 : 500;
    nextSampleAt += intervalMs;
    if (nextSampleAt <= Date.now()) nextSampleAt = Date.now();
  }

  const { enriched, summaries, aggregate } = analyzePremiumProbeSamples(samples);
  writePremiumProbeFiles({ header, samples: enriched, summaries, aggregate, jsonlFile, mdFile });
  console.log(JSON.stringify({
    level: "event-premium-probe-complete",
    startDate,
    marketCount: markets.length,
    sampleRows: enriched.length,
    summaries,
    aggregate,
    files: { jsonlFile, mdFile }
  }, null, 2));
}

async function loadPremiumProbeBatch(cfg, args = {}) {
  const rawMarkets = await loadRawRestMarkets(cfg, { status: "all", limit: Number(args.limit ?? cfg.watchScanLimit) });
  const candidates = rawMarkets
    .filter((market) => isPremiumProbeCandidate(market, cfg))
    .sort(compareStartAsc);
  const startDate = args.startDate ?? candidates[0]?.startDate;
  if (!startDate) return { markets: [], startDate: null, discovery: { rawRestMarkets: rawMarkets.length, candidates: 0 } };
  const startMs = new Date(startDate).getTime();
  const selected = candidates.filter((market) => new Date(market.startDate).getTime() === startMs);
  const hydrated = await Promise.all(selected.map((market) => maybeHydrateMarketOdds(cfg, market)));
  return {
    markets: hydrated.filter((market) => isPremiumProbeCandidate(market, cfg)),
    startDate: new Date(startMs).toISOString(),
    discovery: {
      rawRestMarkets: rawMarkets.length,
      candidates: candidates.length,
      selectedAtStart: selected.length
    }
  };
}

function isPremiumProbeCandidate(market, cfg) {
  if (!market?.address) return false;
  if (!["live", "not_started"].includes(String(market.status ?? ""))) return false;
  const startMs = new Date(market.startDate).getTime();
  if (!Number.isFinite(startMs) || startMs < Date.now() - 1000) return false;
  if (Number(market.contractVersion) !== 2) return false;
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) return false;
  if (isPriceMarket(market, { ...cfg, marketCategoryBlocklist: ["Price"], marketTagBlocklist: ["Price"] })) return false;
  return true;
}

async function samplePremiumProbeBatch(publicClient, cfg, markets, startMs, localNow) {
  let block = null;
  let blockError = null;
  try {
    block = await publicClient.getBlock({ blockTag: "latest" });
  } catch (error) {
    blockError = errorMessage(error);
  }
  const chainTimestampMs = block?.timestamp !== undefined ? Number(block.timestamp) * 1000 : null;
  const chainOffsetSeconds = Number.isFinite(chainTimestampMs) ? (chainTimestampMs - startMs) / 1000 : null;
  const common = {
    sampleAt: new Date(localNow).toISOString(),
    localOffsetMs: Math.round(localNow - startMs),
    chainBlock: block?.number?.toString() ?? null,
    chainTimestamp: Number.isFinite(chainTimestampMs) ? new Date(chainTimestampMs).toISOString() : null,
    chainOffsetSeconds: chainOffsetSeconds === null ? null : roundNumber(chainOffsetSeconds, 3),
    blockError
  };
  const rows = await Promise.all(markets.map((market) => samplePremiumProbeMarket(publicClient, cfg, market, common)));
  return { rows };
}

async function samplePremiumProbeMarket(publicClient, cfg, market, common) {
  try {
    const quote = await quoteBuyAllOutcomes(publicClient, market, cfg);
    const outcome = quote.outcomes[0];
    if (!outcome) throw new Error("No selected outcome");
    const simulated = outcome.simulated;
    const amount = simulated.amount;
    const otToUser = tokenNumber(simulated.otToUser);
    const stakeUsdt = tokenNumber(amount);
    const effectiveCost = otToUser > 0 ? stakeUsdt / otToUser : null;
    const post = simulated.post ?? {};
    return {
      ok: true,
      ...common,
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      tokenId: String(outcome.tokenId),
      outcomeName: outcome.name ?? outcome.title ?? "",
      rankSource: outcome.selectionRankSource ?? quote.selection?.rankSource ?? null,
      selectionScore: outcome.selectionScore ?? null,
      stakeUsdt,
      otToUser: roundNumber(otToUser, 9),
      otPerUsdt: stakeUsdt > 0 ? roundNumber(otToUser / stakeUsdt, 9) : null,
      effectiveCost: effectiveCost === null ? null : roundNumber(effectiveCost, 9),
      postPayoutPerOt: roundNumber(tokenNumber(post.payoutPerOt ?? post[4] ?? 0n), 9),
      postTotalMarketCap: roundNumber(tokenNumber(post.totalMarketCap ?? post[3] ?? 0n), 6),
      collateralFromUser: roundNumber(tokenNumber(simulated.collateralFromUser), 9),
      collateralToTreasury: roundNumber(tokenNumber(simulated.collateralToTreasury), 9),
      collateralToIntegrator: roundNumber(tokenNumber(simulated.collateralToIntegrator), 9),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      ...common,
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      tokenId: null,
      outcomeName: null,
      rankSource: null,
      selectionScore: null,
      error: errorMessage(error)
    };
  }
}

function analyzePremiumProbeSamples(samples) {
  const byMarket = new Map();
  for (const sample of samples) {
    const key = String(sample.market ?? "unknown").toLowerCase();
    const rows = byMarket.get(key) ?? [];
    rows.push(sample);
    byMarket.set(key, rows);
  }

  const summaries = [];
  const enriched = [];
  for (const rows of byMarket.values()) {
    rows.sort((a, b) => Number(a.localOffsetMs ?? 0) - Number(b.localOffsetMs ?? 0));
    const baseline = rows.find((row) => row.ok && Number(row.chainOffsetSeconds) >= 20 && Number(row.effectiveCost) > 0);
    const peakEstimates = [];
    for (const row of rows) {
      const next = { ...row };
      if (baseline && row.ok && Number(row.effectiveCost) > 0 && Number(row.otToUser) > 0) {
        next.baselineLocalOffsetMs = baseline.localOffsetMs;
        next.baselineChainOffsetSeconds = baseline.chainOffsetSeconds;
        next.observedPremiumPct = roundNumber((Number(row.effectiveCost) / Number(baseline.effectiveCost) - 1) * 100, 4);
        next.otShortfallPct = roundNumber((1 - Number(row.otToUser) / Number(baseline.otToUser)) * 100, 4);
        const remainingFraction = Math.max(0, (20 - Number(row.chainOffsetSeconds ?? 20)) / 20);
        next.remainingPremiumFraction = roundNumber(remainingFraction, 4);
        if (remainingFraction > 0.05 && Number.isFinite(next.observedPremiumPct)) {
          peakEstimates.push(next.observedPremiumPct / remainingFraction);
        }
      } else {
        next.baselineLocalOffsetMs = baseline?.localOffsetMs ?? null;
        next.baselineChainOffsetSeconds = baseline?.chainOffsetSeconds ?? null;
        next.observedPremiumPct = null;
        next.otShortfallPct = null;
        next.remainingPremiumFraction = null;
      }
      enriched.push(next);
    }
    const validRows = rows.filter((row) => row.ok);
    summaries.push({
      market: rows[0]?.market ?? null,
      question: rows[0]?.question ?? null,
      tokenId: validRows[0]?.tokenId ?? null,
      outcomeName: validRows[0]?.outcomeName ?? null,
      rankSource: validRows[0]?.rankSource ?? null,
      sampleCount: rows.length,
      validSampleCount: validRows.length,
      baselineLocalOffsetMs: baseline?.localOffsetMs ?? null,
      baselineChainOffsetSeconds: baseline?.chainOffsetSeconds ?? null,
      baselineEffectiveCost: baseline?.effectiveCost ?? null,
      inferredPeakPremiumPctMedian: peakEstimates.length ? roundNumber(median(peakEstimates), 4) : null,
      firstError: rows.find((row) => !row.ok)?.error ?? null
    });
  }

  return {
    enriched: enriched.sort((a, b) => String(a.market).localeCompare(String(b.market)) || Number(a.localOffsetMs ?? 0) - Number(b.localOffsetMs ?? 0)),
    summaries,
    aggregate: {
      chainOffset: aggregatePremiumProbe(enriched, {
        field: "chainOffsetSeconds",
        bucketSize: 0.5,
        outputField: "chainOffsetSeconds"
      }),
      localOffset: aggregatePremiumProbe(enriched, {
        field: "localOffsetMs",
        bucketSize: 500,
        outputField: "localOffsetMs"
      })
    }
  };
}

function aggregatePremiumProbe(rows, { field, bucketSize, outputField }) {
  const buckets = new Map();
  for (const row of rows) {
    if (!row.ok || row.observedPremiumPct === null || row.observedPremiumPct === undefined) continue;
    const value = Number(row[field]);
    if (!Number.isFinite(value)) continue;
    const bucketValue = Math.round(value / bucketSize) * bucketSize;
    const bucket = buckets.get(bucketValue) ?? [];
    bucket.push(Number(row.observedPremiumPct));
    buckets.set(bucketValue, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketValue, values]) => ({
      [outputField]: roundNumber(bucketValue, 3),
      medianObservedPremiumPct: roundNumber(median(values), 4),
      p25ObservedPremiumPct: roundNumber(quantile(values, 0.25), 4),
      p75ObservedPremiumPct: roundNumber(quantile(values, 0.75), 4),
      minObservedPremiumPct: roundNumber(Math.min(...values), 4),
      maxObservedPremiumPct: roundNumber(Math.max(...values), 4),
      sampleCount: values.length
    }));
}

function writePremiumProbeFiles({ header, samples, summaries, aggregate, jsonlFile, mdFile }) {
  fs.mkdirSync(path.dirname(jsonlFile), { recursive: true });
  fs.writeFileSync(jsonlFile, samples.map((row) => JSON.stringify(row)).join("\n") + (samples.length ? "\n" : ""));
  fs.writeFileSync(mdFile, renderPremiumProbeMarkdown({ header, samples, summaries, aggregate }));
}

function renderPremiumProbeMarkdown({ header, samples, summaries, aggregate }) {
  const lines = [
    "# Anti-Sniping Premium Probe",
    "",
    `- Mode: ${header.mode}`,
    `- Start date: ${header.startDate ?? "n/a"}`,
    `- Stake: ${header.stakeUsdt}U simulated per quote`,
    `- Markets: ${header.marketCount}`,
    `- Note: ${header.note}`,
    "",
    "## Aggregate By Chain Offset",
    "",
    "| chain offset | median premium % | p25 | p75 | min | max | n |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  const chainAggregate = aggregate?.chainOffset ?? [];
  if (chainAggregate.length === 0) {
    lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | 0 |");
  } else {
    for (const row of chainAggregate) {
      lines.push(`| T+${fmt(row.chainOffsetSeconds)}s | ${fmt(row.medianObservedPremiumPct)} | ${fmt(row.p25ObservedPremiumPct)} | ${fmt(row.p75ObservedPremiumPct)} | ${fmt(row.minObservedPremiumPct)} | ${fmt(row.maxObservedPremiumPct)} | ${row.sampleCount} |`);
    }
  }

  lines.push(
    "",
    "## Aggregate By Local Offset",
    "",
    "| local offset | median premium % | p25 | p75 | min | max | n |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  const localAggregate = aggregate?.localOffset ?? [];
  if (localAggregate.length === 0) {
    lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | 0 |");
  } else {
    for (const row of localAggregate) {
      lines.push(`| ${formatOffset(row.localOffsetMs)} | ${fmt(row.medianObservedPremiumPct)} | ${fmt(row.p25ObservedPremiumPct)} | ${fmt(row.p75ObservedPremiumPct)} | ${fmt(row.minObservedPremiumPct)} | ${fmt(row.maxObservedPremiumPct)} | ${row.sampleCount} |`);
    }
  }

  lines.push("", "## Markets", "");
  for (const summary of summaries) {
    lines.push(`### ${summary.question ?? summary.market}`);
    lines.push("");
    lines.push(`- Market: \`${summary.market}\``);
    lines.push(`- Outcome: ${summary.outcomeName ?? "n/a"} (${summary.tokenId ?? "n/a"})`);
    lines.push(`- Rank source: ${summary.rankSource ?? "n/a"}`);
    lines.push(`- Baseline: local ${formatOffset(summary.baselineLocalOffsetMs)}, chain ${summary.baselineChainOffsetSeconds ?? "n/a"}s`);
    lines.push(`- Inferred peak premium median: ${fmt(summary.inferredPeakPremiumPctMedian)}%`);
    if (summary.firstError) lines.push(`- First error: ${summary.firstError}`);
    lines.push("");
    lines.push("| local offset | chain offset | block | ot/user | ot/USDT | effective cost | premium % | OT shortfall % |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    const rows = samples.filter((row) => String(row.market).toLowerCase() === String(summary.market).toLowerCase());
    for (const row of rows) {
      lines.push(`| ${formatOffset(row.localOffsetMs)} | ${fmt(row.chainOffsetSeconds)} | ${row.chainBlock ?? ""} | ${fmt(row.otToUser)} | ${fmt(row.otPerUsdt)} | ${fmt(row.effectiveCost)} | ${fmt(row.observedPremiumPct)} | ${fmt(row.otShortfallPct)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function premiumProbeOutputBase(outputDir, startDate) {
  const safeDate = String(startDate ?? new Date().toISOString()).replace(/[:.]/g, "-");
  return path.join(String(outputDir), `premium-probe-${safeDate}`);
}

function tokenNumber(value) {
  if (value === null || value === undefined) return 0;
  return Number(formatUnits(BigInt(value), 18));
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits));
}

function median(values) {
  return quantile(values, 0.5);
}

function quantile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function formatOffset(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "n/a";
  const sign = Number(ms) < 0 ? "-" : "";
  return `${sign}T+${(Math.abs(Number(ms)) / 1000).toFixed(3)}s`;
}

function fmt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return String(value);
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
  const { chain, batch, startDate, testCfg, runtime, records, signerMode } = await buildPresignTestRecords(cfg, args);

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
    note: signerMode === "profile"
      ? "offline presign/cache test only; uses the loaded profile signer to validate Executor operator access and never broadcasts"
      : "offline presign/cache test only; uses a public test private key and does not broadcast",
    signerMode,
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
  const { chain, batch, startDate, testCfg, runtime, records, signerMode } = await buildPresignTestRecords(cfg, args);
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
  const forcedAt = Date.now();
  const forcedStarts = [];
  const pending = new Map();
  const seen = new Set();
  for (const record of records) {
    const actionCfg = actionConfigForRecord(record, dueCfg);
    const actionDelayMs = effectivePostOpenBroadcastDelayMs(actionCfg);
    const forcedStartDate = new Date(forcedAt - actionDelayMs - 10).toISOString();
    record.market = { ...record.market, startDate: forcedStartDate };
    forcedStarts.push({
      market: record.market.address,
      question: record.market.question,
      actionDelayMs,
      forcedStartDate
    });
    pending.set(eventSeenKey(record.market, dueCfg), record);
  }

  const drainStart = performance.now();
  await drainDuePendingMarkets(dueCfg, seen, pending, runtime);
  const drainMs = performance.now() - drainStart;

  console.log(JSON.stringify({
    level: "event-due-test",
    note: signerMode === "profile"
      ? "offline due-path test only; uses the loaded profile signer, forces each record just past its configured action time, and never broadcasts"
      : "offline due-path test only; uses a public test private key for pre-signing and dry-run execution, no broadcast",
    signerMode,
    chainLoad: {
      source: chain.discoverySource,
      head: chain.head,
      fromBlock: chain.fromBlock,
      restEventMarkets: chain.restEventMarkets
    },
    marketBatch: {
      originalStartDate: startDate,
      forcedStarts,
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
      usedCachedBundleBeforeDrain: Boolean(cachedBundle ?? signed)
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
    autoSellLadderProfitPercent: 100,
    autoSellOpenExitDelaySeconds: 36,
    autoSellOpenExitPercent: 100,
    autoSellTakeProfitSteps: 0,
    autoSellBeforeMarketStartSeconds: 0,
    autoSellMarketStartEndOffsetSeconds: 0,
    autoSellGasPriceGwei: "",
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

  passed.push(...await runMemeRangeSelectionSelfTest());

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

  const middlePlan = buildDirectBuyAllOutcomesPlan(mockEventMarket(), {
    ...testCfg,
    eventOutcomeSelection: "middle",
    eventOutcomeCount: 3,
    stakePerOutcomeUsdt: 6,
    maxMarketStakeUsdt: 18
  });
  assertSelfTest(
    middlePlan.selection?.rankSource === "token_order",
    `expected token_order middle selection, got ${middlePlan.selection?.rankSource}`
  );
  assertArrayEqual(
    middlePlan.outcomes.map((outcome) => String(outcome.tokenId)),
    ["2", "4", "8"],
    "middle outcome selection"
  );
  assertSelfTest(middlePlan.totalStakeUsdt === 18, `expected middle plan total 18U, got ${middlePlan.totalStakeUsdt}`);
  passed.push("middle selection buys the centered three outcomes at the configured stake");

  const firstPlan = buildDirectBuyAllOutcomesPlan(mockEventMarket(), {
    ...testCfg,
    eventOutcomeSelection: "first",
    eventOutcomeCount: 3,
    stakePerOutcomeUsdt: 10,
    maxMarketStakeUsdt: 30
  });
  assertSelfTest(
    firstPlan.selection?.rankSource === "token_order",
    `expected token_order first selection, got ${firstPlan.selection?.rankSource}`
  );
  assertArrayEqual(
    firstPlan.outcomes.map((outcome) => String(outcome.tokenId)),
    ["1", "2", "4"],
    "first outcome selection"
  );
  assertSelfTest(firstPlan.totalStakeUsdt === 30, `expected first plan total 30U, got ${firstPlan.totalStakeUsdt}`);
  passed.push("first selection buys the first configured outcomes by token order");

  const bot2MemeMarket = mockEventMarket({
    question: "$TEST FDV by July 20th?",
    categories: ["Crypto", "Meme"],
    memeRangeSelection: {
      locked: true,
      mode: "metric_adjacent",
      metric: "fdv",
      market: "0x0000000000000000000000000000000000000042",
      matchedOutcomeName: "D",
      selectedOutcomeNames: ["C", "D", "E"],
      evidence: { computedValue: 12_000_000 },
      source: { provider: "dexscreener" },
      lockedAt: "2026-07-11T00:00:00.000Z"
    }
  });
  const bot2MemeCfg = eventBuyConfigForMarket({
    ...testCfg,
    botName: "Bot2 Console",
    profileRole: "",
    memeRangeSelectionEnabled: true,
    memeRangeSelectionOutcomeCount: 5,
    eventOutcomeSelection: "first",
    eventOutcomeCount: 3,
    stakePerOutcomeUsdt: 10,
    maxMarketStakeUsdt: 50,
    maxBatchStakeUsdt: 50
  }, bot2MemeMarket);
  const bot2MemePlan = annotateBuyConfigPlan(buildDirectBuyAllOutcomesPlan(bot2MemeMarket, bot2MemeCfg), bot2MemeCfg);
  assertArrayEqual(bot2MemePlan.outcomes.map((outcome) => outcome.name), ["B", "C", "D", "E", "F"], "Bot2 locked Meme metric selection");
  assertSelfTest(bot2MemePlan.totalStakeUsdt === 50, `expected Bot2 Meme plan total 50U, got ${bot2MemePlan.totalStakeUsdt}`);
  assertSelfTest(bot2MemePlan.selection?.memeRangeSelection, "Bot2 Meme plan should retain lock evidence");
  passed.push("Bot2/Bot5 Meme buys consume locked metric-adjacent outcome names");

  const bot2MemeFallbackMarket = { ...bot2MemeMarket, memeRangeSelection: null };
  const bot2MemeFallbackCfg = eventBuyConfigForMarket({
    ...bot2MemeCfg,
    eventOutcomeSelection: "first"
  }, bot2MemeFallbackMarket);
  const bot2MemeFallbackPlan = annotateBuyConfigPlan(
    buildDirectBuyAllOutcomesPlan(bot2MemeFallbackMarket, bot2MemeFallbackCfg),
    bot2MemeFallbackCfg
  );
  assertArrayEqual(bot2MemeFallbackPlan.outcomes.map((outcome) => outcome.name), ["A", "B", "C", "D", "E"], "Bot2 Meme middle fallback");
  assertSelfTest(
    bot2MemeFallbackPlan.selection?.memeRangeSelectionMode === "middle_fallback",
    "Bot2 Meme fallback should be auditable"
  );
  passed.push("Bot2/Bot5 unsupported Meme events fall back to middle three outcomes");

  const memeLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-meme-lock-test-"));
  try {
    const memeLockFile = path.join(memeLockDir, "locks.jsonl");
    fs.writeFileSync(memeLockFile, `${JSON.stringify({
      level: "meme-range-selection-lock",
      market: bot2MemeMarket.address,
      selection: bot2MemeMarket.memeRangeSelection
    })}\n{\"partial\":`, "utf8");
    const sharedLockCfg = eventBuyConfigForMarket({
      ...bot2MemeCfg,
      memeRangeSelectionFile: memeLockFile
    }, bot2MemeFallbackMarket);
    const sharedLockPlan = annotateBuyConfigPlan(
      buildDirectBuyAllOutcomesPlan(bot2MemeFallbackMarket, sharedLockCfg),
      sharedLockCfg
    );
    assertArrayEqual(sharedLockPlan.outcomes.map((outcome) => outcome.name), ["B", "C", "D", "E", "F"], "shared Meme lock file selection");
    passed.push("Bot2/Bot5 read the same durable Meme lock and tolerate a partial trailing row");

    const memePriceMarket = {
      ...bot2MemeFallbackMarket,
      question: "$PUMP price range by July 20th?",
      categories: ["Crypto", "Meme"]
    };
    const memePriceLock = {
      ...bot2MemeMarket.memeRangeSelection,
      metric: "price",
      matchedOutcomeName: "D"
    };
    fs.writeFileSync(memeLockFile, `${JSON.stringify({
      level: "meme-range-selection-lock",
      market: memePriceMarket.address,
      selection: memePriceLock
    })}\n`, "utf8");
    const memePriceCfg = {
      ...bot2MemeCfg,
      memeRangeSelectionFile: memeLockFile,
      eventIntelBuyFilter: "strong",
      minEventDurationHours: 0,
      minMarketCreatedAt: null,
      marketCategoryBlocklist: ["Price"],
      marketTagBlocklist: ["Price"]
    };
    const memePriceDecision = marketFilterDecision(memePriceMarket, memePriceCfg);
    assertSelfTest(memePriceDecision.eligible, `locked Meme price range should be eligible: ${JSON.stringify(memePriceDecision)}`);
    const nonMemePriceDecision = marketFilterDecision({
      ...memePriceMarket,
      question: "$SOL price range by July 20th?",
      categories: ["Crypto"]
    }, memePriceCfg);
    assertSelfTest(
      !nonMemePriceDecision.eligible && nonMemePriceDecision.reason === "price-market",
      `non-Meme price range must remain blocked: ${JSON.stringify(nonMemePriceDecision)}`
    );
    passed.push("locked Meme price ranges bypass Price blocking without enabling non-Meme price markets");
  } finally {
    fs.rmSync(memeLockDir, { recursive: true, force: true });
  }

  const namedLargePlan = buildDirectBuyAllOutcomesPlan(mockEventMarket({
    address: "0x0000000000000000000000000000000000000942",
    outcomes: Array.from({ length: 16 }, (_, index) => ({
      tokenId: (1n << BigInt(index)).toString(),
      name: `Team ${index + 1}`
    }))
  }), {
    ...testCfg,
    eventOutcomeSelection: "names",
    eventOutcomeNames: "Team 4,Team 8,Team 12",
    stakePerOutcomeUsdt: 10,
    maxMarketStakeUsdt: 30
  });
  assertArrayEqual(
    namedLargePlan.outcomes.map((outcome) => outcome.name),
    ["Team 4", "Team 8", "Team 12"],
    "named explicit outcome selection"
  );
  assertSelfTest(namedLargePlan.totalStakeUsdt === 30, `expected named plan total 30U, got ${namedLargePlan.totalStakeUsdt}`);
  passed.push("named selection buys explicit outcomes and allows large candidate lists");

  const comparatorNamedPlan = buildDirectBuyAllOutcomesPlan(mockEventMarket({
    address: "0x0000000000000000000000000000000000000943",
    outcomes: [
      { tokenId: "1", name: ">900B" },
      { tokenId: "2", name: "≥ 1.05T" }
    ]
  }), {
    ...testCfg,
    eventOutcomeSelection: "names",
    eventOutcomeNames: "> 900B,>= 1.05T",
    stakePerOutcomeUsdt: 1,
    maxMarketStakeUsdt: 2
  });
  assertArrayEqual(
    comparatorNamedPlan.outcomes.map((outcome) => outcome.name),
    [">900B", "≥ 1.05T"],
    "named comparator outcome normalization"
  );
  passed.push("named selection normalizes comparator spacing and symbols");

  const fifaExactScoreMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000001042",
    question: "Ecuador vs Curacao",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match", "world_cup"],
    outcomes: mockFifaExactScoreOutcomes({
      homePrice: 0.22,
      awayPrice: 0.35,
      drawPrice: 0.9
    })
  });
  const fifaPreview = previewBot3FifaExactScoreMarket(fifaExactScoreMarket);
  assertSelfTest(!fifaPreview.skipReason, `FIFA exact-score preview should pass, got ${fifaPreview.skipReason}`);
  assertSelfTest(fifaPreview.selectedSide === "home_win", `expected home_win side, got ${fifaPreview.selectedSide}`);
  assertArrayEqual(
    fifaPreview.selectedOutcomeNames,
    ["ECU 1-0 CUW", "ECU 2-0 CUW", "ECU 3-0 CUW", "ECU 2-1 CUW", "ECU 3-1 CUW"],
    "Bot3 FIFA exact-score preview selected home win tier"
  );
  const fifaPreviewWithNonUniformAddedScores = previewBot3FifaExactScoreMarket({
    ...fifaExactScoreMarket,
    outcomes: mockFifaExactScoreOutcomes({
      homePrice: 0.22,
      awayPrice: 0.35,
      drawPrice: 0.9
    }).map((outcome) => {
      if (outcome.name === "ECU 3-0 CUW") return { ...outcome, price: 0.24 };
      if (outcome.name === "ECU 3-1 CUW") return { ...outcome, price: 0.25 };
      return outcome;
    })
  });
  assertSelfTest(
    !fifaPreviewWithNonUniformAddedScores.skipReason,
    `FIFA exact-score preview should not require added score prices to be uniform, got ${fifaPreviewWithNonUniformAddedScores.skipReason}`
  );
  assertArrayEqual(
    fifaPreviewWithNonUniformAddedScores.selectedOutcomeNames,
    ["ECU 1-0 CUW", "ECU 2-0 CUW", "ECU 3-0 CUW", "ECU 2-1 CUW", "ECU 3-1 CUW"],
    "Bot3 FIFA exact-score preview keeps five-score selection when added score prices differ"
  );
  const fifaAwayMarket = {
    ...fifaExactScoreMarket,
    address: "0x0000000000000000000000000000000000001043",
    outcomes: mockFifaExactScoreOutcomes({
      homePrice: 0.35,
      awayPrice: 0.22,
      drawPrice: 0.9
    })
  };
  assertArrayEqual(
    previewBot3FifaExactScoreMarket(fifaAwayMarket).selectedOutcomeNames,
    ["ECU 0-1 CUW", "ECU 0-2 CUW", "ECU 0-3 CUW", "ECU 1-2 CUW", "ECU 1-3 CUW"],
    "Bot3 FIFA exact-score preview selected away win tier"
  );
  const sideMarketPreview = previewBot3FifaExactScoreMarket({
    ...fifaExactScoreMarket,
    question: "Ecuador vs Curacao - Total Goals",
    tags: ["soccer_match_tg", "world_cup_prop"]
  });
  assertSelfTest(
    sideMarketPreview.skipReason === "not_fifa_sports_exact_score",
    `side market should skip, got ${sideMarketPreview.skipReason}`
  );
  const bot3AutoCfg = {
    ...testCfg,
    botName: "42space-3",
    watchFundingMode: "next_batch",
    bot3FifaExactScoreAutoBuyEnabled: true,
    bot3FifaExactScoreAutoStakeUsdt: 1,
    marketQuestionAllowlistRegex: /a^/iu,
    marketBuyQuestionAllowlistRegex: /a^/iu
  };
  const bot3AutoDecision = marketFilterDecision(fifaExactScoreMarket, bot3AutoCfg);
  assertSelfTest(
    bot3AutoDecision.eligible && bot3AutoDecision.reason === "bot3-fifa-exact-score-auto-buy",
    `Bot3 FIFA auto decision should bypass ordinary buy allowlists, got ${JSON.stringify(bot3AutoDecision)}`
  );
  const bot3AutoBuyCfg = eventBuyConfigForMarket(bot3AutoCfg, fifaExactScoreMarket);
  const bot3AutoPlan = annotateBuyConfigPlan(buildDirectBuyAllOutcomesPlan(fifaExactScoreMarket, bot3AutoBuyCfg), bot3AutoBuyCfg);
  assertArrayEqual(
    bot3AutoPlan.outcomes.map((outcome) => outcome.name),
    ["ECU 1-0 CUW", "ECU 2-0 CUW", "ECU 3-0 CUW", "ECU 2-1 CUW", "ECU 3-1 CUW"],
    "Bot3 FIFA auto plan selected names"
  );
  assertSelfTest(bot3AutoPlan.totalStakeUsdt === 5, `Bot3 FIFA auto plan should use 1U x 5, got ${bot3AutoPlan.totalStakeUsdt}`);
  assertSelfTest(bot3AutoPlan.selection?.bot3FifaExactScoreAutoBuy, "Bot3 FIFA auto plan should be annotated");
  const bot3AutoFunding = computeFundingRequirement(bot3AutoCfg, []);
  assertSelfTest(
    bot3AutoFunding.requiredBusdt === 5 && bot3AutoFunding.reason === "bot3_fifa_exact_score_auto_single_market_fallback",
    `Bot3 FIFA auto funding fallback should require 5U before the next batch is known, got ${JSON.stringify(bot3AutoFunding)}`
  );
  assertSelfTest(
    !marketFilterDecision(fifaExactScoreMarket, { ...bot3AutoCfg, botName: "42space-2" }).eligible,
    "Bot3 FIFA auto switch should not activate on Bot2"
  );
  const bot1ExactScoreAutoCfg = {
    ...bot3AutoCfg,
    botName: "Bot1 Console",
    profileRole: "bot3_like"
  };
  const bot1ExactScoreDecision = marketFilterDecision(fifaExactScoreMarket, bot1ExactScoreAutoCfg);
  assertSelfTest(
    bot1ExactScoreDecision.eligible && bot1ExactScoreDecision.reason === "bot3-fifa-exact-score-auto-buy",
    `Bot1 bot3_like should activate the exact-score selector, got ${JSON.stringify(bot1ExactScoreDecision)}`
  );
  assertArrayEqual(
    buildDirectBuyAllOutcomesPlan(
      fifaExactScoreMarket,
      eventBuyConfigForMarket(bot1ExactScoreAutoCfg, fifaExactScoreMarket)
    ).outcomes.map((outcome) => outcome.name),
    ["ECU 1-0 CUW", "ECU 2-0 CUW", "ECU 3-0 CUW", "ECU 2-1 CUW", "ECU 3-1 CUW"],
    "Bot1 bot3_like exact-score selection"
  );
  passed.push("Bot3 and bot3_like FIFA exact-score preview and 1U auto selection are profile-gated");

  const runtimeHealthDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-runtime-health-test-"));
  try {
    const runtimeHealthFile = path.join(runtimeHealthDir, "runtime-health.json");
    const runtimeHealthCfg = {
      ...bot1ExactScoreAutoCfg,
      runtimeHealthFile,
      dryRun: false,
      execute: true,
      autoSellEnabled: true,
      autoSellStrategy: "pre_start_exit"
    };
    const runtimeHealth = createRuntimeHealthState(runtimeHealthCfg);
    const healthRuntime = {
      health: runtimeHealth,
      pendingBuyRecords: new Map([["market", { preparedPlan: { market: "test" } }]]),
      txLock: { owner: null, since: null }
    };
    refreshRuntimeHealthSnapshot(healthRuntime, Date.parse("2026-07-11T00:00:00.000Z"));
    markAutoSellHealthStarted(healthRuntime, "2026-07-11T00:00:01.000Z");
    markAutoSellHealthCompleted(healthRuntime, { checked: 3, triggered: 1, executed: 1, errors: [] }, "2026-07-11T00:00:02.000Z");
    markAutoSellHealthCompleted(healthRuntime, {
      checked: 0,
      triggered: 0,
      executed: 0,
      errors: [],
      skippedReason: "open-buy-window",
      pause: { until: "2026-07-11T00:01:00.000Z" }
    }, "2026-07-11T00:00:03.000Z");
    saveRuntimeHealth(runtimeHealthFile, healthRuntime.health);
    const savedHealth = JSON.parse(fs.readFileSync(runtimeHealthFile, "utf8"));
    assertSelfTest(savedHealth.buy.policy === "fifa_exact_score_lowest_price_tier", "runtime health should expose exact-score buy policy");
    assertSelfTest(savedHealth.buy.pendingCount === 1 && savedHealth.buy.preparedCount === 1, "runtime health should expose pending/prepared counts");
    assertSelfTest(savedHealth.sell.checked === 3 && savedHealth.sell.executed === 1, "runtime health should expose auto-sell scan evidence");
    assertSelfTest(savedHealth.sell.state === "guarded" && savedHealth.sell.guardUntil, "runtime health should expose temporary buy protection without erasing scan evidence");
    passed.push("runtime health records automatic buy heartbeat and automatic sell scan evidence");
  } finally {
    fs.rmSync(runtimeHealthDir, { recursive: true, force: true });
  }

  const plannedBuyDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-planned-buy-test-"));
  try {
    const plannedMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001142",
      question: "Ecuador vs Curacao",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match", "world_cup"],
      startDate: new Date(Date.now() + 120000).toISOString(),
      outcomes: [
        { tokenId: "1", name: "ECU 0-0 CUW" },
        { tokenId: "2", name: "ECU 1-0 CUW" },
        { tokenId: "4", name: "ECU 2-0 CUW" },
        { tokenId: "8", name: "ECU 3-0 CUW" }
      ]
    });
    const holdMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001144",
      question: "Hold to settlement test",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match", "world_cup"],
      startDate: new Date(Date.now() + 120000).toISOString(),
      outcomes: [
        { tokenId: "1", name: "HOLD 1" }
      ]
    });
    const preStartMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001145",
      question: "Pre start exit test",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match", "world_cup"],
      startDate: new Date(Date.now() + 120000).toISOString(),
      endDate: new Date(Date.now() + 5 * 86400000 + 45 * 60000).toISOString(),
      outcomes: [
        { tokenId: "1", name: "PRE 0-1" }
      ]
    });
    const retainedMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001146",
      question: "Retained settlement test",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match", "world_cup"],
      startDate: new Date(Date.now() + 120000).toISOString(),
      endDate: new Date(Date.now() + 5 * 86400000 + 45 * 60000).toISOString(),
      outcomes: [
        { tokenId: "1", name: "RET 0-1" },
        { tokenId: "2", name: "RET 0-2" }
      ]
    });
    const regexPlannedMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001147",
      question: "BNB/USDT Futures Daily Volume, June 27th?",
      categories: ["Crypto"],
      tags: ["Normal"],
      startDate: new Date(Date.now() + 120000).toISOString(),
      outcomes: [
        { tokenId: "1", name: "< $150M" },
        { tokenId: "2", name: "$150M - $300M" },
        { tokenId: "4", name: "$300M - $450M" }
      ]
    });
    const pricePlannedMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001149",
      question: "Micron Technology (MU) price range, end of July 15th?",
      categories: ["Finance"],
      subcategories: ["Prices"],
      tags: ["Normal"],
      startDate: new Date(Date.now() + 120000).toISOString(),
      outcomes: [
        { tokenId: "1", name: "< $850" },
        { tokenId: "2", name: "$850 - $900" },
        { tokenId: "4", name: "$900 - $950" },
        { tokenId: "8", name: "$950 - $1000" },
        { tokenId: "16", name: "$1000 - $1050" }
      ]
    });
    const plannedOverridesAutoMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001151",
      question: "Ecuador vs Curacao",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match", "world_cup"],
      outcomes: mockFifaExactScoreOutcomes({
        homePrice: 0.22,
        awayPrice: 0.35,
        drawPrice: 0.9
      })
    });
    const plannedBuysFile = path.join(plannedBuyDir, "planned-buys.json");
    fs.writeFileSync(plannedBuysFile, JSON.stringify({
      plans: [
        {
          market: plannedMarket.address,
          outcomes: ["ECU 1-0 CUW", "ECU 2-0 CUW", "ECU 3-0 CUW"],
          stakePerOutcomeUsdt: 10,
          stakeByOutcomeUsdt: {
            "ECU 1-0 CUW": 20
          }
        },
        {
          market: holdMarket.address,
          enabled: false,
          preserveAutoSellAfterDisable: true,
          outcomes: ["HOLD 1"],
          stakePerOutcomeUsdt: 2,
          autoSell: {
            enabled: false,
            strategy: "hold_to_settlement",
            stopLossEnabled: false
          }
        },
        {
          market: preStartMarket.address,
          outcomes: ["PRE 0-1"],
          stakePerOutcomeUsdt: 10,
          openBroadcastDelayMs: 20000,
          gasPriceGwei: "0.15",
          broadcastRpcUrls: ["https://rpc-a.example", "https://rpc-b.example"],
          builderBundle: {
            enabled: true,
            mode: "builder_then_fanout",
            tipBnb: "0.005",
            tipGasPriceGwei: "1",
            maxBlocks: 4,
            maxTimestampOffsetSeconds: 12,
            fanoutDelayMs: 120,
            timingMode: "first_20s_block",
            prepositionLeadMs: 300,
            fallbackSafetyMs: 100,
            earlySubmitLeadMs: 900,
            minTimestampOffsetMs: 20000,
            positionFirst: true,
            timeoutMs: 750
          },
          autoSell: {
            strategy: "pre_start_exit",
            beforeMarketStartSeconds: 36000,
            stopLossEnabled: true,
            stopLossPercent: 10,
            stopLossSellPercent: 100
          }
        },
        {
          market: retainedMarket.address,
          outcomes: ["RET 0-1", "RET 0-2"],
          stakePerOutcomeUsdt: 10,
          autoSell: {
            strategy: "pre_start_exit",
            beforeMarketStartSeconds: 36000,
            stopLossEnabled: false,
            retainPositions: [
              { outcome: "RET 0-1", retainPercent: 10 }
            ]
          }
        },
        {
          questionRegex: "BNB\\/USDT\\s+Futures\\s+Daily\\s+Volume",
          outcomes: ["$150M - $300M", "$300M - $450M"],
          stakePerOutcomeUsdt: 5,
          gasPriceGwei: "0.15"
        },
        {
          market: pricePlannedMarket.address,
          outcomes: ["$900 - $950", "$950 - $1000", "$1000 - $1050"],
          stakePerOutcomeUsdt: 10
        },
        {
          market: plannedOverridesAutoMarket.address,
          outcomes: ["ECU 0-1 CUW", "ECU 0-2 CUW", "ECU 1-2 CUW"],
          stakePerOutcomeUsdt: 2
        }
      ]
    }));
    const plannedCfg = {
      ...testCfg,
      eventPlannedBuysFile: plannedBuysFile,
      eventOutcomeSelection: "middle",
      eventOutcomeCount: 3,
      stakePerOutcomeUsdt: 6,
      maxStakeUsdt: 6,
      maxMarketStakeUsdt: 18,
      maxBatchStakeUsdt: 18,
      eventMaxDueMarketsPerOpen: 1,
      openBroadcastDelayMs: 19000
    };
    const plannedBuyCfg = plannedBuyConfigForMarket(plannedCfg, plannedMarket);
    const plannedPlan = annotatePlannedBuyPlan(buildDirectBuyAllOutcomesPlan(plannedMarket, plannedBuyCfg), plannedBuyCfg);
    const plannedExecutionCfg = executionConfigForPlan(plannedCfg, plannedPlan);
    const bot2PlannedCfg = eventBuyConfigForMarket({
      ...plannedCfg,
      botName: "Bot2 Console",
      memeRangeSelectionEnabled: true
    }, {
      ...plannedMarket,
      categories: ["Crypto", "Meme"],
      memeRangeSelection: bot2MemeMarket.memeRangeSelection
    });
    const bot5PlannedCfg = eventBuyConfigForMarket({
      ...plannedCfg,
      botName: "42space-5",
      memeRangeSelectionEnabled: true
    }, {
      ...plannedMarket,
      categories: ["Crypto", "Meme"],
      memeRangeSelection: bot2MemeMarket.memeRangeSelection
    });
    assertArrayEqual(
      plannedPlan.outcomes.map((outcome) => outcome.name),
      ["ECU 1-0 CUW", "ECU 2-0 CUW", "ECU 3-0 CUW"],
      "planned buy outcome selection"
    );
    assertSelfTest(plannedPlan.selection?.plannedBuy, "planned buy plan should be marked");
    assertArrayEqual(
      plannedPlan.outcomes.map((outcome) => outcome.stakeUsdt),
      [20, 10, 10],
      "planned buy outcome-specific stakes"
    );
    assertSelfTest(plannedPlan.totalStakeUsdt === 40, `expected planned buy total 40U, got ${plannedPlan.totalStakeUsdt}`);
    assertSelfTest(selectedStakeUsdt(plannedMarket, plannedCfg) === 40, "planned funding should use outcome-specific total stake");
    assertSelfTest(plannedBuyCfg.maxStakeUsdt === 20, `expected planned config maxStakeUsdt 20U, got ${plannedBuyCfg.maxStakeUsdt}`);
    assertSelfTest(plannedExecutionCfg.maxStakeUsdt === 20, `expected planned execution maxStakeUsdt 20U, got ${plannedExecutionCfg.maxStakeUsdt}`);
    assertArrayEqual(
      gasAllocationsFromEventPlan(plannedPlan).map((allocation) => allocation.amountUsdt),
      [20, 10, 10],
      "planned buy gas allocation uses outcome-specific stakes"
    );
    assertSelfTest(
      bot2PlannedCfg.plannedBuy?.id && bot2PlannedCfg.eventOutcomeNames.includes("ECU 1-0 CUW"),
      "planned buy must override Bot2 Meme range selection"
    );
    assertSelfTest(
      bot5PlannedCfg.plannedBuy?.id && bot5PlannedCfg.eventOutcomeNames.includes("ECU 1-0 CUW"),
      "planned buy must override Bot5 Meme range selection"
    );
    const regexPlannedBuyCfg = plannedBuyConfigForMarket(plannedCfg, regexPlannedMarket);
    assertArrayEqual(
      buildDirectBuyAllOutcomesPlan(regexPlannedMarket, regexPlannedBuyCfg).outcomes.map((outcome) => outcome.name),
      ["$150M - $300M", "$300M - $450M"],
      "regex planned buy outcome selection"
    );
    const regexFunding = computeFundingRequirement(plannedCfg, [regexPlannedMarket]);
    assertSelfTest(
      regexFunding.nextBatchMarkets?.[0]?.gasPriceGwei === "0.15",
      `funding summary should inherit regex planned buy gasPriceGwei, got ${regexFunding.nextBatchMarkets?.[0]?.gasPriceGwei}`
    );
    const pricePlannedDecision = marketFilterDecision(pricePlannedMarket, plannedCfg);
    assertSelfTest(
      pricePlannedDecision.eligible && pricePlannedDecision.reason === "planned-buy",
      `planned buy should override Price strategy filter, got ${JSON.stringify(pricePlannedDecision)}`
    );
    const plannedAutoSellCfg = autoSellConfigForPosition(plannedCfg, {
      marketAddress: plannedMarket.address,
      question: { title: plannedMarket.question }
    });
    assertSelfTest(isAutoSellEnabledForPosition(plannedAutoSellCfg), "normal planned buy should keep global auto-sell enabled");
    const holdAutoSellCfg = autoSellConfigForPosition(plannedCfg, {
      marketAddress: holdMarket.address,
      question: { title: holdMarket.question }
    });
    assertSelfTest(
      holdAutoSellCfg.autoSellEnabled === false && holdAutoSellCfg.autoSellStrategy === "hold_to_settlement",
      `hold planned buy should normalize auto-sell disabled, got ${JSON.stringify(holdAutoSellCfg.plannedAutoSellOverride)}`
    );
    assertSelfTest(
      !plannedBuyForMarket(plannedCfg, holdMarket) && !isAutoSellEnabledForPosition(holdAutoSellCfg),
      "disabled executed plan should preserve hold-to-settlement without remaining buy-eligible"
    );
    const preStartBuyCfg = plannedBuyConfigForMarket(plannedCfg, preStartMarket);
    assertSelfTest(
      preStartBuyCfg.plannedBuy?.openBroadcastDelayMs === 20000,
      `planned buy should carry per-record openBroadcastDelayMs, got ${preStartBuyCfg.plannedBuy?.openBroadcastDelayMs}`
    );
    assertSelfTest(
      preStartBuyCfg.gasPriceGwei === "0.15" && preStartBuyCfg.plannedBuy?.gasPriceGwei === "0.15",
      `planned buy should carry per-record gasPriceGwei, got cfg=${preStartBuyCfg.gasPriceGwei} plan=${preStartBuyCfg.plannedBuy?.gasPriceGwei}`
    );
    assertSelfTest(
      executionConfigForPlan(plannedCfg, annotatePlannedBuyPlan(buildDirectBuyAllOutcomesPlan(preStartMarket, preStartBuyCfg), preStartBuyCfg)).gasPriceGwei === "0.15",
      "planned execution config should inherit per-record gasPriceGwei"
    );
    const plannedOverridesAutoCfg = {
      ...plannedCfg,
      botName: "42space-3",
      bot3FifaExactScoreAutoBuyEnabled: true,
      bot3FifaExactScoreAutoStakeUsdt: 1,
      maxBatchStakeUsdt: 30
    };
    const plannedOverridesAutoBuyCfg = eventBuyConfigForMarket(plannedOverridesAutoCfg, plannedOverridesAutoMarket);
    const plannedOverridesAutoPlan = annotateBuyConfigPlan(
      buildDirectBuyAllOutcomesPlan(plannedOverridesAutoMarket, plannedOverridesAutoBuyCfg),
      plannedOverridesAutoBuyCfg
    );
    assertArrayEqual(
      plannedOverridesAutoPlan.outcomes.map((outcome) => outcome.name),
      ["ECU 0-1 CUW", "ECU 0-2 CUW", "ECU 1-2 CUW"],
      "planned buy should override Bot3 FIFA auto selection"
    );
    assertSelfTest(plannedOverridesAutoPlan.selection?.plannedBuy, "planned override should remain marked as planned buy");
    assertSelfTest(
      !plannedOverridesAutoPlan.selection?.bot3FifaExactScoreAutoBuy,
      "planned override should not be marked as Bot3 FIFA auto buy"
    );
    assertSelfTest(
      preStartBuyCfg.broadcastRpcUrls?.length === 2 &&
      preStartBuyCfg.plannedBuy?.broadcastRpcUrls?.length === 2,
      `planned buy should carry per-record broadcastRpcUrls, got cfg=${preStartBuyCfg.broadcastRpcUrls?.length ?? 0} plan=${preStartBuyCfg.plannedBuy?.broadcastRpcUrls?.length ?? 0}`
    );
    assertSelfTest(
      preStartBuyCfg.builderBundleEnabled === true &&
        preStartBuyCfg.builderBundleMode === "builder_then_fanout" &&
        preStartBuyCfg.builderBundleTipBnb === "0.005" &&
        preStartBuyCfg.builderBundleMaxBlocks === 4 &&
        preStartBuyCfg.builderBundleFanoutDelayMs === 120 &&
        preStartBuyCfg.builderBundleTimingMode === "first_20s_block" &&
        preStartBuyCfg.builderBundleEarlySubmitLeadMs === 300 &&
        preStartBuyCfg.builderBundleMinTimestampOffsetMs === 0 &&
        preStartBuyCfg.builderBundleMaxTimestampOffsetMs === 20000 &&
        preStartBuyCfg.builderBundlePositionFirst === true &&
        preStartBuyCfg.plannedBuy?.builderBundle?.builderBundleTipBnb === "0.005",
      `planned buy should carry per-record builder bundle override, got ${JSON.stringify(preStartBuyCfg.plannedBuy?.builderBundle ?? null)}`
    );
    const preStartExecutionCfg = executionConfigForPlan(
      plannedCfg,
      annotatePlannedBuyPlan(buildDirectBuyAllOutcomesPlan(preStartMarket, preStartBuyCfg), preStartBuyCfg)
    );
    assertSelfTest(
      executionConfigForPlan(plannedCfg, annotatePlannedBuyPlan(buildDirectBuyAllOutcomesPlan(preStartMarket, preStartBuyCfg), preStartBuyCfg)).broadcastRpcUrls?.length === 2,
      "planned execution config should inherit per-record broadcastRpcUrls"
    );
    assertSelfTest(
      preStartExecutionCfg.builderBundleTipBnb === "0.005",
      "planned execution config should inherit per-record builder bundle tip"
    );
    assertSelfTest(
      preStartExecutionCfg.builderBundleMode === "builder_then_fanout",
      "planned execution config should inherit per-record builder bundle mode"
    );
    assertSelfTest(
      preStartExecutionCfg.builderBundleFanoutDelayMs === 120,
      "planned execution config should inherit per-record builder fanout delay"
    );
    assertSelfTest(
      preStartExecutionCfg.builderBundleEnabled === true &&
        preStartExecutionCfg.builderBundleEarlySubmitOffsetMs === 19700 &&
        preStartExecutionCfg.builderBundleTargetBoundaryLeadMs === 300 &&
        preStartExecutionCfg.builderBundlePublicFallbackLeadMs === 300 &&
        preStartExecutionCfg.builderBundleMaxTimestampOffsetMs === 20000,
      `planned targeted builder request should use a 300ms target-boundary lead, got ${JSON.stringify(preStartExecutionCfg.builderBundleTimingResolved)}`
    );
    const plannedGasReserve = calculateFundingGasReserve(plannedCfg, fundingForMarketSummaries(plannedCfg, [{
      ...preStartMarket,
      totalStakeUsdt: 10,
      outcomeCount: 1,
      gasPriceGwei: "0.15"
    }]));
    assertSelfTest(
      plannedGasReserve.gasPriceGwei === "0.15" &&
        plannedGasReserve.builderBundleTipBnb === "0.005" &&
        Number(plannedGasReserve.requiredBnb) > Number(plannedGasReserve.buyGasRequiredBnb),
      `planned funding reserve should use per-record gas and Builder costs, got ${JSON.stringify(plannedGasReserve)}`
    );
    const preStartAutoSellCfg = autoSellConfigForPosition(plannedCfg, {
      marketAddress: preStartMarket.address,
      question: { title: preStartMarket.question }
    });
    assertSelfTest(
      preStartAutoSellCfg.autoSellStrategy === "pre_start_exit" &&
        preStartAutoSellCfg.autoSellBeforeMarketStartSeconds === 36000 &&
        preStartAutoSellCfg.autoSellStopLossEnabled === true,
      `pre-start planned auto-sell override should keep stop-loss and pre-start exit, got ${JSON.stringify(preStartAutoSellCfg.plannedAutoSellOverride)}`
    );
    const retainedAutoSellCfg = autoSellConfigForPosition(plannedCfg, {
      marketAddress: retainedMarket.address,
      question: { title: retainedMarket.question },
      outcome: { name: "RET 0-1" }
    });
    assertSelfTest(
      retainedAutoSellCfg.autoSellStrategy === "pre_start_exit" &&
        retainedAutoSellCfg.autoSellBeforeMarketStartSeconds === 36000 &&
        retainedAutoSellCfg.autoSellStopLossEnabled === false &&
        retainedAutoSellCfg.autoSellRetainPosition?.retainPercent === 10,
      `retained planned auto-sell should resolve 10% retained outcome with stop-loss off, got ${JSON.stringify(retainedAutoSellCfg.autoSellRetainPosition)}`
    );
    const retainedSell = resolveAutoSellRetainedPosition(
      retainedAutoSellCfg,
      { initialSize: "1000", remainingSize: "1000" },
      { size: "1000", outcome: { name: "RET 0-1" } }
    );
    assertSelfTest(
      retainedSell?.shouldSell && retainedSell.sellAmountOt === "900" && retainedSell.retainedTargetOt === "100",
      `1000 chips with 10% retained should sell 900, got ${JSON.stringify(retainedSell)}`
    );
    const nonRetainedAutoSellCfg = autoSellConfigForPosition(plannedCfg, {
      marketAddress: retainedMarket.address,
      question: { title: retainedMarket.question },
      outcome: { name: "RET 0-2" }
    });
    assertSelfTest(
      !nonRetainedAutoSellCfg.autoSellRetainPosition,
      "non-retained outcome in same match should not inherit retained config"
    );
    const nonRetainedEntry = { remainingSize: "1000", initialSize: "1000", nextStep: 1 };
    markAutoSellActionApplied(nonRetainedAutoSellCfg, nonRetainedEntry, { trigger: "pre_start_exit" });
    assertSelfTest(
      nonRetainedEntry.completed && nonRetainedEntry.remainingSize === "0",
      `non-retained pre-start exit should still clear full position, got ${JSON.stringify(nonRetainedEntry)}`
    );
    const retainedNoSell = resolveAutoSellRetainedPosition(
      retainedAutoSellCfg,
      { initialSize: "1000", remainingSize: "80" },
      { size: "80", outcome: { name: "RET 0-1" } }
    );
    assertSelfTest(
      retainedNoSell && !retainedNoSell.shouldSell && retainedNoSell.remainingAfterSellOt === "80",
      `current chips below retained target should produce no-sell, got ${JSON.stringify(retainedNoSell)}`
    );
    const retainedNoSellEntry = { remainingSize: "80", initialSize: "1000", nextStep: 1 };
    markAutoSellActionApplied(retainedAutoSellCfg, retainedNoSellEntry, {
      trigger: "retained_to_settlement",
      noSell: true,
      ...retainedAutoSellFields(retainedNoSell)
    });
    assertSelfTest(
      retainedNoSellEntry.completed &&
        retainedNoSellEntry.retainedToSettlement &&
        retainedNoSellEntry.remainingSize === "80",
      `retained no-sell should mark held tail without zeroing size, got ${JSON.stringify(retainedNoSellEntry)}`
    );
    const retainedPartialEntry = { remainingSize: "1000", initialSize: "1000", nextStep: 1 };
    markAutoSellActionApplied(retainedAutoSellCfg, retainedPartialEntry, {
      trigger: "pre_start_retained_exit",
      sellAmountOt: "900",
      remainingAfterSellOt: "100",
      currentSizeOt: "1000",
      retainedTargetOt: "100",
      retainPercent: 10
    });
    assertSelfTest(
      retainedPartialEntry.completed &&
        retainedPartialEntry.retainedToSettlement &&
        retainedPartialEntry.remainingSize === "100",
      `retained partial pre-start sell should keep 100 chips in state, got ${JSON.stringify(retainedPartialEntry)}`
    );
    const invalidRetainedRows = [
      {
        question: "Invalid retained outcome",
        outcomes: ["A 1-0 B"],
        autoSell: { retainPositions: [{ outcome: "A 2-0 B", retainPercent: 10 }] }
      },
      {
        question: "Duplicate retained outcome",
        outcomes: ["A 1-0 B"],
        autoSell: {
          retainPositions: [
            { outcome: "A 1-0 B", retainPercent: 10 },
            { outcome: "A 1-0 B", retainPercent: 10 }
          ]
        }
      },
      {
        question: "Invalid retained percent",
        outcomes: ["A 1-0 B"],
        autoSell: { retainPositions: [{ outcome: "A 1-0 B", retainPercent: 0 }] }
      }
    ];
    for (const row of invalidRetainedRows) {
      let rejected = false;
      try {
        normalizePlannedBuy(row);
      } catch {
        rejected = true;
      }
      assertSelfTest(rejected, `invalid retained planned-buy row should be rejected: ${row.question}`);
    }
    const preStartRecord = await preparePendingRecord(plannedCfg, preStartMarket, { receiverAddress: PUBLIC_TEST_RECEIVER });
    const preStartMs = new Date(preStartMarket.startDate).getTime();
    assertSelfTest(
      preStartRecord.openBroadcastDelayMs === 20000 &&
        marketActionTimeMsForRecord(preStartRecord, plannedCfg) === preStartMs + 20000,
      "planned buy record should use per-record T+20s action time"
    );
    const normalPlannedRecord = await preparePendingRecord(plannedCfg, plannedMarket, { receiverAddress: PUBLIC_TEST_RECEIVER });
    const normalPlannedMs = new Date(plannedMarket.startDate).getTime();
    assertSelfTest(
      normalPlannedRecord.openBroadcastDelayMs === null &&
        marketActionTimeMsForRecord(normalPlannedRecord, plannedCfg) === normalPlannedMs + 19000,
      "planned buy record without per-record delay should inherit global T+19s action time"
    );
    assertSelfTest(
      marketActionTimeMs(preStartMarket, plannedCfg) === preStartMs + 19000,
      "global action time should remain T+19s for unplanned records"
    );
    const approvalCandidates = autoSellOperatorPreapprovalCandidates(plannedCfg, {
      openPositions: [
        {
          marketAddress: plannedMarket.address,
          tokenId: "2",
          size: "1",
          costBasis: "1",
          question: { title: plannedMarket.question }
        },
        {
          marketAddress: holdMarket.address,
          tokenId: "1",
          size: "1",
          costBasis: "1",
          question: { title: holdMarket.question }
        },
        {
          marketAddress: preStartMarket.address,
          tokenId: "1",
          size: "1",
          costBasis: "1",
          question: { title: preStartMarket.question }
        }
      ],
      eligibleMarkets: new Map([
        [plannedMarket.address.toLowerCase(), "2030-01-01T00:00:00.000Z"],
        [holdMarket.address.toLowerCase(), "2030-01-01T00:00:00.000Z"],
        [preStartMarket.address.toLowerCase(), "2030-01-01T00:00:00.000Z"]
      ])
    });
    assertArrayEqual(
      approvalCandidates.markets.map((market) => String(market).toLowerCase()),
      [plannedMarket.address.toLowerCase(), preStartMarket.address.toLowerCase()],
      "hold-to-settlement planned buy operator preapproval candidates"
    );
    assertSelfTest(approvalCandidates.disabled === 1, "hold-to-settlement planned buy should also skip operator preapproval");
    const livePlannedRecord = await preparePendingRecord({
      ...plannedCfg,
      dryRun: false,
      execute: true,
      riskAck: "YES",
      eligibilityAck: "YES",
      privateKey: PUBLIC_TEST_PRIVATE_KEY,
      walletAddress: PUBLIC_TEST_RECEIVER
    }, plannedMarket, { receiverAddress: PUBLIC_TEST_RECEIVER });
    assertSelfTest(
      livePlannedRecord.preparedPlan && !livePlannedRecord.prepareError,
      `planned buy should pass prepare-time execution validation, got ${livePlannedRecord.prepareError ?? "no plan"}`
    );
    const invalidManualRecord = await preparePendingRecord({
      ...plannedCfg,
      eventPlannedBuysFile: "",
      eventOutcomeSelection: "names",
      eventOutcomeNames: "ECU 1-0 CUW,ECU 2-0 CUW,ECU 3-0 CUW",
      stakePerOutcomeUsdt: 10,
      maxMarketStakeUsdt: 30,
      maxBatchStakeUsdt: 30,
      dryRun: false,
      execute: true,
      riskAck: "YES",
      eligibilityAck: "YES",
      privateKey: PUBLIC_TEST_PRIVATE_KEY,
      walletAddress: PUBLIC_TEST_RECEIVER
    }, plannedMarket, { receiverAddress: PUBLIC_TEST_RECEIVER });
    assertSelfTest(
      !invalidManualRecord.preparedPlan && invalidManualRecord.prepareError?.includes("MAX_STAKE_USDT"),
      `prepare-time validation should catch MAX_STAKE_USDT mismatch, got ${invalidManualRecord.prepareError ?? "no error"}`
    );
    const sameOpenPlanned = [
      { market: plannedMarket, preparedPlan: plannedPlan },
      { market: mockEventMarket({ address: "0x0000000000000000000000000000000000001143", startDate: plannedMarket.startDate }) }
    ];
    const allowedKeys = recordKeysWithinOpenLimit(plannedCfg, sameOpenPlanned);
    assertSelfTest(
      allowedKeys.has(eventSeenKey(plannedMarket, plannedCfg)),
      "planned buy should bypass single-market open limit"
    );
    const staleSeen = new Set([eventSeenKey(plannedMarket, plannedCfg)]);
    assertSelfTest(
      clearSeenForFuturePlannedBuy(plannedCfg, staleSeen, plannedMarket, "self-test"),
      "future planned buy should override a prior seen record"
    );
    assertSelfTest(
      !staleSeen.has(eventSeenKey(plannedMarket, plannedCfg)),
      "future planned buy should remove the stale seen key"
    );
    const globalFutureMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000001150",
      question: "$TEST FDV by end of self test?",
      status: "not_started",
      categories: ["Crypto", "Meme"]
    });
    const globalBuyCfg = {
      ...plannedCfg,
      eventPlannedBuysFile: "",
      eventIntelBuyFilter: "strong",
      minEventDurationHours: 0
    };
    const globalSeen = new Set([eventSeenKey(globalFutureMarket, globalBuyCfg)]);
    const globalDecision = marketFilterDecision(globalFutureMarket, globalBuyCfg);
    assertSelfTest(
      clearSeenForFutureEligibleBuy(globalBuyCfg, globalSeen, globalFutureMarket, "self-test"),
      `future eligible global buy should override a prior seen record, decision=${JSON.stringify(globalDecision)}`
    );
    assertSelfTest(
      !globalSeen.has(eventSeenKey(globalFutureMarket, globalBuyCfg)),
      "future eligible global buy should remove the stale seen key"
    );
    const openedBeforeActionMarket = {
      ...plannedMarket,
      startDate: new Date(Date.now() - 5000).toISOString()
    };
    const openedBeforeActionSeen = new Set([eventSeenKey(openedBeforeActionMarket, plannedCfg)]);
    assertSelfTest(
      !clearSeenForFuturePlannedBuy(plannedCfg, openedBeforeActionSeen, openedBeforeActionMarket, "self-test"),
      "planned buy should not override seen after market start even before configured action time"
    );
    const duePlannedMarket = {
      ...plannedMarket,
      startDate: new Date(Date.now() - 60000).toISOString()
    };
    const dueSeen = new Set([eventSeenKey(duePlannedMarket, plannedCfg)]);
    assertSelfTest(
      !clearSeenForFuturePlannedBuy(plannedCfg, dueSeen, duePlannedMarket, "self-test"),
      "planned buy should not override seen after the action time"
    );
    passed.push("planned buy file overrides global middle selection per market");
  } finally {
    fs.rmSync(plannedBuyDir, { recursive: true, force: true });
  }

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
  assertSelfTest(
    autoSellPresignPauseHoldMs({
      ...testCfg,
      autoSellStrategy: "open_timed_exit",
      preSignWindowMs: 60000,
      openBroadcastDelayMs: 19000,
      autoSellPollMs: 1000
    }) === 80000,
    "open timed exit should resume auto-sell before the configured sell point"
  );
  assertSelfTest(
    shouldStartAutoSellBeforeFunding({ armWaitForFunding: true, autoSellEnabled: true }),
    "auto-sell should start before funding wait when both switches are enabled"
  );
  assertSelfTest(
    !shouldStartAutoSellBeforeFunding({ armWaitForFunding: true, autoSellEnabled: false }),
    "auto-sell should not start before funding wait when auto-sell is disabled"
  );
  const waitRuntime = { txLock: { owner: "auto-sell-batch", since: new Date().toISOString() } };
  setTimeout(() => {
    waitRuntime.txLock.owner = null;
    waitRuntime.txLock.since = null;
  }, 10);
  await waitForRuntimeTransactionIdle(waitRuntime, "self-test", { timeoutMs: 1000, pollMs: 5 });
  assertSelfTest(!runtimeTransactionBusy(waitRuntime), "runtime transaction idle wait did not observe lock release");
  passed.push("transaction lock and auto-sell pause protect hot buy window");

  const fastExitLaneCfg = {
    ...testCfg,
    autoSellEnabled: true,
    autoSellStrategy: "open_timed_exit",
    autoSellFastOpenExitEnabled: true,
    openBroadcastDelayMs: 19850
  };
  assertSelfTest(fastOpenExitNonceLaneEnabled(fastExitLaneCfg), "fast open exit nonce lane should be enabled");
  const reservedBuyRuntime = {
    pendingBuyRecords: new Map([["next", { preSignedFastTransaction: { nonce: 44 } }]])
  };
  assertSelfTest(runtimeHasPreSignedBuy(reservedBuyRuntime), "reserved future buy nonce should be detected");
  const currentFastExitMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000001191",
    question: "Current fast exit market"
  });
  const earlierBuyTargetMs = Date.now() + 2000;
  const earlierBuyMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000001192",
    question: "Earlier pending buy",
    startDate: new Date(earlierBuyTargetMs - fastExitLaneCfg.openBroadcastDelayMs).toISOString()
  });
  const pendingBuyRuntime = {
    pendingBuyRecords: new Map([
      ["current", { market: currentFastExitMarket }],
      ["next", { market: earlierBuyMarket }]
    ])
  };
  const pendingBeforeExit = pendingBuyBeforeFastOpenExit(
    fastExitLaneCfg,
    pendingBuyRuntime,
    currentFastExitMarket,
    Date.now() + 5000
  );
  assertSelfTest(
    pendingBeforeExit?.market === earlierBuyMarket.address,
    `earlier pending buy should suppress conflicting fast exit, got ${JSON.stringify(pendingBeforeExit)}`
  );
  const fastExitGateRuntime = { fastOpenExitPreSignGate: { key: "market:tx" } };
  releaseFastOpenExitPreSignGate(fastExitGateRuntime, "other:tx");
  assertSelfTest(fastExitGateRuntime.fastOpenExitPreSignGate, "unrelated fast exit gate should remain active");
  releaseFastOpenExitPreSignGate(fastExitGateRuntime, "market:tx");
  assertSelfTest(!fastExitGateRuntime.fastOpenExitPreSignGate, "matching fast exit gate should release");
  let postBuyApprovalError = "";
  try {
    await ensureFastOpenExitOperatorApproval(fastExitLaneCfg, {}, currentFastExitMarket.address, [
      { operatorApproved: false }
    ]);
  } catch (error) {
    postBuyApprovalError = errorMessage(error);
  }
  assertSelfTest(
    postBuyApprovalError.includes("refusing a nonce-consuming approval after buy"),
    `fast exit must not spend a reserved nonce on post-buy approval, got ${postBuyApprovalError || "no error"}`
  );
  passed.push("fast open exit preapproval and serial nonce lane protect later buys");

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
  const profitPercent = autoSellProfitPercent(6, 12);
  assertSelfTest(profitPercent === 100, `expected 100% profit, got ${profitPercent}`);
  const halfPositionMetrics = autoSellReturnMetrics(
    { costBasis: "9.9799", size: "3888.27" },
    { initialSize: "7776.54", initialCostBasisUsdt: "9.9799" },
    8.3686
  );
  assertSelfTest(
    halfPositionMetrics.lossPercent === 0 && halfPositionMetrics.profitPercent > 60,
    `half-position return should be positive, got ${JSON.stringify(halfPositionMetrics)}`
  );
  const losingHalfPositionMetrics = autoSellReturnMetrics(
    { costBasis: "9.9799", size: "3888.27" },
    { initialSize: "7776.54", initialCostBasisUsdt: "9.9799" },
    4.2
  );
  assertSelfTest(
    losingHalfPositionMetrics.lossPercent > 10,
    `true half-position loss should still trigger stop-loss, got ${JSON.stringify(losingHalfPositionMetrics)}`
  );
  const staleRestHalfPositionMetrics = autoSellReturnMetrics(
    { costBasis: "9.9799", size: "7776.54" },
    { initialSize: "7776.54", initialCostBasisUsdt: "9.9799", remainingSize: "3888.27" },
    8.3686
  );
  assertSelfTest(
    staleRestHalfPositionMetrics.lossPercent === 0 && staleRestHalfPositionMetrics.profitPercent > 60,
    `tracked remaining size should override stale REST size, got ${JSON.stringify(staleRestHalfPositionMetrics)}`
  );
  const trackedEntry = { initialSize: "100", initialCostBasisUsdt: "10", nextStep: 1 };
  markAutoSellActionApplied(
    { ...testCfg, autoSellChunkPercent: 50, autoSellTakeProfitSteps: 1, autoSellBeforeMarketStartSeconds: 36000 },
    trackedEntry,
    { trigger: "ladder_step", sellAmountOt: "50" }
  );
  assertSelfTest(
    trackedEntry.remainingSize === "50" && trackedEntry.takeProfitCompleted,
    `ladder sell should track remaining size, got ${JSON.stringify(trackedEntry)}`
  );
  assertSelfTest(
    !isAutoSellLadderProfitReady(testCfg, 99.9),
    "auto-sell ladder should wait below the 100% profit gate"
  );
  assertSelfTest(
    isAutoSellLadderProfitReady(testCfg, 100),
    "auto-sell ladder should start at the 100% profit gate"
  );
  assertSelfTest(
    isAutoSellLadderProfitReady({ ...testCfg, autoSellLadderProfitPercent: 0 }, null),
    "auto-sell ladder should preserve old behavior when the profit gate is off"
  );
  const quoteGuardPosition = {
    marketAddress: "0x0000000000000000000000000000000000000a51",
    tokenId: "1",
    costBasis: "1",
    size: "1",
    question: { title: "Quote guard market" },
    market: { startDate: new Date(Date.now() + 24 * 3600000).toISOString() }
  };
  const quoteGuardEntry = {
    nextStep: 1,
    initialSize: "1",
    initialCostBasisUsdt: "1",
    buyAt: new Date().toISOString(),
    completed: false,
    stopLossSold: false
  };
  const operatorHintRuntime = {
    autoSellOperatorReadyMarkets: new Set([quoteGuardPosition.marketAddress.toLowerCase()])
  };
  assertSelfTest(
    autoSellOperatorApprovalHint(operatorHintRuntime, quoteGuardPosition.marketAddress) === true &&
      autoSellOperatorApprovalHint(operatorHintRuntime, "0x0000000000000000000000000000000000000a52") === undefined,
    "auto-sell should reuse only positively confirmed operator approvals"
  );
  let cachedApprovalBalanceReads = 0;
  let cachedApprovalOperatorReads = 0;
  let cachedApprovalSimulations = 0;
  const cachedApprovalClient = {
    readContract: async ({ functionName }) => {
      if (functionName === "balanceOf") {
        cachedApprovalBalanceReads += 1;
        return parseUnits("1", 18);
      }
      if (functionName === "isOperator") {
        cachedApprovalOperatorReads += 1;
        throw new Error("confirmed operator approval should not be re-read");
      }
      throw new Error(`unexpected cached approval readContract ${functionName}`);
    },
    simulateContract: async () => {
      cachedApprovalSimulations += 1;
      return { result: parseUnits("0.9", 18) };
    }
  };
  const cachedApprovalQuote = await quoteAutoSellReturnState(
    testCfg,
    cachedApprovalClient,
    PUBLIC_TEST_RECEIVER,
    quoteGuardPosition,
    quoteGuardEntry,
    true
  );
  assertSelfTest(
    cachedApprovalQuote.quote?.operatorApproved === true &&
      cachedApprovalBalanceReads === 1 &&
      cachedApprovalOperatorReads === 0 &&
      cachedApprovalSimulations === 1,
    `confirmed operator approval should keep balance/simulation and skip only isOperator, got ${JSON.stringify({
      balanceReads: cachedApprovalBalanceReads,
      operatorReads: cachedApprovalOperatorReads,
      simulations: cachedApprovalSimulations
    })}`
  );
  passed.push("auto-sell reuses confirmed operator approval without reducing quote cadence");
  let quoteGuardCalls = 0;
  const quoteGuardClient = {
    readContract: async () => {
      quoteGuardCalls += 1;
      throw new Error("quote guard should not be called");
    },
    simulateContract: async () => {
      quoteGuardCalls += 1;
      throw new Error("quote guard should not be called");
    }
  };
  const preStartQuoteGuardAction = await buildPreStartExitAutoSellAction({
    ...testCfg,
    autoSellStrategy: "pre_start_exit",
    autoSellBeforeMarketStartSeconds: 300,
    autoSellStopLossEnabled: false
  }, quoteGuardClient, PUBLIC_TEST_RECEIVER, quoteGuardPosition, quoteGuardEntry, Date.now());
  assertSelfTest(
    preStartQuoteGuardAction === null && quoteGuardCalls === 0,
    `pre-start exit should not quote before due when stop-loss is off, calls=${quoteGuardCalls}`
  );
  const ladderQuoteGuardAction = await buildLadderAutoSellAction({
    ...testCfg,
    autoSellStrategy: "ladder",
    autoSellStartDelaySeconds: 3600,
    autoSellLadderProfitPercent: 0,
    autoSellStopLossEnabled: false
  }, quoteGuardClient, PUBLIC_TEST_RECEIVER, quoteGuardPosition, quoteGuardEntry, Date.now());
  assertSelfTest(
    ladderQuoteGuardAction === null && quoteGuardCalls === 0,
    `ladder should not quote before due when stop-loss is off and no profit gate is configured, calls=${quoteGuardCalls}`
  );
  const ladderProfitGateEntry = {
    ...quoteGuardEntry,
    buyAt: new Date(Date.now() - 60000).toISOString()
  };
  const ladderProfitGateAction = await buildLadderAutoSellAction({
    ...testCfg,
    autoSellStrategy: "ladder",
    autoSellStartDelaySeconds: 0,
    autoSellLadderProfitPercent: 100,
    autoSellStopLossEnabled: false
  }, quoteGuardClient, PUBLIC_TEST_RECEIVER, quoteGuardPosition, ladderProfitGateEntry, Date.now());
  assertSelfTest(
    ladderProfitGateAction === null && quoteGuardCalls > 0,
    "ladder should still quote at due time when a profit gate is configured"
  );
  const beforeOpenTimedNoProfitGateCalls = quoteGuardCalls;
  const openTimedNoProfitGateAction = await buildOpenTimedExitAutoSellAction({
    ...testCfg,
    autoSellStrategy: "open_timed_exit",
    autoSellOpenExitDelaySeconds: 39600,
    autoSellLadderProfitPercent: 0,
    autoSellStopLossEnabled: false
  }, quoteGuardClient, PUBLIC_TEST_RECEIVER, quoteGuardPosition, ladderProfitGateEntry, Date.now());
  assertSelfTest(
    openTimedNoProfitGateAction === null && quoteGuardCalls === beforeOpenTimedNoProfitGateCalls,
    `open timed exit should not quote before due without a profit gate, calls=${quoteGuardCalls}`
  );
  const beforeOpenTimedProfitGateCalls = quoteGuardCalls;
  const openTimedProfitGateAction = await buildOpenTimedExitAutoSellAction({
    ...testCfg,
    autoSellStrategy: "open_timed_exit",
    autoSellStartDelaySeconds: 0,
    autoSellOpenExitDelaySeconds: 39600,
    autoSellChunkPercent: 100,
    autoSellTakeProfitSteps: 1,
    autoSellLadderProfitPercent: 70,
    autoSellStopLossEnabled: false
  }, quoteGuardClient, PUBLIC_TEST_RECEIVER, quoteGuardPosition, ladderProfitGateEntry, Date.now());
  assertSelfTest(
    openTimedProfitGateAction === null && quoteGuardCalls > beforeOpenTimedProfitGateCalls,
    "open timed exit should quote before the timed exit when a profit gate is configured"
  );
  const profitableOpenTimedClient = {
    readContract: async ({ functionName }) => {
      if (functionName === "balanceOf") return parseUnits("100", 18);
      if (functionName === "isOperator") return true;
      throw new Error(`unexpected readContract ${functionName}`);
    },
    simulateContract: async () => ({ result: parseUnits("20", 18) })
  };
  const profitableOpenTimedAction = await buildOpenTimedExitAutoSellAction({
    ...testCfg,
    autoSellStrategy: "open_timed_exit",
    autoSellStartDelaySeconds: 0,
    autoSellOpenExitDelaySeconds: 39600,
    autoSellChunkPercent: 100,
    autoSellTakeProfitSteps: 1,
    autoSellLadderProfitPercent: 70,
    autoSellStopLossEnabled: false
  }, profitableOpenTimedClient, PUBLIC_TEST_RECEIVER, {
    ...quoteGuardPosition,
    costBasis: "10",
    size: "100"
  }, {
    ...ladderProfitGateEntry,
    initialSize: "100",
    remainingSize: "100",
    initialCostBasisUsdt: "10"
  }, Date.now());
  assertSelfTest(
    profitableOpenTimedAction?.trigger === "ladder_step" &&
      profitableOpenTimedAction.percent === 100 &&
      profitableOpenTimedAction.profitPercent >= 70,
    `open timed exit should sell 100% at the profit gate before timed exit, got ${JSON.stringify({
      trigger: profitableOpenTimedAction?.trigger,
      percent: profitableOpenTimedAction?.percent,
      profitPercent: profitableOpenTimedAction?.profitPercent
    })}`
  );
  let priceTargetReadCalls = 0;
  let priceTargetSimulateCalls = 0;
  const priceTargetClient = {
    readContract: async ({ functionName }) => {
      priceTargetReadCalls += 1;
      if (functionName === "balanceOf") return parseUnits("100", 18);
      if (functionName === "isOperator") return true;
      throw new Error(`unexpected price target readContract ${functionName}`);
    },
    simulateContract: async () => {
      priceTargetSimulateCalls += 1;
      throw new Error("price target must not request a full-exit quote");
    }
  };
  const priceTargetCfg = {
    ...testCfg,
    autoSellStrategy: "open_timed_exit",
    autoSellOpenExitDelaySeconds: 39600,
    autoSellLadderProfitPercent: 70,
    autoSellStopLossEnabled: false,
    autoSellPriceTargets: [{ outcome: "DeepSeek V4 Flash", price: 0.0017, enabled: true }],
    autoSellPriceSellPercent: 100
  };
  const priceTargetPosition = {
    ...quoteGuardPosition,
    outcome: { name: "DeepSeek V4 Flash" },
    curPrice: "0.001699",
    costBasis: "10",
    size: "100"
  };
  const belowPriceTargetAction = await buildOpenTimedExitAutoSellAction(
    priceTargetCfg,
    priceTargetClient,
    PUBLIC_TEST_RECEIVER,
    priceTargetPosition,
    ladderProfitGateEntry,
    Date.now()
  );
  assertSelfTest(
    belowPriceTargetAction === null && priceTargetReadCalls === 0 && priceTargetSimulateCalls === 0,
    "REST price target should not use chain RPC below the configured price"
  );
  const reachedPriceTargetAction = await buildOpenTimedExitAutoSellAction(
    priceTargetCfg,
    priceTargetClient,
    PUBLIC_TEST_RECEIVER,
    { ...priceTargetPosition, curPrice: "0.0017" },
    ladderProfitGateEntry,
    Date.now()
  );
  assertSelfTest(
    reachedPriceTargetAction?.trigger === "price_target" &&
      reachedPriceTargetAction.currentPrice === 0.0017 &&
      reachedPriceTargetAction.targetPrice === 0.0017 &&
      reachedPriceTargetAction.percent === 100 &&
      priceTargetReadCalls === 2 &&
      priceTargetSimulateCalls === 0,
    `REST price target should sell directly without a quote, got ${JSON.stringify({
      trigger: reachedPriceTargetAction?.trigger,
      currentPrice: reachedPriceTargetAction?.currentPrice,
      targetPrice: reachedPriceTargetAction?.targetPrice,
      percent: reachedPriceTargetAction?.percent,
      readCalls: priceTargetReadCalls,
      simulateCalls: priceTargetSimulateCalls
    })}`
  );
  const priceTargetAppliedEntry = { initialSize: "100", remainingSize: "100", nextStep: 1, completed: false };
  markAutoSellActionApplied(priceTargetCfg, priceTargetAppliedEntry, reachedPriceTargetAction);
  assertSelfTest(
    priceTargetAppliedEntry.completed && priceTargetAppliedEntry.priceTargetSold && priceTargetAppliedEntry.remainingSize === "0",
    `price target should complete the outcome, got ${JSON.stringify(priceTargetAppliedEntry)}`
  );
  const futureOnlyTarget = autoSellPriceTargetForPosition({
    ...priceTargetCfg,
    autoSellPriceApplyAfterIso: new Date(Date.now() + 1000).toISOString()
  }, { ...priceTargetPosition, curPrice: "0.002" }, ladderProfitGateEntry);
  assertSelfTest(futureOnlyTarget === null, "price target cutover should exclude older positions");
  passed.push("auto-sell uses REST price targets without full-exit quote RPC and keeps profit quotes strategy-gated");

  const pricePollDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-price-poll-test-"));
  try {
    const plannedBuysFile = path.join(pricePollDir, "planned-buys.json");
    const fillsFile = path.join(pricePollDir, "fills.jsonl");
    const buyAt = Date.now() - 5000;
    const marketAddress = "0x0000000000000000000000000000000000000b44";
    fs.writeFileSync(plannedBuysFile, JSON.stringify({ plans: [{
      id: "price-poll",
      market: marketAddress,
      outcomes: ["DeepSeek V4 Flash"],
      stakePerOutcomeUsdt: 10,
      autoSell: {
        priceTargets: [{ outcome: "DeepSeek V4 Flash", price: 0.0017 }],
        priceHotPollMs: 1000,
        priceHotWindowSeconds: 600
      }
    }] }));
    fs.writeFileSync(fillsFile, `${JSON.stringify({
      at: new Date(buyAt).toISOString(),
      plan: { market: { address: marketAddress, question: "Price poll" } },
      result: { dryRun: false, status: "broadcast" }
    })}\n`);
    const pricePollCfg = {
      ...testCfg,
      eventPlannedBuysFile: plannedBuysFile,
      fillsFile,
      autoSellApplyAfterIso: null,
      autoSellEligibleTailBytes: 1024 * 1024,
      autoSellPollMs: 60000
    };
    assertSelfTest(autoSellMonitorSchedulerMs(pricePollCfg) === 1000, "price target monitor scheduler should wake every second");
    assertSelfTest(autoSellMonitorDesiredPollMs(pricePollCfg, buyAt + 5000) === 1000, "price target hot window should poll every second");
    assertSelfTest(autoSellMonitorDesiredPollMs(pricePollCfg, buyAt + 601000) === 60000, "price target monitor should restore normal polling after ten minutes");
  } finally {
    fs.rmSync(pricePollDir, { recursive: true, force: true });
  }
  passed.push("price target monitor polls at 1s for ten minutes then restores the profile interval");
  const oneStepEntry = {
    nextStep: 1,
    initialSize: "100",
    buyAt: new Date(Date.now() - 60000).toISOString(),
    completed: false
  };
  markAutoSellActionApplied({
    ...testCfg,
    autoSellChunkPercent: 50,
    autoSellTakeProfitSteps: 1,
    autoSellBeforeMarketStartSeconds: 300
  }, oneStepEntry, {
    trigger: "ladder_step"
  });
  assertSelfTest(
    oneStepEntry.takeProfitCompleted && !oneStepEntry.completed,
    "one-step take-profit should leave remaining position for pre-start exit"
  );
  const gasBudget = await ensureAutoSellGasBudget(
    { ...testCfg, dryRun: false, execute: true, autoSellGasPriceGwei: "0.15", autoSellMinBnbReserve: 0 },
    {
      getBalance: async () => parseUnits("1", 18),
      getGasPrice: async () => parseGwei("9")
    },
    PUBLIC_TEST_RECEIVER,
    1_000_000
  );
  assertSelfTest(gasBudget.gasPriceGwei === "0.15", `auto-sell gas should use sell-only gas price, got ${gasBudget.gasPriceGwei}`);
  const kickoffPlanDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-kickoff-plan-test-"));
  try {
    const kickoffFile = path.join(kickoffPlanDir, "planned-buys.json");
    const kickoffMarket = "0x00000000000000000000000000000000000000aa";
    const holdFastExitMarket = "0x00000000000000000000000000000000000000bb";
    fs.writeFileSync(kickoffFile, JSON.stringify({
      plans: [
        {
          market: kickoffMarket,
          outcomes: ["A"],
          stakePerOutcomeUsdt: 1,
          kickoffAt: "2030-01-02T03:04:05Z"
        },
        {
          market: holdFastExitMarket,
          outcomes: ["A"],
          stakePerOutcomeUsdt: 1,
          autoSell: {
            enabled: false,
            strategy: "hold_to_settlement"
          }
        }
      ]
    }));
    const kickoffCfg = {
      ...testCfg,
      eventPlannedBuysFile: kickoffFile,
      autoSellBeforeMarketStartSeconds: 300,
      autoSellMarketStartEndOffsetSeconds: 2700
    };
    const kickoffPosition = {
      marketAddress: kickoffMarket,
      tokenId: "1",
      costBasis: "1",
      size: "1",
      market: {
        startDate: "2030-01-01T00:00:00Z",
        endDate: "2030-01-09T09:09:09Z"
      }
    };
    assertSelfTest(
      autoSellMarketStartDate(kickoffCfg, kickoffPosition) === "2030-01-02T03:04:05.000Z",
      "planned-buy kickoffAt should override market start/end fallback"
    );
    assertSelfTest(
      autoSellPreStartDueAt(kickoffCfg, kickoffPosition) === Date.parse("2030-01-02T02:59:05Z"),
      "pre-start exit should be scheduled 5 minutes before planned kickoffAt"
    );
    const autoExactScorePosition = {
      marketAddress: "0x00000000000000000000000000000000000000cc",
      tokenId: "1",
      costBasis: "1",
      size: "1",
      outcome: { name: "FRA 1-0 MAR" },
      market: {
        question: "France vs Morocco",
        startDate: "2030-01-02T03:00:00Z",
        endDate: "2030-01-09T09:09:09Z"
      }
    };
    const autoExactScoreCfg = {
      ...testCfg,
      autoSellBeforeMarketStartSeconds: 300,
      autoSellMarketStartEndOffsetSeconds: 0
    };
    assertSelfTest(
      autoSellMarketStartDate(autoExactScoreCfg, autoExactScorePosition) === "2030-01-09T09:09:09.000Z",
      "auto exact-score positions should use match endDate as the pre-start anchor when no planned kickoffAt exists"
    );
    assertSelfTest(
      autoSellPreStartDueAt(autoExactScoreCfg, autoExactScorePosition) === Date.parse("2030-01-09T09:04:09Z"),
      "auto exact-score pre-start exit should be scheduled before match endDate, not market open startDate"
    );
    assertSelfTest(
      autoSellMarketStartDate({ ...autoExactScoreCfg, autoSellMarketStartEndOffsetSeconds: 2700 }, autoExactScorePosition) === "2030-01-09T08:24:09.000Z",
      "auto exact-score endDate fallback should still respect AUTO_SELL_MARKET_START_END_OFFSET_SECONDS"
    );
    const totalGoalsPosition = {
      ...autoExactScorePosition,
      marketAddress: "0x00000000000000000000000000000000000000cd",
      outcome: { name: "0-1 goals" },
      market: {
        ...autoExactScorePosition.market,
        question: "France vs Morocco - Total Goals"
      }
    };
    assertSelfTest(
      autoSellMarketStartDate(autoExactScoreCfg, totalGoalsPosition) === "2030-01-02T03:00:00Z",
      "sports side markets should not use the exact-score endDate fallback"
    );
    assertSelfTest(
      autoSellOpenExitDueAt({
        ...testCfg,
        autoSellOpenExitDelaySeconds: 36
      }, kickoffPosition) === Date.parse("2030-01-01T00:00:36Z"),
      "open timed exit should use market open startDate, not planned kickoffAt"
    );
    const openExitEntry = {
      nextStep: 1,
      initialSize: "100",
      buyAt: "2030-01-01T00:00:19Z",
      completed: false
    };
    markAutoSellActionApplied(testCfg, openExitEntry, {
      trigger: "open_timed_exit"
    });
    assertSelfTest(
      openExitEntry.completed && openExitEntry.openTimedExitSold,
      "open timed exit should complete the position after one sell"
    );
    const fastExitCfg = {
      ...testCfg,
      dryRun: false,
      execute: true,
      autoSellStrategy: "open_timed_exit",
      autoSellFastOpenExitEnabled: true,
      autoSellFastOpenExitMinDelayMs: 24500,
      autoSellFastOpenExitMaxDelayMs: 26000
    };
    const randomDelay = fastOpenExitRandomDelayMs(fastExitCfg, (min, max) => {
      assertSelfTest(min === 24500 && max === 26001, `fast exit random bounds wrong: ${min}-${max}`);
      return 25555;
    });
    assertSelfTest(randomDelay === 25555, `fast open exit random delay mismatch: ${randomDelay}`);
    const fastSchedule = fastOpenExitSchedule(fastExitCfg, kickoffPosition.market, "0xabc");
    assertSelfTest(
      fastSchedule.targetMs >= Date.parse(kickoffPosition.market.startDate) + 24500 &&
        fastSchedule.targetMs <= Date.parse(kickoffPosition.market.startDate) + 26000,
      `fast open exit schedule outside range: ${JSON.stringify(fastSchedule)}`
    );
    const fastRuntime = { txLock: { owner: null, since: null } };
    const holdFastExitMarketDetails = {
      ...kickoffPosition.market,
      address: holdFastExitMarket,
      question: "Hold fast open exit test"
    };
    const holdFastExitBuyCfg = plannedBuyConfigForMarket(kickoffCfg, holdFastExitMarketDetails);
    assertSelfTest(
      shouldScheduleFastOpenExitAfterBuy(
        fastExitCfg,
        { txHash: "0xabc", outcomes: [{ tokenId: "1", name: "A" }] },
        { type: "single", marketDetails: [kickoffPosition.market] },
        fastRuntime,
        { status: "success" }
      ),
      "fast open exit should schedule after a successful single-buy receipt"
    );
    assertSelfTest(
      !shouldScheduleFastOpenExitAfterBuy(
        { ...fastExitCfg, autoSellFastOpenExitEnabled: false },
        { txHash: "0xabc", outcomes: [{ tokenId: "1", name: "A" }] },
        { type: "single", marketDetails: [kickoffPosition.market] },
        fastRuntime,
        { status: "success" }
      ),
      "fast open exit should stay disabled unless explicitly enabled"
    );
    assertSelfTest(
      !shouldScheduleFastOpenExitAfterBuy(
        fastExitCfg,
        { txHash: "0xabc", outcomes: [{ tokenId: "1", name: "A" }] },
        { type: "single", plannedBuy: holdFastExitBuyCfg.plannedBuy, marketDetails: [holdFastExitMarketDetails] },
        fastRuntime,
        { status: "success" }
      ),
      "fast open exit should respect planned-buy hold_to_settlement context"
    );
    assertSelfTest(
      !shouldScheduleFastOpenExitAfterBuy(
        { ...fastExitCfg, eventPlannedBuysFile: kickoffFile },
        { txHash: "0xabc", outcomes: [{ tokenId: "1", name: "A" }] },
        { type: "single", marketDetails: [holdFastExitMarketDetails] },
        fastRuntime,
        { status: "success" }
      ),
      "fast open exit should respect planned-buy hold_to_settlement file fallback"
    );
    const fastOpenExitEntry = {
      nextStep: 1,
      initialSize: "100",
      buyAt: "2030-01-01T00:00:19Z",
      completed: false
    };
    markAutoSellActionApplied(testCfg, fastOpenExitEntry, {
      trigger: "fast_open_timed_exit",
      sellAmountOt: "100"
    });
    assertSelfTest(
      fastOpenExitEntry.completed && fastOpenExitEntry.openTimedExitSold,
      "fast open timed exit should complete the position after one sell"
    );
    const sellBroadcastCfg = rpcOnlyAutoSellBroadcastConfig({
      ...fastExitCfg,
      builderBundleEnabled: true,
      builderBundleRequestedEnabled: true,
      builderBundleKillSwitch: false,
      builderTimedBuyExecutorEnabled: true,
      builderTimestampGuardEnabled: true
    });
    assertSelfTest(
      !sellBroadcastCfg.builderBundleEnabled &&
        !sellBroadcastCfg.builderBundleRequestedEnabled &&
        sellBroadcastCfg.builderBundleKillSwitch &&
        !sellBroadcastCfg.builderTimedBuyExecutorEnabled &&
        !sellBroadcastCfg.builderTimestampGuardEnabled,
      "fast auto-sell broadcasts must not inherit the buy-only Builder path"
    );
    const failedFastExitRuntime = {
      autoSellPausedUntil: Date.now() + 45000,
      autoSellPauseReason: "fast-open-exit-scheduled"
    };
    releaseFastOpenExitAutoSellPause(failedFastExitRuntime);
    assertSelfTest(
      !runtimeAutoSellPauseInfo(failedFastExitRuntime),
      "failed fast open exit should immediately release its monitor pause"
    );
  } finally {
    fs.rmSync(kickoffPlanDir, { recursive: true, force: true });
  }
  passed.push("auto-sell waits for the 100% ladder profit gate, supports open timed exit, fast randomized open exit, one-step take-profit, sell-only gas, planned kickoffAt, and keeps 10% stop-loss");

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
  assertSelfTest(
    isTransientPositionsFetchErrorMessage("42 positions 503: <html><h1>Service Temporarily Unavailable</h1></html>"),
    "42 positions 5xx should be treated as transient"
  );
  assertSelfTest(
    isTransientPositionsFetchErrorMessage("42 positions invalid JSON: Unexpected token '<'"),
    "42 positions invalid JSON should be treated as transient"
  );
  assertSelfTest(
    !isTransientPositionsFetchErrorMessage("Failed to load auto-sell position state data/auto-sell-positions.json"),
    "local auto-sell state errors must remain fatal"
  );
  passed.push("auto-sell positions API outages are retryable without monitor-exception alerts");

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
  const blockAwareCfg = {
    ...testCfg,
    allowPreopenBroadcast: false,
    openBroadcastMode: "block_aware_20s",
    openBroadcastDelayMs: 19900,
    openBroadcastBlockTargetOffsetMs: 20000,
    openBroadcastBlockAwareLeadMs: 95,
    openBroadcastBlockAwareMaxWaitMs: 250,
    openBroadcastBlockAwarePreTargetCount: 2,
    openBroadcastBlockAwarePreTargetSendMs: 120,
    openBroadcastBlockAwareHeadMaxAgeMs: 2000
  };
  const blockAwareRecord = { market: { startDate: fixedStart } };
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, null, fixedStartMs + 19800) === fixedStartMs + 19900,
    "block-aware timing should not send before the configured arm delay"
  );
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, null, fixedStartMs + 19900) === fixedStartMs + 19905,
    "block-aware timing should fall back to the nominal target when no block heads are useful"
  );
  const targetHeadRuntime = { openBroadcastBlockClock: createOpenBroadcastBlockClockState() };
  rememberOpenBroadcastBlockHead(
    targetHeadRuntime.openBroadcastBlockClock,
    { number: 100n, timestamp: BigInt((fixedStartMs + 20000) / 1000) },
    fixedStartMs + 20080
  );
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, targetHeadRuntime, fixedStartMs + 20080) === fixedStartMs + 20080,
    "block-aware timing should release immediately after observing the target timestamp head"
  );
  const preTargetRuntime = { openBroadcastBlockClock: createOpenBroadcastBlockClockState() };
  for (const [index, receivedAt] of [fixedStartMs + 19600, fixedStartMs + 19750, fixedStartMs + 19890].entries()) {
    rememberOpenBroadcastBlockHead(
      preTargetRuntime.openBroadcastBlockClock,
      { number: BigInt(200 + index), timestamp: BigInt((fixedStartMs + 19000) / 1000) },
      receivedAt
    );
  }
  const onePreTargetRuntime = { openBroadcastBlockClock: createOpenBroadcastBlockClockState() };
  rememberOpenBroadcastBlockHead(
    onePreTargetRuntime.openBroadcastBlockClock,
    { number: 199n, timestamp: BigInt((fixedStartMs + 19000) / 1000) },
    fixedStartMs + 19890
  );
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, onePreTargetRuntime, fixedStartMs + 19900) === fixedStartMs + 19905,
    "block-aware timing should require enough repeated pre-target heads before arm-time release"
  );
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, preTargetRuntime, fixedStartMs + 19880) === fixedStartMs + 19900,
    "block-aware timing should not release before the configured arm delay even with repeated pre-target heads"
  );
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, preTargetRuntime, fixedStartMs + 19900) === fixedStartMs + 19900,
    "block-aware timing should allow arm-time release when repeated pre-target timestamp heads are seen"
  );
  assertSelfTest(
    marketActionTimeMsForRecord(blockAwareRecord, blockAwareCfg, preTargetRuntime, fixedStartMs + 19905) === fixedStartMs + 19905,
    "block-aware timing should release when repeated fresh pre-target timestamp heads are seen near the boundary"
  );
  assertSelfTest(
    marketActionTimeMsForRecord(
      { market: { startDate: fixedStart }, openBroadcastDelayMs: 25000 },
      blockAwareCfg,
      preTargetRuntime,
      fixedStartMs + 19905
    ) === fixedStartMs + 25000,
    "block-aware timing should not pull a record-level late delay back to the 20s boundary"
  );
  const oldDueBlockAwareGroups = groupRecordsByActionTime([
    { market: { startDate: "2030-01-01T00:00:00.000Z" } },
    { market: { startDate: "2030-01-01T00:01:00.000Z" } }
  ], blockAwareCfg, preTargetRuntime);
  assertSelfTest(
    oldDueBlockAwareGroups.size === 2,
    "block-aware grouping should use stable action keys instead of merging records by the current due instant"
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
  passed.push("pre-open broadcast is opt-in and block-aware post-open timing is bounded");

  const cheapGateQuote = summarizeEventPriceGateQuote(
    { tokenId: "1", name: "cheap" },
    {
      collateralFromUser: parseUnits("1", 18),
      otToUser: parseUnits("1000", 18),
      stakeUsdt: 1
    }
  );
  const expensiveGateQuote = summarizeEventPriceGateQuote(
    { tokenId: "2", name: "expensive" },
    {
      collateralFromUser: parseUnits("1.3", 18),
      otToUser: parseUnits("1000", 18),
      stakeUsdt: 1.3
    }
  );
  const gateCfg = { ...testCfg, eventPriceGateMaxEffectivePrice: 0.0012, eventPriceGateRequire: "any" };
  assertSelfTest(isPriceGateQuotePassing(gateCfg, cheapGateQuote), "price gate should pass a cheap quote");
  assertSelfTest(!isPriceGateQuotePassing(gateCfg, expensiveGateQuote), "price gate should reject an expensive quote");
  assertSelfTest(
    priceGatePasses(gateCfg, [expensiveGateQuote, cheapGateQuote]),
    "any-mode price gate should pass when one selected outcome is below the threshold"
  );
  assertSelfTest(
    !priceGatePasses({ ...gateCfg, eventPriceGateRequire: "all" }, [expensiveGateQuote, cheapGateQuote]),
    "all-mode price gate should reject if any selected outcome is above the threshold"
  );
  const oneOpenStart = "2030-01-01T00:00:00.000Z";
  const limitedOpenRecords = [
    { market: mockEventMarket({ address: "0x0000000000000000000000000000000000000101", startDate: oneOpenStart }) },
    { market: mockEventMarket({ address: "0x0000000000000000000000000000000000000102", startDate: oneOpenStart }) },
    { market: mockEventMarket({ address: "0x0000000000000000000000000000000000000103", startDate: oneOpenStart }) }
  ];
  const limitedOpen = splitRecordsByOpenLimit({ ...testCfg, eventMaxDueMarketsPerOpen: 1 }, limitedOpenRecords);
  assertSelfTest(
    limitedOpen.selected.length === 1 && limitedOpen.skipped.length === 2,
    `single-market open limit should keep one market and skip two, got ${limitedOpen.selected.length}/${limitedOpen.skipped.length}`
  );
  passed.push("price gate uses effective simulateMint cost and supports single-market any-outcome mode");

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
  const builderGasReserve = calculateFastGasReserve(
    {
      ...testCfg,
      fastGasLimit: 8000000,
      gasPriceGwei: "1",
      builderBundleEnabled: true,
      builderBundleTipBnb: "0.005",
      builderBundleTipGasPriceGwei: "1"
    },
    { nextBatchOutcomeCount: 1 }
  );
  assertSelfTest(
    builderGasReserve.builderBundleTipBnb === "0.005" &&
      Number(builderGasReserve.requiredBnb) > Number(builderGasReserve.buyGasRequiredBnb),
    `builder gas reserve should include BNB tip and tip transfer gas, got ${JSON.stringify(builderGasReserve)}`
  );
  const target19Timing = resolveBuilderBundleTimingPreset({
    ...testCfg,
    builderBundleEnabled: true,
    builderBundleTimingMode: "auto",
    builderBundleTimeoutMs: 800,
    builderBundlePrepositionLeadMs: 300,
    builderBundleFallbackSafetyMs: 100,
    openBroadcastDelayMs: 18840
  });
  assertSelfTest(
    target19Timing.eligible &&
      target19Timing.targetSecond === 19 &&
      target19Timing.earlySubmitOffsetMs === 18700 &&
      target19Timing.targetBoundaryLeadMs === 300 &&
      target19Timing.publicFallbackLeadMs === 140 &&
      target19Timing.effectiveTimeoutMs === 800,
    `T+19 targeted builder timing should submit at T+18.700 without shortening the request timeout, got ${JSON.stringify(target19Timing)}`
  );
  const target20Cfg = applyBuilderBundleTimingPreset({
    ...testCfg,
    builderBundleEnabled: true,
    builderBundleTimingMode: "auto",
    builderBundleMode: "builder_only",
    builderBundleTimeoutMs: 700,
    builderBundlePrepositionLeadMs: 300,
    builderBundleFallbackSafetyMs: 100,
    openBroadcastDelayMs: 19900
  });
  assertSelfTest(
    target20Cfg.builderBundleEnabled &&
      target20Cfg.builderBundleTargetSecond === 20 &&
      target20Cfg.builderBundleEarlySubmitOffsetMs === 19700 &&
      target20Cfg.builderBundleTargetBoundaryLeadMs === 300 &&
      target20Cfg.builderBundlePublicFallbackLeadMs === 200 &&
      target20Cfg.builderBundleMinTimestampOffsetMs === 0 &&
      target20Cfg.builderBundleMaxTimestampOffsetMs === 20000 &&
      target20Cfg.builderBundleMode === "builder_only" &&
      target20Cfg.builderBundlePositionFirst,
    `T+20 targeted builder-only timing should remain builder-only, got ${JSON.stringify(target20Cfg.builderBundleTimingResolved)}`
  );
  const offTargetCfg = applyBuilderBundleTimingPreset({
    ...target20Cfg,
    builderBundleEnabled: true,
    builderBundleTimingMode: "auto",
    openBroadcastDelayMs: 22000
  });
  assertSelfTest(
    !offTargetCfg.builderBundleEnabled && offTargetCfg.builderBundleRequestedEnabled,
    `non-19/20 fallback should stay RPC-only, got ${JSON.stringify(offTargetCfg.builderBundleTimingResolved)}`
  );
  const strictLaneStart = "2030-01-01T00:00:00.000Z";
  const strictLane = splitRecordsByStrictBuilderLane({
    ...testCfg,
    builderBundleEnabled: true,
    builderBundleTimingMode: "auto",
    builderBundleTimeoutMs: 700,
    builderBundlePrepositionLeadMs: 300,
    builderBundleFallbackSafetyMs: 100,
    openBroadcastDelayMs: 18840
  }, [
    { market: mockEventMarket({ address: "0x0000000000000000000000000000000000001191", startDate: strictLaneStart }) },
    { market: mockEventMarket({ address: "0x0000000000000000000000000000000000001192", startDate: strictLaneStart }) }
  ]);
  assertSelfTest(
    strictLane.selected.length === 1 && strictLane.skipped.length === 1,
    `targeted builder wallet lane should admit one market per target second, got ${JSON.stringify({ selected: strictLane.selected.length, skipped: strictLane.skipped.length })}`
  );
  const builderDryRun = await buildBuilderBundleDryRun(
    {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTipBnb: "0.005",
      builderBundleTipGasPriceGwei: "1",
      builderBundleMaxTimestampOffsetSeconds: 12,
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848"
    },
    {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMaxTimestamp: 12
    },
    { maxBlockNumber: 123, nowMs: 0 }
  );
  assertSelfTest(
    builderDryRun.ready &&
      builderDryRun.txCount === 2 &&
      builderDryRun.tipNonce === 43 &&
      builderDryRun.tipBnb === "0.005" &&
      builderDryRun.minTimestamp === null &&
      builderDryRun.maxTimestamp === 12,
    `legacy builder dry-run should use documented maxTimestamp only, got ${JSON.stringify(builderDryRun)}`
  );
  const dualBuilderDryRun = await buildBuilderBundleDryRun(
    {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      blockrazorBuilderEnabled: true,
      blockrazorBuilderUrl: "https://rpc.blockrazor.builders",
      blockrazorBuilderTipTo: "0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20",
      blockrazorBuilderAuthToken: "test-token"
    },
    {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMaxTimestamp: 12
    },
    { maxBlockNumber: null, nowMs: 0 }
  );
  assertSelfTest(
    dualBuilderDryRun.ready &&
      dualBuilderDryRun.targetCount === 2 &&
      dualBuilderDryRun.targets.every((target) => target.txCount === 2 && target.tipNonce === 43) &&
      new Set(dualBuilderDryRun.targets.map((target) => target.tipTo.toLowerCase())).size === 2,
    `dual Builder dry-run should sign one same-nonce tip per Builder address, got ${JSON.stringify(dualBuilderDryRun)}`
  );
  const originalDualBuilderFetch = globalThis.fetch;
  const dualBuilderRequests = [];
  let dualBuilderSubmission = null;
  try {
    globalThis.fetch = async (input, init = {}) => {
      dualBuilderRequests.push({
        url: String(input),
        headers: init.headers ?? {},
        body: JSON.parse(String(init.body ?? "{}"))
      });
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: `0x${"ab".repeat(32)}`
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    dualBuilderSubmission = await submitPreSignedBuilderBundle({
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderBundleNoMerge: true,
      builderBundlePositionFirst: true,
      builderBundle48spSign: "test-sign",
      blockrazorBuilderEnabled: true,
      blockrazorBuilderUrl: "https://rpc.blockrazor.builders",
      blockrazorBuilderTipTo: "0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20",
      blockrazorBuilderAuthToken: "test-token"
    }, {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMinTimestamp: 12,
      builderBundleMaxTimestamp: 12
    });
  } finally {
    globalThis.fetch = originalDualBuilderFetch;
  }
  const blockrazorRequest = dualBuilderRequests.find((request) => request.url.includes("blockrazor"));
  const clubRequest = dualBuilderRequests.find((request) => request.url.includes("48.club"));
  assertSelfTest(
    dualBuilderSubmission?.submitted &&
      dualBuilderSubmission.submittedTargetCount === 2 &&
      dualBuilderRequests.length === 2 &&
      blockrazorRequest?.headers?.Authorization === "test-token" &&
      !Object.hasOwn(blockrazorRequest?.body?.params?.[0] ?? {}, "48spSign") &&
      !Object.hasOwn(blockrazorRequest?.body?.params?.[0] ?? {}, "minTimestamp") &&
      blockrazorRequest?.body?.params?.[0]?.maxTimestamp === 12 &&
      blockrazorRequest?.body?.params?.[0]?.positionFirst === true &&
      blockrazorRequest?.body?.params?.[0]?.noMerge === true &&
      clubRequest?.body?.params?.[0]?.["48spSign"] === "test-sign" &&
      clubRequest?.body?.params?.[0]?.minTimestamp === 12 &&
      clubRequest?.body?.params?.[0]?.maxTimestamp === 12 &&
      clubRequest?.body?.params?.[0]?.positionFirst === true &&
      clubRequest?.body?.params?.[0]?.noMerge === true,
    `dual Builder submission should preserve shared ordering fields while keeping 48spSign provider-specific, got ${JSON.stringify({ dualBuilderSubmission, dualBuilderRequests })}`
  );
  const originalBuilderSingleflightFetch = globalThis.fetch;
  let builderSingleflightRequests = 0;
  let builderSingleflightResults = [];
  try {
    globalThis.fetch = async (_input, init = {}) => {
      builderSingleflightRequests += 1;
      const payload = JSON.parse(String(init.body ?? "{}"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: `0x${"cd".repeat(32)}`
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const sharedSigned = {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000"
    };
    const sharedCfg = {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleMode: "builder_only",
      builderBundleTimingMode: "legacy",
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      blockrazorBuilderEnabled: false
    };
    builderSingleflightResults = await Promise.all([
      broadcastPreSignedFastTransaction(sharedCfg, sharedSigned),
      broadcastPreSignedFastTransaction(sharedCfg, sharedSigned)
    ]);
  } finally {
    globalThis.fetch = originalBuilderSingleflightFetch;
  }
  assertSelfTest(
    builderSingleflightRequests === 1 &&
      builderSingleflightResults.every((result) => (
        result?.mode === "presigned_builder_bundle_only" &&
        result?.publicBroadcastSkipped === true
      )),
    `concurrent strict Builder callers should share one in-flight submission, got ${JSON.stringify({ builderSingleflightRequests, builderSingleflightResults })}`
  );
  const timedExecutorAddress = "0x1111111111111111111111111111111111111111";
  const timedRouterData = "0x12345678";
  const timedExecutorData = encodeTimedBuyExecutorCall(20, parseUnits("30", 18), timedRouterData);
  const timedDecoded = decodeFunctionData({ abi: TIMED_BUY_EXECUTOR_ABI, data: timedExecutorData });
  const timedBuilderDryRun = await buildBuilderBundleDryRun(
    {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTimingMode: "first_20s_block",
      builderBundlePrepositionLeadMs: 300,
      openBroadcastDelayMs: 19900,
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderTimedBuyExecutorEnabled: true,
      builderTimedBuyExecutorAddress: timedExecutorAddress
    },
    {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMinTimestamp: 20,
      builderBundleMaxTimestamp: 20,
      builderBundleTargetSecond: 20,
      timedBuyExecutorEnabled: true,
      timedBuyExecutorAddress: timedExecutorAddress,
      timedBuyExecutorTargetTimestamp: 20
    },
    { maxBlockNumber: null, nowMs: 0 }
  );
  assertSelfTest(
    timedDecoded.functionName === "executeAfter" &&
      timedDecoded.args[0] === 20n &&
      timedDecoded.args[1] === parseUnits("30", 18) &&
      timedDecoded.args[2] === timedRouterData &&
      timedBuilderDryRun.ready &&
      timedBuilderDryRun.txCount === 2 &&
      timedBuilderDryRun.minTimestamp === 20 &&
      timedBuilderDryRun.maxTimestamp === 20 &&
      timedBuilderDryRun.timedBuyExecutorEnabled,
    `timed Builder dry-run should encode atomic executeAfter + tip at one target timestamp, got ${JSON.stringify(timedBuilderDryRun)}`
  );
  const exactTimedBuilderDryRun = await buildBuilderBundleDryRun(
    {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTimingMode: "first_20s_block",
      builderBundlePrepositionLeadMs: 700,
      openBroadcastDelayMs: 19900,
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      blockrazorBuilderEnabled: true,
      blockrazorBuilderUrl: "https://rpc.blockrazor.builders",
      blockrazorBuilderTipTo: "0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20",
      builderTimedBuyExecutorEnabled: true,
      builderTimedBuyExecutorExactSecond: true,
      builderTimedBuyExecutorAddress: timedExecutorAddress
    },
    {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMinTimestamp: 20,
      builderBundleMaxTimestamp: 21,
      builderBundleTargetSecond: 20,
      timedBuyExecutorEnabled: true,
      timedBuyExecutorExactSecond: true,
      timedBuyExecutorAddress: timedExecutorAddress,
      timedBuyExecutorTargetTimestamp: 20
    },
    { maxBlockNumber: null, nowMs: 0 }
  );
  assertSelfTest(
    exactTimedBuilderDryRun.ready &&
      exactTimedBuilderDryRun.targetCount === 2 &&
      exactTimedBuilderDryRun.targets.every((target) => (
        target.minTimestamp === 20 && target.maxTimestamp === 21
      )) &&
      exactTimedBuilderDryRun.timedBuyExecutorExactSecond,
    `exact-second Builder dry-run should expose a non-zero provider window while the executor pins T+20, got ${JSON.stringify(exactTimedBuilderDryRun)}`
  );
  const strictBuilderDryRun = await buildBuilderBundleDryRun(
    {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTimingMode: "first_20s_block",
      builderBundleMode: "builder_then_fanout",
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderBundleTimeoutMs: 700,
      builderBundlePrepositionLeadMs: 300,
      builderBundleFallbackSafetyMs: 100,
      openBroadcastDelayMs: 19900
    },
    {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMaxTimestamp: 20,
      builderBundleTargetSecond: 20,
      builderBundleTargetBoundaryAtMs: 20000,
      builderBundleTargetBoundaryLeadMs: 300,
      builderBundlePublicFallbackLeadMs: 200,
      builderBundleEarlySubmitAtMs: 19700
    },
    { maxBlockNumber: null, nowMs: 0 }
  );
  assertSelfTest(
    strictBuilderDryRun.ready &&
      strictBuilderDryRun.minTimestamp === null &&
      strictBuilderDryRun.maxTimestamp === 20 &&
      strictBuilderDryRun.targetSecond === 20 &&
      strictBuilderDryRun.positionFirst,
    `targeted builder dry-run should use maxTimestamp-only expiry at T+20, got ${JSON.stringify(strictBuilderDryRun)}`
  );
  const guardedBuilderDryRun = await buildBuilderBundleDryRun(
    {
      ...testCfg,
      builderBundleEnabled: true,
      builderBundleTimingMode: "first_20s_block",
      builderBundleMode: "builder_then_fanout",
      builderBundleTipBnb: "0.001",
      builderBundleTipGasPriceGwei: "1",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderBundleTimeoutMs: 700,
      builderBundlePrepositionLeadMs: 500,
      builderTimestampGuardEnabled: true,
      builderTimestampGuardAddress: "0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557",
      openBroadcastDelayMs: 19900
    },
    {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 43,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMinTimestamp: 20,
      builderBundleMaxTimestamp: 20,
      builderBundleTargetSecond: 20,
      preSignedTimestampGuardTransaction: {
        txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        serializedTransaction: "0x5678",
        nonce: 42,
        to: "0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557",
        targetTimestamp: 20
      }
    },
    { maxBlockNumber: null, nowMs: 0 }
  );
  assertSelfTest(
    guardedBuilderDryRun.ready &&
      guardedBuilderDryRun.txCount === 3 &&
      guardedBuilderDryRun.minTimestamp === 20 &&
      guardedBuilderDryRun.maxTimestamp === 20 &&
      guardedBuilderDryRun.timestampGuardEnabled &&
      guardedBuilderDryRun.timestampGuardNonce === 42 &&
      guardedBuilderDryRun.buyNonce === 43 &&
      guardedBuilderDryRun.tipNonce === 44,
    `guarded Builder dry-run should enforce guard -> buy -> tip nonces at one target timestamp, got ${JSON.stringify(guardedBuilderDryRun)}`
  );
  const originalFetch = globalThis.fetch;
  let publicFanoutCalls = 0;
  let inFlightBroadcast;
  let guardedPreSubmittedBroadcast;
  let strictBuilderOnlyBroadcast;
  try {
    globalThis.fetch = async (_input, init = {}) => {
      const payload = JSON.parse(String(init.body ?? "{}"));
      if (payload.method !== "eth_sendRawTransaction") {
        throw new Error(`unexpected self-test RPC method ${payload.method}`);
      }
      publicFanoutCalls += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: "0x1111111111111111111111111111111111111111111111111111111111111111"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const inFlightBuilderResult = {
      submitted: true,
      provider: "builder.example",
      acceptedAt: "2030-01-01T00:00:19.050Z",
      requestStartedAt: "2030-01-01T00:00:18.700Z",
      requestLatencyMs: 350,
      latencyMs: 350,
      buyTxHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      tipTxHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      tipBnb: "0.001",
      tipPreSigned: true,
      maxTimestamp: 1893456019,
      targetSecond: 19,
      targetBoundaryAtMs: 1893456019000,
      targetBoundaryLeadMs: 300,
      publicFallbackLeadMs: 150,
      earlySubmitAtMs: 1893456018700,
      earlySubmitted: true,
      earlySubmitStartedAt: "2030-01-01T00:00:18.700Z",
      earlySubmitLeadMs: 300
    };
    inFlightBroadcast = await broadcastPreSignedFastTransaction({
      ...testCfg,
      fanoutBroadcast: true,
      rpcUrl: "https://race-rpc-a.example",
      broadcastRpcUrls: ["https://race-rpc-a.example", "https://race-rpc-b.example"],
      builderBundleEnabled: true,
      builderBundleTimingMode: "auto",
      builderBundleMode: "builder_then_fanout",
      builderBundleTipBnb: "0.001",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderBundlePrepositionLeadMs: 300,
      openBroadcastDelayMs: 18850
    }, {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 42,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMaxTimestamp: 1893456019,
      builderBundleTargetSecond: 19,
      preSubmittedBuilderBundlePromise: Promise.resolve(inFlightBuilderResult)
    });
    guardedPreSubmittedBroadcast = await broadcastPreSignedFastTransaction({
      ...testCfg,
      fanoutBroadcast: true,
      rpcUrl: "https://race-rpc-a.example",
      broadcastRpcUrls: ["https://race-rpc-a.example", "https://race-rpc-b.example"],
      builderBundleEnabled: true,
      builderBundleTimingMode: "auto",
      builderBundleMode: "builder_then_fanout",
      builderBundleTipBnb: "0.001",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderBundlePrepositionLeadMs: 500,
      builderTimestampGuardEnabled: true,
      builderTimestampGuardAddress: "0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557",
      openBroadcastDelayMs: 18850
    }, {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 43,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMinTimestamp: 1893456019,
      builderBundleMaxTimestamp: 1893456019,
      builderBundleTargetSecond: 19,
      preSignedTimestampGuardTransaction: {
        txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        serializedTransaction: "0x5678",
        nonce: 42,
        to: "0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557",
        targetTimestamp: 1893456019
      },
      preSubmittedBuilderBundle: {
        ...inFlightBuilderResult,
        timestampGuardEnabled: true,
        timestampGuardAddress: "0x376ba9bF428F62350256f9aD4f3B5eF48Ae81557",
        timestampGuardTxHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        timestampGuardNonce: 42,
        timestampGuardTargetTimestamp: 1893456019
      }
    });
    strictBuilderOnlyBroadcast = await broadcastPreSignedFastTransaction({
      ...testCfg,
      fanoutBroadcast: true,
      rpcUrl: "https://race-rpc-a.example",
      broadcastRpcUrls: ["https://race-rpc-a.example", "https://race-rpc-b.example"],
      builderBundleEnabled: true,
      builderBundleTimingMode: "auto",
      builderBundleMode: "builder_only",
      builderBundleTipBnb: "0.001",
      builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848",
      builderBundlePrepositionLeadMs: 500,
      openBroadcastDelayMs: 18850
    }, {
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      serializedTransaction: "0x1234",
      nonce: 44,
      gas: "21000",
      gasPrice: "1000000000",
      builderBundleMinTimestamp: 1893456019,
      builderBundleMaxTimestamp: 1893456019,
      builderBundleTargetSecond: 19,
      preSubmittedBuilderBundle: inFlightBuilderResult
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertSelfTest(
    publicFanoutCalls === 4 &&
      inFlightBroadcast?.mode === "presigned_builder_then_fanout_raw" &&
      inFlightBroadcast?.builderBundlePublicFanoutWhileInFlight === true &&
      inFlightBroadcast?.builderBundleSubmitted === true &&
      Boolean(inFlightBroadcast?.publicBroadcastStartedAt) &&
      guardedPreSubmittedBroadcast?.mode === "presigned_builder_then_fanout_raw" &&
      guardedPreSubmittedBroadcast?.builderTimestampGuardEnabled === true &&
      Boolean(guardedPreSubmittedBroadcast?.publicBroadcastStartedAt) &&
      strictBuilderOnlyBroadcast?.mode === "presigned_builder_bundle_only" &&
      strictBuilderOnlyBroadcast?.publicBroadcastSkipped === true,
    `Builder races should preserve hybrid fallback but never fan out strict builder-only buys, got ${JSON.stringify({ publicFanoutCalls, inFlightBroadcast, guardedPreSubmittedBroadcast, strictBuilderOnlyBroadcast })}`
  );
  const killSwitchDryRun = await buildBuilderBundleDryRun({
    ...testCfg,
    builderBundleKillSwitch: true,
    builderBundleEnabled: true,
    builderBundleTimingMode: "legacy",
    builderBundleTipBnb: "0.001",
    builderBundleTipTo: "0x4848489f0b2BEdd788c696e2D79b6b69D7484848"
  }, {
    txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    serializedTransaction: "0x1234",
    nonce: 42,
    gas: "21000",
    gasPrice: "1000000000"
  });
  assertSelfTest(
    !killSwitchDryRun.ready && killSwitchDryRun.reason === "kill-switch",
    `builder kill switch must override explicit plan enablement, got ${JSON.stringify(killSwitchDryRun)}`
  );
  const nonceSourceRecord = { market: mockEventMarket({ address: "0x0000000000000000000000000000000000001181" }) };
  const nonceLaterRecord = {
    market: mockEventMarket({ address: "0x0000000000000000000000000000000000001182" }),
    preSignedFastTransaction: { txHash: "0xlater", nonce: 45 }
  };
  const nonceRuntime = { nextNonce: 46, lastNonceSyncAt: Date.now() };
  releaseBuilderTipNonceReservationAfterEarlyFailure(
    { ...testCfg, dryRun: false, execute: true },
    new Map([["source", nonceSourceRecord], ["later", nonceLaterRecord]]),
    nonceRuntime,
    nonceSourceRecord,
    { txHash: "0xbuy", nonce: 42 }
  );
  assertSelfTest(
    nonceRuntime.nextNonce === 43 && !nonceLaterRecord.preSignedFastTransaction,
    `failed early builder submission should release tip nonce and discard later pre-sign, got nonce=${nonceRuntime.nextNonce}`
  );
  const guardedNonceRuntime = { nextNonce: 46, lastNonceSyncAt: Date.now() };
  const guardedLaterRecord = {
    market: mockEventMarket({ address: "0x0000000000000000000000000000000000001183" }),
    preSignedFastTransaction: { txHash: "0xguarded-later", nonce: 45 }
  };
  releaseBuilderTipNonceReservationAfterEarlyFailure(
    { ...testCfg, dryRun: false, execute: true },
    new Map([["source", nonceSourceRecord], ["later", guardedLaterRecord]]),
    guardedNonceRuntime,
    nonceSourceRecord,
    {
      txHash: "0xguarded-buy",
      nonce: 43,
      preSignedTimestampGuardTransaction: { txHash: "0xguard", nonce: 42 }
    }
  );
  assertSelfTest(
    guardedNonceRuntime.nextNonce === 46 && guardedLaterRecord.preSignedFastTransaction,
    "guarded early submission failure must retain guard/buy/tip nonces for the chain-gated public fallback"
  );
  const droppedSourceRecord = { preSignedFastTransaction: { txHash: "0xdropped", nonce: 42 } };
  const droppedLaterRecord = { preSignedFastTransaction: { txHash: "0xdropped-later", nonce: 44 } };
  const droppedRuntime = {
    pendingBuyRecords: new Map([["source", droppedSourceRecord], ["later", droppedLaterRecord]])
  };
  const droppedCleared = clearRuntimePreSignedTransactionsAtOrAfterNonce(droppedRuntime, 42, "self-test-target-missed");
  assertSelfTest(
    droppedCleared === 2 && !droppedSourceRecord.preSignedFastTransaction && !droppedLaterRecord.preSignedFastTransaction,
    `target-missed nonce recovery should discard current and later pre-signs, got ${droppedCleared}`
  );
  const staggeredGasReserve = calculateFundingGasReserve(
    { ...testCfg, fastGasLimit: 8000000, bundleDueMarkets: false, gasPriceGwei: "3" },
    fundingForMarketSummaries(testCfg, [
      { question: "BNB/USDT Futures Daily Volume", outcomeCount: 2, availableOutcomeCount: 6, totalStakeUsdt: 20, gasPriceGwei: "0.15" },
      { question: "OpenRouter Python", outcomeCount: 3, availableOutcomeCount: 10, totalStakeUsdt: 30, gasPriceGwei: "3" }
    ])
  );
  const combinedSingleReserve = calculateFastGasReserve(
    { ...testCfg, fastGasLimit: 8000000, bundleDueMarkets: false, gasPriceGwei: "3" },
    { nextBatchOutcomeCount: 5, nextBatchGasPriceGwei: "3" }
  );
  assertSelfTest(
    staggeredGasReserve.mode === "multi_single_fast" &&
      Number(staggeredGasReserve.requiredBnb) < Number(combinedSingleReserve.requiredBnb),
    `staggered gas reserve should sum per-market gas instead of overestimating as one 5-outcome tx, got ${JSON.stringify(staggeredGasReserve)} vs ${JSON.stringify(combinedSingleReserve)}`
  );
  passed.push("builder targeting, legacy guard, dual-Builder atomic timing, kill switch, and nonce ownership are enforced");
  passed.push("staggered non-bundle gas reserve sums per-market gas");
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
  const guardedBuilderReserveWei = 2_126_000_000_000_000n;
  const guardedBuilderWalletBalance = 22_828_163_752_684_928n;
  const guardedBuilderGasPrice = 2_100_000_000n;
  const guardedBuilderGasLimit = resolveWalletBudgetGasLimit(
    {
      ...testCfg,
      fastGasWalletBudget: true,
      fastGasWalletBudgetBps: 10000,
      fastGasBlockLimitBps: 10000,
      fastGasTxLimit: 16777216
    },
    {
      desiredGasLimit: 5_200_000n,
      walletBalance: guardedBuilderWalletBalance,
      gasPrice: guardedBuilderGasPrice,
      blockGasLimit: 140_000_000n,
      reservedWei: guardedBuilderReserveWei
    }
  );
  assertSelfTest(
    guardedBuilderGasLimit * guardedBuilderGasPrice + guardedBuilderReserveWei <= guardedBuilderWalletBalance,
    "guarded Builder wallet budget should reserve guard gas, tip value, and tip transfer gas"
  );
  assertSelfTest(
    guardedBuilderGasLimit >= 5_200_000n && guardedBuilderGasLimit < 10_870_554n,
    `guarded Builder buy gas should keep the desired margin without consuming reserved BNB, got ${guardedBuilderGasLimit}`
  );
  const fixedGasLimit = resolveWalletBudgetGasLimit(
    { ...testCfg, fastGasWalletBudget: false, fastGasTxLimit: 16777216 },
    { desiredGasLimit: 20_000_000n }
  );
  assertSelfTest(
    fixedGasLimit === 16_777_216n,
    `fixed fast gas limit should cap to BSC tx max, got ${fixedGasLimit}`
  );
  passed.push("fast gas limit uses wallet BNB budget capped by BSC tx max and reserves guarded Builder costs");

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

  const dailyVolumeAllowlistCfg = {
    ...testCfg,
    minEventDurationHours: 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: ["Price"],
    marketQuestionAllowlistRegex: /^(BTC|ETH|BNB)\/USDT Futures Daily Volume/i
  };
  const allowedDailyVolumeMarkets = filterEventMarkets([
    mockEventMarket({
      address: "0x0000000000000000000000000000000000001146",
      question: "BNB/USDT Futures Daily Volume, May 27th?",
      categories: ["Crypto"],
      startDate: new Date(Date.now() + 60000).toISOString(),
      endDate: new Date(Date.now() + 24 * 3600000).toISOString()
    })
  ], dailyVolumeAllowlistCfg);
  assertSelfTest(allowedDailyVolumeMarkets.length === 1, "question allowlist should allow BNB daily volume when duration filter is paused");
  const blockedDailyVolumeDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001147",
    question: "SOL/USDT Futures Daily Volume, May 27th?",
    categories: ["Crypto"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), dailyVolumeAllowlistCfg);
  assertSelfTest(
    !blockedDailyVolumeDecision.eligible && blockedDailyVolumeDecision.reason === "question-allowlist",
    `question allowlist should exclude SOL daily volume, got ${JSON.stringify(blockedDailyVolumeDecision)}`
  );
  const manualBlockedDailyVolumeDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001148",
    question: "SOL/USDT Futures Daily Volume, May 27th?",
    categories: ["Crypto"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), {
    ...dailyVolumeAllowlistCfg,
    marketFollowState: {
      followed: {
        "0x0000000000000000000000000000000000001148": {
          market: "0x0000000000000000000000000000000000001148",
          title: "SOL/USDT Futures Daily Volume"
        }
      },
      blocked: {}
    }
  });
  assertSelfTest(
    !manualBlockedDailyVolumeDecision.eligible && manualBlockedDailyVolumeDecision.reason === "question-allowlist",
    `manual follow must not bypass question allowlist, got ${JSON.stringify(manualBlockedDailyVolumeDecision)}`
  );
  passed.push("question allowlist can hard-limit Bot2 daily volume targets");

  const allowlistBlockedExactScoreMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000001149",
    question: "USA vs Bosnia and Herzegovina",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match", "world_cup"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 120 * 3600000).toISOString()
  });
  const hardQuestionAllowlistCfg = {
    ...testCfg,
    minEventDurationHours: 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: ["Price"],
    marketQuestionAllowlistRegex: /a^/,
    eventDisplayFilterRules: ["price", "daily_fixed_template", "sports_total_goals", "sports_goal_differential"]
  };
  const allowlistBlockedExactScoreDecision = getEventMarketDecision(allowlistBlockedExactScoreMarket, hardQuestionAllowlistCfg);
  assertSelfTest(
    !allowlistBlockedExactScoreDecision.eligible && allowlistBlockedExactScoreDecision.reason === "question-allowlist",
    `hard question allowlist should still block auto-buy, got ${JSON.stringify(allowlistBlockedExactScoreDecision)}`
  );
  const allowlistBlockedExactScoreDisplay = getEventMarketDisplayDecision(
    allowlistBlockedExactScoreMarket,
    hardQuestionAllowlistCfg,
    allowlistBlockedExactScoreDecision
  );
  assertSelfTest(
    allowlistBlockedExactScoreDisplay.visible && allowlistBlockedExactScoreDisplay.reason === "display-sports-exact-score",
    `hard question allowlist should not hide exact-score display, got ${JSON.stringify(allowlistBlockedExactScoreDisplay)}`
  );
  const allowlistBlockedTotalGoalsDisplay = getEventMarketDisplayDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001153",
    question: "USA vs Bosnia and Herzegovina - Total Goals",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_tg", "world_cup", "world_cup_prop"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 120 * 3600000).toISOString()
  }), hardQuestionAllowlistCfg);
  assertSelfTest(
    !allowlistBlockedTotalGoalsDisplay.visible && allowlistBlockedTotalGoalsDisplay.reason === "display-sports-total-goals",
    `display filters should still hide Total Goals side markets, got ${JSON.stringify(allowlistBlockedTotalGoalsDisplay)}`
  );
  passed.push("question allowlist blocks auto-buy without hiding exact-score dashboard display");

  const bot4OpenRouterPythonCfg = {
    ...testCfg,
    minEventDurationHours: 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: ["Price"],
    eventIntelBuyFilter: "off",
    marketQuestionAllowlistRegex: null,
    marketBuyQuestionAllowlistRegex: /highest.*Python.*usage.*OpenRouter|AI 模型.*OpenRouter.*Python.*使用量.*最高/i
  };
  const bot4OpenRouterDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001150",
    question: "Which AI model will have the highest Python usage on OpenRouter on June 23rd?",
    categories: ["AI"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), bot4OpenRouterPythonCfg);
  assertSelfTest(
    bot4OpenRouterDecision.eligible,
    `Bot4 buy allowlist should allow OpenRouter Python usage, got ${JSON.stringify(bot4OpenRouterDecision)}`
  );
  const bot4BlockedDailyVolumeDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001151",
    question: "BNB/USDT Futures Daily Volume, June 23rd?",
    categories: ["Crypto"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), bot4OpenRouterPythonCfg);
  assertSelfTest(
    !bot4BlockedDailyVolumeDecision.eligible && bot4BlockedDailyVolumeDecision.reason === "buy-question-allowlist",
    `Bot4 buy allowlist should exclude other daily templates, got ${JSON.stringify(bot4BlockedDailyVolumeDecision)}`
  );
  const bot4ManualBlockedDailyVolumeDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001152",
    question: "BNB/USDT Futures Daily Volume, June 23rd?",
    categories: ["Crypto"],
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), {
    ...bot4OpenRouterPythonCfg,
    marketFollowState: {
      followed: {
        "0x0000000000000000000000000000000000001152": {
          market: "0x0000000000000000000000000000000000001152",
          title: "BNB/USDT Futures Daily Volume"
        }
      },
      blocked: {}
    }
  });
  assertSelfTest(
    !bot4ManualBlockedDailyVolumeDecision.eligible && bot4ManualBlockedDailyVolumeDecision.reason === "buy-question-allowlist",
    `manual follow must not bypass Bot4 buy allowlist, got ${JSON.stringify(bot4ManualBlockedDailyVolumeDecision)}`
  );
  passed.push("Bot4 buy allowlist can hard-limit OpenRouter Python usage targets while display stays broad");

  const intelStrongCfg = {
    ...testCfg,
    minEventDurationHours: 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: ["Price"],
    eventIntelBuyFilter: "strong",
    eventIntelBuyFile: path.join(os.tmpdir(), `42space-missing-intel-${Date.now()}.jsonl`)
  };
  const localStrongDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001246",
    question: "HYPE vs BNB: Higher FDV on Dec 31st 2026?",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), intelStrongCfg);
  assertSelfTest(
    localStrongDecision.eligible && localStrongDecision.tags.includes("Binance strong"),
    `local Binance strong topic should pass Bot2 intel filter, got ${JSON.stringify(localStrongDecision)}`
  );
  const bnbDailyDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001247",
    question: "BNB/USDT Futures Daily Volume, June 2nd?",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 24 * 3600000).toISOString()
  }), intelStrongCfg);
  assertSelfTest(
    !bnbDailyDecision.eligible && bnbDailyDecision.reason === "event-intel-missing",
    `BNB daily fixed template should not pass Bot2 strong filter by ticker alone, got ${JSON.stringify(bnbDailyDecision)}`
  );
  const fixedDailyWithBinanceSourceDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001251",
    question: "BTC/USDT Futures Daily Volume, June 3rd?",
    description: "Primary Resolution Source: https://www.binance.com/en/futures/funding-history/1",
    createdAt: "2030-06-01T00:00:00Z",
    startDate: "2030-06-03T00:00:00Z",
    endDate: "2030-06-03T12:00:00Z"
  }), intelStrongCfg);
  assertSelfTest(
    !fixedDailyWithBinanceSourceDecision.eligible && fixedDailyWithBinanceSourceDecision.reason === "event-intel-archive",
    `Fixed daily template should stay archived before local Binance source matching, got ${JSON.stringify(fixedDailyWithBinanceSourceDecision)}`
  );
  const genericBinanceChartDecision = getEventMarketDecision(mockEventMarket({
    address: "0x0000000000000000000000000000000000001252",
    question: "How much will ETH appreciate following Vitalik's post?",
    description: "Resolution Source: https://www.binance.com/en/trade/ETH_USDT?type=spot",
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 7 * 24 * 3600000).toISOString()
  }), intelStrongCfg);
  assertSelfTest(
    !genericBinanceChartDecision.eligible && genericBinanceChartDecision.reason === "event-intel-missing",
    `Generic Binance chart resolution source should not pass Bot2 strong filter, got ${JSON.stringify(genericBinanceChartDecision)}`
  );

  const followRuleLibraryCfg = {
    ...testCfg,
    ...FOLLOW_RULE_LIBRARY_CONFIG,
    eventIntelBuyFile: path.join(os.tmpdir(), `42space-follow-rule-library-missing-${Date.now()}.jsonl`),
    marketFollowState: { followed: {}, blocked: {} }
  };
  for (const entry of FOLLOW_RULE_EVENT_LIBRARY) {
    const decision = getEventMarketDecision(entry.market, followRuleLibraryCfg);
    const displayDecision = getEventMarketDisplayDecision(entry.market, followRuleLibraryCfg, decision);
    assertSelfTest(
      decision.eligible === entry.expected.eligible,
      `${entry.id} expected eligible=${entry.expected.eligible}, got ${JSON.stringify(decision)}`
    );
    if (entry.expected.reason) {
      assertSelfTest(
        decision.reason === entry.expected.reason,
        `${entry.id} expected reason=${entry.expected.reason}, got ${JSON.stringify(decision)}`
      );
    }
    if (entry.expected.defaultFollowed !== undefined) {
      assertSelfTest(
        Boolean(decision.follow?.defaultFollowed) === entry.expected.defaultFollowed,
        `${entry.id} expected defaultFollowed=${entry.expected.defaultFollowed}, got ${JSON.stringify(decision.follow)}`
      );
    }
    for (const tag of entry.expected.tagsAny ?? []) {
      assertSelfTest(
        (decision.tags ?? []).includes(tag),
        `${entry.id} expected tag ${tag}, got ${JSON.stringify(decision.tags)}`
      );
    }
    if (entry.expected.displayVisible !== undefined) {
      assertSelfTest(
        Boolean(displayDecision.visible) === entry.expected.displayVisible,
        `${entry.id} expected displayVisible=${entry.expected.displayVisible}, got ${JSON.stringify(displayDecision)}`
      );
    }
    if (entry.expected.displayNotify !== undefined) {
      assertSelfTest(
        Boolean(displayDecision.notify) === entry.expected.displayNotify,
        `${entry.id} expected displayNotify=${entry.expected.displayNotify}, got ${JSON.stringify(displayDecision)}`
      );
    }
    if (entry.expected.displayReason) {
      assertSelfTest(
        displayDecision.reason === entry.expected.displayReason,
        `${entry.id} expected displayReason=${entry.expected.displayReason}, got ${JSON.stringify(displayDecision)}`
      );
    }
    for (const tag of entry.expected.displayTagsAny ?? []) {
      assertSelfTest(
        (displayDecision.tags ?? []).includes(tag),
        `${entry.id} expected display tag ${tag}, got ${JSON.stringify(displayDecision.tags)}`
      );
    }
  }
  passed.push("follow-rule event library matches Bot2 display, notify, default-follow, and fixed-template exclusions");

  const noDisplayFilterCfg = {
    ...followRuleLibraryCfg,
    eventDisplayFilterRules: []
  };
  for (const entry of FOLLOW_RULE_EVENT_LIBRARY.filter((item) => item.expected.displayVisible === false)) {
    const displayDecision = getEventMarketDisplayDecision(entry.market, noDisplayFilterCfg);
    assertSelfTest(
      displayDecision.visible && displayDecision.notify,
      `${entry.id} should display and notify when all display filters are disabled, got ${JSON.stringify(displayDecision)}`
    );
  }
  passed.push("empty display-filter rule list shows every data-complete monitored library event");

  const dailyTemplateOnlyDisplayCfg = {
    ...followRuleLibraryCfg,
    eventDisplayIncludeRules: ["daily_fixed_template"]
  };
  for (const entry of FOLLOW_RULE_EVENT_LIBRARY) {
    const displayDecision = getEventMarketDisplayDecision(entry.market, dailyTemplateOnlyDisplayCfg);
    const shouldDisplay = entry.expected.displayReason === "display-fixed-template";
    assertSelfTest(
      Boolean(displayDecision.visible) === shouldDisplay,
      `${entry.id} daily-template include expected visible=${shouldDisplay}, got ${JSON.stringify(displayDecision)}`
    );
    assertSelfTest(
      Boolean(displayDecision.notify) === shouldDisplay,
      `${entry.id} daily-template include expected notify=${shouldDisplay}, got ${JSON.stringify(displayDecision)}`
    );
    assertSelfTest(
      shouldDisplay
        ? displayDecision.reason === "display-include-daily-fixed-template"
        : displayDecision.reason === "display-include-miss",
      `${entry.id} daily-template include reason mismatch, got ${JSON.stringify(displayDecision)}`
    );
  }
  passed.push("display include rules can show only daily fixed templates for Bot4");

  const intelReportDir = fs.mkdtempSync(path.join(os.tmpdir(), "42space-intel-buy-test-"));
  try {
    const intelReportFile = path.join(intelReportDir, "event-intel.jsonl");
    const reportRows = [
      {
        market: "0x0000000000000000000000000000000000001248",
        binanceRelation: "strong",
        fixedTemplate: false,
        eventKind: "non-template"
      },
      {
        market: "0x0000000000000000000000000000000000001249",
        binanceRelation: "medium",
        fixedTemplate: false,
        eventKind: "non-template"
      },
      {
        market: "0x0000000000000000000000000000000000001250",
        binanceRelation: "strong",
        fixedTemplate: true,
        eventKind: "fixed-template"
      }
    ];
    fs.writeFileSync(intelReportFile, `${reportRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const reportStrongDecision = getEventMarketDecision(mockEventMarket({
      address: "0x0000000000000000000000000000000000001248",
      question: "A report-only Binance strong event?",
      startDate: new Date(Date.now() + 60000).toISOString(),
      endDate: new Date(Date.now() + 24 * 3600000).toISOString()
    }), { ...intelStrongCfg, eventIntelBuyFile: intelReportFile });
    assertSelfTest(
      reportStrongDecision.eligible && reportStrongDecision.tags.includes("情报报告命中"),
      `JSONL Binance strong report should pass Bot2 intel filter, got ${JSON.stringify(reportStrongDecision)}`
    );
    const reportMediumDecision = getEventMarketDecision(mockEventMarket({
      address: "0x0000000000000000000000000000000000001249",
      question: "A report-only Binance medium event?",
      startDate: new Date(Date.now() + 60000).toISOString(),
      endDate: new Date(Date.now() + 24 * 3600000).toISOString()
    }), { ...intelStrongCfg, eventIntelBuyFile: intelReportFile });
    assertSelfTest(
      !reportMediumDecision.eligible && reportMediumDecision.reason === "event-intel-relation",
      `JSONL Binance medium report should not pass Bot2 intel filter, got ${JSON.stringify(reportMediumDecision)}`
    );
    const archivedStrongDecision = getEventMarketDecision(mockEventMarket({
      address: "0x0000000000000000000000000000000000001250",
      question: "A fixed-template Binance strong report?",
      startDate: new Date(Date.now() + 60000).toISOString(),
      endDate: new Date(Date.now() + 24 * 3600000).toISOString()
    }), { ...intelStrongCfg, eventIntelBuyFile: intelReportFile });
    assertSelfTest(
      !archivedStrongDecision.eligible && archivedStrongDecision.reason === "event-intel-archive",
      `Archived fixed-template strong report should not pass Bot2 intel filter, got ${JSON.stringify(archivedStrongDecision)}`
    );
  } finally {
    fs.rmSync(intelReportDir, { recursive: true, force: true });
  }
  passed.push("Bot2 strong intelligence filter gates auto-buy without reviving fixed-template buys");

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
  const restKnownEligibleState = createRestDiscoveryState();
  const restKnownEligibleMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000000150",
    question: "Known future long market",
    status: "not_started",
    createdAt: new Date(Date.now()).toISOString(),
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 72 * 3600000).toISOString()
  });
  rememberRestDiscoveryMarkets(restKnownEligibleState, [restKnownEligibleMarket]);
  const knownRestCandidates = collectRestDiscoveryCandidates(
    testCfg,
    new Set(),
    new Map(),
    restKnownEligibleState,
    [restKnownEligibleMarket]
  );
  assertSelfTest(
    knownRestCandidates.candidates.length === 1 && knownRestCandidates.knownFutureEligible === 1,
    `known future eligible REST market should become a candidate, got ${JSON.stringify(knownRestCandidates)}`
  );
  const restOldSeedState = createRestDiscoveryState();
  const restOldSeedMarket = mockEventMarket({
    address: "0x0000000000000000000000000000000000000151",
    question: "Old future long market",
    status: "not_started",
    createdAt: new Date(restOldSeedState.startedAtMs - 60000).toISOString(),
    startDate: new Date(Date.now() + 60000).toISOString(),
    endDate: new Date(Date.now() + 72 * 3600000).toISOString()
  });
  rememberRestDiscoveryMarkets(restOldSeedState, [restOldSeedMarket]);
  const oldSeedCandidates = collectRestDiscoveryCandidates(
    testCfg,
    new Set(),
    new Map(),
    restOldSeedState,
    [restOldSeedMarket]
  );
  assertSelfTest(
    oldSeedCandidates.candidates.length === 1 && oldSeedCandidates.knownFutureEligible === 1,
    "known future REST markets should be rechecked after seed when they are eligible and not pending"
  );
  passed.push("REST raw discovery tracks filtered markets and rechecks known future eligible markets after seed");

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

  const executionTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "42space-execution-isolation-self-test-"));
  try {
    const isolatedCfg = isolatedExecutionTestConfig({
      ...testCfg,
      feishuAlertsEnabled: true,
      feishuWebhook: "https://example.invalid/production-webhook"
    }, executionTestRoot);
    const isolatedFiles = [
      isolatedCfg.stateFile,
      isolatedCfg.fillsFile,
      isolatedCfg.gasLedgerFile,
      isolatedCfg.decisionFile,
      isolatedCfg.alertStateFile,
      isolatedCfg.runtimeHealthFile,
      isolatedCfg.autoSellStateFile,
      isolatedCfg.autoSellPositionStateFile,
      isolatedCfg.autoSellCircuitStateFile
    ];
    assertSelfTest(isolatedCfg.executionTestMode, "execution tests should carry an explicit side-effect guard");
    assertSelfTest(!isolatedCfg.feishuAlertsEnabled && !isolatedCfg.feishuWebhook, "execution tests must disable Feishu");
    assertSelfTest(
      isolatedFiles.every((file) => path.dirname(file) === executionTestRoot),
      "execution test writes must stay inside the isolated temporary directory"
    );
  } finally {
    fs.rmSync(executionTestRoot, { recursive: true, force: true });
  }
  passed.push("execution tests isolate files and cannot send production Feishu alerts");

  const dedicatedTimerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "42space-dedicated-timer-self-test-"));
  try {
    const timerCfg = {
      ...isolatedExecutionTestConfig(testCfg, dedicatedTimerRoot),
      allowLateBuy: false,
      eventOpenWindowSeconds: 20
    };
    const timerMarket = mockEventMarket({
      address: "0x0000000000000000000000000000000000000050",
      question: "Dedicated timer expiry race",
      startDate: new Date(Date.now() - 30000).toISOString()
    });
    const timerKey = eventSeenKey(timerMarket, timerCfg);
    const timerRecord = { market: timerMarket, dedicatedOpenTimer: true };
    const timerPending = new Map([[timerKey, timerRecord]]);
    const timerSeen = new Set();
    skipExpiredPendingMarkets(timerCfg, timerSeen, timerPending, "self-test-dedicated-timer");
    assertSelfTest(
      timerPending.has(timerKey) && !timerSeen.has(timerKey),
      "an active dedicated open timer must not be marked expired by the generic drain loop"
    );
    timerRecord.dedicatedOpenTimer = false;
    skipExpiredPendingMarkets(timerCfg, timerSeen, timerPending, "self-test-dedicated-timer-finished");
    assertSelfTest(
      !timerPending.has(timerKey) && timerSeen.has(timerKey),
      "an expired record should be skipped after its dedicated timer finishes"
    );
  } finally {
    fs.rmSync(dedicatedTimerRoot, { recursive: true, force: true });
  }
  passed.push("dedicated open timers are protected from the generic expiry race");

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
  assertSelfTest(
    shouldNotifyFundingWait(farFundingStatus, { armFundingNotifyWindowMs: 18 * 60 * 60 * 1000 }),
    "profile funding notify window can alert before the default near-opening window"
  );

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

function mockFifaExactScoreOutcomes({ homePrice, awayPrice, drawPrice }) {
  const rows = [
    ["ECU 0-0 CUW", drawPrice],
    ["ECU 1-1 CUW", drawPrice],
    ["ECU 2-2 CUW", drawPrice],
    ["ECU 1-0 CUW", homePrice],
    ["ECU 2-0 CUW", homePrice],
    ["ECU 3-0 CUW", homePrice],
    ["ECU 2-1 CUW", homePrice],
    ["ECU 3-1 CUW", homePrice],
    ["ECU 0-1 CUW", awayPrice],
    ["ECU 0-2 CUW", awayPrice],
    ["ECU 0-3 CUW", awayPrice],
    ["ECU 1-2 CUW", awayPrice],
    ["ECU 1-3 CUW", awayPrice]
  ];
  return rows.map(([name, price], index) => ({
    tokenId: (1n << BigInt(index)).toString(),
    name,
    price,
    payout: price > 0 ? 1 / price : null
  }));
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
  const useProfileSigner = args.profileSigner === true;
  if (useProfileSigner && !cfg.privateKey) {
    throw new Error("--profile-signer requires PRIVATE_KEY from the loaded profile");
  }
  const signerMode = useProfileSigner ? "profile" : "public_test";
  const isolatedCfg = isolatedExecutionTestConfig(cfg);
  const testCfg = {
    ...isolatedCfg,
    privateKey: useProfileSigner ? cfg.privateKey : PUBLIC_TEST_PRIVATE_KEY,
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
  const testAccount = makeClients(testCfg).account;
  const runtime = {
    receiverAddress: testAccount?.address ?? PUBLIC_TEST_RECEIVER,
    nextNonce: 1000
  };
  const records = await Promise.all(batch.map((market) => preparePendingRecord(testCfg, market, runtime)));
  const prepareErrors = records.filter((record) => record.prepareError).map((record) => ({
    market: pendingMarket(record).address,
    error: record.prepareError
  }));
  if (prepareErrors.length > 0) {
    throw new Error(`Pre-sign test prepare failed: ${JSON.stringify(prepareErrors)}`);
  }
  return { chain, batch, startDate, testCfg, runtime, records, signerMode };
}

function isolatedExecutionTestConfig(cfg, root = fs.mkdtempSync(path.join(os.tmpdir(), "42space-execution-test-"))) {
  return {
    ...cfg,
    executionTestMode: true,
    feishuAlertsEnabled: false,
    feishuWebhook: "",
    stateFile: path.join(root, "seen-markets.json"),
    fillsFile: path.join(root, "fills.jsonl"),
    gasLedgerFile: path.join(root, "gas-ledger.jsonl"),
    decisionFile: path.join(root, "market-decisions.jsonl"),
    alertStateFile: path.join(root, "alert-state.json"),
    runtimeHealthFile: path.join(root, "runtime-health.json"),
    autoSellStateFile: path.join(root, "auto-sell-seen.json"),
    autoSellPositionStateFile: path.join(root, "auto-sell-positions.json"),
    autoSellCircuitStateFile: path.join(root, "auto-sell-circuit.json")
  };
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
  await appendGasLedgerFromExecution(cfg, approval, {
    action: "approval",
    source: "minimal-buy-router-approval",
    wallet: approval.address,
    txHashKey: "approveHash",
    fieldPrefix: "approve",
    metadata: { router: approval.router, requiredAllowance: approval.requiredAllowance }
  });
  await appendGasLedgerFromExecution(cfg, approval, {
    action: "approval",
    source: "minimal-buy-router-approval-reset",
    wallet: approval.address,
    txHashKey: "resetHash",
    fieldPrefix: "reset",
    metadata: { router: approval.router, requiredAllowance: approval.requiredAllowance }
  });
  console.log(JSON.stringify({ level: "minimal-approval", approval }, null, 2));

  const runtime = await createRuntime(cfg);
  const result = await withRuntimeTransactionLock(
    runtime,
    "buy-single",
    () => buyOutcomesBatch(cfg, eventPlan, runtime)
  );
  await appendGasLedgerFromExecution(cfg, result, {
    action: "buy",
    source: "minimal-buy-result",
    allocations: gasAllocationsFromEventPlan(eventPlan)
  });
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
    eventDiscoveryFeedFile: cfg.eventDiscoveryFeedFile || null,
    eventDiscoveryFeedPollMs: cfg.eventDiscoveryFeedPollMs,
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
    builderBundle: builderBundleConfigSummary(cfg),
    executionRetryMs: cfg.executionRetryMs,
    eventOpenWindowSeconds: cfg.eventOpenWindowSeconds,
    preSignFastTx: cfg.preSignFastTx,
    preSignWindowMs: cfg.preSignWindowMs,
    preSignRetryMs: cfg.preSignRetryMs,
    allowPreopenBroadcast: cfg.allowPreopenBroadcast,
    prebroadcastMs: cfg.prebroadcastMs,
    openBroadcastDelayMs: cfg.openBroadcastDelayMs,
    openBroadcastMode: cfg.openBroadcastMode,
    openBroadcastBlockTargetOffsetMs: cfg.openBroadcastBlockTargetOffsetMs,
    openBroadcastBlockAwareLeadMs: cfg.openBroadcastBlockAwareLeadMs,
    openBroadcastBlockAwareMaxWaitMs: cfg.openBroadcastBlockAwareMaxWaitMs,
    openBroadcastBlockAwarePreTargetCount: cfg.openBroadcastBlockAwarePreTargetCount,
    openBroadcastBlockAwarePreTargetSendMs: cfg.openBroadcastBlockAwarePreTargetSendMs,
    openBroadcastBlockAwareHeadMaxAgeMs: cfg.openBroadcastBlockAwareHeadMaxAgeMs,
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
    autoSellLadderProfitPercent: cfg.autoSellLadderProfitPercent,
    autoSellTakeProfitSteps: cfg.autoSellTakeProfitSteps,
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

  let runtime = null;
  let autoSellMonitor;
  let runtimeHealthMonitor;
  let autoSellStartedBeforeFunding = false;
  if (shouldStartAutoSellBeforeFunding(cfg)) {
    runtime = await createRuntime(cfg);
    runtimeHealthMonitor = startRuntimeHealthMonitor(cfg, runtime);
    autoSellMonitor = startAutoSellMonitor(cfg, runtime);
    autoSellStartedBeforeFunding = Boolean(autoSellMonitor);
    console.log(JSON.stringify({
      level: "event-arm-auto-sell-before-funding",
      started: autoSellStartedBeforeFunding,
      sharedRuntime: Boolean(runtime),
      transactionLock: Boolean(runtime?.txLock),
      waitForFunding: true,
      autoSellStrategy: cfg.autoSellStrategy,
      autoSellPollMs: cfg.autoSellPollMs,
      at: new Date().toISOString()
    }));
  }

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

  await watch(cfg, {
    fundingRecovery,
    ...(runtime !== null ? { runtime } : {}),
    ...(runtimeHealthMonitor !== undefined ? { runtimeHealthMonitor } : {}),
    ...(autoSellMonitor !== undefined ? { autoSellMonitor, autoSellStartedBeforeFunding } : {})
  });
}

async function preflight(cfg) {
  const { publicClient } = makeClients(cfg);
  const status = await getWalletStatus(cfg);
  const chain = await loadChainEventMarkets(cfg, { lookbackBlocks: cfg.eventLogLookbackBlocks });
  const funding = computeFundingRequirement(cfg, chain.eventMarkets);
  const gasReserve = await estimateFundingGasReserve(publicClient, cfg, funding);
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
  await appendGasLedgerFromExecution(cfg, result, {
    action: "approval",
    source: "router-approval-cli",
    wallet: result.address,
    txHashKey: "approveHash",
    fieldPrefix: "approve",
    metadata: { router: result.router, requiredAllowance: result.requiredAllowance }
  });
  await appendGasLedgerFromExecution(cfg, result, {
    action: "approval",
    source: "router-approval-reset-cli",
    wallet: result.address,
    txHashKey: "resetHash",
    fieldPrefix: "reset",
    metadata: { router: result.router, requiredAllowance: result.requiredAllowance }
  });
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
    gasReserve = await estimateFundingGasReserve(publicClient, cfg, funding);
  } catch (error) {
    gasReserve = { ok: false, message: errorMessage(error) };
  }
  const checks = {
    config: {
      botName: cfg.botName,
      profileRole: cfg.profileRole || "",
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
      builderBundle: builderBundleConfigSummary(cfg),
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
    openBroadcastBlockClock: null,
    autoSellOperatorReadyMarkets: new Set(),
    health: createRuntimeHealthState(cfg),
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

function createRuntimeHealthState(cfg) {
  const startedAt = new Date().toISOString();
  return {
    version: 1,
    profile: cfg.botName || "42space",
    pid: process.pid,
    startedAt,
    updatedAt: null,
    buy: {
      enabled: Boolean(!cfg.dryRun && cfg.execute),
      policy: runtimeBuyPolicy(cfg),
      state: "starting",
      lastHeartbeatAt: null,
      pendingCount: 0,
      preparedCount: 0,
      transactionLock: null
    },
    sell: {
      enabled: Boolean(cfg.autoSellEnabled),
      strategy: cfg.autoSellStrategy,
      state: cfg.autoSellEnabled ? "starting" : "disabled",
      lastTickStartedAt: null,
      lastTickCompletedAt: null,
      lastSuccessfulScanAt: null,
      checked: 0,
      triggered: 0,
      executed: 0,
      errors: 0,
      skippedReason: null,
      guardUntil: null,
      lastErrorAt: null,
      lastError: null
    }
  };
}

function runtimeBuyPolicy(cfg) {
  if (bot3FifaExactScoreAutoBuyActive(cfg)) return "fifa_exact_score_lowest_price_tier";
  if (String(cfg.eventIntelBuyFilter ?? "").trim().toLowerCase() === "strong") return "meme_binance_strong";
  return "planned_or_manual_follow";
}

function startRuntimeHealthMonitor(cfg, runtime) {
  if (!runtime?.health || !cfg.runtimeHealthFile) return null;
  const write = () => {
    refreshRuntimeHealthSnapshot(runtime);
    try {
      saveRuntimeHealth(cfg.runtimeHealthFile, runtime.health);
    } catch (error) {
      const now = Date.now();
      if (now - runtimeHealthWriteWarningAt >= 60000) {
        runtimeHealthWriteWarningAt = now;
        console.error(JSON.stringify({
          level: "warn",
          source: "runtime-health",
          message: errorMessage(error),
          at: new Date(now).toISOString()
        }));
      }
    }
  };
  write();
  const timer = setInterval(write, RUNTIME_HEALTH_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function refreshRuntimeHealthSnapshot(runtime, now = Date.now()) {
  if (!runtime?.health) return null;
  const at = new Date(now).toISOString();
  const pending = runtime.pendingBuyRecords instanceof Map ? [...runtime.pendingBuyRecords.values()] : [];
  const lock = runtimeTransactionLockInfo(runtime);
  const buyBusy = Boolean(lock?.owner && /buy|bundle|open|broadcast/iu.test(lock.owner));
  runtime.health.updatedAt = at;
  runtime.health.pid = process.pid;
  runtime.health.buy = {
    ...runtime.health.buy,
    state: buyBusy ? "executing" : (pending.length > 0 ? "armed" : "watching"),
    lastHeartbeatAt: at,
    pendingCount: pending.length,
    preparedCount: pending.filter((record) => Boolean(record?.preparedPlan)).length,
    transactionLock: lock
  };
  if (!runtime.health.sell.enabled) runtime.health.sell.state = "disabled";
  return runtime.health;
}

function saveRuntimeHealth(file, state) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function markAutoSellHealthStarted(runtime, at = new Date().toISOString()) {
  if (!runtime?.health?.sell) return;
  runtime.health.sell = {
    ...runtime.health.sell,
    enabled: true,
    state: "checking",
    lastTickStartedAt: at
  };
}

function markAutoSellHealthCompleted(runtime, result, at = new Date().toISOString()) {
  if (!runtime?.health?.sell) return;
  const circuitOpen = result?.circuitBreaker?.status === "open";
  const guarded = ["open-buy-window", "buy-hot-window", "transaction-busy"].includes(result?.skippedReason);
  const successfulScan = !circuitOpen && !guarded && !result?.transientPositionsError;
  runtime.health.sell = {
    ...runtime.health.sell,
    state: circuitOpen ? "paused" : (guarded ? "guarded" : (result?.transientPositionsError ? "degraded" : "watching")),
    lastTickCompletedAt: at,
    lastSuccessfulScanAt: successfulScan ? at : runtime.health.sell.lastSuccessfulScanAt,
    checked: successfulScan ? Number(result?.checked ?? 0) : runtime.health.sell.checked,
    triggered: successfulScan ? Number(result?.triggered ?? 0) : runtime.health.sell.triggered,
    executed: successfulScan ? Number(result?.executed ?? 0) : runtime.health.sell.executed,
    errors: successfulScan ? (Array.isArray(result?.errors) ? result.errors.length : 0) : runtime.health.sell.errors,
    skippedReason: result?.skippedReason ?? null,
    guardUntil: guarded
      ? (result?.pause?.until ?? result?.hotWindow?.startsAt ?? null)
      : null,
    lastErrorAt: result?.transientPositionsError ? at : runtime.health.sell.lastErrorAt,
    lastError: result?.transientPositionsError?.message ?? runtime.health.sell.lastError
  };
}

function markAutoSellHealthError(runtime, error, at = new Date().toISOString()) {
  if (!runtime?.health?.sell) return;
  runtime.health.sell = {
    ...runtime.health.sell,
    state: "error",
    lastTickCompletedAt: at,
    lastErrorAt: at,
    lastError: String(error ?? "auto-sell monitor error")
  };
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

function shouldStartAutoSellBeforeFunding(cfg) {
  return Boolean(cfg?.armWaitForFunding && cfg?.autoSellEnabled);
}

async function waitForRuntimeTransactionIdle(runtime, reason, { timeoutMs = 60000, pollMs = 250 } = {}) {
  if (!runtimeTransactionBusy(runtime)) return;
  const deadline = Date.now() + timeoutMs;
  while (runtimeTransactionBusy(runtime)) {
    if (Date.now() >= deadline) {
      const lock = runtimeTransactionLockInfo(runtime);
      throw new Error(`Timed out waiting for transaction lock to clear before ${reason}: ${lock?.owner ?? "unknown"}`);
    }
    await sleep(pollMs);
  }
}

function pauseRuntimeAutoSell(runtime, cfg, reason) {
  if (!runtime) return;
  const holdMs = autoSellPresignPauseHoldMs(cfg);
  const until = Date.now() + holdMs;
  runtime.autoSellPausedUntil = Math.max(runtime.autoSellPausedUntil ?? 0, until);
  runtime.autoSellPauseReason = reason;
}

function autoSellPresignPauseHoldMs(cfg) {
  if (cfg.autoSellStrategy === "open_timed_exit") {
    const monitorPollMs = autoSellMonitorSchedulerMs(cfg);
    return Math.max(
      monitorPollMs,
      Number(cfg.preSignWindowMs ?? 0) +
        Number(cfg.openBroadcastDelayMs ?? eventOpenWindowMs(cfg)) +
        Math.max(1000, monitorPollMs)
    );
  }
  return Math.max(
    cfg.autoSellPollMs,
    cfg.preSignWindowMs + eventOpenWindowMs(cfg) + 5000
  );
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
  await waitForRuntimeBuilderNonceRecovery(runtime);
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

async function waitForRuntimeBuilderNonceRecovery(runtime) {
  const recovery = runtime?.builderNonceRecoveryPromise;
  if (recovery) await recovery;
  if (runtime?.builderNonceRecoveryError) {
    throw new Error(`strict Builder nonce recovery blocked: ${runtime.builderNonceRecoveryError}`);
  }
}

async function watch(cfg, options = {}) {
  const seen = loadSeen(cfg.stateFile);
  const runtime = Object.prototype.hasOwnProperty.call(options, "runtime")
    ? options.runtime
    : await createRuntime(cfg);
  if (options.autoSellStartedBeforeFunding && runtime) {
    pauseRuntimeAutoSell(runtime, cfg, "funding-ready-watch-start");
    await waitForRuntimeTransactionIdle(runtime, "watch-start-after-funding");
  }
  const startupApproval = await withRuntimeTransactionLock(
    runtime,
    "startup-router-approval",
    () => ensureStartupRouterApproval(cfg)
  );
  if (startupApproval?.approved || startupApproval?.approveHash || startupApproval?.resetHash) {
    await syncRuntimeNonceAfterExternalTx(cfg, runtime, "startup-router-approval");
  }
  const watchPreflight = await validateWatchFunding(cfg);
  const broadcastWarmup = await maybeWarmBroadcastRpcs(cfg);
  const initialPending = new Map();
  attachRuntimePendingBuyRecords(runtime, initialPending);
  const startupWarnings = [];
  const wsStartupSeedDeferred = cfg.eventDiscovery === "ws" && !cfg.watchBuyExisting;

  if (!wsStartupSeedDeferred) {
    startupWarnings.push(...(await seedStartupMarkets(cfg, seen, initialPending, runtime, options)));
  }

  const autoSellMonitorPrestarted = Object.prototype.hasOwnProperty.call(options, "autoSellMonitor");
  const autoSellMonitor = autoSellMonitorPrestarted
    ? options.autoSellMonitor
    : startAutoSellMonitor(cfg, runtime);
  const runtimeHealthMonitor = Object.prototype.hasOwnProperty.call(options, "runtimeHealthMonitor")
    ? options.runtimeHealthMonitor
    : startRuntimeHealthMonitor(cfg, runtime);
  const openBroadcastBlockClock = maybeStartOpenBroadcastBlockClock(cfg, runtime);

  console.log(
    JSON.stringify(
      {
        mode: cfg.dryRun || !cfg.execute ? "dry-run" : "execute",
        stakePerOutcomeUsdt: cfg.stakePerOutcomeUsdt,
        maxMarketStakeUsdt: cfg.maxMarketStakeUsdt,
        maxBatchStakeUsdt: cfg.maxBatchStakeUsdt,
        maxOutcomesPerMarket: cfg.maxOutcomesPerMarket,
        eventDiscovery: cfg.eventDiscovery,
        eventDiscoveryFeedFile: cfg.eventDiscoveryFeedFile || null,
        eventDiscoveryFeedPollMs: cfg.eventDiscoveryFeedPollMs,
        wsProvider: wsProviderLabel(cfg.wsUrl),
        eventBuyMode: cfg.eventBuyMode,
        eventOutcomeSelection: cfg.eventOutcomeSelection,
        eventOutcomeCount: cfg.eventOutcomeCount,
        eventOutcomeSelectionFallback: cfg.eventOutcomeSelectionFallback,
        filterMode: cfg.filterMode ?? "production",
        marketQuestionAllowlistRegex: cfg.marketQuestionAllowlistRegex?.source ?? null,
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
      builderBundle: builderBundleConfigSummary(cfg),
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
        openBroadcastMode: cfg.openBroadcastMode,
        openBroadcastBlockTargetOffsetMs: cfg.openBroadcastBlockTargetOffsetMs,
        openBroadcastBlockAwareLeadMs: cfg.openBroadcastBlockAwareLeadMs,
        openBroadcastBlockAwareMaxWaitMs: cfg.openBroadcastBlockAwareMaxWaitMs,
        openBroadcastBlockAwarePreTargetCount: cfg.openBroadcastBlockAwarePreTargetCount,
        openBroadcastBlockAwarePreTargetSendMs: cfg.openBroadcastBlockAwarePreTargetSendMs,
        openBroadcastBlockAwareHeadMaxAgeMs: cfg.openBroadcastBlockAwareHeadMaxAgeMs,
        openBroadcastBlockClockActive: Boolean(openBroadcastBlockClock?.unwatch),
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
              ladderProfitPercent: cfg.autoSellLadderProfitPercent,
              openExitDelaySeconds: cfg.autoSellOpenExitDelaySeconds,
              openExitPercent: cfg.autoSellOpenExitPercent,
              fastOpenExitEnabled: cfg.autoSellFastOpenExitEnabled,
              fastOpenExitMinDelayMs: cfg.autoSellFastOpenExitMinDelayMs,
              fastOpenExitMaxDelayMs: cfg.autoSellFastOpenExitMaxDelayMs,
              takeProfitSteps: cfg.autoSellTakeProfitSteps,
              beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
              marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
              gasPriceGwei: cfg.autoSellGasPriceGwei || cfg.gasPriceGwei || null,
              pollMs: cfg.autoSellPollMs,
              buyGuardBeforeMs: cfg.autoSellBuyGuardBeforeMs,
              buyGuardAfterMs: cfg.autoSellBuyGuardAfterMs,
              preapproveOperator: cfg.autoSellPreapproveOperator,
              requirePreapprovedOperator: cfg.autoSellRequirePreapprovedOperator,
              maxOutcomesPerTx: cfg.autoSellMaxOutcomesPerTx,
              maxMarketsPerTx: cfg.autoSellMaxMarketsPerTx,
              maxGasPerTx: cfg.autoSellMaxGasPerTx,
              maxTxPerTick: cfg.autoSellMaxTxPerTick,
              monitorSource: autoSellMonitorPrestarted ? "pre-funding" : "watch",
              startedBeforeFunding: Boolean(options.autoSellStartedBeforeFunding)
            }
          : { enabled: false },
        runtimeHealth: {
          enabled: Boolean(runtimeHealthMonitor),
          file: cfg.runtimeHealthFile || null,
          intervalMs: RUNTIME_HEALTH_INTERVAL_MS
        }
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
  if (cfg.eventDiscovery === "feed") {
    await watchFeed(cfg, seen, runtime, initialPending);
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

function autoSellMonitorSchedulerMs(cfg) {
  const configured = readPlannedBuys(cfg)
    .filter((plan) => plan.enabled || plan.preserveAutoSellAfterDisable)
    .map((plan) => plan.autoSell)
    .filter((autoSell) => autoSellPriceTargetsEnabled(autoSell))
    .map((autoSell) => Number(autoSell.autoSellPriceHotPollMs ?? 1000))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(250, Math.min(Number(cfg.autoSellPollMs ?? 60000), ...configured));
}

function autoSellMonitorDesiredPollMs(cfg, now = Date.now()) {
  const hotWindow = activeAutoSellPriceHotWindow(cfg, now);
  return hotWindow?.pollMs ?? Number(cfg.autoSellPollMs ?? 60000);
}

function activeAutoSellPriceHotWindow(cfg, now = Date.now()) {
  for (const record of loadAutoSellBuyRecords(cfg)) {
    const plan = plannedBuyAutoSellForMarket(cfg, record);
    const autoSell = plan?.autoSell;
    if (!autoSellPriceTargetsEnabled(autoSell)) continue;
    const buyAtMs = Date.parse(record.buyAt ?? "");
    if (!Number.isFinite(buyAtMs) || now < buyAtMs) continue;
    const applyAfterMs = Date.parse(autoSell.autoSellPriceApplyAfterIso ?? "");
    if (Number.isFinite(applyAfterMs) && buyAtMs < applyAfterMs) continue;
    const windowMs = Number(autoSell.autoSellPriceHotWindowSeconds ?? 600) * 1000;
    if (!(windowMs > 0) || now >= buyAtMs + windowMs) continue;
    return {
      market: record.address,
      question: record.question,
      buyAt: record.buyAt,
      until: new Date(buyAtMs + windowMs).toISOString(),
      pollMs: Math.max(250, Number(autoSell.autoSellPriceHotPollMs ?? 1000))
    };
  }
  return null;
}

function loadAutoSellBuyRecords(cfg) {
  const file = cfg?.fillsFile;
  if (!file || !fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  const cacheKey = `${stat.mtimeMs}:${stat.size}:${cfg.autoSellEligibleTailBytes}`;
  const cached = autoSellBuyRecordsCache.get(file);
  if (cached?.cacheKey === cacheKey) return cached.records;

  const applyAfterMs = cfg.autoSellApplyAfterIso ? Date.parse(cfg.autoSellApplyAfterIso) : 0;
  const recordsByMarket = new Map();
  for (const row of readJsonlTailRows(file, cfg.autoSellEligibleTailBytes)) {
    const buyAtMs = Date.parse(row?.at ?? "");
    if (!Number.isFinite(buyAtMs) || buyAtMs < applyAfterMs || !isSuccessfulBuyFill(row)) continue;
    for (const record of boughtMarketRecordsFromFill(row)) {
      const key = String(record.address ?? "").toLowerCase();
      if (!key) continue;
      const existing = recordsByMarket.get(key);
      if (!existing || Date.parse(existing.buyAt) < buyAtMs) {
        recordsByMarket.set(key, { ...record, buyAt: new Date(buyAtMs).toISOString() });
      }
    }
  }
  const records = [...recordsByMarket.values()];
  autoSellBuyRecordsCache.set(file, { cacheKey, records });
  return records;
}

function boughtMarketRecordsFromFill(row) {
  if (row?.plan?.market?.address) {
    return [{ address: row.plan.market.address, question: row.plan.market.question ?? null }];
  }
  if (Array.isArray(row?.bundle?.markets)) {
    return row.bundle.markets
      .map((market) => ({ address: market?.address, question: market?.question ?? null }))
      .filter((market) => market.address);
  }
  if (row?.context?.market) {
    return [{ address: row.context.market, question: row.context.question ?? null }];
  }
  if (Array.isArray(row?.context?.markets)) {
    return row.context.markets
      .map((market) => typeof market === "string"
        ? { address: market, question: row.context.question ?? null }
        : { address: market?.address, question: market?.question ?? row.context.question ?? null })
      .filter((market) => market.address);
  }
  return [];
}

function startAutoSellMonitor(cfg, runtime = null) {
  if (!cfg.autoSellEnabled) return null;
  const seen = loadSeen(cfg.autoSellStateFile);
  let running = false;
  let lastTickStartedAt = 0;
  let consecutiveTransientPositionsErrors = 0;

  const tick = async ({ force = false } = {}) => {
    if (running) return;
    const now = Date.now();
    const desiredPollMs = autoSellMonitorDesiredPollMs(cfg, now);
    if (!force && lastTickStartedAt > 0 && now - lastTickStartedAt < desiredPollMs) return;
    running = true;
    lastTickStartedAt = now;
    markAutoSellHealthStarted(runtime, new Date(now).toISOString());
    try {
      const result = await runAutoSellOnce(cfg, {
        seen,
        runtime,
        source: "monitor"
      });
      markAutoSellHealthCompleted(runtime, result);
      if (result.transientPositionsError) {
        consecutiveTransientPositionsErrors += 1;
        console.warn(JSON.stringify({
          level: "event-auto-sell-transient",
          source: "monitor",
          reason: result.skippedReason,
          consecutive: consecutiveTransientPositionsErrors,
          message: result.transientPositionsError.message,
          at: new Date().toISOString()
        }));
        if (
          consecutiveTransientPositionsErrors >= AUTO_SELL_TRANSIENT_POSITIONS_ALERT_AFTER &&
          consecutiveTransientPositionsErrors % AUTO_SELL_TRANSIENT_POSITIONS_ALERT_AFTER === 0
        ) {
          notifyFeishu(cfg, {
            title: "持仓接口连续异常",
            level: "warn",
            fields: {
              status: "自动卖出等待持仓接口恢复",
              message: result.transientPositionsError.message,
              action: "接口恢复后自动继续",
              retryMs: cfg.autoSellPollMs
            },
            dedupeKey: "auto-sell-positions-transient",
            cooldownMs: cfg.autoSellAlertCooldownMs,
            fingerprint: `positions-transient:${result.transientPositionsError.message}`,
            repeatMs: 0
          });
        }
        return;
      }
      if (consecutiveTransientPositionsErrors > 0) {
        console.log(JSON.stringify({
          level: "event-auto-sell-transient-recovered",
          source: "monitor",
          consecutive: consecutiveTransientPositionsErrors,
          at: new Date().toISOString()
        }));
        consecutiveTransientPositionsErrors = 0;
      }
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
      markAutoSellHealthError(runtime, message);
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

  const timer = setInterval(tick, autoSellMonitorSchedulerMs(cfg));
  void tick({ force: true });
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
    disabled: 0,
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

  let openPositions;
  try {
    openPositions = await fetchOpenPositions(cfg, {
      user: walletAddress,
      limit: cfg.autoSellPositionLimit
    });
  } catch (error) {
    const message = autoSellErrorMessage(cfg, error);
    if (source === "monitor" && isTransientPositionsFetchErrorMessage(message)) {
      result.skipped += 1;
      result.skippedReason = "positions-fetch-transient-error";
      result.transientPositionsError = { message };
      return result;
    }
    throw error;
  }
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
    const autoSellCfg = autoSellConfigForPosition(cfg, position);
    if (!isAutoSellEnabledForPosition(autoSellCfg)) {
      result.skipped += 1;
      result.disabled += 1;
      continue;
    }

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

      const action = await buildAutoSellAction(
        autoSellCfg,
        publicClient,
        walletAddress,
        position,
        entry,
        now,
        autoSellOperatorApprovalHint(runtime, position.marketAddress)
      );
      if (!action) continue;

      result.triggered += 1;
      allItems.push({ key, entry, position, autoSellCfg, ...action });
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

  const allActions = allItems.map(({ plan, entry, position, autoSellCfg, ...action }) => ({
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
  const retainedNoSellItems = [];
  for (let index = 0; index < allItems.length; index += 1) {
    const item = allItems[index];
    const action = allActions[index];
    if (item.noSell) {
      action.status = "retained-to-settlement";
      retainedNoSellItems.push({ item, action });
      continue;
    }
    if (cfg.autoSellRequirePreapprovedOperator && !item.plan.operatorApproved) {
      action.status = "skipped-operator-approval-needed";
      waitingForApproval.push(action);
      continue;
    }
    readyItems.push({ item, action });
  }
  if (retainedNoSellItems.length > 0) {
    for (const { item } of retainedNoSellItems) {
      markAutoSellActionApplied(item.autoSellCfg ?? cfg, item.entry, item);
    }
    saveAutoSellPositionState(cfg.autoSellPositionStateFile, ladderState);
    const actions = retainedNoSellItems.map(({ action }) => action);
    result.executed += actions.length;
    result.actions.push(...actions);
    appendAutoSellBatchLog(cfg, {
      source,
      walletAddress,
      markets: marketsFromItems(retainedNoSellItems.map(({ item }) => item)),
      actions,
      execution: { status: "retained-to-settlement", txHash: null }
    });
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
          autoSellExecutionConfigForItems(cfg, items),
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
        for (const item of items) markAutoSellActionApplied(item.autoSellCfg ?? cfg, item.entry, item);
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
  const candidates = autoSellOperatorPreapprovalCandidates(cfg, { openPositions, eligibleMarkets, runtime });
  const markets = candidates.markets;
  if (candidates.disabled > 0) result.operatorApprovalDisabled = (result.operatorApprovalDisabled ?? 0) + candidates.disabled;

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
      await appendGasLedgerFromExecution(cfg, execution, {
        action: "approval",
        source: "operator-preapproval",
        allocations: [{ market, action: "approval", weight: 1 }]
      });
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

function autoSellOperatorPreapprovalCandidates(cfg, { openPositions = [], eligibleMarkets = new Map(), runtime = null } = {}) {
  const markets = [];
  const seenMarkets = new Set();
  let disabled = 0;
  for (const position of openPositions) {
    if (!isAutoSellablePosition(position)) continue;
    const marketKey = String(position.marketAddress).toLowerCase();
    if (!eligibleMarkets.has(marketKey) || seenMarkets.has(marketKey)) continue;
    if (runtime?.autoSellOperatorReadyMarkets?.has(marketKey)) continue;
    const autoSellCfg = autoSellConfigForPosition(cfg, position);
    if (!isAutoSellEnabledForPosition(autoSellCfg)) {
      seenMarkets.add(marketKey);
      disabled += 1;
      continue;
    }
    seenMarkets.add(marketKey);
    markets.push(position.marketAddress);
  }
  return { markets, disabled };
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

function autoSellConfigForPosition(cfg, position) {
  const planned = plannedBuyAutoSellForMarket(cfg, {
    address: position?.marketAddress,
    question: position?.question?.title
  });
  if (!planned?.autoSell) return cfg;
  const merged = {
    ...cfg,
    ...planned.autoSell,
    plannedAutoSellOverride: {
      id: planned.id,
      market: planned.market,
      question: planned.question
    }
  };
  const retainPosition = autoSellRetainPositionForPosition(merged, position);
  if (retainPosition) merged.autoSellRetainPosition = retainPosition;
  return merged;
}

function autoSellRetainPositionForPosition(cfg, position) {
  const rows = Array.isArray(cfg?.autoSellRetainPositions) ? cfg.autoSellRetainPositions : [];
  if (rows.length === 0) return null;
  const outcomeKey = normalizePlannedBuyOutcomeName(position?.outcome?.name);
  if (!outcomeKey) return null;
  return rows.find((row) => normalizePlannedBuyOutcomeName(row?.outcome) === outcomeKey) ?? null;
}

function autoSellExecutionConfigForItems(cfg, items) {
  const configs = items.map((item) => item.autoSellCfg).filter(Boolean);
  if (configs.length === 0) return cfg;
  const gasPriceGwei = configs.find((item) => item.autoSellGasPriceGwei)?.autoSellGasPriceGwei ?? cfg.autoSellGasPriceGwei;
  return {
    ...cfg,
    autoSellGasPriceGwei: gasPriceGwei
  };
}

function rpcOnlyAutoSellBroadcastConfig(cfg) {
  return {
    ...cfg,
    builderBundleEnabled: false,
    builderBundleRequestedEnabled: false,
    builderBundleKillSwitch: true,
    builderTimedBuyExecutorEnabled: false,
    builderTimestampGuardEnabled: false
  };
}

function isAutoSellEnabledForPosition(cfg) {
  if (cfg?.autoSellEnabled === false) return false;
  const strategy = String(cfg?.autoSellStrategy ?? "").trim().toLowerCase();
  return !["hold_to_settlement", "hold", "disabled", "off", "none"].includes(strategy);
}

function autoSellOperatorApprovalHint(runtime, marketAddress) {
  const marketKey = String(marketAddress ?? "").toLowerCase();
  if (!marketKey) return undefined;
  return runtime?.autoSellOperatorReadyMarkets?.has(marketKey) ? true : undefined;
}

async function buildAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved) {
  if (cfg.autoSellStrategy === "open_timed_exit") {
    return buildOpenTimedExitAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved);
  }
  if (cfg.autoSellStrategy === "pre_start_exit") {
    return buildPreStartExitAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved);
  }
  return buildLadderAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved);
}

async function buildOpenTimedExitAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved) {
  const dueAt = autoSellOpenExitDueAt(cfg, position);
  if (dueAt === null) return null;
  const due = now >= dueAt;
  const priceTarget = autoSellPriceTargetForPosition(cfg, position, entry);
  if (!due && priceTarget?.reached) {
    const percent = Number(cfg.autoSellPriceSellPercent ?? 100);
    const plan = await buildDirectSellPlan(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      percent
    });
    return {
      plan,
      trigger: "price_target",
      triggerLabel: "价格止盈",
      percent,
      step: entry.nextStep,
      openTimedExitDueAt: new Date(dueAt).toISOString(),
      sellAmountOt: formatUnits(plan.amount, 18),
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      currentPrice: priceTarget.currentPrice,
      targetPrice: priceTarget.targetPrice,
      priceSource: "42_rest_positions",
      costBasisUsdt: roundUsd(Number(position?.costBasis ?? 0)),
      remainingCostBasisUsdt: roundUsd(autoSellRemainingCostBasisUsdt(position, entry, Number(position?.costBasis ?? 0))),
      fullExitValueUsdt: null,
      profitPercent: null,
      lossPercent: null,
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: null,
      txHash: null
    };
  }
  const takeProfitDue = autoSellPriceTargetsEnabled(cfg)
    ? false
    : autoSellOpenTimedTakeProfitDue(cfg, entry, now, dueAt);
  const quoteState = cfg.autoSellStopLossEnabled || takeProfitDue
    ? await quoteAutoSellReturnState(cfg, publicClient, walletAddress, position, entry, operatorApproved)
    : defaultAutoSellReturnState(position);

  if (
    quoteState.quote &&
    cfg.autoSellStopLossEnabled &&
    quoteState.lossPercent !== null &&
    quoteState.lossPercent >= cfg.autoSellStopLossPercent
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
      costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
      remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
      fullExitValueUsdt: roundUsd(quoteState.fullExitValueUsdt),
      profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
      lossPercent: roundUsd(quoteState.lossPercent),
      stopLossPercent: cfg.autoSellStopLossPercent,
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: quoteState.quoteError,
      txHash: null
    };
  }

  if (takeProfitDue && isAutoSellLadderProfitReady(cfg, quoteState.profitPercent)) {
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
      triggerLabel: "止盈",
      percent: cfg.autoSellChunkPercent,
      step: entry.nextStep,
      totalSteps: autoSellTotalSteps(cfg),
      dueAt: new Date(autoSellStepDueAt(cfg, entry)).toISOString(),
      openTimedExitDueAt: new Date(dueAt).toISOString(),
      sellAmountOt: formatUnits(plan.amount, 18),
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
      remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
      fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
      profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
      ladderProfitPercent: cfg.autoSellLadderProfitPercent,
      lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: quoteState.quoteError,
      txHash: null
    };
  }

  if (!due) return null;

  const percent = Number(cfg.autoSellOpenExitPercent ?? 100);
  const plan = await buildDirectSellPlan(publicClient, {
    market: position.marketAddress,
    tokenId: position.tokenId,
    owner: walletAddress,
    percent
  });
  return {
    plan,
    trigger: "open_timed_exit",
    triggerLabel: "开盘定时卖出",
    percent,
    step: entry.nextStep,
    dueAt: new Date(dueAt).toISOString(),
    marketOpenDate: autoSellMarketOpenDate(position),
    delaySeconds: cfg.autoSellOpenExitDelaySeconds,
    sellAmountOt: formatUnits(plan.amount, 18),
    marketAddress: position.marketAddress,
    tokenId: String(position.tokenId),
    question: position.question?.title ?? null,
    outcome: position.outcome?.name ?? null,
    costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
    remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
    fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
    profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
    lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
    minCollateralOutUsdt: "0.000000000000000001",
    noPriceProtection: true,
    quoteError: quoteState.quoteError,
    txHash: null
  };
}

function autoSellPriceTargetsEnabled(cfg) {
  return Array.isArray(cfg?.autoSellPriceTargets) && cfg.autoSellPriceTargets.some((target) => target?.enabled !== false);
}

function autoSellPriceTargetForPosition(cfg, position, entry) {
  if (!autoSellPriceTargetsEnabled(cfg)) return null;
  const buyAtMs = Date.parse(entry?.buyAt ?? "");
  const applyAfterMs = Date.parse(cfg.autoSellPriceApplyAfterIso ?? "");
  if (Number.isFinite(applyAfterMs) && (!Number.isFinite(buyAtMs) || buyAtMs < applyAfterMs)) return null;
  const outcomeKey = normalizePlannedBuyOutcomeName(position?.outcome?.name);
  const target = cfg.autoSellPriceTargets.find((item) => (
    item?.enabled !== false && normalizePlannedBuyOutcomeName(item?.outcome) === outcomeKey
  ));
  if (!target) return null;
  const currentPrice = Number(position?.curPrice);
  const targetPrice = Number(target.price);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  return {
    outcome: target.outcome,
    currentPrice,
    targetPrice,
    reached: currentPrice >= targetPrice
  };
}

function autoSellOpenTimedTakeProfitDue(cfg, entry, now, openExitDueAt) {
  if (entry?.takeProfitCompleted) return false;
  if (!autoSellLadderProfitGateEnabled(cfg)) return false;
  if (Number(cfg.autoSellChunkPercent ?? 0) <= 0) return false;
  if (openExitDueAt !== null && now >= openExitDueAt) return false;
  return now >= autoSellStepDueAt(cfg, entry);
}

function retainedAutoSellFields(retained, plan = null) {
  const sellAmountOt = plan ? formatUnits(plan.amount, 18) : "0";
  return {
    retainedToSettlement: true,
    retainOutcome: retained.outcome,
    retainPercent: retained.retainPercent,
    retainedTargetOt: retained.retainedTargetOt,
    currentSizeOt: retained.currentSizeOt,
    remainingAfterSellOt: plan
      ? autoSellRemainingAfterSellOt(retained.currentSizeOt, plan.amount)
      : retained.remainingAfterSellOt,
    sellAmountOt
  };
}

async function buildPreStartExitAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved) {
  const preStartDueAt = autoSellPreStartDueAt(cfg, position);
  const preStartDue = preStartDueAt !== null && now >= preStartDueAt;
  const retainedPosition = resolveAutoSellRetainedPosition(cfg, entry, position);
  const quoteState = cfg.autoSellStopLossEnabled
    ? await quoteAutoSellReturnState(cfg, publicClient, walletAddress, position, entry, operatorApproved)
    : defaultAutoSellReturnState(position);
  if (
    quoteState.quote &&
    cfg.autoSellStopLossEnabled &&
    quoteState.lossPercent !== null &&
    quoteState.lossPercent >= cfg.autoSellStopLossPercent
  ) {
    if (retainedPosition) {
      if (!retainedPosition.shouldSell) {
        if (!preStartDue) return null;
        const marketStartDate = autoSellMarketStartDate(cfg, position);
        return {
          noSell: true,
          trigger: "retained_to_settlement",
          triggerLabel: "留仓到结算",
          percent: 0,
          step: entry.nextStep,
          dueAt: new Date(preStartDueAt).toISOString(),
          marketStartDate,
          beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
          marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
          marketAddress: position.marketAddress,
          tokenId: String(position.tokenId),
          question: position.question?.title ?? null,
          outcome: position.outcome?.name ?? null,
          costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
          remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
          fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
          profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
          lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
          quoteError: quoteState.quoteError,
          txHash: null,
          ...retainedAutoSellFields(retainedPosition)
        };
      }
      const plan = await buildDirectSellPlan(publicClient, {
        market: position.marketAddress,
        tokenId: position.tokenId,
        owner: walletAddress,
        amountOt: retainedPosition.sellAmountOt
      });
      return {
        plan,
        trigger: "stop_loss_retained_exit",
        triggerLabel: "止损留仓卖出",
        percent: null,
        step: entry.nextStep,
        dueAt: preStartDueAt === null ? null : new Date(preStartDueAt).toISOString(),
        marketAddress: position.marketAddress,
        tokenId: String(position.tokenId),
        question: position.question?.title ?? null,
        outcome: position.outcome?.name ?? null,
        costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
        remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
        fullExitValueUsdt: roundUsd(quoteState.fullExitValueUsdt),
        profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
        lossPercent: roundUsd(quoteState.lossPercent),
        stopLossPercent: cfg.autoSellStopLossPercent,
        minCollateralOutUsdt: "0.000000000000000001",
        noPriceProtection: true,
        quoteError: quoteState.quoteError,
        txHash: null,
        ...retainedAutoSellFields(retainedPosition, plan)
      };
    }
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
      dueAt: preStartDueAt === null ? null : new Date(preStartDueAt).toISOString(),
      sellAmountOt: formatUnits(plan.amount, 18),
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
      remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
      fullExitValueUsdt: roundUsd(quoteState.fullExitValueUsdt),
      profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
      lossPercent: roundUsd(quoteState.lossPercent),
      stopLossPercent: cfg.autoSellStopLossPercent,
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: quoteState.quoteError,
      txHash: null
    };
  }

  if (!preStartDue) return null;

  const marketStartDate = autoSellMarketStartDate(cfg, position);
  if (retainedPosition) {
    if (!retainedPosition.shouldSell) {
      return {
        noSell: true,
        trigger: "retained_to_settlement",
        triggerLabel: "留仓到结算",
        percent: 0,
        step: entry.nextStep,
        dueAt: new Date(preStartDueAt).toISOString(),
        marketStartDate,
        beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
        marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
        marketAddress: position.marketAddress,
        tokenId: String(position.tokenId),
        question: position.question?.title ?? null,
        outcome: position.outcome?.name ?? null,
        costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
        remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
        fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
        profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
        lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
        quoteError: quoteState.quoteError,
        txHash: null,
        ...retainedAutoSellFields(retainedPosition)
      };
    }
    const plan = await buildDirectSellPlan(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      amountOt: retainedPosition.sellAmountOt
    });
    return {
      plan,
      trigger: "pre_start_retained_exit",
      triggerLabel: "赛前留仓卖出",
      percent: null,
      step: entry.nextStep,
      dueAt: new Date(preStartDueAt).toISOString(),
      marketStartDate,
      beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
      marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
      remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
      fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
      profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
      lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: quoteState.quoteError,
      txHash: null,
      ...retainedAutoSellFields(retainedPosition, plan)
    };
  }
  const plan = await buildDirectSellPlan(publicClient, {
    market: position.marketAddress,
    tokenId: position.tokenId,
    owner: walletAddress,
    percent: 100
  });
  return {
    plan,
    trigger: "pre_start_exit",
    triggerLabel: "赛前清仓",
    percent: 100,
    step: entry.nextStep,
    dueAt: new Date(preStartDueAt).toISOString(),
    marketStartDate,
    beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
    marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
    sellAmountOt: formatUnits(plan.amount, 18),
    marketAddress: position.marketAddress,
    tokenId: String(position.tokenId),
    question: position.question?.title ?? null,
    outcome: position.outcome?.name ?? null,
    costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
    remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
    fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
    profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
    lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
    minCollateralOutUsdt: "0.000000000000000001",
    noPriceProtection: true,
    quoteError: quoteState.quoteError,
    txHash: null
  };
}

async function buildLadderAutoSellAction(cfg, publicClient, walletAddress, position, entry, now, operatorApproved) {
  const dueAt = autoSellStepDueAt(cfg, entry);
  const due = now >= dueAt;
  const preStartDueAt = autoSellPreStartDueAt(cfg, position);
  const preStartDue = preStartDueAt !== null && now >= preStartDueAt;
  const retainedPosition = resolveAutoSellRetainedPosition(cfg, entry, position);
  const profitGateNeedsQuote = !entry.takeProfitCompleted && due && autoSellLadderProfitGateEnabled(cfg);
  const quoteState = cfg.autoSellStopLossEnabled || profitGateNeedsQuote
    ? await quoteAutoSellReturnState(cfg, publicClient, walletAddress, position, entry, operatorApproved)
    : defaultAutoSellReturnState(position);
  if (
    quoteState.quote &&
    cfg.autoSellStopLossEnabled &&
    quoteState.lossPercent !== null &&
    quoteState.lossPercent >= cfg.autoSellStopLossPercent
  ) {
    if (retainedPosition) {
      if (!retainedPosition.shouldSell) {
        if (!preStartDue) return null;
        const marketStartDate = autoSellMarketStartDate(cfg, position);
        return {
          noSell: true,
          trigger: "retained_to_settlement",
          triggerLabel: "留仓到结算",
          percent: 0,
          step: entry.nextStep,
          dueAt: new Date(preStartDueAt).toISOString(),
          marketStartDate,
          beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
          marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
          marketAddress: position.marketAddress,
          tokenId: String(position.tokenId),
          question: position.question?.title ?? null,
          outcome: position.outcome?.name ?? null,
          costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
          remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
          fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
          profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
          lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
          quoteError: quoteState.quoteError,
          txHash: null,
          ...retainedAutoSellFields(retainedPosition)
        };
      }
      const plan = await buildDirectSellPlan(publicClient, {
        market: position.marketAddress,
        tokenId: position.tokenId,
        owner: walletAddress,
        amountOt: retainedPosition.sellAmountOt
      });
      return {
        plan,
        trigger: "stop_loss_retained_exit",
        triggerLabel: "止损留仓卖出",
        percent: null,
        step: entry.nextStep,
        dueAt: new Date(dueAt).toISOString(),
        marketAddress: position.marketAddress,
        tokenId: String(position.tokenId),
        question: position.question?.title ?? null,
        outcome: position.outcome?.name ?? null,
        costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
        remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
        fullExitValueUsdt: roundUsd(quoteState.fullExitValueUsdt),
        profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
        lossPercent: roundUsd(quoteState.lossPercent),
        stopLossPercent: cfg.autoSellStopLossPercent,
        minCollateralOutUsdt: "0.000000000000000001",
        noPriceProtection: true,
        quoteError: quoteState.quoteError,
        txHash: null,
        ...retainedAutoSellFields(retainedPosition, plan)
      };
    }
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
      costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
      remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
      fullExitValueUsdt: roundUsd(quoteState.fullExitValueUsdt),
      profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
      lossPercent: roundUsd(quoteState.lossPercent),
      stopLossPercent: cfg.autoSellStopLossPercent,
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: quoteState.quoteError,
      txHash: null
    };
  }

  if (preStartDue) {
    const marketStartDate = autoSellMarketStartDate(cfg, position);
    if (retainedPosition) {
      if (!retainedPosition.shouldSell) {
        return {
          noSell: true,
          trigger: "retained_to_settlement",
          triggerLabel: "留仓到结算",
          percent: 0,
          step: entry.nextStep,
          dueAt: new Date(preStartDueAt).toISOString(),
          marketStartDate,
          beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
          marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
          marketAddress: position.marketAddress,
          tokenId: String(position.tokenId),
          question: position.question?.title ?? null,
          outcome: position.outcome?.name ?? null,
          costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
          remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
          fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
          profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
          lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
          quoteError: quoteState.quoteError,
          txHash: null,
          ...retainedAutoSellFields(retainedPosition)
        };
      }
      const plan = await buildDirectSellPlan(publicClient, {
        market: position.marketAddress,
        tokenId: position.tokenId,
        owner: walletAddress,
        amountOt: retainedPosition.sellAmountOt
      });
      return {
        plan,
        trigger: "pre_start_retained_exit",
        triggerLabel: "赛前留仓卖出",
        percent: null,
        step: entry.nextStep,
        dueAt: new Date(preStartDueAt).toISOString(),
        marketStartDate,
        beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
        marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
        marketAddress: position.marketAddress,
        tokenId: String(position.tokenId),
        question: position.question?.title ?? null,
        outcome: position.outcome?.name ?? null,
        costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
        remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
        fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
        profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
        lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
        minCollateralOutUsdt: "0.000000000000000001",
        noPriceProtection: true,
        quoteError: quoteState.quoteError,
        txHash: null,
        ...retainedAutoSellFields(retainedPosition, plan)
      };
    }
    const plan = await buildDirectSellPlan(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      percent: 100
    });
    return {
      plan,
      trigger: "pre_start_exit",
      triggerLabel: "赛前清仓",
      percent: 100,
      step: entry.nextStep,
      dueAt: new Date(preStartDueAt).toISOString(),
      marketStartDate,
      beforeMarketStartSeconds: cfg.autoSellBeforeMarketStartSeconds,
      marketStartEndOffsetSeconds: cfg.autoSellMarketStartEndOffsetSeconds,
      sellAmountOt: formatUnits(plan.amount, 18),
      marketAddress: position.marketAddress,
      tokenId: String(position.tokenId),
      question: position.question?.title ?? null,
      outcome: position.outcome?.name ?? null,
      costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
      remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
      fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
      profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
      lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
      minCollateralOutUsdt: "0.000000000000000001",
      noPriceProtection: true,
      quoteError: quoteState.quoteError,
      txHash: null
    };
  }

  if (entry.takeProfitCompleted) return null;
  if (!due) return null;
  if (!isAutoSellLadderProfitReady(cfg, quoteState.profitPercent)) return null;

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
    costBasisUsdt: roundUsd(quoteState.costBasisUsdt),
    remainingCostBasisUsdt: roundUsd(quoteState.remainingCostBasisUsdt),
    fullExitValueUsdt: quoteState.fullExitValueUsdt === null ? null : roundUsd(quoteState.fullExitValueUsdt),
    profitPercent: quoteState.profitPercent === null ? null : roundUsd(quoteState.profitPercent),
    ladderProfitPercent: cfg.autoSellLadderProfitPercent,
    lossPercent: quoteState.lossPercent === null ? null : roundUsd(quoteState.lossPercent),
    minCollateralOutUsdt: "0.000000000000000001",
    noPriceProtection: true,
    quoteError: quoteState.quoteError,
    txHash: null
  };
}

function appendAutoSellBatchLog(cfg, { source, walletAddress, market = null, markets = null, actions, execution }) {
  appendGasLedgerFromExecution(cfg, execution, {
    action: "sell",
    source: `auto-sell:${source}`,
    wallet: walletAddress,
    allocations: gasAllocationsFromAutoSellActions(actions)
  });
  if (execution?.approval) {
    appendGasLedgerFromExecution(cfg, execution.approval, {
      action: "approval",
      source: `auto-sell-approval:${source}`,
      wallet: walletAddress,
      allocations: [{
        market: execution.approval.market ?? market ?? markets?.[0],
        action: "approval",
        weight: 1
      }]
    });
  }
  for (const approval of execution?.approvals ?? []) {
    appendGasLedgerFromExecution(cfg, approval, {
      action: "approval",
      source: `auto-sell-approval:${source}`,
      wallet: walletAddress,
      txHashKey: "operatorApprovalHash",
      fieldPrefix: "operatorApproval",
      allocations: [{ market: approval.market, action: "approval", weight: 1 }]
    });
  }
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

async function appendGasLedgerFromReceipt(cfg, publicClient, {
  txHash,
  receipt,
  action,
  source,
  wallet = "",
  allocations = [],
  extraFeeWei = null,
  extraFeeBnb = null,
  metadata = {}
} = {}) {
  try {
    const blockNumber = receipt?.blockNumber !== undefined && receipt?.blockNumber !== null
      ? BigInt(receipt.blockNumber)
      : null;
    const [transaction, block] = await Promise.all([
      publicClient.getTransaction({ hash: txHash }).catch(() => null),
      receipt?.blockHash
        ? publicClient.getBlock({ blockHash: receipt.blockHash }).catch(() => (
          blockNumber ? publicClient.getBlock({ blockNumber }).catch(() => null) : null
        ))
        : blockNumber
          ? publicClient.getBlock({ blockNumber }).catch(() => null)
          : Promise.resolve(null)
    ]);
    const priceInfo = await bnbUsdtPriceForBlock(block).catch((error) => ({
      price: null,
      source: null,
      error: errorMessage(error)
    }));
    const entry = buildGasLedgerEntry({
      txHash,
      receipt,
      transaction,
      block,
      profile: cfg.botName,
      source,
      action,
      wallet,
      allocations,
      bnbUsdtPrice: priceInfo?.price ?? null,
      bnbUsdtSource: priceInfo?.source ?? "",
      extraFeeWei,
      extraFeeBnb,
      metadata: {
        ...metadata,
        priceError: priceInfo?.error ?? null
      }
    });
    appendGasLedgerEntries(cfg.gasLedgerFile, [entry]);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "gas-ledger-write-error",
      source,
      txHash,
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
  }
}

async function appendGasLedgerFromExecution(cfg, execution, {
  action,
  source,
  wallet = "",
  allocations = [],
  txHashKey = "txHash",
  fieldPrefix = "",
  metadata = {}
} = {}) {
  const txHash = execution?.[txHashKey];
  const gasUsedKey = fieldPrefix ? `${fieldPrefix}GasUsed` : "gasUsed";
  const effectiveGasPriceKey = fieldPrefix ? `${fieldPrefix}EffectiveGasPrice` : "effectiveGasPrice";
  const gasUsed = execution?.[gasUsedKey];
  const effectiveGasPrice = execution?.[effectiveGasPriceKey];
  if (!txHash || !gasUsed || !effectiveGasPrice) return;
  try {
    const { publicClient } = makeClients(cfg);
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
    const transaction = await publicClient.getTransaction({ hash: txHash }).catch(() => null);
    const blockHash = receipt?.blockHash;
    const blockNumber = receipt?.blockNumber ?? execution?.blockNumber;
    const block = blockHash
      ? await publicClient.getBlock({ blockHash }).catch(() => null)
      : blockNumber ? await publicClient.getBlock({ blockNumber: BigInt(blockNumber) }).catch(() => null) : null;
    const priceInfo = await bnbUsdtPriceForBlock(block).catch((error) => ({
      price: null,
      source: null,
      error: errorMessage(error)
    }));
    const entry = buildGasLedgerEntry({
      txHash,
      receipt: receipt ?? {
        status: execution.status ?? null,
        blockNumber: execution.blockNumber ?? null,
        transactionIndex: execution.transactionIndex ?? null,
        gasUsed,
        effectiveGasPrice
      },
      transaction,
      block,
      profile: cfg.botName,
      source,
      action,
      wallet,
      allocations,
      bnbUsdtPrice: priceInfo?.price ?? null,
      bnbUsdtSource: priceInfo?.source ?? "",
      metadata: {
        ...metadata,
        priceError: priceInfo?.error ?? null
      }
    });
    appendGasLedgerEntries(cfg.gasLedgerFile, [entry]);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "gas-ledger-write-error",
      source,
      txHash,
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
  }
}

function gasAllocationsFromEventPlan(plan) {
  const market = plan?.market ?? {};
  const fallbackStake = Number(plan?.stakePerOutcomeUsdt ?? 0);
  return (plan?.outcomes ?? []).map((outcome) => {
    const stake = Number(outcome?.stakeUsdt ?? fallbackStake);
    return {
      market: market.address,
      question: market.question,
      tokenId: outcome.tokenId,
      outcome: outcome.name,
      action: "buy",
      amountUsdt: Number.isFinite(stake) && stake > 0 ? stake : null,
      weight: Number.isFinite(stake) && stake > 0 ? stake : 1
    };
  });
}

function gasAllocationsFromBundle(bundle) {
  return (bundle?.markets ?? []).map((market) => {
    const amount = Number(market.totalStakeUsdt ?? market.stakeUsdt ?? market.totalStake ?? 0);
    return {
      market: market.address,
      question: market.question,
      action: "buy",
      amountUsdt: Number.isFinite(amount) && amount > 0 ? amount : null,
      weight: Number.isFinite(amount) && amount > 0 ? amount : 1
    };
  });
}

function gasAllocationsFromReceiptContext(context = {}) {
  if (context.type === "bundle") {
    return (context.marketDetails ?? []).map((market) => ({
      market: market.address,
      question: market.question,
      action: "buy",
      weight: 1
    }));
  }
  return [{
    market: context.market,
    question: context.question,
    action: "buy",
    weight: 1
  }];
}

function gasAllocationsFromAutoSellActions(actions = []) {
  return (actions ?? []).map((action) => ({
    market: action.marketAddress ?? action.market,
    question: action.question,
    tokenId: action.tokenId,
    outcome: action.outcome,
    action: "sell",
    weight: Number(action.expectedCollateralToUserUsdt ?? action.fullExitValueUsdt ?? 0) || 1
  }));
}

function gasAllocationsFromSellItem(item = {}) {
  const position = item.position ?? {};
  const plan = item.plan ?? {};
  const expectedCollateral = plan.expectedCollateralToUser !== undefined && plan.expectedCollateralToUser !== null
    ? Number(formatUnits(BigInt(plan.expectedCollateralToUser), 18))
    : Number(position.currentValue ?? position.value ?? 0);
  return [{
    market: position.marketAddress ?? plan.market,
    question: position.question?.title ?? position.question ?? null,
    tokenId: position.tokenId ?? plan.tokenId,
    outcome: position.outcome?.name ?? position.outcome ?? null,
    action: "sell",
    amountUsdt: Number.isFinite(expectedCollateral) && expectedCollateral > 0 ? expectedCollateral : null,
    weight: Number.isFinite(expectedCollateral) && expectedCollateral > 0 ? expectedCollateral : 1
  }];
}

function markAutoSellActionApplied(cfg, entry, item) {
  const appliedAt = new Date().toISOString();
  entry.lastTrigger = item.trigger;
  if (
    item.noSell ||
    item.trigger === "retained_to_settlement" ||
    item.trigger === "pre_start_retained_exit" ||
    item.trigger === "stop_loss_retained_exit"
  ) {
    if (!item.noSell) entry.lastSoldAt = appliedAt;
    entry.lastRetainedAt = appliedAt;
    entry.retainedToSettlement = true;
    entry.retainPercent = item.retainPercent ?? null;
    entry.retainedTargetSize = item.retainedTargetOt ?? null;
    entry.currentSizeBeforeRetain = item.currentSizeOt ?? null;
    entry.retainedSellAmount = item.sellAmountOt ?? "0";
    entry.retainedReason = item.trigger;
    entry.remainingSize = String(item.remainingAfterSellOt ?? item.retainedTargetOt ?? entry.remainingSize ?? "0");
    if (item.trigger === "pre_start_retained_exit" || item.trigger === "retained_to_settlement") {
      entry.preStartExitHandled = true;
      if (item.trigger === "pre_start_retained_exit") entry.preStartSold = true;
    }
    if (item.trigger === "stop_loss_retained_exit") entry.stopLossSold = true;
    entry.completed = true;
    return;
  }
  entry.lastSoldAt = appliedAt;
  if (
    item.trigger === "stop_loss" ||
    item.trigger === "price_target" ||
    item.trigger === "pre_start_exit" ||
    item.trigger === "open_timed_exit" ||
    item.trigger === "fast_open_timed_exit"
  ) {
    if (item.trigger === "stop_loss") entry.stopLossSold = true;
    if (item.trigger === "price_target") entry.priceTargetSold = true;
    if (item.trigger === "pre_start_exit") entry.preStartSold = true;
    if (item.trigger === "open_timed_exit" || item.trigger === "fast_open_timed_exit") entry.openTimedExitSold = true;
    entry.remainingSize = "0";
    entry.completed = true;
    return;
  }
  updateAutoSellRemainingSize(entry, item);
  entry.nextStep = Number(entry.nextStep ?? 1) + 1;
  const takeProfitSteps = autoSellTakeProfitSteps(cfg);
  if (takeProfitSteps > 0 && entry.nextStep > takeProfitSteps) {
    entry.takeProfitCompleted = true;
    if (!cfg.autoSellBeforeMarketStartSeconds) entry.completed = true;
    return;
  }
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
      initialCostBasisUsdt: String(position.costBasis ?? "0"),
      remainingSize: String(position.size ?? "0"),
      nextStep: 1,
      completed: false,
      stopLossSold: false,
      priceTargetSold: false,
      takeProfitCompleted: false,
      preStartSold: false,
      openTimedExitSold: false,
      retainedToSettlement: false,
      retainedTargetSize: null,
      retainedSellAmount: null,
      retainPercent: null,
      preStartExitHandled: false
    };
  }
  return state.positions[key];
}

function updateAutoSellRemainingSize(entry, item) {
  const current = autoSellNumber(entry?.remainingSize ?? entry?.initialSize);
  const sold = autoSellNumber(item?.sellAmountOt);
  if (!(current >= 0) || !(sold > 0)) return;
  entry.remainingSize = String(Math.max(0, current - sold));
}

function autoSellAmountUnits(value) {
  if (value === undefined || value === null || value === "") return 0n;
  try {
    return parseUnits(String(value), 18);
  } catch {
    return 0n;
  }
}

function autoSellHasAmount(value) {
  return value !== undefined && value !== null && value !== "";
}

function autoSellCurrentSizeUnits(position, entry) {
  const hasPositionSize = autoSellHasAmount(position?.size);
  const hasRemainingSize = autoSellHasAmount(entry?.remainingSize);
  const positionSize = autoSellAmountUnits(position?.size);
  const remainingSize = autoSellAmountUnits(entry?.remainingSize);
  if (hasPositionSize && hasRemainingSize) return positionSize < remainingSize ? positionSize : remainingSize;
  if (hasRemainingSize) return remainingSize;
  if (hasPositionSize) return positionSize;
  return 0n;
}

function ceilDivBigInt(numerator, denominator) {
  if (denominator <= 0n) return 0n;
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function autoSellRetainTargetUnits(entry, position, retainPercent, currentSize) {
  let initial = autoSellAmountUnits(entry?.initialSize ?? position?.size);
  if (initial <= 0n) initial = currentSize;
  const scaledPercent = BigInt(Math.ceil(Number(retainPercent) * 1_000_000));
  return ceilDivBigInt(initial * scaledPercent, 100_000_000n);
}

function resolveAutoSellRetainedPosition(cfg, entry, position) {
  const retain = cfg?.autoSellRetainPosition;
  if (!retain) return null;
  const retainPercent = Number(retain.retainPercent);
  if (!Number.isFinite(retainPercent) || retainPercent <= 0 || retainPercent > 100) return null;
  const currentSize = autoSellCurrentSizeUnits(position, entry);
  const retainedTarget = autoSellRetainTargetUnits(entry, position, retainPercent, currentSize);
  const base = {
    outcome: retain.outcome,
    retainPercent,
    currentSizeOt: formatUnits(currentSize, 18),
    retainedTargetOt: formatUnits(retainedTarget, 18)
  };
  if (currentSize <= retainedTarget) {
    return {
      ...base,
      shouldSell: false,
      sellAmountOt: "0",
      remainingAfterSellOt: formatUnits(currentSize, 18)
    };
  }
  const sellAmount = currentSize - retainedTarget;
  return {
    ...base,
    shouldSell: true,
    sellAmountOt: formatUnits(sellAmount, 18),
    remainingAfterSellOt: formatUnits(retainedTarget, 18)
  };
}

function autoSellRemainingAfterSellOt(currentSizeOt, soldAmountUnits) {
  const current = autoSellAmountUnits(currentSizeOt);
  const remaining = current > soldAmountUnits ? current - soldAmountUnits : 0n;
  return formatUnits(remaining, 18);
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

function autoSellTakeProfitSteps(cfg) {
  const steps = Number(cfg.autoSellTakeProfitSteps ?? 0);
  return Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 0;
}

function autoSellMarketStartDate(cfg, position) {
  const planned = plannedBuyForMarket(cfg, {
    address: position?.marketAddress,
    question: position?.question?.title
  });
  if (planned?.kickoffAt) return planned.kickoffAt;
  const exactScoreMatchDate = autoSellExactScoreMatchDate(cfg, position);
  if (exactScoreMatchDate) return exactScoreMatchDate;
  const endOffsetSeconds = Number(cfg.autoSellMarketStartEndOffsetSeconds ?? 0);
  if (endOffsetSeconds > 0) {
    const endDate = position?.market?.endDate ?? position?.question?.endDate ?? null;
    const endMs = Date.parse(endDate ?? "");
    if (!Number.isFinite(endMs)) return null;
    return new Date(endMs - endOffsetSeconds * 1000).toISOString();
  }
  return position?.market?.startDate ?? position?.question?.startDate ?? null;
}

function autoSellExactScoreMatchDate(cfg, position) {
  const endDate = position?.market?.endDate ?? position?.question?.endDate ?? null;
  const endMs = Date.parse(endDate ?? "");
  if (!Number.isFinite(endMs)) return null;
  if (!isAutoSellExactScorePosition(position)) return null;
  const endOffsetSeconds = Number(cfg?.autoSellMarketStartEndOffsetSeconds ?? 0);
  const matchMs = endOffsetSeconds > 0 ? endMs - endOffsetSeconds * 1000 : endMs;
  return new Date(matchMs).toISOString();
}

function isAutoSellExactScorePosition(position) {
  const question = autoSellPositionQuestion(position);
  if (!question) return false;
  const market = {
    question,
    categories: position?.market?.categories ?? position?.question?.categories ?? [],
    subcategories: position?.market?.subcategories ?? position?.question?.subcategories ?? [],
    topics: position?.market?.topics ?? position?.question?.topics ?? [],
    tags: position?.market?.tags ?? position?.question?.tags ?? []
  };
  if (isSportsExactScoreMarket(market)) return true;
  if (!/\bvs\.?\b/iu.test(question)) return false;
  if (/\s[-–—]\s/u.test(question)) return false;
  if (isSportsSideMarketQuestion(question)) return false;
  return isExactScoreOutcomeName(position?.outcome?.name);
}

function autoSellPositionQuestion(position) {
  return String(
    position?.market?.question
      ?? position?.market?.title
      ?? position?.question?.title
      ?? position?.question?.question
      ?? position?.question
      ?? ""
  ).trim();
}

function isExactScoreOutcomeName(name) {
  return /(?:^|[^\d])\d{1,2}\s*(?:-|:|[\u2010-\u2015\u2212])\s*\d{1,2}(?:[^\d]|$)/u.test(String(name ?? ""));
}

function autoSellPreStartDueAt(cfg, position) {
  const beforeSeconds = Number(cfg.autoSellBeforeMarketStartSeconds ?? 0);
  if (!(beforeSeconds > 0)) return null;
  const startMs = Date.parse(autoSellMarketStartDate(cfg, position) ?? "");
  if (!Number.isFinite(startMs)) return null;
  return startMs - beforeSeconds * 1000;
}

function autoSellMarketOpenDate(position) {
  return position?.market?.startDate ?? position?.question?.startDate ?? null;
}

function autoSellOpenExitDueAt(cfg, position) {
  const openMs = Date.parse(autoSellMarketOpenDate(position) ?? "");
  if (!Number.isFinite(openMs)) return null;
  return openMs + Number(cfg.autoSellOpenExitDelaySeconds ?? 36) * 1000;
}

function autoSellProfitPercent(costBasisUsdt, fullExitValueUsdt) {
  if (!(costBasisUsdt > 0) || fullExitValueUsdt === null || fullExitValueUsdt === undefined) return null;
  return Math.max(0, (Number(fullExitValueUsdt) / Number(costBasisUsdt) - 1) * 100);
}

function defaultAutoSellReturnState(position) {
  const costBasisUsdt = Number(position?.costBasis ?? 0);
  return {
    costBasisUsdt,
    remainingCostBasisUsdt: costBasisUsdt,
    quote: null,
    quoteError: null,
    fullExitValueUsdt: null,
    lossPercent: null,
    profitPercent: null
  };
}

async function quoteAutoSellReturnState(cfg, publicClient, walletAddress, position, entry, operatorApproved) {
  const state = defaultAutoSellReturnState(position);
  try {
    state.quote = await quoteSellOutcome(publicClient, {
      market: position.marketAddress,
      tokenId: position.tokenId,
      owner: walletAddress,
      percent: 100,
      slippageBps: cfg.slippageBps,
      operatorApproved
    });
    state.fullExitValueUsdt = rawUsdt(state.quote.expectedCollateralToUser);
    const metrics = autoSellReturnMetrics(position, entry, state.fullExitValueUsdt);
    state.remainingCostBasisUsdt = metrics.remainingCostBasisUsdt;
    state.lossPercent = metrics.lossPercent;
    state.profitPercent = metrics.profitPercent;
  } catch (error) {
    state.quoteError = autoSellErrorMessage(cfg, error);
  }
  return state;
}

function autoSellReturnMetrics(position, entry, fullExitValueUsdt) {
  const costBasisUsdt = Number(position?.costBasis ?? 0);
  const remainingCostBasisUsdt = autoSellRemainingCostBasisUsdt(position, entry, costBasisUsdt);
  const profitPercent = autoSellProfitPercent(remainingCostBasisUsdt, fullExitValueUsdt);
  const lossPercent = remainingCostBasisUsdt > 0
    ? Math.max(0, (1 - Number(fullExitValueUsdt) / remainingCostBasisUsdt) * 100)
    : 0;
  return {
    costBasisUsdt,
    remainingCostBasisUsdt,
    profitPercent,
    lossPercent
  };
}

function autoSellRemainingCostBasisUsdt(position, entry, fallbackCostBasisUsdt = 0) {
  const basis = autoSellNumber(entry?.initialCostBasisUsdt ?? fallbackCostBasisUsdt ?? position?.costBasis ?? 0);
  if (!(basis > 0)) return 0;

  const initialSize = autoSellNumber(entry?.initialSize ?? position?.size ?? 0);
  const trackedRemainingSize = autoSellNumber(entry?.remainingSize);
  const apiCurrentSize = autoSellNumber(position?.size ?? 0);
  const currentSize = trackedRemainingSize >= 0
    ? (apiCurrentSize > 0 ? Math.min(apiCurrentSize, trackedRemainingSize) : trackedRemainingSize)
    : apiCurrentSize;
  if (!(initialSize > 0)) return basis;
  if (!(currentSize > 0)) return 0;

  const remainingRatio = Math.min(1, currentSize / initialSize);
  return basis * remainingRatio;
}

function autoSellNumber(value) {
  if (value === undefined || value === null || value === "") return NaN;
  return Number(String(value).replace(/,/gu, ""));
}

function isAutoSellLadderProfitReady(cfg, profitPercent) {
  const threshold = Number(cfg.autoSellLadderProfitPercent ?? 0);
  if (!(threshold > 0)) return true;
  return profitPercent !== null && profitPercent >= threshold;
}

function autoSellLadderProfitGateEnabled(cfg) {
  return Number(cfg.autoSellLadderProfitPercent ?? 0) > 0;
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
  const gasPriceGwei = cfg.autoSellGasPriceGwei || cfg.gasPriceGwei;
  const gasPriceWei = gasPriceGwei
    ? parseGwei(String(gasPriceGwei))
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
    if (isSensitiveLogKey(key)) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitizeAutoSellLogValue(cfg, item, depth + 1);
  }
  return result;
}

function isSensitiveLogKey(key) {
  return /privateKey|feishuWebhook|webhook|rpcUrl|wsUrl|broadcastRpcUrls|apiKey|token|secret/i.test(String(key));
}

function isInsufficientFundsErrorMessage(message) {
  return /insufficient funds|gas \* price|exceeds the balance|not enough (?:bnb|native)|AUTO_SELL_INSUFFICIENT_BNB|AUTO_SELL gas guard|BNB balance .*below required/i.test(String(message));
}

function isTransientPositionsFetchErrorMessage(message) {
  return /^42 positions (?:(?:408|425|429|5\d\d)\b|invalid JSON\b)|fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|socket hang up|network timeout|terminated/i.test(
    String(message)
  );
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
  if (cfg.autoSellStrategy === "open_timed_exit") {
    const takeProfit = Number(cfg.autoSellLadderProfitPercent ?? 0) > 0
      ? `; 盈${cfg.autoSellLadderProfitPercent}%卖${cfg.autoSellChunkPercent}%`
      : "";
    const stopLoss = cfg.autoSellStopLossEnabled
      ? `; 亏${cfg.autoSellStopLossPercent}%全卖`
      : "";
    const fast = cfg.autoSellFastOpenExitEnabled
      ? `; 快速随机T+${roundMs(cfg.autoSellFastOpenExitMinDelayMs / 1000)}-${roundMs(cfg.autoSellFastOpenExitMaxDelayMs / 1000)}s`
      : "";
    return `开盘T+${cfg.autoSellOpenExitDelaySeconds}s卖${cfg.autoSellOpenExitPercent}%${takeProfit}${fast}${stopLoss}`;
  }
  if (cfg.autoSellStrategy === "pre_start_exit") {
    const preStart = Number(cfg.autoSellBeforeMarketStartSeconds ?? 0) > 0
      ? `赛前${Math.round(Number(cfg.autoSellBeforeMarketStartSeconds) / 60)}min清仓`
      : "赛前清仓未配置";
    const stopLoss = cfg.autoSellStopLossEnabled
      ? `; 亏${cfg.autoSellStopLossPercent}%全卖`
      : "";
    return `持有不分批卖; ${preStart}${stopLoss}`;
  }
  if (cfg.autoSellStrategy === "ladder") {
    const profitGate = Number(cfg.autoSellLadderProfitPercent ?? 0) > 0
      ? `且盈${cfg.autoSellLadderProfitPercent}%后`
      : "";
    const takeProfitSteps = Number(cfg.autoSellTakeProfitSteps ?? 0);
    const takeProfit = takeProfitSteps > 0
      ? `${profitGate}卖${cfg.autoSellChunkPercent}% ${takeProfitSteps}次`
      : `${profitGate}每${cfg.autoSellIntervalSeconds}s卖${cfg.autoSellChunkPercent}%`;
    const preStart = Number(cfg.autoSellBeforeMarketStartSeconds ?? 0) > 0
      ? `; 赛前${Math.round(Number(cfg.autoSellBeforeMarketStartSeconds) / 60)}min清剩余`
      : "";
    return `买后${cfg.autoSellStartDelaySeconds}s起${takeProfit}${preStart}; 亏${cfg.autoSellStopLossPercent}%全卖`;
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
      if (shouldNotifyFundingWait(fundingStatus, cfg)) {
        notifyFeishu(cfg, {
          title: "开盘前资金不足",
          level: "warn",
          fields: waitAlertFields,
          dedupeKey: "waiting-for-funds",
          cooldownMs: cfg.feishuAlertCooldownMs,
          fingerprint: fundingWaitingAlertFingerprint(fundingStatus, cfg),
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

function fundingWaitingAlertFingerprint(fundingStatus, cfg = {}) {
  return [
    "waiting",
    fundingReminderStage(fundingStatus, cfg),
    fundingShortfallFingerprint(fundingStatus),
    fundingStatus?.funding?.nextBatchStartDate ?? "no-start",
    fundingStatus?.executablePlan?.selected?.length ?? 0,
    fundingStatus?.funding?.nextBatchMarketCount ?? 0
  ].join(":");
}

function fundingReminderStage(fundingStatus, cfg = {}) {
  const ms = fundingMsUntilStart(fundingStatus);
  if (ms === null || ms < 0) return "normal";
  if (ms <= 5 * 60 * 1000) return "t-5m";
  if (ms <= 30 * 60 * 1000) return "t-30m";
  const notifyWindowMs = Number(cfg?.armFundingNotifyWindowMs ?? 30 * 60 * 1000);
  if (Number.isFinite(notifyWindowMs) && notifyWindowMs > 30 * 60 * 1000 && ms <= notifyWindowMs) {
    return `t-${Math.ceil(notifyWindowMs / 60000)}m`;
  }
  return "normal";
}

function shouldNotifyFundingWait(fundingStatus, cfg = {}) {
  return fundingReminderStage(fundingStatus, cfg) !== "normal";
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
  const gasReserve = await estimateFundingGasReserve(publicClient, cfg, executableFunding);
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
      clearSeenForFutureEligibleBuy(cfg, seen, market, "startup-rest-future-buy");
      const record = await preparePendingRecord(cfg, market, runtime);
      if (record.preparedPlan) preparedFutureMarkets += 1;
      pending.set(eventSeenKey(market, cfg), record);
      recordMarketDecision(cfg, pendingMarket(record), "pending", {
        source: "startup-rest-seed",
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null,
        selectedOutcomes: record.preparedPlan?.outcomes?.map((outcome) => outcome.name) ?? [],
        memeRangeSelection: record.preparedPlan?.memeRangeSelection ?? null,
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
    if (seen.has(key) && !clearSeenForFutureEligibleBuy(cfg, seen, market, "startup-chain-future-buy")) continue;
    if (pending.has(key)) continue;
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
        selectedOutcomes: record.preparedPlan?.outcomes?.map((outcome) => outcome.name) ?? [],
        memeRangeSelection: record.preparedPlan?.memeRangeSelection ?? null,
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
  const builderKeepalive = createRpcKeepaliveState();
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
      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      await drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, dueExecution, "ws-loop");

      while (queue.length > 0) addBufferedControllerLog(txBuffers, queue.shift());
      await drainControllerLogBuffers(publicClient, txBuffers, cfg, seen, pending, runtime);
      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      maybeStartBroadcastRpcKeepalive(cfg, pending, rpcKeepalive, runtime);
      maybeStartBuilderBundleKeepalive(cfg, pending, builderKeepalive, runtime);
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
    await wakeSignal.wait(nextWatchSleepMs(cfg, pending, runtime));
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
    builderTimers: new Map(),
    running: false,
    rerun: false
  };
}

function shouldUseBlockAwareOpenBroadcast(cfg) {
  return Boolean(
    cfg.openBroadcastMode === "block_aware_20s" &&
    effectivePrebroadcastMs(cfg) <= 0
  );
}

function createOpenBroadcastBlockClockState() {
  return {
    heads: [],
    startedAt: new Date().toISOString(),
    lastHeadAt: null,
    lastErrorAt: null,
    lastError: null,
    errors: 0,
    unwatch: null
  };
}

function maybeStartOpenBroadcastBlockClock(cfg, runtime) {
  if (!shouldUseBlockAwareOpenBroadcast(cfg) || !runtime) return null;
  if (runtime.openBroadcastBlockClock) return runtime.openBroadcastBlockClock;

  const state = createOpenBroadcastBlockClockState();
  runtime.openBroadcastBlockClock = state;

  try {
    const wsClient = makeWsClient(cfg);
    state.unwatch = wsClient.watchBlocks({
      includeTransactions: false,
      emitMissed: true,
      onBlock: (block) => rememberOpenBroadcastBlockHead(state, block),
      onError: (error) => {
        state.errors += 1;
        state.lastErrorAt = new Date().toISOString();
        state.lastError = errorMessage(error);
        console.error(JSON.stringify({
          level: "warn",
          source: "open-broadcast-block-clock",
          message: state.lastError,
          errors: state.errors,
          at: state.lastErrorAt
        }));
      }
    });
    console.log(JSON.stringify({
      level: "open-broadcast-block-clock-started",
      mode: cfg.openBroadcastMode,
      wsProvider: wsProviderLabel(cfg.wsUrl),
      targetOffsetMs: cfg.openBroadcastBlockTargetOffsetMs,
      leadMs: cfg.openBroadcastBlockAwareLeadMs,
      maxWaitMs: cfg.openBroadcastBlockAwareMaxWaitMs,
      preTargetCount: cfg.openBroadcastBlockAwarePreTargetCount,
      preTargetSendMs: cfg.openBroadcastBlockAwarePreTargetSendMs,
      headMaxAgeMs: cfg.openBroadcastBlockAwareHeadMaxAgeMs,
      at: state.startedAt
    }));
  } catch (error) {
    state.errors += 1;
    state.lastErrorAt = new Date().toISOString();
    state.lastError = errorMessage(error);
    console.error(JSON.stringify({
      level: "warn",
      source: "open-broadcast-block-clock-startup",
      message: state.lastError,
      at: state.lastErrorAt
    }));
  }
  return state;
}

function rememberOpenBroadcastBlockHead(state, block, receivedAt = Date.now()) {
  if (!state) return;
  const timestampMs = normalizeBlockTimestampMs(block?.timestamp);
  if (!Number.isFinite(timestampMs)) return;
  const head = {
    number: block?.number === null || block?.number === undefined ? null : String(block.number),
    timestampMs,
    timestampIso: new Date(timestampMs).toISOString(),
    receivedAt,
    receivedAtIso: new Date(receivedAt).toISOString()
  };
  state.heads.push(head);
  state.lastHeadAt = receivedAt;
  const cutoff = receivedAt - 60_000;
  if (state.heads.length > 128 || state.heads.some((item) => item.receivedAt < cutoff)) {
    state.heads = state.heads
      .filter((item) => item.receivedAt >= cutoff)
      .slice(-128);
  }
}

function normalizeBlockTimestampMs(value) {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
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
  if (!state.builderTimers) state.builderTimers = new Map();
  const now = Date.now();
  const scheduleAheadMs = Number(cfg.openBroadcastScheduleAheadMs ?? 0);
  const activeKeys = new Set();

  for (const [key, record] of pending.entries()) {
    activeKeys.add(key);
    if (seen.has(key)) {
      const cleared = clearSeenForFutureEligibleBuy(cfg, seen, pendingMarket(record), `${source}-future-buy`);
      if (cleared) saveSeen(cfg.stateFile, seen);
      if (seen.has(key)) continue;
    }
    const timing = openBroadcastTimingForRecord(record, cfg, runtime, now);
    const nominalTargetMs = timing.targetMs;
    if (!Number.isFinite(nominalTargetMs)) continue;
    const retryTargetMs = Number(record?.executionRetryAfterMs ?? 0);
    const targetMs = Number.isFinite(retryTargetMs)
      ? Math.max(nominalTargetMs, retryTargetMs)
      : nominalTargetMs;
    const waitMs = targetMs - now;
    if (waitMs < -eventOpenWindowMs(cfg)) continue;
    if (scheduleAheadMs > 0 && waitMs > scheduleAheadMs) continue;

    scheduleEarlyBuilderSubmission(cfg, pending, runtime, state, key, record, nominalTargetMs, now);

    const existing = state.timers.get(key);
    if (existing?.targetMs === targetMs) continue;
    if (existing?.timer) clearTimeout(existing.timer);

    const delayMs = Math.max(0, waitMs - Number(cfg.openBroadcastSpinMs ?? 0));
    const timer = setTimeout(() => {
      void waitUntilBroadcastTarget(targetMs, Number(cfg.openBroadcastSpinMs ?? 0))
        .then(() => {
          if (!pending.has(key) || seen.has(key)) return false;
          const current = pending.get(key);
          if (current?.dedicatedOpenTimer && hasPreSignedSingle(current) && !hasPreSignedBundle(current)) {
            return executeDedicatedScheduledSingle(cfg, seen, pending, runtime, key, current, targetMs);
          }
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
          const current = pending.get(key);
          if (current) current.dedicatedOpenTimer = false;
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
      postOpenDelayMs: effectivePostOpenBroadcastDelayMs(actionConfigForRecord(record, cfg)),
      blockAware: describeOpenBroadcastTiming(timing)
    }));
  }

  for (const [key, scheduled] of [...state.timers.entries()]) {
    if (activeKeys.has(key) && !seen.has(key)) continue;
    clearTimeout(scheduled.timer);
    state.timers.delete(key);
  }
  for (const [key, scheduled] of [...state.builderTimers.entries()]) {
    if (activeKeys.has(key) && !seen.has(key)) continue;
    clearTimeout(scheduled.timer);
    state.builderTimers.delete(key);
  }
}

function scheduleEarlyBuilderSubmission(cfg, pending, runtime, state, key, record, targetMs, now = Date.now()) {
  const existing = state.builderTimers.get(key);
  const signed = record?.preSignedFastTransaction;
  const executionCfg = executionConfigForPlan(cfg, record?.preparedPlan);
  const configuredLeadMs = Number(executionCfg?.builderBundleEarlySubmitLeadMs ?? 0);
  const absoluteEarlyTargetMs = Number(signed?.builderBundleEarlySubmitAtMs);
  const earlyTargetMs = Number.isFinite(absoluteEarlyTargetMs) && absoluteEarlyTargetMs > 0
    ? absoluteEarlyTargetMs
    : targetMs - configuredLeadMs;
  const targetBoundaryMs = Number(signed?.builderBundleTargetBoundaryAtMs);
  const targetBoundaryLeadMs = Number.isFinite(targetBoundaryMs)
    ? targetBoundaryMs - earlyTargetMs
    : configuredLeadMs;
  const publicFallbackLeadMs = targetMs - earlyTargetMs;
  const strictTiming = Boolean(executionCfg?.builderBundleTimingResolved?.strict);
  const validTimestampWindow = Boolean(
    Number.isSafeInteger(Number(signed?.builderBundleMaxTimestamp)) &&
    Number(signed.builderBundleMaxTimestamp) > 0
  );
  const configured = Boolean(
    signed?.preSignedBuilderBundle &&
    executionCfg?.builderBundleEnabled &&
    ["builder_then_fanout", "builder_only"].includes(executionCfg?.builderBundleMode) &&
    validTimestampWindow &&
    earlyTargetMs < targetMs &&
    Number.isFinite(publicFallbackLeadMs) &&
    publicFallbackLeadMs > 0 &&
    (!strictTiming || (Number.isFinite(targetBoundaryLeadMs) && targetBoundaryLeadMs > 0))
  );
  record.dedicatedOpenTimer = configured;
  const eligible = configured && !signed.preSubmittedBuilderBundle;
  if (!eligible) {
    if (existing?.timer) clearTimeout(existing.timer);
    state.builderTimers.delete(key);
    return;
  }
  if (existing?.targetMs === earlyTargetMs && existing?.txHash === signed.txHash) return;
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const submissionPromise = submitEarlyBuilderBundleForRecord(cfg, pending, runtime, key, record, executionCfg, signed, {
      targetMs,
      earlyTargetMs,
      targetBoundaryMs,
      targetBoundaryLeadMs,
      publicFallbackLeadMs
    });
    signed.preSubmittedBuilderBundlePromise = submissionPromise;
    void submissionPromise.catch((error) => {
      console.error(JSON.stringify({
        level: "warn",
        source: "builder-bundle-early-submit",
        market: pendingMarket(record)?.address,
        question: pendingMarket(record)?.question,
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
    }).finally(() => {
      if (signed.preSubmittedBuilderBundlePromise === submissionPromise) {
        delete signed.preSubmittedBuilderBundlePromise;
      }
      state.builderTimers.delete(key);
    });
  }, Math.max(0, earlyTargetMs - now));
  timer.unref?.();
  state.builderTimers.set(key, { targetMs: earlyTargetMs, txHash: signed.txHash, timer });
  console.log(JSON.stringify({
    level: "builder-bundle-early-submit-scheduled",
    market: pendingMarket(record)?.address,
    question: pendingMarket(record)?.question,
    txHash: signed.txHash,
    targetAt: new Date(targetMs).toISOString(),
    targetBoundaryAt: Number.isFinite(targetBoundaryMs) ? new Date(targetBoundaryMs).toISOString() : null,
    earlySubmitAt: new Date(earlyTargetMs).toISOString(),
    targetBoundaryLeadMs,
    publicFallbackLeadMs,
    minTimestamp: signed.builderBundleMinTimestamp ?? null,
    maxTimestamp: signed.builderBundleMaxTimestamp ?? null,
    timingMode: executionCfg.builderBundleTimingMode ?? "legacy",
    targetSecond: signed.builderBundleTargetSecond ?? null,
    at: new Date().toISOString()
  }));
}

async function executeDedicatedScheduledSingle(cfg, seen, pending, runtime, key, record, targetMs) {
  if (record.dedicatedOpenTimerInFlight) return false;
  record.dedicatedOpenTimerInFlight = true;
  const market = pendingMarket(record);
  const reachedAtMs = Date.now();
  console.log(JSON.stringify({
    level: "open-broadcast-dedicated-timer",
    market: market?.address,
    question: market?.question,
    targetAt: new Date(targetMs).toISOString(),
    reachedAt: new Date(reachedAtMs).toISOString(),
    latenessMs: Math.max(0, reachedAtMs - targetMs),
    txHash: record.preSignedFastTransaction?.txHash ?? null,
    at: new Date().toISOString()
  }));
  try {
    const executed = await maybeExecuteMarket(cfg, seen, market, {
      allowFuturePending: false,
      runtime,
      preparedPlan: record.preparedPlan,
      preSignedFastTransaction: record.preSignedFastTransaction,
      hydrateOdds: false,
      hydrationSkipReason: "dedicated_open_timer",
      retryRecord: record
    });
    if (executed || seen.has(key)) pending.delete(key);
    return executed;
  } finally {
    record.dedicatedOpenTimerInFlight = false;
  }
}

async function submitEarlyBuilderBundleForRecord(cfg, pending, runtime, key, record, executionCfg, signed, timing) {
  const current = pending.get(key);
  if (current !== record || current?.preSignedFastTransaction?.txHash !== signed.txHash) return null;
  if (signed.preSubmittedBuilderBundle) return signed.preSubmittedBuilderBundle;
  const inFlight = signed.preSubmittedBuilderBundlePromise ?? null;
  if (inFlight) {
    const sharedResult = await inFlight;
    if (sharedResult?.submitted) {
      signed.preSubmittedBuilderBundle = sharedResult;
      return sharedResult;
    }
  }

  const startedAtMs = Date.now();
  const result = await submitPreSignedBuilderBundle(executionCfg, signed);
  signed.preSubmittedBuilderBundle = result ?? {
    submitted: false,
    earlySubmitted: true,
    earlySubmitStartedAt: new Date(startedAtMs).toISOString(),
    earlySubmitLeadMs: timing.targetBoundaryLeadMs,
    error: "builder early submission unavailable"
  };
  console.log(JSON.stringify({
    level: "builder-bundle-early-submit-result",
    market: pendingMarket(record)?.address,
    question: pendingMarket(record)?.question,
    txHash: signed.txHash,
    submitted: Boolean(signed.preSubmittedBuilderBundle.submitted),
    targetAt: new Date(timing.targetMs).toISOString(),
    targetBoundaryAt: Number.isFinite(timing.targetBoundaryMs) ? new Date(timing.targetBoundaryMs).toISOString() : null,
    earlySubmitAt: new Date(timing.earlyTargetMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    acceptedAt: signed.preSubmittedBuilderBundle.acceptedAt ?? null,
    requestLatencyMs: signed.preSubmittedBuilderBundle.requestLatencyMs ?? null,
    targetBoundaryLeadMs: timing.targetBoundaryLeadMs,
    publicFallbackLeadMs: timing.publicFallbackLeadMs,
    minTimestamp: signed.preSubmittedBuilderBundle.minTimestamp ?? signed.builderBundleMinTimestamp ?? null,
    maxTimestamp: signed.preSubmittedBuilderBundle.maxTimestamp ?? signed.builderBundleMaxTimestamp ?? null,
    timingMode: signed.preSubmittedBuilderBundle.timingMode ?? signed.builderBundleTimingMode ?? null,
    targetSecond: signed.preSubmittedBuilderBundle.targetSecond ?? signed.builderBundleTargetSecond ?? null,
    error: signed.preSubmittedBuilderBundle.error ?? null,
    at: new Date().toISOString()
  }));
  if (!signed.preSubmittedBuilderBundle.submitted) {
    releaseBuilderTipNonceReservationAfterEarlyFailure(cfg, pending, runtime, record, signed);
  }
  return signed.preSubmittedBuilderBundle;
}

function releaseBuilderTipNonceReservationAfterEarlyFailure(cfg, pending, runtime, sourceRecord, signed) {
  if (!runtime || runtime.nextNonce === undefined || cfg.dryRun || !cfg.execute) return;
  if (signed?.preSignedTimestampGuardTransaction) return;
  if (signed?.builderBundleTipNonceRuntimeReleased) return;
  const buyNonce = Number(signed?.nonce);
  if (!Number.isSafeInteger(buyNonce) || buyNonce < 0) return;
  if (signed?.timedBuyExecutorEnabled) {
    if (signed.builderBundleNonceRecoveryDeferred) return;
    signed.builderBundleNonceRecoveryDeferred = true;
    scheduleStrictBuilderTargetExpiryWatch(
      cfg,
      strictBuilderExpiryResultFromSigned(signed),
      {
        type: "single",
        market: pendingMarket(sourceRecord)?.address ?? null,
        question: pendingMarket(sourceRecord)?.question ?? null,
        marketDetails: [pendingMarket(sourceRecord)].filter(Boolean),
        sourceRecord
      },
      runtime,
      { allowUnsubmitted: true }
    );
    console.error(JSON.stringify({
      level: "warn",
      source: "builder-early-submit-nonce-recovery-deferred",
      buyTxHash: signed.txHash,
      buyNonce,
      targetTimestamp: signed.timedBuyExecutorTargetTimestamp ?? null,
      reason: "timed Builder buy nonce remains reserved until the exact target second expires",
      at: new Date().toISOString()
    }));
    return;
  }
  let cleared = 0;
  for (const record of pending.values()) {
    if (record === sourceRecord) continue;
    const singleNonce = Number(record?.preSignedFastTransaction?.nonce);
    if (Number.isSafeInteger(singleNonce) && singleNonce > buyNonce) {
      clearPreSignedSingleRecord(record, "builder-early-submit-failed");
      cleared += 1;
    }
    const bundleNonce = Number(record?.preSignedFastBundleTransaction?.nonce);
    if (Number.isSafeInteger(bundleNonce) && bundleNonce > buyNonce) {
      clearPreSignedBundleRecords([record], "builder-early-submit-failed");
      cleared += 1;
    }
  }
  const nextNonce = buyNonce + 1;
  const previousNonce = runtime.nextNonce;
  runtime.nextNonce = Math.min(previousNonce, nextNonce);
  runtime.lastNonceSyncAt = 0;
  signed.builderBundleTipNonceReleased = true;
  signed.builderBundleTipNonceRuntimeReleased = true;
  if (signed.preSubmittedBuilderBundle) signed.preSubmittedBuilderBundle.tipNonceReleased = true;
  console.error(JSON.stringify({
    level: "warn",
    source: "builder-early-submit-nonce-release",
    buyTxHash: signed.txHash,
    buyNonce,
    previousNonce,
    nextNonce: runtime.nextNonce,
    clearedPreSignedTransactions: cleared,
    at: new Date().toISOString()
  }));
}

function strictBuilderExpiryResultFromSigned(signed) {
  const submitted = signed?.preSubmittedBuilderBundle ?? {};
  return {
    txHash: signed?.txHash ?? null,
    nonce: signed?.nonce ?? null,
    preSignedNonce: signed?.nonce ?? null,
    builderBundleSubmitted: Boolean(submitted.submitted),
    publicBroadcastSkipped: true,
    builderBundleHash: submitted.bundleHash ?? null,
    builderBundleTipTxHash: submitted.tipTxHash ?? signed?.preSignedBuilderBundleTipTransaction?.txHash ?? null,
    builderBundleTargetSecond: signed?.builderBundleTargetSecond ?? null,
    builderBundleMaxTimestamp: signed?.builderBundleMaxTimestamp ?? null,
    builderTimedBuyExecutorTargetTimestamp: signed?.timedBuyExecutorTargetTimestamp ?? null,
    builderTimedBuyExecutorExactSecond: Boolean(signed?.timedBuyExecutorExactSecond)
  };
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

function maybeStartBroadcastRpcKeepalive(cfg, pending, state, runtime = null) {
  const intervalMs = Number(cfg.rpcKeepaliveMs ?? 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  const configs = hotBroadcastRpcConfigs(cfg, pending, runtime);
  if (configs.length === 0) return;
  const now = Date.now();
  if (state.running || now < state.nextRunAt) return;

  state.running = true;
  void Promise.all(configs.map((item) => warmBroadcastRpcClients(item, { includeGasPrice: false })))
    .then((results) => {
      const attempts = results.flatMap((result) => result.results ?? []);
      const failed = attempts.filter((item) => !item.ok);
      if (failed.length > 0) {
        console.error(JSON.stringify({
          level: "warn",
          source: "broadcast-rpc-keepalive",
          okCount: attempts.length - failed.length,
          rpcCount: attempts.length,
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

function hotBroadcastRpcConfigs(cfg, pending, runtime = null) {
  if (!pending || pending.size === 0) return [];
  const configs = new Map();
  for (const record of pending.values()) {
    const waitMs = msUntilRecordAction(record, cfg, runtime);
    if (waitMs > cfg.preopenHotMs || waitMs < -eventOpenWindowMs(cfg)) continue;
    const execCfg = record?.preparedPlan ? executionConfigForPlan(cfg, record.preparedPlan) : cfg;
    const urls = execCfg.broadcastRpcUrls?.length ? execCfg.broadcastRpcUrls : [execCfg.rpcUrl];
    const key = urls.filter(Boolean).join("|");
    if (key && !configs.has(key)) configs.set(key, execCfg);
  }
  return [...configs.values()];
}

function maybeStartBuilderBundleKeepalive(cfg, pending, state, runtime = null) {
  const intervalMs = Number(cfg.rpcKeepaliveMs ?? 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  const configs = hotBuilderBundleConfigs(cfg, pending, runtime);
  if (configs.length === 0) return;
  const now = Date.now();
  if (state.running || now < state.nextRunAt) return;

  state.running = true;
  void Promise.all(configs.map((item) => warmBuilderBundleClient(item)))
    .then((results) => {
      const failed = results.filter((item) => !item.ok);
      if (failed.length > 0) {
        console.error(JSON.stringify({
          level: "warn",
          source: "builder-bundle-keepalive",
          okCount: results.length - failed.length,
          builderCount: results.length,
          failed: failed.map((item) => ({
            provider: item.provider,
            reason: item.reason ?? null,
            error: item.error ?? null
          })),
          at: new Date().toISOString()
        }));
      }
    })
    .catch((error) => {
      console.error(JSON.stringify({
        level: "warn",
        source: "builder-bundle-keepalive",
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
    })
    .finally(() => {
      state.nextRunAt = Date.now() + intervalMs;
      state.running = false;
    });
}

function hotBuilderBundleConfigs(cfg, pending, runtime = null) {
  if (!pending || pending.size === 0) return [];
  const configs = new Map();
  for (const record of pending.values()) {
    const waitMs = msUntilRecordAction(record, cfg, runtime);
    if (waitMs > cfg.preopenHotMs || waitMs < -eventOpenWindowMs(cfg)) continue;
    const execCfg = record?.preparedPlan ? executionConfigForPlan(cfg, record.preparedPlan) : cfg;
    if (!execCfg.builderBundleEnabled) continue;
    if (!execCfg.builderBundleUrl) continue;
    const tipBnb = Number(execCfg.builderBundleTipBnb);
    if (!Number.isFinite(tipBnb) || tipBnb <= 0) continue;
    const key = [
      execCfg.builderBundleUrl,
      execCfg.builderBundleTimeoutMs,
      execCfg.builderBundleMode,
      execCfg.builderBundleTipBnb
    ].join("|");
    if (!configs.has(key)) configs.set(key, execCfg);
  }
  return [...configs.values()];
}

function hasHotPendingMarket(cfg, pending, runtime = null) {
  if (!pending || pending.size === 0) return false;
  return [...pending.values()].some((record) => {
    const waitMs = msUntilRecordAction(record, cfg, runtime);
    return waitMs <= cfg.preopenHotMs && waitMs >= -eventOpenWindowMs(cfg);
  });
}

async function watchRest(cfg, seen, runtime = null, initialPending = new Map()) {
  const pending = new Map(initialPending);
  attachRuntimePendingBuyRecords(runtime, pending);
  const dueExecution = createDueExecutionState();
  while (true) {
    try {
      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      await drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, dueExecution, "rest-loop");

      const markets = await loadEventMarkets(cfg, { limit: cfg.watchScanLimit });
      for (const market of [...markets].reverse()) {
        const executed = await maybeExecuteMarket(cfg, seen, market, { allowFuturePending: false, runtime });
        if (!executed && !seen.has(eventSeenKey(market, cfg)) && msUntilStart(market) > 0) {
          pending.set(eventSeenKey(market, cfg), await preparePendingRecord(cfg, market, runtime));
        }
      }
      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: errorMessage(error), at: new Date().toISOString() }));
    }
    await sleep(nextWatchSleepMs(cfg, pending, runtime));
  }
}

async function watchFeed(cfg, seen, runtime = null, initialPending = new Map()) {
  const pending = new Map(initialPending);
  attachRuntimePendingBuyRecords(runtime, pending);
  const dueExecution = createDueExecutionState();
  const feedState = createEventDiscoveryFeedState(cfg);

  console.log(JSON.stringify({
    level: "event-discovery-feed-watch",
    file: cfg.eventDiscoveryFeedFile,
    pollMs: cfg.eventDiscoveryFeedPollMs,
    tailBytes: cfg.eventDiscoveryFeedTailBytes
  }));

  while (true) {
    try {
      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
      await drainDuePendingMarketsSerialized(cfg, seen, pending, runtime, dueExecution, "feed-loop");

      const markets = readEventDiscoveryFeedMarkets(cfg, feedState);
      if (markets.length > 0) {
        console.log(JSON.stringify({
          level: "event-discovery-feed-poll",
          markets: markets.length,
          latestCreatedAt: markets[0]?.createdAt ?? null,
          latestQuestion: markets[0]?.question ?? null,
          at: new Date().toISOString()
        }));
        await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByStartAsc(markets), runtime, {
          source: "event-discovery-feed",
          hydrateDueOdds: true,
          hydrationSkipReason: "event_discovery_feed"
        });
      }

      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
      scheduleDuePendingMarkets(cfg, seen, pending, runtime, dueExecution);
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        source: "event-discovery-feed",
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
      notifyFeishu(cfg, {
        title: "共享发现读取异常",
        level: "warn",
        fields: { message: errorMessage(error) },
        dedupeKey: "event-discovery-feed-error",
        cooldownMs: cfg.feishuAlertCooldownMs
      });
    }
    await sleep(Math.min(nextWatchSleepMs(cfg, pending, runtime), cfg.eventDiscoveryFeedPollMs));
  }
}

function createEventDiscoveryFeedState(cfg) {
  return {
    file: cfg.eventDiscoveryFeedFile,
    initialized: false,
    offset: 0,
    partial: "",
    dropFirstPartial: false,
    parseErrors: 0,
    missingLoggedAt: 0
  };
}

function readEventDiscoveryFeedMarkets(cfg, state) {
  const file = cfg.eventDiscoveryFeedFile;
  if (!file) return [];
  if (!fs.existsSync(file)) {
    const now = Date.now();
    if (!state.missingLoggedAt || now - state.missingLoggedAt >= 60000) {
      state.missingLoggedAt = now;
      console.error(JSON.stringify({
        level: "warn",
        source: "event-discovery-feed",
        message: "feed file does not exist yet",
        file,
        at: new Date().toISOString()
      }));
    }
    return [];
  }

  const stat = fs.statSync(file);
  if (!state.initialized) {
    const tailBytes = Number(cfg.eventDiscoveryFeedTailBytes ?? 0);
    state.offset = tailBytes > 0 ? Math.max(0, stat.size - tailBytes) : stat.size;
    state.dropFirstPartial = state.offset > 0;
    state.initialized = true;
  }
  if (stat.size < state.offset) {
    state.offset = 0;
    state.partial = "";
    state.dropFirstPartial = false;
  }
  if (stat.size === state.offset) return [];

  const chunk = readUtf8FileChunk(file, state.offset, stat.size - state.offset);
  state.offset = stat.size;
  const text = state.partial + chunk;
  const hasTrailingNewline = text.endsWith("\n") || text.endsWith("\r");
  const lines = text.split(/\r?\n/);
  state.partial = hasTrailingNewline ? "" : (lines.pop() ?? "");
  if (state.dropFirstPartial) {
    lines.shift();
    state.dropFirstPartial = false;
  }

  const markets = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const market = marketFromEventDiscoveryFeedRow(row);
      if (market) markets.push(market);
    } catch (error) {
      state.parseErrors += 1;
      if (state.parseErrors <= 5 || state.parseErrors % 100 === 0) {
        console.error(JSON.stringify({
          level: "warn",
          source: "event-discovery-feed-parse",
          parseErrors: state.parseErrors,
          message: errorMessage(error),
          at: new Date().toISOString()
        }));
      }
    }
  }
  return mergeKnownEventMarkets(markets);
}

function readUtf8FileChunk(file, offset, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function marketFromEventDiscoveryFeedRow(row) {
  if (!row || row.level !== "event-discovery-feed") return null;
  const rawMarket = row.market && typeof row.market === "object" ? row.market : row;
  if (!rawMarket?.address) return null;
  return {
    ...rawMarket,
    address: String(rawMarket.address),
    question: rawMarket.question ?? rawMarket.title ?? row.question ?? null,
    title: rawMarket.title ?? rawMarket.question ?? row.question ?? null,
    status: rawMarket.status ?? row.status ?? null,
    startDate: rawMarket.startDate ?? row.startDate ?? null,
    outcomes: Array.isArray(rawMarket.outcomes) ? rawMarket.outcomes.map(normalizeFeedOutcome) : []
  };
}

function normalizeFeedOutcome(outcome = {}) {
  return {
    ...outcome,
    tokenId: outcome.tokenId === undefined || outcome.tokenId === null ? outcome.tokenId : String(outcome.tokenId),
    name: outcome.name ?? outcome.title ?? null
  };
}

function createRestDiscoveryState() {
  return {
    startedAtMs: Date.now(),
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
    const seedCandidates = collectRestDiscoverySeedCandidates(cfg, seen, pending, state, markets);
    rememberRestDiscoveryMarkets(state, markets);
    state.seeded = true;
    console.log(JSON.stringify({
      level: "rest-discovery-seed",
      markets: markets.length,
      seedFutureEligible: seedCandidates.length,
      latestCreatedAt: markets[0]?.createdAt ?? null,
      latestQuestion: markets[0]?.question ?? null,
      at: new Date().toISOString()
    }));
    if (seedCandidates.length > 0) state.candidates.push(...seedCandidates);
    return;
  }

  const { candidates, unknown, knownFutureEligible } = collectRestDiscoveryCandidates(
    cfg,
    seen,
    pending,
    state,
    markets
  );
  rememberRestDiscoveryMarkets(state, markets);

  if (candidates.length === 0) return;
  const eligible = candidates.filter((market) => marketFilterDecision(market, cfg).eligible).length;
  console.log(JSON.stringify({
    level: "rest-discovery-poll",
    candidates: candidates.length,
    unknown,
    knownFutureEligible,
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
      const seedCandidates = collectRestDiscoverySeedCandidates(cfg, seen, pending, state, markets);
      rememberRestDiscoveryMarkets(state, markets);
      state.seeded = true;
      console.log(JSON.stringify({
        level: "rest-discovery-seed",
        markets: markets.length,
        seedFutureEligible: seedCandidates.length,
        latestCreatedAt: markets[0]?.createdAt ?? null,
        latestQuestion: markets[0]?.question ?? null,
        at: new Date().toISOString()
      }));
      if (seedCandidates.length > 0) {
        await handleDiscoveredMarkets(cfg, seen, pending, sortMarketsByStartAsc(seedCandidates), runtime, {
          source: "rest-discovery-seed",
          hydrateDueOdds: true,
          hydrationSkipReason: "rest_discovery_seed"
        });
      }
      return;
    }

    const { candidates, unknown, knownFutureEligible } = collectRestDiscoveryCandidates(
      cfg,
      seen,
      pending,
      state,
      markets
    );
    rememberRestDiscoveryMarkets(state, markets);

    if (candidates.length > 0) {
      const eligible = candidates.filter((market) => marketFilterDecision(market, cfg).eligible).length;
      console.log(JSON.stringify({
        level: "rest-discovery-poll",
        candidates: candidates.length,
        unknown,
        knownFutureEligible,
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

function collectRestDiscoverySeedCandidates(cfg, seen, pending, state, markets) {
  const now = Date.now();
  return markets.filter((market) => {
    const rawKey = restDiscoveryMarketKey(market);
    if (!rawKey) return false;
    const key = eventSeenKey(market, cfg);
    if (seen.has(key) || pending.has(key)) return false;
    if (!isRestDiscoverySessionMarket(state, market)) return false;
    return isFutureEligibleRestDiscoveryMarket(cfg, market, now);
  });
}

function collectRestDiscoveryCandidates(cfg, seen, pending, state, markets) {
  const now = Date.now();
  const candidates = [];
  let unknown = 0;
  let knownFutureEligible = 0;

  for (const market of markets) {
    const rawKey = restDiscoveryMarketKey(market);
    if (!rawKey) continue;
    const key = eventSeenKey(market, cfg);
    if (seen.has(key) || pending.has(key)) continue;

    if (!state.knownMarketKeys.has(rawKey)) {
      candidates.push(market);
      unknown += 1;
      continue;
    }

    if (isFutureEligibleRestDiscoveryMarket(cfg, market, now)) {
      candidates.push(market);
      knownFutureEligible += 1;
    }
  }

  return { candidates, unknown, knownFutureEligible };
}

function isFutureEligibleRestDiscoveryMarket(cfg, market, now = Date.now()) {
  const startMs = new Date(market?.startDate).getTime();
  if (!Number.isFinite(startMs)) return false;
  const actionMs = marketActionTimeMs(market, cfg);
  return Number.isFinite(actionMs) && actionMs > now && marketFilterDecision(market, cfg).eligible;
}

function isRestDiscoverySessionMarket(state, market) {
  const createdAt = new Date(market?.createdAt).getTime();
  const startedAt = Number(state?.startedAtMs ?? 0);
  if (!Number.isFinite(createdAt) || !Number.isFinite(startedAt) || startedAt <= 0) return false;
  return createdAt >= startedAt - 1000;
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
      await preSignHotPendingMarkets(cfg, seen, pending, runtime);
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
        await preSignHotPendingMarkets(cfg, seen, pending, runtime);
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
    await sleep(nextWatchSleepMs(cfg, pending, runtime));
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
  const dueRecordsRaw = [...pending.values()].filter((record) => {
    return !record.dedicatedOpenTimer && msUntilRecordAction(record, cfg, runtime) <= 0;
  });
  const preBlockedStrictBuilderRecords = dueRecordsRaw.filter((record) => record.strictBuilderLaneBlocked);
  await markStrictBuilderLaneSkippedRecords(cfg, seen, pending, runtime, preBlockedStrictBuilderRecords, "pending-builder-wallet-lane");
  const strictBuilderLane = splitRecordsByStrictBuilderLane(
    cfg,
    dueRecordsRaw.filter((record) => !record.strictBuilderLaneBlocked)
  );
  await markStrictBuilderLaneSkippedRecords(cfg, seen, pending, runtime, strictBuilderLane.skipped, "pending-builder-wallet-lane");
  const dueLimit = splitRecordsByOpenLimit(cfg, strictBuilderLane.selected);
  await markOpenLimitSkippedRecords(cfg, seen, pending, runtime, dueLimit.skipped, "pending-open-market-limit");
  const dueRecords = dueLimit.selected;
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

    const grouped = groupRecordsByActionTime(dueRecords.filter((record) => {
      const key = eventSeenKey(pendingMarket(record), cfg);
      return !handled.has(key) && !hasPreSignedBundle(record);
    }), cfg, runtime);
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
    if (record.dedicatedOpenTimer) continue;
    if (fundingBlockedKeys.has(eventSeenKey(market, cfg))) continue;
    if (msUntilRecordAction(record, cfg, runtime) > 0) continue;
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
  await waitForRuntimeBuilderNonceRecovery(runtime);
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
    const openBroadcastTiming = describeOpenBroadcastTiming(
      openBroadcastTimingForRecord(records[0], cfg, runtime)
    );
    let result = await executeOrPrintBundle(bundle, cfg, runtime);
    if (openBroadcastTiming) result = { ...result, openBroadcastTiming };
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

async function preSignHotPendingMarkets(cfg, seen, pending, runtime) {
  if (!shouldPreSignFastTransactions(cfg, runtime)) return;
  await waitForRuntimeBuilderNonceRecovery(runtime);
  const now = Date.now();
  const fundingBlockedKeys = new Set();
  const openLimitKeys = recordKeysWithinOpenLimit(cfg, [...pending.values()]);
  const strictBuilderLaneKeys = assignStrictBuilderLaneAdmission(cfg, [...pending.values()]);
  const fastOpenExitNonceLane = fastOpenExitNonceLaneEnabled(cfg);
  if (fastOpenExitNonceLane && (runtimeHasPreSignedBuy(runtime) || runtime?.fastOpenExitPreSignGate)) return;
  const recordAvailableForPreSign = (record, source) => {
    const market = pendingMarket(record);
    const key = eventSeenKey(market, cfg);
    if (!seen?.has?.(key)) return true;
    const cleared = clearSeenForFutureEligibleBuy(cfg, seen, market, source);
    if (cleared) saveSeen(cfg.stateFile, seen);
    return !seen.has(key);
  };
  if (cfg.bundleDueMarkets && cfg.eventBuyMode === "fast" && !fastOpenExitNonceLane) {
    const grouped = groupRecordsByActionTime([...pending.values()].filter((record) => {
      if (!recordAvailableForPreSign(record, "pre-sign-bundle-future-buy")) return false;
      if (openLimitKeys && !openLimitKeys.has(eventSeenKey(pendingMarket(record), cfg))) return false;
      if (!strictBuilderLaneKeys.has(eventSeenKey(pendingMarket(record), cfg))) return false;
      if (isMarketFollowBlocked(pendingMarket(record), cfg)) return false;
      if (
        !record.preparedPlan ||
        record.preSignedFastBundleTransaction ||
        !canRetryPreSign(record.bundlePreSignError, record.bundlePreSignRetryAfterMs, now, cfg)
      ) return false;
      const actionWaitMs = msUntilRecordAction(record, cfg, runtime);
      return actionWaitMs > 0 && actionWaitMs <= cfg.preSignWindowMs;
    }), cfg, runtime);

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
      if (!recordAvailableForPreSign(record, "pre-sign-single-future-buy")) return false;
      if (openLimitKeys && !openLimitKeys.has(eventSeenKey(pendingMarket(record), cfg))) return false;
      if (!strictBuilderLaneKeys.has(eventSeenKey(pendingMarket(record), cfg))) return false;
      if (fundingBlockedKeys.has(eventSeenKey(pendingMarket(record), cfg))) return false;
      if (isMarketFollowBlocked(pendingMarket(record), cfg)) return false;
      if (
        !record.preparedPlan ||
        record.preSignedFastTransaction ||
        record.preSignedFastBundleTransaction ||
        !canRetryPreSign(record.preSignError, record.preSignRetryAfterMs, now, cfg)
      ) return false;
      const actionWaitMs = msUntilRecordAction(record, cfg, runtime);
      return actionWaitMs > 0 && actionWaitMs <= cfg.preSignWindowMs;
    })
    .sort((a, b) => compareStartAsc(pendingMarket(a), pendingMarket(b)));

  if (fastOpenExitNonceLane) {
    const preapprovalChangedNonce = await maybePreapproveFastOpenExitMarkets(cfg, records, runtime);
    if (preapprovalChangedNonce) return;
  }

  const recordsToSign = fastOpenExitNonceLane ? records.slice(0, 1) : records;
  for (const record of recordsToSign) {
    await syncRuntimeNonceBeforePreSign(cfg, runtime, { reason: "single" });
    await attachPreSignedFastTransaction(cfg, record, runtime);
  }
}

function fastOpenExitNonceLaneEnabled(cfg) {
  return Boolean(
    cfg.autoSellFastOpenExitEnabled &&
    cfg.autoSellEnabled &&
    String(cfg.autoSellStrategy ?? "").trim().toLowerCase() === "open_timed_exit"
  );
}

function fastOpenExitEnabledForRecord(cfg, record) {
  if (!fastOpenExitNonceLaneEnabled(cfg)) return false;
  const market = pendingMarket(record);
  const planned = plannedBuyForMarket(cfg, market);
  const autoSellCfg = planned?.autoSell ? { ...cfg, ...planned.autoSell } : cfg;
  return Boolean(
    autoSellCfg.autoSellEnabled !== false &&
    autoSellCfg.autoSellFastOpenExitEnabled !== false &&
    String(autoSellCfg.autoSellStrategy ?? "").trim().toLowerCase() === "open_timed_exit"
  );
}

function runtimeHasPreSignedBuy(runtime) {
  const pending = runtime?.pendingBuyRecords;
  if (!pending?.values) return false;
  for (const record of pending.values()) {
    if (record?.preSignedFastTransaction || record?.preSignedFastBundleTransaction) return true;
  }
  return false;
}

async function maybePreapproveFastOpenExitMarkets(cfg, records, runtime) {
  if (!fastOpenExitNonceLaneEnabled(cfg) || runtimeHasPreSignedBuy(runtime) || runtime?.fastOpenExitPreSignGate) {
    return false;
  }
  for (const record of records) {
    if (!fastOpenExitEnabledForRecord(cfg, record)) continue;
    const market = pendingMarket(record);
    const marketKey = String(market?.address ?? "").toLowerCase();
    if (!marketKey || runtime?.autoSellOperatorReadyMarkets?.has(marketKey)) continue;
    if (record.fastOpenExitOperatorPreapprovalAttempted) continue;
    if (msUntilRecordAction(record, cfg, runtime) <= 5000) {
      record.fastOpenExitOperatorPreapprovalAttempted = true;
      record.fastOpenExitOperatorPreapprovalError = "less than 5s remains before buy";
      console.error(JSON.stringify({
        level: "warn",
        source: "fast-open-exit-operator-preapproval",
        market: market.address,
        question: market.question,
        status: "skipped",
        reason: record.fastOpenExitOperatorPreapprovalError,
        at: new Date().toISOString()
      }));
      continue;
    }

    record.fastOpenExitOperatorPreapprovalAttempted = true;
    try {
      const execution = await withRuntimeTransactionLock(runtime, "fast-open-exit-operator-preapproval", () =>
        ensureMarketOperatorApproval(cfg, market.address)
      );
      if (execution.txHash) {
        await syncRuntimeNonceAfterExternalTx(cfg, runtime, "fast-open-exit-operator-preapproval");
      }
      if (execution.operatorApproved) {
        runtime?.autoSellOperatorReadyMarkets?.add(marketKey);
      }
      record.fastOpenExitOperatorPreapproval = execution;
      const row = {
        level: "event-operator-preapproval",
        source: "fast-open-exit-before-buy",
        wallet: runtime?.receiverAddress ?? cfg.walletAddress ?? null,
        market: market.address,
        execution,
        at: new Date().toISOString()
      };
      appendJsonl(cfg.fillsFile, row);
      await appendGasLedgerFromExecution(cfg, execution, {
        action: "approval",
        source: "fast-open-exit-before-buy",
        allocations: [{ market: market.address, action: "approval", weight: 1 }]
      });
      console.log(JSON.stringify(row));
      return Boolean(execution.txHash);
    } catch (error) {
      record.fastOpenExitOperatorPreapprovalError = errorMessage(error);
      console.error(JSON.stringify({
        level: "warn",
        source: "fast-open-exit-operator-preapproval",
        market: market.address,
        question: market.question,
        status: "error",
        message: record.fastOpenExitOperatorPreapprovalError,
        at: new Date().toISOString()
      }));
    }
  }
  return false;
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
      msUntilAction: msUntilRecordAction(records[0], cfg, runtime)
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
  for (const discoveredMarket of markets) {
    const market = attachMemeRangeSelectionLock(cfg, discoveredMarket);
    const key = eventSeenKey(market, cfg);
    if (seen.has(key)) {
      const cleared = clearSeenForFutureEligibleBuy(cfg, seen, market, `${source}-future-buy`);
      if (cleared) saveSeen(cfg.stateFile, seen);
      if (seen.has(key)) continue;
    }
    if (pending.has(key)) {
      await maybeUpgradePendingMemeRangeSelection(cfg, pending, key, market, runtime, source);
      continue;
    }
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

    const dueNow = msUntilRecordAction({ market }, cfg, runtime) <= 0;
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
    const recordDueNow = msUntilRecordAction(record, cfg, runtime) <= 0;
    if (recordDueNow) {
      recordMarketDecision(cfg, pendingMarket(record), "due", {
        source,
        decision,
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null,
        selectedOutcomes: record.preparedPlan?.outcomes?.map((outcome) => outcome.name) ?? [],
        memeRangeSelection: record.preparedPlan?.memeRangeSelection ?? null
      });
      notifyWillBuyMarket(cfg, pendingMarket(record), record, {
        source,
        state: "立即买入"
      });
      immediateRecords.push(record);
      continue;
    }

    if (!seen.has(key)) {
      pending.set(key, record);
      recordMarketDecision(cfg, pendingMarket(record), "pending", {
        source,
        decision,
        rankSource: record.preparedPlan?.selection?.rankSource ?? null,
        fallbackReason: record.preparedPlan?.selection?.fallbackReason ?? null,
        selectedOutcomes: record.preparedPlan?.outcomes?.map((outcome) => outcome.name) ?? [],
        memeRangeSelection: record.preparedPlan?.memeRangeSelection ?? null
      });
      notifyWillBuyMarket(cfg, pendingMarket(record), record, {
        source,
        state: "待开盘"
      });
    }
  }

  if (immediateRecords.length === 0) return;
  const immediateLimit = splitRecordsByOpenLimit(cfg, immediateRecords);
  await markOpenLimitSkippedRecords(cfg, seen, pending, runtime, immediateLimit.skipped, "immediate-open-market-limit");
  const executableImmediateRecords = immediateLimit.selected;
  if (executableImmediateRecords.length === 0) return;
  const fundingBlockedKeys = new Set();
  if (cfg.bundleDueMarkets && cfg.eventBuyMode === "fast") {
    const grouped = groupRecordsByActionTime(executableImmediateRecords, cfg, runtime);
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

  for (const record of executableImmediateRecords) {
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

async function maybeUpgradePendingMemeRangeSelection(cfg, pending, key, market, runtime, source) {
  const existing = pending.get(key);
  const lockedSelection = market.memeRangeSelection ?? readMemeRangeSelectionLock(cfg, market.address);
  if (!existing || !lockedSelection?.locked) return false;
  const currentSelection = existing.preparedPlan?.memeRangeSelection;
  if (
    currentSelection?.locked &&
    currentSelection.lockedAt === lockedSelection.lockedAt &&
    currentSelection.mode === lockedSelection.mode
  ) {
    return false;
  }
  if (hasPreSignedSingle(existing) || hasPreSignedBundle(existing) || existing.dedicatedOpenTimer) {
    recordMarketDecision(cfg, pendingMarket(existing), "meme-selection-lock-late", {
      source,
      message: "locked Meme selection arrived after signing/timer ownership; existing prepared plan retained",
      once: false
    });
    return false;
  }
  const mergedMarket = mergeKnownEventMarket(pendingMarket(existing), {
    ...market,
    memeRangeSelection: lockedSelection
  });
  const replacement = await preparePendingRecord(cfg, mergedMarket, runtime);
  if (replacement.prepareError || !replacement.preparedPlan) {
    recordMarketDecision(cfg, mergedMarket, "meme-selection-lock-error", {
      source,
      message: replacement.prepareError ?? "locked Meme selection did not produce a plan",
      once: false
    });
    return false;
  }
  pending.set(key, replacement);
  recordMarketDecision(cfg, replacement.market, "meme-selection-locked", {
    source,
    rankSource: replacement.preparedPlan.selection?.rankSource ?? null,
    fallbackReason: replacement.preparedPlan.selection?.fallbackReason ?? null,
    selectedOutcomes: replacement.preparedPlan.outcomes?.map((outcome) => outcome.name) ?? [],
    memeRangeSelection: replacement.preparedPlan.memeRangeSelection ?? null,
    once: false
  });
  return true;
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
      兜底: plan.selection?.fallbackReason ?? "",
      ...memeRangeSelectionAlertFields(plan.memeRangeSelection)
    },
    dedupeKey: `will-buy:${String(market.address).toLowerCase()}`,
    cooldownMs: WILL_BUY_ALERT_COOLDOWN_MS
  });
}

function memeRangeSelectionAlertFields(selection) {
  if (!selection) return {};
  if (selection.mode === "middle_fallback") {
    return {
      Meme选档: "中间三档兜底",
      锁定原因: selection.reason ?? "行情或区间不可用",
      锁定时间: selection.lockedAt ?? "首次监控"
    };
  }
  return {
    Meme选档: "当前档 + 上下相邻档",
    命中档位: selection.matchedOutcomeName ?? "",
    行情快照: `${String(selection.metric ?? "metric").toUpperCase()} ${formatMetricValue(selection.evidence?.computedValue)}`,
    行情来源: selection.source?.provider ?? "",
    锁定时间: selection.lockedAt ?? "首次监控"
  };
}

function formatMetricValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  if (number >= 1e12) return `$${roundNumber(number / 1e12, 4)}T`;
  if (number >= 1e9) return `$${roundNumber(number / 1e9, 4)}B`;
  if (number >= 1e6) return `$${roundNumber(number / 1e6, 4)}M`;
  if (number >= 1e3) return `$${roundNumber(number / 1e3, 4)}K`;
  return `$${roundNumber(number, 8)}`;
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

function plannedBuyForMarket(cfg, market) {
  if (!cfg?.eventPlannedBuysFile || !market) return null;
  const plans = readPlannedBuys(cfg);
  if (plans.length === 0) return null;
  return plans.find((plan) => {
    if (!plan.enabled) return false;
    return plannedBuyMatchesMarket(plan, market);
  }) ?? null;
}

function plannedBuyAutoSellForMarket(cfg, market) {
  const active = plannedBuyForMarket(cfg, market);
  if (active) return active;
  return readPlannedBuys(cfg).find((plan) => (
    !plan.enabled &&
    plan.preserveAutoSellAfterDisable &&
    plan.autoSell &&
    plannedBuyMatchesMarket(plan, market)
  )) ?? null;
}

function plannedBuyMatchesMarket(plan, market) {
  const marketAddress = normalizePlannedBuyAddress(market?.address);
  const marketQuestion = normalizePlannedBuyQuestion(market?.question);
  const marketQuestionText = String(market?.question ?? "").trim().replace(/\s+/gu, " ");
  if (plan.market && marketAddress && plan.market === marketAddress) return true;
  if (plan.question && marketQuestion && plan.question === marketQuestion) return true;
  return Boolean(
    plan.questionRegex &&
    marketQuestionText &&
    plannedBuyQuestionRegexMatches(plan.questionRegex, marketQuestionText)
  );
}

function readPlannedBuys(cfg) {
  const file = cfg?.eventPlannedBuysFile;
  if (!file) return [];
  try {
    const stat = fs.statSync(file);
    const cacheKey = `${stat.mtimeMs}:${stat.size}`;
    const cached = plannedBuysFileCache.get(file);
    if (cached?.cacheKey === cacheKey) return cached.plans;
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.plans) ? json.plans : []);
    const plans = rows.map(normalizePlannedBuy).filter(Boolean);
    plannedBuysFileCache.set(file, { cacheKey, plans });
    return plans;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    const cached = plannedBuysFileCache.get(file);
    if (!cached?.lastErrorAt || Date.now() - cached.lastErrorAt > 60000) {
      plannedBuysFileCache.set(file, { ...cached, lastErrorAt: Date.now() });
      console.error(JSON.stringify({
        level: "warn",
        source: "planned-buys-load",
        file,
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
    }
    return cached?.plans ?? [];
  }
}

function normalizePlannedBuy(row) {
  if (!row || typeof row !== "object") return null;
  const outcomes = plannedBuyOutcomeNames(row);
  if (outcomes.length === 0) return null;
  const market = normalizePlannedBuyAddress(row.market ?? row.address);
  const question = normalizePlannedBuyQuestion(row.question ?? row.title);
  const questionRegex = normalizePlannedBuyQuestionRegex(row.questionRegex ?? row.titleRegex);
  if (!market && !question && !questionRegex) return null;
  const stakePerOutcomeUsdt = Number(row.stakePerOutcomeUsdt ?? row.stake ?? row.stakeUsdt);
  const stakeByOutcomeUsdt = normalizePlannedBuyStakeByOutcome(
    firstDefinedValue(row, ["stakeByOutcomeUsdt", "outcomeStakesUsdt", "stakesByOutcome"]),
    outcomes
  );
  const kickoffAt = normalizePlannedBuyDate(row.kickoffAt ?? row.marketStartAt ?? row.matchStartAt);
  const autoSell = normalizePlannedBuyAutoSell(row.autoSell, outcomes);
  const openBroadcastDelayMs = normalizePlannedBuyOpenBroadcastDelayMs(row);
  const gasPriceGwei = normalizePlannedBuyGasPriceGwei(row);
  const broadcastRpcUrls = normalizePlannedBuyBroadcastRpcUrls(row);
  const builderBundle = normalizePlannedBuyBuilderBundle(row);
  return {
    id: String(row.id ?? market ?? question ?? questionRegex),
    enabled: row.enabled !== false && row.disabled !== true,
    preserveAutoSellAfterDisable: row.preserveAutoSellAfterDisable === true,
    market,
    question,
    questionRegex,
    outcomes,
    stakePerOutcomeUsdt: Number.isFinite(stakePerOutcomeUsdt) && stakePerOutcomeUsdt > 0
      ? stakePerOutcomeUsdt
      : null,
    stakeByOutcomeUsdt,
    kickoffAt,
    openBroadcastDelayMs,
    gasPriceGwei,
    broadcastRpcUrls,
    builderBundle,
    autoSell,
    note: String(row.note ?? "").trim() || null
  };
}

function normalizePlannedBuyAutoSell(row, selectedOutcomes = []) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const result = {};
  takeOptionalBoolean(row, result, "autoSellEnabled", ["enabled"]);
  const strategy = normalizePlannedBuyAutoSellStrategy(firstDefinedValue(row, ["autoSellStrategy", "strategy"]));
  if (strategy) {
    result.autoSellStrategy = strategy;
    if (strategy === "hold_to_settlement") result.autoSellEnabled = false;
  }
  takeOptionalInteger(row, result, "autoSellStartDelaySeconds", ["startDelaySeconds", "startDelay"]);
  takeOptionalInteger(row, result, "autoSellIntervalSeconds", ["intervalSeconds", "interval"]);
  takeOptionalNumber(row, result, "autoSellLadderProfitPercent", ["ladderProfitPercent", "profitPercent"]);
  takeOptionalNumber(row, result, "autoSellChunkPercent", ["chunkPercent"]);
  takeOptionalInteger(row, result, "autoSellTakeProfitSteps", ["takeProfitSteps"]);
  takeOptionalInteger(row, result, "autoSellBeforeMarketStartSeconds", ["beforeMarketStartSeconds", "preStartSeconds"]);
  takeOptionalBoolean(row, result, "autoSellStopLossEnabled", ["stopLossEnabled"]);
  takeOptionalNumber(row, result, "autoSellStopLossPercent", ["stopLossPercent"]);
  takeOptionalNumber(row, result, "autoSellStopLossSellPercent", ["stopLossSellPercent"]);
  const priceTargets = normalizePlannedBuyPriceTargets(
    firstDefinedValue(row, ["priceTargets", "outcomePriceTargets", "sellPriceTargets"]),
    selectedOutcomes
  );
  if (priceTargets.length > 0) {
    result.autoSellPriceTargets = priceTargets;
    result.autoSellPriceHotPollMs = normalizePlannedBuyPositiveInteger(
      firstDefinedValue(row, ["priceHotPollMs", "hotPollMs"]),
      1000,
      "autoSell.priceHotPollMs"
    );
    result.autoSellPriceHotWindowSeconds = normalizePlannedBuyPositiveInteger(
      firstDefinedValue(row, ["priceHotWindowSeconds", "hotWindowSeconds"]),
      600,
      "autoSell.priceHotWindowSeconds"
    );
    result.autoSellPriceSellPercent = normalizePlannedBuyPercent(
      firstDefinedValue(row, ["priceSellPercent", "sellPercent"]),
      100,
      "autoSell.priceSellPercent"
    );
    const applyAfterIso = normalizePlannedBuyDate(
      firstDefinedValue(row, ["priceApplyAfterIso", "priceApplyAfter", "applyAfterIso"])
    );
    if (applyAfterIso) result.autoSellPriceApplyAfterIso = applyAfterIso;
  }
  const retainPositions = normalizePlannedBuyRetainPositions(
    firstDefinedValue(row, ["retainPositions", "retainedPositions"]),
    selectedOutcomes
  );
  if (retainPositions.length > 0) result.autoSellRetainPositions = retainPositions;
  return Object.keys(result).length > 0 ? result : null;
}

function normalizePlannedBuyPriceTargets(rows, selectedOutcomes = []) {
  if (rows === undefined || rows === null || rows === "") return [];
  const entries = Array.isArray(rows)
    ? rows
    : Object.entries(rows).map(([outcome, value]) => (
        value && typeof value === "object" && !Array.isArray(value)
          ? { outcome, ...value }
          : { outcome, price: value }
      ));
  const selectedByKey = new Map(selectedOutcomes.map((outcome) => [
    normalizePlannedBuyOutcomeName(outcome),
    String(outcome).trim()
  ]));
  const seen = new Set();
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`autoSell.priceTargets[${index}] must be an object`);
    }
    const requestedOutcome = String(firstDefinedValue(entry, ["outcome", "name", "outcomeName"]) ?? "").trim();
    const key = normalizePlannedBuyOutcomeName(requestedOutcome);
    if (!key) throw new Error(`autoSell.priceTargets[${index}].outcome is required`);
    if (seen.has(key)) throw new Error(`duplicate price target outcome after normalization: ${requestedOutcome}`);
    const selectedOutcome = selectedByKey.get(key);
    if (!selectedOutcome) throw new Error(`price target outcome is not in the planned selected outcomes: ${requestedOutcome}`);
    const price = Number(firstDefinedValue(entry, ["price", "threshold", "targetPrice", "sellPrice"]));
    if (!Number.isFinite(price) || price <= 0 || price > 1) {
      throw new Error(`invalid price target for outcome ${requestedOutcome}`);
    }
    seen.add(key);
    return {
      outcome: selectedOutcome,
      price,
      enabled: entry.enabled !== false
    };
  });
}

function normalizePlannedBuyPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function normalizePlannedBuyPercent(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) throw new Error(`${label} must be > 0 and <= 100`);
  return number;
}

function normalizePlannedBuyRetainPositions(rows, selectedOutcomes = []) {
  if (rows === undefined || rows === null || rows === "") return [];
  if (!Array.isArray(rows)) throw new Error("autoSell.retainPositions must be an array");
  const selectedByKey = new Map();
  for (const selected of selectedOutcomes) {
    const outcome = String(selected ?? "").trim();
    const key = normalizePlannedBuyOutcomeName(outcome);
    if (!key) continue;
    if (selectedByKey.has(key)) {
      throw new Error(`duplicate planned outcome after normalization: ${outcome}`);
    }
    selectedByKey.set(key, outcome);
  }
  const seen = new Set();
  return rows.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`autoSell.retainPositions[${index}] must be an object`);
    }
    const outcome = String(firstDefinedValue(entry, ["outcome", "name", "outcomeName"]) ?? "").trim();
    const key = normalizePlannedBuyOutcomeName(outcome);
    if (!key) throw new Error(`autoSell.retainPositions[${index}].outcome is required`);
    if (seen.has(key)) throw new Error(`duplicate retained outcome after normalization: ${outcome}`);
    const selectedOutcome = selectedByKey.get(key);
    if (!selectedOutcome) {
      throw new Error(`retained outcome is not in the planned selected outcomes: ${outcome}`);
    }
    const retainPercent = Number(firstDefinedValue(entry, ["retainPercent", "percent", "retainChipPercent", "chipPercent"]));
    if (!Number.isFinite(retainPercent) || retainPercent <= 0 || retainPercent > 100) {
      throw new Error(`invalid retainPercent for retained outcome ${outcome}`);
    }
    seen.add(key);
    return {
      outcome: selectedOutcome,
      retainPercent
    };
  });
}

function normalizePlannedBuyAutoSellStrategy(value) {
  if (value === undefined || value === null || value === "") return "";
  const strategy = String(value).trim().toLowerCase();
  if (["hold_to_settlement", "hold", "disabled", "off", "none"].includes(strategy)) return "hold_to_settlement";
  if (["pre_start", "prestart", "pre_start_only", "prestart_only", "hold_until_pre_start"].includes(strategy)) {
    return "pre_start_exit";
  }
  if (["ladder", "open_timed_exit", "pre_start_exit", "legacy"].includes(strategy)) return strategy;
  return "";
}

function normalizePlannedBuyOpenBroadcastDelayMs(row) {
  const rawMs = firstDefinedValue(row, ["openBroadcastDelayMs", "buyDelayMs", "broadcastDelayMs", "openDelayMs"]);
  if (rawMs !== undefined && rawMs !== null && rawMs !== "") {
    const value = Number(rawMs);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  const rawSeconds = firstDefinedValue(row, ["openBroadcastDelaySeconds", "buyDelaySeconds", "broadcastDelaySeconds", "openDelaySeconds"]);
  if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== "") {
    const value = Number(rawSeconds);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value * 1000) : null;
  }
  return null;
}

function normalizePlannedBuyGasPriceGwei(row) {
  const raw = firstDefinedValue(row, ["gasPriceGwei", "buyGasPriceGwei", "gasGwei", "buyGasGwei"]);
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.01 || value > 50) return null;
  return String(raw).trim();
}

function normalizePlannedBuyBroadcastRpcUrls(row) {
  const raw = firstDefinedValue(row, ["broadcastRpcUrls", "buyBroadcastRpcUrls", "broadcastRpcUrl", "buyBroadcastRpcUrl"]);
  if (raw === undefined || raw === null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(",");
  const seen = new Set();
  const urls = [];
  for (const item of items) {
    const url = String(item ?? "").trim();
    if (!/^https?:\/\//iu.test(url)) continue;
    try {
      new URL(url);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function normalizePlannedBuyBuilderBundle(row) {
  const nested = row?.builderBundle && typeof row.builderBundle === "object" && !Array.isArray(row.builderBundle)
    ? row.builderBundle
    : null;
  const source = nested ?? row;
  const directKeys = [
    "builderBundleEnabled",
    "builderBundleUrl",
    "builderBundleTipTo",
    "builderBundleTipBnb",
    "builderBundleTipGasPriceGwei",
    "builderBundleMaxBlocks",
    "builderBundleMaxBlockLookup",
    "builderBundleMaxTimestampOffsetSeconds",
    "builderBundleTimeoutMs",
    "builderBundleMode",
    "builderBundleFanoutDelayMs",
    "builderBundleTimingMode",
    "builderBundlePrepositionLeadMs",
    "builderBundleFallbackSafetyMs",
    "builderBundleEarlySubmitLeadMs",
    "builderBundleMinTimestampOffsetMs",
    "builderBundleNoMerge",
    "builderBundlePositionFirst",
    "builderBundle48spSign",
    "builderTimestampGuardEnabled",
    "builderTimestampGuardAddress",
    "builderTimestampGuardGasLimit",
    "builderTimestampGuardRetryIntervalMs",
    "builderTimestampGuardRetryUntilLeadMs",
    "builderTimestampGuardReleasePollMs"
  ];
  const nestedKeys = [
    "enabled",
    "url",
    "tipTo",
    "tipBnb",
    "tipGasPriceGwei",
    "maxBlocks",
    "maxBlockLookup",
    "maxTimestampOffsetSeconds",
    "timeoutMs",
    "mode",
    "fanoutDelayMs",
    "timingMode",
    "prepositionLeadMs",
    "fallbackSafetyMs",
    "earlySubmitLeadMs",
    "minTimestampOffsetMs",
    "noMerge",
    "positionFirst",
    "48spSign",
    "timestampGuardEnabled",
    "timestampGuardAddress",
    "timestampGuardGasLimit",
    "timestampGuardRetryIntervalMs",
    "timestampGuardRetryUntilLeadMs",
    "timestampGuardReleasePollMs"
  ];
  const hasConfig = nested
    ? nestedKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key))
    : directKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (!hasConfig) return null;

  const result = {};
  const enabled = firstDefinedValue(source, nested ? ["enabled", "builderBundleEnabled"] : ["builderBundleEnabled"]);
  if (enabled !== undefined && enabled !== null && enabled !== "") result.builderBundleEnabled = parseLooseBoolean(enabled);
  const url = String(firstDefinedValue(source, nested ? ["url", "builderBundleUrl"] : ["builderBundleUrl"]) ?? "").trim();
  if (url && /^https?:\/\//iu.test(url)) {
    try {
      new URL(url);
      result.builderBundleUrl = url;
    } catch {}
  }
  const tipTo = String(firstDefinedValue(source, nested ? ["tipTo", "builderBundleTipTo"] : ["builderBundleTipTo"]) ?? "").trim();
  if (/^0x[a-fA-F0-9]{40}$/u.test(tipTo)) result.builderBundleTipTo = tipTo;
  const tipBnb = firstDefinedValue(source, nested ? ["tipBnb", "tip", "tipAmountBnb", "builderBundleTipBnb"] : ["builderBundleTipBnb"]);
  if (tipBnb !== undefined && tipBnb !== null && tipBnb !== "") {
    const value = Number(tipBnb);
    if (Number.isFinite(value) && value >= 0 && value <= 10) result.builderBundleTipBnb = String(tipBnb).trim();
  }
  const tipGas = firstDefinedValue(source, nested ? ["tipGasPriceGwei", "tipGasGwei", "builderBundleTipGasPriceGwei"] : ["builderBundleTipGasPriceGwei"]);
  if (tipGas !== undefined && tipGas !== null && tipGas !== "") {
    const value = Number(tipGas);
    if (Number.isFinite(value) && value >= 0.01 && value <= 50) result.builderBundleTipGasPriceGwei = String(tipGas).trim();
  }
  takeOptionalInteger(source, result, "builderBundleMaxBlocks", nested ? ["maxBlocks"] : []);
  const maxBlockLookup = firstDefinedValue(source, nested ? ["maxBlockLookup", "useMaxBlock", "builderBundleMaxBlockLookup"] : ["builderBundleMaxBlockLookup"]);
  if (maxBlockLookup !== undefined && maxBlockLookup !== null && maxBlockLookup !== "") {
    result.builderBundleMaxBlockLookup = parseLooseBoolean(maxBlockLookup);
  }
  takeOptionalInteger(source, result, "builderBundleMaxTimestampOffsetSeconds", nested ? ["maxTimestampOffsetSeconds"] : []);
  takeOptionalInteger(source, result, "builderBundleTimeoutMs", nested ? ["timeoutMs"] : []);
  takeOptionalInteger(source, result, "builderBundleFanoutDelayMs", nested ? ["fanoutDelayMs", "publicFanoutDelayMs", "delayedPublicFanoutMs"] : []);
  takeOptionalInteger(source, result, "builderBundlePrepositionLeadMs", nested ? ["prepositionLeadMs"] : []);
  takeOptionalInteger(source, result, "builderBundleFallbackSafetyMs", nested ? ["fallbackSafetyMs"] : []);
  takeOptionalInteger(source, result, "builderBundleEarlySubmitLeadMs", nested ? ["earlySubmitLeadMs", "preSubmitLeadMs"] : []);
  takeOptionalInteger(source, result, "builderBundleMinTimestampOffsetMs", nested ? ["minTimestampOffsetMs", "notBeforeOffsetMs"] : []);
  if (
    result.builderBundleFanoutDelayMs !== undefined &&
    (result.builderBundleFanoutDelayMs < 0 || result.builderBundleFanoutDelayMs > 5000)
  ) {
    delete result.builderBundleFanoutDelayMs;
  }
  if (
    result.builderBundleEarlySubmitLeadMs !== undefined &&
    (result.builderBundleEarlySubmitLeadMs < 0 || result.builderBundleEarlySubmitLeadMs > 5000)
  ) {
    delete result.builderBundleEarlySubmitLeadMs;
  }
  if (
    result.builderBundlePrepositionLeadMs !== undefined &&
    (result.builderBundlePrepositionLeadMs <= 0 || result.builderBundlePrepositionLeadMs > 5000)
  ) {
    delete result.builderBundlePrepositionLeadMs;
  }
  if (
    result.builderBundleFallbackSafetyMs !== undefined &&
    (result.builderBundleFallbackSafetyMs < 0 || result.builderBundleFallbackSafetyMs > 5000)
  ) {
    delete result.builderBundleFallbackSafetyMs;
  }
  if (
    result.builderBundleMinTimestampOffsetMs !== undefined &&
    (result.builderBundleMinTimestampOffsetMs < 0 || result.builderBundleMinTimestampOffsetMs > 24 * 60 * 60 * 1000)
  ) {
    delete result.builderBundleMinTimestampOffsetMs;
  }
  const mode = String(firstDefinedValue(source, nested ? ["mode", "builderBundleMode"] : ["builderBundleMode"]) ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  if (["concurrent", "builder_only", "builder_then_fanout"].includes(mode)) result.builderBundleMode = mode;
  const timingMode = String(firstDefinedValue(source, nested ? ["timingMode", "builderBundleTimingMode"] : ["builderBundleTimingMode"]) ?? "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  if (["legacy", "auto", "first_19s_block", "first_20s_block"].includes(timingMode)) {
    result.builderBundleTimingMode = timingMode;
  }
  const noMerge = firstDefinedValue(source, nested ? ["noMerge", "builderBundleNoMerge"] : ["builderBundleNoMerge"]);
  if (noMerge !== undefined && noMerge !== null && noMerge !== "") result.builderBundleNoMerge = parseLooseBoolean(noMerge);
  const positionFirst = firstDefinedValue(source, nested ? ["positionFirst", "builderBundlePositionFirst"] : ["builderBundlePositionFirst"]);
  if (positionFirst !== undefined && positionFirst !== null && positionFirst !== "") {
    result.builderBundlePositionFirst = parseLooseBoolean(positionFirst);
  }
  const sign = String(firstDefinedValue(source, nested ? ["48spSign", "builderBundle48spSign"] : ["builderBundle48spSign"]) ?? "").trim();
  if (sign) result.builderBundle48spSign = sign;
  const guardEnabled = firstDefinedValue(
    source,
    nested ? ["timestampGuardEnabled", "builderTimestampGuardEnabled"] : ["builderTimestampGuardEnabled"]
  );
  if (guardEnabled !== undefined && guardEnabled !== null && guardEnabled !== "") {
    result.builderTimestampGuardEnabled = parseLooseBoolean(guardEnabled);
  }
  const guardAddress = String(firstDefinedValue(
    source,
    nested ? ["timestampGuardAddress", "builderTimestampGuardAddress"] : ["builderTimestampGuardAddress"]
  ) ?? "").trim();
  if (/^0x[a-fA-F0-9]{40}$/u.test(guardAddress)) result.builderTimestampGuardAddress = guardAddress;
  takeOptionalInteger(source, result, "builderTimestampGuardGasLimit", nested ? ["timestampGuardGasLimit"] : []);
  takeOptionalInteger(source, result, "builderTimestampGuardRetryIntervalMs", nested ? ["timestampGuardRetryIntervalMs"] : []);
  takeOptionalInteger(source, result, "builderTimestampGuardRetryUntilLeadMs", nested ? ["timestampGuardRetryUntilLeadMs"] : []);
  takeOptionalInteger(source, result, "builderTimestampGuardReleasePollMs", nested ? ["timestampGuardReleasePollMs"] : []);
  return Object.keys(result).length > 0 ? result : null;
}

function plannedBuyBuilderBundleOverrides(plan) {
  const overrides = plan?.builderBundle ?? plan?.plannedBuy?.builderBundle;
  if (!overrides) return {};
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function takeOptionalNumber(source, target, key, aliases = []) {
  const raw = firstDefinedValue(source, [key, ...aliases]);
  if (raw === undefined || raw === null || raw === "") return;
  const value = Number(raw);
  if (Number.isFinite(value)) target[key] = value;
}

function takeOptionalInteger(source, target, key, aliases = []) {
  const raw = firstDefinedValue(source, [key, ...aliases]);
  if (raw === undefined || raw === null || raw === "") return;
  const value = Number(raw);
  if (Number.isFinite(value)) target[key] = Math.floor(value);
}

function takeOptionalBoolean(source, target, key, aliases = []) {
  const raw = firstDefinedValue(source, [key, ...aliases]);
  if (raw === undefined || raw === null || raw === "") return;
  target[key] = parseLooseBoolean(raw);
}

function firstDefinedValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function parseLooseBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function plannedBuyOutcomeNames(row) {
  const raw = row.outcomes ?? row.outcomeNames ?? row.names;
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePlannedBuyStakeByOutcome(value, selectedOutcomes = []) {
  if (value === undefined || value === null || value === "") return {};
  const entries = Array.isArray(value)
    ? value.map((row) => [row?.outcome ?? row?.name, row?.stakeUsdt ?? row?.amountUsdt ?? row?.stake])
    : value && typeof value === "object"
      ? Object.entries(value)
      : null;
  if (!entries) throw new Error("stakeByOutcomeUsdt must be an object or array");

  const selectedByKey = new Map(selectedOutcomes.map((outcome) => [
    normalizePlannedBuyOutcomeName(outcome),
    String(outcome).trim()
  ]));
  const result = {};
  const seen = new Set();
  for (const [rawOutcome, rawStake] of entries) {
    const requestedOutcome = String(rawOutcome ?? "").trim();
    const key = normalizePlannedBuyOutcomeName(requestedOutcome);
    if (!key) throw new Error("stakeByOutcomeUsdt contains an empty outcome name");
    if (seen.has(key)) throw new Error(`duplicate outcome stake override after normalization: ${requestedOutcome}`);
    const selectedOutcome = selectedByKey.get(key);
    if (!selectedOutcome) throw new Error(`outcome stake override is not in planned outcomes: ${requestedOutcome}`);
    const stakeUsdt = Number(rawStake);
    if (!Number.isFinite(stakeUsdt) || stakeUsdt <= 0) {
      throw new Error(`invalid outcome stake override for ${requestedOutcome}`);
    }
    seen.add(key);
    result[selectedOutcome] = stakeUsdt;
  }
  return result;
}

function normalizePlannedBuyAddress(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/u.test(text) ? text : "";
}

function normalizePlannedBuyQuestion(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normalizePlannedBuyQuestionRegex(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  new RegExp(text, "iu");
  return text;
}

function plannedBuyQuestionRegexMatches(pattern, question) {
  try {
    return new RegExp(pattern, "iu").test(question);
  } catch {
    return false;
  }
}

function normalizePlannedBuyOutcomeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\u2265/gu, ">=")
    .replace(/\u2264/gu, "<=")
    .replace(/\s+/gu, " ")
    .replace(/([<>]=?)\s+(?=[\d.])/gu, "$1")
    .toLowerCase();
}

function normalizePlannedBuyDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function plannedBuyConfigForMarket(cfg, market) {
  const plan = plannedBuyForMarket(cfg, market);
  if (!plan) return applyBuilderBundleTimingPreset(cfg);
  const stakePerOutcomeUsdt = Number(plan.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  const stakeByOutcomeUsdt = plan.stakeByOutcomeUsdt ?? {};
  const outcomeStakesUsdt = plan.outcomes.map((outcome) => Number(stakeByOutcomeUsdt[outcome] ?? stakePerOutcomeUsdt));
  const totalStakeUsdt = roundUsd(outcomeStakesUsdt.reduce((sum, stake) => sum + stake, 0));
  const maxStakePerOutcomeUsdt = Math.max(stakePerOutcomeUsdt, ...outcomeStakesUsdt);
  return applyBuilderBundleTimingPreset({
    ...cfg,
    ...plannedBuyBuilderBundleOverrides(plan),
    eventOutcomeSelection: "names",
    eventOutcomeNames: plan.outcomes.join(","),
    eventOutcomeCount: plan.outcomes.length,
    stakePerOutcomeUsdt,
    stakeByOutcomeUsdt,
    maxStakeUsdt: Math.max(Number(cfg.maxStakeUsdt ?? 0), maxStakePerOutcomeUsdt),
    maxOutcomesPerMarket: Math.max(Number(cfg.maxOutcomesPerMarket ?? 0), plan.outcomes.length),
    maxMarketStakeUsdt: Math.max(Number(cfg.maxMarketStakeUsdt ?? 0), totalStakeUsdt),
    maxBatchStakeUsdt: Math.max(Number(cfg.maxBatchStakeUsdt ?? 0), totalStakeUsdt),
    gasPriceGwei: plan.gasPriceGwei ?? cfg.gasPriceGwei,
    openBroadcastDelayMs: plan.openBroadcastDelayMs ?? cfg.openBroadcastDelayMs,
    broadcastRpcUrls: plan.broadcastRpcUrls?.length ? plan.broadcastRpcUrls : cfg.broadcastRpcUrls,
    plannedBuy: {
      id: plan.id,
      market: plan.market,
      question: plan.question,
      outcomes: plan.outcomes,
      stakePerOutcomeUsdt,
      stakeByOutcomeUsdt,
      maxStakePerOutcomeUsdt,
      totalStakeUsdt,
      kickoffAt: plan.kickoffAt,
      openBroadcastDelayMs: plan.openBroadcastDelayMs,
      gasPriceGwei: plan.gasPriceGwei,
      broadcastRpcUrls: plan.broadcastRpcUrls,
      builderBundle: plan.builderBundle,
      autoSell: plan.autoSell,
      note: plan.note
    }
  });
}

function eventBuyConfigForMarket(cfg, market) {
  if (plannedBuyForMarket(cfg, market)) return plannedBuyConfigForMarket(cfg, market);
  return applyBuilderBundleTimingPreset(
    bot3FifaExactScoreConfigForMarket(cfg, market) ??
    bot2LikeMemeBuyConfigForMarket(cfg, market) ??
    cfg
  );
}

function bot2LikeMemeBuyConfigForMarket(cfg, market) {
  if (!cfg.memeRangeSelectionEnabled || !isBot2LikeMemeProfile(cfg) || !isMemeIntelMarket(market)) return null;
  const lockedSelection = market.memeRangeSelection ?? readMemeRangeSelectionLock(cfg, market.address);
  const selectionMarket = lockedSelection ? { ...market, memeRangeSelection: lockedSelection } : market;
  const requestedOutcomeCount = Math.min(
    Math.max(1, Number(cfg.memeRangeSelectionOutcomeCount ?? 3)),
    Math.max(1, market?.outcomes?.length ?? 1)
  );
  const selectedOutcomeNames = lockedMemeRangeOutcomeNames(selectionMarket, requestedOutcomeCount);
  if (selectedOutcomeNames.length > 0) {
    return {
      ...cfg,
      eventOutcomeSelection: "names",
      eventOutcomeNames: selectedOutcomeNames.join(","),
      eventOutcomeCount: selectedOutcomeNames.length,
      memeRangeSelection: {
        ...lockedSelection,
        executionOutcomeCount: selectedOutcomeNames.length,
        executionSelectedOutcomeNames: selectedOutcomeNames
      }
    };
  }
  return {
    ...cfg,
    eventOutcomeSelection: "middle",
    eventOutcomeNames: "",
    eventOutcomeCount: requestedOutcomeCount,
    memeRangeSelection: {
      locked: true,
      mode: "middle_fallback",
      metric: null,
      reason: "meme_event_without_locked_metric_selection",
      selectedOutcomeNames: [],
      executionOutcomeCount: requestedOutcomeCount
    }
  };
}

function attachMemeRangeSelectionLock(cfg, market) {
  if (!cfg.memeRangeSelectionEnabled || !isBot2LikeMemeProfile(cfg) || !market?.address) return market;
  if (market.memeRangeSelection?.locked) return market;
  const selection = readMemeRangeSelectionLock(cfg, market.address);
  return selection ? { ...market, memeRangeSelection: selection } : market;
}

function readMemeRangeSelectionLock(cfg, marketAddress) {
  const file = String(cfg?.memeRangeSelectionFile ?? "").trim();
  const address = String(marketAddress ?? "").toLowerCase();
  if (!file || !address) return null;
  try {
    const stat = fs.statSync(file);
    let cached = memeRangeSelectionFileCache.get(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      const locks = new Map();
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const selection = row?.selection ?? row;
          const key = String(selection?.market ?? row?.market ?? "").toLowerCase();
          if (!key || !selection?.locked || !Array.isArray(selection.selectedOutcomeNames)) continue;
          locks.set(key, selection);
        } catch {
          // A partial trailing JSONL row must not hide earlier durable locks.
        }
      }
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, locks };
      memeRangeSelectionFileCache.set(file, cached);
    }
    return cached.locks.get(address) ?? null;
  } catch {
    return null;
  }
}

function isBot2LikeMemeProfile(cfg) {
  const botName = String(cfg?.botName ?? "").trim().toLowerCase();
  const role = String(cfg?.profileRole ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
  return role === "bot2_like" ||
    botName === "42space-2" ||
    botName === "bot2" ||
    botName.startsWith("bot2") ||
    botName === "42space-5" ||
    botName === "bot5" ||
    botName.startsWith("bot5") ||
    botName.includes("bot5");
}

function clearSeenForFuturePlannedBuy(cfg, seen, market, source) {
  return clearSeenForFutureEligibleBuy(cfg, seen, market, source, { requirePlannedBuy: true });
}

function clearSeenForFutureEligibleBuy(cfg, seen, market, source, { requirePlannedBuy = false } = {}) {
  if (!seen || !market) return false;
  const key = eventSeenKey(market, cfg);
  if (!seen.has(key)) return false;
  const planned = plannedBuyForMarket(cfg, market);
  if (requirePlannedBuy && !planned) return false;
  if (msUntilStart(market) <= 0) return false;
  if (msUntilRecordAction({ market, openBroadcastDelayMs: planned?.openBroadcastDelayMs ?? null }, cfg) <= 0) return false;
  if (isMarketFollowBlocked(market, cfg)) return false;
  const decision = marketFilterDecision(market, cfg);
  if (!decision.eligible) return false;
  seen.delete(key);
  recordMarketDecision(cfg, market, "seen-override", {
    source,
    message: planned ? "planned buy overrides prior seen record" : "future eligible buy overrides prior seen record",
    decision,
    once: false
  });
  return true;
}

function annotatePlannedBuyPlan(plan, buyCfg) {
  if (!buyCfg?.plannedBuy) return plan;
  return {
    ...plan,
    plannedBuy: buyCfg.plannedBuy,
    selection: {
      ...(plan.selection ?? {}),
      plannedBuy: true,
      plannedBuyId: buyCfg.plannedBuy.id
    }
  };
}

function annotateBuyConfigPlan(plan, buyCfg) {
  return annotateBot3FifaExactScorePlan(
    annotateMemeRangeSelectionPlan(annotatePlannedBuyPlan(plan, buyCfg), buyCfg),
    buyCfg
  );
}

function annotateMemeRangeSelectionPlan(plan, buyCfg) {
  const selection = buyCfg?.memeRangeSelection;
  if (!selection) return plan;
  return {
    ...plan,
    memeRangeSelection: selection,
    selection: {
      ...(plan.selection ?? {}),
      memeRangeSelection: true,
      memeRangeSelectionMode: selection.mode ?? null,
      memeRangeMetric: selection.metric ?? null,
      memeRangeMatchedOutcome: selection.matchedOutcomeName ?? null,
      memeRangeComputedValue: selection.evidence?.computedValue ?? null,
      memeRangeSourceProvider: selection.source?.provider ?? null,
      memeRangeLockedAt: selection.lockedAt ?? null,
      fallbackReason: selection.mode === "middle_fallback"
        ? selection.reason ?? plan.selection?.fallbackReason ?? "meme_middle_fallback"
        : plan.selection?.fallbackReason ?? null
    }
  };
}

function executionConfigForPlan(cfg, plan) {
  if (!plan?.selection?.plannedBuy) return applyBuilderBundleTimingPreset(cfg);
  const totalStakeUsdt = Number(plan.totalStakeUsdt ?? 0);
  const stakePerOutcomeUsdt = Number(plan.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  const maxStakePerOutcomeUsdt = Math.max(
    stakePerOutcomeUsdt,
    ...(plan.outcomes ?? []).map((outcome) => Number(outcome?.stakeUsdt ?? 0))
  );
  return applyBuilderBundleTimingPreset({
    ...cfg,
    ...plannedBuyBuilderBundleOverrides(plan),
    eventOutcomeSelection: "names",
    eventOutcomeNames: plan.plannedBuy?.outcomes?.join(",") ?? cfg.eventOutcomeNames,
    eventOutcomeCount: plan.outcomes?.length ?? cfg.eventOutcomeCount,
    stakePerOutcomeUsdt,
    stakeByOutcomeUsdt: plan.stakeByOutcomeUsdt ?? plan.plannedBuy?.stakeByOutcomeUsdt ?? {},
    maxStakeUsdt: Math.max(Number(cfg.maxStakeUsdt ?? 0), maxStakePerOutcomeUsdt),
    maxMarketStakeUsdt: Math.max(Number(cfg.maxMarketStakeUsdt ?? 0), totalStakeUsdt),
    maxBatchStakeUsdt: Math.max(Number(cfg.maxBatchStakeUsdt ?? 0), totalStakeUsdt),
    gasPriceGwei: plan.plannedBuy?.gasPriceGwei ?? cfg.gasPriceGwei,
    openBroadcastDelayMs: plan.plannedBuy?.openBroadcastDelayMs ?? cfg.openBroadcastDelayMs,
    broadcastRpcUrls: plan.plannedBuy?.broadcastRpcUrls?.length
      ? plan.plannedBuy.broadcastRpcUrls
      : cfg.broadcastRpcUrls
  });
}

function marketFilterDecision(market, cfg) {
  const decisionMarket = attachMemeRangeSelectionLock(cfg, market);
  const decision = getEventMarketDecision(decisionMarket, cfg);
  const planned = plannedBuyForMarket(cfg, decisionMarket);
  if (planned && !["missing-market", "status", "no-outcomes"].includes(decision.reason)) {
    return {
      ...decision,
      eligible: true,
      reason: "planned-buy",
      reasonText: "手动计划买入",
      tags: [...(decision.tags ?? []), "计划买入"]
    };
  }
  const bot3Fifa = bot3FifaExactScoreConfigForMarket(cfg, decisionMarket)?.bot3FifaExactScoreAutoBuy?.preview ?? null;
  if (bot3Fifa && !["missing-market", "status", "no-outcomes", "price-market"].includes(decision.reason)) {
    return {
      ...decision,
      eligible: true,
      reason: "bot3-fifa-exact-score-auto-buy",
      reasonText: "FIFA 精确比分最低价格档自动买入",
      tags: [
        ...(decision.tags ?? []),
        "精确比分自动买入",
        "FIFA 精确比分",
        "最低价格档",
        bot3Fifa.selectedSide === "home_win" ? "主队胜档" : "客队胜档"
      ]
    };
  }
  if (!decision.eligible) return decision;
  if (filterEventMarkets([decisionMarket], cfg).length > 0) return decision;
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
    selectedOutcomes: details.selectedOutcomes ?? null,
    memeRangeSelection: details.memeRangeSelection ?? null,
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

function groupRecordsByActionTime(records, cfg, runtime = null) {
  const groups = new Map();
  for (const record of records) {
    const key = stableRecordActionGroupTimeMs(record, cfg, runtime);
    if (!Number.isFinite(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return groups;
}

function stableRecordActionGroupTimeMs(record, cfg, runtime = null) {
  const timing = openBroadcastTimingForRecord(record, cfg, runtime);
  if (timing.mode === "block_aware_20s") return timing.fixedTargetMs;
  return timing.targetMs;
}

function strictBuilderTargetKeyForRecord(record, cfg) {
  const market = pendingMarket(record);
  const startMs = Date.parse(market?.startDate ?? "");
  if (!Number.isFinite(startMs)) return null;
  const executionCfg = executionConfigForPlan(cfg, record?.preparedPlan);
  const timing = executionCfg.builderBundleTimingResolved ?? resolveBuilderBundleTimingPreset(executionCfg);
  if (!executionCfg.builderBundleEnabled || !timing.strict || !timing.eligible) return null;
  const targetTimestamp = Math.ceil((startMs + timing.targetSecond * 1000) / 1000);
  return `${targetTimestamp}:${timing.targetSecond}`;
}

function assignStrictBuilderLaneAdmission(cfg, records) {
  const split = splitRecordsByStrictBuilderLane(cfg, records);
  for (const record of split.selected) record.strictBuilderLaneBlocked = false;
  for (const record of split.skipped) record.strictBuilderLaneBlocked = true;
  return new Set(split.selected.map((record) => eventSeenKey(pendingMarket(record), cfg)));
}

function splitRecordsByStrictBuilderLane(cfg, records) {
  const selected = [];
  const skipped = [];
  const strictGroups = new Map();
  for (const record of records) {
    const targetKey = strictBuilderTargetKeyForRecord(record, cfg);
    if (!targetKey) {
      selected.push(record);
      continue;
    }
    if (!strictGroups.has(targetKey)) strictGroups.set(targetKey, []);
    strictGroups.get(targetKey).push(record);
  }
  for (const group of strictGroups.values()) {
    const sorted = sortRecordsByBuyPriority(group);
    selected.push(sorted[0]);
    skipped.push(...sorted.slice(1));
  }
  return { selected, skipped };
}

async function markStrictBuilderLaneSkippedRecords(cfg, seen, pending, runtime, records, source) {
  if (!records.length) return;
  let resetNonce = false;
  for (const record of records) {
    const market = pendingMarket(record);
    const key = eventSeenKey(market, cfg);
    if (hasPreSignedSingle(record) || hasPreSignedBundle(record)) resetNonce = true;
    clearPreSignedSingleRecord(record, "builder-wallet-lane-conflict");
    clearPreSignedBundleRecords([record], "builder-wallet-lane-conflict");
    pending?.delete?.(key);
    seen.add(key);
    const row = {
      level: "event-skip-builder-wallet-lane",
      source,
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      reason: "one wallet can submit only one strict builder bundle per target second",
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    recordMarketDecision(cfg, market, "skipped", {
      source,
      message: row.reason,
      dedupeKey: `${String(market.address).toLowerCase()}:skipped-builder-wallet-lane`
    });
    console.error(JSON.stringify(row));
    notifyFeishu(cfg, {
      title: "Builder 同钱包同秒冲突，已跳过",
      level: "warn",
      fields: {
        market: market.address,
        question: market.question,
        startDate: market.startDate
      },
      dedupeKey: `builder-wallet-lane:${String(market.address).toLowerCase()}`,
      cooldownMs: cfg.feishuAlertCooldownMs
    });
  }
  if (resetNonce) await resetRuntimeNonceToPending(cfg, runtime, "builder_wallet_lane_conflict");
  saveSeen(cfg.stateFile, seen);
}

function recordKeysWithinOpenLimit(cfg, records) {
  const limit = Number(cfg.eventMaxDueMarketsPerOpen ?? 0);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const selected = new Set();
  for (const group of groupRecordsByStartDate(records).values()) {
    const sorted = sortRecordsByBuyPriority(group);
    const planned = sorted.filter((record) => isPlannedBuyItem(record, cfg));
    const picked = planned.length > 0 ? planned : sorted.slice(0, limit);
    for (const record of picked) {
      selected.add(eventSeenKey(pendingMarket(record), cfg));
    }
  }
  return selected;
}

function splitRecordsByOpenLimit(cfg, records) {
  const allowedKeys = recordKeysWithinOpenLimit(cfg, records);
  if (!allowedKeys) return { selected: records, skipped: [] };
  const selected = [];
  const skipped = [];
  for (const record of records) {
    if (allowedKeys.has(eventSeenKey(pendingMarket(record), cfg))) selected.push(record);
    else skipped.push(record);
  }
  return { selected, skipped };
}

async function markOpenLimitSkippedRecords(cfg, seen, pending, runtime, records, source) {
  if (!records.length) return;
  let resetNonce = false;
  for (const record of records) {
    const market = pendingMarket(record);
    const key = eventSeenKey(market, cfg);
    if (hasPreSignedSingle(record) || hasPreSignedBundle(record)) resetNonce = true;
    clearPreSignedSingleRecord(record, "open-market-limit");
    clearPreSignedBundleRecords([record], "open-market-limit");
    pending?.delete?.(key);
    seen.add(key);
    const row = {
      level: "event-skip-open-market-limit",
      source,
      market: market.address,
      question: market.question,
      startDate: market.startDate,
      maxDueMarketsPerOpen: cfg.eventMaxDueMarketsPerOpen,
      reason: `only first ${cfg.eventMaxDueMarketsPerOpen} market(s) per open are enabled`,
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    recordMarketDecision(cfg, market, "skipped", {
      source,
      message: row.reason,
      dedupeKey: `${String(market.address).toLowerCase()}:skipped-open-market-limit`
    });
    console.error(JSON.stringify(row));
  }
  if (resetNonce) await resetRuntimeNonceToPending(cfg, runtime, "open_market_limit");
  saveSeen(cfg.stateFile, seen);
}

function selectedOutcomeCount(market, cfg) {
  return estimateSelectedOutcomeCount(market, eventBuyConfigForMarket(cfg, market));
}

function selectedStakeUsdt(market, cfg) {
  const buyCfg = eventBuyConfigForMarket(cfg, market);
  const plannedTotal = Number(buyCfg.plannedBuy?.totalStakeUsdt);
  if (Number.isFinite(plannedTotal) && plannedTotal > 0) return plannedTotal;
  return buyCfg.stakePerOutcomeUsdt * selectedOutcomeCount(market, cfg);
}

function batchSelectedOutcomeCount(markets, cfg) {
  return markets.reduce((sum, market) => sum + selectedOutcomeCount(market, cfg), 0);
}

function batchSelectedStakeUsdt(markets, cfg) {
  return roundUsd(markets.reduce((sum, market) => sum + selectedStakeUsdt(market, cfg), 0));
}

function routerApprovalRequiredUsdt(cfg) {
  const bot3FifaAutoRequired = bot3FifaExactScoreAutoFallbackBusdt(cfg) ?? 0;
  return roundUsd(Math.max(
    cfg.maxMarketStakeUsdt,
    cfg.maxBatchStakeUsdt,
    cfg.stakePerOutcomeUsdt * estimateMaxSelectedOutcomeCount(cfg),
    bot3FifaAutoRequired
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
  const budget = walletBudgetUsdt(cfg, walletStatus, records);
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
  const budget = walletBudgetUsdt(cfg, walletStatus, markets);
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
  return walletHasBnbForMarkets(cfg, records.map((record) => recordFundingSummary(record, cfg)), walletStatus);
}

function walletHasBnbForMarkets(cfg, markets, walletStatus) {
  if (!walletStatus?.bnbBalance) return true;
  try {
    const reserve = calculateFundingGasReserve(cfg, fundingForMarketSummaries(cfg, markets));
    return Number(walletStatus.bnbBalance) >= Number(reserve.requiredBnb);
  } catch {
    return true;
  }
}

function walletBudgetUsdt(cfg, walletStatus, items = []) {
  if (!walletStatus) return 0;
  const plannedCap = plannedBatchStakeCap(cfg, items);
  const bot3FifaAutoCap = bot3FifaExactScoreAutoFallbackBusdt(cfg) ?? 0;
  const batchCap = Math.max(Number(cfg.maxBatchStakeUsdt ?? 0), plannedCap, bot3FifaAutoCap);
  return roundUsd(Math.max(0, Math.min(
    Number(walletStatus.busdtBalance ?? 0),
    Number(walletStatus.busdtAllowanceToRouter ?? 0),
    batchCap || Infinity
  )));
}

function plannedBatchStakeCap(cfg, items = []) {
  return roundUsd((items ?? []).reduce((sum, item) => {
    if (!isPlannedBuyItem(item, cfg)) return sum;
    return sum + itemStakeUsdt(item, cfg);
  }, 0));
}

function isPlannedBuyItem(item, cfg) {
  if (item?.preparedPlan?.selection?.plannedBuy) return true;
  return Boolean(plannedBuyForMarket(cfg, pendingMarket(item)));
}

function itemStakeUsdt(item, cfg) {
  return Number(item?.preparedPlan?.totalStakeUsdt ?? item?.totalStakeUsdt ?? selectedStakeUsdt(pendingMarket(item), cfg));
}

function recordFundingSummary(record, cfg) {
  const market = pendingMarket(record);
  return marketFundingSummary(market, cfg, {
    totalStakeUsdt: recordStakeUsdt(record, cfg),
    outcomeCount: record?.preparedPlan?.outcomes?.length ?? selectedOutcomeCount(market, cfg),
    gasPriceGwei: record?.preparedPlan?.plannedBuy?.gasPriceGwei ?? null
  });
}

function marketFundingSummary(market, cfg, overrides = {}) {
  const gasPriceGwei = overrides.gasPriceGwei ?? plannedBuyForMarket(cfg, market)?.gasPriceGwei ?? null;
  return {
    ...market,
    totalStakeUsdt: overrides.totalStakeUsdt ?? roundUsd(selectedStakeUsdt(market, cfg)),
    outcomeCount: overrides.outcomeCount ?? selectedOutcomeCount(market, cfg),
    availableOutcomeCount: market?.outcomes?.length ?? 0,
    gasPriceGwei
  };
}

function fundingForMarketSummaries(cfg, markets, baseFunding = {}) {
  const sorted = [...(markets ?? [])];
  const requiredBusdt = roundUsd(sorted.reduce((sum, market) => {
    return sum + Number(market.totalStakeUsdt ?? selectedStakeUsdt(market, cfg));
  }, 0));
  const gasPrices = sorted
    .map((market) => Number(market.gasPriceGwei))
    .filter((value) => Number.isFinite(value) && value > 0);
  const nextBatchGasPriceGwei = gasPrices.length > 0 ? String(Math.max(...gasPrices)) : baseFunding.nextBatchGasPriceGwei;
  return {
    ...baseFunding,
    reason: sorted.length > 0 ? "affordable_opening_subset" : (baseFunding.reason ?? "single_market_upper_bound"),
    requiredBusdt,
    nextBatchRequiredBusdt: requiredBusdt,
    nextBatchMarketCount: sorted.length,
    nextBatchOutcomeCount: sorted.reduce((sum, market) => sum + Number(market.outcomeCount ?? selectedOutcomeCount(market, cfg)), 0),
    nextBatchAvailableOutcomeCount: sorted.reduce((sum, market) => sum + Number(market.availableOutcomeCount ?? market.outcomes?.length ?? 0), 0),
    nextBatchStartDate: sorted[0]?.startDate ?? baseFunding.nextBatchStartDate ?? null,
    nextBatchGasPriceGwei,
    nextBatchMarkets: sorted
  };
}

async function estimateFundingGasReserve(publicClient, cfg, funding = {}) {
  const direct = calculateFundingGasReserve(cfg, funding);
  if (direct) return direct;
  return estimateFastGasReserve(publicClient, cfg, funding);
}

function calculateFundingGasReserve(cfg, funding = {}) {
  const markets = Array.isArray(funding.nextBatchMarkets) ? funding.nextBatchMarkets : [];
  if (markets.length === 1) {
    const marketCfg = eventBuyConfigForMarket(cfg, markets[0]);
    return calculateFastGasReserve(marketCfg, funding);
  }
  if (cfg.bundleDueMarkets || markets.length === 0) {
    return calculateFastGasReserve(cfg, funding);
  }

  let requiredWei = 0n;
  let gasLimit = 0n;
  let maxGasPriceWei = 0n;
  const perMarket = [];
  for (const market of markets) {
    const marketFunding = fundingForMarketSummaries(cfg, [market], funding);
    const marketCfg = eventBuyConfigForMarket(cfg, market);
    const reserve = calculateFastGasReserve(marketCfg, marketFunding);
    const required = parseUnits(String(reserve.requiredBnb), 18);
    const limit = BigInt(reserve.gasLimit ?? 0);
    const price = BigInt(reserve.gasPriceWei ?? 0);
    requiredWei += required;
    gasLimit += limit;
    if (price > maxGasPriceWei) maxGasPriceWei = price;
    perMarket.push({
      question: market.question ?? null,
      outcomeCount: Number(market.outcomeCount ?? 0),
      gasPriceGwei: reserve.gasPriceGwei,
      gasLimit: reserve.gasLimit,
      requiredBnb: reserve.requiredBnb
    });
  }

  return {
    mode: "multi_single_fast",
    gasLimit: gasLimit.toString(),
    gasPriceWei: maxGasPriceWei.toString(),
    gasPriceGwei: maxGasPriceWei > 0n ? formatUnits(maxGasPriceWei, 9) : null,
    requiredBnb: formatUnits(requiredWei, 18),
    perMarket
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
    const reserve = calculateFundingGasReserve(
      cfg,
      fundingForMarketSummaries(cfg, [recordFundingSummary(record, cfg)])
    );
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
  await appendGasLedgerFromExecution(cfg, result, {
    action: "approval",
    source: "router-approval-startup",
    wallet: result.address,
    txHashKey: "approveHash",
    fieldPrefix: "approve",
    metadata: { router: result.router, requiredAllowance: result.requiredAllowance }
  });
  await appendGasLedgerFromExecution(cfg, result, {
    action: "approval",
    source: "router-approval-reset-startup",
    wallet: result.address,
    txHashKey: "resetHash",
    fieldPrefix: "reset",
    metadata: { router: result.router, requiredAllowance: result.requiredAllowance }
  });
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

function genericUpperBoundRequiredBusdt(cfg) {
  return roundUsd(cfg.stakePerOutcomeUsdt * estimateMaxSelectedOutcomeCount(cfg));
}

function bot3FifaExactScoreAutoFallbackBusdt(cfg) {
  if (!bot3FifaExactScoreAutoBuyActive(cfg)) return null;
  const stake = Number(cfg.bot3FifaExactScoreAutoStakeUsdt ?? 0);
  if (!Number.isFinite(stake) || stake <= 0) return null;
  return roundUsd(stake * BOT3_FIFA_EXACT_SCORE_AUTO_OUTCOME_COUNT);
}

function fundingUpperBoundRequiredBusdt(cfg) {
  const genericRequired = genericUpperBoundRequiredBusdt(cfg);
  const bot3FifaAutoRequired = bot3FifaExactScoreAutoFallbackBusdt(cfg);
  if (cfg.watchFundingMode === "next_batch" && bot3FifaAutoRequired !== null) {
    return bot3FifaAutoRequired;
  }
  return genericRequired;
}

function computeFundingRequirement(cfg, eventMarkets = []) {
  const genericUpperBoundBusdt = genericUpperBoundRequiredBusdt(cfg);
  const bot3FifaExactScoreAutoFallbackRequiredBusdt = bot3FifaExactScoreAutoFallbackBusdt(cfg);
  const upperBoundRequiredBusdt = fundingUpperBoundRequiredBusdt(cfg);
  const usingBot3FifaExactScoreAutoFallback = cfg.watchFundingMode === "next_batch" &&
    bot3FifaExactScoreAutoFallbackRequiredBusdt !== null;
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
    reason: useNextBatch
      ? "known_next_opening_batch"
      : (usingBot3FifaExactScoreAutoFallback
        ? "bot3_fifa_exact_score_auto_single_market_fallback"
        : "single_market_upper_bound"),
    requiredBusdt,
    minimumExecutableBusdt,
    upperBoundRequiredBusdt,
    genericUpperBoundRequiredBusdt: genericUpperBoundBusdt,
    bot3FifaExactScoreAutoFallbackRequiredBusdt,
    nextBatchRequiredBusdt,
    nextBatchMarketCount: nextBatch.length,
    nextBatchOutcomeCount: batchSelectedOutcomeCount(nextBatch, cfg),
    nextBatchAvailableOutcomeCount: nextBatch.reduce((sum, market) => sum + (market.outcomes?.length ?? 0), 0),
    nextBatchStartDate: nextBatch[0]?.startDate ?? null,
    nextBatchMarkets: nextBatch.map((market) => marketFundingSummary(market, cfg, {
      totalStakeUsdt: roundUsd(selectedStakeUsdt(market, cfg)),
      outcomeCount: selectedOutcomeCount(market, cfg)
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
  const lockedMarket = attachMemeRangeSelectionLock(cfg, market);
  const record = {
    market: lockedMarket,
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
    executionRetryAfterMs: null,
    openBroadcastDelayMs: null
  };
  if (cfg.eventBuyMode !== "fast") return record;

  try {
    const hydrateOdds = options.hydrateOdds !== false;
    const preparedMarket = hydrateOdds
      ? await maybeHydrateMarketOdds(cfg, lockedMarket)
      : {
          ...lockedMarket,
          oddsHydrationSkipped: options.hydrationSkipReason ?? "disabled"
        };
    record.market = preparedMarket;
    const buyCfg = eventBuyConfigForMarket(cfg, preparedMarket);
    let plan = annotateBuyConfigPlan(buildDirectBuyAllOutcomesPlan(preparedMarket, buyCfg), buyCfg);
    record.openBroadcastDelayMs = buyCfg.plannedBuy?.openBroadcastDelayMs ?? null;
    const receiver = runtime?.receiverAddress || cfg.walletAddress;
    if (receiver) {
      plan = withPrebuiltFastExecution(plan, receiver);
    }
    validatePreparedPlanForExecution(cfg, plan);
    record.preparedPlan = plan;
    record.preparedAt = new Date().toISOString();
    record.prebuiltCalldata = Boolean(plan.prebuiltFastExecution);
  } catch (error) {
    record.prepareError = errorMessage(error);
  }
  return record;
}

function validatePreparedPlanForExecution(cfg, plan) {
  if (cfg.dryRun || !cfg.execute) return;
  assertExecutionAllowed(executionConfigForPlan(cfg, plan), plan);
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
    const executionCfg = executionConfigForPlan(cfg, record.preparedPlan);
    record.preSignedFastTransaction = await withRuntimeTransactionLock(
      runtime,
      "pre-sign-single",
      () => preSignFastBuyTransaction(executionCfg, record.preparedPlan, runtime)
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
      msUntilAction: msUntilRecordAction(record, cfg, runtime)
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
    if (record.dedicatedOpenTimer || record.dedicatedOpenTimerInFlight) continue;
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
  const strictWindow = strictBuilderTargetWindow(cfg, market);
  const strictTargetExpired = Boolean(strictWindow && Date.now() >= strictWindow.expiresAtMs);
  if (!strictTargetExpired && !isPastEventOpenWindow(cfg, market)) return false;
  const key = eventSeenKey(market, cfg);
  if (seen.has(key)) return true;
  const ageMs = marketOpenAgeMs(market);
  const reason = strictTargetExpired
    ? `strict Builder target T+${strictWindow.targetSecond}s expired; one-second-late local buy is forbidden`
    : `market is ${Math.round(ageMs / 1000)}s past open; max ${cfg.eventOpenWindowSeconds}s`;
  const row = {
    level: strictTargetExpired ? "event-skip-builder-target-window" : "event-skip-open-window",
    source,
    market: market.address,
    question: market.question,
    startDate: market.startDate,
    ageMs,
    eventOpenWindowSeconds: cfg.eventOpenWindowSeconds,
    builderTargetSecond: strictWindow?.targetSecond ?? null,
    builderTargetTimestamp: strictWindow?.targetTimestamp ?? null,
    reason,
    at: new Date().toISOString()
  };
  seen.add(key);
  appendJsonl(cfg.fillsFile, row);
  recordMarketDecision(cfg, market, "skipped", {
    source,
    message: row.reason,
    dedupeKey: `${String(market.address).toLowerCase()}:${strictTargetExpired ? "skipped-builder-target-window" : "skipped-open-window"}`
  });
  console.error(JSON.stringify(row));
  return true;
}

function strictBuilderTargetWindow(cfg, market, { planAware = true } = {}) {
  const startMs = Date.parse(market?.startDate ?? "");
  if (!Number.isFinite(startMs)) return null;
  const effective = planAware
    ? eventBuyConfigForMarket(cfg, market)
    : applyBuilderBundleTimingPreset(cfg);
  const timing = effective.builderBundleTimingResolved ?? resolveBuilderBundleTimingPreset(effective);
  if (
    !effective.builderBundleEnabled ||
    effective.builderBundleMode !== "builder_only" ||
    !timing.strict ||
    !timing.eligible ||
    !Number.isSafeInteger(Number(timing.targetSecond))
  ) return null;
  const targetTimestamp = Math.ceil((startMs + Number(timing.targetSecond) * 1000) / 1000);
  return {
    targetSecond: Number(timing.targetSecond),
    targetTimestamp,
    expiresAtMs: (targetTimestamp + 1) * 1000
  };
}

function isPastEventOpenWindow(cfg, market) {
  if (cfg.allowLateBuy) return false;
  const ageMs = marketOpenAgeMs(market);
  return Number.isFinite(ageMs) && ageMs > eventOpenWindowMs(cfg);
}

function assertPlanWithinOpenWindow(cfg, market, source = "buy") {
  const strictWindow = strictBuilderTargetWindow(cfg, market, { planAware: false });
  if (strictWindow && Date.now() >= strictWindow.expiresAtMs) {
    throw new Error(
      `Refusing ${source}: strict Builder target T+${strictWindow.targetSecond}s expired; one-second-late local buy is forbidden`
    );
  }
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

function isPriceGateActive(cfg) {
  return Boolean(cfg.eventPriceGateEnabled && !cfg.dryRun && cfg.execute);
}

function isPriceGateQuotePassing(cfg, quote) {
  return Number(quote?.effectivePrice ?? Infinity) < Number(cfg.eventPriceGateMaxEffectivePrice);
}

function priceGatePasses(cfg, quotes) {
  const rows = Array.isArray(quotes) ? quotes : [];
  if (cfg.eventPriceGateRequire === "all") {
    return rows.length > 0 && rows.every((quote) => isPriceGateQuotePassing(cfg, quote));
  }
  return rows.some((quote) => isPriceGateQuotePassing(cfg, quote));
}

async function checkEventPriceGate(cfg, eventPlan) {
  if (!isPriceGateActive(cfg)) return { enabled: false, allowed: true };

  const outcomes = Array.isArray(eventPlan?.outcomes) ? eventPlan.outcomes : [];
  if (outcomes.length === 0) {
    return {
      enabled: true,
      allowed: false,
      reason: "no-outcomes",
      quotes: [],
      errors: [],
      elapsedMs: 0
    };
  }

  const startedAt = Date.now();
  const timeoutMs = Number(cfg.eventPriceGateTimeoutMs ?? 1000);
  const quotes = [];
  const errors = [];
  const { publicClient } = makeClients(cfg);

  return new Promise((resolve) => {
    let settled = false;
    let remaining = outcomes.length;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        enabled: true,
        allowed: Boolean(result.allowed),
        reason: result.reason,
        passingQuote: result.passingQuote ?? null,
        quotes: [...quotes],
        errors: [...errors],
        elapsedMs: Date.now() - startedAt
      });
    };
    const finishIfComplete = () => {
      if (remaining > 0) return;
      finish({
        allowed: priceGatePasses(cfg, quotes),
        reason: priceGatePasses(cfg, quotes) ? "all-complete-pass" : "all-complete-no-pass",
        passingQuote: quotes.find((quote) => isPriceGateQuotePassing(cfg, quote)) ?? null
      });
    };
    const timer = setTimeout(() => {
      const allowed = cfg.eventPriceGateRequire === "all"
        ? quotes.length === outcomes.length && priceGatePasses(cfg, quotes)
        : priceGatePasses(cfg, quotes);
      finish({
        allowed,
        reason: allowed ? "timeout-after-pass" : "timeout-no-pass",
        passingQuote: quotes.find((quote) => isPriceGateQuotePassing(cfg, quote)) ?? null
      });
    }, timeoutMs);
    timer.unref?.();

    for (const outcome of outcomes) {
      quoteEventPriceGateOutcome(publicClient, cfg, eventPlan, outcome)
        .then((quote) => {
          if (settled) return;
          quotes.push(quote);
          remaining -= 1;
          if (cfg.eventPriceGateRequire === "any" && isPriceGateQuotePassing(cfg, quote)) {
            finish({ allowed: true, reason: "any-outcome-pass", passingQuote: quote });
            return;
          }
          if (cfg.eventPriceGateRequire === "all" && !isPriceGateQuotePassing(cfg, quote)) {
            finish({ allowed: false, reason: "all-outcomes-required", passingQuote: null });
            return;
          }
          finishIfComplete();
        })
        .catch((error) => {
          if (settled) return;
          errors.push({
            tokenId: String(outcome.tokenId),
            outcome: outcome.name ?? outcome.outcome ?? outcome.symbol ?? null,
            message: errorMessage(error)
          });
          remaining -= 1;
          if (cfg.eventPriceGateRequire === "all") {
            finish({ allowed: false, reason: "quote-error", passingQuote: null });
            return;
          }
          finishIfComplete();
        });
    }
  });
}

async function quoteEventPriceGateOutcome(publicClient, cfg, eventPlan, outcome) {
  const amount = outcome.amount ?? parseUnits(String(outcome.stakeUsdt ?? eventPlan.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt), 18);
  const simulated = await simulateMintAmount(publicClient, {
    market: eventPlan.market.address,
    tokenId: outcome.tokenId,
    amount,
    stakeUsdt: outcome.stakeUsdt ?? eventPlan.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt
  });
  return summarizeEventPriceGateQuote(outcome, simulated);
}

function summarizeEventPriceGateQuote(outcome, simulated) {
  const collateralFromUserUsdt = Number(formatUnits(simulated.collateralFromUser, 18));
  const otToUser = Number(formatUnits(simulated.otToUser, 18));
  const effectivePrice = otToUser > 0 ? collateralFromUserUsdt / otToUser : Infinity;
  return {
    tokenId: String(outcome.tokenId),
    outcome: outcome.name ?? outcome.outcome ?? outcome.symbol ?? null,
    stakeUsdt: Number(simulated.stakeUsdt ?? outcome.stakeUsdt ?? 0),
    collateralFromUserUsdt: roundUsd(collateralFromUserUsdt),
    otToUser: roundToken(otToUser, 4),
    effectivePrice: roundPrice(effectivePrice)
  };
}

function roundPrice(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 1e12) / 1e12;
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

function summarizePosition(position, cfg = null) {
  const costBasisUsdt = Number(position.costBasis ?? 0);
  const cashPnlUsdt = Number(position.cashPnl ?? 0);
  const realizedPnlUsdt = Number(position.realizedPnl ?? 0);
  const planned = cfg ? plannedBuyForMarket(cfg, {
    address: position.marketAddress,
    question: position.question?.title
  }) : null;
  return {
    marketAddress: position.marketAddress,
    question: position.question?.title ?? null,
    outcome: position.outcome?.name ?? null,
    tokenId: position.tokenId,
    startDate: position.market?.startDate ?? position.question?.startDate ?? null,
    endDate: position.market?.endDate ?? position.question?.endDate ?? null,
    categories: position.market?.categories ?? position.question?.categories ?? [],
    tags: position.market?.tags ?? position.question?.tags ?? [],
    kickoffAt: planned?.kickoffAt ?? null,
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
  await waitForRuntimeBuilderNonceRecovery(runtime);
  if (retryRecord) preSignedFastTransaction = retryRecord.preSignedFastTransaction ?? null;
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
  const actionWaitMs = retryRecord
    ? msUntilRecordAction(retryRecord, cfg, runtime)
    : msUntilRecordAction({ market }, cfg, runtime);
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
  const priceGate = await checkEventPriceGate(cfg, eventPlan);
  if (priceGate.enabled) {
    const gateRow = {
      level: priceGate.allowed ? "event-price-gate-pass" : "event-price-gate-skip",
      market: market.address,
      question: market.question,
      threshold: cfg.eventPriceGateMaxEffectivePrice,
      require: cfg.eventPriceGateRequire,
      reason: priceGate.reason,
      elapsedMs: priceGate.elapsedMs,
      passingQuote: priceGate.passingQuote,
      quotes: priceGate.quotes,
      errors: priceGate.errors,
      at: new Date().toISOString()
    };
    if (priceGate.allowed) {
      console.log(JSON.stringify(gateRow));
      recordMarketDecision(cfg, market, "price-gate-pass", {
        source: "single-price-gate",
        rankSource: eventPlan.selection?.rankSource ?? null,
        fallbackReason: eventPlan.selection?.fallbackReason ?? null,
        message: `${priceGate.reason}: ${priceGate.passingQuote?.effectivePrice ?? ""} < ${cfg.eventPriceGateMaxEffectivePrice}`,
        once: false
      });
    } else {
      clearPreSignedSingleRecord(retryRecord, "price-gate-skip");
      await resetRuntimeNonceToPending(cfg, runtime, "price_gate_skip");
      clearExecutionRetry(retryRecord);
      seen.add(key);
      saveSeen(cfg.stateFile, seen);
      appendJsonl(cfg.fillsFile, gateRow);
      recordMarketDecision(cfg, market, "price-gate-skip", {
        source: "single-price-gate",
        rankSource: eventPlan.selection?.rankSource ?? null,
        fallbackReason: eventPlan.selection?.fallbackReason ?? null,
        message: `${priceGate.reason}: no selected outcome below ${cfg.eventPriceGateMaxEffectivePrice}`,
        once: false
      });
      console.error(JSON.stringify(gateRow));
      return false;
    }
  }
  let result;
  const openBroadcastTiming = describeOpenBroadcastTiming(
    openBroadcastTimingForRecord(retryRecord ?? { market }, cfg, runtime)
  );
  try {
    result = await executeOrPrint(eventPlan, cfg, runtime);
    if (result?.builderBundleTipNonceReleased && preSignedFastTransaction) {
      releaseBuilderTipNonceReservationAfterEarlyFailure(
        cfg,
        runtime?.pendingBuyRecords ?? new Map(),
        runtime,
        retryRecord,
        preSignedFastTransaction
      );
    }
    if (openBroadcastTiming) result = { ...result, openBroadcastTiming };
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
  const buyCfg = eventBuyConfigForMarket(cfg, planMarket);
  if (args.forceQuoted || args.quoted || cfg.eventBuyMode === "quoted") {
    const plan = await quoteBuyAllOutcomes(publicClient, planMarket, buyCfg, {
      stakePerOutcomeUsdt: args.stakePerOutcomeUsdt ?? buyCfg.stakePerOutcomeUsdt
    });
    return annotateBuyConfigPlan(plan, buyCfg);
  }
  return annotateBuyConfigPlan(buildDirectBuyAllOutcomesPlan(planMarket, buyCfg, {
    stakePerOutcomeUsdt: args.stakePerOutcomeUsdt ?? buyCfg.stakePerOutcomeUsdt
  }), buyCfg);
}

function filterEventMarketsForBot(markets, cfg) {
  const byAddress = new Map();
  for (const market of filterEventMarkets(markets, cfg)) {
    byAddress.set(String(market.address ?? "").toLowerCase(), market);
  }
  for (const market of markets ?? []) {
    const decision = marketFilterDecision(market, cfg);
    if (!decision.eligible) continue;
    byAddress.set(String(market.address ?? "").toLowerCase(), market);
  }
  return sortMarketsByStartAsc([...byAddress.values()]);
}

async function loadEventMarkets(cfg, { status = "live", limit = 500 } = {}) {
  const markets = await fetchMarkets(cfg, {
    status,
    topic: "",
    order: "created_at",
    ascending: false,
    limit
  });
  return filterEventMarketsForBot(markets, cfg);
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
  const executionCfg = executionConfigForPlan(cfg, eventPlan);
  if (executionCfg.dryRun || !executionCfg.execute) {
    console.log(JSON.stringify({ level: "event-plan", plan: described }, null, 2));
    return { dryRun: true };
  }
  assertPlanWithinOpenWindow(executionCfg, eventPlan.market, "single-buy");

  const result = await withRuntimeTransactionLock(
    runtime,
    "buy-single",
    () => buyOutcomesBatch(broadcastOnlyExecutionCfg(executionCfg), eventPlan, runtime)
  );
  console.log(JSON.stringify({ level: "executed", plan: described, result }, null, 2));
  await appendGasLedgerFromExecution(cfg, result, {
    action: "buy",
    source: "single-buy-result",
    allocations: gasAllocationsFromEventPlan(eventPlan)
  });
  maybeTrackReceipt(executionCfg, result, {
    type: "single",
    market: eventPlan.market.address,
    question: eventPlan.market.question,
    plannedBuy: eventPlan.plannedBuy ?? null,
    marketDetails: [eventPlan.market]
  }, runtime);
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
  await appendGasLedgerFromExecution(cfg, result, {
    action: "buy",
    source: "bundle-buy-result",
    allocations: gasAllocationsFromBundle(bundle)
  });
  maybeTrackReceipt(cfg, result, {
    type: "bundle",
    markets: bundle.markets.map((market) => market.address),
    marketCount: bundle.marketCount,
    outcomeCount: bundle.outcomeCount,
    marketDetails: bundle.markets
  }, runtime);
  return result;
}

function broadcastOnlyExecutionCfg(cfg) {
  return {
    ...cfg,
    waitForReceipt: false,
    asyncReceiptWatch: true
  };
}

function maybeTrackReceipt(cfg, result, context = {}, runtime = null) {
  if (
    !cfg.asyncReceiptWatch ||
    cfg.dryRun ||
    !cfg.execute ||
    !result?.txHash ||
    result.waitedForReceipt ||
    result.blockNumber
  ) return;

  maybeTrackTimestampGuardFallback(cfg, result, context, runtime);
  maybeTrackStrictBuilderTargetExpiry(cfg, result, context, runtime);
  void trackReceipt(cfg, result, context, runtime).catch(async (error) => {
    const receiptWatch = await classifyReceiptWatchError(cfg, result.txHash).catch((classifyError) => ({
      status: "error",
      txFound: null,
      receiptFound: null,
      message: errorMessage(classifyError)
    }));
    const status = receiptWatch.receiptFound && receiptWatch.receiptStatus
      ? receiptWatch.receiptStatus
      : receiptWatch.status === "dropped" ? "dropped" : "error";
    const message = errorMessage(error);
    const row = {
      level: "event-receipt",
      status,
      txHash: result.txHash,
      message,
      receiptWatchStatus: receiptWatch.status,
      txFound: receiptWatch.txFound,
      receiptFound: receiptWatch.receiptFound,
      classifyMessage: receiptWatch.message ?? null,
      context: receiptLogContext(context),
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    console.error(JSON.stringify(row));
    if (receiptWatch.status === "dropped") {
      await recoverRuntimeNonceAfterDroppedBuy(cfg, runtime, result, "receipt-watch-dropped");
    }
    if (receiptWatch.receiptFound && receiptWatch.receiptStatus) {
      clearTimestampGuardFallbackTransactions(result.txHash);
      if (receiptWatch.receipt) {
        const { publicClient } = makeClients(cfg);
        await appendGasLedgerFromReceipt(cfg, publicClient, {
          txHash: result.txHash,
          receipt: receiptWatch.receipt,
          action: "buy",
          source: "event-receipt-classify",
          allocations: gasAllocationsFromReceiptContext(context),
          metadata: {
            receiptWatchStatus: receiptWatch.status,
            receiptWatchError: message
          }
        });
        await maybeAppendBuilderTimestampGuardReceipt(cfg, publicClient, result, context, "event-receipt-classify-builder-guard");
        const tipReceipt = await maybeAppendBuilderBundleTipReceipt(cfg, publicClient, result, context, "event-receipt-classify-builder-tip");
        await maybeResetRuntimeNonceAfterMissingBuilderTip(cfg, publicClient, runtime, result, tipReceipt, "event-receipt-classify-builder-tip");
      }
      recordReceiptMarketDecisions(cfg, context, { status: receiptWatch.receiptStatus }, result.txHash);
      if (receiptWatch.receiptStatus === "success") return;
    } else {
      recordReceiptWatchErrorMarketDecisions(cfg, context, result.txHash, message, receiptWatch);
    }
    notifyFeishu(cfg, {
      title: receiptWatch.status === "dropped" ? "交易广播后链上未找到" : "交易 receipt 监控异常",
      level: "warn",
      fields: {
        tx: result.txHash,
        status: receiptWatch.status,
        txFound: String(receiptWatch.txFound ?? ""),
        receiptFound: String(receiptWatch.receiptFound ?? ""),
        context: context.type ?? "",
        message
      },
      dedupeKey: `receipt-watch:${result.txHash}:${receiptWatch.status}`,
      cooldownMs: cfg.feishuAlertCooldownMs
    });
  });
}

function maybeTrackTimestampGuardFallback(cfg, result, context = {}, runtime = null) {
  if (!result?.builderTimestampGuardEnabled || !result?.builderTimestampGuardTxHash) return;
  const fallback = getTimestampGuardFallbackTransactions(result.txHash);
  if (!fallback) {
    const row = {
      level: "builder-timestamp-guard-fallback-missing",
      txHash: result.txHash,
      guardTxHash: result.builderTimestampGuardTxHash,
      context: receiptLogContext(context),
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    console.error(JSON.stringify(row));
    notifyFeishu(cfg, {
      title: "Builder 时间闸门 fallback 缺失",
      level: "warn",
      fields: {
        tx: result.txHash,
        guardTx: result.builderTimestampGuardTxHash,
        context: context.type ?? ""
      },
      dedupeKey: `builder-timestamp-guard-fallback-missing:${result.txHash}`,
      cooldownMs: cfg.feishuAlertCooldownMs
    });
    return;
  }
  void releaseTimestampGuardAfterTarget(cfg, result, context, runtime, fallback).catch((error) => {
    const row = {
      level: "builder-timestamp-guard-fallback-error",
      txHash: result.txHash,
      guardTxHash: fallback.guard.txHash,
      message: errorMessage(error),
      context: receiptLogContext(context),
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, row);
    console.error(JSON.stringify(row));
    notifyFeishu(cfg, {
      title: "Builder 时间闸门 fallback 异常",
      level: "warn",
      fields: {
        tx: result.txHash,
        guardTx: fallback.guard.txHash,
        message: row.message
      },
      dedupeKey: `builder-timestamp-guard-fallback-error:${result.txHash}`,
      cooldownMs: cfg.feishuAlertCooldownMs
    });
  });
}

async function releaseTimestampGuardAfterTarget(cfg, result, context, runtime, fallback) {
  const targetTimestamp = Number(fallback.targetTimestamp ?? result.builderTimestampGuardTargetTimestamp);
  if (!Number.isSafeInteger(targetTimestamp) || targetTimestamp <= 0) {
    throw new Error(`invalid timestamp guard target ${targetTimestamp}`);
  }
  const { publicClient } = makeClients(cfg);
  const pollMs = Math.max(25, Number(cfg.builderTimestampGuardReleasePollMs ?? 50));
  const deadlineMs = Date.now() + 10_000;
  let latestBlock = null;
  while (Date.now() < deadlineMs) {
    latestBlock = await publicClient.getBlock({ blockTag: "latest" });
    if (Number(latestBlock.timestamp) >= targetTimestamp) break;
    await sleep(pollMs);
  }
  if (!latestBlock || Number(latestBlock.timestamp) < targetTimestamp) {
    throw new Error(`chain timestamp did not reach guard target ${targetTimestamp}`);
  }

  const existingReceipt = await publicClient.getTransactionReceipt({ hash: result.txHash }).catch(() => null);
  if (existingReceipt) {
    clearTimestampGuardFallbackTransactions(result.txHash);
    return;
  }

  const fallbackCfg = {
    ...cfg,
    builderBundleEnabled: false,
    builderBundleKillSwitch: true,
    builderTimestampGuardEnabled: false
  };
  let guardBroadcast = null;
  let buyBroadcast = null;
  await withRuntimeTransactionLock(runtime, "builder-timestamp-guard-release", async () => {
    guardBroadcast = await broadcastSignedTransaction(fallbackCfg, fallback.guard);
    buyBroadcast = await broadcastSignedTransaction(fallbackCfg, fallback.buy);
  });
  const row = {
    level: "builder-timestamp-guard-released",
    txHash: result.txHash,
    guardTxHash: fallback.guard.txHash,
    targetTimestamp,
    observedBlockNumber: latestBlock.number?.toString() ?? null,
    observedBlockTimestamp: latestBlock.timestamp?.toString() ?? null,
    guardBroadcastStartedAt: guardBroadcast?.broadcastStartedAt ?? null,
    guardFirstAcceptedAt: guardBroadcast?.firstAcceptedAt ?? null,
    buyBroadcastStartedAt: buyBroadcast?.broadcastStartedAt ?? null,
    buyFirstAcceptedAt: buyBroadcast?.firstAcceptedAt ?? null,
    context: receiptLogContext(context),
    at: new Date().toISOString()
  };
  appendJsonl(cfg.fillsFile, row);
  console.log(JSON.stringify(row));
}

function maybeTrackStrictBuilderTargetExpiry(cfg, result, context = {}, runtime = null) {
  scheduleStrictBuilderTargetExpiryWatch(cfg, result, context, runtime);
}

function scheduleStrictBuilderTargetExpiryWatch(
  cfg,
  result,
  context = {},
  runtime = null,
  { allowUnsubmitted = false } = {}
) {
  const targetTimestamp = strictBuilderExpiryTargetTimestamp(result);
  if (
    (!allowUnsubmitted && !result?.builderBundleSubmitted) ||
    !result?.publicBroadcastSkipped ||
    !result?.txHash ||
    !Number.isSafeInteger(targetTimestamp) ||
    targetTimestamp <= 0
  ) return;

  if (runtime && !runtime.builderTargetExpiryWatch) runtime.builderTargetExpiryWatch = new Set();
  const watchSet = runtime?.builderTargetExpiryWatch ?? builderTargetExpiryWatches;
  const key = String(result.txHash).toLowerCase();
  if (watchSet.has(key)) return;
  watchSet.add(key);

  const tracked = trackStrictBuilderTargetExpiry(cfg, result, context, runtime, targetTimestamp)
    .catch((error) => {
      if (runtime) runtime.builderNonceRecoveryError = errorMessage(error);
      console.error(JSON.stringify({
        level: "warn",
        source: "builder-target-expiry-watch",
        txHash: result.txHash,
        targetTimestamp,
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
      throw error;
    });
  if (!runtime) {
    void tracked.catch(() => {});
    return;
  }
  runtime.builderNonceRecoveryError = null;
  const recovery = tracked.finally(() => {
    if (runtime.builderNonceRecoveryPromise === recovery) {
      runtime.builderNonceRecoveryPromise = null;
    }
  });
  runtime.builderNonceRecoveryPromise = recovery;
  runtime.builderNonceRecoveryTxHash = result.txHash;
  void recovery.catch(() => {});
}

function strictBuilderExpiryTargetTimestamp(result) {
  const executorTarget = Number(result?.builderTimedBuyExecutorTargetTimestamp);
  if (Number.isSafeInteger(executorTarget) && executorTarget > 0) return executorTarget;
  return Number(result?.builderBundleMaxTimestamp);
}

async function trackStrictBuilderTargetExpiry(cfg, result, context, runtime, targetTimestamp) {
  const { publicClient } = makeClients(cfg);
  const wallTargetEndMs = (targetTimestamp + 1) * 1000;
  if (Date.now() < wallTargetEndMs) await sleep(wallTargetEndMs - Date.now());

  const deadlineMs = Date.now() + 30_000;
  let latestBlock = null;
  while (Date.now() < deadlineMs) {
    latestBlock = await publicClient.getBlock({ blockTag: "latest" });
    if (Number(latestBlock.timestamp) > targetTimestamp) break;
    await sleep(150);
  }
  if (!latestBlock || Number(latestBlock.timestamp) <= targetTimestamp) {
    throw new Error(`chain timestamp did not pass strict builder target ${targetTimestamp}`);
  }

  let receipt = null;
  for (let attempt = 0; attempt < 4 && !receipt; attempt += 1) {
    receipt = await publicClient.getTransactionReceipt({ hash: result.txHash }).catch(() => null);
    if (!receipt && attempt < 3) await sleep(250);
  }
  if (receipt) {
    await reconcileRuntimeNonceAfterStrictBuilderReceipt(cfg, runtime, result);
    return;
  }

  const row = {
    level: "builder-bundle-target-missed",
    status: "dropped",
    txHash: result.txHash,
    tipTxHash: result.builderBundleTipTxHash ?? null,
    bundleHash: result.builderBundleHash ?? null,
    builderBundleSubmitted: Boolean(result.builderBundleSubmitted),
    targetTimestamp,
    targetSecond: result.builderBundleTargetSecond ?? null,
    latestBlockNumber: latestBlock.number?.toString() ?? null,
    latestBlockTimestamp: latestBlock.timestamp?.toString() ?? null,
    context: receiptLogContext(context),
    at: new Date().toISOString()
  };
  appendJsonl(cfg.fillsFile, row);
  console.error(JSON.stringify(row));
  await recoverRuntimeNonceAfterDroppedBuy(cfg, runtime, result, "strict-builder-target-missed");
  recordReceiptWatchErrorMarketDecisions(cfg, context, result.txHash, "strict builder target second missed", {
    status: "dropped",
    txFound: false,
    receiptFound: false
  });
  notifyFeishu(cfg, {
    title: "Builder 目标秒未成交，已放弃",
    level: "warn",
    fields: {
      tx: result.txHash,
      targetSecond: String(result.builderBundleTargetSecond ?? ""),
      targetTimestamp: String(targetTimestamp),
      context: context.type ?? ""
    },
    dedupeKey: `builder-target-missed:${result.txHash}`,
    cooldownMs: cfg.feishuAlertCooldownMs
  });
}

async function reconcileRuntimeNonceAfterStrictBuilderReceipt(cfg, runtime, result) {
  if (!runtime || runtime.nextNonce === undefined || cfg.dryRun || !cfg.execute) return;
  const buyNonce = Number(result?.nonce ?? result?.preSignedNonce);
  if (!Number.isSafeInteger(buyNonce) || buyNonce < 0) return;
  const { publicClient, account } = makeClients(cfg);
  if (!account) return;
  const pendingNonce = Number(await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  }));
  const expectedNonce = buyNonce + 1 + (result?.builderBundleTipTxHash ? 1 : 0);
  if (pendingNonce >= expectedNonce) return;
  const previousNonce = runtime.nextNonce;
  const cleared = clearRuntimePreSignedTransactionsAtOrAfterNonce(
    runtime,
    pendingNonce,
    "strict-builder-tip-missing"
  );
  runtime.nextNonce = pendingNonce;
  runtime.lastNonceSyncAt = Date.now();
  console.error(JSON.stringify({
    level: "warn",
    source: "strict-builder-receipt-nonce-reconciled",
    txHash: result.txHash,
    buyNonce,
    expectedNonce,
    pendingNonce,
    previousNonce,
    clearedPreSignedTransactions: cleared,
    at: new Date().toISOString()
  }));
}

async function recoverRuntimeNonceAfterDroppedBuy(cfg, runtime, result, reason) {
  if (!runtime || runtime.nextNonce === undefined || cfg.dryRun || !cfg.execute) return;
  const buyNonce = Number(result?.nonce ?? result?.preSignedNonce);
  if (Number.isSafeInteger(buyNonce) && buyNonce >= 0) {
    clearRuntimePreSignedTransactionsAtOrAfterNonce(runtime, buyNonce, reason);
  }
  await resetRuntimeNonceToPending(cfg, runtime, reason);
}

function clearRuntimePreSignedTransactionsAtOrAfterNonce(runtime, minNonce, reason) {
  const pending = runtime?.pendingBuyRecords;
  if (!pending?.values) return 0;
  let cleared = 0;
  for (const record of pending.values()) {
    const singleNonce = Number(record?.preSignedFastTransaction?.nonce);
    if (Number.isSafeInteger(singleNonce) && singleNonce >= minNonce) {
      clearPreSignedSingleRecord(record, reason);
      cleared += 1;
    }
    const bundleNonce = Number(record?.preSignedFastBundleTransaction?.nonce);
    if (Number.isSafeInteger(bundleNonce) && bundleNonce >= minNonce) {
      clearPreSignedBundleRecords([record], reason);
      cleared += 1;
    }
  }
  return cleared;
}

async function trackReceipt(cfg, result, context, runtime = null) {
  const { publicClient } = makeClients(cfg);
  const txHash = result.txHash;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: cfg.receiptWatchTimeoutMs,
    pollingInterval: cfg.receiptWatchPollingMs
  });
  clearTimestampGuardFallbackTransactions(txHash);
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
  await appendGasLedgerFromReceipt(cfg, publicClient, {
    txHash,
    receipt,
    action: "buy",
    source: "event-receipt",
    allocations: gasAllocationsFromReceiptContext(context)
  });
  await maybeAppendBuilderTimestampGuardReceipt(cfg, publicClient, result, context, "event-receipt-builder-guard");
  const tipReceipt = await maybeAppendBuilderBundleTipReceipt(cfg, publicClient, result, context, "event-receipt-builder-tip");
  await maybeResetRuntimeNonceAfterMissingBuilderTip(cfg, publicClient, runtime, result, tipReceipt, "event-receipt-builder-tip");
  console.log(JSON.stringify(row));
  recordReceiptMarketDecisions(cfg, context, receipt, txHash);
  if (receipt.status === "success") {
    maybeScheduleFastOpenExitAfterBuyReceipt(cfg, result, context, runtime, receipt);
  }
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

async function maybeAppendBuilderTimestampGuardReceipt(
  cfg,
  publicClient,
  result,
  context = {},
  source = "builder-guard"
) {
  const guardTxHash = result?.builderTimestampGuardTxHash;
  if (!guardTxHash) return null;
  const receipt = await publicClient.getTransactionReceipt({ hash: guardTxHash }).catch(() => null);
  const row = {
    level: "builder-timestamp-guard-receipt",
    status: receipt?.status ?? "not_found",
    buyTxHash: result.txHash ?? null,
    guardTxHash,
    targetTimestamp: result.builderTimestampGuardTargetTimestamp ?? null,
    blockNumber: receipt?.blockNumber?.toString() ?? null,
    gasUsed: receipt?.gasUsed?.toString() ?? null,
    effectiveGasPrice: receipt?.effectiveGasPrice?.toString() ?? null,
    context: receiptLogContext(context),
    at: new Date().toISOString()
  };
  appendJsonl(cfg.fillsFile, row);
  if (!receipt) return null;
  await appendGasLedgerFromReceipt(cfg, publicClient, {
    txHash: guardTxHash,
    receipt,
    action: "builder_guard",
    source,
    allocations: gasAllocationsFromReceiptContext(context).map((item) => ({
      ...item,
      action: "builder_guard"
    })),
    metadata: {
      buyTxHash: result.txHash ?? null,
      targetTimestamp: result.builderTimestampGuardTargetTimestamp ?? null,
      guardAddress: result.builderTimestampGuardAddress ?? null
    }
  });
  return receipt;
}

async function maybeAppendBuilderBundleTipReceipt(cfg, publicClient, result, context = {}, source = "builder-tip") {
  if (!result?.builderBundleSubmitted) return null;
  const candidates = Array.isArray(result.builderBundleTipCandidates) && result.builderBundleTipCandidates.length > 0
    ? result.builderBundleTipCandidates
    : result.builderBundleTipTxHash
      ? [{
          tipTxHash: result.builderBundleTipTxHash,
          tipBnb: result.builderBundleTipBnb ?? null,
          provider: result.builderBundleProvider ?? null,
          targetId: null,
          tipTo: result.builderBundleTipTo ?? null
        }]
      : [];
  const uniqueCandidates = [...new Map(candidates
    .filter((candidate) => /^0x[a-fA-F0-9]{64}$/u.test(String(candidate?.tipTxHash ?? "")))
    .map((candidate) => [String(candidate.tipTxHash).toLowerCase(), candidate])).values()];
  if (uniqueCandidates.length === 0) return null;
  const checked = await Promise.all(uniqueCandidates.map(async (candidate) => ({
    candidate,
    receipt: await publicClient.getTransactionReceipt({ hash: candidate.tipTxHash }).catch(() => null)
  })));
  for (const { candidate, receipt } of checked) {
    appendJsonl(cfg.fillsFile, {
      level: "builder-bundle-tip-receipt",
      status: receipt?.status ?? "not_found",
      buyTxHash: result.txHash ?? null,
      tipTxHash: candidate.tipTxHash,
      tipTo: candidate.tipTo ?? null,
      tipBnb: candidate.tipBnb ?? result.builderBundleTipBnb ?? null,
      provider: candidate.provider ?? null,
      targetId: candidate.targetId ?? null,
      blockNumber: receipt?.blockNumber?.toString() ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
      effectiveGasPrice: receipt?.effectiveGasPrice?.toString() ?? null,
      context: receiptLogContext(context),
      at: new Date().toISOString()
    });
  }
  const landed = checked.find((item) => item.receipt);
  if (!landed) return null;
  const { candidate, receipt } = landed;
  await appendGasLedgerFromReceipt(cfg, publicClient, {
    txHash: candidate.tipTxHash,
    receipt,
    action: "builder_tip",
    source,
    extraFeeBnb: candidate.tipBnb ?? result.builderBundleTipBnb ?? null,
    allocations: gasAllocationsFromReceiptContext(context).map((item) => ({
      ...item,
      action: "builder_tip"
    })),
    metadata: {
      buyTxHash: result.txHash ?? null,
      tipBnb: candidate.tipBnb ?? result.builderBundleTipBnb ?? null,
      provider: candidate.provider ?? null,
      targetId: candidate.targetId ?? null,
      tipTo: candidate.tipTo ?? null
    }
  });
  return receipt;
}

async function maybeResetRuntimeNonceAfterMissingBuilderTip(cfg, publicClient, runtime, result, tipReceipt, source) {
  if (tipReceipt) return;
  if (result?.builderBundleTipNonceReleased) return;
  if (!runtime || runtime.nextNonce === undefined || cfg.dryRun || !cfg.execute) return;
  if (!result?.builderBundleTipPreSigned || !result?.builderBundleTipTxHash) return;
  const buyNonce = Number(result.nonce ?? result.preSignedNonce);
  if (!Number.isSafeInteger(buyNonce) || buyNonce < 0) return;
  const { account } = makeClients(cfg);
  if (!account) return;
  const pendingNonce = Number(await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  }));
  if (!Number.isSafeInteger(pendingNonce) || pendingNonce <= buyNonce || pendingNonce >= runtime.nextNonce) return;
  const previousNonce = runtime.nextNonce;
  const clearedPreSignedTransactions = clearRuntimePreSignedTransactionsAtOrAfterNonce(runtime, pendingNonce, source);
  runtime.nextNonce = pendingNonce;
  runtime.lastNonceSyncAt = Date.now();
  console.error(JSON.stringify({
    level: "warn",
    source: "builder-tip-missing-nonce-reset",
    reason: source,
    buyTxHash: result.txHash ?? null,
    tipTxHash: result.builderBundleTipTxHash,
    buyNonce,
    previousNonce,
    pendingNonce,
    clearedPreSignedTransactions,
    at: new Date().toISOString()
  }));
}

async function classifyReceiptWatchError(cfg, txHash) {
  const { publicClient } = makeClients(cfg);
  const timeoutMs = Math.max(1000, Math.min(5000, Number(cfg.receiptWatchPollingMs ?? 1000) * 2));
  const [tx, receipt] = await Promise.all([
    withTimeout(publicClient.getTransaction({ hash: txHash }).catch(() => null), timeoutMs, "getTransaction timeout"),
    withTimeout(publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null), timeoutMs, "getTransactionReceipt timeout")
  ]);

  if (receipt) {
    return {
      status: receipt.status === "success" ? "receipt-success" : "receipt-failed",
      txFound: true,
      receiptFound: true,
      receiptStatus: receipt.status,
      blockNumber: receipt.blockNumber?.toString() ?? null,
      receipt
    };
  }
  if (tx) {
    return {
      status: "timeout",
      txFound: true,
      receiptFound: false
    };
  }
  return {
    status: "dropped",
    txFound: false,
    receiptFound: false
  };
}

function maybeScheduleFastOpenExitAfterBuyReceipt(cfg, result, context = {}, runtime = null, receipt = null) {
  if (!shouldScheduleFastOpenExitAfterBuy(cfg, result, context, runtime, receipt)) return;
  const market = context.marketDetails[0];
  const schedule = fastOpenExitSchedule(cfg, market, result.txHash);
  if (!schedule) return;
  if (Date.now() > schedule.targetMs + 5000) {
    console.error(JSON.stringify({
      level: "event-auto-sell-fast-open-exit-skip",
      reason: "target-already-expired",
      market: market.address,
      question: market.question,
      txHash: result.txHash,
      targetAt: schedule.targetAt,
      at: new Date().toISOString()
    }));
    return;
  }
  const earlierBuy = pendingBuyBeforeFastOpenExit(cfg, runtime, market, schedule.targetMs);
  if (earlierBuy) {
    console.error(JSON.stringify({
      level: "event-auto-sell-fast-open-exit-skip",
      reason: "pending-buy-precedes-fast-exit",
      market: market.address,
      question: market.question,
      txHash: result.txHash,
      targetAt: schedule.targetAt,
      pendingBuyMarket: earlierBuy.market,
      pendingBuyQuestion: earlierBuy.question,
      pendingBuyTargetAt: earlierBuy.targetAt,
      at: new Date().toISOString()
    }));
    return;
  }

  const key = `${String(market.address).toLowerCase()}:${String(result.txHash).toLowerCase()}`;
  if (!runtime.fastOpenExitScheduled) runtime.fastOpenExitScheduled = new Set();
  if (runtime.fastOpenExitScheduled.has(key)) return;
  runtime.fastOpenExitScheduled.add(key);
  runtime.fastOpenExitPreSignGate = {
    key,
    market: market.address,
    targetAt: schedule.targetAt
  };
  pauseRuntimeAutoSellUntil(runtime, schedule.targetMs + Number(cfg.autoSellFastOpenExitMonitorPauseMs ?? 0), "fast-open-exit-scheduled");

  console.log(JSON.stringify({
    level: "event-auto-sell-fast-open-exit-scheduled",
    market: market.address,
    question: market.question,
    buyTxHash: result.txHash,
    targetAt: schedule.targetAt,
    delayMs: schedule.delayMs,
    percent: cfg.autoSellOpenExitPercent,
    selectedOutcomes: result.outcomes?.map((outcome) => ({
      tokenId: String(outcome.tokenId),
      name: outcome.name ?? null
    })) ?? [],
    monitorPausedUntil: new Date(runtime.autoSellPausedUntil).toISOString(),
    at: new Date().toISOString()
  }));

  void prepareAndBroadcastFastOpenExit(cfg, result, context, runtime, schedule, key)
    .catch(async (error) => {
      console.error(JSON.stringify({
        level: "event-auto-sell-fast-open-exit-error",
        market: market.address,
        question: market.question,
        buyTxHash: result.txHash,
        message: autoSellErrorMessage(cfg, error),
        at: new Date().toISOString()
      }));
      notifyFeishu(cfg, {
        title: "快速定时卖出失败",
        level: "warn",
        fields: {
          market: market.address,
          question: market.question,
          target: schedule.targetAt,
          message: autoSellErrorMessage(cfg, error)
        },
        dedupeKey: `fast-open-exit-error:${String(market.address).toLowerCase()}:${String(result.txHash).toLowerCase()}`,
        cooldownMs: cfg.autoSellAlertCooldownMs
      });
    })
    .finally(() => releaseFastOpenExitPreSignGate(runtime, key));
}

function pendingBuyBeforeFastOpenExit(cfg, runtime, currentMarket, fastExitTargetMs) {
  const pending = runtime?.pendingBuyRecords;
  if (!pending?.values) return null;
  const currentMarketKey = String(currentMarket?.address ?? "").toLowerCase();
  let earliest = null;
  for (const record of pending.values()) {
    const market = pendingMarket(record);
    if (String(market?.address ?? "").toLowerCase() === currentMarketKey) continue;
    const waitMs = msUntilRecordAction(record, cfg, runtime);
    if (!Number.isFinite(waitMs)) continue;
    const targetMs = Date.now() + waitMs;
    if (targetMs > fastExitTargetMs) continue;
    if (!earliest || targetMs < earliest.targetMs) {
      earliest = {
        market: market?.address ?? null,
        question: market?.question ?? null,
        targetMs,
        targetAt: new Date(targetMs).toISOString()
      };
    }
  }
  return earliest;
}

function shouldScheduleFastOpenExitAfterBuy(cfg, result, context = {}, runtime = null, receipt = null) {
  const baseEligible = Boolean(
    cfg.autoSellFastOpenExitEnabled &&
    cfg.autoSellEnabled &&
    cfg.autoSellStrategy === "open_timed_exit" &&
    !cfg.dryRun &&
    cfg.execute &&
    runtime?.txLock &&
    receipt?.status === "success" &&
    context?.type === "single" &&
    Array.isArray(context.marketDetails) &&
    context.marketDetails.length === 1 &&
    Array.isArray(result?.outcomes) &&
    result.outcomes.length > 0
  );
  if (!baseEligible) return false;
  return plannedBuyAllowsFastOpenExit(cfg, context);
}

function plannedBuyAllowsFastOpenExit(cfg, context = {}) {
  const planned = plannedBuyForFastOpenExitContext(cfg, context);
  if (!planned?.autoSell) return true;
  const plannedAutoSellCfg = {
    ...cfg,
    ...planned.autoSell
  };
  if (!isAutoSellEnabledForPosition(plannedAutoSellCfg)) return false;
  return String(plannedAutoSellCfg.autoSellStrategy ?? "").trim().toLowerCase() === "open_timed_exit";
}

function plannedBuyForFastOpenExitContext(cfg, context = {}) {
  if (context?.plannedBuy) return context.plannedBuy;
  if (!Array.isArray(context.marketDetails) || context.marketDetails.length !== 1) return null;
  return plannedBuyForMarket(cfg, context.marketDetails[0]);
}

function fastOpenExitSchedule(cfg, market, seed = "") {
  const openMs = Date.parse(market?.startDate ?? "");
  if (!Number.isFinite(openMs)) return null;
  const delayMs = fastOpenExitRandomDelayMs(cfg);
  const targetMs = openMs + delayMs;
  return {
    delayMs,
    targetMs,
    targetAt: new Date(targetMs).toISOString(),
    seed: String(seed ?? "")
  };
}

function fastOpenExitRandomDelayMs(cfg, randomFn = randomInt) {
  const min = Math.floor(Number(cfg.autoSellFastOpenExitMinDelayMs ?? 24500));
  const max = Math.floor(Number(cfg.autoSellFastOpenExitMaxDelayMs ?? min));
  if (max <= min) return min;
  return randomFn(min, max + 1);
}

function pauseRuntimeAutoSellUntil(runtime, untilMs, reason) {
  if (!runtime) return;
  const until = Number(untilMs ?? 0);
  if (!Number.isFinite(until) || until <= Date.now()) return;
  runtime.autoSellPausedUntil = Math.max(runtime.autoSellPausedUntil ?? 0, until);
  runtime.autoSellPauseReason = reason;
}

function releaseFastOpenExitAutoSellPause(runtime) {
  if (!runtime || runtime.autoSellPauseReason !== "fast-open-exit-scheduled") return;
  runtime.autoSellPausedUntil = 0;
  runtime.autoSellPauseReason = null;
}

function releaseFastOpenExitPreSignGate(runtime, key) {
  if (!runtime?.fastOpenExitPreSignGate) return;
  if (runtime.fastOpenExitPreSignGate.key !== key) return;
  runtime.fastOpenExitPreSignGate = null;
}

async function prepareAndBroadcastFastOpenExit(cfg, result, context, runtime, schedule, gateKey = null) {
  const { publicClient, account } = makeClients(cfg);
  if (!account) throw new Error("PRIVATE_KEY is required for fast open exit");
  const walletAddress = cfg.walletAddress || account.address;
  const market = context.marketDetails[0];
  const marketAddress = market.address;
  const percent = Number(cfg.autoSellOpenExitPercent ?? 100);
  let signed = null;
  let broadcast = null;
  let actions = [];
  const sellExecutionCfg = rpcOnlyAutoSellBroadcastConfig(
    autoSellExecutionConfigForItems(cfg, [{ autoSellCfg: cfg }])
  );

  try {
    let plans = await buildFastOpenExitSellPlans(cfg, publicClient, market, result, walletAddress, schedule.targetMs);
    const approval = await ensureFastOpenExitOperatorApproval(cfg, runtime, marketAddress, plans);
    if (approval) {
      await syncRuntimeNonceAfterExternalTx(cfg, runtime, "fast-open-exit-operator-approval");
      plans = await buildFastOpenExitSellPlans(cfg, publicClient, market, result, walletAddress, schedule.targetMs);
    }
    const missingApproval = plans.find((plan) => !plan.operatorApproved);
    if (missingApproval) throw new Error(`Operator approval missing for market ${missingApproval.market}`);
    actions = plans.map((plan) => fastOpenExitActionFromPlan(cfg, plan, market, result, schedule, "prepared"));

    await ensureAutoSellGasBudget(cfg, publicClient, walletAddress, estimateAutoSellBatchGas(plans.length));
    signed = await withRuntimeTransactionLock(runtime, "fast-open-exit-presign", () =>
      preSignSellOutcomesBatch(
        sellExecutionCfg,
        plans,
        runtime,
        { requirePreapprovedOperator: true }
      )
    );
    for (const action of actions) {
      action.status = "scheduled";
      action.txHash = signed.txHash;
      action.nonce = signed.nonce;
      action.gas = signed.gas;
      action.gasPriceGwei = signed.gasPriceGwei;
    }
    appendAutoSellBatchLog(cfg, {
      source: "fast-open-exit",
      walletAddress,
      markets: [marketAddress],
      actions,
      execution: {
        status: "scheduled",
        txHash: signed.txHash,
        nonce: signed.nonce,
        targetAt: schedule.targetAt,
        delayMs: schedule.delayMs,
        approval: approval ?? null
      }
    });

    await waitUntilBroadcastTarget(schedule.targetMs, Number(cfg.openBroadcastSpinMs ?? 0));
    broadcast = await withRuntimeTransactionLock(runtime, "fast-open-exit-broadcast", () =>
      broadcastSignedTransaction(sellExecutionCfg, signed)
    );
    await syncRuntimeNonceAfterExternalTx(cfg, runtime, "fast-open-exit-broadcast");
    releaseFastOpenExitPreSignGate(runtime, gateKey);
    for (const action of actions) {
      action.status = "broadcast";
      action.txHash = broadcast.txHash;
      action.broadcastMode = broadcast.mode;
      action.firstAcceptedAt = broadcast.firstAcceptedAt ?? null;
      action.firstAcceptedLatencyMs = broadcast.firstAcceptedLatencyMs ?? null;
    }
    appendAutoSellBatchLog(cfg, {
      source: "fast-open-exit",
      walletAddress,
      markets: [marketAddress],
      actions,
      execution: {
        ...broadcast,
        status: "broadcast",
        targetAt: schedule.targetAt,
        delayMs: schedule.delayMs
      }
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: broadcast.txHash,
      timeout: cfg.receiptWatchTimeoutMs,
      pollingInterval: cfg.receiptWatchPollingMs
    });
    const receiptRow = {
      level: "event-auto-sell-fast-open-exit-receipt",
      status: receipt.status,
      txHash: broadcast.txHash,
      blockNumber: receipt.blockNumber?.toString() ?? null,
      gasUsed: receipt.gasUsed?.toString() ?? null,
      effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
      market: marketAddress,
      question: market.question,
      targetAt: schedule.targetAt,
      delayMs: schedule.delayMs,
      at: new Date().toISOString()
    };
    appendJsonl(cfg.fillsFile, receiptRow);
    await appendGasLedgerFromReceipt(cfg, publicClient, {
      txHash: broadcast.txHash,
      receipt,
      action: "sell",
      source: "fast-open-exit-receipt",
      allocations: gasAllocationsFromAutoSellActions(actions.length ? actions : [{
        marketAddress,
        question: market.question
      }])
    });
    console.log(JSON.stringify(receiptRow));

    for (const action of actions) action.status = receipt.status;
    if (receipt.status === "success") {
      markFastOpenExitAutoSellState(cfg, walletAddress, actions);
    } else {
      notifyFeishu(cfg, {
        title: "快速定时卖出 receipt 非成功",
        level: "warn",
        fields: {
          market: marketAddress,
          question: market.question,
          tx: broadcast.txHash,
          status: receipt.status
        },
        dedupeKey: `fast-open-exit-receipt:${broadcast.txHash}`,
        cooldownMs: cfg.autoSellAlertCooldownMs
      });
    }
    appendAutoSellBatchLog(cfg, {
      source: "fast-open-exit",
      walletAddress,
      markets: [marketAddress],
      actions,
      execution: {
        status: receipt.status,
        txHash: broadcast.txHash,
        blockNumber: receipt.blockNumber?.toString() ?? null
      }
    });
  } catch (error) {
    releaseFastOpenExitAutoSellPause(runtime);
    if (signed && !broadcast) await resetRuntimeNonceToPending(cfg, runtime, "fast_open_exit_unbroadcast_signed_tx");
    for (const action of actions) {
      action.status = "error";
      action.message = autoSellErrorMessage(cfg, error);
    }
    if (actions.length > 0) {
      appendAutoSellBatchLog(cfg, {
        source: "fast-open-exit",
        walletAddress,
        markets: [marketAddress],
        actions,
        execution: {
          status: "error",
          txHash: signed?.txHash ?? null,
          message: autoSellErrorMessage(cfg, error),
          targetAt: schedule.targetAt
        }
      });
    }
    throw error;
  }
}

async function buildFastOpenExitSellPlans(cfg, publicClient, market, result, walletAddress, targetMs) {
  const outcomes = result.outcomes ?? [];
  let lastError = null;
  const deadlineMs = Math.max(Date.now(), Number(targetMs ?? Date.now()) - 500);
  do {
    try {
      const plans = await Promise.all(outcomes.map((outcome) =>
        buildDirectSellPlan(publicClient, {
          market: market.address,
          tokenId: outcome.tokenId,
          owner: walletAddress,
          percent: cfg.autoSellOpenExitPercent
        })
      ));
      return plans;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadlineMs) break;
      await sleep(Math.min(250, Math.max(1, deadlineMs - Date.now())));
    }
  } while (Date.now() < deadlineMs);
  throw lastError ?? new Error("Failed to build fast open exit sell plans");
}

async function ensureFastOpenExitOperatorApproval(cfg, runtime, marketAddress, plans) {
  void cfg;
  void runtime;
  if (plans.every((plan) => plan.operatorApproved)) return null;
  throw new Error(
    `Fast open exit operator approval was not mined before buy for market ${marketAddress}; refusing a nonce-consuming approval after buy`
  );
}

function fastOpenExitActionFromPlan(cfg, plan, market, result, schedule, status) {
  const outcome = (result.outcomes ?? []).find((item) => String(item.tokenId) === String(plan.tokenId));
  return {
    trigger: "fast_open_timed_exit",
    triggerLabel: "快速开盘定时卖出",
    percent: Number(cfg.autoSellOpenExitPercent ?? 100),
    dueAt: schedule.targetAt,
    targetAt: schedule.targetAt,
    marketOpenDate: market.startDate ?? null,
    delayMs: schedule.delayMs,
    sellAmountOt: formatUnits(plan.amount, 18),
    balanceOt: formatUnits(plan.balance, 18),
    marketAddress: market.address,
    tokenId: String(plan.tokenId),
    question: market.question ?? null,
    outcome: outcome?.name ?? null,
    minCollateralOutUsdt: "0.000000000000000001",
    noPriceProtection: true,
    status,
    txHash: null
  };
}

function markFastOpenExitAutoSellState(cfg, walletAddress, actions) {
  const state = loadAutoSellPositionState(cfg.autoSellPositionStateFile);
  if (!state.positions) state.positions = {};
  for (const action of actions) {
    const key = autoSellActionPositionKey(walletAddress, action);
    if (!state.positions[key]) {
      state.positions[key] = {
        marketAddress: action.marketAddress,
        tokenId: String(action.tokenId),
        question: action.question ?? null,
        outcome: action.outcome ?? null,
        buyAt: null,
        detectedAt: new Date().toISOString(),
        initialSize: String(action.balanceOt ?? action.sellAmountOt ?? "0"),
        initialCostBasisUsdt: "0",
        remainingSize: String(action.balanceOt ?? action.sellAmountOt ?? "0"),
        nextStep: 1,
        completed: false,
        stopLossSold: false,
        takeProfitCompleted: false,
        preStartSold: false,
        openTimedExitSold: false,
        retainedToSettlement: false,
        retainedTargetSize: null,
        retainedSellAmount: null,
        retainPercent: null,
        preStartExitHandled: false
      };
    }
    markAutoSellActionApplied(cfg, state.positions[key], action);
  }
  saveAutoSellPositionState(cfg.autoSellPositionStateFile, state);
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

function recordReceiptWatchErrorMarketDecisions(cfg, context = {}, txHash, message, receiptWatch = {}) {
  const markets = Array.isArray(context.marketDetails) ? context.marketDetails : [];
  const action = receiptWatch.status === "dropped"
    ? "receipt-dropped"
    : receiptWatch.status === "timeout" ? "receipt-timeout" : "receipt-error";
  for (const market of markets) {
    recordMarketDecision(cfg, market, action, {
      source: "receipt-watch",
      txHash,
      message: message || receiptWatch.message || receiptWatch.status || "receipt watch error",
      once: false
    });
  }
}

function notifyFeishu(
  cfg,
  { title, level = "info", fields = {}, dedupeKey = null, cooldownMs = 0, fingerprint = null, repeatMs = 0 } = {}
) {
  if (cfg?.executionTestMode) return;
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

function sleepUntil(targetMs) {
  const waitMs = Number(targetMs) - Date.now();
  if (waitMs <= 0) return Promise.resolve();
  return sleep(waitMs);
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

function nextWatchSleepMs(cfg, pending, runtime = null) {
  const defaultMs = cfg.pollMs;
  if (!pending || pending.size === 0) return defaultMs;

  let minActionWaitMs = Infinity;
  for (const record of pending.values()) {
    minActionWaitMs = Math.min(minActionWaitMs, msUntilRecordAction(record, cfg, runtime));
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

function msUntilRecordAction(record, cfg, runtime = null, now = Date.now()) {
  const actionWaitMs = Math.max(0, marketActionTimeMsForRecord(record, cfg, runtime, now) - now);
  const retryWaitMs = Math.max(0, Number(record?.executionRetryAfterMs ?? 0) - now);
  return Math.max(actionWaitMs, retryWaitMs);
}

function marketActionTimeMsForRecord(record, cfg, runtime = null, now = Date.now()) {
  return openBroadcastTimingForRecord(record, cfg, runtime, now).targetMs;
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

function actionConfigForRecord(record, cfg) {
  const rawDelay = record?.openBroadcastDelayMs ?? record?.preparedPlan?.plannedBuy?.openBroadcastDelayMs;
  if (rawDelay === undefined || rawDelay === null || rawDelay === "") return cfg;
  const delay = Number(rawDelay);
  if (!Number.isFinite(delay) || delay < 0) return cfg;
  if (effectivePrebroadcastMs(cfg) > 0) return cfg;
  return {
    ...cfg,
    openBroadcastDelayMs: delay
  };
}

function openBroadcastTimingForRecord(record, cfg, runtime = null, now = Date.now()) {
  const market = pendingMarket(record);
  const actionCfg = actionConfigForRecord(record, cfg);
  const fixedTargetMs = marketActionTimeMs(market, actionCfg);
  const fixed = {
    mode: "fixed",
    reason: "fixed",
    targetMs: fixedTargetMs,
    fixedTargetMs
  };

  if (!shouldUseBlockAwareOpenBroadcast(actionCfg)) return fixed;

  const startMs = new Date(market?.startDate).getTime();
  if (!Number.isFinite(startMs)) return fixed;

  const armMs = startMs + effectivePostOpenBroadcastDelayMs(actionCfg);
  const targetBoundaryMs = startMs + Number(actionCfg.openBroadcastBlockTargetOffsetMs ?? 20000);
  const nominalTargetMs = targetBoundaryMs - Number(actionCfg.openBroadcastBlockAwareLeadMs ?? 0);
  const maxWaitTargetMs = targetBoundaryMs + Number(actionCfg.openBroadcastBlockAwareMaxWaitMs ?? 0);
  let targetMs = Math.max(armMs, nominalTargetMs);
  let reason = "nominal-lead";
  const blockClock = summarizeOpenBroadcastBlockClock(runtime?.openBroadcastBlockClock, market, actionCfg, now);

  if (armMs >= targetBoundaryMs) {
    targetMs = armMs;
    reason = "arm-after-target-boundary";
  } else if (now < armMs) {
    targetMs = armMs;
    reason = "arm-wait";
  } else if (blockClock.targetHeadSeen) {
    targetMs = now;
    reason = "target-head-seen";
  } else if (now >= maxWaitTargetMs) {
    targetMs = now;
    reason = "max-wait-expired";
  } else if (
    blockClock.preTargetHeadCount >= Number(actionCfg.openBroadcastBlockAwarePreTargetCount ?? 0) &&
    now >= targetBoundaryMs - Number(actionCfg.openBroadcastBlockAwarePreTargetSendMs ?? 0)
  ) {
    targetMs = now;
    reason = "pre-target-heads";
  } else if (now >= targetMs) {
    targetMs = now;
    reason = "nominal-reached";
  }

  return {
    mode: "block_aware_20s",
    reason,
    targetMs,
    fixedTargetMs,
    armMs,
    targetBoundaryMs,
    nominalTargetMs,
    maxWaitTargetMs,
    blockClock
  };
}

function summarizeOpenBroadcastBlockClock(state, market, cfg, now = Date.now()) {
  const startMs = new Date(market?.startDate).getTime();
  const targetBoundaryMs = startMs + Number(cfg.openBroadcastBlockTargetOffsetMs ?? 20000);
  const preTargetTimestampMs = Math.floor((targetBoundaryMs - 1) / 1000) * 1000;
  const headMaxAgeMs = Number(cfg.openBroadcastBlockAwareHeadMaxAgeMs ?? 0);
  const heads = Array.isArray(state?.heads) ? state.heads : [];
  const recentHeads = heads.filter((head) => {
    if (!Number.isFinite(head?.timestampMs) || !Number.isFinite(head?.receivedAt)) return false;
    if (headMaxAgeMs <= 0) return true;
    return now - head.receivedAt <= headMaxAgeMs;
  });
  const latestHead = recentHeads.at(-1) ?? null;
  const preTargetHeads = recentHeads.filter((head) => head.timestampMs === preTargetTimestampMs);
  const targetHead = recentHeads.find((head) => head.timestampMs >= targetBoundaryMs) ?? null;
  return {
    active: Boolean(state),
    startedAt: state?.startedAt ?? null,
    lastHeadAt: state?.lastHeadAt ? new Date(state.lastHeadAt).toISOString() : null,
    lastHeadAgeMs: state?.lastHeadAt ? now - state.lastHeadAt : null,
    latestBlockNumber: latestHead?.number ?? null,
    latestTimestampIso: latestHead?.timestampIso ?? null,
    latestReceivedAt: latestHead?.receivedAtIso ?? null,
    latestOffsetMs: latestHead ? latestHead.timestampMs - startMs : null,
    preTargetTimestampIso: Number.isFinite(preTargetTimestampMs) ? new Date(preTargetTimestampMs).toISOString() : null,
    preTargetHeadCount: preTargetHeads.length,
    targetHeadSeen: Boolean(targetHead),
    targetHeadBlockNumber: targetHead?.number ?? null,
    targetHeadReceivedAt: targetHead?.receivedAtIso ?? null,
    errors: state?.errors ?? 0,
    lastError: state?.lastError ?? null
  };
}

function describeOpenBroadcastTiming(timing) {
  if (!timing || timing.mode !== "block_aware_20s") return null;
  return {
    mode: timing.mode,
    reason: timing.reason,
    targetAt: new Date(timing.targetMs).toISOString(),
    armAt: new Date(timing.armMs).toISOString(),
    targetBoundaryAt: new Date(timing.targetBoundaryMs).toISOString(),
    nominalTargetAt: new Date(timing.nominalTargetMs).toISOString(),
    maxWaitTargetAt: new Date(timing.maxWaitTargetMs).toISOString(),
    fixedTargetAt: new Date(timing.fixedTargetMs).toISOString(),
    preTargetHeadCount: timing.blockClock?.preTargetHeadCount ?? 0,
    targetHeadSeen: Boolean(timing.blockClock?.targetHeadSeen),
    latestBlockNumber: timing.blockClock?.latestBlockNumber ?? null,
    latestTimestampIso: timing.blockClock?.latestTimestampIso ?? null,
    latestOffsetMs: timing.blockClock?.latestOffsetMs ?? null,
    lastHeadAgeMs: timing.blockClock?.lastHeadAgeMs ?? null,
    lastError: timing.blockClock?.lastError ?? null
  };
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

function builderBundleConfigSummary(cfg) {
  const effective = applyBuilderBundleTimingPreset(cfg);
  const timing = effective.builderBundleTimingResolved ?? resolveBuilderBundleTimingPreset(effective);
  return {
    killSwitch: Boolean(effective.builderBundleKillSwitch),
    configuredEnabled: Boolean(cfg.builderBundleEnabled),
    enabled: Boolean(effective.builderBundleEnabled),
    provider: effective.builderBundleUrl ? wsProviderLabel(effective.builderBundleUrl) : null,
    builders: [
      {
        id: "48club",
        enabled: Boolean(effective.builderBundleEnabled),
        provider: effective.builderBundleUrl ? wsProviderLabel(effective.builderBundleUrl) : null,
        tipTo: effective.builderBundleTipTo ?? null
      },
      {
        id: "blockrazor",
        enabled: Boolean(effective.builderBundleEnabled && effective.blockrazorBuilderEnabled),
        provider: effective.blockrazorBuilderUrl ? wsProviderLabel(effective.blockrazorBuilderUrl) : null,
        tipTo: effective.blockrazorBuilderTipTo ?? null,
        authConfigured: Boolean(effective.blockrazorBuilderAuthToken)
      }
    ],
    tipBnb: effective.builderBundleTipBnb ?? null,
    tipGasPriceGwei: effective.builderBundleTipGasPriceGwei ?? null,
    maxBlocks: effective.builderBundleMaxBlocks ?? null,
    maxBlockLookup: Boolean(effective.builderBundleMaxBlockLookup),
    maxTimestampOffsetSeconds: effective.builderBundleMaxTimestampOffsetSeconds ?? null,
    timeoutMs: effective.builderBundleTimeoutMs ?? null,
    configuredTimeoutMs: timing.configuredTimeoutMs ?? null,
    mode: effective.builderBundleMode ?? "concurrent",
    timingMode: timing.mode,
    timingEligible: timing.eligible,
    timingReason: timing.reason,
    targetSecond: timing.targetSecond,
    fallbackOffsetMs: timing.fallbackOffsetMs,
    earlySubmitOffsetMs: timing.earlySubmitOffsetMs,
    targetBoundaryLeadMs: timing.targetBoundaryLeadMs ?? null,
    publicFallbackLeadMs: timing.publicFallbackLeadMs ?? null,
    fanoutDelayMs: effective.builderBundleFanoutDelayMs ?? null,
    earlySubmitLeadMs: effective.builderBundleEarlySubmitLeadMs ?? null,
    minTimestampOffsetMs: effective.builderBundleMinTimestampOffsetMs ?? null,
    maxTimestampOffsetMs: effective.builderBundleMaxTimestampOffsetMs ?? null,
    noMerge: Boolean(effective.builderBundleNoMerge),
    positionFirst: Boolean(effective.builderBundlePositionFirst),
    timedBuyExecutor: {
      enabled: Boolean(effective.builderTimedBuyExecutorEnabled),
      address: effective.builderTimedBuyExecutorAddress ?? null,
      exactSecond: Boolean(effective.builderTimedBuyExecutorExactSecond),
      releasePollMs: effective.builderTimedBuyExecutorReleasePollMs ?? null
    },
    timestampGuard: {
      enabled: Boolean(effective.builderTimestampGuardEnabled),
      address: effective.builderTimestampGuardAddress ?? null,
      gasLimit: effective.builderTimestampGuardGasLimit ?? null,
      retryIntervalMs: effective.builderTimestampGuardRetryIntervalMs ?? null,
      retryUntilLeadMs: effective.builderTimestampGuardRetryUntilLeadMs ?? null,
      releasePollMs: effective.builderTimestampGuardReleasePollMs ?? null
    }
  };
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
