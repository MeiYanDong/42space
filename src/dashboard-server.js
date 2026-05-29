#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadDotEnv, normalizeRuntimeConfig, readConfig, writeRuntimeConfig } from "./config.js";
import { fetchActivity, fetchMarket, fetchMarkets } from "./fortytwo.js";
import { eventDurationMs, getBaseEventMarketDecision, getEventMarketDecision, isEventMarket, isPriceMarket } from "./event-strategy.js";
import {
  blockMarket,
  blockMarkets,
  followMarket,
  followMarkets,
  marketFollowStatus,
  readMarketFollowState
} from "./market-follow.js";

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
const overviewCacheMs = Number(process.env.DASHBOARD_OVERVIEW_CACHE_MS ?? 30000);
const overviewStaleMs = Number(process.env.DASHBOARD_OVERVIEW_STALE_MS ?? 300000);
const overviewRefreshMs = Number(process.env.DASHBOARD_OVERVIEW_REFRESH_MS ?? 60000);
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
      return sendJson(res, await getOverview());
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
  void refreshOverviewCache().catch(logOverviewRefreshError);
  if (overviewRefreshMs > 0) {
    setInterval(() => {
      void refreshOverviewCache({ background: true }).catch(logOverviewRefreshError);
    }, overviewRefreshMs).unref();
  }
});

async function getOverview() {
  const now = Date.now();
  if (overviewCache && now - overviewCache.at < overviewCacheMs) return overviewCache.data;
  if (overviewCache && overviewHotWindowInfo(overviewCache.data, now)) return overviewCache.data;
  if (overviewCache && now - overviewCache.at < overviewStaleMs) {
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
  const holdings = normalizeHoldings(positions, walletActivity);
  const recentRows = readRecentActivity();
  const newMarketFeed = normalizeNewMarkets(newMarkets, status, walletActivity, recentRows, strategyCfg, followState);
  const analytics = buildAnalytics(positions, walletActivity);
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    bot: normalizeBot(bot, status),
    wallet: normalizeWallet(status.wallet),
    next: normalizeNext(status),
    manualSell: manualSellState(status, cfg),
    newMarkets: newMarketFeed,
    holdings,
    projectBoard: buildProjectBoard(newMarketFeed, holdings, walletActivity, followState),
    analytics,
    activity: normalizeActivity(recentRows, walletActivity),
    settings: {
      appName,
      runtimeConfig: runtimeConfigSummary(cfg, status.watchConfig),
      stakeText: `${status.watchConfig?.eventOutcomeCount ?? cfg.eventOutcomeCount ?? 5} 档 / ${status.watchConfig?.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt ?? 5}U`,
      windowText: `${status.watchConfig?.eventOpenWindowSeconds ?? 60}s`,
      autoSellText: autoSellText(status.watchConfig, cfg)
    }
  };
}

