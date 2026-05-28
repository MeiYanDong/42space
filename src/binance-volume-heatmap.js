import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFuturesKlines } from "./binance.js";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    return;
  }

  const now = args.now ? new Date(args.now).getTime() : Date.now();
  if (!Number.isFinite(now)) throw new Error(`Invalid --now ${args.now}`);

  const targetDayStart = args.date ? parseUtcDate(args.date) : floorToDay(now);
  const targetDate = formatDate(targetDayStart);
  const start = targetDayStart - args.days * dayMs;
  const currentHour = floorToHour(now);
  const targetDayEnd = targetDayStart + 23 * hourMs;
  const isLiveTargetDay = targetDayStart === floorToDay(now);
  const end = isLiveTargetDay ? Math.min(targetDayEnd, currentHour) : targetDayEnd;

  const cacheFile = path.resolve(rootDir, args.cacheFile);
  const cache = readCache(cacheFile, args.symbol, "1h");
  const requiredOpenTimes = hourlyRange(start, end);
  const fetchPlan = buildFetchPlan(requiredOpenTimes, cache, now, args.currentTtlMs, !args.noFetch);
  const fetchedCandles = [];

  for (const range of fetchPlan) {
    const rows = await getFuturesKlines(args.symbol, "1h", {
      startTime: range.start,
      endTime: range.end + hourMs - 1,
      limit: Math.min(1500, Math.floor((range.end - range.start) / hourMs) + 1)
    });
    fetchedCandles.push(...rows.map((row) => normalizeKline(args.symbol, "1h", row, now)));
  }

  if (fetchedCandles.length > 0) {
    appendCache(cacheFile, fetchedCandles);
    for (const candle of fetchedCandles) cache.set(candle.openTime, candle);
  }

  const missing = requiredOpenTimes.filter((openTime) => !cache.has(openTime));
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.length} required candles; first missing ${new Date(missing[0]).toISOString()}`);
  }

  const report = buildReport({
    symbol: args.symbol,
    days: args.days,
    targetDayStart,
    targetDate,
    isLiveTargetDay,
    now,
    cacheFile: path.relative(rootDir, cacheFile),
    fetchedCount: fetchedCandles.length,
    cacheCount: cache.size,
    currentTtlMs: args.currentTtlMs,
    candles: cache
  });

  if (args.output) {
    const outputFile = path.resolve(rootDir, args.output);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${report}\n`);
  }

  console.log(report);
}

function buildReport(ctx) {
  const baselineDates = Array.from({ length: ctx.days }, (_, index) => ctx.targetDayStart - (ctx.days - index) * dayMs);
  const allDates = [...baselineDates, ctx.targetDayStart];
  const targetHourIndex = ctx.isLiveTargetDay ? Math.floor((floorToHour(ctx.now) - ctx.targetDayStart) / hourMs) : 23;
  const currentHourFraction = ctx.isLiveTargetDay
    ? clamp((ctx.now - floorToHour(ctx.now)) / hourMs, 0.001, 1)
    : 1;

  const baselineByHour = new Map();
  for (let hour = 0; hour < 24; hour += 1) {
    baselineByHour.set(
      hour,
      baselineDates
        .map((dayStart) => getCandle(ctx.candles, dayStart, hour)?.quoteVolume)
        .filter(Number.isFinite)
    );
  }

  const lines = [];
  lines.push(`# ${ctx.symbol} 合约每小时成交额热力图`);
  lines.push("");
  lines.push(`生成时间: ${new Date(ctx.now).toISOString()}`);
  lines.push(`目标 UTC 日期: ${ctx.targetDate}`);
  lines.push(`缓存: ${ctx.cacheFile}; 已缓存小时K: ${ctx.cacheCount}; 本次新拉取: ${ctx.fetchedCount}; 当前小时刷新 TTL: ${Math.round(ctx.currentTtlMs / 1000)} 秒。`);
  lines.push("");
  lines.push("图例: `C` 偏冷，`N` 正常，`H` 偏热，`X` 极热。热度是和过去 7 个完整 UTC 日的同一个 UTC 小时对比；格子里的数值是 Binance Futures 每小时 `Vol(USDT)`，单位为十亿美元。");
  lines.push("预测口径: `05-28 今天` 只显示真实已发生数据；`预测今天小时值` 对 24 小时都填值，已完成小时用实际值，当前小时按当前进度折算整小时，未来小时用过去 7 天同小时均值作为基准预测。");
  lines.push("");
  lines.push("## 7日 x 24小时热力表");
  lines.push("");
  lines.push(buildHeatmapTable({ ctx, allDates, baselineByHour, targetHourIndex, currentHourFraction }));
  lines.push("");
  lines.push("## 今天已过小时对比");
  lines.push("");
  lines.push(buildTodayComparisonTable({ ctx, baselineByHour, targetHourIndex, currentHourFraction }));
  lines.push("");
  lines.push("## 累计量与情景推演");
  lines.push("");
  lines.push(buildScenarioTable({ ctx, baselineDates, targetHourIndex, currentHourFraction }));
  lines.push("");
  lines.push("## 阈值压力");
  lines.push("");
  lines.push(buildRangePressureTable({ ctx, targetHourIndex, currentHourFraction }));
  return lines.join("\n");
}

