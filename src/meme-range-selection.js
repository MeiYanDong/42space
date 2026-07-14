const DEFAULT_DEXSCREENER_API_URL = "https://api.dexscreener.com";
const DEFAULT_PYTH_HERMES_URL = "https://hermes.pyth.network";
const DEFAULT_FETCH_TIMEOUT_MS = 2500;
const DEFAULT_FETCH_ATTEMPTS = 2;
const DEFAULT_PYTH_MAX_AGE_SECONDS = 120;

export function isPotentialMemeRangeMarket(market) {
  const title = marketQuestion(market);
  if (!detectMetric(title, market?.description)) return false;
  const metadata = [
    ...(market?.categories ?? []),
    ...(market?.tags ?? []),
    ...(market?.topics ?? [])
  ].join(" ");
  return /\bmeme\b/iu.test(metadata) || /^\s*\$[^\s?]+/u.test(title);
}

export function isMemeMarket(market) {
  const metadata = [
    ...(market?.categories ?? []),
    ...(market?.tags ?? []),
    ...(market?.topics ?? [])
  ].join(" ");
  const title = marketQuestion(market);
  return /\bmeme\b/iu.test(metadata) || /\$[^\s?]+.*\bFDV\b/iu.test(title);
}

export function middleOutcomeNames(outcomes, count = 3) {
  const sorted = sortOutcomes(outcomes ?? []);
  const requested = Math.min(Math.max(1, Number(count) || 3), sorted.length);
  const start = Math.max(0, Math.floor((sorted.length - requested) / 2));
  return sorted.slice(start, start + requested).map((outcome) => String(outcome.name ?? outcome.title ?? "").trim()).filter(Boolean);
}

export function buildMemeRangeFallback(market, reason, options = {}) {
  const selectedOutcomeNames = middleOutcomeNames(market?.outcomes, 3);
  return {
    version: 1,
    market: String(market?.address ?? "").toLowerCase(),
    question: marketQuestion(market),
    locked: true,
    mode: "middle_fallback",
    metric: detectMetric(marketQuestion(market), market?.description),
    selectedOutcomeNames,
    matchedOutcomeName: null,
    matchedOutcomeIndex: null,
    source: null,
    evidence: null,
    boundaryPolicy: "higher_bucket",
    reason: String(reason || "selection_unavailable"),
    error: options.error ? conciseError(options.error) : null,
    observedAt: options.observedAt ?? new Date().toISOString(),
    lockedAt: options.lockedAt ?? new Date().toISOString()
  };
}

export async function resolveMemeRangeSelection(market, options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const fallback = (reason, extra = {}) => buildMemeRangeFallback(market, reason, { observedAt, ...extra });
  if (!isPotentialMemeRangeMarket(market)) return fallback("not_meme_numeric_range");

  const outcomes = market?.outcomes ?? [];
  const parsedOutcomes = outcomes.map((outcome) => ({ outcome, range: parseOutcomeRange(outcome?.name ?? outcome?.title) }));
  if (outcomes.length < 3 || parsedOutcomes.some((row) => !row.range)) {
    return fallback("outcome_ranges_unparseable");
  }

  const descriptor = parseMarketDescriptor(market);
  if (!descriptor.metric) return fallback("metric_unrecognized");
  if (!descriptor.provider) return fallback("resolution_source_unsupported");

  try {
    const quote = descriptor.provider === "dexscreener"
      ? await readDexScreenerMetric(descriptor, options)
      : await readPythMetric(descriptor, options);
    const selected = selectAdjacentOutcomeWindow(parsedOutcomes, quote.value);
    if (!selected) return fallback("metric_outside_outcome_ranges");

    return {
      version: 1,
      market: String(market?.address ?? "").toLowerCase(),
      question: marketQuestion(market),
      locked: true,
      mode: "metric_adjacent",
      metric: descriptor.metric,
      selectedOutcomeNames: selected.rows.map((row) => String(row.outcome.name ?? row.outcome.title ?? "").trim()),
      matchedOutcomeName: String(selected.matched.outcome.name ?? selected.matched.outcome.title ?? "").trim(),
      matchedOutcomeIndex: selected.matchedIndex,
      source: quote.source,
      evidence: quote.evidence,
      boundaryPolicy: "higher_bucket",
      reason: "current_metric_bucket_with_neighbors",
      error: null,
      observedAt,
      lockedAt: new Date().toISOString()
    };
  } catch (error) {
    return fallback("source_fetch_or_validation_failed", { error });
  }
}

