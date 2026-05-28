import { ADDRESSES } from "./fortytwo.js";

export function filterEventMarkets(markets, cfg) {
  return markets
    .filter((market) => isEventMarket(market, cfg))
    .filter((market) => passesCreatedAtFloor(market, cfg))
    .sort(compareCreatedAtDesc);
}

export function isEventMarket(market, cfg) {
  return getEventMarketDecision(market, cfg).eligible;
}

export function getEventMarketDecision(market, cfg) {
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
  if (isPriceMarket(market, cfg)) {
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
  return {
    ...base,
    eligible: true,
    reason: "eligible",
    reasonText: "符合买入",
    tags: ["符合买入", "长周期"]
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