function buildHeatmapTable({ ctx, allDates, baselineByHour, targetHourIndex, currentHourFraction }) {
  const header = [
    "UTC小时",
    ...allDates.map((date) => dateHeader(date, ctx.targetDayStart)),
    "7日同小时均值",
    "预测今天小时值",
    "今天/7日均值"
  ];
  const rows = [header];

  for (let hour = 0; hour < 24; hour += 1) {
    const row = [String(hour).padStart(2, "0")];
    const baseline = baselineByHour.get(hour) ?? [];
    for (const dayStart of allDates) {
      const candle = getCandle(ctx.candles, dayStart, hour);
      if (!candle || (dayStart === ctx.targetDayStart && hour > targetHourIndex)) {
        row.push("--");
        continue;
      }
      const isLiveCell = dayStart === ctx.targetDayStart && ctx.isLiveTargetDay && hour === targetHourIndex;
      const compareValue = isLiveCell ? candle.quoteVolume / currentHourFraction : candle.quoteVolume;
      const suffix = isLiveCell ? ` 已发生 / ${formatBillions(compareValue)} 小时估算` : "";
      row.push(`${classifyHeat(compareValue, baseline)} ${formatBillions(candle.quoteVolume)}${suffix}`);
    }
    const today = getCandle(ctx.candles, ctx.targetDayStart, hour);
    const baselineAverage = average(baseline);
    const predictedTodayValue = predictTodayHourValue({
      ctx,
      hour,
      targetHourIndex,
      currentHourFraction,
      today,
      baselineAverage
    });
    row.push(formatBillions(baselineAverage));
    row.push(formatBillions(predictedTodayValue));
    row.push(formatRatio(predictedTodayValue, baselineAverage));
    rows.push(row);
  }

  return markdownTable(rows);
}

function buildTodayComparisonTable({ ctx, baselineByHour, targetHourIndex, currentHourFraction }) {
  const rows = [["UTC小时", "今天", "7日均值", "7日中位数", "均值倍数", "排名", "说明"]];
  for (let hour = 0; hour <= targetHourIndex; hour += 1) {
    const candle = getCandle(ctx.candles, ctx.targetDayStart, hour);
    if (!candle) continue;
    const baseline = baselineByHour.get(hour) ?? [];
    const isLiveCell = ctx.isLiveTargetDay && hour === targetHourIndex;
    const comparable = isLiveCell ? candle.quoteVolume / currentHourFraction : candle.quoteVolume;
    const note = isLiveCell ? `${formatBillions(candle.quoteVolume)} 已发生，按当前进度估算整小时` : "完整小时";
    rows.push([
      String(hour).padStart(2, "0"),
      formatBillions(comparable),
      formatBillions(average(baseline)),
      formatBillions(median(baseline)),
      formatRatio(comparable, average(baseline)),
      rankText(comparable, baseline),
      note
    ]);
  }
  return markdownTable(rows);
}

function buildScenarioTable({ ctx, baselineDates, targetHourIndex, currentHourFraction }) {
  const todayCurrent = ctx.isLiveTargetDay
    ? cumulativeActualForDay(ctx.candles, ctx.targetDayStart, targetHourIndex)
    : cumulativeForDay(ctx.candles, ctx.targetDayStart, targetHourIndex, currentHourFraction, true);
  const sameTimeTotals = baselineDates.map((dayStart) =>
    cumulativeForDay(ctx.candles, dayStart, targetHourIndex, currentHourFraction, true)
  );
  const futureRemainders = baselineDates.map((dayStart) =>
    remainingForDay(ctx.candles, dayStart, targetHourIndex, currentHourFraction)
  );
  const fullDayTotals = baselineDates.map((dayStart) => cumulativeForDay(ctx.candles, dayStart, 23, 1, true));

  const p25Final = todayCurrent + quantile(futureRemainders, 0.25);
  const medianFinal = todayCurrent + median(futureRemainders);
  const p75Final = todayCurrent + quantile(futureRemainders, 0.75);
  const rank = rankText(todayCurrent, sameTimeTotals);

  return markdownTable([
    ["指标", "数值"],
    ["今天当前累计", formatBillions(todayCurrent)],
    ["过去7日同一时点均值", formatBillions(average(sameTimeTotals))],
    ["过去7日同一时点中位数", formatBillions(median(sameTimeTotals))],
    ["今天同一时点排名", rank],
    ["过去7日全天均值", formatBillions(average(fullDayTotals))],
    ["保守最终值(剩余小时 p25)", `${formatBillions(p25Final)} -> ${rangeName(p25Final)}`],
    ["中性最终值(剩余小时中位数)", `${formatBillions(medianFinal)} -> ${rangeName(medianFinal)}`],
    ["偏热最终值(剩余小时 p75)", `${formatBillions(p75Final)} -> ${rangeName(p75Final)}`]
  ]);
}