export function lockedMemeRangeOutcomeNames(market, outcomeCount = null) {
  const selection = market?.memeRangeSelection;
  if (!selection?.locked || !Array.isArray(selection.selectedOutcomeNames)) return [];
  const marketAddress = String(market?.address ?? "").toLowerCase();
  if (selection.market && String(selection.market).toLowerCase() !== marketAddress) return [];
  const requested = outcomeCount === null
    ? selection.selectedOutcomeNames.length
    : Math.min(Math.max(1, Number(outcomeCount) || selection.selectedOutcomeNames.length), market?.outcomes?.length ?? 0);
  if (requested !== selection.selectedOutcomeNames.length) {
    const expanded = outcomeWindowAroundName(market?.outcomes, selection.matchedOutcomeName, requested);
    if (expanded.length === requested) return expanded;
    if (!selection.matchedOutcomeName || selection.mode === "middle_fallback") {
      return middleOutcomeNames(market?.outcomes, requested);
    }
  }
  const byName = new Map((market?.outcomes ?? []).map((outcome) => [
    normalizeOutcomeName(outcome?.name ?? outcome?.title),
    String(outcome?.name ?? outcome?.title ?? "").trim()
  ]));
  const selected = selection.selectedOutcomeNames
    .map((name) => byName.get(normalizeOutcomeName(name)))
    .filter(Boolean);
  return selected.length === selection.selectedOutcomeNames.length ? selected : [];
}

function outcomeWindowAroundName(outcomes, matchedName, count) {
  if (!matchedName || !Array.isArray(outcomes) || outcomes.length === 0) return [];
  const sorted = sortOutcomes(outcomes);
  const matchedIndex = sorted.findIndex((outcome) =>
    normalizeOutcomeName(outcome?.name ?? outcome?.title) === normalizeOutcomeName(matchedName)
  );
  if (matchedIndex < 0) return [];
  const requested = Math.min(Math.max(1, Number(count) || 1), sorted.length);
  const radius = Math.floor(requested / 2);
  const start = Math.min(Math.max(0, matchedIndex - radius), Math.max(0, sorted.length - requested));
  return sorted.slice(start, start + requested)
    .map((outcome) => String(outcome?.name ?? outcome?.title ?? "").trim())
    .filter(Boolean);
}

