import fs from "node:fs";

import { ADDRESSES } from "./fortytwo.js";
import {
  classifyEventIntelMarket,
  evaluateLocalBinanceRelation,
  getEventDisplayFilterDecision,
  getEventDisplayRuleMatch,
  isMemeIntelMarket,
  isSportsExactScoreMarket,
  isSportsPlayerPropMarket
} from "./event-intel.js";
import { normalizeEventDisplayFilterRules } from "./event-display-rules.js";
import { applyMarketFollowDecision, isManualFollowDecision } from "./market-follow.js";

const intelBuyReportCache = new Map();

export function filterEventMarkets(markets, cfg) {
  return markets
    .filter((market) => {
      const decision = getEventMarketDecision(market, cfg);
      if (!decision.eligible) return false;
      if (isManualFollowDecision(decision)) return true;
      return passesCreatedAtFloor(market, cfg);
    })
    .sort(compareCreatedAtDesc);
}

export function isEventMarket(market, cfg) {
  return getEventMarketDecision(market, cfg).eligible;
}

export function getEventMarketDecision(market, cfg) {
  return applyMarketFollowDecision(market, cfg, getBaseEventMarketDecision(market, cfg));
}

export function getBaseEventMarketDecision(market, cfg) {
  const durationMs = eventDurationMs(market);
  const durationHours = Number.isFinite(durationMs) ? durationMs / 3600000 : null;
  const minHours = Number(cfg.minEventDurationHours ?? 0);
  const base = {
    eligible: false,
    reason: "unknown",
    reasonText: "不可判断",
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    durationHours,
    minDurationHours: Number.isFinite(minHours) ? minHours : 0,
    tags: []
  };

  if (!market) return { ...base, reason: "missing-market", reasonText: "缺少市场数据" };
  if (!isMonitorableEventStatus(market.status)) {
    return { ...base, reason: "status", reasonText: "状态不处理", tags: [String(market.status ?? "unknown")] };
  }
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) {
    return { ...base, reason: "no-outcomes", reasonText: "缺少选项" };
  }
  if (!passesQuestionAllowlist(market, cfg)) {
    return { ...base, reason: "question-allowlist", reasonText: "题目不在白名单", tags: ["非目标题目"] };
  }
  if (!passesBuyQuestionAllowlist(market, cfg)) {
    return { ...base, reason: "buy-question-allowlist", reasonText: "买入题目不在白名单", tags: ["非买入题目"] };
  }
  if (isPriceMarket(market, cfg) && !hasLockedMemeRangeSelection(market, cfg)) {
    return { ...base, reason: "price-market", reasonText: "Price 场", tags: ["Price"] };
  }
  if (!passesCategoryAllowlist(market, cfg)) {
    return { ...base, reason: "category", reasonText: "分类不匹配", tags: market.categories ?? [] };
  }
  if (!passesMinDuration(market, cfg)) {
    const hasUsableTime = Number.isFinite(durationMs) && durationMs > 0;
    return {
      ...base,
      reason: hasUsableTime ? "short-duration" : "missing-time",
      reasonText: hasUsableTime ? `短于 ${formatDurationHours(minHours)}` : "缺少结束时间",
      tags: [hasUsableTime ? "短周期" : "缺少时间"]
    };
  }
  const intelBuyDecision = getEventIntelBuyDecision(market, cfg);
  if (!intelBuyDecision.eligible) {
    return {
      ...base,
      reason: intelBuyDecision.reason,
      reasonText: intelBuyDecision.reasonText,
      tags: intelBuyDecision.tags
    };
  }
  return {
    ...base,
    eligible: true,
    reason: "eligible",
    reasonText: "符合买入",
    tags: [...["符合买入", "长周期"], ...(intelBuyDecision.tags ?? [])]
  };
}

