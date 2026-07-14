#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_OPEN_BROADCAST_DELAY_MS = 19900;
const DEFAULT_OPEN_WINDOW_SECONDS = 35;
const DEFAULT_TIMED_BUY_EXECUTOR_ADDRESS = "0xC2B2F78C620228Ea8d1B2E155664ceBbc7212148";
const TARGETS = [
  {
    id: "openrouter-python",
    questionPattern: "highest Python usage on OpenRouter",
    sampleQuestion: "Which AI model will have the highest Python usage on OpenRouter on June 27th?",
    titleRe: /highest\s+Python\s+usage\s+on\s+OpenRouter|AI\s*模型.*OpenRouter.*Python.*使用量.*最高/iu,
    outcomes: ["Hy3 (free)", "MiMo - V2.5"],
    expectedBroadcastDelayMs: 19900,
    latestAllowedBroadcastStartDelayMs: 20000,
    gasPriceGwei: "0.5",
    builderBundle: {
      enabled: true,
      mode: "builder_only",
      tipBnb: "0.001",
      timeoutMs: 700,
      timingMode: "first_20s_block",
      targetSecond: 20,
      prepositionLeadMs: 700,
      exactSecond: true,
      noMerge: true,
      timedBuyExecutorAddress: DEFAULT_TIMED_BUY_EXECUTOR_ADDRESS,
      positionFirst: true
    },
    autoSell: {
      priceTargets: [
        { outcome: "Hy3 (free)", price: 0.002 },
        { outcome: "MiMo - V2.5", price: 0.0017 }
      ],
      priceHotPollMs: 1000,
      priceHotWindowSeconds: 600,
      priceSellPercent: 100,
      stopLossEnabled: false
    }
  },
  {
    id: "bnbusdt-daily-volume",
    questionPattern: "BNB/USDT Futures Daily Volume",
    sampleQuestion: "BNB/USDT Futures Daily Volume, June 27th?",
    titleRe: /BNB\/USDT\s+Futures\s+Daily\s+Volume|BNB\/USDT.*期[貨货]每日交易量/iu,
    outcomes: ["$150M \u2013 $300M", "$300M \u2013 $450M"],
    expectedBroadcastDelayMs: 22000,
    latestAllowedBroadcastStartDelayMs: 23000,
    gasPriceGwei: "0.15"
  }
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAtMs = Date.now();
  const waitUntilComplete = Boolean(args.waitUntilComplete);
  const retryMs = Math.max(1000, Number(args.retryMs ?? 60000));
  const maxWaitMs = Math.max(0, Number(args.maxWaitMs ?? 0));
  const hasMaxWait = maxWaitMs > 0;
  let latest = null;
  do {
    const elapsedMs = Date.now() - startedAtMs;
    const timedOut = waitUntilComplete && hasMaxWait && elapsedMs >= maxWaitMs;
    latest = collectAndWriteEvidence({ ...args, timedOut });
    if (latest.report.conclusion === "complete") process.exit(0);
    if (!waitUntilComplete || args.singlePass) process.exit(2);
    if (timedOut) process.exit(2);
    const nextSleepMs = hasMaxWait
      ? Math.min(retryMs, Math.max(1000, maxWaitMs - (Date.now() - startedAtMs)))
      : retryMs;
    sleepSync(nextSleepMs);
  } while (true);
}

