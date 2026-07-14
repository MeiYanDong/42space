#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, getAddress, http as viemHttp } from "viem";
import { bsc } from "viem/chains";
import { loadDotEnv, normalizeRuntimeConfig, readConfig, writeRuntimeConfig } from "./config.js";
import {
  eventDisplayFilterRuleLabels,
  eventDisplayFilterRuleOptions,
  normalizeEventDisplayFilterRules
} from "./event-display-rules.js";
import { ADDRESSES, fetchActivity, fetchMarket, fetchMarkets, fetchOpenPositions } from "./fortytwo.js";
import { isSportsExactScoreMarket } from "./event-intel.js";
import {
  eventDurationMs,
  getBaseEventMarketDecision,
  getEventMarketDecision,
  getEventMarketDisplayDecision,
  isEventMarket,
  isPriceMarket
} from "./event-strategy.js";
import {
  blockMarket,
  blockMarkets,
  followMarket,
  followMarkets,
  marketFollowStatus,
  readMarketFollowState
} from "./market-follow.js";
import {
  buildGasSummary,
  gasForMarket,
  gasForOutcome,
  gasLedgerFileForConfig,
  readGasLedger
} from "./gas-ledger.js";
import { buildDashboardStrategyProfile, dashboardProfileKind } from "./dashboard-strategy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
loadDotEnv(".env.local");
loadDotEnv();

const appName = process.env.BOT_NAME ?? "42space";
const botWallet = process.env.DASHBOARD_WALLET ?? process.env.WALLET_ADDRESS ?? "";
const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
const port = Number(process.env.DASHBOARD_PORT ?? 4242);
const launchLabel = process.env.BOT_LAUNCH_LABEL ?? "com.myandong.42space-event-arm";
const systemdService = process.env.BOT_SYSTEMD_SERVICE ?? "42space-event-arm.service";
const fillsFile = path.resolve(rootDir, process.env.FILLS_FILE ?? "data/fills.jsonl");
const actionsFile = path.resolve(rootDir, process.env.DASHBOARD_ACTIONS_FILE ?? "data/dashboard-actions.jsonl");
const bot4ReadinessFile = process.env.BOT4_READINESS_FILE ?? "/opt/42space/output/bot4-readiness/latest.json";
const bot4FirstBuyEvidenceFile = process.env.BOT4_FIRST_BUY_EVIDENCE_FILE ?? "/opt/42space/output/bot4-first-buy/latest.json";
const dashboardActivitySince = process.env.DASHBOARD_ACTIVITY_SINCE ?? "";
const overviewCacheMs = Number(process.env.DASHBOARD_OVERVIEW_CACHE_MS ?? 30000);
const overviewStaleMs = Number(process.env.DASHBOARD_OVERVIEW_STALE_MS ?? 300000);
const overviewRefreshMs = Number(process.env.DASHBOARD_OVERVIEW_REFRESH_MS ?? 60000);
const overviewStartupRefresh = envBool("DASHBOARD_STARTUP_REFRESH", true);
const overviewHotPauseBeforeMs = Number(process.env.DASHBOARD_OVERVIEW_HOT_PAUSE_BEFORE_MS ?? 120000);
const overviewHotPauseAfterMs = Number(process.env.DASHBOARD_OVERVIEW_HOT_PAUSE_AFTER_MS ?? 30000);
const dashboardEventTimeoutMs = Number(process.env.DASHBOARD_EVENT_TIMEOUT_MS ?? 20000);
const dashboardChildLowPriority = envBool("DASHBOARD_CHILD_LOW_PRIORITY", true);
const dashboardChildNice = Number(process.env.DASHBOARD_CHILD_NICE ?? 10);
const aggregatePnlEnabled = envBool("DASHBOARD_AGGREGATE_PNL_ENABLED", port === 4242);
const aggregatePnlActivityLimit = Number(process.env.DASHBOARD_AGGREGATE_PNL_ACTIVITY_LIMIT ?? 5000);
const aggregatePnlPositionLimit = Number(process.env.DASHBOARD_AGGREGATE_PNL_POSITION_LIMIT ?? 500);
const aggregatePnlGasLimit = Number(process.env.DASHBOARD_AGGREGATE_PNL_GAS_LIMIT ?? 0);
const aggregatePnlDays = Number(process.env.DASHBOARD_AGGREGATE_PNL_DAYS ?? 90);
const aggregatePnlTimeZone = process.env.DASHBOARD_AGGREGATE_PNL_TIME_ZONE ?? "Asia/Shanghai";
const orderflowConfigEnabled = envBool("DASHBOARD_ORDERFLOW_CONFIG_ENABLED", port === 4242);
const plannedPriceExitPlanId = process.env.DASHBOARD_PRICE_EXIT_PLAN_ID ?? "bot4-openrouter-python-daily";
const orderflowSystemdDir = process.env.DASHBOARD_ORDERFLOW_SYSTEMD_DIR ?? "/etc/systemd/system";
const orderflowMonitorSlots = [
  {
    id: "bot1-runner-up",
    label: "Bot1 Runner-Up",
    profile: "Bot1",
    service: "42space-bot1-runner-up-orderflow-sell.service"
  },
  {
    id: "bot1-third-place",
    label: "Bot1 3rd Place",
    profile: "Bot1",
    service: "42space-bot1-third-place-orderflow-sell.service"
  },
  {
    id: "bot3-runner-up",
    label: "Bot3 Runner-Up",
    profile: "Bot3",
    service: "42space-bot3-runner-up-orderflow-sell.service"
  },
  {
    id: "bot3-third-place",
    label: "Bot3 3rd Place",
    profile: "Bot3",
    service: "42space-bot3-third-place-orderflow-sell.service"
  }
];
const watchedAddressActivityEnabled = envBool("DASHBOARD_WATCHED_ADDRESS_ACTIVITY_ENABLED", port === 4242);
const watchedAddressSystemdDir = process.env.DASHBOARD_WATCHED_ADDRESS_SYSTEMD_DIR ?? orderflowSystemdDir;
const watchedAddressLookbackMinutes = Number(process.env.DASHBOARD_WATCHED_ADDRESS_LOOKBACK_MINUTES ?? 60);
const watchedAddressBlocksPerMinute = Number(process.env.DASHBOARD_WATCHED_ADDRESS_BLOCKS_PER_MINUTE ?? 80);
const watchedAddressMaxScanBlocks = Number(process.env.DASHBOARD_WATCHED_ADDRESS_MAX_SCAN_BLOCKS ?? 9000);
const watchedAddressScanChunkBlocks = Number(process.env.DASHBOARD_WATCHED_ADDRESS_SCAN_CHUNK_BLOCKS ?? 2500);
const watchedAddressActivityLimit = Number(process.env.DASHBOARD_WATCHED_ADDRESS_ACTIVITY_LIMIT ?? 80);
const watchedAddressSlots = [
  {
    id: "0x96fde",
    label: "0x96FDe...3650",
    address: "0x96FDe227f3863812464dC1320B505016837a3650",
    service: "42space-address-tx-watch-0x96fde.service"
  },
  {
    id: "0x1bc7df",
    label: "0x1Bc7...A80b",
    address: "0x1Bc7dF2AA0DBE1a489A7205f2D1fF92C3d51A80b",
    service: "42space-address-tx-watch-0x1bc7df.service"
  },
  {
    id: "0x51349f",
    label: "0x5134...9C41",
    address: "0x51349f0B9b8C21A34781273e37F16B0233239C41",
    service: "42space-address-tx-watch-0x51349f.service"
  }
];
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC1155_TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f832d46ec942c18f8c8cf";
const ERC1155_TRANSFER_BATCH_TOPIC = "0x4a39dc06d4c0dbc64b70b45c59d4ed6409018f8cbd4a6932f3c99907335bc54";
const MARKET_TRADE_TOPIC = "0xf2e90b10bd525a6b1fe02d09e8133d3e38c9a87376ed4850904ca21e6e27abec";
const watchedAddressMarketCache = new Map();
const watchedAddressTxCache = new Map();

let overviewCache = null;
let overviewPromise = null;
let lastOverviewHotSkipLogAt = 0;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile(res, path.join(publicDir, "dashboard.html"), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/assets/")) {
      return serveStatic(res, url.pathname);
    }
    if (url.pathname === "/api/overview" && req.method === "GET") {
      return sendJson(res, await getOverview({ force: url.searchParams.get("refresh") === "1" }));
    }
    if (url.pathname === "/api/automation-status" && req.method === "GET") {
      return sendJson(res, await automationStatusPayload());
    }
    if (url.pathname === "/api/runtime-config" && req.method === "GET") {
      return sendJson(res, runtimeConfigPayload());
    }
    if (url.pathname === "/api/runtime-config" && req.method === "PUT") {
      return sendJson(res, await updateRuntimeConfig(req));
    }
    if (url.pathname === "/api/planned-price-exit" && req.method === "GET") {
      return sendJson(res, await plannedPriceExitPayload());
    }
    if (url.pathname === "/api/planned-price-exit" && req.method === "PUT") {
      return sendJson(res, await updatePlannedPriceExit(req));
    }
    if (url.pathname === "/api/orderflow-monitors" && req.method === "GET") {
      return sendJson(res, await orderflowMonitorsPayload());
    }
    if (url.pathname === "/api/orderflow-monitors" && req.method === "PUT") {
      return sendJson(res, await updateOrderflowMonitor(req));
    }
    if (url.pathname === "/api/watched-address-activity" && req.method === "GET") {
      return sendJson(res, await watchedAddressActivityPayload(url));
    }
    if (url.pathname === "/api/upcoming-markets" && req.method === "GET") {
      return sendJson(res, (await getOverview()).newMarkets);
    }
    if (url.pathname === "/api/project-holdings" && req.method === "GET") {
      return sendJson(res, (await getOverview()).projectBoard);
    }
    if (url.pathname === "/api/market-detail" && req.method === "GET") {
      return sendJson(res, await marketDetail(url));
    }
    if (url.pathname === "/api/market-follow" && req.method === "POST") {
      return sendJson(res, await updateMarketFollow(req, "follow"));
    }
    if (url.pathname === "/api/market-follow" && req.method === "DELETE") {
      return sendJson(res, await updateMarketFollow(req, "block"));
    }
    if (url.pathname === "/api/market-follow-batch" && req.method === "POST") {
      return sendJson(res, await updateMarketFollowBatch(req));
    }
    if (url.pathname === "/api/sell/quote" && req.method === "POST") {
      return sendJson(res, await sellQuote(await readJsonBody(req)));
    }
    if (url.pathname === "/api/sell/execute" && req.method === "POST") {
      return sendJson(res, await sellExecute(await readJsonBody(req)));
    }
    sendJson(res, { ok: false, message: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { ok: false, message: cleanError(error) }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`42 dashboard listening on http://${host}:${port}`);
  if (overviewStartupRefresh) {
    void refreshOverviewCache().catch(logOverviewRefreshError);
  }
  if (overviewRefreshMs > 0) {
    setInterval(() => {
      void refreshOverviewCache({ background: true }).catch(logOverviewRefreshError);
    }, overviewRefreshMs).unref();
  }
});

async function getOverview({ force = false } = {}) {
  const now = Date.now();
  if (!force && overviewCache && now - overviewCache.at < overviewCacheMs) return overviewCache.data;
  if (!force && overviewCache && overviewHotWindowInfo(overviewCache.data, now)) return overviewCache.data;
  if (!force && overviewCache && now - overviewCache.at < overviewStaleMs) {
    void refreshOverviewCache({ background: true }).catch(logOverviewRefreshError);
    return overviewCache.data;
  }
  return refreshOverviewCache();
}

function refreshOverviewCache({ background = false } = {}) {
  if (overviewPromise) return overviewPromise;
  const hotWindow = overviewCache ? overviewHotWindowInfo(overviewCache.data) : null;
  if (background && hotWindow) {
    logOverviewHotSkip(hotWindow);
    return Promise.resolve(overviewCache.data);
  }
  overviewPromise = buildOverview()
    .then((data) => {
      overviewCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      overviewPromise = null;
    });
  return overviewPromise;
}

function overviewHotWindowInfo(data, now = Date.now()) {
  const startsAt = Date.parse(data?.next?.first?.startsAt ?? "");
  if (!Number.isFinite(startsAt)) return null;
  const msUntilStart = startsAt - now;
  if (msUntilStart > overviewHotPauseBeforeMs || msUntilStart < -overviewHotPauseAfterMs) return null;
  return {
    startsAt: new Date(startsAt).toISOString(),
    msUntilStart,
    beforeMs: overviewHotPauseBeforeMs,
    afterMs: overviewHotPauseAfterMs
  };
}

function logOverviewHotSkip(info) {
  const now = Date.now();
  if (now - lastOverviewHotSkipLogAt < 60000) return;
  lastOverviewHotSkipLogAt = now;
  console.log(JSON.stringify({
    level: "dashboard-overview-refresh-skipped",
    reason: "buy-hot-window",
    startsAt: info.startsAt,
    msUntilStart: info.msUntilStart,
    at: new Date().toISOString()
  }));
}

function logOverviewRefreshError(error) {
  console.error(JSON.stringify({
    level: "warn",
    source: "dashboard-overview-refresh",
    message: cleanError(error),
    at: new Date().toISOString()
  }));
}

async function buildOverview() {
  const cfg = readConfig();
  const followState = readMarketFollowState(cfg.marketFollowFile);
  const strategyCfg = { ...cfg, marketFollowState: followState };
  const [status, bot] = await Promise.all([
    runEvent(["status", ...walletArgs()], { timeoutMs: dashboardEventTimeoutMs }),
    getBotState()
  ]);
  const [positions, walletActivity, newMarkets] = await Promise.all([
    runEvent(["positions", ...walletArgs()], { timeoutMs: dashboardEventTimeoutMs }),
    fetchUserActivity(),
    fetchNewMarketsFeed()
  ]);
  const gasSummary = buildGasSummary(readGasLedger(gasLedgerFileForConfig(cfg)));
  const holdings = normalizeHoldings(positions, walletActivity, cfg, gasSummary);
  const recentRows = readRecentActivity();
  const newMarketFeed = normalizeNewMarkets(newMarkets, status, walletActivity, recentRows, strategyCfg, followState);
  const analytics = buildAnalytics(positions, walletActivity, gasSummary);
  const aggregatePnl = await buildAggregatePnl(cfg);
  if (aggregatePnl) analytics.aggregatePnl = aggregatePnl;
  const strategyProfile = buildDashboardStrategyProfile(cfg, {
    ...status.watchConfig,
    plannedBuyPlans: readDashboardPlannedBuys(cfg)
  });
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    bot: normalizeBot(bot, status),
    wallet: normalizeWallet(status.wallet, status),
    next: normalizeNext(status),
    manualSell: manualSellState(status, cfg),
    newMarkets: newMarketFeed,
    holdings,
    projectBoard: buildProjectBoard(newMarketFeed, holdings, walletActivity, followState, cfg, gasSummary),
    analytics,
    activity: normalizeActivity(recentRows, walletActivity),
    evidence: evidenceSummary(cfg),
    settings: {
      appName,
      runtimeConfig: runtimeConfigSummary(cfg, status.watchConfig),
      ruleSummary: botRuleSummary(cfg),
      strategyProfile,
      stakeText: `${status.watchConfig?.eventOutcomeCount ?? cfg.eventOutcomeCount ?? 5} 档 / ${status.watchConfig?.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt ?? 5}U`,
      windowText: broadcastWindowText(status.watchConfig, cfg),
      autoSellText: strategyProfile.sellSummary
    }
  };
}

async function automationStatusPayload() {
  const cfg = readConfig();
  const worker = await getBotState();
  const health = safeReadJson(cfg.runtimeHealthFile);
  const now = Date.now();
  const heartbeatAt = health?.updatedAt ?? health?.buy?.lastHeartbeatAt ?? null;
  const heartbeatMs = Date.parse(heartbeatAt ?? "");
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Math.max(0, now - heartbeatMs) : null;
  const staleAfterMs = Math.max(10000, Number(process.env.EVENT_RUNTIME_HEALTH_STALE_MS ?? 20000));
  const pidMatches = runtimePidBelongsToWorker(worker, health?.pid);
  const heartbeatFresh = Boolean(
    worker.running &&
    pidMatches &&
    heartbeatAgeMs !== null &&
    heartbeatAgeMs <= staleAfterMs
  );
  const activity = readRecentActivity();
  const lastBuy = latestAutomationActivity(activity, (row) => ["买入成功", "等待确认", "买入失败"].includes(row.label));
  const lastSell = latestAutomationActivity(activity, (row) => row.label === "自动卖出");
  const circuit = safeReadJson(cfg.autoSellCircuitStateFile);
  const circuitPausedUntilMs = Date.parse(circuit?.pausedUntil ?? "");
  const circuitOpen = Number.isFinite(circuitPausedUntilMs) && circuitPausedUntilMs > now;
  const live = Boolean(!cfg.dryRun && cfg.execute !== false);
  const buyPolicy = health?.buy?.policy ?? dashboardBuyPolicy(cfg);

  return {
    ok: true,
    updatedAt: new Date(now).toISOString(),
    heartbeat: {
      at: heartbeatAt,
      ageMs: heartbeatAgeMs,
      fresh: heartbeatFresh,
      staleAfterMs,
      pidMatches
    },
    worker: automationWorkerStatus(worker, { heartbeatFresh, heartbeatAt, heartbeatAgeMs, pidMatches }),
    buy: automationBuyStatus(cfg, health?.buy, {
      live,
      worker,
      heartbeatFresh,
      heartbeatAt,
      heartbeatAgeMs,
      buyPolicy,
      lastAction: lastBuy
    }),
    sell: automationSellStatus(cfg, health?.sell, {
      worker,
      heartbeatFresh,
      heartbeatAt,
      heartbeatAgeMs,
      circuitOpen,
      circuitPausedUntil: circuitOpen ? circuit.pausedUntil : null,
      lastAction: lastSell
    })
  };
}

function automationWorkerStatus(worker, context) {
  const healthy = Boolean(worker.running && context.heartbeatFresh);
  const label = !worker.running
    ? "服务停止"
    : context.heartbeatFresh
      ? "运行中"
      : context.pidMatches
        ? "心跳超时"
        : "进程已更换";
  return {
    ...worker,
    healthy,
    label,
    tone: healthy ? "good" : "bad",
    heartbeatAt: context.heartbeatAt,
    heartbeatAgeMs: context.heartbeatAgeMs
  };
}

function runtimePidBelongsToWorker(worker, runtimePid) {
  const pid = Number(runtimePid ?? 0);
  if (!worker.pid || !pid) return true;
  if (Number(worker.pid) === pid) return true;
  if (!worker.controlGroup || process.platform === "darwin") return true;
  try {
    const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    return cgroup.split(/\r?\n/).some((line) => {
      const current = line.split(":").slice(2).join(":");
      return current === worker.controlGroup || current.startsWith(`${worker.controlGroup}/`);
    });
  } catch {
    return false;
  }
}

function automationBuyStatus(cfg, buy = {}, context = {}) {
  const enabled = Boolean(context.live && buy.enabled !== false);
  const state = String(buy.state ?? "starting");
  const pendingCount = Math.max(0, Number(buy.pendingCount ?? 0));
  const preparedCount = Math.max(0, Number(buy.preparedCount ?? 0));
  const running = Boolean(enabled && context.worker?.running && context.heartbeatFresh);
  let label = "已关闭";
  let tone = "neutral";
  if (enabled && !context.worker?.running) {
    label = "服务停止";
    tone = "bad";
  } else if (enabled && !context.heartbeatFresh) {
    label = "心跳超时";
    tone = "bad";
  } else if (running && state === "executing") {
    label = "正在执行";
    tone = "warn";
  } else if (running && pendingCount > 0) {
    label = `已准备 ${preparedCount}/${pendingCount} 场`;
    tone = "good";
  } else if (running) {
    label = "运行中 · 等待新盘";
    tone = "good";
  }
  return {
    enabled,
    running,
    state,
    label,
    tone,
    policy: context.buyPolicy,
    policyLabel: dashboardBuyPolicyLabel(context.buyPolicy, cfg),
    pendingCount,
    preparedCount,
    heartbeatAt: buy.lastHeartbeatAt ?? context.heartbeatAt,
    lastAction: context.lastAction
  };
}

