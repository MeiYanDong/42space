#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  webSocket
} from "viem";
import { bsc } from "viem/chains";

import { appendJsonl } from "../src/config.js";

const DEFAULT_AUDIT_MS = 60000;
const DEFAULT_TRANSFER_SCAN_MS = 3000;
const DEFAULT_HEALTH_MS = 5000;
const DEFAULT_RPC_STATS_MS = 60000;
const DEFAULT_AUDIT_CONFIRMATIONS = 3;
const DEFAULT_DIRECT_CONFIRMATIONS = 2;
const DEFAULT_MAX_RANGE_BLOCKS = 1000;
const DEFAULT_STATE_FILE = "data/shared-rpc-observer/state.json";
const DEFAULT_LOG_FILE = "data/shared-rpc-observer/observer.jsonl";
const DEFAULT_FEED_FILE = "data/shared-rpc-observer/feed.jsonl";
const DEFAULT_HEALTH_FILE = "data/shared-rpc-observer/health.json";

const MARKET_TRADE_TOPIC = "0xf2e90b10bd525a6b1fe02d09e8133d3e38c9a87376ed4850904ca21e6e27abec";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC1155_TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f832d46ec942c18f8c8cf";
const ERC1155_TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70b45c59d4ed6409018f8cbd4a6932f3c99907335bc54";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const appDir = path.resolve(args.appDir ?? process.cwd());
  const httpRpcUrl = requiredValue(
    args.httpRpcUrl ?? process.env.SHARED_OBSERVER_HTTP_RPC_URL,
    "SHARED_OBSERVER_HTTP_RPC_URL or --http-rpc-url"
  );
  const wsRpcUrl = requiredValue(
    args.wsRpcUrl ?? process.env.SHARED_OBSERVER_WS_RPC_URL,
    "SHARED_OBSERVER_WS_RPC_URL or --ws-rpc-url"
  );
  const markets = addressList(
    requiredValue(args.markets ?? process.env.SHARED_OBSERVER_MARKETS, "SHARED_OBSERVER_MARKETS or --markets")
  );
  const watchedAddresses = addressList(
    requiredValue(args.addresses ?? process.env.SHARED_OBSERVER_ADDRESSES, "SHARED_OBSERVER_ADDRESSES or --addresses")
  );
  const addressEnabled = boolFlag(
    args.addressEnabled ?? process.env.SHARED_OBSERVER_ADDRESS_ENABLED,
    true
  );
  const auditMs = positiveInteger(args.auditMs ?? process.env.SHARED_OBSERVER_AUDIT_MS, DEFAULT_AUDIT_MS);
  const transferScanMs = positiveInteger(
    args.transferScanMs ?? process.env.SHARED_OBSERVER_TRANSFER_SCAN_MS,
    DEFAULT_TRANSFER_SCAN_MS
  );
  const healthMs = positiveInteger(args.healthMs ?? process.env.SHARED_OBSERVER_HEALTH_MS, DEFAULT_HEALTH_MS);
  const rpcStatsMs = positiveInteger(
    args.rpcStatsMs ?? process.env.SHARED_OBSERVER_RPC_STATS_MS,
    DEFAULT_RPC_STATS_MS
  );
  const auditConfirmations = nonNegativeInteger(
    args.auditConfirmations ?? process.env.SHARED_OBSERVER_AUDIT_CONFIRMATIONS,
    DEFAULT_AUDIT_CONFIRMATIONS
  );
  const directConfirmations = nonNegativeInteger(
    args.directConfirmations ?? process.env.SHARED_OBSERVER_DIRECT_CONFIRMATIONS,
    DEFAULT_DIRECT_CONFIRMATIONS
  );
  const maxRangeBlocks = positiveInteger(
    args.maxRangeBlocks ?? process.env.SHARED_OBSERVER_MAX_RANGE_BLOCKS,
    DEFAULT_MAX_RANGE_BLOCKS
  );
  const stateFile = path.resolve(
    args.stateFile ?? process.env.SHARED_OBSERVER_STATE_FILE ?? path.join(appDir, DEFAULT_STATE_FILE)
  );
  const logFile = path.resolve(
    args.logFile ?? process.env.SHARED_OBSERVER_LOG_FILE ?? path.join(appDir, DEFAULT_LOG_FILE)
  );
  const feedFile = path.resolve(
    args.feedFile ?? process.env.SHARED_OBSERVER_FEED_FILE ?? path.join(appDir, DEFAULT_FEED_FILE)
  );
  const healthFile = path.resolve(
    args.healthFile ?? process.env.SHARED_OBSERVER_HEALTH_FILE ?? path.join(appDir, DEFAULT_HEALTH_FILE)
  );

  const rpcStats = createRpcStats();
  const httpClient = createPublicClient({
    chain: bsc,
    transport: instrumentTransport(http(httpRpcUrl, { timeout: 30000 }), rpcStats)
  });
  const wsClient = createPublicClient({
    chain: bsc,
    transport: webSocket(wsRpcUrl, {
      keepAlive: { interval: 20000 },
      reconnect: { attempts: 1000000, delay: 2000 },
      timeout: 15000
    })
  });
  const state = loadState(stateFile);
  state.version = 1;
  state.mode = "shadow";
  state.seen ??= {};
  state.startedAt ??= new Date().toISOString();

  const head = await httpClient.getBlockNumber();
  state.lastDirectBlock ??= head.toString();
  state.lastMarketAuditBlock ??= state.lastAuditBlock ?? head.toString();
  state.lastTransferScanBlock ??= state.lastAuditBlock ?? head.toString();

  const ctx = {
    httpClient,
    wsClient,
    state,
    stateFile,
    logFile,
    feedFile,
    healthFile,
    markets,
    marketSet: new Set(markets.map(normalizeAddress)),
    watchedAddresses,
    watchedAddressSet: new Set(watchedAddresses.map(normalizeAddress)),
    addressEnabled,
    auditMs,
    transferScanMs,
    healthMs,
    rpcStatsMs,
    auditConfirmations,
    directConfirmations,
    maxRangeBlocks,
    rpcStats,
    counters: {
      wsHeads: 0,
      wsMarketLogs: 0,
      wsTransferLogs: 0,
      wsErrors: 0,
      feedEvents: 0,
      duplicateEvents: 0
    },
    startedAt: new Date().toISOString(),
    lastWsAt: null,
    lastWsHead: null,
    lastMarketAudit: null,
    lastTransferScan: null,
    latestRpcStats: null,
    lastFeedCheckpointAt: 0,
    directTarget: BigInt(state.lastDirectBlock),
    directRunning: false,
    directPromise: Promise.resolve(),
    scanPromises: { market: null, transfer: null },
    stateDirty: true,
    shuttingDown: false,
    unwatchers: [],
    subscriptionsReady: 0
  };

  checkpoint(ctx, true);
  appendJsonl(logFile, {
    level: "shared-rpc-observer-started",
    mode: "shadow",
    pid: process.pid,
    markets,
    watchedAddresses,
    addressEnabled,
    auditMs,
    transferScanMs,
    auditConfirmations,
    directConfirmations,
    maxRangeBlocks,
    lastDirectBlock: state.lastDirectBlock,
    lastMarketAuditBlock: state.lastMarketAuditBlock,
    lastTransferScanBlock: state.lastTransferScanBlock,
    at: ctx.startedAt
  });

  await startSubscriptions(ctx);
  await Promise.all([
    scheduleLogScan(ctx, "market", "startup"),
    addressEnabled ? scheduleLogScan(ctx, "transfer", "startup") : Promise.resolve()
  ]);

  const marketAuditTimer = setInterval(() => {
    scheduleLogScan(ctx, "market", "interval").catch((error) => recordError(ctx, "market-audit", error));
  }, auditMs);
  const transferScanTimer = addressEnabled
    ? setInterval(() => {
        scheduleLogScan(ctx, "transfer", "interval").catch((error) => recordError(ctx, "transfer-scan", error));
      }, transferScanMs)
    : null;
  const healthTimer = setInterval(() => writeHealth(ctx), healthMs);
  const checkpointTimer = setInterval(() => checkpoint(ctx), healthMs);
  const rpcStatsTimer = setInterval(() => flushRpcStats(ctx), rpcStatsMs);

  const shutdown = async (signal) => {
    if (ctx.shuttingDown) return;
    ctx.shuttingDown = true;
    clearInterval(marketAuditTimer);
    if (transferScanTimer) clearInterval(transferScanTimer);
    clearInterval(healthTimer);
    clearInterval(checkpointTimer);
    clearInterval(rpcStatsTimer);
    for (const unwatch of ctx.unwatchers.splice(0)) {
      try {
        await unwatch();
      } catch {
        // Shutdown should continue even if the provider already closed a subscription.
      }
    }
    await Promise.allSettled([
      ctx.directPromise,
      ctx.scanPromises.market,
      ctx.scanPromises.transfer
    ].filter(Boolean));
    flushRpcStats(ctx);
    checkpoint(ctx, true);
    writeHealth(ctx, { status: "stopped", signal });
    appendJsonl(logFile, {
      level: "shared-rpc-observer-stopped",
      signal,
      at: new Date().toISOString()
    });
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  writeHealth(ctx);
  await new Promise(() => {});
}

