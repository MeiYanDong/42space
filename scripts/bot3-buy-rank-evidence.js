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

const DEFAULT_PROFILE_ENV = "/etc/42space/profiles/42space-3.env";
const DEFAULT_MARKET_WINDOW_SECONDS = 60;
const DEFAULT_BEFORE_BLOCKS = 120;
const DEFAULT_AFTER_BLOCKS = 120;
const DEFAULT_TOP = 10;

const BUSDT = "0x55d398326f99059fF775485246999027B3197955";
const ROUTER = "0x888888886619275d33c00D3BC62DF94D700DCD42";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MARKET_TRADE_TOPIC = "0xf2e90b10bd525a6b1fe02d09e8133d3e38c9a87376ed4850904ca21e6e27abec";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(args.appDir ?? process.cwd());
  const profileEnvFile = args.profileEnv ?? DEFAULT_PROFILE_ENV;
  const profileEnv = fs.existsSync(profileEnvFile) ? parseEnvFile(profileEnvFile) : {};
  const env = { ...process.env, ...profileEnv };
  const dataDir = path.dirname(env.RUNTIME_CONFIG_FILE ?? "/opt/42space/data/42space-3/runtime-config.json");
  const fillsFile = args.fillsFile ?? env.FILLS_FILE ?? path.join(dataDir, "fills.jsonl");
  const outDir = path.resolve(args.outDir ?? path.join(appDir, "output", "bot3-buy-rank"));
  fs.mkdirSync(outDir, { recursive: true });
  const stateFile = path.resolve(args.stateFile ?? path.join(outDir, "state.json"));

  const fills = readJsonl(fillsFile);
  const target = resolveTarget(args, fills);
  if (!target?.txHash || !target?.market) {
    if (args.onlyNew) {
      console.log(JSON.stringify({
        level: "bot3-buy-rank-evidence-skipped",
        reason: "no-buy-fill",
        latestUpdated: false,
        at: new Date().toISOString()
      }));
      process.exit(0);
    }
    const report = pendingReport({ args, profileEnvFile, fillsFile, outDir, target });
    writeReport(outDir, report, args);
    process.exit(2);
  }
  if (args.onlyNew && isKnownTx(outDir, stateFile, target.txHash)) {
    console.log(JSON.stringify({
      level: "bot3-buy-rank-evidence-skipped",
      reason: "already-collected",
      txHash: target.txHash,
      latestUpdated: false,
      at: new Date().toISOString()
    }));
    process.exit(0);
  }

  const rpcUrl = resolveRpcUrl(args, env);
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const generatedAt = new Date().toISOString();
  const market = getAddress(target.market);
  const txHash = target.txHash;
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const tx = await publicClient.getTransaction({ hash: txHash }).catch(() => null);
  const receiptBlock = await publicClient.getBlock({ blockHash: receipt.blockHash });
  const fromBlock = receipt.blockNumber - BigInt(nonNegativeInteger(args.beforeBlocks, DEFAULT_BEFORE_BLOCKS));
  const toBlock = receipt.blockNumber + BigInt(nonNegativeInteger(args.afterBlocks, DEFAULT_AFTER_BLOCKS));
  const startMs = Date.parse(target.startDate ?? "");
  const windowSeconds = nonNegativeInteger(args.windowSeconds, DEFAULT_MARKET_WINDOW_SECONDS);
  const topN = positiveInteger(args.top, DEFAULT_TOP);
  const targetBoundaryOffsetMs = targetBoundaryOffsetFrom(target.openBroadcastTiming, env, startMs);
  const targetBoundaryMs = Number.isFinite(startMs) && Number.isFinite(targetBoundaryOffsetMs)
    ? startMs + targetBoundaryOffsetMs
    : null;

  const logs = await getMarketTradeLogs(publicClient, market, fromBlock > 0n ? fromBlock : 0n, toBlock);
  const tradeLogs = logs
    .map((log) => parseMarketTradeLog(log, market))
    .filter(Boolean);
  const txGroups = groupByTxHash(tradeLogs);
  const txSummaries = await summarizeTxGroups(publicClient, txGroups, {
    market,
    outcomeMap: target.outcomeMap,
    startMs,
    windowSeconds
  });
  const ranked = txSummaries
    .filter((row) => {
      if (!Number.isFinite(startMs)) return true;
      return row.blockTimeMs >= startMs && row.blockTimeMs <= startMs + windowSeconds * 1000;
    })
    .sort(compareTxOrder)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const boundaryRank = buildBoundaryRank(ranked, txHash, targetBoundaryMs);

  const ourSummary = ranked.find((row) => row.txHash.toLowerCase() === txHash.toLowerCase()) ??
    txSummaries.find((row) => row.txHash.toLowerCase() === txHash.toLowerCase()) ??
    null;
  const top = ranked.slice(0, topN);
  const checks = {
    targetFound: true,
    receiptSuccess: receipt.status === "success",
    rankComputed: Boolean(ourSummary?.rank),
    ourRankOne: ourSummary?.rank === 1,
    ourFirstInTargetSecond: boundaryRank.ourTargetSecondRank === 1,
    ourFirstAtOrAfterTargetBoundary: boundaryRank.ourAtOrAfterBoundaryRank === 1,
    topIncludesOurTx: top.some((row) => row.txHash.toLowerCase() === txHash.toLowerCase()),
    noSecretMaterial: true
  };
  const conclusion = checks.ourRankOne
    ? "rank1_overall"
    : checks.ourFirstInTargetSecond
      ? "first_target_second"
      : checks.ourFirstAtOrAfterTargetBoundary ? "first_after_target_boundary" : checks.rankComputed ? "ranked_after_first" : "rank_missing";

  const report = {
    level: "bot3-buy-rank-evidence",
    generatedAt,
    conclusion,
    profile: {
      envFile: profileEnvFile,
      dataDir,
      fillsFile,
      botName: env.BOT_NAME ?? null,
      dashboardPort: env.DASHBOARD_PORT ?? null,
      walletAddress: env.WALLET_ADDRESS ?? null,
      rpcHost: rpcHost(rpcUrl),
      openBroadcastMode: env.OPEN_BROADCAST_MODE ?? null,
      openBroadcastDelayMs: env.OPEN_BROADCAST_DELAY_MS ?? null,
      openBroadcastBlockTargetOffsetMs: env.OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS ?? null,
      openBroadcastBlockAwareLeadMs: env.OPEN_BROADCAST_BLOCK_AWARE_LEAD_MS ?? null,
      openBroadcastBlockAwareMaxWaitMs: env.OPEN_BROADCAST_BLOCK_AWARE_MAX_WAIT_MS ?? null,
      openBroadcastBlockAwarePreTargetCount: env.OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_COUNT ?? null,
      openBroadcastBlockAwarePreTargetSendMs: env.OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_SEND_MS ?? null,
      openBroadcastBlockAwareHeadMaxAgeMs: env.OPEN_BROADCAST_BLOCK_AWARE_HEAD_MAX_AGE_MS ?? null,
      gasPriceGwei: env.GAS_PRICE_GWEI ?? null,
      autoSellGasPriceGwei: env.AUTO_SELL_GAS_PRICE_GWEI ?? null,
      fanoutBroadcast: env.FANOUT_BROADCAST ?? null,
      broadcastRpcCount: String(env.BROADCAST_RPC_URLS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean).length
    },
    target: {
      question: target.question ?? null,
      market,
      txHash,
      startDate: target.startDate ?? null,
      selectedOutcomes: [...target.outcomeMap.entries()].map(([tokenId, name]) => ({ tokenId, name }))
    },
    timing: {
      broadcastStartedAt: target.broadcastStartedAt ?? null,
      firstAcceptedAt: target.firstAcceptedAt ?? null,
      firstAcceptedLatencyMs: target.firstAcceptedLatencyMs ?? null,
      broadcastStartDelayMs: offsetMs(target.broadcastStartedAt, startMs),
      firstAcceptedDelayMs: offsetMs(target.firstAcceptedAt, startMs),
      targetBoundaryOffsetMs,
      targetBoundaryAt: targetBoundaryMs ? new Date(targetBoundaryMs).toISOString() : null,
      configuredTargetLeadMs: leadMs(target.openBroadcastTiming?.targetAt, targetBoundaryMs),
      broadcastLeadToTargetBoundaryMs: leadMs(target.broadcastStartedAt, targetBoundaryMs),
      firstAcceptedLeadToTargetBoundaryMs: leadMs(target.firstAcceptedAt, targetBoundaryMs),
      openBroadcastTiming: target.openBroadcastTiming ?? null
    },
    receipt: {
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      transactionIndex: Number(receipt.transactionIndex),
      blockTimestamp: Number(receiptBlock.timestamp),
      blockTimeIso: new Date(Number(receiptBlock.timestamp) * 1000).toISOString(),
      offsetSecByBlock: Number.isFinite(startMs) ? Math.floor((Number(receiptBlock.timestamp) * 1000 - startMs) / 1000) : null,
      offsetMsByBlock: Number.isFinite(startMs) ? Number(receiptBlock.timestamp) * 1000 - startMs : null,
      targetBoundaryDeltaMs: targetBoundaryMs ? Number(receiptBlock.timestamp) * 1000 - targetBoundaryMs : null,
      from: safeAddress(receipt.from),
      to: safeAddress(receipt.to),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceGwei: numberFromUnits(receipt.effectiveGasPrice, 9),
      txGasPriceGwei: tx?.gasPrice ? numberFromUnits(tx.gasPrice, 9) : null
    },
    rankWindow: {
      windowSeconds,
      fromBlock: (fromBlock > 0n ? fromBlock : 0n).toString(),
      toBlock: toBlock.toString(),
      marketTradeRows: tradeLogs.length,
      uniqueMintTx: txSummaries.length,
      uniqueMintTxInWindow: ranked.length
    },
    targetBoundaryRank: boundaryRank,
    checks,
    ourTx: ourSummary,
    top10: top
  };
  writeReport(outDir, report, args);
  writeState(stateFile, report, args);
  console.log(JSON.stringify({
    level: "bot3-buy-rank-evidence-written",
    conclusion: report.conclusion,
    ourRank: report.ourTx?.rank ?? null,
    topCount: report.top10.length,
    latestUpdated: args.noLatest !== true,
    jsonPath: report.paths?.jsonPath ?? null,
    mdPath: report.paths?.mdPath ?? null,
    at: generatedAt
  }));
}

