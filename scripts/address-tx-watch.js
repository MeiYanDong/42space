#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http
} from "viem";
import { bsc } from "viem/chains";

import { appendJsonl } from "../src/config.js";
import { fetchMarket } from "../src/fortytwo.js";
import { readJsonlTail } from "../src/jsonl-tail.js";

const DEFAULT_PROFILE_ENV = "/etc/42space/profiles/42space.env";
const DEFAULT_POLL_MS = 3000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_LOOKBACK_BLOCKS = 0;
const DEFAULT_MAX_RANGE_BLOCKS = 20;
const DEFAULT_FEED_POLL_MS = 200;
const DEFAULT_FEED_FILE = "data/shared-rpc-observer/feed.jsonl";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC1155_TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f832d46ec942c18f8c8cf";
const ERC1155_TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70b45c59d4ed6409018f8cbd4a6932f3c99907335bc54";
const MARKET_TRADE_TOPIC = "0xf2e90b10bd525a6b1fe02d09e8133d3e38c9a87376ed4850904ca21e6e27abec";
const BINANCE_DEX_ROUTER = "0xb300000b72deaeb607a12d5f54773d1c19c7028d";
const FORTYTWO_ROUTER = "0x888888886619275d33c00d3bc62df94d700dcd42";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const profileEnvFile = args.profileEnv ?? process.env.ADDRESS_TX_WATCH_PROFILE_ENV ?? DEFAULT_PROFILE_ENV;
  const profileEnv = fs.existsSync(profileEnvFile) ? parseEnvFile(profileEnvFile) : {};
  Object.assign(process.env, profileEnv);

  const watchedAddress = getAddress(requiredValue(args.address ?? process.env.ADDRESS_TX_WATCH_ADDRESS, "ADDRESS_TX_WATCH_ADDRESS or --address"));
  const label = String(args.label ?? process.env.ADDRESS_TX_WATCH_LABEL ?? shortAddress(watchedAddress)).trim();
  const rpcUrl = String(
    args.rpcUrl ??
    process.env.ADDRESS_TX_WATCH_RPC_URL ??
    process.env.ORDERFLOW_TRIGGER_RPC_URL ??
    process.env.BSC_RPC_URL ??
    process.env.CHAINSTACK_BSC_RPC_URL ??
    process.env.ANKR_BSC_RPC_URL ??
    "https://bsc-rpc.publicnode.com"
  ).trim();
  const feishuWebhook = String(args.feishuWebhook ?? process.env.ADDRESS_TX_WATCH_FEISHU_WEBHOOK ?? process.env.FEISHU_WEBHOOK ?? "").trim();
  const feishuEnabled = boolFlag(args.feishuEnabled ?? process.env.ADDRESS_TX_WATCH_FEISHU_ENABLED ?? process.env.FEISHU_ALERTS_ENABLED, true);
  if (feishuEnabled && !feishuWebhook && !args.inspectTx) {
    throw new Error("FEISHU_WEBHOOK or ADDRESS_TX_WATCH_FEISHU_WEBHOOK is required when Feishu alerts are enabled");
  }
  const restUrl = String(process.env.FORTYTWO_REST_URL ?? "https://rest.ft.42.space").trim();

  const runtimeConfigFile = process.env.RUNTIME_CONFIG_FILE || "data/runtime-config.json";
  const dataDir = path.dirname(runtimeConfigFile);
  const stateFile = path.resolve(
    args.stateFile ??
    process.env.ADDRESS_TX_WATCH_STATE_FILE ??
    path.join(dataDir, `address-tx-watch-${watchedAddress.toLowerCase().slice(2, 8)}-state.json`)
  );
  const logFile = path.resolve(
    args.logFile ??
    process.env.ADDRESS_TX_WATCH_LOG_FILE ??
    path.join(dataDir, `address-tx-watch-${watchedAddress.toLowerCase().slice(2, 8)}.jsonl`)
  );
  const pollMs = positiveInteger(args.pollMs ?? process.env.ADDRESS_TX_WATCH_POLL_MS, DEFAULT_POLL_MS);
  const cooldownMs = nonNegativeInteger(args.cooldownMs ?? process.env.ADDRESS_TX_WATCH_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
  const lookbackBlocks = nonNegativeInteger(args.lookbackBlocks ?? process.env.ADDRESS_TX_WATCH_LOOKBACK_BLOCKS, DEFAULT_LOOKBACK_BLOCKS);
  const maxRangeBlocks = positiveInteger(args.maxRangeBlocks ?? process.env.ADDRESS_TX_WATCH_MAX_RANGE_BLOCKS, DEFAULT_MAX_RANGE_BLOCKS);
  const watchTokenTransfers = boolFlag(args.tokenTransfers ?? process.env.ADDRESS_TX_WATCH_TOKEN_TRANSFERS, true);
  const discoverySource = String(
    args.source ?? process.env.ADDRESS_TX_WATCH_SOURCE ?? "rpc"
  ).trim().toLowerCase();
  if (!["rpc", "feed"].includes(discoverySource)) {
    throw new Error("ADDRESS_TX_WATCH_SOURCE must be rpc or feed");
  }
  const feedFile = path.resolve(
    args.feedFile ?? process.env.ADDRESS_TX_WATCH_FEED_FILE ?? path.join(process.cwd(), DEFAULT_FEED_FILE)
  );
  const feedPollMs = positiveInteger(
    args.feedPollMs ?? process.env.ADDRESS_TX_WATCH_FEED_POLL_MS,
    DEFAULT_FEED_POLL_MS
  );
  const feedFromStart = boolFlag(
    args.feedFromStart ?? process.env.ADDRESS_TX_WATCH_FEED_FROM_START,
    false
  );

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  if (args.inspectTx) {
    const inspectCtx = { publicClient, watchedAddress, restUrl, marketCache: new Map() };
    const hit = await inspectTransactionHit(inspectCtx, args.inspectTx);
    console.log(JSON.stringify({
      level: "address-tx-watch-inspect",
      address: watchedAddress,
      ...serializeHit(hit),
      facts: alertFacts(inspectCtx, hit)
    }, null, 2));
    return;
  }
  const state = loadState(stateFile);
  state.address = watchedAddress;
  state.label = label;
  state.seenTxs ??= {};
  state.alert ??= {};

  let lastProcessedBlock = state.lastProcessedBlock !== undefined
    ? BigInt(state.lastProcessedBlock)
    : 0n;
  if (discoverySource === "rpc" && state.lastProcessedBlock === undefined) {
    lastProcessedBlock = await initialLastProcessedBlock(publicClient, lookbackBlocks);
  }
  if (discoverySource === "feed") {
    const initialized = readJsonlTail(feedFile, state.feedCursor, { startAtEnd: !feedFromStart });
    if (initialized.missing) throw new Error(`Address observer feed is missing: ${feedFile}`);
    state.feedCursor = initialized.cursor;
  }
  state.discoverySource = discoverySource;
  state.lastProcessedBlock = lastProcessedBlock.toString();
  saveState(stateFile, state);

  const ctx = {
    publicClient,
    state,
    stateFile,
    logFile,
    watchedAddress,
    addressTopic: addressToTopic(watchedAddress),
    label,
    feishuWebhook,
    feishuEnabled,
    cooldownMs,
    maxRangeBlocks,
    watchTokenTransfers,
    restUrl,
    marketCache: new Map(),
    discoverySource,
    feedFile
  };

  appendJsonl(logFile, {
    level: "address-tx-watch-started",
    discoverySource,
    address: watchedAddress,
    label,
    profileEnvFile,
    feishuEnabled,
    cooldownMs,
    pollMs,
    feedPollMs: discoverySource === "feed" ? feedPollMs : null,
    feedFile: discoverySource === "feed" ? feedFile : null,
    feedOffset: discoverySource === "feed" ? state.feedCursor?.offset ?? null : null,
    watchTokenTransfers,
    lookbackBlocks,
    lastProcessedBlock: lastProcessedBlock.toString(),
    at: new Date().toISOString()
  });

  while (true) {
    try {
      if (discoverySource === "feed") {
        await processObserverFeed(ctx);
      } else {
        const latestBlock = await publicClient.getBlockNumber();
        if (latestBlock > lastProcessedBlock) {
          const result = await processBlockRange({
            ...ctx,
            fromBlock: lastProcessedBlock + 1n,
            toBlock: latestBlock
          });
          lastProcessedBlock = result.lastProcessedBlock;
          state.lastProcessedBlock = lastProcessedBlock.toString();
          pruneSeenTxs(state);
          saveState(stateFile, state);
        }
      }
    } catch (error) {
      appendJsonl(logFile, {
        level: "address-tx-watch-error",
        address: watchedAddress,
        message: errorMessage(error),
        at: new Date().toISOString()
      });
    }
    await sleep(discoverySource === "feed" ? feedPollMs : pollMs);
  }
}

