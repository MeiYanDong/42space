#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_OBSERVER_DIR = "/opt/42space/data/shared-rpc-observer";
const DEFAULT_OUTPUT_FILE = "/opt/42space/output/shared-rpc-observer/latest.json";
const DEFAULT_REQUIRED_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LATENCY_REGRESSION_MS = 100;
const DEFAULT_HEALTH_STALE_MS = 15000;
const DEFAULT_ORDERFLOW_LOGS = [
  "/opt/42space/data/42space/orderflow-trigger-sell-runner-up.jsonl",
  "/opt/42space/data/42space/orderflow-trigger-sell-third-place.jsonl",
  "/opt/42space/data/42space-3/orderflow-trigger-sell-runner-up.jsonl",
  "/opt/42space/data/42space-3/orderflow-trigger-sell-third-place.jsonl",
  "/opt/42space/data/42space-3/orderflow-trigger-sell-spain-belgium.jsonl"
];
const DEFAULT_ADDRESS_LOGS = [
  "/opt/42space/data/42space/address-tx-watch-0x96fde.jsonl",
  "/opt/42space/data/42space/address-tx-watch-0x1bc7df.jsonl",
  "/opt/42space/data/42space/address-tx-watch-0x51349f.jsonl"
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const observerDir = path.resolve(args.observerDir ?? process.env.SHARED_OBSERVER_DIR ?? DEFAULT_OBSERVER_DIR);
  const observerLogFile = path.resolve(args.observerLog ?? path.join(observerDir, "observer.jsonl"));
  const feedFile = path.resolve(args.feed ?? path.join(observerDir, "feed.jsonl"));
  const healthFile = path.resolve(args.health ?? path.join(observerDir, "health.json"));
  const outputFile = path.resolve(args.out ?? process.env.SHARED_OBSERVER_REPORT_FILE ?? DEFAULT_OUTPUT_FILE);
  const observerRows = readJsonl(observerLogFile);
  const latestStart = [...observerRows].reverse().find((row) => row.level === "shared-rpc-observer-started");
  const since = String(args.since ?? latestStart?.at ?? "");
  if (!since || !Number.isFinite(Date.parse(since))) {
    throw new Error("observer start time is unavailable; pass --since");
  }

  const nowMs = Date.now();
  const sinceMs = Date.parse(since);
  const health = readJson(healthFile);
  const feedRows = readJsonl(feedFile).filter((row) => rowTimeMs(row) >= sinceMs);
  const windowObserverRows = observerRows.filter((row) => rowTimeMs(row) >= sinceMs);
  const orderflowRows = csvFiles(args.orderflowLogs, DEFAULT_ORDERFLOW_LOGS)
    .flatMap(readJsonl)
    .filter((row) => row.level === "orderflow-trigger-sell-trade" && rowTimeMs(row) >= sinceMs);
  const addressRows = csvFiles(args.addressLogs, DEFAULT_ADDRESS_LOGS)
    .flatMap(readJsonl)
    .filter((row) => row.level === "address-tx-watch-hit" && rowTimeMs(row) >= sinceMs);

  const report = buildReport({
    nowMs,
    since,
    health,
    feedRows,
    observerRows: windowObserverRows,
    orderflowRows,
    addressRows,
    requiredWindowMs: positiveInteger(args.requiredWindowMs, DEFAULT_REQUIRED_WINDOW_MS),
    maxLatencyRegressionMs: nonNegativeInteger(
      args.maxLatencyRegressionMs,
      DEFAULT_MAX_LATENCY_REGRESSION_MS
    ),
    healthStaleMs: positiveInteger(args.healthStaleMs, DEFAULT_HEALTH_STALE_MS),
    minOrderflowSamples: nonNegativeInteger(args.minOrderflowSamples, 1),
    minAddressSamples: health?.features?.addressEnabled === false
      ? 0
      : nonNegativeInteger(
          args.minAddressSamples ?? process.env.SHARED_OBSERVER_REPORT_MIN_ADDRESS_SAMPLES,
          1
        )
  });
  saveJsonAtomic(outputFile, report);
  console.log(JSON.stringify({
    level: "shared-rpc-observer-report",
    ready: report.ready,
    reasons: report.reasons,
    windowHours: report.windowHours,
    outputFile
  }));
}