function collectAndWriteEvidence(args) {
  const appDir = path.resolve(args.appDir ?? process.cwd());
  const profileEnvFile = args.profileEnv ?? "/etc/42space/profiles/42space-4.env";
  const openingIso = normalizeIso(args.opening ?? defaultDailyOpeningIso(Date.now()));
  const openingMs = Date.parse(openingIso);
  if (!Number.isFinite(openingMs)) throw new Error(`Invalid opening time: ${args.opening}`);

  const profileEnv = parseEnvFile(profileEnvFile);
  const env = { ...process.env, ...profileEnv };
  const dataDir = path.dirname(profileEnv.RUNTIME_CONFIG_FILE ?? "/opt/42space/data/42space-4/runtime-config.json");
  const outDir = path.resolve(args.outDir ?? path.join(appDir, "output", "bot4-first-buy"));
  fs.mkdirSync(outDir, { recursive: true });

  const targetConfigs = resolveTargetConfigs(profileEnv, openingMs);
  const sinceMs = openingMs - Number(args.beforeMs ?? 10 * 60 * 1000);
  const untilMs = openingMs + Number(args.afterMs ?? 15 * 60 * 1000);
  const generatedAt = new Date().toISOString();

  const status = runEventJson(appDir, env, ["status", "--json"]);
  const decisions = filterWindow(readJsonl(profileEnv.MARKET_DECISIONS_FILE ?? path.join(dataDir, "market-decisions.jsonl")), sinceMs, untilMs);
  const fills = filterWindow(readJsonl(profileEnv.FILLS_FILE ?? path.join(dataDir, "fills.jsonl")), sinceMs, untilMs);
  const journal = readJournal(args.unit ?? "42space-event@42space-4.service", sinceMs, untilMs);
  const autoSellJournal = readJournal(
    args.unit ?? "42space-event@42space-4.service",
    openingMs - Number(args.autoSellBeforeMs ?? 24 * 60 * 60 * 1000),
    untilMs
  );

  const targetDecisions = decisions.filter((row) => isTargetRow(row, openingIso));
  const targetFills = fills.filter((row) => isTargetRow(row, openingIso));
  const targetBuyFills = targetFills.filter((row) => row?.result?.txHash || row?.result?.status || row?.plan);
  const txHashes = unique(targetBuyFills.map((row) => row?.result?.txHash).filter(Boolean));
  const targetReceipts = fills.filter((row) => row?.level === "event-receipt" && txHashes.includes(row.txHash));
  const targetReceiptDecisions = decisions.filter((row) => txHashes.includes(row.txHash) && String(row.action ?? "").startsWith("receipt-"));
  const journalTargetRows = journal.events.filter((row) => isTargetRow(row, openingIso) || txHashes.includes(row.txHash));
  const journalTargetText = journal.lines.filter((line) => targetLine(line, txHashes));
  const unintendedBuyFills = fills.filter((row) => {
    if (!row?.result?.txHash && !["executed", "bundle-executed"].includes(row?.level)) return false;
    return !isTargetRow(row, openingIso);
  });

  const scheduled = journalTargetRows.filter((row) => row.level === "open-broadcast-scheduled");
  const targetChecks = Object.fromEntries(TARGETS.map((target) => [
    target.id,
    targetEvidenceChecks({
      target: targetConfigs.find((item) => item.id === target.id) ?? target,
      openingIso,
      decisions,
      fills,
      journalRows: journal.events
    })
  ]));
  const preSigned = journalTargetRows.filter((row) => row.level === "pre-signed-fast-tx");
  const executed = journalTargetRows.filter((row) => row.level === "executed" || row.level === "bundle-executed");
  const receiptSuccess = [
    ...targetReceipts,
    ...targetReceiptDecisions
  ].some((row) => row.status === "success" || row.action === "receipt-success");
  const broadcasted = targetBuyFills.some((row) => ["broadcast", "success"].includes(row?.result?.status));
  const firstAcceptedRpc = targetBuyFills.some((row) => Number.isFinite(Date.parse(row?.result?.firstAcceptedAt ?? "")));
  const outcomeOk = TARGETS.every((target) => targetChecks[target.id]?.outcomeOk);
  const broadcastTimings = targetConfigs.flatMap((target) =>
    targetBuyFills
      .filter((row) => isTargetRowFor(row, target, openingIso))
      .map((row) => broadcastTiming(row, openingMs, target))
  )
    .filter(Boolean);
  const autoSellStartEvents = autoSellJournal.events.filter((row) =>
    row?.level === "event-arm-auto-sell-before-funding" && row.started === true
  );
  const stopLossDisabled = status?.watchConfig?.autoSellEnabled === true &&
    status?.watchConfig?.autoSellStopLossEnabled === false;

  const checks = {
    botRunning: status?.mode === "execute" && Boolean(status?.wallet?.address),
    nextBatchKnown: TARGETS.every((target) => status?.funding?.nextBatchMarkets?.some((market) => target.titleRe.test(market?.question ?? ""))),
    scheduled: TARGETS.every((target) => targetChecks[target.id]?.scheduled),
    scheduledOnTime: TARGETS.every((target) => targetChecks[target.id]?.scheduledOnTime),
    preSigned: TARGETS.every((target) => targetChecks[target.id]?.preSigned),
    broadcasted: TARGETS.every((target) => targetChecks[target.id]?.broadcasted),
    broadcastStartedWithinTargetWindow: TARGETS.every((target) => targetChecks[target.id]?.broadcastStartedWithinTargetWindow),
    firstAcceptedRpc: TARGETS.every((target) => targetChecks[target.id]?.firstAcceptedRpc),
    outcomeOk,
    builderSubmitted: TARGETS.every((target) => targetChecks[target.id]?.builderSubmitted),
    builderPrepositioned: TARGETS.every((target) => targetChecks[target.id]?.builderPrepositioned),
    receiptSuccess: TARGETS.every((target) => targetChecks[target.id]?.receiptSuccess),
    autoSellMonitorStarted: autoSellStartEvents.length > 0,
    stopLossDisabled,
    noUnintendedBuys: unintendedBuyFills.length === 0
  };
  const complete = checks.scheduledOnTime &&
    checks.preSigned &&
    checks.broadcasted &&
    checks.broadcastStartedWithinTargetWindow &&
    checks.firstAcceptedRpc &&
    checks.outcomeOk &&
    checks.builderSubmitted &&
    checks.builderPrepositioned &&
    checks.receiptSuccess &&
    checks.autoSellMonitorStarted &&
    checks.stopLossDisabled &&
    checks.noUnintendedBuys;
  const conclusion = complete ? "complete" : args.timedOut ? "timeout" : "pending";

  const report = {
    level: "bot4-first-buy-evidence",
    generatedAt,
    conclusion,
    wait: {
      waitUntilComplete: Boolean(args.waitUntilComplete),
      retryMs: args.retryMs !== undefined ? Number(args.retryMs) : null,
      maxWaitMs: args.maxWaitMs !== undefined ? Number(args.maxWaitMs) : null,
      singlePass: Boolean(args.singlePass),
      latestUpdated: !args.noLatest,
      timedOut: Boolean(args.timedOut)
    },
    target: {
      openingIso,
      eventOpenWindowSeconds: Number(profileEnv.EVENT_OPEN_WINDOW_SECONDS ?? DEFAULT_OPEN_WINDOW_SECONDS),
      targets: targetConfigs.map((target) => ({
        id: target.id,
        questionPattern: target.questionPattern,
        outcomes: target.outcomes,
        expectedBroadcastDelayMs: target.expectedBroadcastDelayMs,
        expectedBroadcastIso: target.expectedBroadcastIso,
        expectedPrivateSubmitDelayMs: target.expectedPrivateSubmitDelayMs,
        expectedPrivateSubmitIso: target.expectedPrivateSubmitIso,
        latestAllowedBroadcastStartDelayMs: target.latestAllowedBroadcastStartDelayMs,
        latestAllowedBroadcastStartIso: target.latestAllowedBroadcastStartIso,
        gasPriceGwei: target.gasPriceGwei,
        builderBundle: target.builderBundle ?? null,
        autoSell: target.autoSell ?? null
      }))
    },
    profile: {
      envFile: profileEnvFile,
      dataDir,
      botName: profileEnv.BOT_NAME ?? null,
      dashboardPort: profileEnv.DASHBOARD_PORT ?? null,
      eventDisplayIncludeRules: profileEnv.EVENT_DISPLAY_INCLUDE_RULES ?? null,
      openBroadcastDelayMs: profileEnv.OPEN_BROADCAST_DELAY_MS ?? null,
      eventOpenWindowSeconds: profileEnv.EVENT_OPEN_WINDOW_SECONDS ?? null,
      gasPriceGwei: profileEnv.GAS_PRICE_GWEI ?? null,
      autoSellGasPriceGwei: profileEnv.AUTO_SELL_GAS_PRICE_GWEI ?? null,
      bundleDueMarkets: profileEnv.BUNDLE_DUE_MARKETS ?? null,
      builderTimedBuyExecutorEnabled: profileEnv.BUILDER_TIMED_BUY_EXECUTOR_ENABLED ?? null,
      builderTimedBuyExecutorAddress: profileEnv.BUILDER_TIMED_BUY_EXECUTOR_ADDRESS ?? null
    },
    checks,
    targetChecks,
    wallet: status?.wallet ? {
      address: status.wallet.address,
      busdtBalance: status.wallet.busdtBalance,
      bnbBalance: status.wallet.bnbBalance,
      executableMarketCount: status.wallet.executableMarketCount,
      unfundedMarketCount: status.wallet.unfundedMarketCount,
      balanceReady: status.wallet.balanceReady,
      bnbReady: status.wallet.bnbReady,
      allowanceReady: status.wallet.allowanceReady
    } : null,
    statusFuture: status?.future ?? [],
    txHashes,
    targetDecisions,
    targetFills,
    targetReceipts,
    targetReceiptDecisions,
    targetScheduled: scheduled.filter((row) => targetConfigs.some((target) => scheduledRowOnTime(row, target))),
    broadcastTimings,
    autoSellStartEvents,
    journalEvents: journalTargetRows,
    journalExcerpts: journalTargetText.slice(-120),
    unintendedBuyFills
  };

  const stamp = generatedAt.replace(/[:.]/gu, "-");
  const jsonPath = path.join(outDir, `bot4-first-buy-evidence-${stamp}.json`);
  const mdPath = path.join(outDir, `bot4-first-buy-evidence-${stamp}.md`);
  const latestJsonPath = path.join(outDir, "latest.json");
  const latestMdPath = path.join(outDir, "latest.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));
  if (!args.noLatest) {
    fs.copyFileSync(jsonPath, latestJsonPath);
    fs.copyFileSync(mdPath, latestMdPath);
  }
  console.log(JSON.stringify({
    level: "bot4-first-buy-evidence-written",
    conclusion,
    jsonPath,
    mdPath,
    latestUpdated: !args.noLatest,
    checks,
    at: generatedAt
  }));
  return { report, jsonPath, mdPath };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function parseEnvFile(file) {
  const env = {};
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveTargetConfigs(profileEnv, openingMs) {
  const rows = readPlannedBuyRows(profileEnv.EVENT_PLANNED_BUYS_FILE);
  const profileDelayMs = Number(profileEnv.OPEN_BROADCAST_DELAY_MS ?? DEFAULT_OPEN_BROADCAST_DELAY_MS);
  const profileWindowMs = Number(profileEnv.EVENT_OPEN_WINDOW_SECONDS ?? DEFAULT_OPEN_WINDOW_SECONDS) * 1000;
  return TARGETS.map((target) => {
    const row = rows.find((item) => plannedBuyRowMatchesTarget(item, target));
    const rowDelay = Number(row?.openBroadcastDelayMs ?? row?.buyDelayMs ?? row?.broadcastDelayMs ?? row?.openDelayMs);
    const expectedBroadcastDelayMs = Number.isFinite(rowDelay)
      ? rowDelay
      : Number.isFinite(target.expectedBroadcastDelayMs)
        ? target.expectedBroadcastDelayMs
        : profileDelayMs;
    const latestAllowedBroadcastStartDelayMs = Number.isFinite(target.latestAllowedBroadcastStartDelayMs)
      ? target.latestAllowedBroadcastStartDelayMs
      : Math.max(expectedBroadcastDelayMs, profileWindowMs);
    const gasPriceGwei = row?.gasPriceGwei ?? row?.buyGasPriceGwei ?? row?.gasGwei ?? row?.buyGasGwei ?? target.gasPriceGwei ?? profileEnv.GAS_PRICE_GWEI ?? null;
    const expectedPrivateSubmitDelayMs = target.builderBundle
      ? Number(target.builderBundle.targetSecond) * 1000 - Number(target.builderBundle.prepositionLeadMs)
      : expectedBroadcastDelayMs;
    return {
      ...target,
      expectedBroadcastDelayMs,
      expectedBroadcastIso: new Date(openingMs + expectedBroadcastDelayMs).toISOString(),
      expectedPrivateSubmitDelayMs,
      expectedPrivateSubmitIso: new Date(openingMs + expectedPrivateSubmitDelayMs).toISOString(),
      latestAllowedBroadcastStartDelayMs,
      latestAllowedBroadcastStartIso: new Date(openingMs + latestAllowedBroadcastStartDelayMs).toISOString(),
      gasPriceGwei: gasPriceGwei === null ? null : String(gasPriceGwei),
      builderBundle: target.builderBundle ?? null,
      autoSell: target.autoSell ?? null
    };
  });
}

function readPlannedBuyRows(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(json) ? json : (Array.isArray(json?.plans) ? json.plans : []);
  } catch {
    return [];
  }
}

function plannedBuyRowMatchesTarget(row, target) {
  if (!row || row.enabled === false || row.disabled === true) return false;
  const question = String(row.question ?? row.title ?? "");
  const questionRegex = String(row.questionRegex ?? row.titleRegex ?? "");
  if (target.titleRe.test(question)) return true;
  if (!questionRegex) return false;
  try {
    const re = new RegExp(questionRegex, "iu");
    return re.test(target.questionPattern) || re.test(target.sampleQuestion ?? target.questionPattern);
  } catch {
    return false;
  }
}

function runEventJson(appDir, env, eventArgs) {
  const result = spawnSync("node", ["src/event-sniper.js", ...eventArgs], {
    cwd: appDir,
    env,
    encoding: "utf8",
    timeout: 120000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`event-sniper ${eventArgs.join(" ")} failed: ${trimForError(result.stderr || result.stdout)}`);
  }
  return parseFirstJsonObject(result.stdout);
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { level: "unparsed-jsonl", raw: line };
      }
    });
}