async function processBlockRange(ctx) {
  let cursor = ctx.fromBlock;
  let lastProcessedBlock = ctx.fromBlock - 1n;
  while (cursor <= ctx.toBlock) {
    const chunkTo = minBigInt(ctx.toBlock, cursor + BigInt(ctx.maxRangeBlocks) - 1n);
    const hits = await collectAddressHits(ctx, cursor, chunkTo);
    await processAddressHits(ctx, hits);
    lastProcessedBlock = chunkTo;
    cursor = chunkTo + 1n;
  }
  return { lastProcessedBlock };
}

async function processObserverFeed(ctx) {
  const tail = readJsonlTail(ctx.feedFile, ctx.state.feedCursor, { startAtEnd: true });
  if (tail.missing) throw new Error(`Address observer feed is missing: ${ctx.feedFile}`);
  if (tail.bytesRead === 0 && !tail.rotated && !tail.truncated && tail.parseErrors === 0) {
    return { rowsRead: 0, matchedRows: 0, hits: 0, bytesRead: 0, feedOffset: tail.cursor?.offset ?? null };
  }
  const rows = tail.rows
    .filter((row) => [
      "shared-rpc-observer-address-direct",
      "shared-rpc-observer-address-transfer"
    ].includes(row.level))
    .filter((row) => normalizeAddress(row.address) === ctx.watchedAddress.toLowerCase());
  const hits = new Map();
  for (const row of rows) mergeObserverFeedHit(hits, row);
  const hydrated = [];
  for (const hit of [...hits.values()].sort(compareHits)) {
    if (ctx.state.seenTxs[String(hit.txHash).toLowerCase()]) continue;
    await hydrateObserverFeedHit(ctx, hit);
    hydrated.push(hit);
  }
  await processAddressHits(ctx, hydrated, { enriched: true });
  const observedBlock = maxObservedBlock(tail.rows);
  if (observedBlock !== null && observedBlock > BigInt(ctx.state.lastProcessedBlock ?? 0)) {
    ctx.state.lastProcessedBlock = observedBlock.toString();
  }
  ctx.state.feedCursor = tail.cursor;
  ctx.state.feedLastReadAt = new Date().toISOString();
  if (tail.rotated || tail.truncated || tail.parseErrors > 0) {
    appendJsonl(ctx.logFile, {
      level: "address-tx-watch-feed-recovered",
      address: ctx.watchedAddress,
      rotated: tail.rotated,
      truncated: tail.truncated,
      parseErrors: tail.parseErrors,
      at: new Date().toISOString()
    });
  }
  pruneSeenTxs(ctx.state);
  saveState(ctx.stateFile, ctx.state);
  return {
    rowsRead: tail.rows.length,
    matchedRows: rows.length,
    hits: hydrated.length,
    bytesRead: tail.bytesRead,
    feedOffset: tail.cursor?.offset ?? null
  };
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

async function processAddressHits(ctx, hits, { enriched = false } = {}) {
  for (const hit of hits) {
    const key = String(hit.txHash).toLowerCase();
    if (ctx.state.seenTxs[key]) continue;
    if (!enriched) await enrichHitWithFortyTwo(ctx, hit);
    appendJsonl(ctx.logFile, {
      level: "address-tx-watch-hit",
      address: ctx.watchedAddress,
      label: ctx.label,
      ...serializeHit(hit),
      at: new Date().toISOString()
    });
    await maybeSendFeishuAlert(ctx, hit);
    ctx.state.seenTxs[key] = {
      seenAt: new Date().toISOString(),
      blockNumber: hit.blockNumber?.toString() ?? null,
      directions: [...hit.directions].sort(),
      direct: hit.direct,
      tokenTransferCount: hit.tokenTransferCount
    };
    saveState(ctx.stateFile, ctx.state);
  }
}

function mergeObserverFeedHit(hits, row) {
  if (!row?.txHash) return null;
  const hit = ensureHit(hits, row.txHash);
  if (row.blockNumber !== undefined && row.blockNumber !== null) hit.blockNumber = BigInt(row.blockNumber);
  if (row.transactionIndex !== undefined && row.transactionIndex !== null) hit.transactionIndex = Number(row.transactionIndex);
  if (row.level === "shared-rpc-observer-address-direct") {
    hit.from = row.from ?? hit.from;
    hit.to = row.to ?? hit.to;
    hit.nativeValueWei = BigInt(row.valueWei ?? 0);
    hit.direct = true;
  } else if (row.level === "shared-rpc-observer-address-transfer") {
    if (row.direction) hit.directions.add(row.direction);
    if (row.contract) hit.contracts.add(getAddress(row.contract));
    if (row.from) hit.transferFrom.add(getAddress(row.from));
    if (row.to) hit.transferTo.add(getAddress(row.to));
    hit.tokenTransferCount += 1;
  }
  return hit;
}

async function hydrateObserverFeedHit(ctx, hit) {
  const [tx, receipt] = await Promise.all([
    ctx.publicClient.getTransaction({ hash: hit.txHash }),
    ctx.publicClient.getTransactionReceipt({ hash: hit.txHash })
  ]);
  hit.blockNumber = tx.blockNumber ?? receipt.blockNumber ?? hit.blockNumber;
  hit.transactionIndex = tx.transactionIndex ?? receipt.transactionIndex ?? hit.transactionIndex;
  hit.from = tx.from ?? hit.from;
  hit.to = tx.to ?? hit.to;
  hit.nativeValueWei = BigInt(tx.value ?? 0n);
  hit.direct = false;
  hit.directions = new Set();
  hit.tokenTransferCount = 0;
  hit.contracts = new Set();
  hit.transferFrom = new Set();
  hit.transferTo = new Set();
  const watched = ctx.watchedAddress.toLowerCase();
  if (normalizeAddress(tx.from) === watched) {
    hit.direct = true;
    hit.directions.add("out");
  }
  if (normalizeAddress(tx.to) === watched) {
    hit.direct = true;
    hit.directions.add("in");
  }
  mergeReceiptTransferDetails(hit, receipt.logs, watched);
  await enrichHitWithFortyTwo(ctx, hit, receipt);
  return hit;
}

function mergeReceiptTransferDetails(hit, logs, watchedAddress) {
  for (const log of logs ?? []) {
    const topic = String(log.topics?.[0] ?? "").toLowerCase();
    let fromIndex;
    let toIndex;
    if (topic === ERC20_TRANSFER_TOPIC) {
      fromIndex = 1;
      toIndex = 2;
    } else if (topic === ERC1155_TRANSFER_SINGLE_TOPIC || topic === ERC1155_TRANSFER_BATCH_TOPIC) {
      fromIndex = 2;
      toIndex = 3;
    } else {
      continue;
    }
    const from = topicAddress(log.topics?.[fromIndex]);
    const to = topicAddress(log.topics?.[toIndex]);
    const fromMatches = normalizeAddress(from) === watchedAddress;
    const toMatches = normalizeAddress(to) === watchedAddress;
    if (!fromMatches && !toMatches) continue;
    hit.tokenTransferCount += 1;
    hit.contracts.add(getAddress(log.address));
    if (from) hit.transferFrom.add(from);
    if (to) hit.transferTo.add(to);
    if (fromMatches) hit.directions.add("out");
    if (toMatches) hit.directions.add("in");
  }
}

async function collectAddressHits(ctx, fromBlock, toBlock) {
  const hits = new Map();
  await collectDirectTransactionHits(ctx, fromBlock, toBlock, hits);
  if (ctx.watchTokenTransfers) {
    await collectTransferLogHits(ctx, fromBlock, toBlock, hits);
  }
  return [...hits.values()].sort(compareHits);
}

async function collectDirectTransactionHits(ctx, fromBlock, toBlock, hits) {
  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) {
    const block = await ctx.publicClient.getBlock({ blockNumber, includeTransactions: true });
    for (const tx of block.transactions ?? []) {
      if (!tx || typeof tx === "string") continue;
      const from = normalizeAddress(tx.from);
      const to = normalizeAddress(tx.to);
      if (from !== ctx.watchedAddress.toLowerCase() && to !== ctx.watchedAddress.toLowerCase()) continue;
      const hit = ensureHit(hits, tx.hash);
      hit.blockNumber = blockNumber;
      hit.transactionIndex = tx.transactionIndex ?? hit.transactionIndex;
      hit.from = tx.from ?? hit.from;
      hit.to = tx.to ?? hit.to;
      hit.nativeValueWei = BigInt(tx.value ?? 0n);
      hit.direct = true;
      if (from === ctx.watchedAddress.toLowerCase()) hit.directions.add("out");
      if (to === ctx.watchedAddress.toLowerCase()) hit.directions.add("in");
    }
  }
}

