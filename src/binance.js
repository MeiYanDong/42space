const BINANCE_FAPI = "https://fapi.binance.com";
const BINANCE_SPOT_API = "https://api.binance.com";

export async function estimateFuturesDailyQuoteVolume(symbol = "BTCUSDT") {
  const rows = await getFuturesKlines(symbol, "1d", { limit: 8 });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Binance returned no klines");
  }

  const current = rows[rows.length - 1];
  const previous = rows.slice(0, -1);
  const now = Date.now();
  const openTime = Number(current[0]);
  const closeTime = Number(current[6]);
  const currentQuoteVolume = Number(current[7]);
  const previousQuoteVolumes = previous.map((row) => Number(row[7])).filter(Number.isFinite);
  const previousAverage =
    previousQuoteVolumes.length > 0
      ? previousQuoteVolumes.reduce((sum, value) => sum + value, 0) / previousQuoteVolumes.length
      : currentQuoteVolume;

  const elapsedMs = Math.max(1, now - openTime);
  const totalMs = Math.max(1, closeTime - openTime + 1);
  const elapsedFraction = Math.min(1, elapsedMs / totalMs);
  const rawProjection = currentQuoteVolume / elapsedFraction;

  // The first minutes of a day are too noisy. Blend toward recent completed days.
  const elapsedMinutes = elapsedMs / 60_000;
  const weightProjection = Math.max(0, Math.min(0.75, elapsedMinutes / 180));
  const estimatedDailyVolume =
    rawProjection * weightProjection + previousAverage * (1 - weightProjection);

  return {
    symbol,
    currentQuoteVolume,
    previousAverage,
    rawProjection,
    estimatedDailyVolume,
    elapsedFraction,
    openTime,
    closeTime
  };
}

export async function getFuturesKlines(symbol = "BTCUSDT", interval = "1d", options = {}) {
  const url = new URL("/fapi/v1/klines", BINANCE_FAPI);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.startTime !== undefined) url.searchParams.set("startTime", String(options.startTime));
  if (options.endTime !== undefined) url.searchParams.set("endTime", String(options.endTime));

  return getJson(url);
}

export async function getFuturesPrice(symbol = "BTCUSDT") {
  const url = new URL("/fapi/v1/ticker/price", BINANCE_FAPI);
  url.searchParams.set("symbol", symbol);

  const row = await getJson(url);
  const price = Number(row.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Binance returned invalid ${symbol} price`);
  }

  return {
    symbol,
    price,
    at: new Date().toISOString()
  };
}

export async function getSpotPrice(symbol = "BTCUSDT") {
  const url = new URL("/api/v3/ticker/price", BINANCE_SPOT_API);
  url.searchParams.set("symbol", symbol);

  const row = await getJson(url);
  const price = Number(row.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Binance returned invalid ${symbol} spot price`);
  }

  return {
    symbol,
    market: "spot",
    price,
    at: new Date().toISOString()
  };
}

async function getJson(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "42-btc-open-sniper/0.1"
        }
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Binance ${response.status}: ${body.slice(0, 300)}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
