#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";

import { readConfig } from "../src/config.js";
import {
  appendGasLedgerEntries,
  buildGasLedgerEntry,
  buildGasSummary,
  gasLedgerFileForConfig,
  gasLedgerTxSet,
  normalizeTxHash,
  readGasLedger
} from "../src/gas-ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const BNBUSDT_SPOT = "https://api.binance.com/api/v3/klines";
const BNBUSDT_FUTURES = "https://fapi.binance.com/fapi/v1/klines";
const OKX_HISTORY_CANDLES = "https://www.okx.com/api/v5/market/history-candles";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const profileEnv = args.profileEnv ? parseEnvFile(args.profileEnv) : {};
  Object.assign(process.env, profileEnv);
  const cfg = readConfig();
  const profile = String(args.profile ?? cfg.botName ?? process.env.BOT_NAME ?? "");
  const rpcUrl = args.rpcUrl ?? cfg.rpcUrl;
  if (!rpcUrl) throw new Error("Missing RPC URL");

  const dataDir = path.dirname(cfg.runtimeConfigFile ?? cfg.fillsFile ?? "data/runtime-config.json");
  const fillsFile = path.resolve(rootDir, args.fillsFile ?? cfg.fillsFile ?? path.join(dataDir, "fills.jsonl"));
  const actionsFile = path.resolve(rootDir, args.actionsFile ?? process.env.DASHBOARD_ACTIONS_FILE ?? path.join(dataDir, "dashboard-actions.jsonl"));
  const gasLedgerFile = path.resolve(rootDir, args.gasLedgerFile ?? gasLedgerFileForConfig(cfg));
  const outputFile = path.resolve(rootDir, args.output ?? path.join("output", "gas-ledger", `${safeSlug(profile || "profile")}-latest.json`));

  const existing = readGasLedger(gasLedgerFile);
  const existingTxs = args.rebuild
    ? new Set()
    : gasLedgerTxSet(existing.filter((entry) => args.noUsdt || entry.gasFeeUsdt !== null));
  const fills = readJsonl(fillsFile);
  const actions = readJsonl(actionsFile);
  const candidates = collectTxCandidates({ fills, actions, profile });
  const pending = [...candidates.values()]
    .filter((candidate) => !existingTxs.has(candidate.txHash))
    .sort(compareCandidates);
  const limit = positiveInteger(args.limit, pending.length);
  const selected = pending.slice(0, limit);

  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const priceCache = new Map();
  const entries = [];
  const errors = [];
  for (const candidate of selected) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: candidate.txHash });
      const blockNumber = receipt?.blockNumber !== undefined && receipt?.blockNumber !== null
        ? BigInt(receipt.blockNumber)
        : null;
      const [transaction, block] = await Promise.all([
        publicClient.getTransaction({ hash: candidate.txHash }).catch(() => null),
        receipt?.blockHash
          ? publicClient.getBlock({ blockHash: receipt.blockHash }).catch(() => (
            blockNumber ? publicClient.getBlock({ blockNumber }).catch(() => null) : null
          ))
          : blockNumber
            ? publicClient.getBlock({ blockNumber }).catch(() => null)
            : Promise.resolve(null)
      ]);
      const priceInfo = args.noUsdt
        ? null
        : await bnbUsdtPriceForBlock(block, priceCache).catch((error) => ({
          price: null,
          source: null,
          error: error?.message ?? String(error)
        }));
      entries.push(buildGasLedgerEntry({
        txHash: candidate.txHash,
        receipt,
        transaction,
        block,
        profile,
        source: candidate.source,
        action: candidate.action,
        wallet: candidate.wallet,
        allocations: candidate.allocations,
        bnbUsdtPrice: priceInfo?.price ?? null,
        bnbUsdtSource: priceInfo?.source ?? "",
        metadata: {
          firstSeenAt: candidate.firstSeenAt ?? null,
          sources: candidate.sources,
          priceError: priceInfo?.error ?? null
        }
      }));
      if (Number(args.sleepMs ?? 0) > 0) await sleep(Number(args.sleepMs));
    } catch (error) {
      errors.push({
        txHash: candidate.txHash,
        action: candidate.action,
        source: candidate.source,
        message: error?.message ?? String(error)
      });
    }
  }

  const written = args.dryRun ? 0 : appendGasLedgerEntries(gasLedgerFile, entries);
  const combined = args.rebuild ? entries : [...existing, ...entries];
  const summary = serializableGasSummary(buildGasSummary(combined));
  const report = {
    level: "gas-ledger-backfill",
    profile,
    generatedAt: new Date().toISOString(),
    files: {
      fillsFile,
      actionsFile,
      gasLedgerFile,
      outputFile
    },
    counts: {
      fills: fills.length,
      actions: actions.length,
      candidates: candidates.size,
      existingTxs: existingTxs.size,
      pending: pending.length,
      selected: selected.length,
      entriesBuilt: entries.length,
      written,
      errors: errors.length
    },
    summary,
    entries,
    errors
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(outputFile.replace(/\.json$/u, ".md"), markdownReport(report));
  console.log(JSON.stringify({
    level: report.level,
    profile,
    gasLedgerFile,
    outputFile,
    counts: report.counts,
    totalGasFeeBnb: summary.totalGasFeeBnb,
    totalGasFeeUsdt: summary.totalGasFeeUsdt,
    unpricedGasFeeBnb: summary.unpricedGasFeeBnb
  }, null, 2));
}

