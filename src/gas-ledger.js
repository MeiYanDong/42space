import fs from "node:fs";
import path from "node:path";
import { formatUnits } from "viem";

export const GAS_LEDGER_SCHEMA = "42space-gas-ledger/v1";
const BNBUSDT_SPOT = "https://api.binance.com/api/v3/klines";
const BNBUSDT_FUTURES = "https://fapi.binance.com/fapi/v1/klines";
const OKX_HISTORY_CANDLES = "https://www.okx.com/api/v5/market/history-candles";

export function gasLedgerFileForConfig(cfg = {}) {
  if (cfg.gasLedgerFile) return cfg.gasLedgerFile;
  const base = cfg.runtimeConfigFile || cfg.fillsFile || "data/runtime-config.json";
  return path.join(path.dirname(base), "gas-ledger.jsonl");
}

export function normalizeTxHash(value) {
  const text = String(value ?? "").trim();
  return /^0x[0-9a-fA-F]{64}$/u.test(text) ? text.toLowerCase() : null;
}

export function readGasLedger(file, { limit = 0 } = {}) {
  if (!file || !fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean);
  const selected = limit > 0 ? lines.slice(-limit) : lines;
  return selected
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => normalizeTxHash(row?.txHash));
}

export function appendGasLedgerEntries(file, entries) {
  const rows = entries.filter((entry) => normalizeTxHash(entry?.txHash));
  if (rows.length === 0) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return rows.length;
}

export function gasLedgerTxSet(entries = []) {
  return new Set(entries.map((entry) => normalizeTxHash(entry?.txHash)).filter(Boolean));
}

export function buildGasLedgerEntry({
  txHash,
  receipt,
  transaction = null,
  block = null,
  profile = "",
  source = "",
  action = "unknown",
  wallet = "",
  allocations = [],
  bnbUsdtPrice = null,
  bnbUsdtSource = "",
  metadata = {}
} = {}) {
  const normalizedTxHash = normalizeTxHash(txHash ?? receipt?.transactionHash);
  if (!normalizedTxHash) throw new Error("buildGasLedgerEntry requires a valid txHash");
  const gasUsed = toBigInt(receipt?.gasUsed);
  const effectiveGasPrice = toBigInt(receipt?.effectiveGasPrice ?? transaction?.gasPrice);
  const gasFeeWei = gasUsed * effectiveGasPrice;
  const gasFeeBnb = formatUnits(gasFeeWei, 18);
  const price = finitePositiveNumber(bnbUsdtPrice);
  const gasFeeUsdt = price ? roundMoney(Number(gasFeeBnb) * price, 8) : null;
  const normalizedAllocations = normalizeAllocations(allocations);

  return {
    schema: GAS_LEDGER_SCHEMA,
    txHash: normalizedTxHash,
    chainId: 56,
    profile: String(profile ?? ""),
    action: String(action ?? "unknown"),
    source: String(source ?? ""),
    status: receipt?.status ?? null,
    blockNumber: receipt?.blockNumber?.toString() ?? null,
    transactionIndex: receipt?.transactionIndex?.toString() ?? null,
    from: transaction?.from ?? null,
    to: transaction?.to ?? receipt?.to ?? null,
    wallet: wallet || transaction?.from || null,
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
    effectiveGasPriceGwei: formatUnits(effectiveGasPrice, 9),
    gasFeeWei: gasFeeWei.toString(),
    gasFeeBnb,
    bnbUsdtPrice: price === null ? null : roundMoney(price, 8),
    bnbUsdtSource: price === null ? null : (bnbUsdtSource || "BNBUSDT"),
    gasFeeUsdt,
    blockTime: blockTimeIso(block),
    allocations: normalizedAllocations,
    metadata,
    at: new Date().toISOString()
  };
}

export function buildGasSummary(entries = []) {
  const byTx = new Map();
  for (const entry of entries) {
    const txHash = normalizeTxHash(entry?.txHash);
    if (!txHash) continue;
    const previous = byTx.get(txHash);
    if (!previous || preferGasLedgerEntry(entry, previous)) {
      byTx.set(txHash, entry);
    }
  }

  const summary = {
    txCount: 0,
    totalGasFeeBnb: 0,
    totalGasFeeUsdt: 0,
    unpricedGasFeeBnb: 0,
    byMarket: new Map(),
    byOutcome: new Map(),
    byAction: new Map()
  };

  for (const entry of byTx.values()) {
    const gasBnb = Number(entry.gasFeeBnb ?? 0);
    const gasUsdt = Number(entry.gasFeeUsdt ?? 0);
    const hasUsdt = Number.isFinite(gasUsdt) && gasUsdt > 0;
    if (!Number.isFinite(gasBnb) || gasBnb <= 0) continue;
    summary.txCount += 1;
    summary.totalGasFeeBnb += gasBnb;
    if (hasUsdt) summary.totalGasFeeUsdt += gasUsdt;
    else summary.unpricedGasFeeBnb += gasBnb;
    addGasBucket(summary.byAction, String(entry.action ?? "unknown"), gasBnb, hasUsdt ? gasUsdt : 0, 1);

    const allocations = normalizedEntryAllocations(entry);
    for (const allocation of allocations) {
      const share = allocation.share;
      const allocatedBnb = gasBnb * share;
      const allocatedUsdt = hasUsdt ? gasUsdt * share : 0;
      const marketKey = normAddress(allocation.market);
      if (marketKey) {
        addGasBucket(summary.byMarket, marketKey, allocatedBnb, allocatedUsdt, 0);
      }
      const outcomeKey = marketKey && allocation.tokenId !== undefined && allocation.tokenId !== null
        ? `${marketKey}:${String(allocation.tokenId)}`
        : null;
      if (outcomeKey) {
        addGasBucket(summary.byOutcome, outcomeKey, allocatedBnb, allocatedUsdt, 0);
      }
    }
  }
  return summary;
}

