#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http
} from "viem";
import { bsc } from "viem/chains";

import { appendJsonl, readConfig } from "../src/config.js";
import { readJsonlTail } from "../src/jsonl-tail.js";
import {
  appendGasLedgerEntries,
  bnbUsdtPriceForBlock,
  buildGasLedgerEntry
} from "../src/gas-ledger.js";
import {
  ADDRESSES,
  buildDirectSellPlan,
  ensureMarketOperatorApproval,
  fetchOpenPositions,
  makeClients,
  sellOutcomesBatch
} from "../src/fortytwo.js";

const DEFAULT_PROFILE_ENV = "/etc/42space/profiles/42space-3.env";
const DEFAULT_THRESHOLD_USDT = 200;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_BLOCK_LOOKBACK = 0;
const DEFAULT_SELL_PERCENT = 100;
const DEFAULT_RPC_STATS_MS = 60000;
const DEFAULT_FEED_POLL_MS = 100;
const DEFAULT_FEED_FILE = "data/shared-rpc-observer/feed.jsonl";
const DEFAULT_STATE_FILE = "data/orderflow-trigger-sell-state.json";
const DEFAULT_LOG_FILE = "output/orderflow-trigger-sell.jsonl";
const MARKET_TRADE_TOPIC = "0xf2e90b10bd525a6b1fe02d09e8133d3e38c9a87376ed4850904ca21e6e27abec";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const profileEnvFile = args.profileEnv ?? process.env.ORDERFLOW_TRIGGER_PROFILE_ENV ?? DEFAULT_PROFILE_ENV;
  const profileEnv = fs.existsSync(profileEnvFile) ? parseEnvFile(profileEnvFile) : {};
  Object.assign(process.env, profileEnv);

  const cfg = readConfig();
  const appDir = path.resolve(args.appDir ?? process.cwd());
  const dataDir = path.dirname(cfg.runtimeConfigFile);
  const market = getAddress(requiredArg(args.market ?? process.env.ORDERFLOW_TRIGGER_MARKET, "ORDERFLOW_TRIGGER_MARKET or --market"));
  const thresholdUsdt = positiveNumber(args.thresholdUsdt ?? process.env.ORDERFLOW_TRIGGER_THRESHOLD_USDT, DEFAULT_THRESHOLD_USDT);
  const sellPercent = positiveNumber(args.sellPercent ?? process.env.ORDERFLOW_TRIGGER_SELL_PERCENT, DEFAULT_SELL_PERCENT);
  const pollMs = positiveInteger(args.pollMs ?? process.env.ORDERFLOW_TRIGGER_POLL_MS, DEFAULT_POLL_MS);
  const lookbackBlocks = nonNegativeInteger(args.lookbackBlocks ?? process.env.ORDERFLOW_TRIGGER_LOOKBACK_BLOCKS, DEFAULT_BLOCK_LOOKBACK);
  const maxRangeBlocks = positiveInteger(args.maxRangeBlocks ?? process.env.ORDERFLOW_TRIGGER_MAX_RANGE_BLOCKS, 1000);
  const rpcStatsMs = nonNegativeInteger(
    args.rpcStatsMs ?? process.env.ORDERFLOW_TRIGGER_RPC_STATS_MS,
    DEFAULT_RPC_STATS_MS
  );
  const discoverySource = String(
    args.source ?? process.env.ORDERFLOW_TRIGGER_SOURCE ?? "rpc"
  ).trim().toLowerCase();
  if (!["rpc", "feed"].includes(discoverySource)) {
    throw new Error("ORDERFLOW_TRIGGER_SOURCE must be rpc or feed");
  }
  const feedFile = path.resolve(
    args.feedFile ?? process.env.ORDERFLOW_TRIGGER_FEED_FILE ?? path.join(appDir, DEFAULT_FEED_FILE)
  );
  const feedPollMs = positiveInteger(
    args.feedPollMs ?? process.env.ORDERFLOW_TRIGGER_FEED_POLL_MS,
    DEFAULT_FEED_POLL_MS
  );
  const feedFromStart = boolFlag(
    args.feedFromStart ?? process.env.ORDERFLOW_TRIGGER_FEED_FROM_START,
    false
  );
  const configuredWatchedTokenIds = csvSet(args.tokenIds ?? process.env.ORDERFLOW_TRIGGER_TOKEN_IDS);
  const watchedTokenIds = new Set(configuredWatchedTokenIds);
  const watchCurrentPositions = boolFlag(
    args.watchCurrentPositions ?? process.env.ORDERFLOW_TRIGGER_WATCH_CURRENT_POSITIONS,
    false
  );
  if (watchedTokenIds.size === 0 && !watchCurrentPositions) {
    throw new Error("ORDERFLOW_TRIGGER_TOKEN_IDS or --token-ids is required unless current-position watch is enabled");
  }
  const watchCurrentPositionsRefreshMs = positiveInteger(
    args.watchCurrentPositionsRefreshMs ?? process.env.ORDERFLOW_TRIGGER_WATCH_CURRENT_POSITIONS_REFRESH_MS,
    30000
  );
  const sellMode = String(args.sellMode ?? process.env.ORDERFLOW_TRIGGER_SELL_MODE ?? "matched_outcomes").trim();
  if (!["matched_outcomes", "all_watched"].includes(sellMode)) {
    throw new Error("ORDERFLOW_TRIGGER_SELL_MODE must be matched_outcomes or all_watched");
  }
  const execute = Boolean(args.execute || process.env.ORDERFLOW_TRIGGER_EXECUTE === "1");
  if (!execute) {
    cfg.dryRun = true;
    cfg.execute = false;
  }
  const walletAddress = getAddress(args.wallet ?? cfg.walletAddress ?? makeClients(cfg).account?.address);
  if (!walletAddress) throw new Error("WALLET_ADDRESS or PRIVATE_KEY-derived account is required");
  if (execute && makeClients(cfg).account?.address?.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("Real sell wallet must match PRIVATE_KEY-derived account");
  }
  cfg.autoSellGasPriceGwei = String(args.sellGasPriceGwei ?? process.env.ORDERFLOW_TRIGGER_SELL_GAS_PRICE_GWEI ?? cfg.autoSellGasPriceGwei ?? "");

  const stateFile = path.resolve(args.stateFile ?? process.env.ORDERFLOW_TRIGGER_STATE_FILE ?? path.join(dataDir, DEFAULT_STATE_FILE));
  const logFile = path.resolve(args.logFile ?? process.env.ORDERFLOW_TRIGGER_LOG_FILE ?? path.join(appDir, DEFAULT_LOG_FILE));
  const state = loadState(stateFile);
  const priceCache = new Map();
  state.market ??= market;
  state.seenTxs ??= {};
  state.failedTxs ??= {};
  state.processingTxs ??= {};
  state.soldTokenIds ??= {};

  const rpcUrl = args.rpcUrl ?? process.env.ORDERFLOW_TRIGGER_RPC_URL ?? cfg.rpcUrl;
  const rpcStats = createRpcStats();
  const publicClient = createPublicClient({
    chain: bsc,
    transport: instrumentTransport(http(rpcUrl), rpcStats)
  });
  const baseCtx = {
    cfg,
    publicClient,
    state,
    stateFile,
    logFile,
    priceCache,
    market,
    walletAddress,
    configuredWatchedTokenIds,
    watchedTokenIds,
    watchCurrentPositions,
    watchCurrentPositionsRefreshMs,
    discoverySource,
    feedFile,
    expandTradeRowsFromReceipt: discoverySource === "feed",
    lastPositionWatchRefreshAt: 0
  };
  await refreshWatchedTokenIdsFromPositions(baseCtx, true);
  if (execute) {
    const approval = await ensureMarketOperatorApproval(cfg, market);
    await appendOrderflowGasLedger({
      cfg,
      publicClient,
      walletAddress,
      priceCache
    }, {
      execution: approval,
      action: "approval",
      source: "orderflow-trigger-operator-approval",
      allocations: [{ market, action: "approval", weight: 1 }]
    });
    appendJsonl(logFile, {
      level: "orderflow-trigger-sell-operator-approval",
      mode: "execute",
      market,
      approval,
      at: new Date().toISOString()
    });
  }

  const previousDiscoverySource = state.discoverySource;
  let lastProcessedBlock = state.lastProcessedBlock !== undefined
    ? BigInt(state.lastProcessedBlock)
    : 0n;
  if (discoverySource === "rpc" && state.lastProcessedBlock === undefined) {
    lastProcessedBlock = await initialLastProcessedBlock(publicClient, lookbackBlocks);
  }
  if (discoverySource === "feed") {
    if (!feedFromStart) armFeedCutover(state, { previousDiscoverySource, lastProcessedBlock });
    const initialized = readJsonlTail(feedFile, state.feedCursor, {
      startAtEnd: !feedFromStart && state.feedCutoverAfterBlock === undefined
    });
    if (initialized.missing) throw new Error(`Orderflow observer feed is missing: ${feedFile}`);
    state.feedCursor = initialized.cursor;
  }
  state.discoverySource = discoverySource;
  state.lastProcessedBlock = lastProcessedBlock.toString();
  saveState(stateFile, state);

  appendJsonl(logFile, {
    level: "orderflow-trigger-sell-started",
    mode: execute ? "execute" : "dry-run",
    discoverySource,
    profileEnvFile,
    market,
    wallet: walletAddress,
    configuredWatchedTokenIds: [...configuredWatchedTokenIds],
    watchedTokenIds: [...watchedTokenIds],
    watchCurrentPositions,
    watchCurrentPositionsRefreshMs,
    thresholdUsdt,
    sellMode,
    sellPercent,
    pollMs,
    feedPollMs: discoverySource === "feed" ? feedPollMs : null,
    feedFile: discoverySource === "feed" ? feedFile : null,
    feedOffset: discoverySource === "feed" ? state.feedCursor?.offset ?? null : null,
    feedCutoverAfterBlock: discoverySource === "feed" ? state.feedCutoverAfterBlock ?? null : null,
    rpcStatsMs,
    lookbackBlocks,
    lastProcessedBlock: lastProcessedBlock.toString(),
    sellGasPriceGwei: cfg.autoSellGasPriceGwei || cfg.gasPriceGwei,
    at: new Date().toISOString()
  });

  const loopCtx = {
    ...baseCtx,
    thresholdUsdt,
    sellMode,
    sellPercent,
    maxRangeBlocks
  };
  while (true) {
    try {
      await refreshWatchedTokenIdsFromPositions(baseCtx);
      await retryFailedTransactions(loopCtx);
      if (discoverySource === "feed") {
        await processObserverFeed(loopCtx);
      } else {
        const latestBlock = await publicClient.getBlockNumber();
        if (latestBlock > lastProcessedBlock) {
          const result = await processBlockRange({
            ...loopCtx,
            fromBlock: lastProcessedBlock + 1n,
            toBlock: latestBlock
          });
          lastProcessedBlock = result.lastProcessedBlock;
          state.lastProcessedBlock = lastProcessedBlock.toString();
          saveState(stateFile, state);
        }
      }
    } catch (error) {
      appendJsonl(logFile, {
        level: "orderflow-trigger-sell-error",
        market,
        message: error?.message ?? String(error),
        at: new Date().toISOString()
      });
    }
    maybeFlushRpcStats({ rpcStats, rpcStatsMs, logFile, market });
    await sleep(discoverySource === "feed" ? feedPollMs : pollMs);
  }
}