function collectTxCandidates({ fills, actions, profile }) {
  const candidates = new Map();
  for (const row of fills) collectFillTxCandidates(candidates, row, profile);
  for (const row of actions) collectActionTxCandidates(candidates, row, profile);
  return candidates;
}

function collectFillTxCandidates(candidates, row, profile) {
  if (row?.plan && row?.result?.txHash) {
    addCandidate(candidates, row.result.txHash, {
      profile,
      action: "buy",
      source: "fills:plan-result",
      firstSeenAt: row.at,
      wallet: row.result.from ?? "",
      allocations: allocationsFromPlan(row.plan)
    });
  }
  if (row?.bundle && row?.result?.txHash) {
    addCandidate(candidates, row.result.txHash, {
      profile,
      action: "buy",
      source: "fills:bundle-result",
      firstSeenAt: row.at,
      allocations: allocationsFromBundle(row.bundle)
    });
  }
  if (row?.level === "event-receipt" && row.txHash) {
    addCandidate(candidates, row.txHash, {
      profile,
      action: "buy",
      source: "fills:event-receipt",
      firstSeenAt: row.at,
      allocations: allocationsFromReceiptContext(row.context)
    });
  }
  if (row?.level === "event-auto-sell" && row.execution?.txHash) {
    addCandidate(candidates, row.execution.txHash, {
      profile,
      action: "sell",
      source: "fills:event-auto-sell",
      firstSeenAt: row.at,
      wallet: row.wallet ?? "",
      allocations: allocationsFromAutoSellActions(row.actions ?? (row.action ? [row.action] : []))
    });
    if (row.execution.approval?.txHash) {
      addCandidate(candidates, row.execution.approval.txHash, {
        profile,
        action: "approval",
        source: "fills:event-auto-sell-approval",
        firstSeenAt: row.at,
        wallet: row.wallet ?? "",
        allocations: [{ market: row.execution.approval.market ?? row.market ?? row.markets?.[0], action: "approval", weight: 1 }]
      });
    }
    for (const approval of row.execution.approvals ?? []) {
      addCandidate(candidates, approval.operatorApprovalHash, {
        profile,
        action: "approval",
        source: "fills:event-auto-sell-approval",
        firstSeenAt: row.at,
        wallet: row.wallet ?? "",
        allocations: [{ market: approval.market, action: "approval", weight: 1 }]
      });
    }
  }
  if (row?.level === "event-auto-sell-fast-open-exit-receipt" && row.txHash) {
    addCandidate(candidates, row.txHash, {
      profile,
      action: "sell",
      source: "fills:fast-open-exit-receipt",
      firstSeenAt: row.at,
      allocations: [{ market: row.market, question: row.question, action: "sell", weight: 1 }]
    });
  }
  if (row?.level === "event-operator-preapproval" && row.execution?.txHash) {
    addCandidate(candidates, row.execution.txHash, {
      profile,
      action: "approval",
      source: "fills:operator-preapproval",
      firstSeenAt: row.at,
      wallet: row.wallet ?? "",
      allocations: [{ market: row.market, action: "approval", weight: 1 }]
    });
  }
  collectGenericTxHashes(candidates, row, {
    profile,
    action: "unknown",
    source: `fills:${row?.level ?? "unknown"}`,
    firstSeenAt: row?.at ?? null
  });
}

function collectActionTxCandidates(candidates, row, profile) {
  addCandidate(candidates, row?.txHash ?? row?.tx, {
    profile,
    action: row?.type === "sell" ? "sell" : "dashboard_action",
    source: "dashboard-actions",
    firstSeenAt: row?.at ?? null,
    allocations: [{
      market: row?.market,
      question: row?.question,
      tokenId: row?.tokenId,
      outcome: row?.outcome,
      action: row?.type ?? "dashboard_action",
      weight: 1
    }]
  });
}

