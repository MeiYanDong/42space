#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SECONDS = [-1, 0, 1, 2, 3, 5, 10, 15, 18, 19, 20, 21, 22];
const COLORS = ["#2563eb", "#dc2626", "#059669", "#9333ea", "#d97706", "#0891b2"];

if (isDirectRun()) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("Usage: node scripts/premium-watch-chart.js --input <file.enriched.jsonl> [--output <report.html>]");
    process.exitCode = 1;
    return;
  }

  const outputFile = renderPremiumWatchChartFile({
    inputFile: args.input,
    outputFile: args.output
  });
  console.log(outputFile);
}

export function renderPremiumWatchChartFile({ inputFile, outputFile }) {
  const resolvedInputFile = path.resolve(inputFile);
  const rows = readJsonl(resolvedInputFile);
  if (rows.length === 0) {
    throw new Error(`No rows found in ${resolvedInputFile}`);
  }

  const analysis = analyzeRows(rows);
  const resolvedOutputFile = path.resolve(outputFile ?? defaultOutputFile(resolvedInputFile));
  fs.mkdirSync(path.dirname(resolvedOutputFile), { recursive: true });
  fs.writeFileSync(resolvedOutputFile, renderHtml({ inputFile: resolvedInputFile, rows, analysis }), "utf8");
  return resolvedOutputFile;
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--input" || item === "-i") args.input = argv[++i];
    else if (item === "--output" || item === "-o") args.output = argv[++i];
    else if (!args.input) args.input = item;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function defaultOutputFile(inputFile) {
  return inputFile.replace(/\.enriched\.jsonl$/u, ".chart.html").replace(/\.jsonl$/u, ".chart.html");
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on ${file}:${index + 1}: ${error.message}`);
      }
    });
}

function analyzeRows(rows) {
  const sampleRows = rows.filter((row) => row.rowType === "sample");
  const validRows = sampleRows.filter((row) => row.ok);
  const headerRow = validRows[0] ?? sampleRows[0] ?? rows[0] ?? {};
  const stakes = unique(validRows.map((row) => Number(row.stakeUsdt)).filter(Number.isFinite)).sort((a, b) => a - b);
  const series = stakes.map((stake, index) => ({
    stake,
    label: `${formatNumber(stake)}U`,
    color: COLORS[index % COLORS.length],
    rows: aggregateBySecond(validRows.filter((row) => Number(row.stakeUsdt) === stake))
  }));

  return {
    header: {
      question: headerRow.question ?? "",
      market: headerRow.market ?? "",
      startDate: headerRow.startDate ?? "",
      discoverySources: Array.isArray(headerRow.discoverySources) ? headerRow.discoverySources : [],
      status: headerRow.status ?? "",
      createdAt: headerRow.createdAt ?? "",
      sampleCount: sampleRows.length,
      validSampleCount: validRows.length,
      firstChainSecond: min(validRows.map((row) => Number(row.chainOffsetSeconds)).filter(Number.isFinite)),
      lastChainSecond: max(validRows.map((row) => Number(row.chainOffsetSeconds)).filter(Number.isFinite))
    },
    stakes,
    series,
    timingRows: buildTimingRows(series),
    outcomeRows: buildOutcomeRows(validRows),
    warnings: buildWarnings(validRows, series)
  };
}

function aggregateBySecond(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const second = Number(row.chainOffsetSeconds);
    if (!Number.isFinite(second)) continue;
    const key = String(second);
    const bucket = buckets.get(key) ?? {
      second,
      premiumPct: [],
      premiumUsdt: [],
      observedCostPremiumPct: [],
      effectiveCost: [],
      otToUser: [],
      quoteLatencyMs: [],
      sampleCount: 0
    };
    bucket.sampleCount += 1;
    pushFinite(bucket.premiumPct, row.estimatedPremiumPctOfBase);
    pushFinite(bucket.premiumUsdt, row.estimatedPremiumUsdt);
    pushFinite(bucket.observedCostPremiumPct, row.observedCostPremiumPct);
    pushFinite(bucket.effectiveCost, row.effectiveCost);
    pushFinite(bucket.otToUser, row.otToUser);
    pushFinite(bucket.quoteLatencyMs, row.quoteLatencyMs);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => a.second - b.second)
    .map((bucket) => ({
      second: bucket.second,
      sampleCount: bucket.sampleCount,
      premiumPct: stat(bucket.premiumPct),
      premiumUsdt: stat(bucket.premiumUsdt),
      observedCostPremiumPct: stat(bucket.observedCostPremiumPct),
      effectiveCost: stat(bucket.effectiveCost),
      otToUser: stat(bucket.otToUser),
      quoteLatencyMs: stat(bucket.quoteLatencyMs)
    }));
}

function buildTimingRows(series) {
  const rows = [];
  for (const item of series) {
    const bySecond = new Map(item.rows.map((row) => [row.second, row]));
    for (const second of DEFAULT_SECONDS) {
      const row = bySecond.get(second);
      if (!row) continue;
      rows.push({
        stake: item.stake,
        second,
        sampleCount: row.sampleCount,
        premiumPct: row.premiumPct.median,
        premiumUsdt: row.premiumUsdt.median,
        observedCostPremiumPct: row.observedCostPremiumPct.median,
        effectiveCost: row.effectiveCost.median,
        otToUser: row.otToUser.median
      });
    }
  }
  return rows;
}

function buildOutcomeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.stakeUsdt}:${row.tokenId}:${row.outcomeName}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    const premiums = group.map((row) => Number(row.estimatedPremiumPctOfBase)).filter(Number.isFinite);
    const observed = group.map((row) => Number(row.observedCostPremiumPct)).filter(Number.isFinite);
    const qty = group.map((row) => Number(row.otToUser)).filter(Number.isFinite);
    const firstSecond = min(group.map((row) => Number(row.chainOffsetSeconds)).filter(Number.isFinite));
    const lastSecond = max(group.map((row) => Number(row.chainOffsetSeconds)).filter(Number.isFinite));
    return {
      stake: Number(first.stakeUsdt),
      outcomeName: first.outcomeName ?? `选项 ${first.tokenId}`,
      tokenId: first.tokenId,
      firstSecond,
      lastSecond,
      baselineMarkupPct: numberOrNull(first.baselineMarkupPct),
      maxPremiumPct: max(premiums),
      maxObservedCostPremiumPct: max(observed),
      minObservedCostPremiumPct: min(observed),
      maxQty: max(qty),
      sampleCount: group.length
    };
  }).sort((a, b) => a.stake - b.stake || compareToken(a.tokenId, b.tokenId));
}

function buildWarnings(validRows, series) {
  const warnings = [];
  const firstSecond = min(validRows.map((row) => Number(row.chainOffsetSeconds)).filter(Number.isFinite));
  if (Number.isFinite(firstSecond) && firstSecond > 0) {
    warnings.push(`第一条有效样本在链上 T+${formatNumber(firstSecond)}s，前 ${formatNumber(firstSecond)} 秒没有探针数据。`);
  }
  for (const item of series) {
    const maxPremium = max(item.rows.map((row) => row.premiumPct.median).filter(Number.isFinite));
    if (Number.isFinite(maxPremium) && maxPremium === 0) {
      warnings.push(`${item.label} 的“估算 premium”全程为 0，主要看实际成本曲线，不要把它解释成协议税率一直为 0。`);
    }
  }
  return unique(warnings);
}

function renderHtml({ inputFile, analysis }) {
  const title = analysis.header.question || analysis.header.market || "Premium Watch";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - premium 曲线</title>
  <style>
    :root {
      color-scheme: light;
      --text: #172033;
      --muted: #637083;
      --line: #d9dee8;
      --panel: #ffffff;
      --bg: #f6f7f9;
      --warn-bg: #fff7ed;
      --warn-line: #fed7aa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 24px 56px; }
    header { margin-bottom: 18px; }
    h1 { margin: 0 0 10px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 19px; letter-spacing: 0; }
    h3 { margin: 0 0 8px; font-size: 15px; letter-spacing: 0; }
    p { margin: 8px 0; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 18px; color: var(--muted); font-size: 14px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin: 14px 0;
      overflow-x: auto;
    }
    .warning {
      background: var(--warn-bg);
      border-color: var(--warn-line);
      color: #7c2d12;
    }
    .chart { width: 100%; min-width: 860px; height: auto; display: block; }
    .grid { stroke: #e5e8ef; stroke-width: 1; }
    .axis { stroke: #8b96a8; stroke-width: 1.2; }
    .tick { fill: #64748b; font-size: 12px; }
    .label { fill: #334155; font-size: 13px; font-weight: 600; }
    .legend { fill: #334155; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 9px; text-align: right; white-space: nowrap; }
    th:first-child, td:first-child { text-align: left; }
    th { color: #475569; font-weight: 700; background: #f8fafc; }
    .small { color: var(--muted); font-size: 13px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <div>市场地址：<code>${escapeHtml(analysis.header.market || "n/a")}</code></div>
      <div>开盘时间：${escapeHtml(analysis.header.startDate || "n/a")}</div>
      <div>发现来源：${escapeHtml(analysis.header.discoverySources.join(", ") || "n/a")}</div>
      <div>样本：${formatInteger(analysis.header.validSampleCount)} 条有效 / ${formatInteger(analysis.header.sampleCount)} 条总计</div>
      <div>链上覆盖：T+${formatNumber(analysis.header.firstChainSecond)}s 到 T+${formatNumber(analysis.header.lastChainSecond)}s</div>
      <div>输入文件：<code>${escapeHtml(inputFile)}</code></div>
    </div>
  </header>

  ${analysis.warnings.length ? renderWarnings(analysis.warnings) : ""}

  <section class="panel">
    <h3>这张图怎么读</h3>
    <p>第一张看“扣掉 20 秒后基线”的估算 premium。第二张看真实买入成本相对 20 秒后基线的变化，它会混入别人买入造成的价格曲线变化。第三张更直观：同样金额在第几秒能拿到多少份。</p>
  </section>

  <section class="panel">
    <h2>估算 premium 走势</h2>
    ${renderLineChart({
      series: analysis.series,
      valuePath: ["premiumPct", "median"],
      yLabel: "估算 premium %",
      valueSuffix: "%",
      zeroFloor: true
    })}
  </section>

  <section class="panel">
    <h2>实际成本曲线溢价</h2>
    ${renderLineChart({
      series: analysis.series,
      valuePath: ["observedCostPremiumPct", "median"],
      yLabel: "真实成本相对基线 %",
      valueSuffix: "%"
    })}
  </section>

  <section class="panel">
    <h2>同样金额能买到多少</h2>
    ${renderLineChart({
      series: analysis.series,
      valuePath: ["otToUser", "median"],
      yLabel: "买到数量",
      valueSuffix: ""
    })}
  </section>

  <section class="panel">
    <h2>报价耗时</h2>
    ${renderLineChart({
      series: analysis.series,
      valuePath: ["quoteLatencyMs", "median"],
      yLabel: "报价耗时 ms",
      valueSuffix: "ms",
      zeroFloor: true
    })}
  </section>

  <section class="panel">
    <h2>关键秒数表</h2>
    ${renderTimingTable(analysis.timingRows)}
  </section>

  <section class="panel">
    <h2>选项摘要</h2>
    ${renderOutcomeTable(analysis.outcomeRows)}
  </section>

  <section class="panel small">
    <h2>计算口径</h2>
    <p>每次探针只做只读模拟买入：问合约现在花固定金额会拿到多少份。实际每份成本等于花费金额除以拿到数量。估算 premium 等于当前报价相对开盘前价格的溢价，减去同一市场、同一选项、同一金额在链上 T+20s 之后的正常溢价基线。真实成本曲线没有扣这个基线，所以能反映实际狙击成本，但不是纯协议税率。</p>
  </section>
</main>
</body>
</html>
`;
}

function renderWarnings(warnings) {
  return `<section class="panel warning">
    <h3>读图注意</h3>
    ${warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("\n")}
  </section>`;
}

function renderLineChart({ series, valuePath, yLabel, valueSuffix, zeroFloor = false }) {
  const width = 1080;
  const height = 390;
  const margin = { top: 30, right: 34, bottom: 48, left: 78 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const allPoints = series.flatMap((item) => item.rows.map((row) => ({
    x: row.second,
    y: valueAt(row, valuePath),
    label: item.label
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));

  if (allPoints.length === 0) {
    return "<p>没有可画的数据。</p>";
  }

  const xMin = Math.min(-1, Math.floor(min(allPoints.map((point) => point.x))));
  const xMax = Math.max(22, Math.ceil(max(allPoints.map((point) => point.x))));
  let yMin = min(allPoints.map((point) => point.y));
  let yMax = max(allPoints.map((point) => point.y));
  if (zeroFloor) yMin = Math.min(0, yMin);
  if (yMin === yMax) {
    const pad = yMax === 0 ? 1 : Math.abs(yMax * 0.2);
    yMin -= pad;
    yMax += pad;
  } else {
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad;
    yMax += pad;
  }
  if (zeroFloor) yMin = Math.min(0, yMin);

  const xScale = (x) => margin.left + ((x - xMin) / (xMax - xMin || 1)) * innerWidth;
  const yScale = (y) => margin.top + innerHeight - ((y - yMin) / (yMax - yMin || 1)) * innerHeight;
  const xTicks = buildTicks(xMin, xMax, 1).filter((tick) => tick >= -1 && tick <= 22);
  const yTicks = buildNiceTicks(yMin, yMax, 5);

  const paths = series.map((item) => {
    const points = item.rows
      .map((row) => ({ x: row.second, y: valueAt(row, valuePath) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => `${round(xScale(point.x), 2)},${round(yScale(point.y), 2)}`)
      .join(" ");
    if (!points) return "";
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("\n");

  const dots = series.map((item) => item.rows
    .map((row) => ({ x: row.second, y: valueAt(row, valuePath), n: row.sampleCount }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => `<circle cx="${round(xScale(point.x), 2)}" cy="${round(yScale(point.y), 2)}" r="3.2" fill="${item.color}">
      <title>${escapeHtml(item.label)} T+${formatNumber(point.x)}s: ${formatNumber(point.y)}${escapeHtml(valueSuffix)}，样本 ${point.n}</title>
    </circle>`)
    .join("\n")).join("\n");

  const legend = series.map((item, index) => {
    const x = margin.left + index * 110;
    const y = 22;
    return `<g><line x1="${x}" y1="${y}" x2="${x + 24}" y2="${y}" stroke="${item.color}" stroke-width="3"/><text x="${x + 32}" y="${y + 4}" class="legend">${escapeHtml(item.label)}</text></g>`;
  }).join("\n");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(yLabel)} 曲线">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#fff" />
    ${legend}
    ${yTicks.map((tick) => `<line class="grid" x1="${margin.left}" y1="${round(yScale(tick), 2)}" x2="${width - margin.right}" y2="${round(yScale(tick), 2)}" />
      <text class="tick" x="${margin.left - 10}" y="${round(yScale(tick) + 4, 2)}" text-anchor="end">${escapeHtml(formatAxis(tick))}</text>`).join("\n")}
    ${xTicks.map((tick) => `<line class="grid" x1="${round(xScale(tick), 2)}" y1="${margin.top}" x2="${round(xScale(tick), 2)}" y2="${height - margin.bottom}" opacity="${tick % 5 === 0 ? 1 : 0.35}" />
      <text class="tick" x="${round(xScale(tick), 2)}" y="${height - 18}" text-anchor="middle">T+${tick}</text>`).join("\n")}
    <line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" />
    <line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" />
    <text class="label" x="${margin.left}" y="${height - 4}">链上开盘后秒数</text>
    <text class="label" x="20" y="${margin.top}" transform="rotate(-90 20 ${margin.top})">${escapeHtml(yLabel)}</text>
    ${paths}
    ${dots}
  </svg>`;
}

function renderTimingTable(rows) {
  if (rows.length === 0) return "<p>没有关键秒数数据。</p>";
  return `<table>
    <thead><tr>
      <th>金额</th>
      <th>链上时间</th>
      <th>估算 premium</th>
      <th>premium 金额</th>
      <th>真实成本溢价</th>
      <th>每份成本</th>
      <th>买到数量</th>
      <th>样本</th>
    </tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${formatNumber(row.stake)}U</td>
        <td>T+${formatNumber(row.second)}s</td>
        <td>${formatPercent(row.premiumPct)}</td>
        <td>${formatMoney(row.premiumUsdt)}U</td>
        <td>${formatPercent(row.observedCostPremiumPct)}</td>
        <td>${formatMoney(row.effectiveCost)}U</td>
        <td>${formatNumber(row.otToUser)}</td>
        <td>${formatInteger(row.sampleCount)}</td>
      </tr>`).join("\n")}
    </tbody>
  </table>`;
}

function renderOutcomeTable(rows) {
  if (rows.length === 0) return "<p>没有选项数据。</p>";
  return `<table>
    <thead><tr>
      <th>选项</th>
      <th>金额</th>
      <th>覆盖</th>
      <th>20秒后基线</th>
      <th>最大估算 premium</th>
      <th>最大真实成本溢价</th>
      <th>最大可买数量</th>
      <th>样本</th>
    </tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.outcomeName)}</td>
        <td>${formatNumber(row.stake)}U</td>
        <td>T+${formatNumber(row.firstSecond)}s 到 T+${formatNumber(row.lastSecond)}s</td>
        <td>${formatPercent(row.baselineMarkupPct)}</td>
        <td>${formatPercent(row.maxPremiumPct)}</td>
        <td>${formatPercent(row.maxObservedCostPremiumPct)}</td>
        <td>${formatNumber(row.maxQty)}</td>
        <td>${formatInteger(row.sampleCount)}</td>
      </tr>`).join("\n")}
    </tbody>
  </table>`;
}

function stat(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : null,
    p25: quantile(sorted, 0.25),
    median: median(sorted),
    p75: quantile(sorted, 0.75),
    max: sorted.length ? sorted[sorted.length - 1] : null
  };
}

function valueAt(row, pathParts) {
  let value = row;
  for (const part of pathParts) value = value?.[part];
  return Number(value);
}

function pushFinite(target, value) {
  const n = Number(value);
  if (Number.isFinite(n)) target.push(n);
}

function median(values) {
  if (!values.length) return null;
  return quantile(values, 0.5);
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.every((value, index, array) => index === 0 || array[index - 1] <= value)
    ? values
    : [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

function buildTicks(minValue, maxValue, step) {
  const ticks = [];
  for (let value = Math.ceil(minValue / step) * step; value <= maxValue; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function buildNiceTicks(minValue, maxValue, count) {
  const span = maxValue - minValue;
  if (!Number.isFinite(span) || span <= 0) return [minValue, maxValue].filter(Number.isFinite);
  const rawStep = span / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const start = Math.floor(minValue / step) * step;
  const end = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(round(value, 12));
  }
  return ticks.slice(0, 8);
}

function formatAxis(value) {
  const abs = Math.abs(value);
  if (abs >= 1000) return formatNumber(value);
  if (abs >= 10) return String(round(value, 1));
  if (abs >= 1) return String(round(value, 2));
  return String(round(value, 6));
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return "n/a";
  return `${formatNumber(value)}%`;
}

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return "n/a";
  const n = Number(value);
  if (Math.abs(n) > 0 && Math.abs(n) < 0.000001) return n.toExponential(2);
  return formatNumber(n);
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return "n/a";
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.000001) return n.toExponential(2);
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 10) return String(round(n, 4));
  if (abs >= 1) return String(round(n, 6));
  return String(round(n, 9));
}

function formatInteger(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Math.round(Number(value)).toLocaleString("en-US");
}

function round(value, digits = 6) {
  if (!Number.isFinite(Number(value))) return value;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function min(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : null;
}

function max(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unique(values) {
  return [...new Set(values)];
}

function compareToken(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
