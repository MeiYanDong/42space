#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FOLLOW_RULE_EVENT_LIBRARY, FOLLOW_RULE_LIBRARY_CONFIG } from "../src/event-library.js";
import { classifyEventIntelMarket, evaluateLocalBinanceRelation } from "../src/event-intel.js";
import { getEventMarketDecision, getEventMarketDisplayDecision } from "../src/event-strategy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "output");
const htmlFile = path.join(outputDir, "follow-rule-validation.html");
const jsonFile = path.join(outputDir, "follow-rule-validation.json");

const rows = FOLLOW_RULE_EVENT_LIBRARY.map((entry) => {
  const cfg = {
    ...FOLLOW_RULE_LIBRARY_CONFIG,
    eventIntelBuyFile: path.join(outputDir, "missing-follow-rule-intel.jsonl"),
    marketFollowState: { followed: {}, blocked: {} }
  };
  const decision = getEventMarketDecision(entry.market, cfg);
  const displayDecision = getEventMarketDisplayDecision(entry.market, cfg, decision);
  const classification = classifyEventIntelMarket(entry.market);
  const relation = evaluateLocalBinanceRelation(entry.market);
  const checks = buildChecks(entry, decision, displayDecision);
  const pass = checks.every((check) => check.pass);
  return {
    id: entry.id,
    question: entry.market.question,
    categories: entry.market.categories ?? [],
    tags: entry.market.tags ?? [],
    note: entry.note,
    expected: entry.expected,
    decision,
    displayDecision,
    classification: {
      eventKind: classification.eventKind,
      fixedTemplate: Boolean(classification.fixedTemplate),
      priceEvent: Boolean(classification.priceEvent)
    },
    relation: {
      level: relation.level,
      score: relation.score,
      evidence: relation.evidence
    },
    route: buildRoute(entry.market, decision, displayDecision, classification, relation),
    checks,
    pass
  };
});