async function collectTransferLogHits(ctx, fromBlock, toBlock, hits) {
  const specs = [
    { topic: ERC20_TRANSFER_TOPIC, fromIndex: 1, toIndex: 2, topicsForFrom: [ERC20_TRANSFER_TOPIC, ctx.addressTopic], topicsForTo: [ERC20_TRANSFER_TOPIC, null, ctx.addressTopic] },
    { topic: ERC1155_TRANSFER_SINGLE_TOPIC, fromIndex: 2, toIndex: 3, topicsForFrom: [ERC1155_TRANSFER_SINGLE_TOPIC, null, ctx.addressTopic], topicsForTo: [ERC1155_TRANSFER_SINGLE_TOPIC, null, null, ctx.addressTopic] },
    { topic: ERC1155_TRANSFER_BATCH_TOPIC, fromIndex: 2, toIndex: 3, topicsForFrom: [ERC1155_TRANSFER_BATCH_TOPIC, null, ctx.addressTopic], topicsForTo: [ERC1155_TRANSFER_BATCH_TOPIC, null, null, ctx.addressTopic] }
  ];
  for (const spec of specs) {
    for (const [direction, topics] of [["out", spec.topicsForFrom], ["in", spec.topicsForTo]]) {
      const logs = await getLogs(ctx.publicClient, { fromBlock, toBlock, topics });
      for (const log of logs) {
        if (String(log.topics?.[0] ?? "").toLowerCase() !== spec.topic) continue;
        const hit = ensureHit(hits, log.transactionHash);
        hit.blockNumber = parseRpcBigInt(log.blockNumber) ?? hit.blockNumber;
        hit.transactionIndex = parseRpcNumber(log.transactionIndex) ?? hit.transactionIndex;
        hit.directions.add(direction);
        hit.tokenTransferCount += 1;
        hit.contracts.add(getAddress(log.address));
        const from = topicAddress(log.topics?.[spec.fromIndex]);
        const to = topicAddress(log.topics?.[spec.toIndex]);
        if (from) hit.transferFrom.add(from);
        if (to) hit.transferTo.add(to);
      }
    }
  }
}

