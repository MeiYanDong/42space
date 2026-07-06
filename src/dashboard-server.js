#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadDotEnv, normalizeRuntimeConfig, readConfig, writeRuntimeConfig } from "./config.js";
import {
  eventDisplayFilterRuleLabels,
  eventDisplayFilterRuleOptions,
  normalizeEventDisplayFilterRules
} from "./event-display-rules.js";
import { fetchActivity, fetchMarket, fetchMarkets } from "./fortytwo.js";
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
    if (url.pathname === "/api/runtime-config" && req.method === "GET") {
      return sendJson(res, runtimeConfigPayload());
    }
    if (url.pathname === "/api/runtime-config" && req.method === "PUT") {
      return sendJson(res, await updateRuntimeConfig(req));
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
    evidence: evidenceSummary(),
    settings: {
      appName,
      runtimeConfig: runtimeConfigSummary(cfg, status.watchConfig),
      ruleSummary: botRuleSummary(cfg),
      stakeText: `${status.watchConfig?.eventOutcomeCount ?? cfg.eventOutcomeCount ?? 5} 档 / ${status.watchConfig?.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt ?? 5}U`,
      windowText: broadcastWindowText(status.watchConfig, cfg),
      autoSellText: autoSellText(status.watchConfig, cfg)
    }
  };
}