async function processBlockRange(ctx) {
  let cursor = ctx.fromBlock;
  let lastProcessedBlock = ctx.fromBlock - 1n;
  while (cursor <= ctx.toBlock) {
    const chunkTo = minBigInt(ctx.toBlock, cursor + BigInt(ctx.maxRangeBlocks) - 1n);
    const logs = await getMarketTradeLogs(ctx.publicClient, ctx.market, cursor, chunkTo);
    const trades = logs.map((log) => parseMarketTradeLog(log, ctx.market)).filter(Boolean);
    const groups = groupByTxHash(trades);
    await processTradeGroups(ctx, groups);
    lastProcessedBlock = chunkTo;
    cursor = chunkTo + 1n;
  }
  return { lastProcessedBlock };
}

async function processObserverFeed(ctx) {
  const tail = readJsonlTail(ctx.feedFile, ctx.state.feedCursor, { startAtEnd: true });
  if (tail.missing) throw new Error(`Orderflow observer feed is missing: ${ctx.feedFile}`);
  if (tail.bytesRead === 0 && !tail.rotated && !tail.truncated && tail.parseErrors === 0) {
    return { rowsRead: 0, tradeRows: 0, bytesRead: 0, feedOffset: tail.cursor?.offset ?? null };
  }
  const cutoverAfterBlock = optionalBlockNumber(ctx.state.feedCutoverAfterBlock);
  const marketRows = tail.rows
    .filter((row) => row.level === "shared-rpc-observer-market-trade")
    .filter((row) => normalizeAddress(row.market) === normalizeAddress(ctx.market));
  const trades = marketRows
    .filter((row) => observerFeedRowAfterBlock(row, cutoverAfterBlock))
    .map(tradeRowFromObserverFeed)
    .filter(Boolean);
  await processTradeGroups(ctx, groupByTxHash(trades));
  const observedBlock = maxObservedBlock(tail.rows);
  if (observedBlock !== null && observedBlock > BigInt(ctx.state.lastProcessedBlock ?? 0)) {
    ctx.state.lastProcessedBlock = observedBlock.toString();
  }
  ctx.state.feedCursor = tail.cursor;
  ctx.state.feedLastReadAt = new Date().toISOString();
  if (cutoverAfterBlock !== null) {
    delete ctx.state.feedCutoverAfterBlock;
    appendJsonl(ctx.logFile, {
      level: "orderflow-trigger-feed-cutover-complete",
      market: ctx.market,
      replayAfterBlock: cutoverAfterBlock.toString(),
      rowsRead: tail.rows.length,
      marketRows: marketRows.length,
      tradeRows: trades.length,
      skippedPreCutoverMarketRows: marketRows.length - trades.length,
      feedOffset: tail.cursor?.offset ?? null,
      at: new Date().toISOString()
    });
  }
  if (tail.rotated || tail.truncated || tail.parseErrors > 0) {
    appendJsonl(ctx.logFile, {
      level: "orderflow-trigger-feed-recovered",
      market: ctx.market,
      rotated: tail.rotated,
      truncated: tail.truncated,
      parseErrors: tail.parseErrors,
      at: new Date().toISOString()
    });
  }
  saveState(ctx.stateFile, ctx.state);
  return {
    rowsRead: tail.rows.length,
    tradeRows: trades.length,
    bytesRead: tail.bytesRead,
    feedOffset: tail.cursor?.offset ?? null
  };
}