const summary = {
  generatedAt: new Date().toISOString(),
  total: rows.length,
  passed: rows.filter((row) => row.pass).length,
  failed: rows.filter((row) => !row.pass).length
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(jsonFile, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
fs.writeFileSync(htmlFile, renderHtml(summary, rows));

console.log(JSON.stringify({
  level: "follow-rule-validation-report",
  summary,
  htmlFile,
  jsonFile
}, null, 2));

function buildChecks(entry, decision, displayDecision) {
  const checks = [
    {
      label: "eligible",
      expected: String(entry.expected.eligible),
      actual: String(Boolean(decision.eligible)),
      pass: Boolean(decision.eligible) === Boolean(entry.expected.eligible)
    }
  ];
  if (entry.expected.reason) {
    checks.push({
      label: "reason",
      expected: entry.expected.reason,
      actual: decision.reason,
      pass: decision.reason === entry.expected.reason
    });
  }
  if (entry.expected.defaultFollowed !== undefined) {
    checks.push({
      label: "defaultFollowed",
      expected: String(entry.expected.defaultFollowed),
      actual: String(Boolean(decision.follow?.defaultFollowed)),
      pass: Boolean(decision.follow?.defaultFollowed) === Boolean(entry.expected.defaultFollowed)
    });
  }
  for (const tag of entry.expected.tagsAny ?? []) {
    checks.push({
      label: `tag:${tag}`,
      expected: "present",
      actual: (decision.tags ?? []).includes(tag) ? "present" : "missing",
      pass: (decision.tags ?? []).includes(tag)
    });
  }
  if (entry.expected.displayVisible !== undefined) {
    checks.push({
      label: "displayVisible",
      expected: String(entry.expected.displayVisible),
      actual: String(Boolean(displayDecision.visible)),
      pass: Boolean(displayDecision.visible) === Boolean(entry.expected.displayVisible)
    });
  }
  if (entry.expected.displayNotify !== undefined) {
    checks.push({
      label: "displayNotify",
      expected: String(entry.expected.displayNotify),
      actual: String(Boolean(displayDecision.notify)),
      pass: Boolean(displayDecision.notify) === Boolean(entry.expected.displayNotify)
    });
  }
  if (entry.expected.displayReason) {
    checks.push({
      label: "displayReason",
      expected: entry.expected.displayReason,
      actual: displayDecision.reason,
      pass: displayDecision.reason === entry.expected.displayReason
    });
  }
  for (const tag of entry.expected.displayTagsAny ?? []) {
    checks.push({
      label: `displayTag:${tag}`,
      expected: "present",
      actual: (displayDecision.tags ?? []).includes(tag) ? "present" : "missing",
      pass: (displayDecision.tags ?? []).includes(tag)
    });
  }
  return checks;
}

function buildRoute(market, decision, displayDecision, classification, relation) {
  const stages = [
    {
      label: "基础数据",
      state: Array.isArray(market.outcomes) && market.outcomes.length > 0 ? "pass" : "block",
      text: `${market.status ?? "unknown"} / outcomes ${market.outcomes?.length ?? 0}`
    },
    {
      label: "Price/固定模板",
      state: classification.priceEvent || classification.fixedTemplate || decision.reason === "price-market" || decision.reason === "event-intel-archive" ? "block" : "pass",
      text: classification.priceEvent ? "Price 事件" : (classification.fixedTemplate ? "固定模板" : "非 Price/非固定模板")
    },
    {
      label: "低交易量排除",
      state: decision.reason === "event-intel-low-liquidity" ? "block" : "pass",
      text: decision.reason === "event-intel-low-liquidity" ? "Tweet Count 排除" : "未命中排除"
    },
    {
      label: "Meme 默认关注",
      state: (decision.tags ?? []).includes("Meme 默认关注") ? "hit" : "skip",
      text: (decision.tags ?? []).includes("Meme 默认关注") ? "命中 Meme 关注" : "未命中 Meme"
    },
    {
      label: "Binance strong",
      state: (decision.tags ?? []).includes("Binance strong") || relation.level === "strong" ? "hit" : "skip",
      text: `${relation.level} / score ${relation.score}`
    },
    {
      label: "默认显示/通知",
      state: displayDecision.visible ? (displayDecision.notify ? "hit" : "pass") : "block",
      text: `${displayDecision.reasonText} / ${displayDecision.notify ? "通知" : "不通知"}`
    },
    {
      label: "最终判定",
      state: decision.eligible ? "hit" : "block",
      text: `${decision.reasonText} (${decision.reason})`
    }
  ];
  return stages;
}

function renderHtml(summary, rows) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>42space Bot2 关注规则验证</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #202124;
      --muted: #65707c;
      --line: #d8dee4;
      --bg: #f7f9fb;
      --panel: #ffffff;
      --green: #1d7f4f;
      --green-bg: #eaf7ef;
      --red: #b42318;
      --red-bg: #fdecec;
      --blue: #2456a3;
      --blue-bg: #edf3ff;
      --gray-bg: #eef1f4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    header {
      padding: 22px 28px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
      letter-spacing: 0;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--muted);
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px 24px 36px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .metric b { display: block; font-size: 24px; }
    .metric span { color: var(--muted); }
    .rule {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 18px;
    }
    .rule h2 {
      margin: 0 0 8px;
      font-size: 16px;
    }
    .rule ol {
      margin: 0;
      padding-left: 20px;
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      vertical-align: top;
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #f1f4f7;
      font-weight: 650;
      color: #374151;
    }
    tr:last-child td { border-bottom: 0; }
    .question {
      min-width: 270px;
      font-weight: 620;
    }
    .note {
      color: var(--muted);
      margin-top: 4px;
      font-size: 12px;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 6px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--gray-bg);
      color: #394150;
      font-size: 12px;
      white-space: nowrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
    }
    .ok { color: var(--green); background: var(--green-bg); }
    .bad { color: var(--red); background: var(--red-bg); }
    .info { color: var(--blue); background: var(--blue-bg); }
    .muted { color: var(--muted); }
    .route {
      display: grid;
      gap: 6px;
      min-width: 340px;
    }
    .stage {
      display: grid;
      grid-template-columns: 96px 1fr;
      gap: 8px;
      align-items: center;
    }
    .stage-name {
      color: var(--muted);
      font-size: 12px;
    }
    .stage-pill {
      border-left: 4px solid #aab2bd;
      background: var(--gray-bg);
      border-radius: 4px;
      padding: 4px 7px;
      min-height: 28px;
    }
    .stage-pass { border-left-color: var(--green); background: var(--green-bg); }
    .stage-hit { border-left-color: var(--blue); background: var(--blue-bg); }
    .stage-block { border-left-color: var(--red); background: var(--red-bg); }
    .checks {
      min-width: 230px;
    }
    .check {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 0;
      border-bottom: 1px dashed #e5e7eb;
      font-size: 12px;
    }
    .check:last-child { border-bottom: 0; }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    @media (max-width: 920px) {
      main { padding: 14px; }
      .summary { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
      th { position: static; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Bot2 关注规则验证</h1>
    <div class="meta">
      <span>生成时间：${escapeHtml(formatLocal(summary.generatedAt))}</span>
      <span>事件库：<span class="mono">src/event-library.js</span></span>
      <span>规则：<span class="mono">EVENT_INTEL_BUY_FILTER=strong</span></span>
    </div>
  </header>
  <main>
    <section class="summary">
      <div class="metric"><b>${summary.total}</b><span>事件库样例</span></div>
      <div class="metric"><b>${summary.passed}</b><span>验证通过</span></div>
      <div class="metric"><b>${summary.failed}</b><span>验证失败</span></div>
    </section>
    <section class="rule">
      <h2>验证流水线</h2>
      <ol>
        <li>基础市场可用：状态可处理且有 outcomes。</li>
        <li>先排除 Price / 8hour / automated / 日常固定模板。</li>
        <li>体育市场只过滤总进球数 / 净胜球数等边盘，准确比分通过这一步保留下来。</li>
        <li>再排除低交易量题材：当前是 <span class="mono">Tweet Count</span>。</li>
        <li>Meme 板块默认关注；REST categories 为空时使用题目兜底识别。</li>
        <li>非 Meme 继续要求 Binance strong 或 JSONL strong。</li>
        <li>显示和飞书通知独立于买入：非过滤事件默认显示并通知。</li>
        <li>比对事件库里的期望值：eligible、reason、defaultFollowed、关键标签。</li>
      </ol>
    </section>
    <table>
      <thead>
        <tr>
          <th>结果</th>
          <th>事件</th>
          <th>规则路径</th>
          <th>实际判定</th>
          <th>期望校验</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(renderRow).join("\n")}
      </tbody>
    </table>
  </main>
</body>
</html>
`;
}

function renderRow(row) {
  return `<tr>
  <td>${row.pass ? `<span class="badge ok">PASS</span>` : `<span class="badge bad">FAIL</span>`}</td>
  <td>
    <div class="question">${escapeHtml(row.question)}</div>
    <div class="note">${escapeHtml(row.note)}</div>
    <div class="tags">
      ${renderTags(["id:" + row.id, ...row.categories.map((item) => `category:${item}`), ...row.tags.map((item) => `tag:${item}`)])}
    </div>
  </td>
  <td><div class="route">${row.route.map(renderStage).join("")}</div></td>
  <td>
    <div>${row.decision.eligible ? `<span class="badge ok">默认关注</span>` : `<span class="badge bad">不关注</span>`}</div>
    <div class="note">reason: <span class="mono">${escapeHtml(row.decision.reason)}</span></div>
    <div class="note">defaultFollowed: <span class="mono">${escapeHtml(String(Boolean(row.decision.follow?.defaultFollowed)))}</span></div>
    <div class="tags">${renderTags(row.decision.tags ?? [])}</div>
  </td>
  <td class="checks">${row.checks.map(renderCheck).join("")}</td>
</tr>`;
}

function renderStage(stage) {
  const cls = stage.state === "block" ? "stage-block" : (stage.state === "hit" ? "stage-hit" : (stage.state === "pass" ? "stage-pass" : ""));
  return `<div class="stage">
  <div class="stage-name">${escapeHtml(stage.label)}</div>
  <div class="stage-pill ${cls}">${escapeHtml(stage.text)}</div>
</div>`;
}

function renderCheck(check) {
  return `<div class="check">
  <span>${check.pass ? `<span class="badge ok">OK</span>` : `<span class="badge bad">BAD</span>`} ${escapeHtml(check.label)}</span>
  <span class="mono">${escapeHtml(check.actual)}</span>
</div>`;
}

function renderTags(tags) {
  return tags
    .filter(Boolean)
    .map((tag) => `<span class="tag">${escapeHtml(String(tag))}</span>`)
    .join("");
}

function formatLocal(iso) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