function automationSellStatus(cfg, sell = {}, context = {}) {
  const enabled = Boolean(cfg.autoSellEnabled && sell.enabled !== false);
  const state = String(sell.state ?? (enabled ? "starting" : "disabled"));
  const hasTickError = state === "error" || state === "degraded" || Number(sell.errors ?? 0) > 0;
  const guarded = state === "guarded" || ["open-buy-window", "buy-hot-window", "transaction-busy"].includes(sell.skippedReason);
  const running = Boolean(enabled && context.worker?.running && context.heartbeatFresh && !context.circuitOpen && !hasTickError);
  let label = "已关闭";
  let tone = "neutral";
  if (enabled && !context.worker?.running) {
    label = "服务停止";
    tone = "bad";
  } else if (enabled && !context.heartbeatFresh) {
    label = "心跳超时";
    tone = "bad";
  } else if (context.circuitOpen || state === "paused") {
    label = "熔断暂停";
    tone = "bad";
  } else if (hasTickError) {
    label = state === "degraded" ? "接口异常 · 自动重试" : "扫描异常";
    tone = "bad";
  } else if (guarded) {
    label = "买入保护中 · 自动恢复";
    tone = "warn";
  } else if (state === "checking") {
    label = "正在扫描";
    tone = "warn";
  } else if (enabled) {
    label = "运行中";
    tone = "good";
  }
  return {
    enabled,
    running,
    state,
    label,
    tone,
    strategy: cfg.autoSellStrategy,
    strategyLabel: dashboardSellStrategyLabel(cfg),
    pollMs: Number(cfg.autoSellPollMs ?? 0),
    lastTickStartedAt: sell.lastTickStartedAt ?? null,
    lastTickCompletedAt: sell.lastTickCompletedAt ?? null,
    lastSuccessfulScanAt: sell.lastSuccessfulScanAt ?? null,
    checked: Number(sell.checked ?? 0),
    triggered: Number(sell.triggered ?? 0),
    executed: Number(sell.executed ?? 0),
    errors: Number(sell.errors ?? 0),
    skippedReason: sell.skippedReason ?? null,
    guardUntil: sell.guardUntil ?? null,
    lastErrorAt: sell.lastErrorAt ?? null,
    lastError: sell.lastError ?? null,
    circuitPausedUntil: context.circuitPausedUntil,
    lastAction: context.lastAction
  };
}