function armFeedCutover(state, { previousDiscoverySource, lastProcessedBlock }) {
  if (state.feedCursor?.initialized || state.feedCutoverAfterBlock !== undefined) return false;
  if (previousDiscoverySource === "feed" || state.lastProcessedBlock === undefined) return false;
  const processedBlock = BigInt(lastProcessedBlock);
  state.feedCutoverAfterBlock = (processedBlock > 0n ? processedBlock - 1n : 0n).toString();
  return true;
}

function optionalBlockNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function observerFeedRowAfterBlock(row, blockNumber) {
  if (blockNumber === null) return true;
  try {
    return BigInt(row?.blockNumber) > blockNumber;
  } catch {
    return false;
  }
}

function maxObservedBlock(rows) {
  let maximum = null;
  for (const row of rows) {
    if (row?.blockNumber === undefined || row.blockNumber === null) continue;
    try {
      const block = BigInt(row.blockNumber);
      if (maximum === null || block > maximum) maximum = block;
    } catch {
      // Ignore unrelated rows with malformed block metadata.
    }
  }
  return maximum;
}

async function processTradeGroups(ctx, groups) {
  for (const [txHash, rows] of groups.entries()) {
    if (isHandledTx(ctx.state, txHash)) continue;
    markTxProcessing(ctx, txHash, rows);
    try {
      const result = await handleTradeTx(ctx, txHash, rows);
      markTxHandled(ctx, txHash, result);
    } catch (error) {
      recordFailedTx(ctx, txHash, rows, error);
      appendJsonl(ctx.logFile, {
        level: "orderflow-trigger-sell-tx-error",
        market: ctx.market,
        txHash,
        message: error?.message ?? String(error),
        at: new Date().toISOString()
      });
    }
    pruneTxState(ctx.state);
    saveState(ctx.stateFile, ctx.state);
  }
}

function tradeRowFromObserverFeed(row) {
  try {
    if (!row?.txHash || row.tokenId === undefined || row.netCollateral === undefined || row.size === undefined) {
      return null;
    }
    return {
      txHash: row.txHash,
      blockNumber: Number(row.blockNumber),
      transactionIndex: Number(row.transactionIndex),
      logIndex: Number(row.logIndex),
      operator: row.operator ?? null,
      user: row.user ?? null,
      tokenId: String(row.tokenId),
      netCollateralSigned: BigInt(row.netCollateral),
      sizeSigned: BigInt(row.size)
    };
  } catch {
    return null;
  }
}