async function startSubscriptions(ctx) {
  await Promise.all([
    subscribeWss(ctx, "newHeads", ["newHeads"], (head) => {
      const blockNumber = BigInt(head.number);
      ctx.counters.wsHeads += 1;
      ctx.lastWsAt = new Date().toISOString();
      ctx.lastWsHead = blockNumber.toString();
      if (ctx.addressEnabled) {
        queueDirectTarget(ctx, confirmedBlock(blockNumber, ctx.directConfirmations))
          .catch((error) => recordError(ctx, "direct-block", error));
      }
    }),
    subscribeWss(ctx, "marketTrade", ["logs", {
      address: ctx.markets,
      topics: [MARKET_TRADE_TOPIC]
    }], (log) => {
      ctx.counters.wsMarketLogs += 1;
      ctx.lastWsAt = new Date().toISOString();
      recordMarketLog(ctx, log, "wss");
    })
  ]);
}

async function subscribeWss(ctx, stream, params, onResult) {
  try {
    const subscription = await ctx.wsClient.transport.subscribe({
      params,
      onData: (data) => onResult(data.result),
      onError: (error) => recordWssError(ctx, stream, error)
    });
    ctx.unwatchers.push(subscription.unsubscribe);
    ctx.subscriptionsReady += 1;
  } catch (error) {
    throw new Error(`${stream} subscription failed: ${cleanErrorMessage(error)}`);
  }
}