function readJournal(unit, sinceMs, untilMs) {
  const result = spawnSync("journalctl", [
    "-u", unit,
    "-o", "cat",
    "--since", formatShanghaiJournalTime(sinceMs),
    "--until", formatShanghaiJournalTime(untilMs)
  ], {
    encoding: "utf8",
    timeout: 30000
  });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const events = lines
    .map((line) => parseJsonLine(line))
    .filter(Boolean);
  return { lines, events };
}

function filterWindow(rows, sinceMs, untilMs) {
  return rows.filter((row) => {
    const at = rowTime(row);
    return !Number.isFinite(at) || (at >= sinceMs && at <= untilMs);
  });
}

function rowTime(row) {
  for (const key of ["at", "ts", "targetAt", "startDate"]) {
    const ms = Date.parse(row?.[key]);
    if (Number.isFinite(ms)) return ms;
  }
  const planStart = Date.parse(row?.plan?.market?.startDate);
  if (Number.isFinite(planStart)) return planStart;
  return NaN;
}

function isTargetRow(row, openingIso) {
  return TARGETS.some((target) => isTargetRowFor(row, target, openingIso));
}

function isTargetRowFor(row, target, openingIso) {
  const text = JSON.stringify(row ?? {});
  if (!target.titleRe.test(text) && !targetOutcomesPresent(text, target)) return false;
  const start = row?.startDate ?? row?.market?.startDate ?? row?.plan?.market?.startDate;
  if (!start) return true;
  return normalizeIso(start).slice(0, 10) === openingIso.slice(0, 10);
}