function resolveTarget(args, fills) {
  const explicitTx = args.tx ?? args.txHash;
  const wantedMarket = args.market ? getAddress(args.market) : null;
  const buyRows = fills
    .filter((row) => row?.result?.txHash && row?.plan?.market?.address)
    .filter((row) => !explicitTx || String(row.result.txHash).toLowerCase() === String(explicitTx).toLowerCase())
    .filter((row) => !wantedMarket || String(row.plan.market.address).toLowerCase() === wantedMarket.toLowerCase());
  const row = buyRows.at(-1);
  if (row) {
    const outcomeMap = new Map();
    for (const outcome of row.plan?.outcomes ?? []) {
      if (outcome?.tokenId !== undefined && outcome?.name) outcomeMap.set(String(outcome.tokenId), String(outcome.name));
    }
    for (const outcome of row.result?.outcomes ?? []) {
      if (outcome?.tokenId !== undefined && outcome?.name && !outcomeMap.has(String(outcome.tokenId))) {
        outcomeMap.set(String(outcome.tokenId), String(outcome.name));
      }
    }
    return {
      txHash: row.result.txHash,
      market: row.plan.market.address,
      question: row.plan.market.question,
      startDate: row.plan.market.startDate,
      broadcastStartedAt: row.result.broadcastStartedAt,
      firstAcceptedAt: row.result.firstAcceptedAt,
      firstAcceptedLatencyMs: row.result.firstAcceptedLatencyMs,
      openBroadcastTiming: row.result.openBroadcastTiming ?? null,
      outcomeMap
    };
  }
  if (explicitTx && wantedMarket) {
    return {
      txHash: explicitTx,
      market: wantedMarket,
      question: args.question ?? null,
      startDate: args.startDate ?? null,
      broadcastStartedAt: null,
      firstAcceptedAt: null,
      firstAcceptedLatencyMs: null,
      openBroadcastTiming: null,
      outcomeMap: new Map()
    };
  }
  return null;
}