export function getEventMarketDisplayDecision(market, cfg = {}, decision = null) {
  const base = {
    visible: false,
    reason: "unknown",
    reasonText: "不可判断",
    notify: false,
    tags: []
  };

  if (!market) return { ...base, reason: "missing-market", reasonText: "缺少市场数据" };
  if (!isMonitorableEventStatus(market.status)) {
    return { ...base, reason: "status", reasonText: "状态不处理", tags: [String(market.status ?? "unknown")] };
  }
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) {
    return { ...base, reason: "no-outcomes", reasonText: "缺少选项" };
  }

  const includeRules = normalizeEventDisplayFilterRules(cfg?.eventDisplayIncludeRules, { fallback: [] });
  if (includeRules.length > 0) {
    const includeMatch = includeRules
      .map((ruleId) => getEventDisplayRuleMatch(market, ruleId))
      .find(Boolean);
    if (!includeMatch) {
      return { ...base, reason: "display-include-miss", reasonText: "不在显示白名单", tags: ["非显示目标"] };
    }
    return {
      ...base,
      visible: true,
      reason: `display-include-${includeMatch.ruleId.replaceAll("_", "-")}`,
      reasonText: `显示：${includeMatch.reasonText.replace(/^过滤：/u, "")}`,
      notify: true,
      tags: ["默认显示", ...includeMatch.tags.filter((tag) => tag !== "过滤")]
    };
  }

  const filterDecision = getEventDisplayFilterDecision(market, cfg);
  if (filterDecision.filtered) {
    return {
      ...base,
      reason: filterDecision.reason,
      reasonText: filterDecision.reasonText,
      tags: filterDecision.tags
    };
  }

  const focus = getDefaultDisplayFocus(market, cfg);
  if (focus) {
    return {
      ...base,
      visible: true,
      reason: focus.reason,
      reasonText: focus.reasonText,
      notify: true,
      tags: focus.tags
    };
  }

  return {
    ...base,
    visible: true,
    reason: "display-non-template",
    reasonText: "非日常模板，默认显示并通知",
    notify: true,
    tags: ["默认显示", "非日常模板"]
  };
}

function isMonitorableEventStatus(status) {
  return status === "live" || status === "not_started";
}

export function isPriceMarket(market, cfg) {
  const categoryText = (market.categories ?? []).join(" ");
  const tagText = (market.tags ?? []).join(" ");
  const haystack = [
    market.question,
    market.slug,
    categoryText,
    tagText,
    ...(market.topics ?? [])
  ]
    .filter(Boolean)
    .join(" ");

  if (containsAny(categoryText, cfg.marketCategoryBlocklist)) return true;
  if (containsAny(tagText, cfg.marketTagBlocklist)) return true;
  if (market.curve && String(market.curve).toLowerCase() === ADDRESSES.clockCurve.toLowerCase()) return true;
  return /price\s+range|8\s*hour|clock\s*curve/i.test(haystack);
}

export function selectEventMarket(markets, args = {}) {
  if (args.market) {
    const wanted = String(args.market).toLowerCase();
    const market = markets.find((item) => String(item.address).toLowerCase() === wanted);
    if (!market) throw new Error(`Event market not found: ${args.market}`);
    return market;
  }

  const market = markets[0];
  if (!market) throw new Error("No live Event Market found");
  return market;
}

export function summarizeEventMarket(market) {
  return {
    question: market.question,
    address: market.address,
    status: market.status,
    createdAt: market.createdAt,
    startDate: market.startDate,
    endDate: market.endDate,
    contractVersion: market.contractVersion,
    categories: market.categories ?? [],
    tags: market.tags ?? [],
    outcomeCount: market.outcomes?.length ?? 0,
    outcomes: sortOutcomes(market.outcomes ?? []).map((outcome) => ({
      tokenId: outcome.tokenId,
      name: outcome.name,
      price: outcome.price,
      payout: outcome.payout,
      volume: outcome.volume,
      mintedQuantity: outcome.mintedQuantity
    }))
  };
}

export function eventSeenKey(market, cfg) {
  const selection = cfg.eventOutcomeSelection === "all"
    ? "all"
    : `${cfg.eventOutcomeSelection}-${cfg.eventOutcomeCount}`;
  return `${String(market.address).toLowerCase()}:event-${selection}:${cfg.stakePerOutcomeUsdt}`;
}

function passesCategoryAllowlist(market, cfg) {
  if (!cfg.marketCategoryAllowlist || cfg.marketCategoryAllowlist.length === 0) return true;
  return containsAny((market.categories ?? []).join(" "), cfg.marketCategoryAllowlist);
}