function buildRangePressureTable({ ctx, targetHourIndex, currentHourFraction }) {
  const current = ctx.isLiveTargetDay
    ? cumulativeActualForDay(ctx.candles, ctx.targetDayStart, targetHourIndex)
    : cumulativeForDay(ctx.candles, ctx.targetDayStart, targetHourIndex, currentHourFraction, true);
  const remainingHours = ctx.isLiveTargetDay
    ? Math.max(0, (ctx.targetDayStart + dayMs - ctx.now) / hourMs)
    : 0;
  const thresholds = [10e9, 12.5e9, 15e9, 17.5e9, 20e9];
  const rows = [["阈值", "还需要", "剩余每小时需达到"]];
  for (const threshold of thresholds) {
    const need = Math.max(0, threshold - current);
    rows.push([formatBillions(threshold), formatBillions(need), remainingHours > 0 ? formatBillions(need / remainingHours) : "--"]);
  }
  return markdownTable(rows);
}

function parseArgs(argv) {
  const args = {
    symbol: "BTCUSDT",
    days: 7,
    date: "",
    cacheFile: "data/binance-hourly-klines.jsonl",
    currentTtlMs: 120000,
    output: "",
    noFetch: false,
    now: "",
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--symbol") args.symbol = takeValue(argv, ++index, item).toUpperCase();
    else if (item === "--days") args.days = Number(takeValue(argv, ++index, item));
    else if (item === "--date") args.date = takeValue(argv, ++index, item);
    else if (item === "--cache-file") args.cacheFile = takeValue(argv, ++index, item);
    else if (item === "--current-ttl-ms") args.currentTtlMs = Number(takeValue(argv, ++index, item));
    else if (item === "--output") args.output = takeValue(argv, ++index, item);
    else if (item === "--no-fetch") args.noFetch = true;
    else if (item === "--now") args.now = takeValue(argv, ++index, item);
    else throw new Error(`Unknown argument ${item}`);
  }

  if (!Number.isInteger(args.days) || args.days <= 0) throw new Error("--days must be a positive integer");
  if (!Number.isFinite(args.currentTtlMs) || args.currentTtlMs < 0) {
    throw new Error("--current-ttl-ms must be a non-negative number");
  }
  if (args.date) parseUtcDate(args.date);
  return args;
}

function takeValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function helpText() {
  return [
    "Usage: npm run volume:heatmap -- [options]",
    "",
    "Options:",
    "  --symbol BTCUSDT              Binance Futures symbol. Default: BTCUSDT",
    "  --days 7                      Complete UTC days used as baseline. Default: 7",
    "  --date YYYY-MM-DD             Target UTC day. Default: current UTC day",
    "  --cache-file PATH             JSONL kline cache. Default: data/binance-hourly-klines.jsonl",
    "  --current-ttl-ms 120000       Refresh TTL for the live hour. Closed hours are not refetched.",
    "  --output PATH                 Also write the Markdown report to a file.",
    "  --no-fetch                    Use cache only.",
    "  --now ISO                     Override current time for repeatable analysis."
  ].join("\n");
}

function buildFetchPlan(requiredOpenTimes, cache, now, ttlMs, canFetch) {
  if (!canFetch) return [];
  const currentHour = floorToHour(now);
  const missing = requiredOpenTimes.filter((openTime) => {
    const cached = cache.get(openTime);
    if (!cached) return true;
    if (openTime === currentHour && now - Date.parse(cached.fetchedAt) > ttlMs) return true;
    return false;
  });
  return groupContiguous(missing);
}

function groupContiguous(openTimes) {
  const sorted = [...new Set(openTimes)].sort((a, b) => a - b);
  const groups = [];
  for (const openTime of sorted) {
    const last = groups[groups.length - 1];
    if (last && openTime === last.end + hourMs) {
      last.end = openTime;
    } else {
      groups.push({ start: openTime, end: openTime });
    }
  }
  return groups;
}