export async function runMemeRangeSelectionSelfTest() {
  const market = mockFdvMarket();
  const dexResponse = {
    pairs: [{
      chainId: "robinhood",
      pairAddress: "0x451c0DA3b774045a822A129eeDcc5C667DcbfDD8",
      baseToken: {
        address: "0x8e62F281f282686fCa6dCB39288069a93fC23F1c",
        symbol: "HOODRAT"
      },
      priceUsd: "0.01002",
      fdv: 10022600,
      marketCap: 10022600,
      liquidity: { usd: 327530.11 }
    }]
  };
  const fetchJson = async (url) => {
    if (String(url).includes("api.dexscreener.com")) return dexResponse;
    throw new Error(`Unexpected URL ${url}`);
  };
  const selection = await resolveMemeRangeSelection(market, { fetchJson, observedAt: "2026-07-11T00:00:00.000Z" });
  assert(selection.mode === "metric_adjacent", "FDV selection mode");
  assert(selection.evidence.computedValue === 10020000, "FDV calculation must use event maximum supply");
  assertArrayEqual(selection.selectedOutcomeNames, ["$7.5M - $10M", "$10M - $12.5M", "$12.5M - $15M"], "FDV adjacent outcomes");
  assertArrayEqual(
    lockedMemeRangeOutcomeNames({ ...market, memeRangeSelection: selection }, 5),
    ["$5M - $7.5M", "$7.5M - $10M", "$10M - $12.5M", "$12.5M - $15M", "$15M - $20M"],
    "FDV five-outcome execution window"
  );

  const boundarySelection = await resolveMemeRangeSelection(market, {
    fetchJson: async () => ({ ...dexResponse, pairs: [{ ...dexResponse.pairs[0], priceUsd: "0.010" }] })
  });
  assert(boundarySelection.matchedOutcomeName === "$10M - $12.5M", "exact boundary must enter higher bucket");

  const edgeSelection = await resolveMemeRangeSelection(market, {
    fetchJson: async () => ({ ...dexResponse, pairs: [{ ...dexResponse.pairs[0], priceUsd: "0.030" }] })
  });
  assertArrayEqual(edgeSelection.selectedOutcomeNames, ["$15M - $20M", "$20M - $25M", "\u2265 $25M"], "upper edge window");

  const mismatch = await resolveMemeRangeSelection(market, {
    fetchJson: async () => ({
      ...dexResponse,
      pairs: [{ ...dexResponse.pairs[0], baseToken: { address: "0x0000000000000000000000000000000000000001", symbol: "HOODRAT" } }]
    })
  });
  assert(mismatch.mode === "middle_fallback", "token mismatch fallback");
  assertArrayEqual(mismatch.selectedOutcomeNames, ["$7.5M - $10M", "$10M - $12.5M", "$12.5M - $15M"], "middle fallback outcomes");

  const pythMarket = mockPythMarket();
  const pythSelection = await resolveMemeRangeSelection(pythMarket, {
    nowMs: 1783761800000,
    fetchJson: async (url) => {
      if (String(url).includes("/v2/price_feeds")) {
        return [{
          id: "feed-id",
          attributes: { asset_type: "Crypto", symbol: "Crypto.PUMP/USD", display_symbol: "PUMP/USD" }
        }];
      }
      return {
        parsed: [{ id: "feed-id", price: { price: "155000", expo: -8, publish_time: 1783761793 } }]
      };
    }
  });
  assert(pythSelection.mode === "metric_adjacent", "Pyth selection mode");
  assert(pythSelection.matchedOutcomeName === "$0.00150 - $0.00160", "Pyth current price bucket");

  const pythFdvMarket = {
    ...pythMarket,
    question: "$POPCAT FDV by July 13th?",
    description: [
      "FDV is calculated as (Price x Maximum Supply)",
      "Primary Resolution Source: https://app.pyth.com/explore/Crypto.POPCAT%2FUSD",
      "The Max Supply of POPCAT is 979,973,221.",
      "This market resolves solely on the Pyth price."
    ].join("\n"),
    outcomes: [
      "< $40M",
      "$40M - $45M",
      "$45M - $50M",
      "$50M - $55M",
      "\u2265 $55M"
    ].map((name, index) => ({ tokenId: (1n << BigInt(index)).toString(), name }))
  };
  const pythFdvSelection = await resolveMemeRangeSelection(pythFdvMarket, {
    nowMs: 1783761800000,
    fetchJson: async (url) => {
      if (String(url).includes("/v2/price_feeds")) {
        return [{ id: "popcat-feed", attributes: { asset_type: "Crypto", symbol: "Crypto.POPCAT/USD" } }];
      }
      return {
        parsed: [{ id: "popcat-feed", price: { price: "4602294", expo: -8, publish_time: 1783761793 } }]
      };
    }
  });
  assert(pythFdvSelection.evidence.maximumSupply === 979973221, "Pyth FDV maximum supply must not consume the next sentence's T");
  assert(pythFdvSelection.matchedOutcomeName === "$45M - $50M", "Pyth FDV bucket");

  return [
    "Meme FDV event-source calculation",
    "profile execution can expand a locked Meme bucket to five outcomes",
    "higher-boundary outcome selection",
    "edge-adjacent three-outcome window",
    "identity mismatch middle fallback",
    "Pyth price-range selection",
    "Pyth FDV maximum-supply parsing"
  ];
}