function queueDirectTarget(ctx, target) {
  const blockNumber = BigInt(target);
  if (blockNumber > ctx.directTarget) ctx.directTarget = blockNumber;
  if (ctx.directRunning) return ctx.directPromise;
  ctx.directPromise = drainDirectBlocks(ctx);
  return ctx.directPromise;
}

async function drainDirectBlocks(ctx) {
  ctx.directRunning = true;
  try {
    while (!ctx.shuttingDown && BigInt(ctx.state.lastDirectBlock) < ctx.directTarget) {
      const blockNumber = BigInt(ctx.state.lastDirectBlock) + 1n;
      const block = await getBlockWithRetry(ctx.httpClient, blockNumber);
      for (const tx of block.transactions ?? []) {
        if (!tx || typeof tx === "string") continue;
        recordDirectTransaction(ctx, tx, blockNumber);
      }
      ctx.state.lastDirectBlock = blockNumber.toString();
      ctx.stateDirty = true;
    }
  } finally {
    ctx.directRunning = false;
  }
}

function recordDirectTransaction(ctx, tx, blockNumber) {
  const from = normalizeAddress(tx.from);
  const to = normalizeAddress(tx.to);
  const matched = new Set();
  if (ctx.watchedAddressSet.has(from)) matched.add(from);
  if (ctx.watchedAddressSet.has(to)) matched.add(to);
  for (const address of matched) {
    const directions = [];
    if (from === address) directions.push("out");
    if (to === address) directions.push("in");
    recordObservation(ctx, {
      key: `direct:${address}:${String(tx.hash).toLowerCase()}`,
      source: "http_block",
      blockNumber,
      row: {
        level: "shared-rpc-observer-address-direct",
        address: getAddress(address),
        txHash: tx.hash,
        blockNumber: blockNumber.toString(),
        transactionIndex: numberOrNull(tx.transactionIndex),
        from: tx.from ?? null,
        to: tx.to ?? null,
        valueWei: String(tx.value ?? 0n),
        directions
      }
    });
  }
}