async function handleTradeTx(ctx, txHash, rows) {
  let receipt = null;
  if (ctx.expandTradeRowsFromReceipt) {
    receipt = await ctx.publicClient.getTransactionReceipt({ hash: txHash });
    const receiptRows = marketTradeRowsFromReceipt(receipt, ctx.market);
    if (receiptRows.length > 0) rows = receiptRows;
  }
  const watchedBuys = rows
    .filter((row) => ctx.watchedTokenIds.has(String(row.tokenId)))
    .filter((row) => row.netCollateralSigned > 0n);
  if (watchedBuys.length === 0) return { status: "ignored_no_watched_buy" };

  const user = majority(watchedBuys.map((row) => row.user).filter(Boolean));
  if (user && user.toLowerCase() === ctx.walletAddress.toLowerCase()) return { status: "ignored_self" };

  const buyCostUsdt = sumBigInt(watchedBuys.map((row) => row.netCollateralSigned));
  const buyCost = numberFromUnits(buyCostUsdt, 18);
  receipt ??= await ctx.publicClient.getTransactionReceipt({ hash: txHash });
  const transferCost = transferCostsFromUserToRouter(receipt.logs, user);
  const transferCostUsdt = numberFromUnits(sumBigInt(transferCost), 18);
  const triggerCostUsdt = buyCost > 0 ? buyCost : transferCostUsdt;
  const matchedTokenIds = [...new Set(watchedBuys.map((row) => String(row.tokenId)))];

  appendJsonl(ctx.logFile, {
    level: "orderflow-trigger-sell-trade",
    market: ctx.market,
    txHash,
    user,
    matchedTokenIds,
    watchedNetCollateralUsdt: round(triggerCostUsdt),
    routerTransferUsdt: round(transferCostUsdt),
    thresholdUsdt: ctx.thresholdUsdt,
    blockNumber: String(receipt.blockNumber),
    transactionIndex: Number(receipt.transactionIndex),
    triggered: triggerCostUsdt >= ctx.thresholdUsdt,
    at: new Date().toISOString()
  });

  if (triggerCostUsdt < ctx.thresholdUsdt) {
    return {
      status: "below_threshold",
      triggerCostUsdt: round(triggerCostUsdt),
      matchedTokenIds
    };
  }
  const sellTokenIds = ctx.sellMode === "all_watched" ? [...ctx.watchedTokenIds] : matchedTokenIds;
  const execution = await executeTriggeredSell(ctx, {
    txHash,
    user,
    receipt,
    triggerCostUsdt,
    matchedTokenIds,
    sellTokenIds
  });
  return {
    status: "triggered",
    triggerCostUsdt: round(triggerCostUsdt),
    matchedTokenIds,
    executionStatus: execution?.status ?? null
  };
}

async function refreshWatchedTokenIdsFromPositions(ctx, force = false) {
  if (!ctx.watchCurrentPositions) return { enabled: false };
  const now = Date.now();
  if (!force && now - Number(ctx.lastPositionWatchRefreshAt ?? 0) < ctx.watchCurrentPositionsRefreshMs) {
    return { enabled: true, refreshed: false };
  }
  ctx.lastPositionWatchRefreshAt = now;
  try {
    const positions = await fetchOpenPositions(ctx.cfg, {
      user: ctx.walletAddress,
      market: ctx.market,
      limit: 100
    });
    const addedTokenIds = mergeCurrentPositionTokenIds(ctx.watchedTokenIds, positions);
    const currentPositionTokenIds = currentPositionTokenIdsFromPositions(positions);
    ctx.state.configuredWatchedTokenIds = [...ctx.configuredWatchedTokenIds].map(String);
    ctx.state.dynamicWatchedTokenIds = currentPositionTokenIds;
    ctx.state.watchedTokenIds = [...ctx.watchedTokenIds].map(String);
    ctx.state.lastPositionWatchRefreshAt = new Date(now).toISOString();
    saveState(ctx.stateFile, ctx.state);
    if (force || addedTokenIds.length > 0) {
      appendJsonl(ctx.logFile, {
        level: "orderflow-trigger-sell-watch-refresh",
        market: ctx.market,
        configuredWatchedTokenIds: ctx.state.configuredWatchedTokenIds,
        dynamicWatchedTokenIds: currentPositionTokenIds,
        addedTokenIds,
        watchedTokenIds: ctx.state.watchedTokenIds,
        at: new Date(now).toISOString()
      });
    }
    return { enabled: true, refreshed: true, addedTokenIds };
  } catch (error) {
    appendJsonl(ctx.logFile, {
      level: "orderflow-trigger-sell-watch-refresh-error",
      market: ctx.market,
      message: errorMessage(error),
      at: new Date().toISOString()
    });
    return { enabled: true, refreshed: false, error: errorMessage(error) };
  }
}