async function getLogs(publicClient, { fromBlock, toBlock, topics }) {
  return publicClient.request({
    method: "eth_getLogs",
    params: [{
      fromBlock: blockTag(fromBlock),
      toBlock: blockTag(toBlock),
      topics
    }]
  });
}

function ensureHit(hits, txHash) {
  const key = String(txHash).toLowerCase();
  const existing = hits.get(key);
  if (existing) return existing;
  const hit = {
    txHash,
    blockNumber: null,
    transactionIndex: null,
    from: null,
    to: null,
    nativeValueWei: 0n,
    direct: false,
    directions: new Set(),
    tokenTransferCount: 0,
    contracts: new Set(),
    transferFrom: new Set(),
    transferTo: new Set()
  };
  hits.set(key, hit);
  return hit;
}

async function inspectTransactionHit(ctx, txHash) {
  const tx = await ctx.publicClient.getTransaction({ hash: txHash });
  const hit = ensureHit(new Map(), txHash);
  hit.blockNumber = tx.blockNumber;
  hit.transactionIndex = tx.transactionIndex;
  hit.from = tx.from;
  hit.to = tx.to;
  hit.nativeValueWei = BigInt(tx.value ?? 0n);
  hit.direct = true;
  if (normalizeAddress(tx.from) === ctx.watchedAddress.toLowerCase()) hit.directions.add("out");
  if (normalizeAddress(tx.to) === ctx.watchedAddress.toLowerCase()) hit.directions.add("in");
  await enrichHitWithFortyTwo(ctx, hit);
  return hit;
}