function dashboardBuyPolicy(cfg) {
  const kind = dashboardProfileKind(cfg);
  const role = String(cfg.profileRole ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
  if (Boolean(cfg.bot3FifaExactScoreAutoBuyEnabled) && (kind === "bot3" || role === "bot3_like")) {
    return "fifa_exact_score_lowest_price_tier";
  }
  if (String(cfg.eventIntelBuyFilter ?? "").trim().toLowerCase() === "strong") return "meme_binance_strong";
  return "planned_or_manual_follow";
}

function dashboardBuyPolicyLabel(policy, cfg) {
  if (policy === "fifa_exact_score_lowest_price_tier") {
    return `精确比分最低胜方档 · 5项 x ${Number(cfg.bot3FifaExactScoreAutoStakeUsdt ?? 0)}U`;
  }
  if (policy === "meme_binance_strong") return "Meme / Binance strong 自动关注";
  return "planned-buy / 手动关注";
}

function dashboardSellStrategyLabel(cfg) {
  if (!cfg.autoSellEnabled) return "自动卖出关闭";
  if (cfg.autoSellStrategy === "pre_start_exit") {
    const hours = Number(cfg.autoSellBeforeMarketStartSeconds ?? 0) / 3600;
    return `比赛前 ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h 自动卖出`;
  }
  if (cfg.autoSellStrategy === "open_timed_exit") return `开盘后 ${Number(cfg.autoSellOpenExitDelaySeconds ?? 0)}s 自动卖出`;
  if (cfg.autoSellStrategy === "ladder") return "阶梯自动卖出";
  return "自动卖出监控";
}

function latestAutomationActivity(rows, predicate) {
  const row = rows.find(predicate);
  if (!row) return null;
  return {
    at: row.at,
    label: row.label,
    title: row.title,
    tx: row.tx ?? null,
    amount: row.amount ?? ""
  };
}

function evidenceSummary(cfg) {
  if (dashboardProfileKind(cfg) !== "bot4") {
    return { readiness: null, firstBuy: null };
  }
  const readiness = safeReadJson(bot4ReadinessFile);
  const firstBuy = safeReadJson(bot4FirstBuyEvidenceFile);
  return {
    readiness: readiness ? {
      ok: readiness.ok === true,
      phase: readiness.phase ?? null,
      generatedAt: readiness.generatedAt ?? null,
      failedCount: Array.isArray(readiness.failed) ? readiness.failed.length : null,
      autoSellMonitorStarted: Boolean(readiness.summary?.autoSellMonitorStarted),
      walletReady: Boolean(readiness.summary?.walletReady),
      nextBatchStartDate: readiness.summary?.nextBatchStartDate ?? null
    } : null,
    firstBuy: firstBuy ? {
      conclusion: firstBuy.conclusion ?? null,
      generatedAt: firstBuy.generatedAt ?? null,
      expectedBroadcastIso: firstBuy.target?.expectedBroadcastIso ?? null,
      latestAllowedBroadcastStartIso: firstBuy.target?.latestAllowedBroadcastStartIso ?? null,
      checks: pickEvidenceChecks(firstBuy.checks),
      txCount: Array.isArray(firstBuy.txHashes) ? firstBuy.txHashes.length : 0,
      broadcastTimings: Array.isArray(firstBuy.broadcastTimings)
        ? firstBuy.broadcastTimings.map(summarizeBroadcastTiming).filter(Boolean).slice(-3)
        : []
    } : null
  };
}

function pickEvidenceChecks(checks = {}) {
  return {
    botRunning: Boolean(checks.botRunning),
    nextBatchKnown: Boolean(checks.nextBatchKnown),
    scheduledOnTime: Boolean(checks.scheduledOnTime),
    preSigned: Boolean(checks.preSigned),
    broadcasted: Boolean(checks.broadcasted),
    broadcastStartedBefore20s: Boolean(checks.broadcastStartedBefore20s),
    firstAcceptedRpc: Boolean(checks.firstAcceptedRpc),
    outcomeOk: Boolean(checks.outcomeOk),
    receiptSuccess: Boolean(checks.receiptSuccess),
    autoSellMonitorStarted: Boolean(checks.autoSellMonitorStarted),
    stopLossConfigured: Boolean(checks.stopLossConfigured),
    noUnintendedBuys: Boolean(checks.noUnintendedBuys)
  };
}

function summarizeBroadcastTiming(item) {
  if (!item || typeof item !== "object") return null;
  return {
    status: item.status ?? null,
    broadcastMode: item.broadcastMode ?? null,
    broadcastStartedAt: item.broadcastStartedAt ?? null,
    firstAcceptedAt: item.firstAcceptedAt ?? null,
    broadcastStartDelayMs: item.broadcastStartDelayMs ?? null,
    firstAcceptedDelayMs: item.firstAcceptedDelayMs ?? null,
    firstAcceptedLatencyMs: item.firstAcceptedLatencyMs ?? null,
    broadcastStartedBefore20s: Boolean(item.broadcastStartedBefore20s)
  };
}

function runtimeConfigPayload() {
  const cfg = readConfig();
  return {
    ok: true,
    config: runtimeConfigSummary(cfg, null),
    editable: {
      filterModes: [
        { value: "price_only_test", label: "买入门槛：基础 Price/8hour 排除" },
        { value: "production", label: "买入门槛：基础排除 + 时长门槛" }
      ],
      displayFilterRules: eventDisplayFilterRuleOptions(),
      limits: {
        eventOutcomeCount: { min: 1, max: 12, step: 1 },
        stakePerOutcomeUsdt: { min: 0.1, max: 100, step: 0.1 },
        maxBatchStakeUsdt: { min: 0.1, max: 5000, step: 0.1 },
        gasPriceGwei: { min: 0.01, max: 50, step: 0.01 },
        autoSellStartDelaySeconds: { min: 0, max: 3600, step: 1 },
        autoSellIntervalSeconds: { min: 1, max: 3600, step: 1 },
        autoSellChunkPercent: { min: 0.1, max: 100, step: 0.1 },
        autoSellStopLossPercent: { min: 0.1, max: 100, step: 0.1 },
        autoSellStopLossSellPercent: { min: 0.1, max: 100, step: 0.1 }
      }
    },
    writeProtected: Boolean(process.env.DASHBOARD_ADMIN_TOKEN)
  };
}

function runtimeConfigSummary(cfg, watchConfig) {
  return {
    filterMode: watchConfig?.filterMode ?? cfg.filterMode ?? "production",
    eventOutcomeCount: Number(watchConfig?.eventOutcomeCount ?? cfg.eventOutcomeCount),
    stakePerOutcomeUsdt: Number(watchConfig?.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt),
    maxMarketStakeUsdt: Number(watchConfig?.maxMarketStakeUsdt ?? cfg.maxMarketStakeUsdt),
    maxBatchStakeUsdt: Number(watchConfig?.maxBatchStakeUsdt ?? cfg.maxBatchStakeUsdt),
    minEventDurationHours: Number(watchConfig?.minEventDurationHours ?? cfg.minEventDurationHours),
    gasPriceGwei: String(watchConfig?.gasPriceGwei ?? cfg.gasPriceGwei),
    autoSellEnabled: Boolean(watchConfig?.autoSellEnabled ?? cfg.autoSellEnabled),
    autoSellStrategy: String(watchConfig?.autoSellStrategy ?? cfg.autoSellStrategy),
    autoSellStartDelaySeconds: Number(watchConfig?.autoSellStartDelaySeconds ?? cfg.autoSellStartDelaySeconds),
    autoSellIntervalSeconds: Number(watchConfig?.autoSellIntervalSeconds ?? cfg.autoSellIntervalSeconds),
    autoSellChunkPercent: Number(watchConfig?.autoSellChunkPercent ?? cfg.autoSellChunkPercent),
    autoSellLadderProfitPercent: Number(watchConfig?.autoSellLadderProfitPercent ?? cfg.autoSellLadderProfitPercent ?? 0),
    autoSellOpenExitDelaySeconds: Number(watchConfig?.autoSellOpenExitDelaySeconds ?? cfg.autoSellOpenExitDelaySeconds ?? 36),
    autoSellOpenExitPercent: Number(watchConfig?.autoSellOpenExitPercent ?? cfg.autoSellOpenExitPercent ?? 100),
    autoSellFastOpenExitEnabled: Boolean(watchConfig?.autoSellFastOpenExitEnabled ?? cfg.autoSellFastOpenExitEnabled),
    autoSellFastOpenExitMinDelayMs: Number(watchConfig?.autoSellFastOpenExitMinDelayMs ?? cfg.autoSellFastOpenExitMinDelayMs ?? 0),
    autoSellFastOpenExitMaxDelayMs: Number(watchConfig?.autoSellFastOpenExitMaxDelayMs ?? cfg.autoSellFastOpenExitMaxDelayMs ?? 0),
    autoSellTakeProfitSteps: Number(watchConfig?.autoSellTakeProfitSteps ?? cfg.autoSellTakeProfitSteps ?? 0),
    autoSellBeforeMarketStartSeconds: Number(watchConfig?.autoSellBeforeMarketStartSeconds ?? cfg.autoSellBeforeMarketStartSeconds ?? 0),
    autoSellMarketStartEndOffsetSeconds: Number(watchConfig?.autoSellMarketStartEndOffsetSeconds ?? cfg.autoSellMarketStartEndOffsetSeconds ?? 0),
    autoSellGasPriceGwei: String(watchConfig?.autoSellGasPriceGwei ?? cfg.autoSellGasPriceGwei ?? ""),
    autoSellStopLossEnabled: Boolean(watchConfig?.autoSellStopLossEnabled ?? cfg.autoSellStopLossEnabled),
    autoSellStopLossPercent: Number(watchConfig?.autoSellStopLossPercent ?? cfg.autoSellStopLossPercent),
    autoSellStopLossSellPercent: Number(watchConfig?.autoSellStopLossSellPercent ?? cfg.autoSellStopLossSellPercent),
    eventDisplayFilterRules: normalizeEventDisplayFilterRules(
      watchConfig?.eventDisplayFilterRules ?? cfg.eventDisplayFilterRules
    ),
    eventDisplayIncludeRules: normalizeEventDisplayFilterRules(
      watchConfig?.eventDisplayIncludeRules ?? cfg.eventDisplayIncludeRules,
      { fallback: [] }
    ),
    eventDisplayFilterRuleOptions: eventDisplayFilterRuleOptions(),
    marketCategoryBlocklist: cfg.marketCategoryBlocklist ?? [],
    marketTagBlocklist: cfg.marketTagBlocklist ?? [],
    runtimeConfigFile: cfg.runtimeConfigFile,
    marketFollowFile: cfg.marketFollowFile
  };
}

function botRuleSummary(cfg) {
  const profileKind = dashboardProfileKind(cfg);
  const isBot2 = profileKind === "bot2";
  const isBot3 = profileKind === "bot3";
  const isBot3Like = isBot3 || String(cfg?.profileRole ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_") === "bot3_like";
  const isBot4 = profileKind === "bot4";
  const isBot5 = profileKind === "bot5";
  const isBot2Like = isBot2 || isBot5;
  const focusBuyEnabled = String(cfg?.eventIntelBuyFilter ?? "off").trim().toLowerCase() === "strong";
  const buyQuestionAllowlistEnabled = Boolean(cfg?.marketBuyQuestionAllowlistRegex);
  const enabledIncludeLabels = eventDisplayFilterRuleLabels(cfg?.eventDisplayIncludeRules ?? []);
  const enabledFilterLabels = eventDisplayFilterRuleLabels(cfg?.eventDisplayFilterRules ?? []);
  const filterRule = enabledIncludeLabels.length
    ? `当前只显示：${enabledIncludeLabels.join("、")}`
    : enabledFilterLabels.length
      ? `当前过滤：${enabledFilterLabels.join("、")}`
      : "当前未启用显示过滤：所有监控到且数据完整的 live/not_started 事件都会显示";
  const displayRule = enabledIncludeLabels.length
    ? "默认显示并通知：只展示命中显示白名单且数据完整的 live/not_started 事件"
    : "默认显示并通知：除上述过滤外的所有 live/not_started 事件；Meme、Binance strong、准确比分、球员表现会重点标记";
  const followRule = isBot3Like && Boolean(cfg?.bot3FifaExactScoreAutoBuyEnabled)
    ? "默认关注：仅 FIFA/Sports 精确比分最低胜方价格档自动买入；平局和边盘不买；planned-buy 优先"
    : buyQuestionAllowlistEnabled
    ? isBot4
      ? "默认关注：仅命中 Bot4 买入题目白名单的日常模板符合买入；其他日常模板只展示/通知，不买入"
      : "默认关注：买入题目白名单是硬边界；未命中的显示事件只展示/通知，不买入"
    : focusBuyEnabled
      ? "默认关注：仅 Meme 和 Binance strong；其他显示事件需手动关注或 planned buy 才买入"
      : "默认关注：未启用 Meme/Binance strong 默认关注；显示事件需手动关注或 planned buy 才买入";
  return {
    profile: cfg?.botName ?? appName,
    filterRule,
    displayRule,
    followRule,
    notificationRule: isBot4
      ? "Bot4 飞书通知：命中日常模板显示白名单的新事件；买入仍受 Bot4 买入题目白名单限制"
      : isBot2Like || isBot3Like
      ? `${isBot3Like ? (isBot3 ? "Bot3" : "Bot1") : isBot5 ? "Bot5" : "Bot2"} 飞书通知：所有未被基础过滤的新事件；过滤项不通知`
      : "飞书通知按当前 profile 配置执行"
  };
}

async function updateRuntimeConfig(req) {
  const body = await readJsonBody(req);
  requireAdminToken(req, body);
  const cfg = readConfig();
  const isProduction = body.filterMode === "production";
  const input = {
    filterMode: body.filterMode,
    eventOutcomeCount: body.eventOutcomeCount,
    stakePerOutcomeUsdt: body.stakePerOutcomeUsdt,
    maxBatchStakeUsdt: body.maxBatchStakeUsdt,
    gasPriceGwei: body.gasPriceGwei,
    autoSellGasPriceGwei: body.autoSellGasPriceGwei !== undefined
      ? body.autoSellGasPriceGwei
      : cfg.autoSellGasPriceGwei,
    autoSellEnabled: body.autoSellEnabled,
    autoSellStrategy: body.autoSellStrategy !== undefined
      ? body.autoSellStrategy
      : cfg.autoSellStrategy,
    autoSellStartDelaySeconds: body.autoSellStartDelaySeconds,
    autoSellIntervalSeconds: body.autoSellIntervalSeconds,
    autoSellChunkPercent: body.autoSellChunkPercent,
    autoSellLadderProfitPercent: body.autoSellLadderProfitPercent !== undefined
      ? body.autoSellLadderProfitPercent
      : cfg.autoSellLadderProfitPercent,
    autoSellOpenExitDelaySeconds: body.autoSellOpenExitDelaySeconds !== undefined
      ? body.autoSellOpenExitDelaySeconds
      : cfg.autoSellOpenExitDelaySeconds,
    autoSellOpenExitPercent: body.autoSellOpenExitPercent !== undefined
      ? body.autoSellOpenExitPercent
      : cfg.autoSellOpenExitPercent,
    autoSellTakeProfitSteps: body.autoSellTakeProfitSteps !== undefined
      ? body.autoSellTakeProfitSteps
      : cfg.autoSellTakeProfitSteps,
    autoSellBeforeMarketStartSeconds: body.autoSellBeforeMarketStartSeconds !== undefined
      ? body.autoSellBeforeMarketStartSeconds
      : cfg.autoSellBeforeMarketStartSeconds,
    autoSellMarketStartEndOffsetSeconds: body.autoSellMarketStartEndOffsetSeconds !== undefined
      ? body.autoSellMarketStartEndOffsetSeconds
      : cfg.autoSellMarketStartEndOffsetSeconds,
    autoSellStopLossEnabled: body.autoSellStopLossEnabled,
    autoSellStopLossPercent: body.autoSellStopLossPercent,
    autoSellStopLossSellPercent: body.autoSellStopLossSellPercent,
    eventDisplayFilterRules: Array.isArray(body.eventDisplayFilterRules)
      ? body.eventDisplayFilterRules
      : cfg.eventDisplayFilterRules,
    eventDisplayIncludeRules: Array.isArray(body.eventDisplayIncludeRules)
      ? body.eventDisplayIncludeRules
      : (cfg.eventDisplayIncludeRules ?? []),
    minEventDurationHours: isProduction ? (body.minEventDurationHours ?? 48) : 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: isProduction ? ["8 hour", "automated"] : ["Price"]
  };
  input.maxMarketStakeUsdt = roundMoney(Number(input.eventOutcomeCount) * Number(input.stakePerOutcomeUsdt));
  const config = normalizeRuntimeConfig(input, { partial: false });
  writeRuntimeConfig(cfg.runtimeConfigFile, config);
  const restarted = await restartWorker();
  overviewCache = null;
  return {
    ok: true,
    config,
    restarted,
    message: restarted ? "配置已保存，worker 已重启" : "配置已保存"
  };
}

async function plannedPriceExitPayload() {
  const cfg = readConfig();
  if (dashboardProfileKind(cfg) !== "bot4") {
    return {
      ok: true,
      enabled: false,
      plan: null,
      outcomes: [],
      targets: [],
      writeProtected: Boolean(process.env.DASHBOARD_ADMIN_TOKEN)
    };
  }

  const document = readPlannedBuysDocument(cfg.eventPlannedBuysFile);
  const plan = findRawPlannedBuy(document.rows, plannedPriceExitPlanId);
  if (!plan) {
    return {
      ok: true,
      enabled: false,
      plan: null,
      outcomes: [],
      targets: [],
      message: `未找到计划 ${plannedPriceExitPlanId}`,
      writeProtected: Boolean(process.env.DASHBOARD_ADMIN_TOKEN)
    };
  }

  const normalizedPlan = normalizeDashboardPlannedBuy(plan);
  const autoSell = plan.autoSell && typeof plan.autoSell === "object" && !Array.isArray(plan.autoSell)
    ? plan.autoSell
    : {};
  const targets = normalizeDashboardPriceTargets(autoSell.priceTargets, normalizedPlan?.outcomes ?? []);
  let openPositions = [];
  let positionError = null;
  try {
    openPositions = await fetchOpenPositions(cfg, { user: botWallet || cfg.walletAddress, limit: 500 });
  } catch (error) {
    positionError = cleanError(error);
  }
  const matchingPositions = openPositions
    .filter((position) => dashboardPlannedBuyMatches(normalizedPlan, {
      address: position.marketAddress,
      question: position.question?.title
    }))
    .sort((a, b) => safeTime(b.market?.startDate ?? b.question?.startDate) - safeTime(a.market?.startDate ?? a.question?.startDate));
  const enrichedTargets = targets.map((target) => {
    const position = matchingPositions.find((item) => normQuestion(item.outcome?.name) === normQuestion(target.outcome));
    const currentPrice = position ? normalizeDashboardPositiveNumber(position.curPrice) : null;
    return {
      ...target,
      currentPrice,
      reached: Boolean(target.enabled && currentPrice !== null && currentPrice >= Number(target.price)),
      market: position?.marketAddress ?? null,
      question: position?.question?.title ?? null
    };
  });

  return {
    ok: true,
    enabled: true,
    plan: {
      id: String(plan.id ?? plannedPriceExitPlanId),
      label: "OpenRouter Python",
      enabled: plan.enabled !== false && plan.disabled !== true
    },
    outcomes: normalizedPlan?.outcomes ?? [],
    targets: enrichedTargets,
    priceSource: "42 REST positions.curPrice",
    priceHotPollMs: normalizeDashboardPositiveNumber(autoSell.priceHotPollMs) ?? 1000,
    priceHotWindowSeconds: normalizeDashboardPositiveNumber(autoSell.priceHotWindowSeconds) ?? 600,
    normalPollMs: Number(cfg.autoSellPollMs ?? 60000),
    sellPercent: normalizeDashboardPositiveNumber(autoSell.priceSellPercent) ?? 100,
    applyToExisting: !normalizeDashboardDate(autoSell.priceApplyAfterIso),
    priceApplyAfterIso: normalizeDashboardDate(autoSell.priceApplyAfterIso),
    positionError,
    writeProtected: Boolean(process.env.DASHBOARD_ADMIN_TOKEN)
  };
}

async function updatePlannedPriceExit(req) {
  const body = await readJsonBody(req);
  requireAdminToken(req, body);
  const cfg = readConfig();
  if (dashboardProfileKind(cfg) !== "bot4") throw new Error("Price exit editing is only enabled for Bot4");

  const document = readPlannedBuysDocument(cfg.eventPlannedBuysFile);
  const planId = String(body.planId ?? plannedPriceExitPlanId).trim();
  const plan = findRawPlannedBuy(document.rows, planId);
  if (!plan) throw new Error(`Planned buy not found: ${planId}`);
  const normalizedPlan = normalizeDashboardPlannedBuy(plan);
  const selectedByKey = new Map((normalizedPlan?.outcomes ?? []).map((outcome) => [normQuestion(outcome), outcome]));
  const rows = Array.isArray(body.targets) ? body.targets : [];
  if (rows.length > 24) throw new Error("Too many price targets");
  const seen = new Set();
  const targets = rows.map((row, index) => {
    const key = normQuestion(row?.outcome);
    if (!key) throw new Error(`Price target ${index + 1} is missing an outcome`);
    if (seen.has(key)) throw new Error(`Duplicate price target outcome: ${row.outcome}`);
    const selectedOutcome = selectedByKey.get(key);
    if (!selectedOutcome) throw new Error(`Price target outcome is not selected by the planned buy: ${row.outcome}`);
    const price = normalizeDashboardPriceValue(row?.price);
    seen.add(key);
    return {
      outcome: selectedOutcome,
      price,
      enabled: row?.enabled !== false
    };
  });

  const priorAutoSell = plan.autoSell && typeof plan.autoSell === "object" && !Array.isArray(plan.autoSell)
    ? plan.autoSell
    : {};
  const autoSell = {
    ...priorAutoSell,
    priceTargets: targets,
    priceHotPollMs: 1000,
    priceHotWindowSeconds: 600,
    priceSellPercent: 100,
    stopLossEnabled: false
  };
  for (const key of ["ladderProfitPercent", "profitPercent", "chunkPercent", "takeProfitSteps", "startDelaySeconds", "intervalSeconds"]) {
    delete autoSell[key];
  }
  if (body.applyToExisting === true) {
    delete autoSell.priceApplyAfterIso;
  } else if (!normalizeDashboardDate(autoSell.priceApplyAfterIso)) {
    autoSell.priceApplyAfterIso = new Date().toISOString();
  }
  plan.autoSell = autoSell;
  writePlannedBuysDocument(cfg.eventPlannedBuysFile, document);
  const restarted = await restartWorker();
  overviewCache = null;
  const payload = await plannedPriceExitPayload();
  return {
    ...payload,
    restarted,
    message: restarted ? "价格卖出配置已保存，worker 已重启" : "价格卖出配置已保存"
  };
}

function readPlannedBuysDocument(file) {
  if (!file || !fs.existsSync(file)) throw new Error("Planned buys file not found");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(value)) return { value, rows: value, wrapped: false };
  if (value && typeof value === "object" && Array.isArray(value.plans)) {
    return { value, rows: value.plans, wrapped: true };
  }
  throw new Error("Planned buys file must be an array or contain plans[]");
}

function writePlannedBuysDocument(file, document) {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${file}.bak-dashboard-price-exit`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, mode);
  fs.writeFileSync(tmp, `${JSON.stringify(document.value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function findRawPlannedBuy(rows, id) {
  return rows.find((row) => String(row?.id ?? "").trim() === String(id ?? "").trim()) ?? null;
}

function normalizeDashboardPriceTargets(value, selectedOutcomes = []) {
  if (value === undefined || value === null || value === "") return [];
  const rows = Array.isArray(value)
    ? value
    : Object.entries(value).map(([outcome, item]) => (
        item && typeof item === "object" && !Array.isArray(item)
          ? { outcome, ...item }
          : { outcome, price: item }
      ));
  const selectedByKey = new Map(selectedOutcomes.map((outcome) => [normQuestion(outcome), outcome]));
  const seen = new Set();
  return rows.map((row) => {
    const key = normQuestion(row?.outcome ?? row?.name);
    const outcome = selectedByKey.get(key) ?? String(row?.outcome ?? row?.name ?? "").trim();
    const price = normalizeDashboardPriceValue(row?.price ?? row?.threshold ?? row?.targetPrice);
    if (!outcome || seen.has(key)) return null;
    seen.add(key);
    return { outcome, price, enabled: row?.enabled !== false };
  }).filter(Boolean);
}

function normalizeDashboardPriceValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) throw new Error("Price target must be > 0 and <= 1");
  return number.toFixed(18).replace(/0+$/u, "").replace(/\.$/u, "");
}

async function orderflowMonitorsPayload() {
  if (!orderflowConfigEnabled) {
    return {
      ok: true,
      enabled: false,
      monitors: [],
      writeProtected: Boolean(process.env.DASHBOARD_ADMIN_TOKEN)
    };
  }
  const monitors = await Promise.all(orderflowMonitorSlots.map(readOrderflowMonitor));
  return {
    ok: true,
    enabled: true,
    monitors,
    writeProtected: Boolean(process.env.DASHBOARD_ADMIN_TOKEN)
  };
}

async function updateOrderflowMonitor(req) {
  if (!orderflowConfigEnabled) throw new Error("Orderflow config is disabled");
  const body = await readJsonBody(req);
  requireAdminToken(req, body);
  const slot = orderflowMonitorSlots.find((item) => item.id === body.id);
  if (!slot) throw new Error("Unknown orderflow monitor");
  const unitPath = orderflowUnitPath(slot.service);
  if (!unitPath || !fs.existsSync(unitPath)) throw new Error("Orderflow service file not found");

  const text = fs.readFileSync(unitPath, "utf8");
  const env = parseSystemdEnvironment(text);
  const market = normalizeOrderflowMarket(body.market ?? env.ORDERFLOW_TRIGGER_MARKET);
  const thresholdUsdt = normalizeOrderflowThreshold(body.thresholdUsdt ?? env.ORDERFLOW_TRIGGER_THRESHOLD_USDT);
  const tokenIds = normalizeOrderflowTokenIds(
    body.tokenIds !== undefined ? body.tokenIds : env.ORDERFLOW_TRIGGER_TOKEN_IDS
  );
  const watchCurrentPositions = normalizeOrderflowBoolean(
    body.watchCurrentPositions !== undefined
      ? body.watchCurrentPositions
      : env.ORDERFLOW_TRIGGER_WATCH_CURRENT_POSITIONS,
    false
  );
  if (tokenIds.length === 0 && !watchCurrentPositions) {
    throw new Error("Token IDs are required when current-position watch is disabled");
  }

  const nextText = [
    ["ORDERFLOW_TRIGGER_MARKET", market],
    ["ORDERFLOW_TRIGGER_THRESHOLD_USDT", String(thresholdUsdt)],
    ["ORDERFLOW_TRIGGER_TOKEN_IDS", tokenIds.join(",")],
    ["ORDERFLOW_TRIGGER_WATCH_CURRENT_POSITIONS", watchCurrentPositions ? "1" : "0"]
  ].reduce((acc, [key, value]) => setSystemdEnvironment(acc, key, value), text);

  if (nextText !== text) {
    const backup = `${unitPath}.bak-dashboard-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(unitPath, backup);
    fs.writeFileSync(unitPath, nextText);
  }
  const restarted = await restartOrderflowMonitor(slot);
  appendJsonl(actionsFile, {
    type: "orderflow-monitor-config",
    source: "dashboard",
    service: slot.service,
    monitorId: slot.id,
    market,
    thresholdUsdt,
    tokenIds,
    watchCurrentPositions,
    restarted,
    at: new Date().toISOString()
  });
  const monitor = await readOrderflowMonitor(slot);
  return {
    ok: true,
    monitor,
    restarted,
    message: restarted ? "监控配置已保存并重启" : "监控配置已保存"
  };
}

async function readOrderflowMonitor(slot) {
  const unitPath = orderflowUnitPath(slot.service);
  const unitExists = Boolean(unitPath && fs.existsSync(unitPath));
  const text = unitExists ? fs.readFileSync(unitPath, "utf8") : "";
  const env = parseSystemdEnvironment(text);
  const stateFile = env.ORDERFLOW_TRIGGER_STATE_FILE ?? "";
  const logFile = env.ORDERFLOW_TRIGGER_LOG_FILE ?? "";
  const state = safeReadJson(stateFile) ?? {};
  const latestStarted = latestOrderflowStarted(logFile);
  const serviceState = await orderflowServiceState(slot.service);
  return {
    id: slot.id,
    label: slot.label,
    profile: slot.profile,
    service: slot.service,
    unitPath: unitPath ?? null,
    unitExists,
    running: serviceState.running,
    activeState: serviceState.activeState,
    subState: serviceState.subState,
    restarts: serviceState.restarts,
    market: env.ORDERFLOW_TRIGGER_MARKET ?? "",
    tokenIds: parseOrderflowTokenIds(env.ORDERFLOW_TRIGGER_TOKEN_IDS),
    watchCurrentPositions: normalizeOrderflowBoolean(env.ORDERFLOW_TRIGGER_WATCH_CURRENT_POSITIONS, false),
    thresholdUsdt: Number(env.ORDERFLOW_TRIGGER_THRESHOLD_USDT ?? 0),
    sellMode: env.ORDERFLOW_TRIGGER_SELL_MODE ?? "",
    sellPercent: Number(env.ORDERFLOW_TRIGGER_SELL_PERCENT ?? 0),
    pollMs: Number(env.ORDERFLOW_TRIGGER_POLL_MS ?? 0),
    stateFile,
    logFile,
    lastProcessedBlock: state.lastProcessedBlock ?? null,
    failedTxCount: Object.keys(state.failedTxs ?? {}).length,
    processingTxCount: Object.keys(state.processingTxs ?? {}).length,
    soldTokenIds: Object.keys(state.soldTokenIds ?? {}),
    latestStartedAt: latestStarted?.at ?? null,
    latestStartedThresholdUsdt: latestStarted?.thresholdUsdt ?? null,
    latestStartedWatchedTokenIds: latestStarted?.watchedTokenIds ?? []
  };
}

function orderflowUnitPath(service) {
  const systemdPath = path.join(orderflowSystemdDir, service);
  if (fs.existsSync(systemdPath)) return systemdPath;
  const opsPath = path.join(rootDir, "ops", service);
  if (fs.existsSync(opsPath)) return opsPath;
  return systemdPath;
}

async function orderflowServiceState(service) {
  if (process.platform === "darwin") {
    return { running: false, activeState: "unknown", subState: "unsupported", restarts: null };
  }
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "show",
      service,
      "--property=ActiveState",
      "--property=SubState",
      "--property=NRestarts"
    ], { timeoutMs: 5000 });
    const values = Object.fromEntries(stdout.trim().split(/\r?\n/)
      .map((line) => {
        const index = line.indexOf("=");
        return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ""];
      }));
    const activeState = values.ActiveState ?? "";
    const subState = values.SubState ?? "";
    const restarts = values.NRestarts ?? "";
    return {
      running: activeState === "active" && subState === "running",
      activeState,
      subState,
      restarts: Number.isFinite(Number(restarts)) ? Number(restarts) : null
    };
  } catch {
    return { running: false, activeState: "unknown", subState: "unknown", restarts: null };
  }
}

async function restartOrderflowMonitor(slot) {
  if (process.env.DASHBOARD_ORDERFLOW_RESTART === "0") return false;
  if (process.platform === "darwin") return false;
  await execFileAsync("systemctl", ["daemon-reload"], { timeoutMs: 30000 });
  await execFileAsync("systemctl", ["restart", slot.service], { timeoutMs: 30000 });
  return true;
}

function latestOrderflowStarted(logFile) {
  if (!logFile || !fs.existsSync(logFile)) return null;
  return readJsonl(logFile, 300)
    .filter((row) => row.level === "orderflow-trigger-sell-started")
    .at(-1) ?? null;
}

async function watchedAddressActivityPayload(url) {
  if (!watchedAddressActivityEnabled) {
    return {
      ok: true,
      enabled: false,
      monitors: [],
      activity: [],
      warnings: []
    };
  }

  const lookbackMinutes = clampInteger(
    url.searchParams.get("lookbackMinutes") ?? watchedAddressLookbackMinutes,
    5,
    240,
    watchedAddressLookbackMinutes
  );
  const limit = clampInteger(
    url.searchParams.get("limit") ?? watchedAddressActivityLimit,
    1,
    200,
    watchedAddressActivityLimit
  );
  const cfg = readConfig();
  const publicClient = createPublicClient({
    chain: bsc,
    transport: viemHttp(cfg.rpcUrl)
  });
  const monitors = await Promise.all(watchedAddressSlots.map(readWatchedAddressMonitor));
  const warnings = [];
  let scan = {
    latestBlock: null,
    fromBlock: null,
    toBlock: null,
    rows: []
  };

  try {
    scan = await scanWatchedAddressTokenActivity(publicClient, watchedAddressSlots, lookbackMinutes);
  } catch (error) {
    warnings.push(`链上回看失败：${cleanError(error)}`);
  }

  const rows = mergeWatchedAddressRows([
    ...readWatchedAddressLogActivity(monitors),
    ...scan.rows
  ])
    .sort(compareWatchedAddressRows)
    .slice(0, limit);
  const activity = await enrichWatchedAddressRows(cfg, publicClient, rows);
  return {
    ok: true,
    enabled: true,
    generatedAt: new Date().toISOString(),
    lookbackMinutes,
    latestBlock: scan.latestBlock,
    fromBlock: scan.fromBlock,
    toBlock: scan.toBlock,
    monitors,
    activity,
    warnings
  };
}

async function readWatchedAddressMonitor(slot) {
  const unitPath = watchedAddressUnitPath(slot.service);
  const unitExists = Boolean(unitPath && fs.existsSync(unitPath));
  const text = unitExists ? fs.readFileSync(unitPath, "utf8") : "";
  const env = parseSystemdEnvironment(text);
  const stateFile = env.ADDRESS_TX_WATCH_STATE_FILE ?? "";
  const logFile = env.ADDRESS_TX_WATCH_LOG_FILE ?? "";
  const state = safeReadJson(stateFile) ?? {};
  const logs = readJsonl(logFile, 300);
  const serviceState = await orderflowServiceState(slot.service);
  const hits = logs.filter((row) => row.level === "address-tx-watch-hit");
  const alerts = logs.filter((row) => row.level === "address-tx-watch-alert-sent");
  const suppressed = logs.filter((row) => row.level === "address-tx-watch-alert-suppressed");
  const errors = logs.filter((row) => row.level === "address-tx-watch-error");
  const latestStarted = logs.filter((row) => row.level === "address-tx-watch-started").at(-1) ?? null;
  const address = addressOrFallback(env.ADDRESS_TX_WATCH_ADDRESS, slot.address);
  return {
    id: slot.id,
    label: env.ADDRESS_TX_WATCH_LABEL ?? slot.label,
    address,
    service: slot.service,
    unitPath: unitPath ?? null,
    unitExists,
    running: serviceState.running,
    activeState: serviceState.activeState,
    subState: serviceState.subState,
    restarts: serviceState.restarts,
    cooldownMs: Number(env.ADDRESS_TX_WATCH_COOLDOWN_MS ?? 0),
    pollMs: Number(env.ADDRESS_TX_WATCH_POLL_MS ?? 0),
    stateFile,
    logFile,
    lastProcessedBlock: state.lastProcessedBlock ?? null,
    seenTxCount: Object.keys(state.seenTxs ?? {}).length,
    lastAlertAt: state.alert?.lastSentAt ?? null,
    lastAlertTxHash: state.alert?.lastTxHash ?? null,
    latestStartedAt: latestStarted?.at ?? null,
    recentHitCount: hits.length,
    recentAlertCount: alerts.length,
    recentSuppressedCount: suppressed.length,
    lastHitAt: hits.at(-1)?.at ?? null,
    lastHitBlock: hits.at(-1)?.blockNumber ?? null,
    lastErrorAt: errors.at(-1)?.at ?? null,
    lastError: errors.at(-1)?.message ?? null
  };
}

function watchedAddressUnitPath(service) {
  const systemdPath = path.join(watchedAddressSystemdDir, service);
  if (fs.existsSync(systemdPath)) return systemdPath;
  const opsPath = path.join(rootDir, "ops", service);
  if (fs.existsSync(opsPath)) return opsPath;
  return systemdPath;
}

function readWatchedAddressLogActivity(monitors) {
  const rows = [];
  for (const monitor of monitors) {
    for (const row of readJsonl(monitor.logFile, 160)) {
      if (row.level !== "address-tx-watch-hit" || !row.txHash) continue;
      rows.push({
        address: monitor.address,
        addressLabel: row.label ?? monitor.label,
        txHash: row.txHash,
        blockNumber: parseBlockNumber(row.blockNumber),
        transactionIndex: parseBlockNumber(row.transactionIndex),
        logIndex: null,
        directions: Array.isArray(row.directions) ? row.directions : [],
        direct: Boolean(row.direct),
        tokenTransferCount: Number(row.tokenTransferCount ?? 0),
        contracts: Array.isArray(row.contracts) ? row.contracts : [],
        sentUsdt: 0,
        receivedUsdt: 0,
        source: "watcher",
        seenAt: row.at ?? null
      });
    }
  }
  return rows;
}

async function scanWatchedAddressTokenActivity(publicClient, slots, lookbackMinutes) {
  const latestBlock = await publicClient.getBlockNumber();
  const scanBlocks = Math.min(
    Math.max(1, Math.ceil(Number(lookbackMinutes) * watchedAddressBlocksPerMinute) + 120),
    Math.max(1, watchedAddressMaxScanBlocks)
  );
  const fromBlock = latestBlock > BigInt(scanBlocks) ? latestBlock - BigInt(scanBlocks) + 1n : 0n;
  const toBlock = latestBlock;
  const rows = new Map();
  const specs = [
    {
      kind: "erc20",
      topic: ERC20_TRANSFER_TOPIC,
      fromIndex: 1,
      toIndex: 2,
      topicsForFrom: (topic) => [ERC20_TRANSFER_TOPIC, topic],
      topicsForTo: (topic) => [ERC20_TRANSFER_TOPIC, null, topic]
    },
    {
      kind: "erc1155-single",
      topic: ERC1155_TRANSFER_SINGLE_TOPIC,
      fromIndex: 2,
      toIndex: 3,
      topicsForFrom: (topic) => [ERC1155_TRANSFER_SINGLE_TOPIC, null, topic],
      topicsForTo: (topic) => [ERC1155_TRANSFER_SINGLE_TOPIC, null, null, topic]
    },
    {
      kind: "erc1155-batch",
      topic: ERC1155_TRANSFER_BATCH_TOPIC,
      fromIndex: 2,
      toIndex: 3,
      topicsForFrom: (topic) => [ERC1155_TRANSFER_BATCH_TOPIC, null, topic],
      topicsForTo: (topic) => [ERC1155_TRANSFER_BATCH_TOPIC, null, null, topic]
    }
  ];

  for (const slot of slots) {
    const address = getAddressOrNull(slot.address);
    if (!address) continue;
    const addressTopic = addressToTopic(address);
    for (const spec of specs) {
      for (const topics of [spec.topicsForFrom(addressTopic), spec.topicsForTo(addressTopic)]) {
        const logs = await getWatchedAddressLogs(publicClient, { fromBlock, toBlock, topics });
        for (const log of logs) {
          addWatchedAddressTransferLog(rows, slot, address, spec, log);
        }
      }
    }
  }

  return {
    latestBlock: latestBlock.toString(),
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    rows: [...rows.values()].map(finalizeWatchedAddressMapRow)
  };
}

async function getWatchedAddressLogs(publicClient, { fromBlock, toBlock, topics }) {
  const rows = [];
  let cursor = BigInt(fromBlock);
  const end = BigInt(toBlock);
  const chunkBlocks = BigInt(Math.max(1, watchedAddressScanChunkBlocks));
  while (cursor <= end) {
    const chunkTo = minBigInt(end, cursor + chunkBlocks - 1n);
    const logs = await publicClient.request({
      method: "eth_getLogs",
      params: [{
        fromBlock: rpcBlockTag(cursor),
        toBlock: rpcBlockTag(chunkTo),
        topics
      }]
    });
    rows.push(...logs);
    cursor = chunkTo + 1n;
  }
  return rows;
}

function addWatchedAddressTransferLog(rows, slot, address, spec, log) {
  if (String(log.topics?.[0] ?? "").toLowerCase() !== spec.topic) return;
  const txHash = log.transactionHash;
  if (!txHash) return;
  const row = ensureWatchedAddressMapRow(rows, slot, address, txHash);
  const logIndex = parseBlockNumber(log.logIndex);
  const blockNumber = parseBlockNumber(log.blockNumber);
  const transactionIndex = parseBlockNumber(log.transactionIndex);
  const logKey = `${String(txHash).toLowerCase()}:${String(logIndex ?? "")}`;
  const firstSeenLog = !row.logKeys.has(logKey);
  row.blockNumber = maxNumber(row.blockNumber, blockNumber);
  row.transactionIndex = maxNumber(row.transactionIndex, transactionIndex);
  row.logIndex = minNullableNumber(row.logIndex, logIndex);
  row.contracts.add(addressOrFallback(log.address, log.address));
  row.sources.add("scan");

  const from = topicAddress(log.topics?.[spec.fromIndex]);
  const to = topicAddress(log.topics?.[spec.toIndex]);
  const normalized = address.toLowerCase();
  const isOut = from?.toLowerCase() === normalized;
  const isIn = to?.toLowerCase() === normalized;
  if (isOut) row.directions.add("out");
  if (isIn) row.directions.add("in");

  if (firstSeenLog) {
    row.logKeys.add(logKey);
    row.tokenTransferCount += 1;
    if (spec.kind === "erc20" && normAddress(log.address) === normAddress(ADDRESSES.busdt)) {
      const amount = numberFromTokenUnits(log.data, 18);
      if (isOut) row.sentUsdt += amount;
      if (isIn) row.receivedUsdt += amount;
    }
  }
}

function ensureWatchedAddressMapRow(rows, slot, address, txHash) {
  const key = watchedAddressActivityKey(address, txHash);
  if (!rows.has(key)) {
    rows.set(key, {
      key,
      address,
      addressLabel: slot.label,
      txHash,
      blockNumber: null,
      transactionIndex: null,
      logIndex: null,
      directions: new Set(),
      direct: false,
      tokenTransferCount: 0,
      contracts: new Set(),
      sentUsdt: 0,
      receivedUsdt: 0,
      sources: new Set(),
      seenAt: null,
      logKeys: new Set()
    });
  }
  return rows.get(key);
}

function mergeWatchedAddressRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.address || !row.txHash) continue;
    const key = watchedAddressActivityKey(row.address, row.txHash);
    const existing = grouped.get(key) ?? {
      key,
      address: addressOrFallback(row.address, row.address),
      addressLabel: row.addressLabel ?? shortAddress(row.address),
      txHash: row.txHash,
      blockNumber: null,
      transactionIndex: null,
      logIndex: null,
      directions: new Set(),
      direct: false,
      tokenTransferCount: 0,
      contracts: new Set(),
      sentUsdt: 0,
      receivedUsdt: 0,
      sources: new Set(),
      seenAt: null
    };
    existing.addressLabel = row.addressLabel ?? existing.addressLabel;
    existing.blockNumber = maxNumber(existing.blockNumber, row.blockNumber);
    existing.transactionIndex = maxNumber(existing.transactionIndex, row.transactionIndex);
    existing.logIndex = minNullableNumber(existing.logIndex, row.logIndex);
    existing.direct = existing.direct || Boolean(row.direct);
    existing.tokenTransferCount = Math.max(existing.tokenTransferCount, Number(row.tokenTransferCount ?? 0));
    existing.sentUsdt = Math.max(existing.sentUsdt, Number(row.sentUsdt ?? 0));
    existing.receivedUsdt = Math.max(existing.receivedUsdt, Number(row.receivedUsdt ?? 0));
    existing.seenAt = newestIso(existing.seenAt, row.seenAt);
    for (const direction of row.directions ?? []) existing.directions.add(direction);
    for (const contract of row.contracts ?? []) existing.contracts.add(contract);
    for (const source of Array.isArray(row.source) ? row.source : [row.source]) {
      if (source) existing.sources.add(source);
    }
    grouped.set(key, existing);
  }
  return [...grouped.values()].map(finalizeWatchedAddressMapRow);
}

function finalizeWatchedAddressMapRow(row) {
  const sentUsdt = roundMoney(Number(row.sentUsdt ?? 0));
  const receivedUsdt = roundMoney(Number(row.receivedUsdt ?? 0));
  const netUsdt = roundMoney(receivedUsdt - sentUsdt);
  return {
    key: row.key,
    address: addressOrFallback(row.address, row.address),
    addressLabel: row.addressLabel,
    txHash: row.txHash,
    blockNumber: row.blockNumber,
    transactionIndex: row.transactionIndex,
    logIndex: row.logIndex,
    directions: [...(row.directions ?? [])].sort(),
    direct: Boolean(row.direct),
    tokenTransferCount: Number(row.tokenTransferCount ?? 0),
    contracts: [...(row.contracts ?? [])].sort(),
    sentUsdt,
    receivedUsdt,
    netUsdt,
    source: [...(row.sources ?? [])].sort(),
    seenAt: row.seenAt ?? null
  };
}

async function enrichWatchedAddressRows(cfg, publicClient, rows) {
  const enriched = [];
  for (const row of rows) {
    enriched.push(await enrichWatchedAddressRow(cfg, publicClient, row));
  }
  return enriched.sort(compareWatchedAddressRows);
}

async function enrichWatchedAddressRow(cfg, publicClient, row) {
  const base = {
    ...row,
    shortTx: shortHash(row.txHash),
    explorerUrl: `https://bscscan.com/tx/${row.txHash}`,
    directionsText: watchedDirectionsText(row.directions),
    amountText: watchedAmountText(row),
    status: null,
    at: row.seenAt,
    events: [],
    event: null
  };
  try {
    const tx = await getWatchedAddressTxContext(publicClient, row.txHash);
    const blockTime = tx.block?.timestamp !== undefined
      ? new Date(Number(tx.block.timestamp) * 1000).toISOString()
      : null;
    const events = await decodeWatchedAddressTxEvents(cfg, tx.receipt, row.address);
    const primary = primaryWatchedAddressEvent(events);
    return {
      ...base,
      blockNumber: row.blockNumber ?? parseBlockNumber(tx.receipt?.blockNumber),
      status: tx.receipt?.status ?? null,
      at: blockTime ?? row.seenAt,
      events,
      event: primary
    };
  } catch (error) {
    return {
      ...base,
      error: cleanError(error)
    };
  }
}

async function getWatchedAddressTxContext(publicClient, txHash) {
  const key = normHash(txHash);
  if (watchedAddressTxCache.has(key)) return watchedAddressTxCache.get(key);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const block = receipt?.blockNumber !== undefined && receipt?.blockNumber !== null
    ? await publicClient.getBlock({ blockNumber: toBigInt(receipt.blockNumber) }).catch(() => null)
    : null;
  const context = { receipt, block };
  watchedAddressTxCache.set(key, context);
  pruneMap(watchedAddressTxCache, 240);
  return context;
}

async function decodeWatchedAddressTxEvents(cfg, receipt, watchedAddress) {
  const normalized = normAddress(watchedAddress);
  const rawEvents = [];
  for (const log of receipt?.logs ?? []) {
    const topic0 = String(log.topics?.[0] ?? "").toLowerCase();
    if (topic0 === MARKET_TRADE_TOPIC) {
      const event = parseWatchedMarketTradeLog(log, normalized);
      if (event) rawEvents.push(event);
      continue;
    }
    if (topic0 === ERC1155_TRANSFER_SINGLE_TOPIC) {
      const event = parseWatchedErc1155TransferSingleLog(log, normalized);
      if (event) rawEvents.push(event);
    }
  }

  const deduped = dedupeWatchedAddressEvents(rawEvents);
  const events = [];
  for (const event of deduped) {
    events.push(await enrichWatchedAddressEvent(cfg, event));
  }
  return events.filter((event) => event.market || event.question);
}

function parseWatchedMarketTradeLog(log, normalizedWatchedAddress) {
  if ((log.topics?.length ?? 0) < 4) return null;
  const user = topicAddress(log.topics[2]);
  if (!user || normAddress(user) !== normalizedWatchedAddress) return null;
  const dataWords = dataWords64(log.data);
  if (dataWords.length < 2) return null;
  const netCollateral = int256FromWord(dataWords[0]);
  const size = int256FromWord(dataWords[1]);
  return {
    kind: "market_trade",
    action: netCollateral >= 0n ? "buy" : "sell",
    actionLabel: netCollateral >= 0n ? "买入" : "卖出",
    market: addressOrFallback(log.address, log.address),
    tokenId: BigInt(log.topics[3]).toString(),
    amountUsdt: roundMoney(numberFromTokenUnits(absBigInt(netCollateral), 18)),
    size: chips(numberFromTokenUnits(absBigInt(size), 18)),
    logIndex: parseBlockNumber(log.logIndex)
  };
}

function parseWatchedErc1155TransferSingleLog(log, normalizedWatchedAddress) {
  if ((log.topics?.length ?? 0) < 4) return null;
  const from = topicAddress(log.topics[2]);
  const to = topicAddress(log.topics[3]);
  const isOut = from && normAddress(from) === normalizedWatchedAddress;
  const isIn = to && normAddress(to) === normalizedWatchedAddress;
  if (!isOut && !isIn) return null;
  const dataWords = dataWords64(log.data);
  if (dataWords.length < 2) return null;
  return {
    kind: "market_token_transfer",
    action: isOut ? "transfer_out" : "transfer_in",
    actionLabel: isOut ? "转出/赎回" : "转入",
    market: addressOrFallback(log.address, log.address),
    tokenId: BigInt(`0x${dataWords[0]}`).toString(),
    amountUsdt: "",
    size: chips(numberFromTokenUnits(BigInt(`0x${dataWords[1]}`), 18)),
    logIndex: parseBlockNumber(log.logIndex)
  };
}

function dedupeWatchedAddressEvents(events) {
  const hasTrade = new Set(events
    .filter((event) => event.kind === "market_trade")
    .map((event) => `${normAddress(event.market)}:${event.tokenId}`));
  const deduped = new Map();
  for (const event of events) {
    const marketTokenKey = `${normAddress(event.market)}:${event.tokenId}`;
    if (event.kind !== "market_trade" && hasTrade.has(marketTokenKey)) continue;
    const key = `${marketTokenKey}:${event.kind}:${event.action}`;
    if (!deduped.has(key)) deduped.set(key, event);
  }
  return [...deduped.values()].sort((a, b) => Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0));
}

async function enrichWatchedAddressEvent(cfg, event) {
  const market = await fetchWatchedAddressMarket(cfg, event.market);
  const outcome = findOutcomeByTokenId(market, event.tokenId);
  return {
    ...event,
    question: market?.question ?? market?.title ?? "",
    status: market?.status ?? "",
    category: market ? firstCategory(market) : "",
    startsAt: market?.startDate ?? "",
    endsAt: market?.endDate ?? "",
    outcome: outcome?.name ?? outcome?.title ?? (event.tokenId ? `Token ${event.tokenId}` : "")
  };
}

async function fetchWatchedAddressMarket(cfg, address) {
  const key = normAddress(address);
  if (!key) return null;
  if (watchedAddressMarketCache.has(key)) return watchedAddressMarketCache.get(key);
  try {
    const market = await fetchMarket(cfg, address);
    watchedAddressMarketCache.set(key, market);
    pruneMap(watchedAddressMarketCache, 240);
    return market;
  } catch {
    watchedAddressMarketCache.set(key, null);
    pruneMap(watchedAddressMarketCache, 240);
    return null;
  }
}

function primaryWatchedAddressEvent(events) {
  return events.find((event) => event.kind === "market_trade")
    ?? events.find((event) => event.question)
    ?? events[0]
    ?? null;
}

function findOutcomeByTokenId(market, tokenId) {
  const id = String(tokenId ?? "");
  return (market?.outcomes ?? []).find((outcome) => String(outcome.tokenId ?? "") === id) ?? null;
}

function parseSystemdEnvironment(text) {
  const env = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("Environment=")) continue;
    const body = line.slice("Environment=".length).trim();
    for (const item of splitSystemdEnvironmentWords(body)) {
      const index = item.indexOf("=");
      if (index <= 0) continue;
      env[item.slice(0, index)] = unquoteSystemdValue(item.slice(index + 1));
    }
  }
  return env;
}