function isTargetQuestion(question) {
  const text = String(question ?? "");
  return TARGETS.some((target) => target.titleRe.test(text));
}

function broadcastTiming(row, openingMs, target) {
  const result = row?.result;
  if (!result?.txHash) return null;
  const broadcastStartedMs = Date.parse(result.broadcastStartedAt ?? "");
  const firstAcceptedMs = Date.parse(result.firstAcceptedAt ?? "");
  const expectedPrivateSubmitMs = Date.parse(target.expectedPrivateSubmitIso ?? target.expectedBroadcastIso);
  const latestAllowedBroadcastStartMs = Date.parse(target.latestAllowedBroadcastStartIso);
  const expectedBuilderTargetTimestamp = expectedBuilderTimestamp(openingMs, target);
  return {
    targetId: target.id,
    txHash: result.txHash,
    status: result.status ?? null,
    broadcastMode: result.broadcastMode ?? null,
    expectedBroadcastAt: target.expectedBroadcastIso,
    expectedPrivateSubmitAt: target.expectedPrivateSubmitIso ?? target.expectedBroadcastIso,
    expectedBuilderTargetTimestamp,
    latestAllowedBroadcastStartAt: target.latestAllowedBroadcastStartIso,
    broadcastStartedAt: result.broadcastStartedAt ?? null,
    firstAcceptedAt: result.firstAcceptedAt ?? null,
    broadcastStartDelayMs: Number.isFinite(broadcastStartedMs) ? broadcastStartedMs - openingMs : null,
    broadcastStartAfterExpectedMs: Number.isFinite(broadcastStartedMs) ? broadcastStartedMs - expectedPrivateSubmitMs : null,
    firstAcceptedDelayMs: Number.isFinite(firstAcceptedMs) ? firstAcceptedMs - openingMs : null,
    firstAcceptedAfterExpectedMs: Number.isFinite(firstAcceptedMs) ? firstAcceptedMs - expectedPrivateSubmitMs : null,
    firstAcceptedLatencyMs: result.firstAcceptedLatencyMs ?? null,
    broadcastStartedWithinTargetWindow: Number.isFinite(broadcastStartedMs) &&
      broadcastStartedMs >= expectedPrivateSubmitMs - 5 &&
      broadcastStartedMs <= latestAllowedBroadcastStartMs
  };
}