function readCache(file, symbol, interval) {
  const rows = new Map();
  if (!fs.existsSync(file)) return rows;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type !== "binance_kline" || row.symbol !== symbol || row.interval !== interval) continue;
      const existing = rows.get(row.openTime);
      if (!existing || Date.parse(row.fetchedAt) >= Date.parse(existing.fetchedAt)) rows.set(row.openTime, row);
    } catch {
      // Ignore malformed cache lines; later fetches can repair missing data.
    }
  }
  return rows;
}

function appendCache(file, candles) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = candles.map((candle) => JSON.stringify(candle)).join("\n");
  fs.appendFileSync(file, `${text}\n`);
}

function normalizeKline(symbol, interval, row, now) {
  return {
    type: "binance_kline",
    symbol,
    interval,
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    tradeCount: Number(row[8]),
    fetchedAt: new Date(now).toISOString()
  };
}

function hourlyRange(start, end) {
  const rows = [];
  for (let t = start; t <= end; t += hourMs) rows.push(t);
  return rows;
}

function getCandle(candles, dayStart, hour) {
  return candles.get(dayStart + hour * hourMs) ?? null;
}

function cumulativeForDay(candles, dayStart, throughHour, hourFraction, includePartial) {
  let sum = 0;
  for (let hour = 0; hour <= throughHour; hour += 1) {
    const candle = getCandle(candles, dayStart, hour);
    if (!candle) continue;
    const isPartial = hour === throughHour && includePartial && hourFraction < 1;
    sum += isPartial ? candle.quoteVolume * hourFraction : candle.quoteVolume;
  }
  return sum;
}

function cumulativeActualForDay(candles, dayStart, throughHour) {
  let sum = 0;
  for (let hour = 0; hour <= throughHour; hour += 1) {
    sum += getCandle(candles, dayStart, hour)?.quoteVolume ?? 0;
  }
  return sum;
}

function remainingForDay(candles, dayStart, currentHour, currentHourFraction) {
  let sum = 0;
  const current = getCandle(candles, dayStart, currentHour);
  if (current && currentHourFraction < 1) sum += current.quoteVolume * (1 - currentHourFraction);
  for (let hour = currentHour + 1; hour < 24; hour += 1) {
    sum += getCandle(candles, dayStart, hour)?.quoteVolume ?? 0;
  }
  return sum;
}

function predictTodayHourValue({ ctx, hour, targetHourIndex, currentHourFraction, today, baselineAverage }) {
  if (!ctx.isLiveTargetDay) return today?.quoteVolume ?? null;
  if (hour < targetHourIndex) return today?.quoteVolume ?? null;
  if (hour === targetHourIndex) return today ? today.quoteVolume / currentHourFraction : baselineAverage;
  return baselineAverage;
}

function markdownTable(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col] ?? "").length)));
  const formatRow = (row) => `| ${row.map((cell, col) => String(cell ?? "").padEnd(widths[col], " ")).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [formatRow(rows[0]), separator, ...rows.slice(1).map(formatRow)].join("\n");
}

function dateHeader(dayStart, targetDayStart) {
  const label = formatDate(dayStart).slice(5);
  return dayStart === targetDayStart ? `${label} 今天` : label;
}

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseUtcDate(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid UTC date ${value}; expected YYYY-MM-DD`);
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (formatDate(ms) !== value) throw new Error(`Invalid UTC date ${value}`);
  return ms;
}

function floorToDay(ms) {
  return Math.floor(ms / dayMs) * dayMs;
}

function floorToHour(ms) {
  return Math.floor(ms / hourMs) * hourMs;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values) {
  return quantile(values, 0.5);
}

function quantile(values, p) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  return finite[Math.floor((finite.length - 1) * p)];
}

function classifyHeat(value, baseline) {
  if (!Number.isFinite(value) || baseline.length === 0) return "?";
  const q25 = quantile(baseline, 0.25);
  const q75 = quantile(baseline, 0.75);
  const max = Math.max(...baseline);
  if (value > max * 1.1) return "X";
  if (value >= q75) return "H";
  if (value <= q25) return "C";
  return "N";
}

function formatBillions(value) {
  if (!Number.isFinite(value)) return "--";
  return `${(value / 1e9).toFixed(2)}B`;
}

function formatRatio(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return "--";
  return `${(value / base).toFixed(2)}x`;
}

function rankText(value, baseline) {
  const finite = baseline.filter(Number.isFinite).sort((a, b) => b - a);
  if (!Number.isFinite(value) || finite.length === 0) return "--";
  const better = finite.filter((item) => item > value).length;
  return `${better + 1}/${finite.length + 1}`;
}

function rangeName(value) {
  if (value < 10e9) return "低于 $10B";
  if (value < 12.5e9) return "$10B - $12.5B";
  if (value < 15e9) return "$12.5B - $15B";
  if (value < 17.5e9) return "$15B - $17.5B";
  if (value < 20e9) return "$17.5B - $20B";
  return "高于 $20B";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