function preferGasLedgerEntry(candidate, current) {
  const candidateUsdt = finitePositiveNumber(candidate?.gasFeeUsdt);
  const currentUsdt = finitePositiveNumber(current?.gasFeeUsdt);
  if (candidateUsdt !== null && currentUsdt === null) return true;
  if (candidateUsdt === null && currentUsdt !== null) return false;
  const candidateAt = Date.parse(candidate?.at ?? "");
  const currentAt = Date.parse(current?.at ?? "");
  if (Number.isFinite(candidateAt) && Number.isFinite(currentAt)) return candidateAt >= currentAt;
  return Number.isFinite(candidateAt) && !Number.isFinite(currentAt);
}

export function gasForMarket(summary, market) {
  return summary?.byMarket?.get(normAddress(market)) ?? emptyGasBucket();
}

export function gasForOutcome(summary, market, tokenId) {
  return summary?.byOutcome?.get(`${normAddress(market)}:${String(tokenId ?? "")}`) ?? emptyGasBucket();
}

export function gasForAction(summary, action) {
  return summary?.byAction?.get(String(action ?? "unknown")) ?? emptyGasBucket();
}

export function gasFeeWeiFromEntry(entry) {
  return toBigInt(entry?.gasFeeWei ?? 0n);
}

export async function bnbUsdtPriceForBlock(block, cache = null) {
  const seconds = blockTimestampSeconds(block);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const minuteMs = Math.floor((seconds * 1000) / 60000) * 60000;
  if (cache?.has(minuteMs)) return cache.get(minuteMs);
  const price = await fetchBnbUsdtMinutePrice(minuteMs);
  cache?.set(minuteMs, price);
  return price;
}

function normalizedEntryAllocations(entry) {
  const allocations = Array.isArray(entry.allocations) ? entry.allocations : [];
  if (allocations.length === 0) return [{ share: 1 }];
  const normalized = allocations
    .map((allocation) => ({
      ...allocation,
      share: finitePositiveNumber(allocation.share)
    }))
    .filter((allocation) => allocation.share !== null);
  if (normalized.length === 0) return [{ share: 1 }];
  const total = normalized.reduce((sum, allocation) => sum + allocation.share, 0);
  return normalized.map((allocation) => ({
    ...allocation,
    share: allocation.share / total
  }));
}

function normalizeAllocations(allocations = []) {
  const rows = (Array.isArray(allocations) ? allocations : [])
    .map((allocation) => ({
      market: allocation.market ?? allocation.marketAddress ?? null,
      question: allocation.question ?? allocation.title ?? null,
      tokenId: allocation.tokenId === undefined || allocation.tokenId === null ? null : String(allocation.tokenId),
      outcome: allocation.outcome ?? allocation.name ?? null,
      action: allocation.action ?? null,
      amountUsdt: finitePositiveNumber(allocation.amountUsdt ?? allocation.stakeUsdt ?? allocation.collateral),
      weight: finitePositiveNumber(allocation.weight ?? allocation.amountUsdt ?? allocation.stakeUsdt ?? allocation.collateral) ?? 1
    }))
    .filter((allocation) => allocation.market || allocation.question || allocation.tokenId || allocation.outcome);
  if (rows.length === 0) return [];
  const totalWeight = rows.reduce((sum, allocation) => sum + allocation.weight, 0);
  return rows.map((allocation) => {
    const share = totalWeight > 0 ? allocation.weight / totalWeight : 1 / rows.length;
    return {
      market: allocation.market,
      question: allocation.question,
      tokenId: allocation.tokenId,
      outcome: allocation.outcome,
      action: allocation.action,
      amountUsdt: allocation.amountUsdt,
      share: roundMoney(share, 12)
    };
  });
}

function addGasBucket(map, key, gasBnb, gasUsdt, txCountIncrement) {
  const bucket = map.get(key) ?? emptyGasBucket();
  bucket.gasFeeBnb += gasBnb;
  bucket.gasFeeUsdt += gasUsdt;
  bucket.txCount += txCountIncrement;
  map.set(key, bucket);
}

function emptyGasBucket() {
  return {
    gasFeeBnb: 0,
    gasFeeUsdt: 0,
    txCount: 0
  };
}

function normAddress(value) {
  const text = String(value ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/u.test(text) ? text.toLowerCase() : "";
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (value === undefined || value === null || value === "") return 0n;
  return BigInt(String(value));
}

function finitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundMoney(value, decimals) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function blockTimeIso(block) {
  const seconds = blockTimestampSeconds(block);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function blockTimestampSeconds(block) {
  const raw = block?.timestamp;
  if (raw === undefined || raw === null) return null;
  return typeof raw === "bigint" ? Number(raw) : Number(raw);
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
      if (!response.ok) throw new Error(`BNBUSDT ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : payload.data;
      const close = Number(rows?.[0]?.[4]);
      if (!Number.isFinite(close) || close <= 0) throw new Error("BNBUSDT source returned no valid close price");
      return {
        price: close,
        source: candleSource(base)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No BNBUSDT source returned a price");
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