async function executeTriggeredSell(ctx, trigger) {
  const freshPositions = await fetchOpenPositions(ctx.cfg, {
    user: ctx.walletAddress,
    market: ctx.market,
    limit: 100
  });
  const sellSet = new Set(trigger.sellTokenIds.map(String));
  const candidates = freshPositions
    .filter((position) => sellSet.has(String(position.tokenId)))
    .filter((position) => Number(position.size ?? 0) > 0);

  const selected = [];
  const plans = [];
  const skipped = [];
  for (const position of candidates) {
    try {
      const plan = await buildDirectSellPlan(ctx.publicClient, {
        market: position.marketAddress,
        tokenId: position.tokenId,
        owner: ctx.walletAddress,
        percent: ctx.sellPercent
      });
      selected.push(position);
      plans.push(plan);
    } catch (error) {
      if (isNoSellableBalanceError(error)) {
        skipped.push({
          tokenId: String(position.tokenId),
          outcome: position.outcome?.name ?? null,
          reason: errorMessage(error)
        });
        continue;
      }
      throw error;
    }
  }

  if (selected.length === 0) {
    appendJsonl(ctx.logFile, {
      level: "orderflow-trigger-sell-no-position",
      market: ctx.market,
      trigger: summarizeOrderflowTrigger(trigger),
      candidates: candidates.map((position) => ({
        tokenId: String(position.tokenId),
        outcome: position.outcome?.name ?? null,
        size: String(position.size ?? "")
      })),
      skipped,
      at: new Date().toISOString()
    });
    return { status: "no_position", positionCount: 0 };
  }

  const dryRun = ctx.cfg.dryRun || !ctx.cfg.execute;
  let execution = null;
  if (!dryRun) {
    execution = await sellOutcomesBatch(ctx.cfg, plans, { requirePreapprovedOperator: true });
    await appendOrderflowGasLedger(ctx, {
      execution,
      action: "sell",
      source: "orderflow-trigger-sell",
      wallet: ctx.walletAddress,
      allocations: orderflowSellAllocations(selected, plans)
    });
    for (const approval of execution?.approvals ?? []) {
      await appendOrderflowGasLedger(ctx, {
        execution: approval,
        action: "approval",
        source: "orderflow-trigger-sell-approval",
        wallet: ctx.walletAddress,
        txHashKey: "operatorApprovalHash",
        fieldPrefix: "operatorApproval",
        allocations: [{ market: approval.market ?? ctx.market, action: "approval", weight: 1 }]
      });
    }
    for (const position of selected) {
      const index = selected.indexOf(position);
      ctx.state.soldTokenIds[String(position.tokenId)] = {
        soldAt: new Date().toISOString(),
        triggerTxHash: trigger.txHash,
        outcome: position.outcome?.name ?? null,
        soldPositionSize: String(position.size ?? ""),
        sellAmountOt: plans[index] ? formatUnits(plans[index].amount, 18) : null
      };
    }
    saveState(ctx.stateFile, ctx.state);
  }

  appendJsonl(ctx.logFile, {
    level: "orderflow-trigger-sell-execution",
    mode: dryRun ? "dry-run" : "execute",
    market: ctx.market,
    trigger: {
      txHash: trigger.txHash,
      user: trigger.user,
      triggerCostUsdt: round(trigger.triggerCostUsdt),
      matchedTokenIds: trigger.matchedTokenIds,
      blockNumber: String(trigger.receipt.blockNumber),
      transactionIndex: Number(trigger.receipt.transactionIndex)
    },
    sellPercent: ctx.sellPercent,
    positions: selected.map((position, index) => ({
      outcome: position.outcome?.name ?? null,
      tokenId: String(position.tokenId),
      currentSize: String(position.size ?? ""),
      sellAmountOt: formatUnits(plans[index].amount, 18)
    })),
    execution,
    at: new Date().toISOString()
  });
  return {
    status: dryRun ? "dry_run" : "sold",
    positionCount: selected.length,
    txHash: execution?.txHash ?? null
  };
}

function currentPositionTokenIdsFromPositions(positions = []) {
  return [...new Set(
    positions
      .filter((position) => Number(position?.size ?? 0) > 0)
      .map((position) => String(position.tokenId))
  )].sort(compareNumericString);
}

function mergeCurrentPositionTokenIds(watchedTokenIds, positions = []) {
  const added = [];
  for (const tokenId of currentPositionTokenIdsFromPositions(positions)) {
    if (watchedTokenIds.has(tokenId)) continue;
    watchedTokenIds.add(tokenId);
    added.push(tokenId);
  }
  return added;
}