function buildReport({
  nowMs,
  since,
  health,
  feedRows,
  observerRows,
  orderflowRows,
  addressRows,
  requiredWindowMs,
  maxLatencyRegressionMs,
  healthStaleMs,
  minOrderflowSamples,
  minAddressSamples
}) {
  const sinceMs = Date.parse(since);
  const windowMs = Math.max(0, nowMs - sinceMs);
  const marketFeed = earliestByKey(
    feedRows.filter((row) => row.level === "shared-rpc-observer-market-trade"),
    marketTxKey,
    (row) => Date.parse(row.observedAt ?? row.at)
  );
  const addressFeed = earliestByKey(
    feedRows.filter((row) => [
      "shared-rpc-observer-address-direct",
      "shared-rpc-observer-address-transfer"
    ].includes(row.level)),
    addressTxKey,
    (row) => Date.parse(row.observedAt ?? row.at)
  );
  const orderflowExisting = earliestByKey(orderflowRows, marketTxKey, rowTimeMs);
  const addressExisting = earliestByKey(addressRows, addressTxKey, rowTimeMs);
  const orderflowComparison = compareObservationMaps(orderflowExisting, marketFeed);
  const addressComparison = compareObservationMaps(addressExisting, addressFeed);
  const duplicateObservationKeys = duplicateCount(feedRows.map((row) => row.observationKey).filter(Boolean));
  const errors = observerRows.filter((row) => row.level === "shared-rpc-observer-error");
  const marketAudits = observerRows.filter((row) => row.level === "shared-rpc-observer-market-audit");
  const marketAuditTotals = marketAudits.reduce((totals, row) => ({
    logs: totals.logs + Number(row.logs ?? 0),
    matchedWss: totals.matchedWss + Number(row.matchedWss ?? 0),
    backfilled: totals.backfilled + Number(row.missingFromWss ?? 0)
  }), { logs: 0, matchedWss: 0, backfilled: 0 });
  const healthUpdatedMs = Date.parse(health?.updatedAt ?? "");
  const healthAgeMs = Number.isFinite(healthUpdatedMs) ? Math.max(0, nowMs - healthUpdatedMs) : null;
  const reasons = [];
  if (windowMs < requiredWindowMs) reasons.push("shadow_window_incomplete");
  if (health?.status !== "running") reasons.push("observer_not_running");
  if (healthAgeMs === null || healthAgeMs > healthStaleMs) reasons.push("observer_health_stale");
  if (health?.websocket?.subscriptionsReady !== health?.websocket?.subscriptionsExpected) {
    reasons.push("websocket_subscriptions_incomplete");
  }
  if (errors.length > 0) reasons.push("observer_errors_present");
  if (duplicateObservationKeys > 0) reasons.push("duplicate_observation_keys");
  if (orderflowComparison.missing > 0) reasons.push("orderflow_observations_missing");
  if (minAddressSamples > 0 && addressComparison.missing > 0) reasons.push("address_observations_missing");
  if (orderflowComparison.matched < minOrderflowSamples) reasons.push("orderflow_samples_insufficient");
  if (minAddressSamples > 0 && addressComparison.matched < minAddressSamples) reasons.push("address_samples_insufficient");
  if (
    orderflowComparison.p95LatencyDeltaMs !== null &&
    orderflowComparison.p95LatencyDeltaMs > maxLatencyRegressionMs
  ) reasons.push("orderflow_latency_regression");
  if (
    minAddressSamples > 0 &&
    addressComparison.p95LatencyDeltaMs !== null &&
    addressComparison.p95LatencyDeltaMs > maxLatencyRegressionMs
  ) reasons.push("address_latency_regression");

  return {
    version: 1,
    mode: "shadow",
    generatedAt: new Date(nowMs).toISOString(),
    since,
    windowMs,
    windowHours: round(windowMs / 3600000, 4),
    requiredWindowMs,
    ready: reasons.length === 0,
    reasons,
    health: {
      status: health?.status ?? "missing",
      ageMs: healthAgeMs,
      cursors: health?.cursors ?? null,
      websocket: health?.websocket ?? null,
      latestRpcStats: health?.latestRpcStats ?? null
    },
    evidence: {
      observerErrors: errors.length,
      duplicateObservationKeys,
      marketAudit: marketAuditTotals,
      orderflow: orderflowComparison,
      address: addressComparison
    },
    gate: {
      maxLatencyRegressionMs,
      healthStaleMs,
      minOrderflowSamples,
      minAddressSamples,
      addressEnabled: minAddressSamples > 0
    }
  };
}

function compareObservationMaps(existing, observer) {
  const deltas = [];
  let missing = 0;
  for (const [key, existingTime] of existing) {
    const observerTime = observer.get(key);
    if (!Number.isFinite(observerTime)) {
      missing += 1;
      continue;
    }
    deltas.push(observerTime - existingTime);
  }
  return {
    existing: existing.size,
    observer: observer.size,
    matched: deltas.length,
    missing,
    p50LatencyDeltaMs: percentile(deltas, 50),
    p95LatencyDeltaMs: percentile(deltas, 95),
    maxLatencyDeltaMs: deltas.length > 0 ? Math.max(...deltas) : null
  };
}

function earliestByKey(rows, keyFn, timeFn) {
  const result = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const time = timeFn(row);
    if (!key || !Number.isFinite(time)) continue;
    if (!result.has(key) || time < result.get(key)) result.set(key, time);
  }
  return result;
}

function marketTxKey(row) {
  const market = String(row.market ?? "").toLowerCase();
  const txHash = String(row.txHash ?? "").toLowerCase();
  return market && txHash ? `${market}:${txHash}` : "";
}