async function getBlockWithRetry(publicClient, blockNumber, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await publicClient.getBlock({ blockNumber, includeTransactions: true });
    } catch (error) {
      lastError = error;
      if (!isBlockNotFoundError(error) || attempt === attempts) throw error;
      await sleep(attempt * 100);
    }
  }
  throw lastError;
}

function isBlockNotFoundError(error) {
  return /block.*(?:not found|could not be found)/iu.test(String(error?.message ?? error));
}

async function scheduleLogScan(ctx, kind, reason) {
  const active = ctx.scanPromises[kind];
  if (active) return active;
  const promise = runLogScan(ctx, kind, reason)
    .catch((error) => {
      recordError(ctx, `${kind}-${reason}`, error);
      throw error;
    })
    .finally(() => {
      ctx.scanPromises[kind] = null;
    });
  ctx.scanPromises[kind] = promise;
  return promise;
}

async function runLogScan(ctx, kind, reason) {
  const startedAt = Date.now();
  const isMarket = kind === "market";
  const cursorKey = isMarket ? "lastMarketAuditBlock" : "lastTransferScanBlock";
  const confirmations = BigInt(isMarket ? ctx.auditConfirmations : ctx.directConfirmations);
  const head = await ctx.httpClient.getBlockNumber();
  const scanTo = head > confirmations ? head - confirmations : 0n;
  let cursor = BigInt(ctx.state[cursorKey]) + 1n;
  const summary = {
    kind,
    reason,
    fromBlock: cursor <= scanTo ? cursor.toString() : null,
    toBlock: cursor <= scanTo ? scanTo.toString() : null,
    chunks: 0,
    logs: 0,
    observations: 0,
    matchedWss: 0,
    missingFromWss: 0,
    head: head.toString(),
    startedAt: new Date(startedAt).toISOString()
  };

  while (cursor <= scanTo) {
    const chunkTo = minBigInt(scanTo, cursor + BigInt(ctx.maxRangeBlocks) - 1n);
    if (isMarket) {
      const logs = await getRawLogs(ctx.httpClient, {
        address: ctx.markets,
        topics: [MARKET_TRADE_TOPIC],
        fromBlock: cursor,
        toBlock: chunkTo
      });
      for (const log of logs) {
        const result = recordMarketLog(ctx, log, "http_market_audit");
        summary.logs += 1;
        summary.observations += result.isNew ? 1 : 0;
        summary.matchedWss += result.hadWss ? 1 : 0;
        summary.missingFromWss += result.isNew ? 1 : 0;
      }
    } else {
      const specs = transferQuerySpecs(ctx.watchedAddresses);
      const groups = await Promise.all(specs.map((spec) => getRawLogs(ctx.httpClient, {
        topics: spec.topics,
        fromBlock: cursor,
        toBlock: chunkTo
      })));
      for (let index = 0; index < groups.length; index += 1) {
        for (const log of groups[index]) {
          const results = recordTransferLog(ctx, log, "http_transfer_scan", specs[index].kind);
          summary.logs += 1;
          summary.observations += results.filter((result) => result.isNew).length;
        }
      }
    }
    ctx.state[cursorKey] = chunkTo.toString();
    ctx.stateDirty = true;
    summary.chunks += 1;
    cursor = chunkTo + 1n;
    checkpoint(ctx);
  }

  summary.cursor = ctx.state[cursorKey];
  summary.durationMs = Date.now() - startedAt;
  summary.completedAt = new Date().toISOString();
  const level = isMarket ? "shared-rpc-observer-market-audit" : "shared-rpc-observer-transfer-scan";
  if (isMarket) ctx.lastMarketAudit = summary;
  else ctx.lastTransferScan = summary;
  appendJsonl(ctx.logFile, { level, ...summary, at: summary.completedAt });
  checkpoint(ctx, true);
  writeHealth(ctx);
  return summary;
}