async function enrichHitWithFortyTwo(ctx, hit, providedReceipt = null) {
  hit.fortyTwoEvents = [];
  hit.receiptStatus = null;
  hit.enrichmentError = null;
  try {
    const receipt = providedReceipt ?? await ctx.publicClient.getTransactionReceipt({ hash: hit.txHash });
    hit.receiptStatus = receipt.status ?? null;
    const events = [];
    for (const log of receipt.logs ?? []) {
      if (String(log.topics?.[0] ?? "").toLowerCase() !== MARKET_TRADE_TOPIC) continue;
      const event = parseMarketTradeLog(log, ctx.watchedAddress);
      if (event) events.push(await enrichMarketTradeEvent(ctx, event));
    }
    if (events.length === 0 && shouldLookupFortyTwoActivity(hit)) {
      events.push(...await fetchFortyTwoActivityForTransaction(ctx, hit.txHash));
    }
    hit.fortyTwoEvents = events;
  } catch (error) {
    hit.enrichmentError = cleanErrorMessage(error);
    if (ctx.logFile) {
      appendJsonl(ctx.logFile, {
        level: "address-tx-watch-enrichment-error",
        address: ctx.watchedAddress,
        txHash: hit.txHash,
        message: hit.enrichmentError,
        at: new Date().toISOString()
      });
    }
  }
  return hit;
}

function parseMarketTradeLog(log, watchedAddress) {
  if ((log.topics?.length ?? 0) < 4) return null;
  const user = topicAddress(log.topics[2]);
  if (!user || normalizeAddress(user) !== normalizeAddress(watchedAddress)) return null;
  const words = dataWords64(log.data);
  if (words.length < 2) return null;
  const collateral = int256FromWord(words[0]);
  const size = int256FromWord(words[1]);
  const action = collateral >= 0n ? "buy" : "sell";
  return {
    action,
    actionLabel: action === "buy" ? "买入" : "卖出",
    market: getAddress(log.address),
    tokenId: BigInt(log.topics[3]).toString(),
    amountUsdt: formatTokenAmount(absBigInt(collateral), 18, 2),
    size: formatTokenAmount(absBigInt(size), 18, 2),
    logIndex: parseRpcNumber(log.logIndex)
  };
}

async function enrichMarketTradeEvent(ctx, event) {
  const key = event.market.toLowerCase();
  let market = ctx.marketCache.get(key);
  if (market === undefined) {
    try {
      market = await fetchMarket({ restUrl: ctx.restUrl }, event.market);
      ctx.marketCache.set(key, market);
      pruneMap(ctx.marketCache, 240);
    } catch (error) {
      market = null;
      event.marketLookupError = cleanErrorMessage(error);
    }
  }
  const outcome = (market?.outcomes ?? []).find((item) => String(item.tokenId) === event.tokenId);
  return {
    ...event,
    question: market?.question ?? market?.title ?? "",
    outcome: outcome?.name ?? outcome?.title ?? `Token ${event.tokenId}`,
    marketStatus: market?.status ?? ""
  };
}

function shouldLookupFortyTwoActivity(hit) {
  const to = normalizeAddress(hit.to);
  return hit.direct && (to === BINANCE_DEX_ROUTER || to === FORTYTWO_ROUTER);
}

