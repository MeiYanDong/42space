import fs from "node:fs";
import path from "node:path";

const FOLLOW_STATE_VERSION = 1;
const cachedStates = new Map();
const MANUAL_OVERRIDE_REASONS = new Set([
  "price-market",
  "short-duration",
  "missing-time",
  "category",
  "created-at-floor"
]);

export function readMarketFollowState(file) {
  if (!file) return emptyFollowState();
  const resolved = path.resolve(file);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return emptyFollowState();
    throw error;
  }

  const cached = cachedStates.get(resolved);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.state;

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const state = normalizeMarketFollowState(parsed);
  cachedStates.set(resolved, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}

export function writeMarketFollowState(file, input) {
  const resolved = path.resolve(file);
  const state = normalizeMarketFollowState(input);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, resolved);
  cachedStates.delete(resolved);
  return state;
}

export function followMarket(file, marketInput) {
  return updateMarketFollowState(file, (state) => {
    const record = normalizeMarketRecord(marketInput, "manual");
    if (!record) throw new Error("Missing market");
    delete state.blocked[record.market];
    state.followed[record.market] = {
      ...(state.followed[record.market] ?? {}),
      ...record,
      updatedAt: new Date().toISOString()
    };
    return state;
  });
}

export function blockMarket(file, marketInput) {
  return updateMarketFollowState(file, (state) => {
    const record = normalizeMarketRecord(marketInput, "manual");
    if (!record) throw new Error("Missing market");
    delete state.followed[record.market];
    state.blocked[record.market] = {
      ...(state.blocked[record.market] ?? {}),
      ...record,
      updatedAt: new Date().toISOString()
    };
    return state;
  });
}

export function marketFollowStatus(state, market, baseDecision = null, decision = null) {
  const key = marketKey(market);
  const followed = key ? state?.followed?.[key] : null;
  const blocked = key ? state?.blocked?.[key] : null;
  const defaultFollowed = Boolean(baseDecision?.eligible);
  const manuallyFollowed = Boolean(followed);
  const manuallyBlocked = Boolean(blocked);
  const allowed = !manuallyBlocked && Boolean(decision?.eligible ?? (defaultFollowed || manuallyFollowed));
  return {
    key,
    allowed,
    defaultFollowed,
    manuallyFollowed,
    manuallyBlocked,
    source: manuallyBlocked ? "blocked" : (manuallyFollowed ? "manual" : (defaultFollowed ? "default" : "none")),
    label: manuallyBlocked ? "禁止买入" : (manuallyFollowed ? "手动关注" : (defaultFollowed ? "默认关注" : "未关注")),
    followedAt: followed?.updatedAt ?? followed?.addedAt ?? null,
    blockedAt: blocked?.updatedAt ?? blocked?.addedAt ?? null
  };
}

export function applyMarketFollowDecision(market, cfg, baseDecision) {
  const state = cfg?.marketFollowState ?? readMarketFollowState(cfg?.marketFollowFile);
  const status = marketFollowStatus(state, market, baseDecision, baseDecision);
  if (status.manuallyBlocked) {
    return {
      ...baseDecision,
      eligible: false,
      reason: "follow-blocked",
      reasonText: "已取消关注，禁止买入",
      tags: unique([...(baseDecision.tags ?? []), "取消关注"]),
      follow: status
    };
  }

  if (baseDecision.eligible) {
    return {
      ...baseDecision,
      tags: unique([...(baseDecision.tags ?? []), status.manuallyFollowed ? "手动关注" : "默认关注"]),
      follow: marketFollowStatus(state, market, baseDecision, baseDecision)
    };
  }

  if (status.manuallyFollowed && manualFollowCanOverride(market, baseDecision)) {
    const followedDecision = {
      ...baseDecision,
      eligible: true,
      reason: "manual-followed",
      reasonText: "手动关注，允许买入",
      tags: unique([...(baseDecision.tags ?? []), "手动关注"])
    };
    return {
      ...followedDecision,
      follow: marketFollowStatus(state, market, baseDecision, followedDecision)
    };
  }

  return {
    ...baseDecision,
    follow: marketFollowStatus(state, market, baseDecision, baseDecision)
  };
}

export function isManualFollowDecision(decision) {
  return decision?.reason === "manual-followed" || decision?.follow?.manuallyFollowed;
}

export function isMarketFollowBlocked(market, cfg) {
  const state = cfg?.marketFollowState ?? readMarketFollowState(cfg?.marketFollowFile);
  const key = marketKey(market);
  return Boolean(key && state.blocked[key]);
}

export function marketKey(market) {
  const value = typeof market === "string" ? market : (market?.address ?? market?.market);
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeMarketFollowState(input = {}) {
  const followed = normalizeRecordMap(input.followed);
  const blocked = normalizeRecordMap(input.blocked);
  return {
    version: FOLLOW_STATE_VERSION,
    followed,
    blocked,
    updatedAt: input.updatedAt ?? new Date().toISOString()
  };
}

function updateMarketFollowState(file, updater) {
  const current = readMarketFollowState(file);
  const next = normalizeMarketFollowState(updater({
    ...current,
    followed: { ...current.followed },
    blocked: { ...current.blocked },
    updatedAt: new Date().toISOString()
  }));
  return writeMarketFollowState(file, next);
}

function normalizeRecordMap(value) {
  const map = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const record = normalizeMarketRecord({ market: key, ...(raw ?? {}) }, raw?.source ?? "manual");
    if (record) map[record.market] = record;
  }
  return map;
}

function normalizeMarketRecord(input, source) {
  const snapshot = input?.snapshot && typeof input.snapshot === "object" ? input.snapshot : {};
  const market = marketKey(input?.market ?? input?.address ?? snapshot.address ?? snapshot.market);
  if (!market) return null;
  const now = new Date().toISOString();
  return {
    market,
    title: stringOr(input?.title ?? input?.question ?? snapshot.title ?? snapshot.question, "未命名市场"),
    category: stringOr(input?.category ?? snapshot.category, ""),
    startsAt: stringOr(input?.startsAt ?? input?.startDate ?? snapshot.startsAt ?? snapshot.startDate, ""),
    endsAt: stringOr(input?.endsAt ?? input?.endDate ?? snapshot.endsAt ?? snapshot.endDate, ""),
    source,
    addedAt: input?.addedAt ?? now,
    updatedAt: input?.updatedAt ?? now
  };
}

function manualFollowCanOverride(market, decision) {
  if (!MANUAL_OVERRIDE_REASONS.has(decision?.reason)) return false;
  if (!Array.isArray(market?.outcomes) || market.outcomes.length === 0) return false;
  const start = new Date(market?.startDate).getTime();
  return Number.isFinite(start);
}

function emptyFollowState() {
  return {
    version: FOLLOW_STATE_VERSION,
    followed: {},
    blocked: {},
    updatedAt: null
  };
}

function stringOr(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}
