#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, formatUnits, getAddress, http, parseUnits } from "viem";
import { bsc } from "viem/chains";

import { appendJsonl, parseArgs, readConfig } from "../src/config.js";
import {
  appendGasLedgerEntries,
  bnbUsdtPriceForBlock,
  buildGasLedgerEntry
} from "../src/gas-ledger.js";
import {
  fetchOpenPositions,
  makeClients,
  quoteSellOutcome,
  sellOutcomesBatch
} from "../src/fortytwo.js";

const DEFAULT_PROFILE_ENV = "/etc/42space/profiles/42space-3.env";
const DEFAULT_POLL_MS = 5000;
const DEFAULT_LOG_EVERY_MS = 60000;
const DEFAULT_RPC_STATS_MS = 60000;
const DEFAULT_SELL_PERCENT = 100;
const DEFAULT_STATE_FILE = "data/position-value-trigger-sell-state.json";
const DEFAULT_LOG_FILE = "output/position-value-trigger-sell.jsonl";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const profileEnvFile = args.profileEnv ?? process.env.POSITION_VALUE_TRIGGER_PROFILE_ENV ?? DEFAULT_PROFILE_ENV;
  const profileEnv = fs.existsSync(profileEnvFile) ? parseEnvFile(profileEnvFile) : {};
  Object.assign(process.env, profileEnv);

  const cfg = readConfig();
  const appDir = path.resolve(args.appDir ?? process.cwd());
  const dataDir = path.dirname(cfg.runtimeConfigFile);
  const market = getAddress(requiredArg(
    args.market ?? process.env.POSITION_VALUE_TRIGGER_MARKET,
    "POSITION_VALUE_TRIGGER_MARKET or --market"
  ));
  const tokenId = optionalString(args.tokenId ?? process.env.POSITION_VALUE_TRIGGER_TOKEN_ID);
  const outcomeName = optionalString(args.outcomeName ?? process.env.POSITION_VALUE_TRIGGER_OUTCOME_NAME);
  if (!tokenId && !outcomeName) throw new Error("POSITION_VALUE_TRIGGER_TOKEN_ID/--token-id or outcome name is required");

  const thresholdUsdt = positiveNumber(
    args.thresholdUsdt ?? process.env.POSITION_VALUE_TRIGGER_THRESHOLD_USDT,
    null
  );
  if (!(thresholdUsdt > 0)) throw new Error("POSITION_VALUE_TRIGGER_THRESHOLD_USDT or --threshold-usdt must be positive");
  const minOutUsdt = positiveNumber(
    args.minOutUsdt ?? process.env.POSITION_VALUE_TRIGGER_MIN_OUT_USDT,
    thresholdUsdt
  );
  const sellPercent = positiveNumber(
    args.sellPercent ?? process.env.POSITION_VALUE_TRIGGER_SELL_PERCENT,
    DEFAULT_SELL_PERCENT
  );
  const pollMs = positiveInteger(args.pollMs ?? process.env.POSITION_VALUE_TRIGGER_POLL_MS, DEFAULT_POLL_MS);
  const logEveryMs = nonNegativeInteger(
    args.logEveryMs ?? process.env.POSITION_VALUE_TRIGGER_LOG_EVERY_MS,
    DEFAULT_LOG_EVERY_MS
  );
  const rpcStatsMs = nonNegativeInteger(
    args.rpcStatsMs ?? process.env.POSITION_VALUE_TRIGGER_RPC_STATS_MS,
    DEFAULT_RPC_STATS_MS
  );
  const once = Boolean(args.once || process.env.POSITION_VALUE_TRIGGER_ONCE === "1");
  const execute = Boolean(args.execute || process.env.POSITION_VALUE_TRIGGER_EXECUTE === "1");
  if (!execute) {
    cfg.dryRun = true;
    cfg.execute = false;
  }
  cfg.autoSellGasPriceGwei = String(
    args.sellGasPriceGwei ??
    process.env.POSITION_VALUE_TRIGGER_SELL_GAS_PRICE_GWEI ??
    cfg.autoSellGasPriceGwei ??
    ""
  );

  const { account } = makeClients(cfg);
  const rpcStats = createRpcStats();
  const publicClient = createPublicClient({
    chain: bsc,
    transport: instrumentTransport(http(cfg.rpcUrl), rpcStats)
  });
  const walletAddress = getAddress(args.wallet ?? cfg.walletAddress ?? account?.address);
  if (!walletAddress) throw new Error("WALLET_ADDRESS, PRIVATE_KEY-derived account, or --wallet is required");
  if (execute && account?.address?.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("Real sell wallet must match PRIVATE_KEY-derived account");
  }

  const stateFile = path.resolve(
    args.stateFile ??
    process.env.POSITION_VALUE_TRIGGER_STATE_FILE ??
    path.join(dataDir, DEFAULT_STATE_FILE)
  );
  const logFile = path.resolve(
    args.logFile ??
    process.env.POSITION_VALUE_TRIGGER_LOG_FILE ??
    path.join(appDir, DEFAULT_LOG_FILE)
  );
  const state = loadState(stateFile);
  const priceCache = new Map();
  state.market ??= market;
  state.tokenId ??= tokenId ?? null;
  state.outcomeName ??= outcomeName ?? null;
  state.thresholdUsdt ??= thresholdUsdt;

  appendJsonl(logFile, {
    level: "position-value-trigger-sell-started",
    mode: execute ? "execute" : "dry-run",
    profileEnvFile,
    market,
    tokenId: tokenId ?? null,
    outcomeName: outcomeName ?? null,
    wallet: walletAddress,
    thresholdUsdt,
    minOutUsdt,
    sellPercent,
    pollMs,
    rpcStatsMs,
    once,
    sellGasPriceGwei: cfg.autoSellGasPriceGwei || cfg.gasPriceGwei,
    at: new Date().toISOString()
  });

  let lastLogAt = 0;
  const operatorApprovalCache = { value: null };
  while (true) {
    if (state.sold) {
      saveState(stateFile, state);
      appendJsonl(logFile, {
        level: "position-value-trigger-sell-already-sold",
        market,
        tokenId: state.soldTokenId ?? tokenId ?? null,
        txHash: state.txHash ?? null,
        soldAt: state.soldAt ?? null,
        at: new Date().toISOString()
      });
      return;
    }

    try {
      const result = await checkAndMaybeSell({
        cfg,
        publicClient,
        state,
        stateFile,
        logFile,
        priceCache,
        market,
        tokenId,
        outcomeName,
        walletAddress,
        thresholdUsdt,
        minOutUsdt,
        sellPercent,
        execute,
        operatorApprovalCache
      });
      const now = Date.now();
      if (result?.sold) return;
      if (shouldLogStatus(result, now, lastLogAt, logEveryMs)) {
        lastLogAt = now;
        appendJsonl(logFile, {
          level: result.level ?? "position-value-trigger-sell-status",
          ...result,
          at: new Date(now).toISOString()
        });
      }
      if (once) return;
    } catch (error) {
      appendJsonl(logFile, {
        level: "position-value-trigger-sell-error",
        market,
        tokenId: tokenId ?? null,
        outcomeName: outcomeName ?? null,
        message: errorMessage(error),
        at: new Date().toISOString()
      });
      if (once) return;
    } finally {
      maybeFlushPositionRpcStats({ rpcStats, rpcStatsMs, logFile, market });
    }
    await sleep(pollMs);
  }
}