function evidenceSummary() {
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
  const normalizedBotName = String(cfg?.botName ?? appName).trim().toLowerCase();
  const normalizedProfileRole = String(cfg?.profileRole ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const isBot2 = normalizedBotName === "42space-2"
    || normalizedBotName === "bot2"
    || normalizedBotName.startsWith("bot2");
  const isBot5 = normalizedBotName === "42space-5"
    || normalizedBotName === "bot5"
    || normalizedBotName.startsWith("bot5")
    || normalizedBotName.includes("bot5");
  const isBot2Like = isBot2 || isBot5 || normalizedProfileRole === "bot2_like";
  const isBot3 = normalizedBotName === "42space-3"
    || normalizedBotName === "bot3"
    || normalizedBotName.startsWith("bot3");
  const isBot4 = normalizedBotName === "42space-4"
    || normalizedBotName === "bot4"
    || normalizedBotName.startsWith("bot4")
    || normalizedBotName.includes("bot4");
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
  const followRule = buyQuestionAllowlistEnabled
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
      : isBot2Like || isBot3
      ? `${isBot3 ? "Bot3" : isBot5 ? "Bot5" : "Bot2-like"} 飞书通知：所有未被基础过滤的新事件；过滤项不通知`
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

async function marketDetail(url) {
  const address = url.searchParams.get("market");
  if (!address) throw new Error("Missing market");
  const cfg = readConfig();
  const followState = readMarketFollowState(cfg.marketFollowFile);
  const market = await fetchMarket(cfg, address);
  const baseDecision = getBaseEventMarketDecision(market, cfg);
  const decision = getEventMarketDecision(market, { ...cfg, marketFollowState: followState });
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
      follow: marketFollowStatus(followState, market, baseDecision, decision),
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

function autoSellText(watchConfig, cfg) {
  const enabled = Boolean(watchConfig?.autoSellEnabled ?? cfg.autoSellEnabled);
  if (!enabled) return "关闭";
  const strategy = watchConfig?.autoSellStrategy ?? cfg.autoSellStrategy;
  if (strategy === "open_timed_exit") {
    const delay = watchConfig?.autoSellOpenExitDelaySeconds ?? cfg.autoSellOpenExitDelaySeconds ?? 36;
    const percent = watchConfig?.autoSellOpenExitPercent ?? cfg.autoSellOpenExitPercent ?? 100;
    return `开盘 T+${delay}s 卖 ${percent}% / ${autoSellStopLossText(watchConfig, cfg)}`;
  }
  if (strategy === "pre_start_exit") {
    const beforeStart = Number(watchConfig?.autoSellBeforeMarketStartSeconds ?? cfg.autoSellBeforeMarketStartSeconds ?? 0);
    const preStart = beforeStart > 0 ? `赛前 ${Math.round(beforeStart / 60)}min 清仓` : "赛前清仓未配置";
    return `持有不分批卖 / ${preStart} / ${autoSellStopLossText(watchConfig, cfg)}`;
  }
  if (strategy === "ladder") {
    const delay = watchConfig?.autoSellStartDelaySeconds ?? cfg.autoSellStartDelaySeconds;
    const interval = watchConfig?.autoSellIntervalSeconds ?? cfg.autoSellIntervalSeconds;
    const chunk = watchConfig?.autoSellChunkPercent ?? cfg.autoSellChunkPercent;
    const profit = Number(watchConfig?.autoSellLadderProfitPercent ?? cfg.autoSellLadderProfitPercent ?? 0);
    const takeProfitSteps = Number(watchConfig?.autoSellTakeProfitSteps ?? cfg.autoSellTakeProfitSteps ?? 0);
    const beforeStart = Number(watchConfig?.autoSellBeforeMarketStartSeconds ?? cfg.autoSellBeforeMarketStartSeconds ?? 0);
    const gate = profit > 0 ? `盈 ${profit}% 后` : `${delay}s 后`;
    const takeProfit = takeProfitSteps > 0
      ? `${gate}卖 ${chunk}% ${takeProfitSteps} 次`
      : `${gate}每 ${interval}s 卖 ${chunk}%`;
    const preStart = beforeStart > 0 ? ` / 赛前 ${Math.round(beforeStart / 60)}min 清剩余` : "";
    return `${takeProfit}${preStart} / ${autoSellStopLossText(watchConfig, cfg)}`;
  }
  const takeProfit = `${watchConfig?.autoSellProfitMultiplier ?? cfg.autoSellProfitMultiplier}x 卖 ${watchConfig?.autoSellPercent ?? cfg.autoSellPercent}%`;
  return `${takeProfit} / ${autoSellStopLossText(watchConfig, cfg)}`;
}

function autoSellStopLossText(watchConfig, cfg) {
  const enabled = Boolean(watchConfig?.autoSellStopLossEnabled ?? cfg.autoSellStopLossEnabled);
  if (!enabled) return "止损关闭";
  const percent = watchConfig?.autoSellStopLossPercent ?? cfg.autoSellStopLossPercent;
  const sellPercent = Number(watchConfig?.autoSellStopLossSellPercent ?? cfg.autoSellStopLossSellPercent ?? 100);
  return sellPercent >= 100 ? `亏 ${percent}% 全卖` : `亏 ${percent}% 卖 ${sellPercent}%`;
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
    const plannedStake = displayStakePerOutcome * Math.min(displayChoices, market.outcomes?.length ?? 0);
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
  if (["missing-market", "status", "no-outcomes", "price-market", "follow-blocked"].includes(decision?.reason)) {
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
  const kickoffAt = normalizeDashboardDate(row.kickoffAt ?? row.marketStartAt ?? row.matchStartAt);
  return {
    enabled: row.enabled !== false && row.disabled !== true,
    market,
    question,
    questionRegex,
    outcomes,
    stakePerOutcomeUsdt: Number.isFinite(stakePerOutcomeUsdt) && stakePerOutcomeUsdt > 0 ? stakePerOutcomeUsdt : null,
    kickoffAt
  };
}

function findDashboardPlannedBuy(plans, market) {
  const marketAddress = normAddress(market?.address);
  const marketQuestion = normQuestion(market?.question);
  const marketQuestionText = String(market?.question ?? "").trim().replace(/\s+/gu, " ");
  return plans.find((plan) => {
    if (!plan.enabled) return false;
    if (plan.market && marketAddress && plan.market === marketAddress) return true;
    if (plan.question && marketQuestion && plan.question === marketQuestion) return true;
    if (plan.questionRegex && marketQuestionText && questionRegexMatches(plan.questionRegex, marketQuestionText)) return true;
    return false;
  }) ?? null;
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
      "--property=ActiveState,SubState",
      "--value"
    ], { timeoutMs: 5000 });
    const [activeState = "", subState = ""] = stdout.trim().split(/\r?\n/);
    const running = activeState === "active" && subState === "running";
    return {
      running,
      message: running ? "运行中" : "未运行"
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

function cleanError(error) {
  return String(error?.message ?? error)
    .replace(/(?:https?|wss?):\/\/[^\s")]+/g, "[RPC]")
    .split("\n")
    .filter((line) => line.trim())
    .at(0) ?? "Error";
}