function splitSystemdEnvironmentWords(value) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of String(value ?? "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function unquoteSystemdValue(value) {
  const text = String(value ?? "");
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function setSystemdEnvironment(text, key, value) {
  const safeKey = String(key);
  const safeValue = String(value ?? "");
  if (!/^[A-Z0-9_]+$/u.test(safeKey)) throw new Error("Invalid environment key");
  if (/[\r\n\s"']/u.test(safeValue)) throw new Error(`Invalid value for ${safeKey}`);
  const line = `Environment=${safeKey}=${safeValue}`;
  const pattern = new RegExp(`^Environment=${escapeRegExp(safeKey)}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  const anchor = /^Environment=ORDERFLOW_TRIGGER_EXECUTE=.*$/m;
  if (anchor.test(text)) return text.replace(anchor, (match) => `${match}\n${line}`);
  return text.replace(/^(\[Service\])$/m, `$1\n${line}`);
}

function normalizeOrderflowMarket(value) {
  const market = String(value ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/u.test(market)) throw new Error("Invalid market address");
  return market;
}

function normalizeOrderflowThreshold(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1000000) {
    throw new Error("Invalid threshold");
  }
  return roundMoney(threshold);
}

function normalizeOrderflowTokenIds(value) {
  const ids = parseOrderflowTokenIds(value);
  if (ids.length > 64) throw new Error("Too many token IDs");
  for (const id of ids) {
    if (!/^\d+$/u.test(id) || BigInt(id) <= 0n) throw new Error("Invalid token ID");
  }
  return [...new Set(ids)];
}

function parseOrderflowTokenIds(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/u);
  return items.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function normalizeOrderflowBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function marketDetail(url) {
  const address = url.searchParams.get("market");
  if (!address) throw new Error("Missing market");
  const cfg = readConfig();
  const followState = readMarketFollowState(cfg.marketFollowFile);
  const plannedBuys = readDashboardPlannedBuys(cfg);
  const market = await fetchMarket(cfg, address);
  const baseDecision = getBaseEventMarketDecision(market, cfg);
  const rawDecision = getEventMarketDecision(market, { ...cfg, marketFollowState: followState });
  const plannedBuy = findDashboardPlannedBuy(plannedBuys, market);
  const decision = dashboardPlannedBuyDecision(rawDecision, plannedBuy);
  const follow = dashboardPlannedBuyFollow(
    marketFollowStatus(followState, market, baseDecision, decision),
    plannedBuy,
    decision
  );
  return {
    ok: true,
    market: {
      title: market.question,
      address: market.address,
      status: market.status,
      category: firstCategory(market),
      categories: market.categories ?? [],
      tags: market.tags ?? [],
      startsAt: market.startDate,
      endsAt: market.endDate,
      duration: durationText(market),
      durationHours: durationHoursValue(market),
      decision: {
        eligible: decision.eligible,
        reason: decision.reason,
        reasonText: decision.reasonText
      },
      follow,
      outcomes: sortOutcomesForDashboard(market.outcomes ?? []).map((outcome) => ({
        tokenId: String(outcome.tokenId ?? ""),
        name: outcome.name ?? outcome.title ?? "Outcome",
        price: price(outcome.price),
        priceValue: num(outcome.price),
        odds: oddsText(outcome),
        payout: payoutText(outcome.payout),
        volume: money(outcome.volume),
        minted: chips(outcome.mintedQuantity)
      }))
    }
  };
}

async function updateMarketFollow(req, mode) {
  const body = await readJsonBody(req);
  requireAdminToken(req, body);
  const cfg = readConfig();
  const action = body.action === "block" || body.action === "unfollow" ? "block" : mode;
  const marketInput = {
    market: body.market,
    title: body.title,
    category: body.category,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    snapshot: body.snapshot
  };
  const state = action === "block"
    ? blockMarket(cfg.marketFollowFile, marketInput)
    : followMarket(cfg.marketFollowFile, marketInput);
  const restarted = await restartWorker();
  overviewCache = null;
  return {
    ok: true,
    action,
    state,
    restarted,
    message: action === "block"
      ? (restarted ? "已取消关注，worker 已重启" : "已取消关注")
      : (restarted ? "已关注，worker 已重启" : "已关注")
  };
}

async function updateMarketFollowBatch(req) {
  const body = await readJsonBody(req);
  requireAdminToken(req, body);
  const markets = Array.isArray(body.markets) ? body.markets.filter(Boolean) : [];
  if (markets.length === 0) throw new Error("Missing markets");
  if (markets.length > 500) throw new Error("Too many markets");

  const cfg = readConfig();
  const action = body.action === "block" || body.action === "unfollow" ? "block" : "follow";
  const state = action === "block"
    ? blockMarkets(cfg.marketFollowFile, markets)
    : followMarkets(cfg.marketFollowFile, markets);
  const restarted = await restartWorker();
  overviewCache = null;
  return {
    ok: true,
    action,
    count: markets.length,
    state,
    restarted,
    message: action === "block"
      ? `已取消关注 ${markets.length} 个${restarted ? "，worker 已重启" : ""}`
      : `已关注 ${markets.length} 个${restarted ? "，worker 已重启" : ""}`
  };
}

function requireAdminToken(req, body = {}) {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN ?? "";
  if (!expected) return false;
  const provided = req.headers["x-admin-token"] ?? body.adminToken ?? "";
  if (!safeEqual(String(provided), expected)) throw new Error("Invalid admin token");
  return true;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function restartWorker() {
  if (process.env.DASHBOARD_RUNTIME_RESTART === "0") return false;
  if (process.platform === "darwin") return false;
  await execFileAsync("systemctl", ["restart", systemdService], { timeoutMs: 30000 });
  return true;
}

function roundMoney(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

function broadcastWindowText(watchConfig, cfg) {
  const openBroadcastDelayMs = Number(watchConfig?.openBroadcastDelayMs ?? cfg.openBroadcastDelayMs ?? 0);
  const openWindowSeconds = Number(watchConfig?.eventOpenWindowSeconds ?? cfg.eventOpenWindowSeconds ?? 60);
  const broadcastText = openBroadcastDelayMs > 0
    ? `广播 T+${formatSeconds(openBroadcastDelayMs / 1000)}s`
    : "开盘立即广播";
  return `${broadcastText} / 超窗 ${formatSeconds(openWindowSeconds)}s`;
}

function formatSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  return Number.isInteger(number) ? String(number) : number.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

async function sellQuote(body) {
  await assertManualSellAllowed();
  const args = sellArgs(body);
  const result = await runEvent(["sell", ...requireWalletArgs(), ...args], {
    timeoutMs: 30000,
    env: {
      DRY_RUN: "1",
      EXECUTE: "0",
      AUTO_SELL_ENABLED: "0",
      NO_GUI_PROMPT: "1"
    }
  });
  if (result.mode !== "dry-run" || (result.executions?.length ?? 0) > 0) {
    throw new Error("Quote safety violation: quote returned executable sell result");
  }
  return {
    ok: true,
    quote: normalizeSellQuote(result)
  };
}

async function sellExecute(body) {
  await assertManualSellAllowed();
  const args = sellArgs(body);
  const result = await runEvent(["sell", "--execute", ...requireWalletArgs(), ...args], {
    timeoutMs: 120000,
    env: {
      DRY_RUN: "0",
      EXECUTE: "1",
      I_UNDERSTAND_42_PRICE_MARKET_RISK: "YES",
      I_AM_NOT_IN_RESTRICTED_JURISDICTION: "YES",
      NO_GUI_PROMPT: "1"
    }
  });
  const summary = normalizeSellExecution(result);
  appendJsonl(actionsFile, {
    type: "sell",
    source: "manual-dashboard",
    at: new Date().toISOString(),
    question: summary.title,
    outcome: summary.outcome,
    amount: summary.receivedText,
    status: summary.status,
    txHash: summary.txHash,
    txHashes: summary.txHashes,
    operatorApprovalHash: summary.operatorApprovalHash,
    blockNumber: summary.blockNumber,
    market: summary.market,
    tokenId: summary.tokenId
  });
  overviewCache = null;
  return {
    ok: true,
    sell: summary
  };
}

async function assertManualSellAllowed() {
  const status = await runEvent(["status", ...requireWalletArgs()], { timeoutMs: 30000 });
  const state = manualSellState(status, readConfig());
  if (state.blocked) throw new Error(state.message);
}

function walletArgs() {
  return botWallet ? ["--wallet", botWallet] : [];
}

function requireWalletArgs() {
  if (!botWallet) throw new Error("DASHBOARD_WALLET or WALLET_ADDRESS is required for dashboard sell actions");
  return ["--wallet", botWallet];
}

function manualSellState(status, cfg) {
  const block = findManualSellBlock(status, cfg);
  if (!block) {
    return {
      blocked: false,
      label: "可手动卖出",
      message: "当前不在买入保护期"
    };
  }
  const seconds = Math.max(0, Math.ceil(block.msUntilStart / 1000));
  const label = block.msUntilStart >= 0 ? "开盘前保护" : "开盘后保护";
  return {
    blocked: true,
    label,
    message: block.msUntilStart >= 0
      ? `下一场 ${seconds} 秒内开盘，已暂停手动卖出`
      : "当前处于开盘买入保护期，已暂停手动卖出",
    market: block.market?.question ?? null,
    startsAt: block.market?.startDate ?? null,
    msUntilStart: block.msUntilStart,
    guardBeforeMs: block.beforeMs,
    guardAfterMs: block.afterMs
  };
}

function findManualSellBlock(status, cfg) {
  const markets = status.future ?? [];
  if (!markets.length) return null;
  const preSignWindowMs = Number(status.watchConfig?.preSignWindowMs ?? cfg.preSignWindowMs ?? 60000);
  const openWindowMs = Number(status.watchConfig?.eventOpenWindowSeconds ?? cfg.eventOpenWindowSeconds ?? 5) * 1000;
  const guardMs = Number(process.env.DASHBOARD_MANUAL_SELL_HOT_GUARD_MS ?? 15000);
  const beforeMs = preSignWindowMs + guardMs;
  const afterMs = openWindowMs + guardMs;
  const now = Date.now();
  return markets
    .map((market) => {
      const startMs = new Date(market.startDate).getTime();
      if (!Number.isFinite(startMs)) return null;
      return { market, msUntilStart: startMs - now, beforeMs, afterMs };
    })
    .filter(Boolean)
    .filter((item) => item.msUntilStart <= beforeMs && item.msUntilStart >= -afterMs)
    .sort((a, b) => Math.abs(a.msUntilStart) - Math.abs(b.msUntilStart))[0] ?? null;
}

function sellArgs(body) {
  if (!body?.market) throw new Error("Missing market");
  const percent = Number(body.percent ?? 100);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error("Invalid percent");
  const args = ["--market", String(body.market), "--percent", String(percent)];
  if (body.all) {
    args.push("--all");
  } else {
    if (!body.tokenId) throw new Error("Missing token");
    args.push("--token-id", String(body.tokenId));
  }
  return args;
}

function normalizeBot(bot, status) {
  const wallet = normalizeWallet(status.wallet, status);
  const waitingFunds = wallet && wallet.state === "blocked";
  const partialFunding = wallet?.state === "partial";
  const idle = wallet?.state === "idle";
  return {
    running: bot.running,
    label: bot.running ? (waitingFunds ? "等待资金" : (partialFunding ? "部分可买" : (idle ? "等待新盘" : "运行中"))) : "未运行",
    tone: bot.running && !waitingFunds ? "good" : "warn",
    message: waitingFunds || partialFunding || idle ? wallet.message : bot.message
  };
}

function normalizeWallet(wallet, status = null) {
  if (!wallet) return null;
  const executableMarketCount = Number(wallet.executableMarketCount ?? 0);
  const hasExecutableFunds = Boolean((wallet.balanceReady || executableMarketCount > 0) && wallet.bnbReady);
  const nextBatchMarketCount = Number(status?.funding?.nextBatchMarketCount ?? wallet.nextBatchMarketCount ?? NaN);
  const hasNextBatchInfo = Number.isFinite(nextBatchMarketCount);
  const hasNoNextBatch = hasNextBatchInfo && nextBatchMarketCount === 0;
  const upperBoundReady = Boolean(wallet.balanceReadyForUpperBound && wallet.allowanceReadyForUpperBound && wallet.bnbReady);
  const partial = Boolean(wallet.partialFunding);
  const state = hasExecutableFunds ? (partial ? "partial" : "all") : (hasNoNextBatch && upperBoundReady ? "idle" : "blocked");
  const label = state === "all" ? "全部可买" : (state === "partial" ? "部分可买" : (state === "idle" ? "等待新盘" : "不可买"));
  return {
    busdt: money(wallet.busdtBalance),
    bnb: Number(wallet.bnbBalance ?? 0).toFixed(6),
    ready: state !== "blocked",
    partial,
    state,
    label,
    tone: state === "blocked" ? "warn" : "good",
    executableMarketCount,
    unfundedMarketCount: Number(wallet.unfundedMarketCount ?? 0),
    message: fundingMessage(wallet, { state })
  };
}

function fundingMessage(wallet, context = {}) {
  if (!wallet) return "";
  if (context.state === "idle") return "当前没有待买事件";
  if ((wallet.balanceReady || wallet.executableMarketCount > 0) && wallet.bnbReady) {
    if (wallet.partialFunding) {
      const executable = Number(wallet.executableMarketCount ?? 0);
      const total = executable + Number(wallet.unfundedMarketCount ?? 0);
      const missing = money(Math.max(0, Number(wallet.requiredBusdt ?? 0) - Number(wallet.busdtBalance ?? 0)));
      return total > 0 ? `可买 ${executable}/${total} 场，全买还差 ${missing} U` : `部分可买，全买还差 ${missing} U`;
    }
    return "当前可买";
  }
  const missing = Math.max(0, Number(wallet.minimumExecutableBusdt ?? wallet.requiredBusdt ?? 0) - Number(wallet.busdtBalance ?? 0));
  if (missing > 0) return `至少差 ${money(missing)} U`;
  return "需要补 BNB";
}

function normalizeNext(status) {
  const markets = status.future ?? [];
  const next = markets[0] ?? null;
  return {
    count: markets.length,
    items: markets.slice(0, 20).map((market) => normalizeQueueMarket(market)),
    first: next ? {
      title: next.question,
      startsAt: next.startDate,
      endsAt: next.endDate,
      duration: next.durationText || durationText(next),
      stake: money(next.totalStakeUsdt),
      choices: next.outcomeCount,
      fundingState: next.fundingState,
      ready: Boolean(next.prepared)
    } : null
  };
}

function normalizeQueueMarket(market) {
  return {
    title: market.question,
    address: market.address,
    startsAt: market.startDate,
    endsAt: market.endDate,
    duration: market.durationText || durationText(market),
    stake: money(market.totalStakeUsdt),
    choices: market.outcomeCount,
    fundingState: market.fundingState ?? "future",
    state: queueMarketState(market),
    ready: Boolean(market.prepared)
  };
}

function queueMarketState(market) {
  if (market.fundingState === "funded") return "待买";
  if (market.fundingState === "insufficient-funds") return "资金不足";
  return market.prepared ? "已准备" : "待准备";
}

function normalizeNewMarkets(markets, status, walletRows, localRows, cfg = readConfig(), followState = readMarketFollowState(cfg.marketFollowFile)) {
  const openWindowSeconds = Number(status.watchConfig?.eventOpenWindowSeconds ?? cfg.eventOpenWindowSeconds ?? 60);
  const bought = boughtMarketSummary(walletRows, localRows);
  const skipped = skippedMarketSet(localRows);
  const future = new Map((status.future ?? []).map((market) => [normAddress(market.address), market]));
  const plannedBuys = readDashboardPlannedBuys(cfg);
  const rows = [];
  let excluded = 0;
  const plannedChoices = Number(status.watchConfig?.eventOutcomeCount ?? cfg.eventOutcomeCount ?? 5);
  const plannedStakePerOutcome = Number(status.watchConfig?.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt ?? 5);

  for (const market of markets) {
    const baseDecision = getBaseEventMarketDecision(market, cfg);
    const rawDecision = getEventMarketDecision(market, cfg);
    const plannedBuy = findDashboardPlannedBuy(plannedBuys, market);
    const decision = dashboardPlannedBuyDecision(rawDecision, plannedBuy);
    const displayDecision = getEventMarketDisplayDecision(market, cfg, decision);
    if (!displayDecision.visible) continue;
    const key = normAddress(market.address);
    const pending = future.get(key);
    const follow = dashboardPlannedBuyFollow(marketFollowStatus(followState, market, baseDecision, decision), plannedBuy, decision);
    if (!decision.eligible) excluded += 1;
    const state = marketState(market, { bought, skipped, pending, openWindowSeconds, decision, displayDecision });
    const boughtInfo = bought.get(key);
    const displayChoices = plannedBuy?.outcomes?.length ?? plannedChoices;
    const displayStakePerOutcome = Number(plannedBuy?.stakePerOutcomeUsdt ?? plannedStakePerOutcome);
    const choices = state === "已买" && boughtInfo?.outcomeCount > 0
      ? boughtInfo.outcomeCount
      : Math.min(displayChoices, market.outcomes?.length ?? 0);
    const plannedStake = plannedBuy
      ? dashboardPlannedBuyTotalStake(plannedBuy, displayStakePerOutcome, market.outcomes?.length ?? 0)
      : displayStakePerOutcome * Math.min(displayChoices, market.outcomes?.length ?? 0);
    const stake = state === "已买" && boughtInfo?.amount > 0 ? boughtInfo.amount : plannedStake;
    rows.push({
      title: market.question,
      address: market.address,
      category: firstCategory(market),
      createdAt: market.createdAt,
      startsAt: market.startDate,
      endsAt: market.endDate,
      matchStartsAt: dashboardMatchStartAt(market, plannedBuy, cfg),
      timeGroup: marketTimeGroup(market),
      duration: durationText(market),
      durationHours: durationHoursValue(market),
      categories: market.categories ?? [],
      rawTags: market.tags ?? [],
      tags: marketTags(market, decision, pending, cfg, displayDecision),
      filterReason: decision.eligible ? "" : decision.reasonText,
      displayReason: displayDecision.reasonText,
      notify: displayDecision.notify,
      choices,
      stake: money(stake),
      stakeValue: stake,
      state,
      tone: marketTone(state),
      eligible: decision.eligible,
      follow
    });
  }

  return {
    count: rows.length,
    excluded,
    items: rows
      .sort(compareDashboardMarketRows)
      .slice(0, Number(process.env.DASHBOARD_MARKET_ROWS ?? 80))
  };
}

function dashboardPlannedBuyDecision(decision, plannedBuy) {
  if (!plannedBuy) return decision;
  if (["missing-market", "status", "no-outcomes", "follow-blocked"].includes(decision?.reason)) {
    return decision;
  }
  return {
    ...decision,
    eligible: true,
    reason: "planned-buy",
    reasonText: "计划买入",
    tags: [...new Set([...(decision?.tags ?? []), "计划买入"])]
  };
}

function dashboardPlannedBuyFollow(follow, plannedBuy, decision) {
  if (!plannedBuy || !decision?.eligible || follow?.manuallyBlocked) return follow;
  return {
    ...follow,
    allowed: true,
    source: follow?.source === "none" ? "planned" : follow?.source,
    label: follow?.label === "未关注" ? "计划买入" : follow?.label
  };
}

function readDashboardPlannedBuys(cfg) {
  const file = cfg?.eventPlannedBuysFile;
  if (!file) return [];
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.plans) ? json.plans : []);
    return rows.map(normalizeDashboardPlannedBuy).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeDashboardPlannedBuy(row) {
  if (!row || typeof row !== "object") return null;
  const outcomes = Array.isArray(row.outcomes ?? row.outcomeNames ?? row.names)
    ? (row.outcomes ?? row.outcomeNames ?? row.names).map((item) => String(item).trim()).filter(Boolean)
    : String(row.outcomes ?? row.outcomeNames ?? row.names ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (outcomes.length === 0) return null;
  const market = normAddress(row.market ?? row.address);
  const question = normQuestion(row.question ?? row.title);
  const questionRegex = normQuestionRegex(row.questionRegex ?? row.titleRegex);
  if (!market && !question && !questionRegex) return null;
  const stakePerOutcomeUsdt = Number(row.stakePerOutcomeUsdt ?? row.stake ?? row.stakeUsdt);
  const stakeByOutcomeUsdt = normalizeDashboardStakeByOutcome(
    row.stakeByOutcomeUsdt ?? row.outcomeStakesUsdt ?? row.stakesByOutcome,
    outcomes
  );
  const kickoffAt = normalizeDashboardDate(row.kickoffAt ?? row.marketStartAt ?? row.matchStartAt);
  return {
    id: String(row.id ?? "").trim() || null,
    enabled: row.enabled !== false && row.disabled !== true,
    market,
    question,
    questionRegex,
    outcomes,
    stakePerOutcomeUsdt: Number.isFinite(stakePerOutcomeUsdt) && stakePerOutcomeUsdt > 0 ? stakePerOutcomeUsdt : null,
    stakeByOutcomeUsdt,
    openBroadcastDelayMs: normalizeDashboardNonNegativeNumber(row.openBroadcastDelayMs),
    gasPriceGwei: normalizeDashboardPositiveNumber(row.gasPriceGwei),
    builderBundle: normalizeDashboardBuilderBundle(row.builderBundle),
    autoSell: normalizeDashboardPlannedAutoSell(row.autoSell, outcomes),
    kickoffAt
  };
}

function normalizeDashboardStakeByOutcome(value, outcomes = []) {
  if (!value || typeof value !== "object") return {};
  const entries = Array.isArray(value)
    ? value.map((row) => [row?.outcome ?? row?.name, row?.stakeUsdt ?? row?.amountUsdt ?? row?.stake])
    : Object.entries(value);
  const selectedByKey = new Map(outcomes.map((outcome) => [normQuestion(outcome), outcome]));
  const result = {};
  for (const [rawOutcome, rawStake] of entries) {
    const selectedOutcome = selectedByKey.get(normQuestion(rawOutcome));
    const stakeUsdt = Number(rawStake);
    if (!selectedOutcome || !Number.isFinite(stakeUsdt) || stakeUsdt <= 0) continue;
    result[selectedOutcome] = stakeUsdt;
  }
  return result;
}

function dashboardPlannedBuyTotalStake(plan, fallbackStake, availableOutcomeCount) {
  const selected = (plan?.outcomes ?? []).slice(0, Math.min(plan?.outcomes?.length ?? 0, availableOutcomeCount));
  return selected.reduce((sum, outcome) => (
    sum + Number(plan?.stakeByOutcomeUsdt?.[outcome] ?? fallbackStake)
  ), 0);
}

function normalizeDashboardPlannedAutoSell(value, outcomes = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    priceTargets: normalizeDashboardPriceTargets(value.priceTargets, outcomes),
    priceHotPollMs: normalizeDashboardPositiveNumber(value.priceHotPollMs),
    priceHotWindowSeconds: normalizeDashboardPositiveNumber(value.priceHotWindowSeconds),
    priceSellPercent: normalizeDashboardPositiveNumber(value.priceSellPercent),
    priceApplyAfterIso: normalizeDashboardDate(value.priceApplyAfterIso),
    stopLossEnabled: value.stopLossEnabled === true
  };
}

function normalizeDashboardBuilderBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    enabled: value.enabled === true,
    mode: String(value.mode ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_"),
    timingMode: String(value.timingMode ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_"),
    tipBnb: String(value.tipBnb ?? "").trim() || null,
    prepositionLeadMs: normalizeDashboardNonNegativeNumber(value.prepositionLeadMs),
    noMerge: value.noMerge === true,
    positionFirst: value.positionFirst === true
  };
}

function normalizeDashboardNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeDashboardPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function findDashboardPlannedBuy(plans, market) {
  return plans.find((plan) => plan.enabled && dashboardPlannedBuyMatches(plan, market)) ?? null;
}

function dashboardPlannedBuyMatches(plan, market) {
  if (!plan || !market) return false;
  const marketAddress = normAddress(market?.address);
  const marketQuestion = normQuestion(market?.question);
  const marketQuestionText = String(market?.question ?? "").trim().replace(/\s+/gu, " ");
  if (plan.market && marketAddress && plan.market === marketAddress) return true;
  if (plan.question && marketQuestion && plan.question === marketQuestion) return true;
  return Boolean(plan.questionRegex && marketQuestionText && questionRegexMatches(plan.questionRegex, marketQuestionText));
}

function normQuestion(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function normQuestionRegex(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    new RegExp(text, "iu");
    return text;
  } catch {
    return "";
  }
}

function questionRegexMatches(pattern, question) {
  try {
    return new RegExp(pattern, "iu").test(question);
  } catch {
    return false;
  }
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeDashboardDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function dashboardMatchStartAt(market, plannedBuy = null, cfg = readConfig()) {
  if (plannedBuy?.kickoffAt) return plannedBuy.kickoffAt;
  if (!isSportsExactScoreMarket(market)) return null;
  const endOffsetSeconds = Number(cfg.autoSellMarketStartEndOffsetSeconds ?? 0);
  if (endOffsetSeconds <= 0) return null;
  const endMs = Date.parse(market?.endDate ?? market?.endsAt ?? "");
  if (!Number.isFinite(endMs)) return null;
  return new Date(endMs - endOffsetSeconds * 1000).toISOString();
}

function buildProjectBoard(marketFeed, holdings, walletActivity, followState, cfg = readConfig(), gasSummary = null) {
  const openGroups = new Map((holdings.groups ?? []).map((group) => [normAddress(group.market), group]));
  const ledger = buildTradeLedger(walletActivity);
  const plannedBuys = readDashboardPlannedBuys(cfg);
  const active = new Map();

  for (const item of marketFeed.items ?? []) {
    if (item.timeGroup !== "future") continue;
    if (!item.follow?.allowed && !item.follow?.manuallyFollowed) continue;
    upsertProjectBoardItem(active, item.address, {
      market: item.address,
      title: item.title,
      category: item.category,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      matchStartsAt: item.matchStartsAt,
      duration: item.duration,
      state: item.state,
      source: item.follow?.source ?? "default",
      follow: item.follow,
      stake: item.stake,
      choices: item.choices,
      holding: openGroups.get(normAddress(item.address)) ?? null
    });
  }

  for (const record of Object.values(followState.followed ?? {})) {
    const key = normAddress(record.market);
    if (active.has(key)) continue;
    const plannedBuy = findDashboardPlannedBuy(plannedBuys, { address: record.market, question: record.title });
    upsertProjectBoardItem(active, record.market, {
      market: record.market,
      title: record.title,
      category: record.category,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      matchStartsAt: plannedBuy?.kickoffAt ?? null,
      duration: "",
      state: "等待发现",
      source: "manual",
      follow: {
        allowed: true,
        defaultFollowed: false,
        manuallyFollowed: true,
        manuallyBlocked: false,
        source: "manual",
        label: "手动关注"
      },
      stake: "",
      choices: "",
      holding: openGroups.get(key) ?? null
    });
  }

  for (const group of holdings.groups ?? []) {
    upsertProjectBoardItem(active, group.market, {
      market: group.market,
      title: group.title,
      category: group.category ?? "",
      startsAt: group.startsAt ?? "",
      endsAt: group.endsAt ?? "",
      matchStartsAt: group.matchStartsAt ?? "",
      duration: "",
      state: "持仓中",
      source: "holding",
      follow: {
        allowed: true,
        defaultFollowed: false,
        manuallyFollowed: Boolean(followState.followed?.[normAddress(group.market)]),
        manuallyBlocked: Boolean(followState.blocked?.[normAddress(group.market)]),
        source: "holding",
        label: "有持仓"
      },
      stake: "",
      choices: group.items.length,
      holding: group
    });
  }

  const openKeys = new Set((holdings.groups ?? []).map((group) => normAddress(group.market)));
  const activeKeys = new Set(active.keys());
  const history = [];
  for (const trade of ledger.markets.values()) {
    const key = normAddress(trade.marketAddress);
    if (!key || openKeys.has(key)) continue;
    const bought = Number(trade.bought ?? 0);
    if (bought <= 0) continue;
    if (activeKeys.has(key)) active.delete(key);
    const sold = Number(trade.sold ?? 0);
    const realized = Number(trade.realized ?? 0);
    const gas = gasForMarket(gasSummary, trade.marketAddress);
    const gasUsdt = Number(gas.gasFeeUsdt ?? 0);
    const netRealized = realized - gasUsdt;
    const plannedBuy = findDashboardPlannedBuy(plannedBuys, { address: trade.marketAddress, question: trade.title });
    history.push({
      market: trade.marketAddress,
      title: trade.title || trade.marketAddress,
      category: trade.category ?? "",
      startsAt: trade.startsAt ?? "",
      endsAt: trade.endsAt ?? "",
      matchStartsAt: plannedBuy?.kickoffAt ?? dashboardMatchStartAt({
        question: trade.title,
        startDate: trade.startsAt,
        endDate: trade.endsAt,
        categories: trade.categories ?? [],
        tags: trade.tags ?? []
      }, plannedBuy, cfg),
      bought: money(bought),
      sold: money(sold),
      realized: money(realized, { sign: true }),
      grossPnl: money(realized, { sign: true }),
      gas: money(gasUsdt),
      gasBnb: money(gas.gasFeeBnb, { decimals: 6 }),
      pnl: money(netRealized, { sign: true }),
      roi: pct(bought > 0 ? (netRealized / bought) * 100 : 0),
      positive: netRealized >= 0,
      lastAt: trade.lastAt ?? null,
      items: historyOutcomeItems(ledger, key, gasSummary)
    });
  }

  return {
    count: active.size,
    active: [...active.values()].map(formatProjectBoardItem).sort(compareProjectBoardItems),
    history: history.sort((a, b) => safeTime(b.lastAt) - safeTime(a.lastAt)).slice(0, 80)
  };
}

function upsertProjectBoardItem(map, market, input) {
  const key = normAddress(market);
  if (!key) return;
  const existing = map.get(key) ?? {};
  map.set(key, {
    ...existing,
    ...input,
    title: input.title || existing.title,
    category: input.category || existing.category || "",
    startsAt: input.startsAt || existing.startsAt || "",
    endsAt: input.endsAt || existing.endsAt || "",
    matchStartsAt: input.matchStartsAt || existing.matchStartsAt || "",
    duration: input.duration || existing.duration || "",
    stake: input.stake || existing.stake || "",
    choices: input.choices || existing.choices || "",
    holding: input.holding ?? existing.holding ?? null,
    follow: input.follow ?? existing.follow ?? null
  });
}

function formatProjectBoardItem(item) {
  const holding = item.holding;
  return {
    market: item.market,
    title: item.title || holding?.title || "未命名项目",
    category: item.category || "",
    startsAt: item.startsAt || "",
    endsAt: item.endsAt || "",
    matchStartsAt: item.matchStartsAt || "",
    duration: item.duration || "",
    state: holding ? "持仓中" : item.state,
    source: item.source,
    follow: item.follow,
    stake: item.stake,
    choices: item.choices,
    holding: holding ? {
      cost: holding.cost,
      sold: holding.sold,
      value: holding.value,
      realized: holding.realized,
      unrealized: holding.unrealized,
      grossPnl: holding.grossPnl,
      gas: holding.gas,
      gasBnb: holding.gasBnb,
      pnl: holding.pnl,
      roi: holding.roi,
      positive: holding.positive,
      sellable: holding.sellable,
      sellableCount: holding.sellableCount,
      items: holding.items
    } : null
  };
}

function compareProjectBoardItems(a, b) {
  const holdingDelta = Number(Boolean(b.holding)) - Number(Boolean(a.holding));
  if (holdingDelta !== 0) return holdingDelta;
  return safeTime(a.startsAt) - safeTime(b.startsAt);
}

function historyOutcomeItems(ledger, marketKey, gasSummary = null) {
  return [...ledger.outcomes.values()]
    .filter((outcome) => normAddress(outcome.marketAddress) === marketKey)
    .filter((outcome) => Number(outcome.bought ?? 0) > 0)
    .sort((a, b) => safeTime(b.lastAt) - safeTime(a.lastAt))
    .map((outcome) => {
      const bought = Number(outcome.bought ?? 0);
      const sold = Number(outcome.sold ?? 0);
      const realized = Number(outcome.realized ?? 0);
      const gas = gasForOutcome(gasSummary, outcome.marketAddress, outcome.tokenId);
      const gasUsdt = Number(gas.gasFeeUsdt ?? 0);
      const netPnl = realized - gasUsdt;
      return {
        tokenId: outcome.tokenId ?? "",
        outcome: outcome.outcome || outcome.tokenId || "选项",
        buyPrice: price(outcome.boughtSize > 0 ? outcome.buyPriceCost / outcome.boughtSize : 0),
        bought: money(bought),
        sold: money(sold),
        realized: money(realized, { sign: true }),
        gas: money(gasUsdt),
        gasBnb: money(gas.gasFeeBnb),
        grossPnl: money(realized, { sign: true }),
        pnl: money(netPnl, { sign: true }),
        roi: pct(bought > 0 ? (netPnl / bought) * 100 : 0),
        positive: netPnl >= 0,
        lastAt: outcome.lastAt ?? null
      };
    });
}

function boughtMarketSummary(walletRows, localRows) {
  const chain = new Map();
  const local = new Map();
  for (const row of walletRows) {
    if (String(row.type ?? "").toUpperCase() === "MINT" && row.marketAddress) {
      const item = ensureBoughtSummary(chain, row.marketAddress);
      item.amount += num(row.collateral);
      if (row.tokenId !== undefined && row.tokenId !== null) item.outcomes.add(String(row.tokenId));
      const tx = normHash(row.transactionHash ?? row.tx);
      if (tx) item.txs.add(tx);
    }
  }
  for (const row of localRows) {
    if (!["买入成功", "等待确认"].includes(row.label) || !row.market) continue;
    const item = ensureBoughtSummary(local, row.market);
    const tx = normHash(row.tx);
    const entryKey = tx || `${row.label}:${row.at}:${row.amount}`;
    const entry = item.entries.get(entryKey) ?? { tx, amount: 0, confirmed: false };
    entry.amount = Math.max(entry.amount, parseUsdtAmount(row.amount));
    entry.confirmed = entry.confirmed || row.label === "买入成功";
    item.entries.set(entryKey, entry);
    item.outcomeCount = Math.max(item.outcomeCount, Number(row.outcomeCount ?? 0));
  }
  const result = new Map();
  for (const key of new Set([...chain.keys(), ...local.keys()])) {
    const chainItem = chain.get(key);
    const localItem = local.get(key);
    const chainAmount = chainItem?.amount ?? 0;
    const localAmount = [...(localItem?.entries.values() ?? [])].reduce((total, entry) => {
      if (entry.confirmed || (entry.tx && chainItem?.txs.has(entry.tx))) return total + entry.amount;
      return total;
    }, 0);
    if (chainAmount <= 0 && localAmount <= 0) continue;
    result.set(key, {
      amount: localAmount > 0 ? localAmount : chainAmount,
      outcomeCount: chainItem?.outcomes.size || localItem?.outcomeCount || 0
    });
  }
  return result;
}

function ensureBoughtSummary(map, market) {
  const key = normAddress(market);
  if (!map.has(key)) {
    map.set(key, {
      amount: 0,
      outcomes: new Set(),
      txs: new Set(),
      entries: new Map(),
      outcomeCount: 0
    });
  }
  return map.get(key);
}

function parseUsdtAmount(value) {
  const parsed = String(value ?? "").match(/-?\d+(?:\.\d+)?/u)?.[0];
  return num(parsed);
}

function skippedMarketSet(localRows) {
  const set = new Set();
  for (const row of localRows) {
    if (row.label === "已跳过" && row.market) set.add(normAddress(row.market));
  }
  return set;
}

function marketState(market, { bought, skipped, pending, openWindowSeconds, decision, displayDecision = null }) {
  const key = normAddress(market.address);
  if (bought.has(key)) return "已买";
  if (skipped.has(key)) return "已跳过";
  if (decision?.reason === "follow-blocked") return "禁止买入";
  if (!decision?.eligible) return displayDecision?.visible ? "观察" : "已过滤";
  if (pending?.fundingState === "funded") return "待买";
  if (pending?.fundingState === "insufficient-funds") return "资金不足";
  if (pending) return pending.prepared ? "已准备" : "待准备";
  const ageMs = Date.now() - new Date(market.startDate).getTime();
  if (!Number.isFinite(ageMs)) return "观察";
  if (ageMs < 0) return "等待";
  if (ageMs <= openWindowSeconds * 1000) return "窗口内";
  return "已错过";
}

function marketTone(state) {
  if (state === "已买" || state === "已准备" || state === "待买") return "good";
  if (state === "窗口内" || state === "待准备" || state === "资金不足") return "warn";
  if (state === "已错过" || state === "禁止买入") return "bad";
  return "neutral";
}

function marketTags(market, decision, pending, cfg, displayDecision = null) {
  const tags = [];
  for (const tag of displayDecision?.tags ?? []) tags.push(tag);
  if (displayDecision?.notify) tags.push("飞书通知");
  if (decision.reason === "short-duration") tags.push(`短于${minDurationLabel(cfg)}`);
  if (decision.reason === "missing-time") tags.push("缺少时间");
  if (decision.reason === "price-market" || isPriceMarket(market, cfg)) tags.push("Price");
  if (decision.follow?.manuallyBlocked) tags.push("禁止买入");
  if (decision.follow?.manuallyFollowed) tags.push("手动关注");
  if (decision.follow?.defaultFollowed && !decision.follow?.manuallyFollowed) tags.push("默认关注");
  if (decision.reason === "planned-buy") tags.push("计划买入");
  if (decision.eligible) tags.push("符合买入");
  if (pending?.fundingState === "funded") tags.push("当前可买");
  if (pending?.fundingState === "insufficient-funds") tags.push("资金不足");
  const category = firstCategory(market);
  if (category) tags.push(category);
  return [...new Set(tags)];
}

function minDurationLabel(cfg) {
  const hours = Number(cfg.minEventDurationHours ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) return "";
  if (hours % 24 === 0 && hours > 72) return `${hours / 24}天`;
  return `${roundDisplay(hours, 0)}h`;
}

function compareDashboardMarketRows(a, b) {
  const groupDelta = marketTimeGroupRank(a.timeGroup) - marketTimeGroupRank(b.timeGroup);
  if (groupDelta !== 0) return groupDelta;

  const startDelta = a.timeGroup === "future"
    ? safeTime(a.startsAt) - safeTime(b.startsAt)
    : safeTime(b.startsAt) - safeTime(a.startsAt);
  if (startDelta !== 0) return startDelta;

  const stateRank = {
    "待买": 0,
    "已准备": 1,
    "待准备": 2,
    "资金不足": 3,
    "窗口内": 4,
    "已过滤": 5,
    "已买": 6,
    "已跳过": 7,
    "已错过": 8
  };
  const rankDelta = (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9);
  if (rankDelta !== 0) return rankDelta;
  return safeTime(b.createdAt) - safeTime(a.createdAt);
}

function marketTimeGroup(market) {
  const startsAt = safeTime(market?.startDate ?? market?.startsAt);
  if (!startsAt) return "unknown";
  return startsAt > Date.now() ? "future" : "past";
}

function marketTimeGroupRank(group) {
  if (group === "future") return 0;
  if (group === "past") return 1;
  return 2;
}

function safeTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function firstCategory(market) {
  return market.categories?.find((item) => item !== "Price") ?? market.tags?.[0] ?? "";
}

function durationText(market) {
  const duration = eventDurationMs(market);
  if (!Number.isFinite(duration) || duration <= 0) return "--";
  const hours = duration / 3600000;
  if (hours >= 24) {
    const days = hours / 24;
    return `${roundDisplay(days, days >= 10 ? 0 : 1)} 天`;
  }
  return `${roundDisplay(hours, 1)} 小时`;
}

function durationHoursValue(market) {
  const duration = eventDurationMs(market);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return Math.round((duration / 3600000) * 1000) / 1000;
}

function roundDisplay(value, decimals = 2) {
  return Number(value).toFixed(decimals).replace(/\.0+$|(\.\d*?)0+$/u, "$1");
}

function normalizeHoldings(raw, activityRows = [], cfg = readConfig(), gasSummary = null) {
  const rows = raw.positions ?? [];
  const ledger = buildTradeLedger(activityRows);
  const groups = new Map();
  for (const row of rows) {
    const key = row.marketAddress;
    if (!groups.has(key)) {
      groups.set(key, {
        market: row.marketAddress,
        title: row.question,
        invested: 0,
        remainingCost: 0,
        sold: 0,
        value: 0,
        realized: 0,
        unrealized: 0,
        totalPnl: 0,
        startsAt: row.startDate ?? row.startsAt ?? null,
        endsAt: row.endDate ?? row.endsAt ?? null,
        matchStartsAt: row.kickoffAt ?? row.matchStartAt ?? null,
        categories: row.categories ?? [],
        tags: row.tags ?? [],
        items: []
      });
    }
    const group = groups.get(key);
    if (!group.startsAt && (row.startDate || row.startsAt)) group.startsAt = row.startDate ?? row.startsAt;
    if (!group.endsAt && (row.endDate || row.endsAt)) group.endsAt = row.endDate ?? row.endsAt;
    if (!group.matchStartsAt && (row.kickoffAt || row.matchStartAt)) group.matchStartsAt = row.kickoffAt ?? row.matchStartAt;
    group.categories = uniqueStrings([...(group.categories ?? []), ...(row.categories ?? [])]);
    group.tags = uniqueStrings([...(group.tags ?? []), ...(row.tags ?? [])]);
    const trade = ledger.outcomes.get(outcomeLedgerKey(row.marketAddress, row.tokenId));
    const remainingCost = num(row.costBasisUsdt);
    const value = num(row.markValueUsdt);
    const unrealized = num(row.cashPnlUsdt);
    const invested = trade?.bought > 0 ? trade.bought : remainingCost;
    const sold = trade?.sold ?? 0;
    const realized = trade?.realized ?? num(row.realizedPnlUsdt);
    const grossPnl = realized + unrealized;
    const gas = gasForOutcome(gasSummary, row.marketAddress, row.tokenId);
    const gasUsdt = Number(gas.gasFeeUsdt ?? 0);
    const totalPnl = grossPnl - gasUsdt;
    group.invested += invested;
    group.remainingCost += remainingCost;
    group.sold += sold;
    group.value += value;
    group.realized += realized;
    group.unrealized += unrealized;
    group.totalPnl += grossPnl;
    group.items.push({
      market: row.marketAddress,
      tokenId: row.tokenId,
      title: row.question,
      outcome: row.outcome,
      chips: chips(row.size),
      buyPrice: price(row.avgPrice),
      nowPrice: price(row.curPrice),
      cost: money(invested),
      remainingCost: money(remainingCost),
      sold: money(sold),
      value: money(value),
      realized: money(realized, { sign: true }),
      unrealized: money(unrealized, { sign: true }),
      grossPnl: money(grossPnl, { sign: true }),
      gas: money(gasUsdt),
      gasBnb: money(gas.gasFeeBnb),
      pnl: money(totalPnl, { sign: true }),
      pnlPct: pct(invested > 0 ? (totalPnl / invested) * 100 : 0),
      positive: totalPnl >= 0,
      sellable: !row.isFinalized
    });
  }
  const finalizedGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      matchStartsAt: group.matchStartsAt ?? dashboardMatchStartAt({
        question: group.title,
        startDate: group.startsAt,
        endDate: group.endsAt,
        categories: group.categories ?? [],
        tags: group.tags ?? [],
        outcomes: group.items.map((item) => ({ name: item.outcome }))
      }, null, cfg)
    }))
    .map((group) => finalizeHoldingGroup(group, ledger, gasSummary));
  const totals = finalizedGroups.reduce((acc, group) => {
    acc.invested += group.invested;
    acc.remainingCost += group.remainingCost;
    acc.sold += group.sold;
    acc.value += group.value;
    acc.realized += group.realized;
    acc.unrealized += group.unrealized;
    acc.totalPnl += group.totalPnl;
    acc.grossPnl += group.grossPnl;
    acc.gasUsdt += group.gasUsdt;
    acc.gasBnb += group.gasBnb;
    return acc;
  }, {
    invested: 0,
    remainingCost: 0,
    sold: 0,
    value: 0,
    realized: 0,
    unrealized: 0,
    totalPnl: 0,
    grossPnl: 0,
    gasUsdt: 0,
    gasBnb: 0
  });
  return {
    count: rows.length,
    totals: {
      cost: money(totals.invested),
      remainingCost: money(totals.remainingCost),
      sold: money(totals.sold),
      value: money(totals.value),
      realized: money(totals.realized, { sign: true }),
      unrealized: money(totals.unrealized, { sign: true }),
      grossPnl: money(totals.grossPnl, { sign: true }),
      gas: money(totals.gasUsdt),
      gasBnb: money(totals.gasBnb),
      pnl: money(totals.totalPnl, { sign: true }),
      positive: totals.totalPnl >= 0
    },
    groups: finalizedGroups.map(formatHoldingGroup)
  };
}

function finalizeHoldingGroup(group, ledger, gasSummary = null) {
  const marketTrade = ledger.markets.get(normAddress(group.market));
  const invested = marketTrade?.bought > 0 ? marketTrade.bought : group.invested;
  const sold = marketTrade?.sold ?? group.sold;
  const realized = marketTrade ? marketTrade.realized : group.realized;
  const grossPnl = realized + group.unrealized;
  const gas = gasForMarket(gasSummary, group.market);
  const gasUsdt = Number(gas.gasFeeUsdt ?? 0);
  const gasBnb = Number(gas.gasFeeBnb ?? 0);
  const totalPnl = grossPnl - gasUsdt;
  return {
    ...group,
    invested,
    sold,
    realized,
    grossPnl,
    gasUsdt,
    gasBnb,
    totalPnl
  };
}

function formatHoldingGroup(group) {
  const sellableCount = group.items.filter((item) => item.sellable).length;
  return {
    ...group,
    startsAt: group.startsAt ?? "",
    endsAt: group.endsAt ?? "",
    matchStartsAt: group.matchStartsAt ?? "",
    category: group.categories?.[0] ?? "",
    cost: money(group.invested),
    remainingCost: money(group.remainingCost),
    sold: money(group.sold),
    value: money(group.value),
    realized: money(group.realized, { sign: true }),
    unrealized: money(group.unrealized, { sign: true }),
    grossPnl: money(group.grossPnl, { sign: true }),
    gas: money(group.gasUsdt),
    gasBnb: money(group.gasBnb),
    pnl: money(group.totalPnl, { sign: true }),
    roi: pct(group.invested > 0 ? (group.totalPnl / group.invested) * 100 : 0),
    positive: group.totalPnl >= 0,
    sellable: sellableCount > 0,
    sellableCount
  };
}

function buildAnalytics(rawPositions, activityRows, gasSummary = null) {
  const positions = rawPositions.positions ?? [];
  const projects = new Map();
  const ledger = buildTradeLedger(activityRows);
  const totals = {
    bought: 0,
    sold: 0,
    realized: 0,
    openCost: 0,
    openValue: 0,
    openPnl: 0,
    gasUsdt: Number(gasSummary?.totalGasFeeUsdt ?? 0),
    gasBnb: Number(gasSummary?.totalGasFeeBnb ?? 0),
    unpricedGasBnb: Number(gasSummary?.unpricedGasFeeBnb ?? 0)
  };

  for (const row of positions) {
    const project = getProject(projects, row.marketAddress, row.question);
    const openCost = num(row.costBasisUsdt);
    const openValue = num(row.markValueUsdt);
    const openPnl = num(row.cashPnlUsdt);
    project.openCost += openCost;
    project.openValue += openValue;
    project.openPnl += openPnl;
    totals.openCost += openCost;
    totals.openValue += openValue;
    totals.openPnl += openPnl;
  }

  for (const trade of ledger.markets.values()) {
    const project = getProject(projects, trade.marketAddress, trade.title);
    project.bought += trade.bought;
    project.sold += trade.sold;
    project.realized += trade.realized;
    const gas = gasForMarket(gasSummary, trade.marketAddress);
    project.gasUsdt = Number(gas.gasFeeUsdt ?? 0);
    project.gasBnb = Number(gas.gasFeeBnb ?? 0);
    if (safeTime(trade.lastAt) > safeTime(project.lastAt)) project.lastAt = trade.lastAt;
    totals.bought += trade.bought;
    totals.sold += trade.sold;
    totals.realized += trade.realized;
  }

  const grossTotalPnl = totals.realized + totals.openPnl;
  const totalPnl = grossTotalPnl - totals.gasUsdt;
  const invested = totals.bought > 0 ? totals.bought : totals.openCost;
  const cards = {
    invested: money(invested),
    openCost: money(totals.openCost),
    openValue: money(totals.openValue),
    openPnl: money(totals.openPnl, { sign: true }),
    openPositive: totals.openPnl >= 0,
    totalBought: money(totals.bought),
    totalSold: money(totals.sold),
    realizedPnl: money(totals.realized, { sign: true }),
    unrealizedPnl: money(totals.openPnl, { sign: true }),
    grossPnl: money(grossTotalPnl, { sign: true }),
    gasFee: money(totals.gasUsdt),
    gasFeeBnb: money(totals.gasBnb),
    unpricedGasFeeBnb: money(totals.unpricedGasBnb),
    gasTxCount: Number(gasSummary?.txCount ?? 0),
    totalPnl: money(totalPnl, { sign: true }),
    totalPositive: totalPnl >= 0,
    realizedPositive: totals.realized >= 0,
    unrealizedPositive: totals.openPnl >= 0,
    totalRoi: pct(invested > 0 ? (totalPnl / invested) * 100 : 0)
  };

  return {
    cards,
    projects: [...projects.values()]
      .map((project) => normalizeProject(project))
      .sort(compareAnalyticsProjects)
      .slice(0, 12)
  };
}

function compareAnalyticsProjects(a, b) {
  const timeDelta = safeTime(b.lastAt) - safeTime(a.lastAt);
  if (timeDelta !== 0) return timeDelta;
  return Math.abs(b.pnlValue) - Math.abs(a.pnlValue);
}

function getProject(projects, key, title) {
  const projectKey = key || title || "unknown";
  if (!projects.has(projectKey)) {
    projects.set(projectKey, {
      title: title || "未命名项目",
      bought: 0,
      sold: 0,
      realized: 0,
      openCost: 0,
      openValue: 0,
      openPnl: 0,
      gasUsdt: 0,
      gasBnb: 0,
      lastAt: null
    });
  }
  const project = projects.get(projectKey);
  if (!project.title && title) project.title = title;
  return project;
}

function normalizeProject(project) {
  const grossPnl = project.realized + project.openPnl;
  const gasUsdt = Number(project.gasUsdt ?? 0);
  const pnl = grossPnl - gasUsdt;
  const invested = project.bought > 0 ? project.bought : project.openCost;
  return {
    title: project.title,
    bought: money(project.bought),
    sold: money(project.sold),
    openCost: money(project.openCost),
    openValue: money(project.openValue),
    realized: money(project.realized, { sign: true }),
    unrealized: money(project.openPnl, { sign: true }),
    grossPnl: money(grossPnl, { sign: true }),
    gas: money(gasUsdt),
    gasBnb: money(project.gasBnb),
    pnl: money(pnl, { sign: true }),
    pnlValue: pnl,
    lastAt: project.lastAt ?? null,
    positive: pnl >= 0,
    realizedPositive: project.realized >= 0,
    unrealizedPositive: project.openPnl >= 0,
    roi: pct(invested > 0 ? (pnl / invested) * 100 : 0)
  };
}

async function buildAggregatePnl(baseCfg = readConfig()) {
  if (!aggregatePnlEnabled) return null;
  const profiles = resolveAggregatePnlProfiles(baseCfg);
  if (profiles.length === 0) return null;

  const profileResults = await Promise.all(profiles.map((profile) => buildAggregateProfilePnl(profile, baseCfg)));
  const daily = new Map();
  const totals = {
    bought: 0,
    sold: 0,
    realized: 0,
    openValue: 0,
    openPnl: 0,
    gasUsdt: 0,
    gasBnb: 0,
    unpricedGasBnb: 0,
    txCount: 0
  };

  for (const profile of profileResults) {
    totals.bought += profile.values.bought;
    totals.sold += profile.values.sold;
    totals.realized += profile.values.realized;
    totals.openValue += profile.values.openValue;
    totals.openPnl += profile.values.openPnl;
    totals.gasUsdt += profile.values.gasUsdt;
    totals.gasBnb += profile.values.gasBnb;
    totals.unpricedGasBnb += profile.values.unpricedGasBnb;
    totals.txCount += profile.values.txCount;
    for (const [day, value] of profile.daily.entries()) {
      daily.set(day, (daily.get(day) ?? 0) + value);
    }
  }

  const realizedNet = totals.realized - totals.gasUsdt;
  const totalNet = realizedNet + totals.openPnl;
  const invested = totals.bought;
  const todayKey = dashboardDayKey(new Date(), aggregatePnlTimeZone);
  const series = aggregatePnlSeries(daily, todayKey);

  return {
    enabled: true,
    title: "Bot1-Bot5 总净盈亏",
    timeZone: aggregatePnlTimeZone,
    updatedAt: new Date().toISOString(),
    cards: {
      totalNet: money(totalNet, { sign: true }),
      totalNetValue: roundMoney(totalNet),
      totalPositive: totalNet >= 0,
      realizedNet: money(realizedNet, { sign: true }),
      realizedNetValue: roundMoney(realizedNet),
      realizedPositive: realizedNet >= 0,
      dailyNet: money(daily.get(todayKey) ?? 0, { sign: true }),
      dailyNetValue: roundMoney(daily.get(todayKey) ?? 0),
      dailyPositive: (daily.get(todayKey) ?? 0) >= 0,
      openPnl: money(totals.openPnl, { sign: true }),
      openPnlValue: roundMoney(totals.openPnl),
      openPositive: totals.openPnl >= 0,
      gasFee: money(totals.gasUsdt),
      gasFeeValue: roundMoney(totals.gasUsdt),
      gasFeeBnb: money(totals.gasBnb),
      unpricedGasFeeBnb: money(totals.unpricedGasBnb),
      gasTxCount: totals.txCount,
      roi: pct(invested > 0 ? (totalNet / invested) * 100 : 0)
    },
    profiles: profileResults.map((profile) => ({
      label: profile.label,
      wallet: shortAddress(profile.wallet),
      netPnl: money(profile.values.netPnl, { sign: true }),
      netPnlValue: roundMoney(profile.values.netPnl),
      positive: profile.values.netPnl >= 0,
      realizedNet: money(profile.values.realizedNet, { sign: true }),
      openPnl: money(profile.values.openPnl, { sign: true }),
      gas: money(profile.values.gasUsdt),
      txCount: profile.values.txCount,
      ok: profile.errors.length === 0,
      warning: profile.errors.join("；")
    })),
    series: series.map((row) => ({
      ...row,
      dailyNetText: money(row.dailyNet, { sign: true }),
      cumulativeNetText: money(row.cumulativeNet, { sign: true })
    })),
    warnings: profileResults.flatMap((profile) => profile.errors.map((error) => `${profile.label}: ${error}`))
  };
}

function resolveAggregatePnlProfiles(baseCfg) {
  return defaultAggregatePnlProfiles().map((spec) => {
    const fileEnv = readEnvFileSafe(spec.envFile);
    const env = { ...(spec.current ? currentProfileAggregateEnv(baseCfg) : {}), ...fileEnv };
    const runtimeConfigFile = resolveDashboardPath(
      env.RUNTIME_CONFIG_FILE,
      spec.current ? baseCfg.runtimeConfigFile : path.join(spec.dataDir, "runtime-config.json")
    );
    const dataDir = path.dirname(runtimeConfigFile);
    const wallet = String(env.DASHBOARD_WALLET ?? env.WALLET_ADDRESS ?? "").trim();
    if (!wallet) return null;
    return {
      id: spec.id,
      label: spec.label,
      wallet,
      restUrl: env.FORTYTWO_REST_URL || baseCfg.restUrl,
      activitySince: env.DASHBOARD_ACTIVITY_SINCE ?? "",
      fillsFile: resolveDashboardPath(env.FILLS_FILE, path.join(dataDir, "fills.jsonl")),
      actionsFile: resolveDashboardPath(env.DASHBOARD_ACTIONS_FILE, path.join(dataDir, "dashboard-actions.jsonl")),
      gasLedgerFile: resolveDashboardPath(env.GAS_LEDGER_FILE, path.join(dataDir, "gas-ledger.jsonl"))
    };
  }).filter(Boolean);
}

function defaultAggregatePnlProfiles() {
  return [
    {
      id: "42space",
      label: "Bot1",
      envFile: "/etc/42space/profiles/42space.env",
      dataDir: "/opt/42space/data/42space",
      current: true
    },
    {
      id: "42space-2",
      label: "Bot2",
      envFile: "/etc/42space/profiles/42space-2.env",
      dataDir: "/opt/42space/data/42space-2"
    },
    {
      id: "42space-3",
      label: "Bot3",
      envFile: "/etc/42space/profiles/42space-3.env",
      dataDir: "/opt/42space/data/42space-3"
    },
    {
      id: "42space-4",
      label: "Bot4",
      envFile: "/etc/42space/profiles/42space-4.env",
      dataDir: "/opt/42space/data/42space-4"
    },
    {
      id: "42space-5",
      label: "Bot5",
      envFile: "/etc/42space/profiles/42space-5.env",
      dataDir: "/opt/42space/data/42space-5"
    }
  ];
}

function currentProfileAggregateEnv(baseCfg) {
  return {
    BOT_NAME: baseCfg.botName ?? appName,
    DASHBOARD_WALLET: botWallet,
    WALLET_ADDRESS: baseCfg.walletAddress,
    FORTYTWO_REST_URL: baseCfg.restUrl,
    RUNTIME_CONFIG_FILE: baseCfg.runtimeConfigFile,
    FILLS_FILE: baseCfg.fillsFile,
    DASHBOARD_ACTIONS_FILE: actionsFile,
    GAS_LEDGER_FILE: gasLedgerFileForConfig(baseCfg),
    DASHBOARD_ACTIVITY_SINCE: dashboardActivitySince
  };
}

async function buildAggregateProfilePnl(profile, baseCfg) {
  const errors = [];
  const cfg = { ...baseCfg, restUrl: profile.restUrl };
  const [activityResult, positionsResult] = await Promise.all([
    safeProfileFetch(() => fetchActivity(cfg, {
      user: profile.wallet,
      limit: aggregatePnlActivityLimit
    }), "activity"),
    safeProfileFetch(() => fetchOpenPositions(cfg, {
      user: profile.wallet,
      limit: aggregatePnlPositionLimit
    }), "positions")
  ]);
  if (activityResult.error) errors.push(activityResult.error);
  if (positionsResult.error) errors.push(positionsResult.error);

  const activityRows = filterActivitySince(activityResult.rows, profile.activitySince);
  const positions = positionsResult.rows;
  const gasEntries = filterGasSince(
    dedupeGasEntries(readGasLedger(profile.gasLedgerFile, { limit: aggregatePnlGasLimit })),
    profile.activitySince
  );
  const gasSummary = buildGasSummary(gasEntries);
  const ledger = buildTradeLedger(activityRows);
  const daily = profileDailyNet(activityRows, gasEntries);
  const totals = [...ledger.markets.values()].reduce((acc, trade) => {
    acc.bought += Number(trade.bought ?? 0);
    acc.sold += Number(trade.sold ?? 0);
    acc.realized += Number(trade.realized ?? 0);
    return acc;
  }, { bought: 0, sold: 0, realized: 0, openValue: 0, openPnl: 0 });
  for (const row of positions) {
    totals.openValue += aggregatePositionMarkValue(row);
    totals.openPnl += aggregatePositionCashPnl(row);
  }

  const gasUsdt = Number(gasSummary.totalGasFeeUsdt ?? 0);
  const realizedNet = totals.realized - gasUsdt;
  const netPnl = realizedNet + totals.openPnl;
  return {
    label: profile.label,
    wallet: profile.wallet,
    errors,
    daily,
    values: {
      bought: totals.bought,
      sold: totals.sold,
      realized: totals.realized,
      openValue: totals.openValue,
      openPnl: totals.openPnl,
      gasUsdt,
      gasBnb: Number(gasSummary.totalGasFeeBnb ?? 0),
      unpricedGasBnb: Number(gasSummary.unpricedGasFeeBnb ?? 0),
      txCount: Number(gasSummary.txCount ?? 0),
      realizedNet,
      netPnl
    }
  };
}

function aggregatePositionCostBasis(row) {
  return num(row.costBasisUsdt ?? row.costBasis);
}

function aggregatePositionCashPnl(row) {
  return num(row.cashPnlUsdt ?? row.cashPnl);
}

function aggregatePositionMarkValue(row) {
  if (row.markValueUsdt !== undefined && row.markValueUsdt !== null) return num(row.markValueUsdt);
  return aggregatePositionCostBasis(row) + aggregatePositionCashPnl(row);
}

async function safeProfileFetch(fn, label) {
  try {
    const rows = await fn();
    return { rows: Array.isArray(rows) ? rows : [] };
  } catch (error) {
    return { rows: [], error: `${label} 读取失败：${cleanError(error)}` };
  }
}

function profileDailyNet(activityRows, gasEntries) {
  const daily = new Map();
  for (const row of activityRows) {
    const type = String(row.type ?? "").toUpperCase();
    if (!isLedgerExitType(type)) continue;
    const day = dashboardDayKey(activityRowTime(row), aggregatePnlTimeZone);
    if (!day) continue;
    daily.set(day, (daily.get(day) ?? 0) + num(row.realizedPnlDelta));
  }
  for (const entry of gasEntries) {
    const gasUsdt = Number(entry.totalFeeUsdt ?? entry.gasFeeUsdt ?? 0);
    if (!Number.isFinite(gasUsdt) || gasUsdt <= 0) continue;
    const day = dashboardDayKey(entry.blockTime ?? entry.at, aggregatePnlTimeZone);
    if (!day) continue;
    daily.set(day, (daily.get(day) ?? 0) - gasUsdt);
  }
  return daily;
}

function aggregatePnlSeries(daily, todayKey) {
  if (daily.size === 0) return [];
  const keys = [...daily.keys()].sort();
  const firstKey = keys[0];
  const lastKey = [keys.at(-1), todayKey].filter(Boolean).sort().at(-1);
  const rows = [];
  let cumulative = 0;
  for (const day of enumerateDayKeys(firstKey, lastKey)) {
    const dailyNet = daily.get(day) ?? 0;
    cumulative += dailyNet;
    rows.push({
      date: day,
      label: day.slice(5).replace("-", "/"),
      dailyNet: roundMoney(dailyNet),
      cumulativeNet: roundMoney(cumulative)
    });
  }
  const maxDays = Number.isFinite(aggregatePnlDays) && aggregatePnlDays > 0 ? aggregatePnlDays : 90;
  return rows.slice(-maxDays);
}

function enumerateDayKeys(startKey, endKey) {
  const start = Date.parse(`${startKey}T00:00:00Z`);
  const end = Date.parse(`${endKey}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const days = [];
  for (let time = start; time <= end; time += 86400000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

function dashboardDayKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function filterGasSince(rows, since) {
  const cutoffMs = Date.parse(String(since ?? ""));
  if (!Number.isFinite(cutoffMs)) return rows;
  return rows.filter((row) => {
    const time = Date.parse(row?.blockTime ?? row?.at ?? "");
    return Number.isFinite(time) && time >= cutoffMs;
  });
}

function dedupeGasEntries(entries = []) {
  const byTx = new Map();
  for (const entry of entries) {
    const txHash = normHash(entry?.txHash);
    if (!txHash) continue;
    const current = byTx.get(txHash);
    if (!current || preferDashboardGasEntry(entry, current)) byTx.set(txHash, entry);
  }
  return [...byTx.values()];
}

function preferDashboardGasEntry(candidate, current) {
  const candidateExtra = Number(candidate?.extraFeeBnb ?? 0);
  const currentExtra = Number(current?.extraFeeBnb ?? 0);
  if (candidateExtra > 0 && currentExtra <= 0) return true;
  if (candidateExtra <= 0 && currentExtra > 0) return false;
  const candidateUsdt = Number(candidate?.totalFeeUsdt ?? candidate?.gasFeeUsdt ?? 0);
  const currentUsdt = Number(current?.totalFeeUsdt ?? current?.gasFeeUsdt ?? 0);
  if (candidateUsdt > 0 && currentUsdt <= 0) return true;
  if (candidateUsdt <= 0 && currentUsdt > 0) return false;
  return safeTime(candidate?.at) >= safeTime(current?.at);
}

function readEnvFileSafe(file) {
  if (!file || !fs.existsSync(file)) return {};
  const result = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const key = match[1];
    if (![
      "BOT_NAME",
      "DASHBOARD_WALLET",
      "WALLET_ADDRESS",
      "FORTYTWO_REST_URL",
      "RUNTIME_CONFIG_FILE",
      "FILLS_FILE",
      "DASHBOARD_ACTIONS_FILE",
      "GAS_LEDGER_FILE",
      "DASHBOARD_ACTIVITY_SINCE"
    ].includes(key)) continue;
    result[key] = parseEnvFileValue(match[2]);
  }
  return result;
}

function parseEnvFileValue(value) {
  const trimmed = String(value ?? "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveDashboardPath(value, fallback) {
  const selected = String(value ?? fallback ?? "").trim();
  if (!selected) return "";
  return path.isAbsolute(selected) ? selected : path.resolve(rootDir, selected);
}

function shortAddress(value) {
  const text = String(value ?? "").trim();
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function buildTradeLedger(activityRows = []) {
  const markets = new Map();
  const outcomes = new Map();
  for (const row of activityRows) {
    const type = String(row.type ?? "").toUpperCase();
    if (!isLedgerBuyType(type) && !isLedgerExitType(type)) continue;
    const marketKey = normAddress(row.marketAddress ?? row.market);
    if (!marketKey) continue;
    const market = ensureTradeRecord(markets, marketKey, {
      marketAddress: row.marketAddress ?? row.market,
      title: row.title,
      startsAt: row.startDate ?? row.startsAt ?? row.market?.startDate ?? row.question?.startDate ?? null,
      endsAt: row.endDate ?? row.endsAt ?? row.market?.endDate ?? row.question?.endDate ?? null,
      categories: row.categories ?? row.market?.categories ?? row.question?.categories ?? [],
      tags: row.tags ?? row.market?.tags ?? row.question?.tags ?? []
    });
    const outcomeKey = outcomeLedgerKey(row.marketAddress ?? row.market, row.tokenId);
    const outcome = ensureTradeRecord(outcomes, outcomeKey, {
      marketAddress: row.marketAddress ?? row.market,
      title: row.title,
      tokenId: row.tokenId,
      outcome: row.outcome,
      startsAt: row.startDate ?? row.startsAt ?? row.market?.startDate ?? row.question?.startDate ?? null,
      endsAt: row.endDate ?? row.endsAt ?? row.market?.endDate ?? row.question?.endDate ?? null
    });
    const collateral = num(row.collateral);
    const realized = num(row.realizedPnlDelta);
    if (isLedgerBuyType(type)) {
      const size = num(row.size);
      const tradePrice = num(row.tradePrice);
      const priceCost = size > 0 && tradePrice > 0 ? size * tradePrice : collateral;
      market.bought += collateral;
      outcome.bought += collateral;
      outcome.boughtSize += size;
      outcome.buyPriceCost += priceCost;
    } else {
      market.sold += collateral;
      market.realized += realized;
      outcome.sold += collateral;
      outcome.realized += realized;
    }
    const at = row.timestamp ? new Date(Number(row.timestamp) * 1000).toISOString() : row.at;
    if (at && safeTime(at) > safeTime(market.lastAt)) market.lastAt = at;
    if (at && safeTime(at) > safeTime(outcome.lastAt)) outcome.lastAt = at;
  }
  return { markets, outcomes };
}

function isLedgerBuyType(type) {
  return type === "MINT";
}

function isLedgerExitType(type) {
  return type === "REDEEM" || type === "FINALISE" || type === "FINALIZE";
}

function ensureTradeRecord(map, key, initial = {}) {
  if (!map.has(key)) {
    map.set(key, {
      ...initial,
      bought: 0,
      boughtSize: 0,
      buyPriceCost: 0,
      sold: 0,
      realized: 0
    });
  }
  const record = map.get(key);
  if (!record.title && initial.title) record.title = initial.title;
  if (!record.outcome && initial.outcome) record.outcome = initial.outcome;
  if (!record.tokenId && initial.tokenId) record.tokenId = initial.tokenId;
  if (!record.startsAt && initial.startsAt) record.startsAt = initial.startsAt;
  if (!record.endsAt && initial.endsAt) record.endsAt = initial.endsAt;
  record.categories = uniqueStrings([...(record.categories ?? []), ...(initial.categories ?? [])]);
  record.tags = uniqueStrings([...(record.tags ?? []), ...(initial.tags ?? [])]);
  return record;
}

function outcomeLedgerKey(market, tokenId) {
  return `${normAddress(market)}:${String(tokenId ?? "")}`;
}

function normalizeSellQuote(result) {
  const positions = result.positions ?? [];
  const item = positions[0];
  const quote = item?.quote ?? {};
  const isAll = positions.length > 1;
  return {
    title: item?.question ?? "持仓",
    outcome: isAll ? `${positions.length} 个选项` : item?.outcome ?? "",
    balanceOt: isAll ? "" : money(quote.balanceOt),
    sellAmountOt: isAll ? "" : money(quote.sellAmountOt),
    percent: quote.percent ?? null,
    positionCount: positions.length,
    expected: money(result.totals?.expectedCollateralToUserUsdt),
    minimum: money(result.totals?.minCollateralOutUsdt),
    fee: money(result.totals?.collateralToIntegratorUsdt),
    needsApproval: Number(result.totals?.positionsNeedingOperatorApproval ?? 0) > 0
  };
}

function normalizeSellExecution(result) {
  const positions = result.positions ?? [];
  const executions = result.executions ?? [];
  const item = positions[0];
  const execution = executions[0] ?? {};
  const successCount = executions.filter((row) => row.status === "success" || row.txHash).length;
  return {
    status: successCount > 0 ? "已提交" : "已处理",
    title: item?.question ?? "持仓",
    outcome: positions.length > 1 ? `${positions.length} 个选项` : item?.outcome ?? "",
    receivedText: money(result.totals?.expectedCollateralToUserUsdt),
    txHash: execution.txHash ?? null,
    txHashes: executions.map((row) => row.txHash).filter(Boolean),
    operatorApprovalHash: execution.operatorApprovalHash ?? null,
    blockNumber: execution.blockNumber ?? null,
    market: execution.market ?? item?.marketAddress ?? null,
    tokenId: execution.tokenId ?? item?.tokenId ?? null
  };
}

function normalizeActivity(rows, walletRows = []) {
  const chainRows = normalizeWalletActivity(walletRows);
  const localRows = rows.map((row) => ({
    source: "local",
    time: row.at,
    label: row.label,
    title: row.title,
    amount: activityAmount(row.amount)
  }));
  const deduped = [];
  for (const row of [...chainRows, ...localRows]
    .filter((row) => row.time && row.title)
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())) {
    const index = deduped.findIndex((existing) => isSameActivity(existing, row));
    if (index >= 0) {
      if (row.source === "chain" && deduped[index].source !== "chain") deduped[index] = row;
      continue;
    }
    deduped.push(row);
  }
  return deduped.slice(0, 24).map(({ source, ...row }) => row);
}

function normalizeWalletActivity(rows) {
  const groupedBuys = new Map();
  const groupedSettlements = new Map();
  const normalized = [];
  for (const row of rows) {
    const type = String(row.type ?? "").toUpperCase();
    const time = row.timestamp ? new Date(Number(row.timestamp) * 1000).toISOString() : null;
    if (!time) continue;
    if (isLedgerBuyType(type)) {
      const key = row.transactionHash || `${row.title}:${row.timestamp}`;
      const group = groupedBuys.get(key) ?? {
        source: "chain",
        time,
        label: "买入",
        title: row.title,
        amountValue: 0
      };
      group.amountValue += num(row.collateral);
      groupedBuys.set(key, group);
      continue;
    }
    if (type === "REDEEM") {
      normalized.push({
        source: "chain",
        time,
        label: "卖出",
        title: [row.title, row.outcome].filter(Boolean).join(" / "),
        amount: row.collateral ? `${money(row.collateral)} U` : ""
      });
    }
    if (type === "FINALISE" || type === "FINALIZE") {
      const key = row.transactionHash || `${row.title}:${row.timestamp}`;
      const group = groupedSettlements.get(key) ?? {
        source: "chain",
        time,
        label: "结算",
        title: row.title,
        collateral: 0,
        realized: 0
      };
      group.collateral += num(row.collateral);
      group.realized += num(row.realizedPnlDelta);
      groupedSettlements.set(key, group);
    }
  }
  for (const group of groupedBuys.values()) {
    normalized.push({
      source: "chain",
      time: group.time,
      label: group.label,
      title: group.title,
      amount: `${money(group.amountValue)} U`
    });
  }
  for (const group of groupedSettlements.values()) {
    normalized.push({
      source: "chain",
      time: group.time,
      label: group.label,
      title: group.title,
      amount: `收回 ${money(group.collateral)} U / 盈亏 ${money(group.realized, { sign: true })} U`
    });
  }
  return normalized;
}

function isSameActivity(a, b) {
  const deltaMs = Math.abs(new Date(a.time).getTime() - new Date(b.time).getTime());
  return activityLabel(a.label) === activityLabel(b.label) && a.title === b.title && deltaMs < 60000;
}

function activityLabel(label) {
  return label === "买入成功" ? "买入" : label;
}

function activityAmount(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = String(value);
  if (/\bU\b/.test(text)) return text;
  return /^-?\d+(?:\.\d+)?$/.test(text) ? `${text} U` : text;
}

function readRecentActivity() {
  const rows = [];
  for (const row of readJsonl(fillsFile, Number(process.env.DASHBOARD_FILL_HISTORY_LIMIT ?? 2000))) {
    if (row.level === "event-skip-open-window") {
      rows.push({ at: row.at, label: "已跳过", title: row.question, market: row.market, amount: "" });
      continue;
    }
    if (row.level === "event-skip-follow-blocked") {
      rows.push({ at: row.at, label: "禁止买入", title: row.question, market: row.market, amount: "" });
      continue;
    }
    if (row.level === "event-execution-error") {
      rows.push({ at: row.at, label: "买入失败", title: row.question, market: row.market, amount: "" });
      continue;
    }
    if (row.level === "event-receipt") {
      rows.push({
        at: row.at,
        label: row.status === "success" ? "买入成功" : "未成交",
        title: row.context?.question ?? "交易",
        market: row.context?.market,
        tx: row.txHash,
        amount: ""
      });
      continue;
    }
    if (row.plan && row.result && !row.result.dryRun) {
      rows.push({
        at: row.at,
        label: row.result.status === "success" ? "买入成功" : "等待确认",
        title: row.plan.market?.question,
        market: row.plan.market?.address,
        tx: row.result.txHash,
        outcomeCount: row.plan.outcomes?.length,
        amount: row.plan.totalStakeUsdt ? `${money(row.plan.totalStakeUsdt)} U` : ""
      });
      continue;
    }
    if (row.bundle && row.result && !row.result.dryRun) {
      rows.push({
        at: row.at,
        label: row.result.status === "success" ? "买入成功" : "等待确认",
        title: `${row.bundle.marketCount ?? row.result.marketCount ?? 0} 场批量买入`,
        tx: row.result.txHash,
        amount: row.bundle.totalStakeUsdt ? `${money(row.bundle.totalStakeUsdt)} U` : ""
      });
      continue;
    }
    if (row.level === "event-auto-sell") {
      const actions = Array.isArray(row.actions) ? row.actions : (row.action ? [row.action] : []);
      const first = actions[0] ?? {};
      rows.push({
        at: row.at,
        label: "自动卖出",
        title: [first.question ?? "持仓", actions.length > 1 ? `${actions.length} 个选项` : first.outcome].filter(Boolean).join(" / "),
        tx: row.execution?.txHash,
        amount: actions.length > 1 ? `${actions.length} 个选项` : first.sellAmountOt ?? first.percent ?? ""
      });
    }
  }
  for (const row of readJsonl(actionsFile, 80)) {
    rows.push({
      at: row.at,
      label: row.type === "sell" ? (row.source === "manual-dashboard" ? "手动卖出" : "卖出") : "操作",
      title: [row.question, row.outcome].filter(Boolean).join(" / "),
      tx: row.txHash,
      amount: row.amount
    });
  }
  return rows
    .filter((row) => row.at && row.title)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

async function getBotState() {
  if (process.platform !== "darwin") return getSystemdBotState();

  try {
    const uid = String(process.getuid?.() ?? 501);
    const { stdout } = await execFileAsync("launchctl", ["print", `gui/${uid}/${launchLabel}`], { timeoutMs: 5000 });
    const state = stdout.match(/state = ([^\n]+)/)?.[1]?.trim() ?? "";
    return {
      running: state === "running",
      message: state === "running" ? "运行中" : "未运行"
    };
  } catch {
    return { running: false, message: "未运行" };
  }
}

async function getSystemdBotState() {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "show",
      systemdService,
      "--property=ActiveState,SubState,MainPID,NRestarts,ActiveEnterTimestamp,ControlGroup",
      "--no-pager"
    ], { timeoutMs: 5000 });
    const properties = Object.fromEntries(stdout.trim().split(/\r?\n/).map((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ""];
    }));
    const activeState = properties.ActiveState ?? "";
    const subState = properties.SubState ?? "";
    const running = activeState === "active" && subState === "running";
    return {
      running,
      message: running ? "运行中" : "未运行",
      activeState,
      subState,
      pid: Number(properties.MainPID ?? 0) || null,
      restartCount: Number(properties.NRestarts ?? 0) || 0,
      controlGroup: properties.ControlGroup || null,
      activeSince: properties.ActiveEnterTimestamp && properties.ActiveEnterTimestamp !== "n/a"
        ? properties.ActiveEnterTimestamp
        : null
    };
  } catch {
    return { running: false, message: "未运行" };
  }
}

async function fetchUserActivity() {
  if (!botWallet) return [];
  try {
    const cfg = readConfig();
    const rows = await fetchActivity(cfg, {
      user: botWallet,
      limit: Number(process.env.DASHBOARD_ACTIVITY_LIMIT ?? 500)
    });
    return filterActivitySince(rows, dashboardActivitySince);
  } catch {
    return [];
  }
}

function filterActivitySince(rows, since) {
  const cutoffMs = Date.parse(String(since ?? ""));
  if (!Number.isFinite(cutoffMs)) return rows;
  return rows.filter((row) => activityRowTime(row) >= cutoffMs);
}

function activityRowTime(row) {
  const timestamp = Number(row?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp * 1000;
  const at = Date.parse(row?.at ?? row?.createdAt ?? row?.updatedAt ?? "");
  return Number.isFinite(at) ? at : 0;
}

async function fetchNewMarketsFeed() {
  try {
    const cfg = readConfig();
    return await fetchMarkets(cfg, {
      status: "all",
      topic: "",
      order: "created_at",
      ascending: false,
      limit: Number(process.env.DASHBOARD_NEW_MARKETS_LIMIT ?? 500)
    });
  } catch {
    return [];
  }
}

async function runEvent(args, { timeoutMs = 30000, env = {} } = {}) {
  const script = path.join(rootDir, "src/event-sniper.js");
  const childEnv = {
    NO_GUI_PROMPT: "1",
    ...(dashboardChildLowPriority ? {
      DASHBOARD_CHILD_LOW_PRIORITY: "1",
      DASHBOARD_CHILD_NICE: String(dashboardChildNice)
    } : {}),
    ...env
  };
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    cwd: rootDir,
    timeoutMs,
    env: { ...process.env, ...childEnv }
  });
  const parsed = parseLastJson(stdout);
  if (!parsed) throw new Error("No data returned");
  return parsed;
}

function envBool(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function execFileAsync(command, args, { timeoutMs = 30000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...options, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        error.message = cleanError(`${error.message}\n${stderr || stdout}`);
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Request timed out"));
    }, timeoutMs);
  });
}