async function fetchFortyTwoActivityForTransaction(ctx, txHash) {
  const targetHash = String(txHash).toLowerCase();
  for (const delayMs of [0, 500, 1500]) {
    if (delayMs) await sleep(delayMs);
    try {
      const url = new URL("/api/v1/market-data/activity", ctx.restUrl);
      url.searchParams.set("user", ctx.watchedAddress);
      url.searchParams.set("limit", "100");
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) continue;
      const json = await response.json();
      const rows = (Array.isArray(json.data) ? json.data : [])
        .filter((row) => String(row.transactionHash ?? "").toLowerCase() === targetHash);
      if (rows.length === 0) continue;
      return rows.map(activityRowToFortyTwoEvent);
    } catch {
      // The receipt path remains authoritative when REST indexing is delayed.
    }
  }
  return [];
}

function activityRowToFortyTwoEvent(row) {
  const type = String(row.type ?? "").toUpperCase();
  const action = type === "REDEEM" ? "sell" : "buy";
  return {
    action,
    actionLabel: action === "buy" ? "买入" : "卖出",
    market: row.marketAddress ? getAddress(row.marketAddress) : "",
    tokenId: String(row.tokenId ?? ""),
    amountUsdt: formatDisplayNumber(row.collateral, 2),
    size: formatDisplayNumber(row.size, 2),
    logIndex: null,
    question: String(row.title ?? ""),
    outcome: String(row.outcome ?? row.outcomeSymbol ?? (row.tokenId ? `Token ${row.tokenId}` : "")),
    marketStatus: "",
    source: "42_rest"
  };
}

async function maybeSendFeishuAlert(ctx, hit) {
  const now = Date.now();
  const lastSentMs = Date.parse(ctx.state.alert?.lastSentAt ?? "");
  const kind = alertKind(hit);
  const withinCooldown = Number.isFinite(lastSentMs) && now - lastSentMs < ctx.cooldownMs;
  const priorityUpgrade = kind === "42_trade" && ctx.state.alert?.lastKind !== "42_trade";
  const suppressed = withinCooldown && !priorityUpgrade;
  if (suppressed) {
    appendJsonl(ctx.logFile, {
      level: "address-tx-watch-alert-suppressed",
      address: ctx.watchedAddress,
      label: ctx.label,
      txHash: hit.txHash,
      kind,
      lastSentAt: ctx.state.alert.lastSentAt,
      cooldownMs: ctx.cooldownMs,
      at: new Date(now).toISOString()
    });
    return { sent: false, suppressed: true };
  }
  if (!ctx.feishuEnabled) return { sent: false, disabled: true };

  const payload = buildFeishuCardPayload(ctx, hit);
  try {
    await postFeishuPayload(ctx.feishuWebhook, payload);
  } catch (cardError) {
    await postFeishuPayload(ctx.feishuWebhook, buildFeishuTextPayload(ctx, hit)).catch((textError) => {
      throw new Error(`card failed: ${errorMessage(cardError)}; text fallback failed: ${errorMessage(textError)}`);
    });
  }
  ctx.state.alert = {
    lastSentAt: new Date(now).toISOString(),
    lastTxHash: hit.txHash,
    lastKind: kind
  };
  appendJsonl(ctx.logFile, {
    level: "address-tx-watch-alert-sent",
    address: ctx.watchedAddress,
    label: ctx.label,
    txHash: hit.txHash,
    kind,
    priorityUpgrade,
    cooldownMs: ctx.cooldownMs,
    at: new Date(now).toISOString()
  });
  return { sent: true };
}

function buildFeishuCardPayload(ctx, hit) {
  const facts = alertFacts(ctx, hit);
  const trade = primaryFortyTwoEvent(hit);
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: trade?.action === "buy" ? "green" : (trade?.action === "sell" ? "orange" : "blue"),
        title: {
          tag: "plain_text",
          content: truncate(`${trade ? "42 交易提醒" : "地址交易提醒"}：${ctx.label}`, 80)
        }
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: facts.map((fact, index) => {
              const line = `${fact.label}：${fact.value}`;
              return index === 0 ? `**${line}**` : line;
            }).join("\n")
          }
        },
        {
          tag: "note",
          elements: [{ tag: "plain_text", content: `冷却：${formatDuration(ctx.cooldownMs)} · 时间：${formatTime(new Date())}` }]
        }
      ]
    }
  };
}

function buildFeishuTextPayload(ctx, hit) {
  const lines = [`地址交易提醒：${ctx.label}`, ...alertFacts(ctx, hit).map((fact) => `${fact.label}：${fact.value}`)];
  lines.push(`冷却：${formatDuration(ctx.cooldownMs)}`);
  lines.push(`时间：${formatTime(new Date())}`);
  return {
    msg_type: "text",
    content: { text: lines.join("\n").slice(0, 3000) }
  };
}