function parseMarketDescriptor(market) {
  const title = marketQuestion(market);
  const description = String(market?.description ?? "");
  const metric = detectMetric(title, description);
  const dex = description.match(/https?:\/\/(?:www\.)?dexscreener\.com\/([^/\s)]+)\/([A-Za-z0-9]+)/iu);
  const pyth = description.match(/https?:\/\/app\.pyth\.com\/explore\/([^\s)]+)/iu);
  const tokenAddress = extractTokenAddress(description);
  const maximumSupply = extractMaximumSupply(description);
  const tokenSymbol = extractTitleTokenSymbol(title);
  if (dex) {
    return {
      metric,
      provider: "dexscreener",
      sourceUrl: dex[0],
      chainId: decodeURIComponent(dex[1]),
      pairAddress: dex[2],
      tokenAddress,
      tokenSymbol,
      maximumSupply
    };
  }
  if (pyth) {
    return {
      metric,
      provider: "pyth",
      sourceUrl: pyth[0],
      feedSymbol: decodeURIComponent(pyth[1]),
      tokenAddress,
      tokenSymbol,
      maximumSupply
    };
  }
  return { metric, provider: null, tokenAddress, tokenSymbol, maximumSupply };
}

async function readDexScreenerMetric(descriptor, options) {
  const baseUrl = String(options.dexScreenerApiUrl ?? DEFAULT_DEXSCREENER_API_URL).replace(/\/$/u, "");
  const url = `${baseUrl}/latest/dex/pairs/${encodeURIComponent(descriptor.chainId)}/${encodeURIComponent(descriptor.pairAddress)}`;
  const json = await requestJson(url, options);
  const pair = (json?.pairs ?? []).find((row) => sameAddress(row?.pairAddress, descriptor.pairAddress));
  if (!pair) throw new Error("DEX Screener did not return the event's exact pair");
  if (String(pair.chainId ?? "").toLowerCase() !== String(descriptor.chainId).toLowerCase()) {
    throw new Error("DEX Screener chain does not match the event source");
  }
  if (descriptor.tokenAddress && !sameAddress(pair.baseToken?.address, descriptor.tokenAddress)) {
    throw new Error("DEX Screener base token does not match the event token CA");
  }
  if (!descriptor.tokenAddress && descriptor.tokenSymbol && !sameText(pair.baseToken?.symbol, descriptor.tokenSymbol)) {
    throw new Error("DEX Screener base token symbol does not match the event title");
  }
  const sourcePrice = positiveFinite(pair.priceUsd, "DEX Screener priceUsd");
  const value = metricValue(descriptor, {
    sourcePrice,
    marketCap: finiteOrNull(pair.marketCap)
  });
  return {
    value,
    source: {
      provider: "dexscreener",
      url: descriptor.sourceUrl,
      chainId: descriptor.chainId,
      pairAddress: pair.pairAddress,
      tokenAddress: pair.baseToken?.address ?? descriptor.tokenAddress ?? null,
      tokenSymbol: pair.baseToken?.symbol ?? descriptor.tokenSymbol ?? null
    },
    evidence: {
      sourcePrice,
      maximumSupply: descriptor.maximumSupply ?? null,
      computedValue: value,
      providerFdv: finiteOrNull(pair.fdv),
      providerMarketCap: finiteOrNull(pair.marketCap),
      liquidityUsd: finiteOrNull(pair.liquidity?.usd),
      fetchedAt: new Date().toISOString()
    }
  };
}

async function readPythMetric(descriptor, options) {
  if (descriptor.metric === "market_cap") throw new Error("Pyth does not provide market cap for this selector");
  const baseUrl = String(options.pythHermesUrl ?? DEFAULT_PYTH_HERMES_URL).replace(/\/$/u, "");
  const headers = options.pythApiKey ? { authorization: `Bearer ${options.pythApiKey}` } : {};
  const feedsUrl = `${baseUrl}/v2/price_feeds?query=${encodeURIComponent(descriptor.feedSymbol)}&asset_type=crypto`;
  const feeds = await requestJson(feedsUrl, { ...options, headers });
  const feed = exactPythFeed(feeds, descriptor.feedSymbol);
  if (!feed?.id) throw new Error("Pyth exact event feed was not found");
  const latestUrl = `${baseUrl}/v2/updates/price/latest?ids%5B%5D=${encodeURIComponent(feed.id)}&parsed=true`;
  const latest = await requestJson(latestUrl, { ...options, headers });
  const row = (latest?.parsed ?? []).find((item) => sameText(stripHexPrefix(item?.id), stripHexPrefix(feed.id)));
  if (!row?.price) throw new Error("Pyth latest response did not contain the event feed price");
  const sourcePrice = Number(row.price.price) * (10 ** Number(row.price.expo));
  positiveFinite(sourcePrice, "Pyth price");
  const publishTime = Number(row.price.publish_time);
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeSeconds = Number(options.pythMaxAgeSeconds ?? DEFAULT_PYTH_MAX_AGE_SECONDS);
  if (!Number.isFinite(publishTime) || Math.abs(nowMs / 1000 - publishTime) > maxAgeSeconds) {
    throw new Error("Pyth price is stale");
  }
  const value = metricValue(descriptor, { sourcePrice, marketCap: null });
  return {
    value,
    source: {
      provider: "pyth",
      url: descriptor.sourceUrl,
      feedId: feed.id,
      feedSymbol: feed.attributes?.symbol ?? descriptor.feedSymbol,
      tokenAddress: descriptor.tokenAddress ?? null,
      tokenSymbol: descriptor.tokenSymbol ?? null
    },
    evidence: {
      sourcePrice,
      maximumSupply: descriptor.maximumSupply ?? null,
      computedValue: value,
      publishTime,
      confidence: Number(row.price.conf) * (10 ** Number(row.price.expo)),
      fetchedAt: new Date().toISOString()
    }
  };
}