function compareNumericString(a, b) {
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function isNoSellableBalanceError(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("sell amount is zero") ||
    (message.includes("outcome balance") && message.includes("is below sell amount"));
}

function orderflowSellAllocations(positions = [], plans = []) {
  return positions.map((position, index) => {
    const plan = plans[index] ?? {};
    const expected = plan.expectedCollateralToUser !== undefined && plan.expectedCollateralToUser !== null
      ? numberFromUnits(plan.expectedCollateralToUser, 18)
      : 0;
    return {
      market: position.marketAddress,
      question: position.question?.title ?? null,
      tokenId: position.tokenId,
      outcome: position.outcome?.name ?? null,
      action: "sell",
      amountUsdt: expected > 0 ? expected : null,
      weight: expected > 0 ? expected : 1
    };
  });
}

async function appendOrderflowGasLedger(ctx, {
  execution,
  action,
  source,
  wallet = "",
  allocations = [],
  txHashKey = "txHash",
  fieldPrefix = ""
} = {}) {
  const txHash = execution?.[txHashKey];
  const gasUsedKey = fieldPrefix ? `${fieldPrefix}GasUsed` : "gasUsed";
  const effectiveGasPriceKey = fieldPrefix ? `${fieldPrefix}EffectiveGasPrice` : "effectiveGasPrice";
  const gasUsed = execution?.[gasUsedKey];
  const effectiveGasPrice = execution?.[effectiveGasPriceKey];
  if (!txHash || !gasUsed || !effectiveGasPrice) return;
  try {
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
    const blockNumber = receipt?.blockNumber ?? (
      execution?.blockNumber !== undefined && execution?.blockNumber !== null
        ? BigInt(execution.blockNumber)
        : null
    );
    const [transaction, block] = await Promise.all([
      ctx.publicClient.getTransaction({ hash: txHash }).catch(() => null),
      receipt?.blockHash
        ? ctx.publicClient.getBlock({ blockHash: receipt.blockHash }).catch(() => null)
        : blockNumber
          ? ctx.publicClient.getBlock({ blockNumber }).catch(() => null)
          : Promise.resolve(null)
    ]);
    const priceInfo = await bnbUsdtPriceForBlock(block, ctx.priceCache).catch((error) => ({
      price: null,
      source: null,
      error: error?.message ?? String(error)
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
      profile: ctx.cfg.botName,
      source,
      action,
      wallet: wallet || ctx.walletAddress,
      allocations,
      bnbUsdtPrice: priceInfo?.price ?? null,
      bnbUsdtSource: priceInfo?.source ?? "",
      metadata: {
        priceError: priceInfo?.error ?? null
      }
    });
    appendGasLedgerEntries(ctx.cfg.gasLedgerFile, [entry]);
  } catch (error) {
    appendJsonl(ctx.logFile ?? path.join(process.cwd(), DEFAULT_LOG_FILE), {
      level: "orderflow-trigger-gas-ledger-error",
      source,
      txHash,
      message: error?.message ?? String(error),
      at: new Date().toISOString()
    });
  }
}

async function retryFailedTransactions(ctx) {
  const entries = Object.entries(ctx.state.failedTxs ?? {});
  const now = Date.now();
  for (const [txHash, failed] of entries) {
    if (isHandledTx(ctx.state, txHash)) {
      delete ctx.state.failedTxs[txHash];
      saveState(ctx.stateFile, ctx.state);
      continue;
    }
    if (failed.nextRetryAt && Date.parse(failed.nextRetryAt) > now) continue;
    const rows = deserializeTradeRows(failed.rows ?? []);
    if (rows.length === 0) {
      markTxHandled(ctx, txHash, { status: "failed_no_rows" });
      pruneTxState(ctx.state);
      saveState(ctx.stateFile, ctx.state);
      continue;
    }
    markTxProcessing(ctx, txHash, rows, true);
    try {
      const result = await handleTradeTx(ctx, txHash, rows);
      markTxHandled(ctx, txHash, result);
      appendJsonl(ctx.logFile, {
        level: "orderflow-trigger-sell-tx-retry-success",
        market: ctx.market,
        txHash,
        result,
        at: new Date().toISOString()
      });
    } catch (error) {
      recordFailedTx(ctx, txHash, rows, error, true);
      appendJsonl(ctx.logFile, {
        level: "orderflow-trigger-sell-tx-retry-error",
        market: ctx.market,
        txHash,
        attempts: ctx.state.failedTxs[txHash]?.attempts ?? null,
        message: error?.message ?? String(error),
        nextRetryAt: ctx.state.failedTxs[txHash]?.nextRetryAt ?? null,
        at: new Date().toISOString()
      });
    }
    pruneTxState(ctx.state);
    saveState(ctx.stateFile, ctx.state);
  }
}

function isHandledTx(state, txHash) {
  const entry = state.seenTxs?.[txHash];
  if (!entry) return false;
  return entry.status ? entry.status === "handled" : true;
}

function markTxProcessing(ctx, txHash, rows, retry = false) {
  ctx.state.processingTxs ??= {};
  const previousAttempts = ctx.state.failedTxs?.[txHash]?.attempts ?? 0;
  ctx.state.processingTxs[txHash] = {
    startedAt: new Date().toISOString(),
    retry,
    attempts: retry ? previousAttempts + 1 : previousAttempts
  };
  saveState(ctx.stateFile, ctx.state);
}

function markTxHandled(ctx, txHash, result = {}) {
  ctx.state.seenTxs ??= {};
  ctx.state.failedTxs ??= {};
  ctx.state.processingTxs ??= {};
  ctx.state.seenTxs[txHash] = {
    status: "handled",
    handledAt: new Date().toISOString(),
    result
  };
  delete ctx.state.failedTxs[txHash];
  delete ctx.state.processingTxs[txHash];
}

function recordFailedTx(ctx, txHash, rows, error, retry = false) {
  ctx.state.failedTxs ??= {};
  ctx.state.processingTxs ??= {};
  const previous = ctx.state.failedTxs[txHash] ?? {};
  const attempts = Number(previous.attempts ?? 0) + 1;
  const retryDelayMs = retryDelayForAttempts(attempts);
  ctx.state.failedTxs[txHash] = {
    status: "failed",
    firstFailedAt: previous.firstFailedAt ?? new Date().toISOString(),
    lastFailedAt: new Date().toISOString(),
    nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
    attempts,
    retry,
    message: error?.message ?? String(error),
    rows: serializeTradeRows(rows)
  };
  delete ctx.state.processingTxs[txHash];
}

function retryDelayForAttempts(attempts) {
  return Math.min(60000, 1000 * Math.max(1, Math.min(60, attempts)));
}

function summarizeOrderflowTrigger(trigger = {}) {
  const receipt = trigger.receipt ?? {};
  return {
    txHash: trigger.txHash ?? null,
    user: trigger.user ?? null,
    triggerCostUsdt: round(trigger.triggerCostUsdt),
    matchedTokenIds: (trigger.matchedTokenIds ?? []).map(String),
    sellTokenIds: (trigger.sellTokenIds ?? []).map(String),
    blockNumber: receipt.blockNumber !== undefined && receipt.blockNumber !== null
      ? String(receipt.blockNumber)
      : null,
    transactionIndex: receipt.transactionIndex !== undefined && receipt.transactionIndex !== null
      ? Number(receipt.transactionIndex)
      : null,
    receiptStatus: receipt.status !== undefined && receipt.status !== null
      ? String(receipt.status)
      : null
  };
}

function instrumentTransport(baseTransport, stats) {
  return (options) => {
    const transport = baseTransport(options);
    return {
      ...transport,
      request: async (requestArgs) => {
        const startedAt = Date.now();
        let succeeded = false;
        try {
          const result = await transport.request(requestArgs);
          succeeded = true;
          return result;
        } finally {
          try {
            recordRpcStat(stats, requestArgs?.method, Date.now() - startedAt, succeeded);
          } catch {
            // Metrics must never affect observer or sell execution behavior.
          }
        }
      }
    };
  };
}

function createRpcStats(startedAt = Date.now()) {
  return {
    startedAt,
    totalRequests: 0,
    totalErrors: 0,
    methods: new Map()
  };
}

function recordRpcStat(stats, method, latencyMs, succeeded) {
  const name = String(method ?? "unknown");
  const row = stats.methods.get(name) ?? {
    requests: 0,
    errors: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0
  };
  const safeLatencyMs = Math.max(0, Number(latencyMs) || 0);
  row.requests += 1;
  row.errors += succeeded ? 0 : 1;
  row.totalLatencyMs += safeLatencyMs;
  row.maxLatencyMs = Math.max(row.maxLatencyMs, safeLatencyMs);
  stats.methods.set(name, row);
  stats.totalRequests += 1;
  stats.totalErrors += succeeded ? 0 : 1;
}

function consumeRpcStats(stats, endedAt = Date.now()) {
  const methods = {};
  for (const [method, row] of [...stats.methods.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    methods[method] = {
      requests: row.requests,
      errors: row.errors,
      avgLatencyMs: row.requests > 0 ? Math.round(row.totalLatencyMs / row.requests) : 0,
      maxLatencyMs: Math.round(row.maxLatencyMs)
    };
  }
  const snapshot = {
    windowStartedAt: new Date(stats.startedAt).toISOString(),
    windowEndedAt: new Date(endedAt).toISOString(),
    windowMs: Math.max(0, endedAt - stats.startedAt),
    totalRequests: stats.totalRequests,
    totalErrors: stats.totalErrors,
    methods
  };
  stats.startedAt = endedAt;
  stats.totalRequests = 0;
  stats.totalErrors = 0;
  stats.methods.clear();
  return snapshot;
}

function maybeFlushRpcStats({ rpcStats, rpcStatsMs, logFile, market }, now = Date.now()) {
  if (rpcStatsMs <= 0 || now - rpcStats.startedAt < rpcStatsMs) return false;
  try {
    appendJsonl(logFile, {
      level: "orderflow-trigger-rpc-stats",
      market,
      ...consumeRpcStats(rpcStats, now),
      at: new Date(now).toISOString()
    });
    return true;
  } catch {
    return false;
  }
}

function serializeTradeRows(rows) {
  return rows.map((row) => ({
    ...row,
    tokenId: String(row.tokenId),
    netCollateralSigned: String(row.netCollateralSigned),
    sizeSigned: String(row.sizeSigned)
  }));
}

function deserializeTradeRows(rows) {
  return rows.map((row) => ({
    ...row,
    tokenId: String(row.tokenId),
    netCollateralSigned: BigInt(row.netCollateralSigned),
    sizeSigned: BigInt(row.sizeSigned)
  }));
}

async function getMarketTradeLogs(publicClient, market, fromBlock, toBlock) {
  return publicClient.request({
    method: "eth_getLogs",
    params: [{
      address: market,
      topics: [MARKET_TRADE_TOPIC],
      fromBlock: blockTag(fromBlock),
      toBlock: blockTag(toBlock)
    }]
  });
}

function parseMarketTradeLog(log, market) {
  if (String(log.address).toLowerCase() !== String(market).toLowerCase()) return null;
  if (String(log.topics?.[0]).toLowerCase() !== MARKET_TRADE_TOPIC) return null;
  if ((log.topics?.length ?? 0) < 4) return null;
  const dataWords = dataWords64(log.data);
  if (dataWords.length < 2) return null;
  const netCollateral = int256FromWord(dataWords[0]);
  return {
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    operator: topicAddress(log.topics[1]),
    user: topicAddress(log.topics[2]),
    tokenId: BigInt(log.topics[3]).toString(),
    netCollateralSigned: netCollateral,
    sizeSigned: int256FromWord(dataWords[1])
  };
}

function marketTradeRowsFromReceipt(receipt, market) {
  return (receipt?.logs ?? [])
    .map((log) => parseMarketTradeLog(log, market))
    .filter(Boolean)
    .map((row) => ({
      ...row,
      txHash: row.txHash ?? receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber ?? row.blockNumber),
      transactionIndex: Number(receipt.transactionIndex ?? row.transactionIndex)
    }));
}

function transferCostsFromUserToRouter(logs, user) {
  if (!user) return [];
  const normalizedUser = user.toLowerCase();
  const normalizedRouter = ADDRESSES.routerProxy.toLowerCase();
  return logs
    .filter((log) => String(log.address).toLowerCase() === ADDRESSES.busdt.toLowerCase())
    .filter((log) => String(log.topics?.[0]).toLowerCase() === TRANSFER_TOPIC)
    .filter((log) => topicAddress(log.topics[1])?.toLowerCase() === normalizedUser)
    .filter((log) => topicAddress(log.topics[2])?.toLowerCase() === normalizedRouter)
    .map((log) => BigInt(log.data));
}

async function initialLastProcessedBlock(publicClient, lookbackBlocks) {
  const current = await publicClient.getBlockNumber();
  const lookback = BigInt(Math.max(0, lookbackBlocks));
  return current > lookback ? current - lookback : 0n;
}

function runSelfTest() {
  const buyWord = "0".repeat(63) + "a";
  const negativeOne = "f".repeat(64);
  assert(int256FromWord(buyWord) === 10n, "positive int256 decode failed");
  assert(int256FromWord(negativeOne) === -1n, "negative int256 decode failed");
  assert(csvSet("1, 2,,3").size === 3, "csvSet parse failed");
  const testTx = "0xtest";
  const testRows = [{
    txHash: testTx,
    blockNumber: 1,
    transactionIndex: 2,
    logIndex: 3,
    operator: "0x0000000000000000000000000000000000000001",
    user: "0x0000000000000000000000000000000000000002",
    tokenId: "32768",
    netCollateralSigned: 10n,
    sizeSigned: 20n
  }];
  const testCtx = { state: { seenTxs: {}, failedTxs: {}, processingTxs: {} } };
  recordFailedTx(testCtx, testTx, testRows, new Error("temporary failure"));
  assert(!isHandledTx(testCtx.state, testTx), "failed tx must not be marked handled");
  assert(testCtx.state.failedTxs[testTx].rows[0].netCollateralSigned === "10", "failed tx rows must be JSON serializable");
  assert(deserializeTradeRows(testCtx.state.failedTxs[testTx].rows)[0].netCollateralSigned === 10n, "failed tx rows must restore bigint fields");
  markTxHandled(testCtx, testTx, { status: "retry_success" });
  assert(isHandledTx(testCtx.state, testTx), "handled tx must be marked handled only after success");
  assert(!testCtx.state.failedTxs[testTx], "handled tx must be removed from failed retry queue");
  const watched = new Set(["2"]);
  const added = mergeCurrentPositionTokenIds(watched, [
    { tokenId: "2", size: 10 },
    { tokenId: "134217728", size: 5 },
    { tokenId: "8388608", size: 0 }
  ]);
  assert(added.length === 1 && added[0] === "134217728", "current position token ids should merge into watched set");
  assert(watched.has("134217728"), "manual current position token id should become watched");
  assert(isNoSellableBalanceError(new Error("Sell amount is zero")), "zero on-chain balance should be non-fatal");
  const triggerSummary = summarizeOrderflowTrigger({
    txHash: testTx,
    user: testRows[0].user,
    triggerCostUsdt: 250,
    matchedTokenIds: [32768n],
    sellTokenIds: [32768n],
    receipt: {
      blockNumber: 123n,
      transactionIndex: 4n,
      cumulativeGasUsed: 567n,
      status: "success"
    }
  });
  assert(JSON.parse(JSON.stringify(triggerSummary)).blockNumber === "123", "trigger summary must be JSON serializable");
  const feedRow = tradeRowFromObserverFeed({
    txHash: testTx,
    blockNumber: "123",
    transactionIndex: 4,
    logIndex: 5,
    operator: testRows[0].operator,
    user: testRows[0].user,
    tokenId: "32768",
    netCollateral: "10",
    size: "20"
  });
  assert(feedRow?.netCollateralSigned === 10n && feedRow?.sizeSigned === 20n, "observer feed trade must restore signed bigint fields");
  const cutoverState = { discoverySource: "rpc", lastProcessedBlock: "123" };
  assert(
    armFeedCutover(cutoverState, { previousDiscoverySource: "rpc", lastProcessedBlock: 123n }),
    "RPC-to-feed cutover must arm a replay boundary"
  );
  assert(cutoverState.feedCutoverAfterBlock === "122", "feed cutover must overlap the last RPC block by one block");
  assert(
    !observerFeedRowAfterBlock({ blockNumber: "122" }, optionalBlockNumber(cutoverState.feedCutoverAfterBlock)) &&
      observerFeedRowAfterBlock({ blockNumber: "123" }, optionalBlockNumber(cutoverState.feedCutoverAfterBlock)) &&
      observerFeedRowAfterBlock({ blockNumber: "124" }, optionalBlockNumber(cutoverState.feedCutoverAfterBlock)),
    "feed cutover must skip older backlog while retaining the overlap block and restart gap"
  );
  assert(
    !armFeedCutover(cutoverState, { previousDiscoverySource: "feed", lastProcessedBlock: 123n }),
    "an armed feed cutover must remain stable across restart"
  );
  assert(
    !armFeedCutover({ discoverySource: "feed", lastProcessedBlock: "123" }, {
      previousDiscoverySource: "feed",
      lastProcessedBlock: 123n
    }),
    "an established feed reader must not replay from the beginning"
  );
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const topicForAddress = (address) => `0x${"0".repeat(24)}${address.toLowerCase().slice(2)}`;
  const testMarket = "0x94FA631F5A8d830919db6d5B1571e438f0222Fb0";
  const receiptRows = marketTradeRowsFromReceipt({
    transactionHash: testTx,
    blockNumber: 123n,
    transactionIndex: 4,
    logs: [{
      address: testMarket,
      transactionHash: testTx,
      topics: [
        MARKET_TRADE_TOPIC,
        topicForAddress(testRows[0].operator),
        topicForAddress(testRows[0].user),
        `0x${word(32768n)}`
      ],
      data: `0x${word(10n)}${word(20n)}`,
      logIndex: 5
    }]
  }, testMarket);
  assert(receiptRows.length === 1 && receiptRows[0].tokenId === "32768", "feed receipt expansion must recover every market trade row");
  assert(receiptRows[0].blockNumber === 123 && receiptRows[0].transactionIndex === 4, "feed receipt expansion must retain receipt ordering");
  const rpcStats = createRpcStats(1000);
  recordRpcStat(rpcStats, "eth_blockNumber", 10, true);
  recordRpcStat(rpcStats, "eth_getLogs", 30, false);
  const rpcSnapshot = consumeRpcStats(rpcStats, 2000);
  assert(rpcSnapshot.totalRequests === 2, "RPC stats must count requests");
  assert(rpcSnapshot.totalErrors === 1, "RPC stats must count errors");
  assert(rpcSnapshot.methods.eth_getLogs.maxLatencyMs === 30, "RPC stats must retain method latency");
  assert(rpcStats.totalRequests === 0 && rpcStats.methods.size === 0, "consumed RPC stats must reset the window");
  console.log(JSON.stringify({ level: "orderflow-trigger-sell-self-test", status: "ok" }));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function parseEnvFile(file) {
  const env = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function loadState(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const backup = `${file}.bak`;
    if (fs.existsSync(backup)) return JSON.parse(fs.readFileSync(backup, "utf8"));
    throw error;
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
    fs.chmodSync(`${file}.bak`, 0o600);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function pruneTxState(state) {
  pruneObjectByRecentEntries(state, "seenTxs", 5000, 4000);
  pruneObjectByRecentEntries(state, "failedTxs", 1000, 500);
  pruneObjectByRecentEntries(state, "processingTxs", 1000, 100);
}

function pruneObjectByRecentEntries(state, key, limit, keep) {
  const entries = Object.entries(state[key] ?? {});
  if (entries.length <= limit) return;
  state[key] = Object.fromEntries(entries.slice(-keep));
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function groupByTxHash(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.txHash).toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

function dataWords64(data) {
  const raw = String(data ?? "").replace(/^0x/u, "");
  const words = [];
  for (let i = 0; i + 64 <= raw.length; i += 64) words.push(raw.slice(i, i + 64));
  return words;
}

function int256FromWord(word) {
  const value = BigInt(`0x${word}`);
  const signBit = 1n << 255n;
  return value >= signBit ? value - (1n << 256n) : value;
}

function topicAddress(topic) {
  try {
    return getAddress(`0x${String(topic).slice(-40)}`);
  } catch {
    return null;
  }
}

function normalizeAddress(value) {
  if (!value) return "";
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function csvSet(value) {
  return new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

function sumBigInt(values) {
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
}

function numberFromUnits(value, decimals) {
  return Number(formatUnits(BigInt(value), decimals));
}

function majority(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 1e6) / 1e6 : null;
}

function requiredArg(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: "orderflow-trigger-sell-fatal",
    message: error?.message ?? String(error)
  }));
  process.exit(1);
});