function runtimeConfigPayload() {
  const cfg = readConfig();
  return {
    ok: true,
    config: runtimeConfigSummary(cfg, null),
    editable: {
      filterModes: [
        { value: "price_only_test", label: "只过滤 Price" },
        { value: "production", label: "生产过滤" }
      ],
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
    autoSellStartDelaySeconds: Number(watchConfig?.autoSellStartDelaySeconds ?? cfg.autoSellStartDelaySeconds),
    autoSellIntervalSeconds: Number(watchConfig?.autoSellIntervalSeconds ?? cfg.autoSellIntervalSeconds),
    autoSellChunkPercent: Number(watchConfig?.autoSellChunkPercent ?? cfg.autoSellChunkPercent),
    autoSellStopLossEnabled: Boolean(watchConfig?.autoSellStopLossEnabled ?? cfg.autoSellStopLossEnabled),
    autoSellStopLossPercent: Number(watchConfig?.autoSellStopLossPercent ?? cfg.autoSellStopLossPercent),
    autoSellStopLossSellPercent: Number(watchConfig?.autoSellStopLossSellPercent ?? cfg.autoSellStopLossSellPercent),
    marketCategoryBlocklist: cfg.marketCategoryBlocklist ?? [],
    marketTagBlocklist: cfg.marketTagBlocklist ?? [],
    runtimeConfigFile: cfg.runtimeConfigFile,
    marketFollowFile: cfg.marketFollowFile
  };
}

async function updateRuntimeConfig(req) {
  const body = await readJsonBody(req);
  requireAdminToken(req, body);
  const isProduction = body.filterMode === "production";
  const input = {
    filterMode: body.filterMode,
    eventOutcomeCount: body.eventOutcomeCount,
    stakePerOutcomeUsdt: body.stakePerOutcomeUsdt,
    maxBatchStakeUsdt: body.maxBatchStakeUsdt,
    gasPriceGwei: body.gasPriceGwei,
    autoSellEnabled: body.autoSellEnabled,
    autoSellStartDelaySeconds: body.autoSellStartDelaySeconds,
    autoSellIntervalSeconds: body.autoSellIntervalSeconds,
    autoSellChunkPercent: body.autoSellChunkPercent,
    autoSellStopLossEnabled: body.autoSellStopLossEnabled,
    autoSellStopLossPercent: body.autoSellStopLossPercent,
    autoSellStopLossSellPercent: body.autoSellStopLossSellPercent,
    minEventDurationHours: isProduction ? (body.minEventDurationHours ?? 48) : 0,
    marketCategoryBlocklist: ["Price"],
    marketTagBlocklist: isProduction ? ["8 hour", "automated"] : ["Price"]
  };
  input.maxMarketStakeUsdt = roundMoney(Number(input.eventOutcomeCount) * Number(input.stakePerOutcomeUsdt));
  const config = normalizeRuntimeConfig(input, { partial: false });
  const cfg = readConfig();
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
  if (strategy === "ladder") {
    const delay = watchConfig?.autoSellStartDelaySeconds ?? cfg.autoSellStartDelaySeconds;
    const interval = watchConfig?.autoSellIntervalSeconds ?? cfg.autoSellIntervalSeconds;
    const chunk = watchConfig?.autoSellChunkPercent ?? cfg.autoSellChunkPercent;
    const stop = watchConfig?.autoSellStopLossPercent ?? cfg.autoSellStopLossPercent;
    return `${delay}s 后每 ${interval}s 卖 ${chunk}% / 亏 ${stop}% 全卖`;
  }
  const takeProfit = `${watchConfig?.autoSellProfitMultiplier ?? cfg.autoSellProfitMultiplier}x 卖 ${watchConfig?.autoSellPercent ?? cfg.autoSellPercent}%`;
  const stopLossEnabled = Boolean(watchConfig?.autoSellStopLossEnabled ?? cfg.autoSellStopLossEnabled);
  if (!stopLossEnabled) return takeProfit;
  return `${takeProfit} / 亏 ${watchConfig?.autoSellStopLossPercent ?? cfg.autoSellStopLossPercent}% 卖 ${watchConfig?.autoSellStopLossSellPercent ?? cfg.autoSellStopLossSellPercent}%`;
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
  const wallet = normalizeWallet(status.wallet);
  const waitingFunds = wallet && wallet.state === "blocked";
  const partialFunding = wallet?.state === "partial";
  return {
    running: bot.running,
    label: bot.running ? (waitingFunds ? "等待资金" : (partialFunding ? "部分可买" : "运行中")) : "未运行",
    tone: bot.running && !waitingFunds ? "good" : "warn",
    message: waitingFunds || partialFunding ? wallet.message : bot.message
  };
}

function normalizeWallet(wallet) {
  if (!wallet) return null;
  const executableMarketCount = Number(wallet.executableMarketCount ?? 0);
  const hasExecutableFunds = Boolean((wallet.balanceReady || executableMarketCount > 0) && wallet.bnbReady);
  const partial = Boolean(wallet.partialFunding);
  const state = hasExecutableFunds ? (partial ? "partial" : "all") : "blocked";
  const label = state === "all" ? "全部可买" : (state === "partial" ? "部分可买" : "不可买");
  return {
    busdt: money(wallet.busdtBalance),
    bnb: Number(wallet.bnbBalance ?? 0).toFixed(6),
    ready: hasExecutableFunds,
    partial,
    state,
    label,
    tone: state === "blocked" ? "warn" : "good",
    executableMarketCount,
    unfundedMarketCount: Number(wallet.unfundedMarketCount ?? 0),
    message: fundingMessage(wallet)
  };
}

function fundingMessage(wallet) {
  if (!wallet) return "";
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
  const rows = [];
  let excluded = 0;
  const plannedChoices = Number(status.watchConfig?.eventOutcomeCount ?? cfg.eventOutcomeCount ?? 5);
  const plannedStakePerOutcome = Number(status.watchConfig?.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt ?? 5);

  for (const market of markets) {
    const baseDecision = getBaseEventMarketDecision(market, cfg);
    const decision = getEventMarketDecision(market, cfg);
    if (!decision.eligible && !["short-duration", "missing-time", "price-market", "follow-blocked"].includes(decision.reason)) continue;
    const key = normAddress(market.address);
    const pending = future.get(key);
    const follow = marketFollowStatus(followState, market, baseDecision, decision);
    if (!decision.eligible) excluded += 1;
    const state = marketState(market, { bought, skipped, pending, openWindowSeconds, decision });
    const boughtInfo = bought.get(key);
    const choices = state === "已买" && boughtInfo?.outcomeCount > 0
      ? boughtInfo.outcomeCount
      : Math.min(plannedChoices, market.outcomes?.length ?? 0);
    const plannedStake = plannedStakePerOutcome * Math.min(plannedChoices, market.outcomes?.length ?? 0);
    const stake = state === "已买" && boughtInfo?.amount > 0 ? boughtInfo.amount : plannedStake;
    rows.push({
      title: market.question,
      address: market.address,
      category: firstCategory(market),
      createdAt: market.createdAt,
      startsAt: market.startDate,
      endsAt: market.endDate,
      timeGroup: marketTimeGroup(market),
      duration: durationText(market),
      durationHours: durationHoursValue(market),
      categories: market.categories ?? [],
      rawTags: market.tags ?? [],
      tags: marketTags(market, decision, pending, cfg),
      filterReason: decision.eligible ? "" : decision.reasonText,
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

function buildProjectBoard(marketFeed, holdings, walletActivity, followState) {
  const openGroups = new Map((holdings.groups ?? []).map((group) => [normAddress(group.market), group]));
  const ledger = buildTradeLedger(walletActivity);
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
    upsertProjectBoardItem(active, record.market, {
      market: record.market,
      title: record.title,
      category: record.category,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
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
      category: "",
      startsAt: "",
      endsAt: "",
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
    history.push({
      market: trade.marketAddress,
      title: trade.title || trade.marketAddress,
      bought: money(bought),
      sold: money(sold),
      realized: money(realized, { sign: true }),
      pnl: money(realized, { sign: true }),
      roi: pct(bought > 0 ? (realized / bought) * 100 : 0),
      positive: realized >= 0,
      lastAt: trade.lastAt ?? null
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
  const existing = map.get(key);
  map.set(key, {
    ...(existing ?? {}),
    ...input,
    holding: input.holding ?? existing?.holding ?? null,
    follow: input.follow ?? existing?.follow ?? null
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
      pnl: holding.pnl,
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

function marketState(market, { bought, skipped, pending, openWindowSeconds, decision }) {
  const key = normAddress(market.address);
  if (bought.has(key)) return "已买";
  if (skipped.has(key)) return "已跳过";
  if (decision?.reason === "follow-blocked") return "禁止买入";
  if (!decision?.eligible) return "已过滤";
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

function marketTags(market, decision, pending, cfg) {
  const tags = [];
  if (decision.reason === "short-duration") tags.push(`短于${minDurationLabel(cfg)}`);
  if (decision.reason === "missing-time") tags.push("缺少时间");
  if (decision.reason === "price-market" || isPriceMarket(market, cfg)) tags.push("Price");
  if (decision.follow?.manuallyBlocked) tags.push("禁止买入");
  if (decision.follow?.manuallyFollowed) tags.push("手动关注");
  if (decision.follow?.defaultFollowed && !decision.follow?.manuallyFollowed) tags.push("默认关注");
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

function normalizeHoldings(raw, activityRows = []) {
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
        items: []
      });
    }
    const group = groups.get(key);
    const trade = ledger.outcomes.get(outcomeLedgerKey(row.marketAddress, row.tokenId));
    const remainingCost = num(row.costBasisUsdt);
    const value = num(row.markValueUsdt);
    const unrealized = num(row.cashPnlUsdt);
    const invested = trade?.bought > 0 ? trade.bought : remainingCost;
    const sold = trade?.sold ?? 0;
    const realized = trade?.realized ?? num(row.realizedPnlUsdt);
    const totalPnl = realized + unrealized;
    group.invested += invested;
    group.remainingCost += remainingCost;
    group.sold += sold;
    group.value += value;
    group.realized += realized;
    group.unrealized += unrealized;
    group.totalPnl += totalPnl;
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
      pnl: money(totalPnl, { sign: true }),
      pnlPct: pct(invested > 0 ? (totalPnl / invested) * 100 : 0),
      positive: totalPnl >= 0,
      sellable: !row.isFinalized
    });
  }
  const finalizedGroups = [...groups.values()].map((group) => finalizeHoldingGroup(group, ledger));
  const totals = finalizedGroups.reduce((acc, group) => {
    acc.invested += group.invested;
    acc.remainingCost += group.remainingCost;
    acc.sold += group.sold;
    acc.value += group.value;
    acc.realized += group.realized;
    acc.unrealized += group.unrealized;
    acc.totalPnl += group.totalPnl;
    return acc;
  }, {
    invested: 0,
    remainingCost: 0,
    sold: 0,
    value: 0,
    realized: 0,
    unrealized: 0,
    totalPnl: 0
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
      pnl: money(totals.totalPnl, { sign: true }),
      positive: totals.totalPnl >= 0
    },
    groups: finalizedGroups.map(formatHoldingGroup)
  };
}

function finalizeHoldingGroup(group, ledger) {
  const marketTrade = ledger.markets.get(normAddress(group.market));
  const invested = marketTrade?.bought > 0 ? marketTrade.bought : group.invested;
  const sold = marketTrade?.sold ?? group.sold;
  const realized = marketTrade ? marketTrade.realized : group.realized;
  const totalPnl = realized + group.unrealized;
  return {
    ...group,
    invested,
    sold,
    realized,
    totalPnl
  };
}

function formatHoldingGroup(group) {
  const sellableCount = group.items.filter((item) => item.sellable).length;
  return {
    ...group,
    cost: money(group.invested),
    remainingCost: money(group.remainingCost),
    sold: money(group.sold),
    value: money(group.value),
    realized: money(group.realized, { sign: true }),
    unrealized: money(group.unrealized, { sign: true }),
    pnl: money(group.totalPnl, { sign: true }),
    positive: group.totalPnl >= 0,
    sellable: sellableCount > 0,
    sellableCount
  };
}

function buildAnalytics(rawPositions, activityRows) {
  const positions = rawPositions.positions ?? [];
  const projects = new Map();
  const ledger = buildTradeLedger(activityRows);
  const totals = {
    bought: 0,
    sold: 0,
    realized: 0,
    openCost: 0,
    openValue: 0,
    openPnl: 0
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
    totals.bought += trade.bought;
    totals.sold += trade.sold;
    totals.realized += trade.realized;
  }

  const totalPnl = totals.realized + totals.openPnl;
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
      .sort((a, b) => Math.abs(b.pnlValue) - Math.abs(a.pnlValue))
      .slice(0, 12)
  };
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
      openPnl: 0
    });
  }
  const project = projects.get(projectKey);
  if (!project.title && title) project.title = title;
  return project;
}

function normalizeProject(project) {
  const pnl = project.realized + project.openPnl;
  const invested = project.bought > 0 ? project.bought : project.openCost;
  return {
    title: project.title,
    bought: money(project.bought),
    sold: money(project.sold),
    openCost: money(project.openCost),
    openValue: money(project.openValue),
    realized: money(project.realized, { sign: true }),
    unrealized: money(project.openPnl, { sign: true }),
    pnl: money(pnl, { sign: true }),
    pnlValue: pnl,
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
    if (type !== "MINT" && type !== "REDEEM") continue;
    const marketKey = normAddress(row.marketAddress ?? row.market);
    if (!marketKey) continue;
    const market = ensureTradeRecord(markets, marketKey, {
      marketAddress: row.marketAddress ?? row.market,
      title: row.title
    });
    const outcomeKey = outcomeLedgerKey(row.marketAddress ?? row.market, row.tokenId);
    const outcome = ensureTradeRecord(outcomes, outcomeKey, {
      marketAddress: row.marketAddress ?? row.market,
      title: row.title,
      tokenId: row.tokenId,
      outcome: row.outcome
    });
    const collateral = num(row.collateral);
    const realized = num(row.realizedPnlDelta);
    if (type === "MINT") {
      market.bought += collateral;
      outcome.bought += collateral;
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

function ensureTradeRecord(map, key, initial = {}) {
  if (!map.has(key)) {
    map.set(key, {
      ...initial,
      bought: 0,
      sold: 0,
      realized: 0
    });
  }
  const record = map.get(key);
  if (!record.title && initial.title) record.title = initial.title;
  if (!record.outcome && initial.outcome) record.outcome = initial.outcome;
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
  const normalized = [];
  for (const row of rows) {
    const type = String(row.type ?? "").toUpperCase();
    const time = row.timestamp ? new Date(Number(row.timestamp) * 1000).toISOString() : null;
    if (!time) continue;
    if (type === "MINT") {
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
    return await fetchActivity(cfg, {
      user: botWallet,
      limit: Number(process.env.DASHBOARD_ACTIVITY_LIMIT ?? 500)
    });
  } catch {
    return [];
  }
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