function parseLastJson(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const raw = text.slice(start, i + 1);
        try {
          objects.push(JSON.parse(raw));
        } catch {
          // Ignore non-JSON log fragments.
        }
        start = -1;
      }
    }
  }
  return objects.at(-1) ?? null;
}

function readJsonl(file, limit) {
  if (!fs.existsSync(file)) return [];
  const lines = readTextTail(file, Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 4194304))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function safeReadJson(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readTextTail(file, maxBytes) {
  const stat = fs.statSync(file);
  if (stat.size === 0) return "";
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
  return text;
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function serveStatic(res, pathname) {
  const safe = path.normalize(pathname.replace(/^\/assets\//, ""));
  if (safe.startsWith("..")) return sendJson(res, { ok: false }, 404);
  const file = path.join(publicDir, "assets", safe);
  const ext = path.extname(file);
  const type = ext === ".css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
  return serveFile(res, file, type);
}

function serveFile(res, file, type) {
  if (!fs.existsSync(file)) return sendJson(res, { ok: false }, 404);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(fs.readFileSync(file));
}

function money(value, { sign = false } = {}) {
  const num = Number(value ?? 0);
  const prefix = sign && num > 0 ? "+" : "";
  const raw = num.toFixed(Math.abs(num) >= 10 ? 2 : 4).replace(/\.?0+$/, "");
  const clean = raw === "-0" ? "0" : raw;
  return `${prefix}${clean}`;
}

function price(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num <= 0) return "--";
  if (num < 0.01) return num.toFixed(4);
  if (num < 1) return num.toFixed(3).replace(/\.?0+$/, "");
  return num.toFixed(2).replace(/\.?0+$/, "");
}

function payoutText(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num <= 0) return "--";
  return `${price(num)}x`;
}

function oddsText(outcome) {
  if (outcome?.payout !== undefined && outcome?.payout !== null && outcome.payout !== "") {
    return payoutText(outcome.payout);
  }
  const priceValue = Number(outcome?.price);
  if (Number.isFinite(priceValue) && priceValue > 0) return `~${price(1 / priceValue)}x`;
  return "--";
}

function sortOutcomesForDashboard(outcomes = []) {
  return [...outcomes].sort((a, b) => {
    try {
      const delta = BigInt(a.tokenId ?? 0) - BigInt(b.tokenId ?? 0);
      return delta < 0n ? -1 : (delta > 0n ? 1 : 0);
    } catch {
      return String(a.tokenId ?? "").localeCompare(String(b.tokenId ?? ""));
    }
  });
}

function chips(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num >= 1000) return num.toFixed(0);
  if (num >= 10) return num.toFixed(2).replace(/\.?0+$/, "");
  return num.toFixed(4).replace(/\.?0+$/, "");
}

function pct(value) {
  const num = Number(value ?? 0);
  const prefix = num > 0 ? "+" : "";
  return `${prefix}${num.toFixed(1)}%`;
}

function num(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normAddress(value) {
  return String(value ?? "").toLowerCase();
}

function normHash(value) {
  return value ? String(value).toLowerCase() : "";
}

function watchedAddressActivityKey(address, txHash) {
  return `${normAddress(address)}:${normHash(txHash)}`;
}

function compareWatchedAddressRows(a, b) {
  const blockDelta = Number(b.blockNumber ?? 0) - Number(a.blockNumber ?? 0);
  if (blockDelta !== 0) return blockDelta;
  const txDelta = Number(b.transactionIndex ?? 0) - Number(a.transactionIndex ?? 0);
  if (txDelta !== 0) return txDelta;
  const logDelta = Number(b.logIndex ?? 0) - Number(a.logIndex ?? 0);
  if (logDelta !== 0) return logDelta;
  return safeTime(b.at ?? b.seenAt) - safeTime(a.at ?? a.seenAt);
}

function watchedDirectionsText(directions = []) {
  const set = new Set(directions);
  if (set.has("in") && set.has("out")) return "转入/转出";
  if (set.has("in")) return "转入";
  if (set.has("out")) return "转出";
  return "相关";
}

function watchedAmountText(row) {
  const sent = Number(row.sentUsdt ?? 0);
  const received = Number(row.receivedUsdt ?? 0);
  const net = Number(row.netUsdt ?? received - sent);
  if (sent > 0 && received > 0) return `出 ${money(sent)} U / 入 ${money(received)} U / 净 ${money(net, { sign: true })} U`;
  if (sent > 0) return `出 ${money(sent)} U`;
  if (received > 0) return `入 ${money(received)} U`;
  return row.tokenTransferCount ? `Token Transfer x${row.tokenTransferCount}` : (row.direct ? "原生交易" : "");
}

function getAddressOrNull(value) {
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function addressOrFallback(value, fallback) {
  return getAddressOrNull(value) ?? String(fallback ?? value ?? "");
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

function rpcBlockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function parseBlockNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return Number(BigInt(value));
  } catch {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
}

function numberFromTokenUnits(value, decimals) {
  try {
    return Number(formatUnits(BigInt(value), decimals));
  } catch {
    return 0;
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

function maxNumber(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? right : null;
  if (!Number.isFinite(right)) return left;
  return Math.max(left, right);
}

function minNullableNumber(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? right : null;
  if (!Number.isFinite(right)) return left;
  return Math.min(left, right);
}

function minBigInt(a, b) {
  return a < b ? a : b;
}

function toBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function newestIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return safeTime(b) >= safeTime(a) ? b : a;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function pruneMap(map, maxSize) {
  while (map.size > maxSize) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function shortHash(value) {
  const text = String(value ?? "");
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
}

function cleanError(error) {
  return String(error?.message ?? error)
    .replace(/(?:https?|wss?):\/\/[^\s")]+/g, "[RPC]")
    .split("\n")
    .filter((line) => line.trim())
    .at(0) ?? "Error";
}