function recordMarketLog(ctx, log, source) {
  const decoded = decodeMarketTradeLog(log);
  const txHash = String(log.transactionHash ?? "").toLowerCase();
  const logIndex = rpcNumberOrNull(log.logIndex);
  const market = decoded.market;
  return recordObservation(ctx, {
    key: `market:${market.toLowerCase()}:${txHash}:${logIndex}`,
    source,
    blockNumber: log.blockNumber,
    row: {
      level: "shared-rpc-observer-market-trade",
      market,
      txHash: log.transactionHash,
      blockNumber: rpcDecimalStringOrNull(log.blockNumber),
      transactionIndex: rpcNumberOrNull(log.transactionIndex),
      logIndex,
      operator: decoded.operator,
      user: decoded.user,
      tokenId: decoded.tokenId,
      netCollateral: decoded.netCollateral,
      size: decoded.size
    }
  });
}

function decodeMarketTradeLog(log) {
  const words = dataWords64(log.data);
  return {
    market: getAddress(log.address),
    operator: topicAddress(log.topics?.[1]),
    user: topicAddress(log.topics?.[2]),
    tokenId: rpcDecimalStringOrNull(log.topics?.[3]),
    netCollateral: words[0] ? int256FromWord(words[0]).toString() : null,
    size: words[1] ? int256FromWord(words[1]).toString() : null
  };
}

function recordTransferLog(ctx, log, source, kind) {
  const from = normalizeAddress(topicAddress(log.topics?.[kind === "erc20_out" || kind === "erc20_in" ? 1 : 2]));
  const to = normalizeAddress(topicAddress(log.topics?.[kind === "erc20_out" || kind === "erc20_in" ? 2 : 3]));
  const matches = transferAddressDirections(ctx.watchedAddressSet, from, to);
  const txHash = String(log.transactionHash ?? "").toLowerCase();
  const logIndex = rpcNumberOrNull(log.logIndex);
  const results = [];
  for (const match of matches) {
    for (const direction of match.directions) {
      results.push(recordObservation(ctx, {
        key: `transfer:${match.address}:${txHash}:${logIndex}:${direction}`,
        source,
        blockNumber: log.blockNumber,
        row: {
          level: "shared-rpc-observer-address-transfer",
          address: getAddress(match.address),
          direction,
          transferKind: transferKindName(kind),
          txHash: log.transactionHash,
          blockNumber: rpcDecimalStringOrNull(log.blockNumber),
          transactionIndex: rpcNumberOrNull(log.transactionIndex),
          logIndex,
          contract: getAddress(log.address),
          from: from ? getAddress(from) : null,
          to: to ? getAddress(to) : null
        }
      }));
    }
  }
  return results;
}

function recordObservation(ctx, { key, source, blockNumber, row }) {
  const normalizedBlock = rpcDecimalStringOrNull(blockNumber);
  const previous = ctx.state.seen[key];
  const hadWss = Boolean(previous?.sources?.includes("wss"));
  if (previous) {
    previous.sources ??= [];
    if (!previous.sources.includes(source)) previous.sources.push(source);
    previous.lastSeenAt = new Date().toISOString();
    ctx.counters.duplicateEvents += 1;
    ctx.stateDirty = true;
    return { isNew: false, hadWss, entry: previous };
  }

  const observedAt = new Date().toISOString();
  const entry = {
    blockNumber: normalizedBlock,
    firstSeenAt: observedAt,
    firstSource: source,
    lastSeenAt: observedAt,
    sources: [source]
  };
  ctx.state.seen[key] = entry;
  ctx.counters.feedEvents += 1;
  ctx.stateDirty = true;
  appendJsonl(ctx.feedFile, {
    ...row,
    observationKey: key,
    source,
    observedAt
  });
  return { isNew: true, hadWss: false, entry };
}