function metricValue(descriptor, values) {
  if (descriptor.metric === "price") return values.sourcePrice;
  if (descriptor.metric === "market_cap") return positiveFinite(values.marketCap, "market cap");
  const maximumSupply = positiveFinite(descriptor.maximumSupply, "event maximum supply");
  return values.sourcePrice * maximumSupply;
}

function exactPythFeed(feeds, wantedSymbol) {
  if (!Array.isArray(feeds)) return null;
  const wanted = normalizeFeedSymbol(wantedSymbol);
  const exact = feeds.filter((feed) => [
    feed?.attributes?.symbol,
    feed?.attributes?.display_symbol
  ].some((value) => normalizeFeedSymbol(value) === wanted));
  return exact.length === 1 ? exact[0] : null;
}

function selectAdjacentOutcomeWindow(rows, value) {
  const sorted = [...rows].sort((a, b) => {
    const minDelta = a.range.min - b.range.min;
    if (minDelta !== 0) return minDelta;
    return a.range.max - b.range.max;
  });
  const matchedIndex = sorted.findIndex((row) => value >= row.range.min && value < row.range.max);
  if (matchedIndex < 0) return null;
  const start = Math.min(Math.max(0, matchedIndex - 1), Math.max(0, sorted.length - 3));
  return {
    matched: sorted[matchedIndex],
    matchedIndex,
    rows: sorted.slice(start, start + Math.min(3, sorted.length))
  };
}

function parseOutcomeRange(value) {
  const text = String(value ?? "")
    .replace(/,/gu, "")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
  const below = text.match(/^(?:<|<=|\u2264|below|under|less\s+than)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBT])?$/iu);
  if (below) return { min: Number.NEGATIVE_INFINITY, max: scaleNumber(below[1], below[2]) };
  const above = text.match(/^(?:>|>=|\u2265|above|over|greater\s+than)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBT])?$/iu);
  if (above) return { min: scaleNumber(above[1], above[2]), max: Number.POSITIVE_INFINITY };
  const range = text.match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBT])?\s*(?:-|to)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBT])?$/iu);
  if (!range) return null;
  const leftUnit = range[2] || range[4] || "";
  const rightUnit = range[4] || range[2] || "";
  const min = scaleNumber(range[1], leftUnit);
  const max = scaleNumber(range[3], rightUnit);
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}

function detectMetric(title, description) {
  const text = `${title ?? ""}\n${description ?? ""}`;
  if (/\bFDV\b|fully\s+diluted\s+valuation/iu.test(text)) return "fdv";
  if (/market\s+cap(?:italization)?|\u5e02\u503c/iu.test(text)) return "market_cap";
  if (/price\s+range|close\s+price|\u4ef7\u683c\s*\u533a\u95f4/iu.test(text)) return "price";
  return null;
}