async function checkAndMaybeSell(ctx) {
  const positions = await fetchOpenPositions(ctx.cfg, {
    user: ctx.walletAddress,
    market: ctx.market,
    limit: 100
  });
  const position = selectWatchedPosition(positions, {
    market: ctx.market,
    tokenId: ctx.tokenId,
    outcomeName: ctx.outcomeName
  });
  if (!position) {
    const summary = {
      level: "position-value-trigger-sell-no-position",
      market: ctx.market,
      tokenId: ctx.tokenId ?? null,
      outcomeName: ctx.outcomeName ?? null,
      openPositionCount: positions.length
    };
    updateState(ctx.stateFile, ctx.state, {
      lastStatus: "no_position",
      lastOpenPositionCount: positions.length,
      lastCheckedAt: new Date().toISOString()
    });
    return summary;
  }

  const quote = await quoteSellOutcome(ctx.publicClient, {
    market: position.marketAddress,
    tokenId: position.tokenId,
    owner: ctx.walletAddress,
    percent: ctx.sellPercent,
    slippageBps: ctx.cfg.slippageBps,
    operatorApproved: ctx.operatorApprovalCache?.value
  });
  if (ctx.operatorApprovalCache) ctx.operatorApprovalCache.value = Boolean(quote.operatorApproved);
  const expectedUsdt = numberFromUnits(quote.expectedCollateralToUser, 18);
  const markValueUsdt = Number(position.costBasis ?? 0) + Number(position.cashPnl ?? 0);
  const thresholdMet = expectedUsdt >= ctx.thresholdUsdt;
  const summary = {
    level: thresholdMet ? "position-value-trigger-sell-threshold-met" : "position-value-trigger-sell-quote",
    market: position.marketAddress,
    question: position.question?.title ?? null,
    outcome: position.outcome?.name ?? null,
    tokenId: String(position.tokenId),
    size: String(position.size ?? ""),
    sellAmountOt: formatUnits(quote.amount, 18),
    markValueUsdt: round(markValueUsdt),
    expectedCollateralToUserUsdt: round(expectedUsdt),
    thresholdUsdt: ctx.thresholdUsdt,
    minOutUsdt: ctx.minOutUsdt,
    operatorApproved: Boolean(quote.operatorApproved),
    thresholdMet
  };

  updateState(ctx.stateFile, ctx.state, {
    lastStatus: thresholdMet ? "threshold_met" : "below_threshold",
    lastCheckedAt: new Date().toISOString(),
    lastQuote: summary
  });

  if (!thresholdMet) return summary;

  const minOut = parseUnits(String(ctx.minOutUsdt), 18);
  if (quote.expectedCollateralToUser < minOut) {
    return {
      ...summary,
      level: "position-value-trigger-sell-minout-blocked",
      minOutBlocked: true
    };
  }
  const plan = {
    ...quote,
    minCollateralOut: minOut
  };

  if (!ctx.execute || ctx.cfg.dryRun || !ctx.cfg.execute) {
    appendJsonl(ctx.logFile, {
      level: "position-value-trigger-sell-dry-run-trigger",
      ...summary,
      at: new Date().toISOString()
    });
    return summary;
  }

  const execution = await sellOutcomesBatch(ctx.cfg, [plan]);
  await appendPositionValueGasLedger(ctx, {
    execution,
    action: "sell",
    source: "position-value-trigger-sell",
    wallet: ctx.walletAddress,
    allocations: [{
      market: position.marketAddress,
      question: position.question?.title ?? null,
      tokenId: position.tokenId,
      outcome: position.outcome?.name ?? null,
      action: "sell",
      amountUsdt: expectedUsdt,
      weight: expectedUsdt > 0 ? expectedUsdt : 1
    }]
  });
  for (const approval of execution?.approvals ?? []) {
    await appendPositionValueGasLedger(ctx, {
      execution: approval,
      action: "approval",
      source: "position-value-trigger-sell-approval",
      wallet: ctx.walletAddress,
      txHashKey: "operatorApprovalHash",
      fieldPrefix: "operatorApproval",
      allocations: [{
        market: approval.market ?? position.marketAddress,
        question: position.question?.title ?? null,
        tokenId: position.tokenId,
        outcome: position.outcome?.name ?? null,
        action: "approval",
        weight: 1
      }]
    });
  }

  updateState(ctx.stateFile, ctx.state, {
    sold: true,
    soldAt: new Date().toISOString(),
    soldTokenId: String(position.tokenId),
    soldOutcome: position.outcome?.name ?? null,
    txHash: execution?.txHash ?? null,
    execution,
    lastStatus: "sold"
  });
  appendJsonl(ctx.logFile, {
    level: "position-value-trigger-sell-execution",
    mode: "execute",
    ...summary,
    execution,
    at: new Date().toISOString()
  });
  return { ...summary, sold: true, execution };
}