function transferQuerySpecs(addresses) {
  const addressTopics = addresses.map(addressToTopic);
  return [
    { kind: "erc20_out", topics: [ERC20_TRANSFER_TOPIC, addressTopics] },
    { kind: "erc20_in", topics: [ERC20_TRANSFER_TOPIC, null, addressTopics] },
    { kind: "erc1155_single_out", topics: [ERC1155_TRANSFER_SINGLE_TOPIC, null, addressTopics] },
    { kind: "erc1155_single_in", topics: [ERC1155_TRANSFER_SINGLE_TOPIC, null, null, addressTopics] },
    { kind: "erc1155_batch_out", topics: [ERC1155_TRANSFER_BATCH_TOPIC, null, addressTopics] },
    { kind: "erc1155_batch_in", topics: [ERC1155_TRANSFER_BATCH_TOPIC, null, null, addressTopics] }
  ];
}

function transferKindName(kind) {
  if (kind.startsWith("erc20")) return "erc20_or_erc721";
  if (kind.includes("single")) return "erc1155_single";
  return "erc1155_batch";
}

function transferAddressDirections(watchedSet, from, to) {
  const matches = [];
  for (const address of watchedSet) {
    const directions = [];
    if (from === address) directions.push("out");
    if (to === address) directions.push("in");
    if (directions.length > 0) matches.push({ address, directions });
  }
  return matches;
}

function recordWssError(ctx, stream, error) {
  ctx.counters.wsErrors += 1;
  recordError(ctx, `wss-${stream}`, error);
}

function recordError(ctx, source, error) {
  appendJsonl(ctx.logFile, {
    level: "shared-rpc-observer-error",
    source,
    message: cleanErrorMessage(error),
    at: new Date().toISOString()
  });
  writeHealth(ctx, { status: "degraded", lastError: cleanErrorMessage(error) });
}

function checkpoint(ctx, force = false) {
  if (!force && !ctx.stateDirty) return false;
  pruneSeen(ctx.state);
  saveJsonAtomic(ctx.stateFile, ctx.state);
  ctx.stateDirty = false;
  return true;
}

function writeHealth(ctx, overrides = {}) {
  const now = Date.now();
  if (!ctx.shuttingDown && overrides.status !== "stopped") maybeEmitFeedCheckpoint(ctx, now);
  const directCursor = BigInt(ctx.state.lastDirectBlock ?? 0);
  const marketAuditCursor = BigInt(ctx.state.lastMarketAuditBlock ?? 0);
  const transferScanCursor = BigInt(ctx.state.lastTransferScanBlock ?? 0);
  const wsHead = ctx.lastWsHead ? BigInt(ctx.lastWsHead) : null;
  saveJsonAtomic(ctx.healthFile, {
    version: 1,
    mode: "shadow",
    status: "running",
    pid: process.pid,
    startedAt: ctx.startedAt,
    updatedAt: new Date(now).toISOString(),
    markets: ctx.markets,
    watchedAddresses: ctx.watchedAddresses,
    cursors: {
      lastWsHead: ctx.lastWsHead,
      lastDirectBlock: ctx.addressEnabled ? ctx.state.lastDirectBlock : null,
      lastMarketAuditBlock: ctx.state.lastMarketAuditBlock,
      lastTransferScanBlock: ctx.addressEnabled ? ctx.state.lastTransferScanBlock : null,
      directLagBlocks: ctx.addressEnabled && wsHead !== null ? Number(wsHead - directCursor) : null,
      marketAuditLagBlocks: wsHead !== null ? Number(wsHead - marketAuditCursor) : null,
      transferScanLagBlocks: ctx.addressEnabled && wsHead !== null ? Number(wsHead - transferScanCursor) : null
    },
    features: {
      marketEnabled: true,
      addressEnabled: ctx.addressEnabled
    },
    websocket: {
      subscriptionsReady: ctx.subscriptionsReady,
      subscriptionsExpected: 2,
      lastEventAt: ctx.lastWsAt,
      heads: ctx.counters.wsHeads,
      marketLogs: ctx.counters.wsMarketLogs,
      transferLogs: ctx.counters.wsTransferLogs,
      errors: ctx.counters.wsErrors
    },
    observations: {
      feedEvents: ctx.counters.feedEvents,
      duplicates: ctx.counters.duplicateEvents,
      retainedSeenKeys: Object.keys(ctx.state.seen ?? {}).length
    },
    latestMarketAudit: ctx.lastMarketAudit,
    latestTransferScan: ctx.lastTransferScan,
    latestRpcStats: ctx.latestRpcStats,
    ...overrides
  });
}

