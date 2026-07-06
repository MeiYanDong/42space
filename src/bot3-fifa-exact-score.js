import { isSportsExactScoreMarket } from "./event-intel.js";

const HOME_WIN_SCORES = Object.freeze(["1-0", "2-0", "2-1"]);
const AWAY_WIN_SCORES = Object.freeze(["0-1", "0-2", "1-2"]);
const CANONICAL_SCORES = Object.freeze([...HOME_WIN_SCORES, ...AWAY_WIN_SCORES]);

export function bot3FifaExactScoreAutoBuyActive(cfg = {}) {
  return Boolean(cfg.bot3FifaExactScoreAutoBuyEnabled) && isBot3Profile(cfg);
}

export function bot3FifaExactScoreConfigForMarket(cfg, market) {
  if (!bot3FifaExactScoreAutoBuyActive(cfg)) return null;
  const preview = previewBot3FifaExactScoreMarket(market);
  if (preview.skipReason) return null;
  const stakePerOutcomeUsdt = Number(cfg.bot3FifaExactScoreAutoStakeUsdt ?? cfg.stakePerOutcomeUsdt ?? 1);
  const totalStakeUsdt = roundUsd(stakePerOutcomeUsdt * preview.selectedOutcomeNames.length);
  return {
    ...cfg,
    eventOutcomeSelection: "names",
    eventOutcomeNames: preview.selectedOutcomeNames.join(","),
    eventOutcomeCount: preview.selectedOutcomeNames.length,
    stakePerOutcomeUsdt,
    maxStakeUsdt: Math.max(Number(cfg.maxStakeUsdt ?? 0), stakePerOutcomeUsdt),
    maxOutcomesPerMarket: Math.max(Number(cfg.maxOutcomesPerMarket ?? 0), preview.selectedOutcomeNames.length),
    maxMarketStakeUsdt: Math.max(Number(cfg.maxMarketStakeUsdt ?? 0), totalStakeUsdt),
    maxBatchStakeUsdt: Math.max(Number(cfg.maxBatchStakeUsdt ?? 0), totalStakeUsdt),
    bot3FifaExactScoreAutoBuy: {
      strategy: "bot3_fifa_exact_score_lowest_price_tier",
      stakePerOutcomeUsdt,
      totalStakeUsdt,
      preview
    }
  };
}

export function annotateBot3FifaExactScorePlan(plan, buyCfg) {
  const auto = buyCfg?.bot3FifaExactScoreAutoBuy;
  if (!auto) return plan;
  const preview = auto.preview;
  return {
    ...plan,
    bot3FifaExactScoreAutoBuy: auto,
    selection: {
      ...(plan.selection ?? {}),
      autoBuy: true,
      bot3FifaExactScoreAutoBuy: true,
      strategy: auto.strategy,
      rankSource: "outcome_price_tier",
      selectedSide: preview.selectedSide,
      selectedTierPrice: preview.selectedTierPrice,
      homeWinTierPrice: preview.homeWin.tierPrice,
      awayWinTierPrice: preview.awayWin.tierPrice,
      drawTierPrice: preview.draw.tierPrice,
      skipReason: null
    },
    outcomes: plan.outcomes.map((outcome) => ({
      ...outcome,
      selectionRankSource: "outcome_price_tier",
      selectionScore: outcome.price ?? null
    }))
  };
}

export function previewBot3FifaExactScoreMarket(market) {
  const base = {
    market: String(market?.address ?? ""),
    question: marketQuestion(market),
    homeTeam: null,
    awayTeam: null,
    homeWin: { scores: HOME_WIN_SCORES.map(emptyScorePreview), tierPrice: null },
    awayWin: { scores: AWAY_WIN_SCORES.map(emptyScorePreview), tierPrice: null },
    draw: { scores: [], tierPrice: null },
    selectedSide: null,
    selectedTierPrice: null,
    selectedOutcomeNames: [],
    skipReason: null
  };

  if (!market) return skipped(base, "missing_market");
  if (!isSportsExactScoreMarket(market)) return skipped(base, "not_fifa_sports_exact_score");
  const teams = parseMatchTeams(base.question);
  if (!teams) return skipped(base, "matchup_parse_failed");
  const outcomes = normalizeOutcomes(market.outcomes);
  if (outcomes.length === 0) return skipped({ ...base, homeTeam: teams.home, awayTeam: teams.away }, "missing_outcomes");

  const scoreIndex = indexOutcomesByScore(outcomes);
  if (scoreIndex.duplicateScores.length > 0) {
    return skipped(
      { ...base, homeTeam: teams.home, awayTeam: teams.away },
      `duplicate_score_outcomes:${scoreIndex.duplicateScores.join(",")}`
    );
  }

  const homeWin = buildTierPreview(HOME_WIN_SCORES, scoreIndex.byScore);
  const awayWin = buildTierPreview(AWAY_WIN_SCORES, scoreIndex.byScore);
  const draw = buildDrawTierPreview(scoreIndex.byScore);
  const preview = {
    ...base,
    homeTeam: teams.home,
    awayTeam: teams.away,
    homeWin,
    awayWin,
    draw
  };

  const missingCanonical = CANONICAL_SCORES.find((score) => !scoreIndex.byScore.has(score));
  if (missingCanonical) return skipped(preview, `missing_canonical_score:${missingCanonical}`);
  const missingCanonicalPrice = [...homeWin.scores, ...awayWin.scores].find((row) => !isFinitePrice(row.price));
  if (missingCanonicalPrice) return skipped(preview, `missing_canonical_price:${missingCanonicalPrice.score}`);
  if (!homeWin.uniform) return skipped(preview, "home_win_tier_price_not_uniform");
  if (!awayWin.uniform) return skipped(preview, "away_win_tier_price_not_uniform");
  if (!draw.scores.length) return skipped(preview, "missing_draw_tier");
  const missingDrawPrice = draw.scores.find((row) => !isFinitePrice(row.price));
  if (missingDrawPrice) return skipped(preview, `missing_draw_price:${missingDrawPrice.score}`);
  if (!draw.uniform) return skipped(preview, "draw_tier_price_not_uniform");
  if (!isFinitePrice(homeWin.tierPrice) || !isFinitePrice(awayWin.tierPrice)) {
    return skipped(preview, "missing_win_tier_price");
  }
  if (homeWin.tierPrice === awayWin.tierPrice) return skipped(preview, "win_tier_price_tie");
  const selectedSide = homeWin.tierPrice < awayWin.tierPrice ? "home_win" : "away_win";
  const selectedTier = selectedSide === "home_win" ? homeWin : awayWin;
  if (isFinitePrice(draw.tierPrice) && selectedTier.tierPrice >= draw.tierPrice) {
    return skipped(preview, "lowest_tier_is_not_win_side");
  }
  return {
    ...preview,
    selectedSide,
    selectedTierPrice: selectedTier.tierPrice,
    selectedOutcomeNames: selectedTier.scores.map((row) => row.outcomeName)
  };
}