function selectWatchedPosition(positions = [], { market, tokenId, outcomeName } = {}) {
  const marketLower = String(market ?? "").toLowerCase();
  const normalizedOutcome = normalizeOutcomeName(outcomeName);
  return positions.find((position) => {
    if (marketLower && String(position.marketAddress ?? "").toLowerCase() !== marketLower) return false;
    if (tokenId && String(position.tokenId) !== String(tokenId)) return false;
    if (normalizedOutcome && normalizeOutcomeName(position.outcome?.name) !== normalizedOutcome) return false;
    return Number(position.size ?? 0) > 0;
  }) ?? null;
}

async function appendPositionValueGasLedger(ctx, {
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
      profile: ctx.cfg.botName,
      source,
      action,
      wallet,
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
      level: "position-value-trigger-gas-ledger-error",
      source,
      txHash,
      message: errorMessage(error),
      at: new Date().toISOString()
    });
  }
}

function shouldLogStatus(result, now, lastLogAt, logEveryMs) {
  if (!result) return false;
  if (result.thresholdMet || result.minOutBlocked || result.sold) return true;
  if (result.level === "position-value-trigger-sell-no-position") return now - lastLogAt >= logEveryMs;
  return logEveryMs > 0 && now - lastLogAt >= logEveryMs;
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
            // Metrics must never affect quote or sell behavior.
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

function maybeFlushPositionRpcStats({ rpcStats, rpcStatsMs, logFile, market }, now = Date.now()) {
  if (rpcStatsMs <= 0 || now - rpcStats.startedAt < rpcStatsMs) return false;
  try {
    appendJsonl(logFile, {
      level: "position-value-trigger-rpc-stats",
      market,
      ...consumeRpcStats(rpcStats, now),
      at: new Date(now).toISOString()
    });
    return true;
  } catch {
    return false;
  }
}

function updateState(file, state, patch) {
  Object.assign(state, patch);
  saveState(file, state);
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

function optionalString(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function numberFromUnits(value, decimals) {
  return Number(formatUnits(BigInt(value), decimals));
}

function normalizeOutcomeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[‐-‒–—―]/gu, "-")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 1e6) / 1e6 : null;
}