function targetLine(line, txHashes) {
  return isTargetQuestion(line) ||
    TARGETS.some((target) => targetOutcomesPresent(line, target)) ||
    /open-broadcast|pre-signed-fast|event-receipt|receipt|executed|single-execution/iu.test(line) && txHashes.some((tx) => line.includes(tx));
}

function parseJsonLine(line) {
  if (!line.startsWith("{") || !line.endsWith("}")) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseFirstJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error(`No JSON object in output: ${trimForError(text)}`);
  }
}

function renderMarkdown(report) {
  const lines = [
    "# Bot4 First Buy Evidence",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Conclusion: ${report.conclusion}`,
    `- Opening: ${report.target.openingIso}`,
    `- Open window: ${report.target.eventOpenWindowSeconds}s`,
    `- Targets: ${(report.target.targets ?? []).map((target) => `${target.questionPattern} -> ${target.outcomes.join(", ")} @ T+${Number(target.expectedBroadcastDelayMs) / 1000}s ${target.gasPriceGwei ?? ""}gwei`).join("; ")}`,
    "",
    "## Checks",
    "",
    ...Object.entries(report.checks).map(([key, value]) => `- ${key}: ${value ? "yes" : "no"}`),
    "",
    "## Target Checks",
    "",
    fencedJson(report.targetChecks),
    "",
    "## Transactions",
    "",
    report.txHashes.length ? report.txHashes.map((tx) => `- ${tx}`).join("\n") : "- none yet",
    "",
    "## Target Decisions",
    "",
    fencedJson(report.targetDecisions),
    "",
    "## Target Fills",
    "",
    fencedJson(report.targetFills),
    "",
    "## Target Receipts",
    "",
    fencedJson([...report.targetReceipts, ...report.targetReceiptDecisions]),
    "",
    "## Target Schedule",
    "",
    fencedJson(report.targetScheduled),
    "",
    "## Broadcast Timing",
    "",
    fencedJson(report.broadcastTimings),
    "",
    "## Auto Sell Monitor",
    "",
    fencedJson(report.autoSellStartEvents),
    "",
    "## Journal Excerpts",
    "",
    report.journalExcerpts.length ? report.journalExcerpts.map((line) => `- ${line}`).join("\n") : "- none",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function fencedJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function formatShanghaiJournalTime(ms) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function normalizeIso(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return String(value ?? "");
  return new Date(ms).toISOString();
}

function defaultDailyOpeningIso(nowMs) {
  const now = new Date(nowMs);
  const todayOpenMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  const evidenceWindowMs = 35 * 60 * 1000;
  const targetMs = nowMs < todayOpenMs + evidenceWindowMs ? todayOpenMs : todayOpenMs + 24 * 60 * 60 * 1000;
  return new Date(targetMs).toISOString();
}

function unique(values) {
  return [...new Set(values)];
}

function targetEvidenceChecks({ target, openingIso, decisions, fills, journalRows }) {
  const targetFills = fills.filter((row) => isTargetRowFor(row, target, openingIso));
  const targetBuyFills = targetFills.filter((row) => row?.result?.txHash || row?.result?.status || row?.plan);
  const txHashes = unique(targetBuyFills.map((row) => row?.result?.txHash).filter(Boolean));
  const targetJournalRows = journalRows.filter((row) => isTargetRowFor(row, target, openingIso) || txHashes.includes(row?.txHash));
  const targetReceiptRows = [
    ...targetFills.filter((row) => row?.level === "event-receipt" && txHashes.includes(row.txHash)),
    ...decisions.filter((row) => txHashes.includes(row.txHash) && String(row.action ?? "").startsWith("receipt-"))
  ];
  const scheduledOnTime = targetJournalRows.some((row) => scheduledRowOnTime(row, target));
  const openingMs = Date.parse(openingIso);
  const expectedPrivateSubmitMs = Date.parse(target.expectedPrivateSubmitIso ?? target.expectedBroadcastIso);
  const latestAllowedBroadcastStartMs = Date.parse(target.latestAllowedBroadcastStartIso);
  return {
    scheduled: targetJournalRows.some((row) => row.level === "open-broadcast-scheduled"),
    scheduledOnTime,
    preSigned: targetJournalRows.some((row) => row.level === "pre-signed-fast-tx"),
    broadcasted: targetBuyFills.some((row) => ["broadcast", "success"].includes(row?.result?.status)),
    broadcastStartedWithinTargetWindow: targetBuyFills.some((row) => {
      const startedAt = Date.parse(row?.result?.broadcastStartedAt ?? "");
      return Number.isFinite(startedAt) &&
        startedAt >= expectedPrivateSubmitMs - 5 &&
        startedAt <= latestAllowedBroadcastStartMs;
    }),
    firstAcceptedRpc: targetBuyFills.some((row) => Number.isFinite(Date.parse(row?.result?.firstAcceptedAt ?? ""))),
    outcomeOk: targetBuyFills.some((row) => targetOutcomesPresent(JSON.stringify(row?.plan?.outcomes ?? row?.plan ?? row), target)),
    builderSubmitted: !target.builderBundle || targetBuyFills.some((row) => row?.result?.builderBundleSubmitted === true),
    builderPrepositioned: !target.builderBundle || targetBuyFills.some((row) =>
      strictAtomicBuilderResultMatches(row?.result, target, openingMs)
    ),
    receiptSuccess: targetReceiptRows.some((row) => row.status === "success" || row.action === "receipt-success"),
    txHashes,
    expectedBroadcastDelayMs: target.expectedBroadcastDelayMs,
    expectedPrivateSubmitDelayMs: target.expectedPrivateSubmitDelayMs,
    latestAllowedBroadcastStartDelayMs: target.latestAllowedBroadcastStartDelayMs,
    gasPriceGwei: target.gasPriceGwei ?? null,
    builderBundle: target.builderBundle ?? null,
    autoSell: target.autoSell ?? null
  };
}

function strictAtomicBuilderResultMatches(result, target, openingMs) {
  if (!result || !target?.builderBundle) return false;
  const expectedTimestamp = expectedBuilderTimestamp(openingMs, target);
  const expectedAddress = target.builderBundle.timedBuyExecutorAddress;
  const targetResults = Array.isArray(result.builderBundleTargetResults)
    ? result.builderBundleTargetResults
    : [];
  const targetIds = new Set(targetResults.map((row) => String(row?.targetId ?? "").toLowerCase()));
  const bothBuildersAttempted = targetIds.has("48club") && targetIds.has("blockrazor");
  const targetConfigMatches = targetResults.every((row) =>
    row?.timedBuyExecutorEnabled === true &&
    row?.timedBuyExecutorExactSecond === true &&
    sameAddress(row?.timedBuyExecutorAddress, expectedAddress) &&
    Number(row?.timedBuyExecutorTargetTimestamp) === expectedTimestamp &&
    Number(row?.minTimestamp) === expectedTimestamp &&
    Number(row?.maxTimestamp) === expectedTimestamp + 1 &&
    String(row?.timingMode ?? "") === target.builderBundle.timingMode &&
    Number(row?.targetSecond) === Number(target.builderBundle.targetSecond) &&
    (row?.submitted !== true || (row?.noMerge === true && row?.positionFirst === true))
  );
  return result.broadcastMode === "presigned_builder_bundle_only" &&
    result.publicBroadcastSkipped === true &&
    result.builderTimedBuyExecutorEnabled === true &&
    result.builderTimedBuyExecutorExactSecond === true &&
    sameAddress(result.builderTimedBuyExecutorAddress, expectedAddress) &&
    Number(result.builderTimedBuyExecutorTargetTimestamp) === expectedTimestamp &&
    Number(result.builderBundleMinTimestamp) === expectedTimestamp &&
    Number(result.builderBundleMaxTimestamp) === expectedTimestamp + 1 &&
    String(result.builderBundleTimingMode ?? "") === target.builderBundle.timingMode &&
    Number(result.builderBundleTargetSecond) === Number(target.builderBundle.targetSecond) &&
    result.builderBundleNoMerge === true &&
    result.builderBundlePositionFirst === true &&
    bothBuildersAttempted &&
    targetConfigMatches;
}

function expectedBuilderTimestamp(openingMs, target) {
  if (!target?.builderBundle) return null;
  return Math.ceil((openingMs + Number(target.builderBundle.targetSecond) * 1000) / 1000);
}

function sameAddress(actual, expected) {
  return /^0x[a-fA-F0-9]{40}$/u.test(String(actual ?? "")) &&
    String(actual).toLowerCase() === String(expected).toLowerCase();
}

function scheduledRowOnTime(row, target) {
  return row?.level === "open-broadcast-scheduled" &&
    normalizeIso(row.targetAt ?? "") === target.expectedBroadcastIso &&
    Number(row.postOpenDelayMs) === Number(target.expectedBroadcastDelayMs);
}

function targetOutcomesPresent(value, target) {
  const normalized = normalizeOutcomeText(value);
  return target.outcomes.every((outcome) => normalized.includes(normalizeOutcomeText(outcome)));
}

function normalizeOutcomeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function trimForError(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, 500);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.floor(ms)));
}

main();