async function summarizeTxGroups(publicClient, txGroups, { market, outcomeMap, startMs, windowSeconds }) {
  const summaries = [];
  for (const [txHash, rows] of txGroups.entries()) {
    const [receipt, tx] = await Promise.all([
      publicClient.getTransactionReceipt({ hash: txHash }),
      publicClient.getTransaction({ hash: txHash }).catch(() => null)
    ]);
    const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
    const blockTimeMs = Number(block.timestamp) * 1000;
    const parsedRows = rows.sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
    const user = majority(parsedRows.map((row) => row.user).filter(Boolean));
    const costTransfers = transferCostsFromUserToRouter(receipt.logs, user);
    const outcomes = parsedRows.map((row, index) => {
      const size = numberFromUnits(row.size, 18);
      const cost = costTransfers[index] ? numberFromUnits(costTransfers[index], 18) : null;
      const netCollateral = numberFromUnits(row.netCollateral, 18);
      return {
        tokenId: row.tokenId,
        outcome: outcomeMap.get(row.tokenId) ?? null,
        size,
        cost,
        netCollateral,
        tradePrice: size > 0 ? (cost ?? netCollateral) / size : null
      };
    });
    const totalCost = sumNumbers(outcomes.map((item) => item.cost));
    const totalNetCollateral = sumNumbers(outcomes.map((item) => item.netCollateral));
    const totalSize = sumNumbers(outcomes.map((item) => item.size));
    const weightedPrice = totalSize > 0 ? (totalCost || totalNetCollateral) / totalSize : null;
    summaries.push({
      txHash,
      user: user ?? safeAddress(receipt.from),
      from: safeAddress(receipt.from),
      market,
      blockNumber: Number(receipt.blockNumber),
      transactionIndex: Number(receipt.transactionIndex),
      blockTimeMs,
      blockTimeIso: new Date(blockTimeMs).toISOString(),
      blockTimeBj: formatBj(blockTimeMs),
      offsetSec: Number.isFinite(startMs) ? Math.floor((blockTimeMs - startMs) / 1000) : null,
      inWindow: Number.isFinite(startMs) ? blockTimeMs >= startMs && blockTimeMs <= startMs + windowSeconds * 1000 : true,
      gasUsed: Number(receipt.gasUsed),
      effectiveGasPriceGwei: numberFromUnits(receipt.effectiveGasPrice, 9),
      txGasPriceGwei: tx?.gasPrice ? numberFromUnits(tx.gasPrice, 9) : null,
      gasBnb: numberFromUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18),
      totalCostUsdt: totalCost || null,
      totalNetCollateralUsdt: totalNetCollateral || null,
      totalSize: totalSize || null,
      weightedTradePrice: weightedPrice,
      outcomes
    });
  }
  return summaries;
}