function alertFacts(ctx, hit) {
  const trade = primaryFortyTwoEvent(hit);
  if (trade) {
    const extraCount = Math.max(0, (hit.fortyTwoEvents?.length ?? 0) - 1);
    const nativePayment = hit.nativeValueWei > 0n
      ? `（链上输入 ${trimNumber(formatEther(hit.nativeValueWei))} BNB）`
      : "";
    return [
      { label: "操作", value: `${trade.actionLabel} ${truncate(trade.outcome, 52)}${extraCount ? `，同笔另有 ${extraCount} 项` : ""}` },
      { label: "事件", value: truncate(trade.question || shortAddress(trade.market), 110) },
      { label: trade.action === "buy" ? "实际投入" : "实际收回", value: `${trade.amountUsdt} U${nativePayment}` },
      { label: trade.action === "buy" ? "买到份额" : "卖出份额", value: `${trade.size} 份` },
      { label: "交易", value: shortHash(hit.txHash) }
    ];
  }
  return [
    { label: "地址", value: shortAddress(ctx.watchedAddress) },
    { label: "方向", value: formatDirections(hit.directions) },
    { label: "交易", value: shortHash(hit.txHash) },
    { label: "区块", value: hit.blockNumber?.toString() ?? "未知" },
    { label: "类型", value: formatHitType(hit) }
  ].filter((fact) => fact.value);
}

function primaryFortyTwoEvent(hit) {
  return (hit.fortyTwoEvents ?? [])[0] ?? null;
}

function alertKind(hit) {
  return primaryFortyTwoEvent(hit) ? "42_trade" : "generic";
}