function collectGenericTxHashes(candidates, value, defaults, seenObjects = new Set()) {
  if (!value || typeof value !== "object" || seenObjects.has(value)) return;
  seenObjects.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectGenericTxHashes(candidates, item, defaults, seenObjects);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/txhash|transactionhash|approvehash|resethash|operatorapprovalhash/iu.test(key)) {
      addCandidate(candidates, child, defaults);
    }
    if (child && typeof child === "object") collectGenericTxHashes(candidates, child, defaults, seenObjects);
  }
}

function addCandidate(candidates, txHash, candidate) {
  const normalizedTxHash = normalizeTxHash(txHash);
  if (!normalizedTxHash) return;
  const existing = candidates.get(normalizedTxHash) ?? {
    txHash: normalizedTxHash,
    profile: candidate.profile ?? "",
    action: candidate.action ?? "unknown",
    source: candidate.source ?? "",
    sources: [],
    firstSeenAt: candidate.firstSeenAt ?? null,
    wallet: candidate.wallet ?? "",
    allocations: []
  };
  if (existing.action === "unknown" && candidate.action) existing.action = candidate.action;
  if (!existing.source && candidate.source) existing.source = candidate.source;
  if (candidate.source && !existing.sources.includes(candidate.source)) existing.sources.push(candidate.source);
  if (!existing.firstSeenAt && candidate.firstSeenAt) existing.firstSeenAt = candidate.firstSeenAt;
  if (!existing.wallet && candidate.wallet) existing.wallet = candidate.wallet;
  for (const allocation of candidate.allocations ?? []) {
    if (!allocation?.market && !allocation?.question && !allocation?.tokenId && !allocation?.outcome) continue;
    const key = [
      String(allocation.market ?? "").toLowerCase(),
      String(allocation.tokenId ?? ""),
      String(allocation.outcome ?? ""),
      String(allocation.action ?? "")
    ].join(":");
    const exists = existing.allocations.some((item) => [
      String(item.market ?? "").toLowerCase(),
      String(item.tokenId ?? ""),
      String(item.outcome ?? ""),
      String(item.action ?? "")
    ].join(":") === key);
    if (!exists) existing.allocations.push(allocation);
  }
  candidates.set(normalizedTxHash, existing);
}

function allocationsFromPlan(plan) {
  const market = plan?.market ?? {};
  const stake = Number(plan?.stakePerOutcomeUsdt ?? 0);
  return (plan?.outcomes ?? []).map((outcome) => ({
    market: market.address,
    question: market.question,
    tokenId: outcome.tokenId,
    outcome: outcome.name,
    action: "buy",
    amountUsdt: Number.isFinite(stake) && stake > 0 ? stake : null,
    weight: Number.isFinite(stake) && stake > 0 ? stake : 1
  }));
}