function requiredArg(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSelfTest() {
  const positions = [
    {
      marketAddress: "0x94FA631F5A8d830919db6d5B1571e438f0222Fb0",
      tokenId: "2048",
      size: "1",
      outcome: { name: "ESP 2-1 BEL" }
    }
  ];
  assert(
    selectWatchedPosition(positions, {
      market: "0x94FA631F5A8d830919db6d5B1571e438f0222Fb0",
      tokenId: "2048"
    })?.tokenId === "2048",
    "token id selection failed"
  );
  assert(
    selectWatchedPosition(positions, {
      market: "0x94FA631F5A8d830919db6d5B1571e438f0222Fb0",
      outcomeName: "ESP 2–1 BEL"
    })?.tokenId === "2048",
    "outcome name normalization failed"
  );
  assert(positiveNumber("99", 0) === 99, "positive number parse failed");
  const rpcStats = createRpcStats(1000);
  recordRpcStat(rpcStats, "eth_call", 10, true);
  const rpcSnapshot = consumeRpcStats(rpcStats, 2000);
  assert(rpcSnapshot.totalRequests === 1 && rpcSnapshot.methods.eth_call.errors === 0, "RPC stats aggregation failed");
  console.log(JSON.stringify({ level: "position-value-trigger-sell-self-test", status: "ok" }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: "position-value-trigger-sell-fatal",
    message: errorMessage(error)
  }));
  process.exit(1);
});