function parseMarketTradeLog(log, market) {
  if (String(log.address).toLowerCase() !== String(market).toLowerCase()) return null;
  if (String(log.topics?.[0]).toLowerCase() !== MARKET_TRADE_TOPIC) return null;
  if ((log.topics?.length ?? 0) < 4) return null;
  const dataWords = dataWords64(log.data);
  if (dataWords.length < 2) return null;
  return {
    txHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    transactionIndex: Number(log.transactionIndex),
    logIndex: Number(log.logIndex),
    operator: topicAddress(log.topics[1]),
    user: topicAddress(log.topics[2]),
    tokenId: BigInt(log.topics[3]).toString(),
    netCollateral: BigInt(`0x${dataWords[0]}`),
    size: BigInt(`0x${dataWords[1]}`)
  };
}

function transferCostsFromUserToRouter(logs, user) {
  if (!user) return [];
  const normalizedUser = user.toLowerCase();
  const normalizedRouter = ROUTER.toLowerCase();
  return logs
    .filter((log) => String(log.address).toLowerCase() === BUSDT.toLowerCase())
    .filter((log) => String(log.topics?.[0]).toLowerCase() === TRANSFER_TOPIC)
    .filter((log) => topicAddress(log.topics[1])?.toLowerCase() === normalizedUser)
    .filter((log) => topicAddress(log.topics[2])?.toLowerCase() === normalizedRouter)
    .map((log) => BigInt(log.data));
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

function pendingReport({ args, profileEnvFile, fillsFile, target }) {
  return {
    level: "bot3-buy-rank-evidence",
    generatedAt: new Date().toISOString(),
    conclusion: "pending_no_buy",
    profile: {
      envFile: profileEnvFile,
      fillsFile
    },
    target: target ?? null,
    checks: {
      targetFound: false,
      receiptSuccess: false,
      rankComputed: false,
      ourRankOne: false,
      noSecretMaterial: true
    },
    note: "No matching Bot3 buy fill was found. Pass --tx and --market, or run again after the next Bot3 buy.",
    args: {
      market: args.market ?? null,
      tx: args.tx ?? args.txHash ?? null
    }
  };
}

function writeReport(outDir, report, args) {
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outDir, `bot3-buy-rank-evidence-${stamp}.json`);
  const mdPath = path.join(outDir, `bot3-buy-rank-evidence-${stamp}.md`);
  report.paths = {
    jsonPath,
    mdPath,
    latestJsonPath: path.join(outDir, "latest.json"),
    latestMdPath: path.join(outDir, "latest.md")
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));
  if (args.noLatest !== true) {
    fs.copyFileSync(jsonPath, report.paths.latestJsonPath);
    fs.copyFileSync(mdPath, report.paths.latestMdPath);
  }
}