function passesQuestionAllowlist(market, cfg) {
  const regex = cfg.marketQuestionAllowlistRegex;
  if (!regex) return true;
  const title = String(market?.question ?? market?.title ?? "");
  if (regex instanceof RegExp) {
    regex.lastIndex = 0;
    return regex.test(title);
  }
  return new RegExp(String(regex), "i").test(title);
}

function passesBuyQuestionAllowlist(market, cfg) {
  const regex = cfg.marketBuyQuestionAllowlistRegex;
  if (!regex) return true;
  const title = String(market?.question ?? market?.title ?? "");
  if (regex instanceof RegExp) {
    regex.lastIndex = 0;
    return regex.test(title);
  }
  return new RegExp(String(regex), "i").test(title);
}

function passesCreatedAtFloor(market, cfg) {
  if (!cfg.minMarketCreatedAt) return true;
  const createdAt = new Date(market.createdAt).getTime();
  const floor = new Date(cfg.minMarketCreatedAt).getTime();
  return Number.isFinite(createdAt) && Number.isFinite(floor) && createdAt >= floor;
}

function passesMinDuration(market, cfg) {
  const minHours = Number(cfg.minEventDurationHours ?? 0);
  if (!Number.isFinite(minHours) || minHours <= 0) return true;
  const durationMs = eventDurationMs(market);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  return durationMs >= minHours * 60 * 60 * 1000;
}

function getEventIntelBuyDecision(market, cfg) {
  const mode = String(cfg?.eventIntelBuyFilter ?? "off").trim().toLowerCase();
  if (!mode || mode === "off") {
    return { eligible: true, reason: "event-intel-off", reasonText: "情报过滤关闭", tags: [] };
  }
  if (mode !== "strong") {
    return {
      eligible: false,
      reason: "event-intel-config",
      reasonText: "情报过滤配置无效",
      tags: ["情报配置异常"]
    };
  }

  if (hasLockedMemeRangeSelection(market, cfg)) {
    return {
      eligible: true,
      reason: "event-intel-meme-range-lock",
      reasonText: "Meme 数值区间已在首次监控锁定",
      tags: ["Meme 默认关注", "首次监控锁定"]
    };
  }

  const classification = classifyEventIntelMarket(market);
  if (classification.fixedTemplate || classification.priceEvent) {
    return archivedIntelBuyDecision(classification);
  }
  const excludedTopic = lowLiquidityIntelBuyTopic(market);
  if (excludedTopic) {
    return {
      eligible: false,
      reason: "event-intel-low-liquidity",
      reasonText: "低交易量题材，不自动买入",
      tags: ["低交易量", excludedTopic]
    };
  }
  if (isMemeIntelMarket(market)) {
    return {
      eligible: true,
      reason: "event-intel-meme",
      reasonText: "Meme 板块事件",
      tags: ["Meme 默认关注"]
    };
  }

  const localRelation = evaluateLocalBinanceRelation(market);
  if (localRelation.level === "strong") {
    return {
      eligible: true,
      reason: "event-intel-strong",
      reasonText: "Binance strong 事件",
      tags: ["Binance strong", "情报本地命中", ...localRelation.evidence.slice(0, 2)]
    };
  }

  const report = readEventIntelBuyReport(market, cfg);
  if (!report) {
    return {
      eligible: false,
      reason: "event-intel-missing",
      reasonText: "未命中 Binance strong 情报",
      tags: ["非 strong"]
    };
  }
  if (isArchivedIntelReport(report)) {
    return archivedIntelBuyDecision(report);
  }
  if (String(report.binanceRelation ?? "").toLowerCase() === "strong") {
    return {
      eligible: true,
      reason: "event-intel-strong",
      reasonText: "Binance strong 事件",
      tags: ["Binance strong", "情报报告命中"]
    };
  }
  return {
    eligible: false,
    reason: "event-intel-relation",
    reasonText: "Binance 关系未达到 strong",
    tags: ["非 strong", String(report.binanceRelation ?? "unknown")]
  };
}