function addressTxKey(row) {
  const address = String(row.address ?? "").toLowerCase();
  const txHash = String(row.txHash ?? "").toLowerCase();
  return address && txHash ? `${address}:${txHash}` : "";
}

function percentile(values, percentage) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index];
}

function duplicateCount(values) {
  const seen = new Set();
  let duplicates = 0;
  for (const value of values) {
    if (seen.has(value)) duplicates += 1;
    else seen.add(value);
  }
  return duplicates;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially written trailing line is ignored and will be retried next run.
    }
  }
  return rows;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function csvFiles(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function rowTimeMs(row) {
  return Date.parse(row.at ?? row.observedAt ?? "");
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfTest() {
  const nowMs = Date.parse("2026-07-11T12:00:00Z");
  const since = "2026-07-10T11:00:00Z";
  const market = "0x0000000000000000000000000000000000000001";
  const address = "0x0000000000000000000000000000000000000002";
  const txHash = `0x${"1".repeat(64)}`;
  const report = buildReport({
    nowMs,
    since,
    health: {
      status: "running",
      updatedAt: "2026-07-11T11:59:58Z",
      websocket: { subscriptionsReady: 2, subscriptionsExpected: 2 }
    },
    feedRows: [
      { level: "shared-rpc-observer-market-trade", market, txHash, observationKey: "market-1", observedAt: "2026-07-11T10:00:00.000Z" },
      { level: "shared-rpc-observer-address-direct", address, txHash, observationKey: "address-1", observedAt: "2026-07-11T10:00:00.100Z" }
    ],
    observerRows: [{ level: "shared-rpc-observer-market-audit", logs: 1, matchedWss: 1, missingFromWss: 0 }],
    orderflowRows: [{ level: "orderflow-trigger-sell-trade", market, txHash, at: "2026-07-11T10:00:00.200Z" }],
    addressRows: [{ level: "address-tx-watch-hit", address, txHash, at: "2026-07-11T10:00:00.300Z" }],
    requiredWindowMs: DEFAULT_REQUIRED_WINDOW_MS,
    maxLatencyRegressionMs: DEFAULT_MAX_LATENCY_REGRESSION_MS,
    healthStaleMs: DEFAULT_HEALTH_STALE_MS,
    minOrderflowSamples: 1,
    minAddressSamples: 1
  });
  assert(report.ready, "complete equivalent shadow evidence should pass the gate");
  assert(report.evidence.orderflow.p95LatencyDeltaMs === -200, "orderflow latency delta must compare first-seen times");
  assert(report.evidence.address.p95LatencyDeltaMs === -200, "address latency delta must compare first-seen times");
  const incomplete = buildReport({
    nowMs,
    since: "2026-07-11T11:30:00Z",
    health: null,
    feedRows: [],
    observerRows: [],
    orderflowRows: [],
    addressRows: [],
    requiredWindowMs: DEFAULT_REQUIRED_WINDOW_MS,
    maxLatencyRegressionMs: DEFAULT_MAX_LATENCY_REGRESSION_MS,
    healthStaleMs: DEFAULT_HEALTH_STALE_MS,
    minOrderflowSamples: 1,
    minAddressSamples: 1
  });
  assert(!incomplete.ready && incomplete.reasons.includes("shadow_window_incomplete"), "short shadow window must fail");
  const orderflowOnly = buildReport({
    nowMs,
    since,
    health: {
      status: "running",
      updatedAt: "2026-07-11T11:59:58Z",
      websocket: { subscriptionsReady: 2, subscriptionsExpected: 2 }
    },
    feedRows: [
      { level: "shared-rpc-observer-market-trade", market, txHash, observationKey: "market-1", observedAt: "2026-07-11T10:00:00.000Z" }
    ],
    observerRows: [],
    orderflowRows: [{ level: "orderflow-trigger-sell-trade", market, txHash, at: "2026-07-11T10:00:00.200Z" }],
    addressRows: [{ level: "address-tx-watch-hit", address, txHash: `0x${"2".repeat(64)}`, at: "2026-07-11T10:00:00.300Z" }],
    requiredWindowMs: DEFAULT_REQUIRED_WINDOW_MS,
    maxLatencyRegressionMs: DEFAULT_MAX_LATENCY_REGRESSION_MS,
    healthStaleMs: DEFAULT_HEALTH_STALE_MS,
    minOrderflowSamples: 1,
    minAddressSamples: 0
  });
  assert(!orderflowOnly.reasons.includes("address_observations_missing"), "orderflow-only gate must ignore paused address observations");
  assert(!orderflowOnly.reasons.includes("address_samples_insufficient"), "orderflow-only gate must not require address samples");
  console.log(JSON.stringify({ level: "shared-rpc-observer-report-self-test", status: "ok" }));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    level: "shared-rpc-observer-report-fatal",
    message: String(error?.message ?? error).slice(0, 500),
    at: new Date().toISOString()
  }));
  process.exit(1);
}