function isBot3Profile(cfg = {}) {
  const botName = String(cfg.botName ?? "").trim().toLowerCase();
  return botName === "42space-3" || botName === "bot3" || botName.startsWith("bot3") || botName.includes("bot3");
}

function marketQuestion(market) {
  return String(market?.question ?? market?.title ?? "").trim();
}

function parseMatchTeams(question) {
  const match = String(question ?? "").trim().match(/(?<home>.+?)\s+(?:vs\.?|v\.?)\s+(?<away>.+?)(?:\?|$)/iu);
  if (!match?.groups) return null;
  const home = cleanTeamName(match.groups.home);
  const away = cleanTeamName(match.groups.away);
  if (!home || !away) return null;
  return { home, away };
}

function cleanTeamName(value) {
  return String(value ?? "")
    .replace(/^.*:\s*/u, "")
    .replace(/^.*\b(?:for|of|between)\s+/iu, "")
    .replace(/\s*[-\u2010-\u2015]\s*.*$/u, "")
    .replace(/\b(?:correct score|scoreline|final score|match result|match)\b.*$/iu, "")
    .replace(/[?!.,;:]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeOutcomes(outcomes) {
  if (!Array.isArray(outcomes)) return [];
  return outcomes.map((outcome, index) => ({
    index,
    tokenId: outcome?.tokenId === undefined || outcome?.tokenId === null ? null : String(outcome.tokenId),
    outcomeName: String(outcome?.name ?? outcome?.title ?? outcome?.label ?? outcome?.outcomeName ?? "").trim(),
    price: finitePrice(outcome?.price),
    payout: finitePrice(outcome?.payout)
  })).filter((outcome) => outcome.outcomeName || outcome.tokenId);
}

function indexOutcomesByScore(outcomes) {
  const byScore = new Map();
  const duplicateScores = [];
  for (const outcome of outcomes) {
    const parsed = parseScore(outcome.outcomeName);
    if (!parsed) continue;
    const key = `${parsed.homeScore}-${parsed.awayScore}`;
    if (byScore.has(key)) {
      duplicateScores.push(key);
      continue;
    }
    byScore.set(key, { ...outcome, score: key, homeScore: parsed.homeScore, awayScore: parsed.awayScore });
  }
  return { byScore, duplicateScores };
}

function parseScore(outcomeName) {
  const match = String(outcomeName ?? "")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .match(/(?:^|[^\d])(?<home>\d{1,2})\s*(?:-|:)\s*(?<away>\d{1,2})(?:[^\d]|$)/u);
  if (!match?.groups) return null;
  return {
    homeScore: Number(match.groups.home),
    awayScore: Number(match.groups.away)
  };
}

function buildTierPreview(scores, byScore) {
  const rows = scores.map((score) => scorePreview(score, byScore.get(score)));
  return {
    scores: rows,
    tierPrice: uniformTierPrice(rows),
    uniform: priceRowsUniform(rows)
  };
}

function buildDrawTierPreview(byScore) {
  const rows = [...byScore.values()]
    .filter((outcome) => outcome.homeScore === outcome.awayScore)
    .sort((a, b) => a.homeScore - b.homeScore)
    .map((outcome) => scorePreview(outcome.score, outcome));
  return {
    scores: rows,
    tierPrice: uniformTierPrice(rows),
    uniform: priceRowsUniform(rows)
  };
}

function emptyScorePreview(score) {
  return {
    score,
    tokenId: null,
    outcomeName: null,
    price: null,
    payout: null
  };
}

function scorePreview(score, outcome) {
  if (!outcome) return emptyScorePreview(score);
  return {
    score,
    tokenId: outcome.tokenId,
    outcomeName: outcome.outcomeName,
    price: outcome.price,
    payout: outcome.payout
  };
}

function uniformTierPrice(rows) {
  const prices = rows.map((row) => row.price).filter(isFinitePrice);
  if (prices.length === 0) return null;
  return prices.every((price) => price === prices[0]) ? prices[0] : null;
}

function priceRowsUniform(rows) {
  const prices = rows.map((row) => row.price);
  if (prices.some((price) => !isFinitePrice(price))) return false;
  return prices.every((price) => price === prices[0]);
}

function finitePrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isFinitePrice(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function skipped(preview, skipReason) {
  return {
    ...preview,
    selectedSide: null,
    selectedTierPrice: null,
    selectedOutcomeNames: [],
    skipReason
  };
}

function roundUsd(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}