function hasLockedMemeRangeSelection(market, cfg) {
  const selection = market?.memeRangeSelection;
  return Boolean(
    cfg?.memeRangeSelectionEnabled &&
    selection?.locked &&
    ["fdv", "market_cap", "price"].includes(String(selection.metric ?? "")) &&
    isMemeIntelMarket(market)
  );
}

function archivedIntelBuyDecision(input) {
  return {
    eligible: false,
    reason: "event-intel-archive",
    reasonText: "固定模板/Price 情报归档，不自动买入",
    tags: ["情报归档", String(input?.eventKind ?? "archive")]
  };
}

function lowLiquidityIntelBuyTopic(market) {
  const title = String(market?.question ?? market?.title ?? "");
  if (/\btweet\s+count\b/iu.test(title)) return "Tweet Count";
  return "";
}

function getDefaultDisplayFocus(market, cfg) {
  if (isMemeIntelMarket(market)) {
    return { reason: "display-meme", reasonText: "Meme 事件，默认显示并通知", tags: ["默认显示", "Meme"] };
  }

  if (lowLiquidityIntelBuyTopic(market)) return null;

  const localRelation = evaluateLocalBinanceRelation(market);
  if (localRelation.level === "strong") {
    return {
      reason: "display-binance-strong",
      reasonText: "Binance strong，默认显示并通知",
      tags: ["默认显示", "Binance strong", ...localRelation.evidence.slice(0, 1)]
    };
  }

  const report = readEventIntelBuyReport(market, cfg);
  if (report && !isArchivedIntelReport(report) && String(report.binanceRelation ?? "").toLowerCase() === "strong") {
    return {
      reason: "display-binance-strong",
      reasonText: "Binance strong，默认显示并通知",
      tags: ["默认显示", "Binance strong"]
    };
  }

  if (isSportsExactScoreMarket(market)) {
    return { reason: "display-sports-exact-score", reasonText: "FIFA/Sports 准确比分，默认显示并通知", tags: ["默认显示", "准确比分"] };
  }

  if (isSportsPlayerPropMarket(market)) {
    return { reason: "display-sports-player-prop", reasonText: "FIFA/Sports 球员表现，默认显示并通知", tags: ["默认显示", "球员表现"] };
  }

  return null;
}

function hasBasicTemplateTag(market) {
  const text = [
    ...(market?.categories ?? []),
    ...(market?.tags ?? []),
    ...(market?.topics ?? [])
  ].join(" ");
  return containsAny(text, ["8 hour", "automated", "clock curve"]);
}

function readEventIntelBuyReport(market, cfg) {
  const address = String(market?.address ?? "").trim().toLowerCase();
  const file = String(cfg?.eventIntelBuyFile ?? "").trim();
  if (!address || !file) return null;

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") {
      intelBuyReportCache.set(file, {
        mtimeMs: -1,
        size: -1,
        reports: new Map(),
        error: error.message
      });
    }
    return null;
  }

  const cached = intelBuyReportCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.reports.get(address) ?? null;
  }

  const reports = new Map();
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const key = String(row?.market ?? "").trim().toLowerCase();
      if (!key) continue;
      reports.set(key, row);
    }
  } catch {
    return null;
  }
  intelBuyReportCache.set(file, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    reports
  });
  return reports.get(address) ?? null;
}

function isArchivedIntelReport(report) {
  if (report?.fixedTemplate === true) return true;
  const eventKind = String(report?.eventKind ?? "").toLowerCase();
  return eventKind === "fixed-template" || eventKind === "price-event";
}

export function eventDurationMs(market) {
  const start = new Date(market?.startDate).getTime();
  const end = new Date(market?.endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return NaN;
  return end - start;
}

function formatDurationHours(hours) {
  if (!Number.isFinite(hours)) return "--";
  if (hours <= 72) return `${hours} 小时`;
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

function containsAny(text, needles = []) {
  const normalized = String(text ?? "").toLowerCase();
  return needles.some((needle) => normalized.includes(String(needle).toLowerCase()));
}

function compareCreatedAtDesc(a, b) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

function sortOutcomes(outcomes) {
  return [...outcomes].sort((a, b) => Number(BigInt(a.tokenId) - BigInt(b.tokenId)));
}
