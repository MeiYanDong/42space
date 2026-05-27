import { ADDRESSES } from "./fortytwo.js";

export function filterEventMarkets(markets, cfg) {
  return markets
    .filter((market) => isEventMarket(market, cfg))
    .filter((market) => passesCreatedAtFloor(market, cfg))
    .sort(compareCreatedAtDesc);
}

export function isEventMarket(market, cfg) {
  if (!market || !isMonitorableEventStatus(market.status)) return false;
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) return false;
  if (isPriceMarket(market, cfg)) return false;
  if (!passesCategoryAllowlist(market, cfg)) return false;
  return true;
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