function writeState(file, report, args) {
  if (args.noState === true || !report?.target?.txHash) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    txHash: report.target.txHash,
    market: report.target.market,
    question: report.target.question ?? null,
    conclusion: report.conclusion,
    rank: report.ourTx?.rank ?? null,
    reportPath: report.paths?.jsonPath ?? null
  }, null, 2)}\n`);
}

function isKnownTx(outDir, stateFile, txHash) {
  const normalized = String(txHash).toLowerCase();
  const candidates = [
    safeReadJson(stateFile)?.txHash,
    safeReadJson(path.join(outDir, "latest.json"))?.target?.txHash
  ];
  return candidates.some((value) => value && String(value).toLowerCase() === normalized);
}

function renderMarkdown(report) {
  const lines = [
    "# Bot3 Buy Rank Evidence",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Conclusion: ${report.conclusion}`,
    `- Market: ${report.target?.question ?? ""} ${report.target?.market ?? ""}`.trim(),
    `- Tx: ${report.target?.txHash ?? ""}`,
    `- Open broadcast delay: ${report.profile?.openBroadcastDelayMs ?? ""}ms`,
    `- Open broadcast mode: ${report.profile?.openBroadcastMode ?? ""}`,
    `- Block-aware timing: ${formatOpenBroadcastTiming(report.timing?.openBroadcastTiming)}`,
    `- Buy gas: ${report.profile?.gasPriceGwei ?? ""}gwei`,
    `- Broadcast timing: start ${report.timing?.broadcastStartDelayMs ?? "n/a"}ms, first accepted ${report.timing?.firstAcceptedDelayMs ?? "n/a"}ms`,
    `- Target boundary: ${report.timing?.targetBoundaryAt ?? "n/a"} (${report.timing?.targetBoundaryOffsetMs ?? "n/a"}ms)`,
    `- Boundary lead: configured ${formatMs(report.timing?.configuredTargetLeadMs)}, broadcast ${formatMs(report.timing?.broadcastLeadToTargetBoundaryMs)}, first accepted ${formatMs(report.timing?.firstAcceptedLeadToTargetBoundaryMs)}`,
    `- Our rank: ${report.ourTx?.rank ?? "n/a"}`,
    `- Our target-second rank: ${report.targetBoundaryRank?.ourTargetSecondRank ?? "n/a"}`,
    `- Our at/after-boundary rank: ${report.targetBoundaryRank?.ourAtOrAfterBoundaryRank ?? "n/a"}`,
    "",
    "## Checks",
    "",
    ...Object.entries(report.checks ?? {}).map(([key, value]) => `- ${key}: ${value ? "yes" : "no"}`),
    "",
    "## Top 10",
    "",
    renderTopTable(report.top10 ?? []),
    "",
    "## Target Second",
    "",
    renderTopTable(report.targetBoundaryRank?.targetSecondTop ?? []),
    "",
    "## Our Tx",
    "",
    fencedJson(report.ourTx ?? null),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function renderTopTable(rows) {
  if (!rows.length) return "- none";
  const header = "| rank | address | gas gwei | block | txIndex | BJ time | price | tx |";
  const sep = "| --- | --- | ---: | ---: | ---: | --- | ---: | --- |";
  const body = rows.map((row) => [
    row.rank,
    row.from,
    formatMaybe(row.effectiveGasPriceGwei, 4),
    row.blockNumber,
    row.transactionIndex,
    row.blockTimeBj,
    formatMaybe(row.weightedTradePrice, 10),
    row.txHash
  ]);
  return [header, sep, ...body.map((cols) => `| ${cols.join(" | ")} |`)].join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function parseEnvFile(file) {
  const env = {};
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/u)
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

function safeReadJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function resolveRpcUrl(args, env) {
  const rpcUrl = args.rpcUrl ?? env.BSC_RPC_URL ?? env.CHAINSTACK_BSC_RPC_URL ?? env.ANKR_BSC_RPC_URL;
  if (!rpcUrl) throw new Error("Missing RPC URL: pass --rpc-url or provide profile env with BSC_RPC_URL/CHAINSTACK_BSC_RPC_URL/ANKR_BSC_RPC_URL");
  return rpcUrl;
}

function dataWords64(data) {
  const raw = String(data ?? "").replace(/^0x/u, "");
  const words = [];
  for (let i = 0; i + 64 <= raw.length; i += 64) words.push(raw.slice(i, i + 64));
  return words;
}

function topicAddress(topic) {
  try {
    return getAddress(`0x${String(topic).slice(-40)}`);
  } catch {
    return null;
  }
}

function safeAddress(value) {
  try {
    return value ? getAddress(value) : null;
  } catch {
    return value ?? null;
  }
}

function majority(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function sumNumbers(values) {
  return values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function numberFromUnits(value, decimals) {
  return Number(formatUnits(BigInt(value), decimals));
}

function offsetMs(value, startMs) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) && Number.isFinite(startMs) ? ms - startMs : null;
}

function leadMs(value, targetBoundaryMs) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) && Number.isFinite(targetBoundaryMs) ? targetBoundaryMs - ms : null;
}