function allocationsFromBundle(bundle) {
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

function allocationsFromReceiptContext(context) {
  if (!context) return [];
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

function allocationsFromAutoSellActions(actions = []) {
  return actions.map((action) => ({
    market: action.marketAddress ?? action.market,
    question: action.question,
    tokenId: action.tokenId,
    outcome: action.outcome,
    action: "sell",
    weight: Number(action.expectedCollateralToUserUsdt ?? action.fullExitValueUsdt ?? 0) || 1
  }));
}

async function bnbUsdtPriceForBlock(block, cache) {
  const seconds = typeof block?.timestamp === "bigint" ? Number(block.timestamp) : Number(block?.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minuteMs = Math.floor((seconds * 1000) / 60000) * 60000;
  if (cache.has(minuteMs)) return cache.get(minuteMs);
  const price = await fetchBnbUsdtMinutePrice(minuteMs);
  cache.set(minuteMs, price);
  return price;
}

async function fetchBnbUsdtMinutePrice(minuteMs) {
  const urls = [BNBUSDT_SPOT, BNBUSDT_FUTURES, OKX_HISTORY_CANDLES];
  let lastError = null;
  for (const base of urls) {
    try {
      const url = bnbUsdtCandleUrl(base, minuteMs);
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "42space-gas-ledger/0.1"
        }
      });
      if (!response.ok) throw new Error(`Binance ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : payload.data;
      const close = Number(rows?.[0]?.[4]);
      if (!Number.isFinite(close) || close <= 0) throw new Error("Binance returned no valid close price");
      return {
        price: close,
        source: candleSource(base)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function bnbUsdtCandleUrl(base, minuteMs) {
  const url = new URL(base);
  if (base === OKX_HISTORY_CANDLES) {
    url.searchParams.set("instId", "BNB-USDT");
    url.searchParams.set("bar", "1m");
    url.searchParams.set("before", String(minuteMs - 60000));
    url.searchParams.set("after", String(minuteMs + 60000));
    url.searchParams.set("limit", "10");
    return url;
  }
  url.searchParams.set("symbol", "BNBUSDT");
  url.searchParams.set("interval", "1m");
  url.searchParams.set("startTime", String(minuteMs));
  url.searchParams.set("limit", "1");
  return url;
}

function candleSource(base) {
  if (base === OKX_HISTORY_CANDLES) return "okx-bnb-usdt-1m-close";
  return base.includes("/fapi/") ? "binance-futures-1m-close" : "binance-spot-1m-close";
}

function serializableGasSummary(summary) {
  return {
    txCount: summary.txCount,
    totalGasFeeBnb: round(summary.totalGasFeeBnb, 10),
    totalGasFeeUsdt: round(summary.totalGasFeeUsdt, 6),
    unpricedGasFeeBnb: round(summary.unpricedGasFeeBnb, 10),
    byAction: [...summary.byAction.entries()].map(([action, item]) => ({
      action,
      txCount: item.txCount,
      gasFeeBnb: round(item.gasFeeBnb, 10),
      gasFeeUsdt: round(item.gasFeeUsdt, 6)
    })).sort((a, b) => b.gasFeeUsdt - a.gasFeeUsdt),
    topMarkets: [...summary.byMarket.entries()].map(([market, item]) => ({
      market,
      gasFeeBnb: round(item.gasFeeBnb, 10),
      gasFeeUsdt: round(item.gasFeeUsdt, 6)
    })).sort((a, b) => b.gasFeeUsdt - a.gasFeeUsdt).slice(0, 20)
  };
}

function markdownReport(report) {
  const lines = [
    `# Gas Ledger Backfill - ${report.profile || "profile"}`,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Candidates: ${report.counts.candidates}`,
    `- Existing txs: ${report.counts.existingTxs}`,
    `- Pending txs: ${report.counts.pending}`,
    `- Written: ${report.counts.written}`,
    `- Errors: ${report.counts.errors}`,
    `- Total gas: ${report.summary.totalGasFeeBnb} BNB / ${report.summary.totalGasFeeUsdt} U`,
    `- Unpriced gas: ${report.summary.unpricedGasFeeBnb} BNB`,
    "",
    "## By Action",
    "",
    "| Action | Tx | BNB | U |",
    "| --- | ---: | ---: | ---: |",
    ...report.summary.byAction.map((row) => `| ${row.action} | ${row.txCount} | ${row.gasFeeBnb} | ${row.gasFeeUsdt} |`),
    "",
    "## Recent Entries",
    "",
    "| Tx | Action | BNB | U | Status |",
    "| --- | --- | ---: | ---: | --- |",
    ...report.entries.slice(-30).map((entry) => `| ${entry.txHash} | ${entry.action} | ${entry.gasFeeBnb} | ${entry.gasFeeUsdt ?? ""} | ${entry.status ?? ""} |`)
  ];
  if (report.errors.length > 0) {
    lines.push("", "## Errors", "", "| Tx | Action | Message |", "| --- | --- | --- |");
    for (const error of report.errors.slice(0, 50)) {
      lines.push(`| ${error.txHash} | ${error.action} | ${String(error.message ?? "").replace(/\|/gu, "/")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function compareCandidates(a, b) {
  return Date.parse(a.firstSeenAt ?? "") - Date.parse(b.firstSeenAt ?? "");
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

function parseEnvFile(file) {
  const env = {};
  if (!file || !fs.existsSync(file)) return env;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function safeSlug(value) {
  return String(value ?? "profile").trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "profile";
}

function round(value, decimals) {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Usage: node scripts/gas-ledger-backfill.js [options]

Options:
  --profile-env FILE       Load a production profile env safely.
  --rpc-url URL            Override RPC URL.
  --fills-file FILE        Override fills.jsonl.
  --actions-file FILE      Override dashboard-actions.jsonl.
  --gas-ledger-file FILE   Override output gas-ledger.jsonl.
  --output FILE            Write a JSON and Markdown report.
  --limit N                Backfill at most N missing transactions.
  --dry-run                Build entries and report without appending ledger.
  --no-usdt                Skip BNBUSDT historical price lookup.
  --rebuild                Ignore existing ledger tx hashes.
`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exit(1);
});