function maybeEmitFeedCheckpoint(ctx, now = Date.now()) {
  if (now - ctx.lastFeedCheckpointAt < ctx.healthMs) return false;
  ctx.lastFeedCheckpointAt = now;
  appendJsonl(ctx.feedFile, {
    level: "shared-rpc-observer-checkpoint",
    blockNumber: ctx.lastWsHead,
    directBlockNumber: ctx.addressEnabled ? ctx.state.lastDirectBlock : null,
    marketAuditBlockNumber: ctx.state.lastMarketAuditBlock,
    transferScanBlockNumber: ctx.addressEnabled ? ctx.state.lastTransferScanBlock : null,
    observedAt: new Date(now).toISOString()
  });
  return true;
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
            // Metrics are observational and must never change request behavior.
          }
        }
      }
    };
  };
}

function createRpcStats(startedAt = Date.now()) {
  return { startedAt, totalRequests: 0, totalErrors: 0, methods: new Map() };
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

function flushRpcStats(ctx) {
  const snapshot = consumeRpcStats(ctx.rpcStats);
  ctx.latestRpcStats = snapshot;
  appendJsonl(ctx.logFile, {
    level: "shared-rpc-observer-rpc-stats",
    ...snapshot,
    at: snapshot.windowEndedAt
  });
  writeHealth(ctx);
}

function pruneSeen(state) {
  const entries = Object.entries(state.seen ?? {});
  if (entries.length <= 20000) return;
  state.seen = Object.fromEntries(entries.slice(-15000));
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

function saveJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
    fs.chmodSync(`${file}.bak`, 0o600);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function addressList(value) {
  const addresses = String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((address) => getAddress(address.toLowerCase()));
  return [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
}

function normalizeAddress(value) {
  if (!value) return "";
  try {
    return getAddress(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function topicAddress(topic) {
  try {
    if (!topic) return null;
    return getAddress(`0x${String(topic).slice(-40)}`);
  } catch {
    return null;
  }
}

function addressToTopic(address) {
  return `0x${"0".repeat(24)}${normalizeAddress(address).slice(2)}`;
}

async function getRawLogs(publicClient, { address, topics, fromBlock, toBlock }) {
  const filter = {
    fromBlock: blockTag(fromBlock),
    toBlock: blockTag(toBlock),
    topics
  };
  if (address) filter.address = address;
  return publicClient.request({ method: "eth_getLogs", params: [filter] });
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function dataWords64(data) {
  const raw = String(data ?? "").replace(/^0x/u, "");
  const words = [];
  for (let index = 0; index + 64 <= raw.length; index += 64) words.push(raw.slice(index, index + 64));
  return words;
}

function int256FromWord(word) {
  const value = BigInt(`0x${word}`);
  const signBit = 1n << 255n;
  return value >= signBit ? value - (1n << 256n) : value;
}

function rpcDecimalStringOrNull(value) {
  return value === undefined || value === null ? null : BigInt(value).toString();
}

function rpcNumberOrNull(value) {
  return value === undefined || value === null ? null : Number(BigInt(value));
}

function numberOrNull(value) {
  return value === undefined || value === null ? null : Number(value);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function boolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function requiredValue(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function confirmedBlock(blockNumber, confirmations) {
  const block = BigInt(blockNumber);
  const offset = BigInt(Math.max(0, Number(confirmations) || 0));
  return block > offset ? block - offset : 0n;
}

function cleanErrorMessage(error) {
  return String(error?.message ?? error)
    .replace(/(?:https?|wss?):\/\/[^\s"']+/gu, "[RPC]")
    .slice(0, 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfTest() {
  const addresses = addressList([
    "0x96FDe227f3863812464dC1320B505016837a3650",
    "0x1Bc7dF2AA0DBE1a489A7205f2D1fF92C3d51A80b",
    "0x96FDe227f3863812464dC1320B505016837a3650"
  ].join(","));
  assert(addresses.length === 2, "address list must de-duplicate targets");
  const watched = new Set(addresses.map(normalizeAddress));
  const first = normalizeAddress(addresses[0]);
  const second = normalizeAddress(addresses[1]);
  const matches = transferAddressDirections(watched, first, second);
  assert(matches.length === 2, "cross-target transfer must match both addresses");
  assert(matches.find((item) => item.address === first)?.directions[0] === "out", "out direction must match");
  assert(matches.find((item) => item.address === second)?.directions[0] === "in", "in direction must match");
  const selfMatches = transferAddressDirections(watched, first, first);
  assert(selfMatches[0].directions.join(",") === "out,in", "self transfer must preserve both directions");
  const specs = transferQuerySpecs(addresses);
  assert(specs.length === 6, "observer must use six shared transfer filters");
  assert(Array.isArray(specs[0].topics[1]) && specs[0].topics[1].length === 2, "shared address topics must encode as an OR filter");
  assert(specs[0].topics[0] === ERC20_TRANSFER_TOPIC, "shared transfer filter must use the canonical topic");
  assert(boolFlag("0", true) === false && boolFlag(undefined, true) === true, "address feature flag must support an explicit pause without changing its default");
  assert(MARKET_TRADE_TOPIC === "0xf2e90b10bd525a6b1fe02d09e8133d3e38c9a87376ed4850904ca21e6e27abec", "market filter must match production topic");
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const decodedTrade = decodeMarketTradeLog({
    address: "0x94FA631F5A8d830919db6d5B1571e438f0222Fb0",
    topics: [
      MARKET_TRADE_TOPIC,
      `0x${word(1n)}`,
      addressToTopic(addresses[0]),
      `0x${word(32768n)}`
    ],
    data: `0x${word(50n)}${"f".repeat(64)}`
  });
  assert(decodedTrade.tokenId === "32768", "raw MarketTrade token id must decode as decimal");
  assert(decodedTrade.netCollateral === "50" && decodedTrade.size === "-1", "raw MarketTrade signed fields must decode");
  assert(confirmedBlock(100n, 2) === 98n, "direct block confirmation offset must be applied");
  assert(isBlockNotFoundError(new Error("Block at number 10 could not be found")), "block lag must be retryable");
  const stats = createRpcStats(1000);
  recordRpcStat(stats, "eth_getBlockByNumber", 15, true);
  recordRpcStat(stats, "eth_getLogs", 25, false);
  const snapshot = consumeRpcStats(stats, 2000);
  assert(snapshot.totalRequests === 2 && snapshot.totalErrors === 1, "RPC stats must count requests and errors");
  assert(cleanErrorMessage(new Error("failed https://secret.example/key")) === "failed [RPC]", "errors must redact RPC URLs");
  console.log(JSON.stringify({ level: "shared-rpc-observer-self-test", status: "ok" }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: "shared-rpc-observer-fatal",
    message: cleanErrorMessage(error),
    at: new Date().toISOString()
  }));
  process.exit(1);
});