function targetBoundaryOffsetFrom(timing, env, startMs) {
  const fromTiming = Date.parse(timing?.targetBoundaryAt ?? "");
  if (Number.isFinite(fromTiming) && Number.isFinite(startMs)) return fromTiming - startMs;
  const configured = Number(env.OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS ?? "");
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 20000;
}

function buildBoundaryRank(ranked, txHash, targetBoundaryMs) {
  if (!Number.isFinite(targetBoundaryMs)) {
    return {
      targetBoundaryAt: null,
      targetSecondStartAt: null,
      targetSecondCount: 0,
      atOrAfterBoundaryCount: 0,
      firstTargetSecondBlockNumber: null,
      ourTargetSecondRank: null,
      ourAtOrAfterBoundaryRank: null,
      ourFirstTargetSecondBlockRank: null,
      targetSecondTop: []
    };
  }
  const normalizedTx = String(txHash).toLowerCase();
  const targetSecondStartMs = Math.floor(targetBoundaryMs / 1000) * 1000;
  const targetSecondRows = ranked
    .filter((row) => row.blockTimeMs === targetSecondStartMs)
    .map((row, index) => ({ ...row, targetSecondRank: index + 1 }));
  const atOrAfterBoundaryRows = ranked
    .filter((row) => row.blockTimeMs >= targetBoundaryMs)
    .map((row, index) => ({ ...row, atOrAfterBoundaryRank: index + 1 }));
  const firstTargetSecondBlockNumber = targetSecondRows.length
    ? Math.min(...targetSecondRows.map((row) => row.blockNumber))
    : null;
  const firstTargetSecondBlockRows = firstTargetSecondBlockNumber === null
    ? []
    : targetSecondRows
      .filter((row) => row.blockNumber === firstTargetSecondBlockNumber)
      .map((row, index) => ({ ...row, firstTargetSecondBlockRank: index + 1 }));
  const ourTargetSecond = targetSecondRows.find((row) => row.txHash.toLowerCase() === normalizedTx) ?? null;
  const ourAtOrAfterBoundary = atOrAfterBoundaryRows.find((row) => row.txHash.toLowerCase() === normalizedTx) ?? null;
  const ourFirstTargetSecondBlock = firstTargetSecondBlockRows.find((row) => row.txHash.toLowerCase() === normalizedTx) ?? null;
  return {
    targetBoundaryAt: new Date(targetBoundaryMs).toISOString(),
    targetSecondStartAt: new Date(targetSecondStartMs).toISOString(),
    targetSecondCount: targetSecondRows.length,
    atOrAfterBoundaryCount: atOrAfterBoundaryRows.length,
    firstTargetSecondBlockNumber,
    ourTargetSecondRank: ourTargetSecond?.targetSecondRank ?? null,
    ourAtOrAfterBoundaryRank: ourAtOrAfterBoundary?.atOrAfterBoundaryRank ?? null,
    ourFirstTargetSecondBlockRank: ourFirstTargetSecondBlock?.firstTargetSecondBlockRank ?? null,
    targetSecondTop: targetSecondRows.slice(0, DEFAULT_TOP)
  };
}

function compareTxOrder(a, b) {
  return a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex;
}

function rpcHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "<unknown>";
  }
}

function formatBj(ms) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function formatMaybe(value, digits) {
  return Number.isFinite(value) ? Number(value).toFixed(digits).replace(/0+$/u, "").replace(/\.$/u, "") : "";
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function formatOpenBroadcastTiming(timing) {
  if (!timing) return "n/a";
  return [
    timing.mode ?? "",
    timing.reason ? `reason=${timing.reason}` : "",
    timing.targetAt ? `target=${timing.targetAt}` : "",
    timing.nominalTargetAt ? `nominal=${timing.nominalTargetAt}` : "",
    timing.latestOffsetMs !== null && timing.latestOffsetMs !== undefined ? `latestHeadOffsetMs=${timing.latestOffsetMs}` : ""
  ].filter(Boolean).join(" / ");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function fencedJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: "bot3-buy-rank-evidence-error",
    message: error?.message ?? String(error)
  }));
  process.exit(1);
});