function extractMaximumSupply(description) {
  const match = String(description ?? "").match(/(?:maximum|max)\s+supply[^\n.]*?\s+is\s+\$?\s*([0-9][0-9,.]*(?:\.[0-9]+)?)(?:[ \t]*([KMBT])(?=[ \t,.;)\n]|$))?/iu);
  return match ? scaleNumber(match[1].replace(/,/gu, ""), match[2]) : null;
}

function extractTokenAddress(description) {
  const match = String(description ?? "").match(/\bCA\s+of\s+[^\n.]{0,100}?\s+is\s+([A-Za-z0-9]{32,66})/iu);
  return match?.[1] ?? null;
}

function extractTitleTokenSymbol(title) {
  return String(title ?? "").match(/^\s*\$([^\s?:]+)/u)?.[1] ?? null;
}

async function requestJson(url, options) {
  if (typeof options.fetchJson === "function") return options.fetchJson(url, options);
  const attempts = Math.max(1, Number(options.fetchAttempts ?? DEFAULT_FETCH_ATTEMPTS));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS));
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", ...(options.headers ?? {}) },
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
      return JSON.parse(body);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("request failed");
}

function sortOutcomes(outcomes) {
  return [...outcomes].sort((a, b) => {
    try {
      const left = BigInt(a?.tokenId);
      const right = BigInt(b?.tokenId);
      return left < right ? -1 : left > right ? 1 : 0;
    } catch {
      return String(a?.tokenId ?? "").localeCompare(String(b?.tokenId ?? ""));
    }
  });
}

function scaleNumber(value, unit = "") {
  const number = Number(value);
  const scales = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return number * (scales[String(unit ?? "").toUpperCase()] ?? 1);
}

function positiveFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} is unavailable`);
  return number;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameAddress(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function sameText(left, right) {
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function normalizeFeedSymbol(value) {
  return String(value ?? "").trim().toLowerCase().replace(/^crypto\./u, "");
}

function stripHexPrefix(value) {
  return String(value ?? "").replace(/^0x/iu, "");
}

function normalizeOutcomeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\u2265/gu, ">=")
    .replace(/\u2264/gu, "<=")
    .replace(/\s+/gu, " ")
    .replace(/([<>]=?)\s+(?=[\d.])/gu, "$1")
    .toLowerCase();
}

function marketQuestion(market) {
  return String(market?.question ?? market?.title ?? "").trim();
}

function conciseError(error) {
  return String(error?.shortMessage ?? error?.message ?? error ?? "unknown error")
    .replace(/https?:\/\/[^\s)]+/gu, "[source-url]")
    .replace(/\s+/gu, " ")
    .slice(0, 240);
}

function mockFdvMarket() {
  return {
    address: "0x0000000000000000000000000000000000000042",
    question: "$HOODRAT FDV by July 13th, 12:00 UTC?",
    categories: ["Crypto", "Meme"],
    description: [
      "FDV is calculated as (Price x Maximum Supply)",
      "Primary Resolution Source: https://dexscreener.com/robinhood/0x451c0da3b774045a822a129eedcc5c667dcbfdd8",
      "The CA of $HOODRAT is 0x8e62F281f282686fCa6dCB39288069a93fC23F1c.",
      "The Maximum Supply of $HOODRAT is 1,000,000,000."
    ].join("\n"),
    outcomes: [
      "< $5M",
      "$5M - $7.5M",
      "$7.5M - $10M",
      "$10M - $12.5M",
      "$12.5M - $15M",
      "$15M - $20M",
      "$20M - $25M",
      "\u2265 $25M"
    ].map((name, index) => ({ tokenId: (1n << BigInt(index)).toString(), name }))
  };
}

function mockPythMarket() {
  return {
    address: "0x0000000000000000000000000000000000000043",
    question: "$PUMP price range by July 13th, 00:00 UTC?",
    categories: ["Crypto", "Meme"],
    description: "Primary Resolution Source: https://app.pyth.com/explore/Crypto.PUMP%2FUSD",
    outcomes: [
      "< $0.00135",
      "$0.00135 - $0.00150",
      "$0.00150 - $0.00160",
      "$0.00160 - $0.00170",
      "$0.00170 - $0.00180",
      "\u2265 $0.00180"
    ].map((name, index) => ({ tokenId: (1n << BigInt(index)).toString(), name }))
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`Meme range selection self-test failed: ${message}`);
}

function assertArrayEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
}