async function postFeishuPayload(webhook, payload) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Feishu webhook ${response.status}: ${body.slice(0, 200)}`);
  const parsed = parseJsonOrNull(body);
  const code = parsed?.code ?? parsed?.StatusCode;
  if (code !== undefined && Number(code) !== 0) {
    const message = parsed?.msg ?? parsed?.StatusMessage ?? body;
    throw new Error(`Feishu webhook code ${code}: ${String(message).slice(0, 200)}`);
  }
}

async function initialLastProcessedBlock(publicClient, lookbackBlocks) {
  const current = await publicClient.getBlockNumber();
  const lookback = BigInt(Math.max(0, lookbackBlocks));
  return current > lookback ? current - lookback : 0n;
}

function serializeHit(hit) {
  return {
    txHash: hit.txHash,
    blockNumber: hit.blockNumber?.toString() ?? null,
    transactionIndex: hit.transactionIndex ?? null,
    from: hit.from,
    to: hit.to,
    nativeValueBnb: hit.nativeValueWei > 0n ? formatEther(hit.nativeValueWei) : "0",
    direct: hit.direct,
    directions: [...hit.directions].sort(),
    tokenTransferCount: hit.tokenTransferCount,
    contracts: [...hit.contracts].sort(),
    transferFrom: [...hit.transferFrom].sort(),
    transferTo: [...hit.transferTo].sort(),
    receiptStatus: hit.receiptStatus ?? null,
    fortyTwoEvents: hit.fortyTwoEvents ?? [],
    enrichmentError: hit.enrichmentError ?? null
  };
}

function compareHits(a, b) {
  const blockA = a.blockNumber ?? 0n;
  const blockB = b.blockNumber ?? 0n;
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return Number(a.transactionIndex ?? 0) - Number(b.transactionIndex ?? 0);
}

function formatHitType(hit) {
  const parts = [];
  if (hit.direct) {
    const nativeValue = hit.nativeValueWei > 0n ? `${trimNumber(formatEther(hit.nativeValueWei))} BNB` : "";
    parts.push(nativeValue ? `原生交易 ${nativeValue}` : "原生交易");
  }
  if (hit.tokenTransferCount > 0) parts.push(`Token Transfer x${hit.tokenTransferCount}`);
  return parts.join(" / ") || "链上交易";
}

function formatDirections(directions) {
  const set = directions instanceof Set ? directions : new Set(directions ?? []);
  if (set.has("in") && set.has("out")) return "转入/转出";
  if (set.has("in")) return "转入";
  if (set.has("out")) return "转出";
  return "相关";
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

function pruneSeenTxs(state) {
  const entries = Object.entries(state.seenTxs ?? {});
  if (entries.length <= 5000) return;
  state.seenTxs = Object.fromEntries(entries.slice(-4000));
}

function addressToTopic(address) {
  return `0x${"0".repeat(24)}${String(address).toLowerCase().slice(2)}`;
}

function topicAddress(topic) {
  try {
    if (!topic) return null;
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

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function parseRpcBigInt(value) {
  if (value === undefined || value === null) return null;
  return BigInt(value);
}

function parseRpcNumber(value) {
  if (value === undefined || value === null) return null;
  return Number(value);
}

function parseJsonOrNull(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

function absBigInt(value) {
  return value < 0n ? -value : value;
}

function formatTokenAmount(value, decimals, maxFractionDigits) {
  const number = Number(formatUnits(BigInt(value), decimals));
  return formatDisplayNumber(number, maxFractionDigits);
}

function formatDisplayNumber(value, maxFractionDigits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: 0
  }).format(number);
}

function pruneMap(map, maxEntries) {
  while (map.size > maxEntries) map.delete(map.keys().next().value);
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
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function shortAddress(address) {
  const text = String(address);
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function shortHash(hash) {
  const text = String(hash);
  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

function trimNumber(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatDuration(ms) {
  const minutes = Math.round(Number(ms) / 60000);
  if (minutes >= 1) return `${minutes} 分钟`;
  return `${Math.round(Number(ms) / 1000)} 秒`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function requiredValue(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

function cleanErrorMessage(error) {
  return errorMessage(error)
    .replace(/(?:https?|wss?):\/\/[^\s"']+/gu, "[RPC]")
    .slice(0, 500);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfTest() {
  const address = "0x96FDe227f3863812464dC1320B505016837a3650";
  const topic = addressToTopic(getAddress(address));
  assert(topic === "0x00000000000000000000000096fde227f3863812464dc1320b505016837a3650", "address topic encode failed");
  assert(topicAddress(topic) === getAddress(address), "topic address decode failed");
  assert(formatDirections(new Set(["in"])) === "转入", "incoming direction label failed");
  assert(formatDirections(new Set(["out"])) === "转出", "outgoing direction label failed");
  assert(formatDirections(new Set(["in", "out"])) === "转入/转出", "mixed direction label failed");
  const hit = ensureHit(new Map(), "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
  hit.direct = true;
  hit.nativeValueWei = 1000000000000000000n;
  hit.directions.add("out");
  assert(formatHitType(hit) === "原生交易 1 BNB", "native hit label failed");
  const feedHits = new Map();
  mergeObserverFeedHit(feedHits, {
    level: "shared-rpc-observer-address-direct",
    txHash: hit.txHash,
    blockNumber: "123",
    transactionIndex: 4,
    from: address,
    to: "0x0000000000000000000000000000000000000003",
    valueWei: "1000000000000000000"
  });
  mergeObserverFeedHit(feedHits, {
    level: "shared-rpc-observer-address-transfer",
    txHash: hit.txHash,
    blockNumber: "123",
    transactionIndex: 4,
    direction: "out",
    contract: "0x0000000000000000000000000000000000000004",
    from: address,
    to: "0x0000000000000000000000000000000000000003"
  });
  const feedHit = feedHits.get(hit.txHash.toLowerCase());
  assert(feedHit?.direct && feedHit?.tokenTransferCount === 1, "observer feed rows must aggregate by transaction");
  const receiptHit = ensureHit(new Map(), hit.txHash);
  const otherTopic = addressToTopic("0x0000000000000000000000000000000000000003");
  mergeReceiptTransferDetails(receiptHit, [{
    address: "0x0000000000000000000000000000000000000004",
    topics: [ERC20_TRANSFER_TOPIC, topic, otherTopic]
  }, {
    address: "0x0000000000000000000000000000000000000005",
    topics: [ERC1155_TRANSFER_SINGLE_TOPIC, otherTopic, otherTopic, topic]
  }], getAddress(address).toLowerCase());
  assert(receiptHit.tokenTransferCount === 2, "receipt hydration must recover every matching transfer log");
  assert(receiptHit.directions.has("in") && receiptHit.directions.has("out"), "receipt hydration must recover both directions");
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const trade = parseMarketTradeLog({
    address: "0x47D0BBf0fCd0626621b47484Df8251109684C0c2",
    topics: [
      MARKET_TRADE_TOPIC,
      `0x${word(0n)}`,
      topic,
      `0x${word(1n)}`
    ],
    data: `0x${word(56580000000000000000n)}${word(9988760000000000000000n)}${word(0n)}`,
    logIndex: 22
  }, address);
  assert(trade?.action === "buy", "42 MarketTrade buy decode failed");
  assert(trade?.amountUsdt === "56.58", "42 MarketTrade collateral decode failed");
  assert(trade?.size === "9,988.76", "42 MarketTrade size decode failed");
  hit.nativeValueWei = 100000000000000000n;
  hit.fortyTwoEvents = [{
    ...trade,
    question: "$HOODIES FDV by July 10th, 12:00 UTC?",
    outcome: "< $500K"
  }];
  const facts = alertFacts({ watchedAddress: getAddress(address) }, hit);
  assert(alertKind(hit) === "42_trade", "42 trade alert priority failed");
  assert(facts.some((fact) => fact.label === "事件" && fact.value.includes("HOODIES")), "42 event alert fact failed");
  assert(facts.some((fact) => fact.label === "操作" && fact.value.includes("< $500K")), "42 outcome alert fact failed");
  assert(facts.some((fact) => fact.label === "实际投入" && fact.value.includes("56.58 U") && fact.value.includes("0.1 BNB")), "42 amount alert fact failed");
  console.log(JSON.stringify({ level: "address-tx-watch-self-test", status: "ok" }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: "address-tx-watch-fatal",
    message: errorMessage(error),
    at: new Date().toISOString()
  }));
  process.exit(1);
});
