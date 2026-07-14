#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PROFILE_ENV = "/etc/42space/profiles/42space-4.env";
const DEFAULT_APP_DIR = "/opt/42space";
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4245/api/overview";
const DEFAULT_PUBLIC_DASHBOARD_URL = "http://127.0.0.1:4245/api/overview";
const DEFAULT_EVIDENCE_FILE = "/opt/42space/output/bot4-first-buy/latest.json";
const DEFAULT_OPEN_BROADCAST_DELAY_MS = 19900;
const DEFAULT_OPEN_WINDOW_SECONDS = 35;
const DEFAULT_BUY_GAS_GWEI = "0.5";
const DEFAULT_SELL_GAS_GWEI = "0.15";
const DEFAULT_AUTO_SELL_STRATEGY = "open_timed_exit";
const DEFAULT_AUTO_SELL_OPEN_EXIT_DELAY_SECONDS = 39600;
const DEFAULT_AUTO_SELL_OPEN_EXIT_PERCENT = 100;
const DEFAULT_AUTO_SELL_POLL_MS = 60000;
const DEFAULT_TIMED_BUY_EXECUTOR_ADDRESS = "0xC2B2F78C620228Ea8d1B2E155664ceBbc7212148";
const TARGETS = [
  {
    id: "openrouter-python",
    questionPattern: "highest Python usage on OpenRouter",
    sampleQuestion: "Which AI model will have the highest Python usage on OpenRouter on June 27th?",
    titleRe: /highest\s+Python\s+usage\s+on\s+OpenRouter|AI\s*模型.*OpenRouter.*Python.*使用量.*最高/iu,
    outcomes: ["Hy3 (free)", "MiMo - V2.5"],
    stakeUsdt: 30,
    stakePerOutcomeUsdt: 10,
    stakeByOutcomeUsdt: { "Hy3 (free)": 20 },
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
    stakeUsdt: 20,
    stakePerOutcomeUsdt: 10,
    expectedBroadcastDelayMs: 22000,
    latestAllowedBroadcastStartDelayMs: 23000,
    gasPriceGwei: "0.15",
    broadcastRpcCount: 1
  }
];
const TARGET_TOTAL_STAKE_USDT = TARGETS.reduce((sum, target) => sum + target.stakeUsdt, 0);
const TARGET_MAX_MARKET_STAKE_USDT = Math.max(...TARGETS.map((target) => target.stakeUsdt));
const TARGET_MAX_OUTCOME_STAKE_USDT = Math.max(...TARGETS.flatMap((target) => (
  target.outcomes.map((outcome) => Number(target.stakeByOutcomeUsdt?.[outcome] ?? expectedStakePerOutcomeUsdt(target)))
)));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileEnvFile = args.profileEnv ?? DEFAULT_PROFILE_ENV;
  const appDir = path.resolve(args.appDir ?? DEFAULT_APP_DIR);
  const dashboardUrl = args.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
  const publicDashboardUrl = args.publicDashboardUrl ?? DEFAULT_PUBLIC_DASHBOARD_URL;
  const evidenceFile = args.evidenceFile ?? DEFAULT_EVIDENCE_FILE;
  const nowMs = Date.now();
  const openingIso = normalizeIso(args.opening ?? defaultDailyOpeningIso(nowMs));
  const openingMs = Date.parse(openingIso);
  const phase = currentPhase(nowMs, openingMs);

  const profileEnv = parseEnvFile(profileEnvFile);
  const status = runEventStatus(appDir, profileEnv);
  const [dashboard, publicDashboard] = await Promise.all([
    fetchJsonSafe(dashboardUrl, Number(args.timeoutMs ?? 8000)),
    fetchJsonSafe(publicDashboardUrl, Number(args.timeoutMs ?? 8000))
  ]);
  const evidence = readJsonSafe(evidenceFile);
	  const services = args.skipSystemd ? null : readServices([
	    "42space-event@42space-4.service",
	    "42space-dashboard@42space-4.service",
	    "42space-bot4-first-buy-evidence.timer"
	  ]);
  const autoSellStartEvents = args.skipSystemd
    ? []
    : readJournalEvents(
      args.unit ?? "42space-event@42space-4.service",
      Number(args.autoSellLookbackMs ?? 24 * 60 * 60 * 1000)
    ).filter((row) => row?.level === "event-arm-auto-sell-before-funding" && row.started === true);

  const checks = [
    ...profileChecks(profileEnv),
    ...statusChecks(status, openingIso),
    ...dashboardChecks(dashboard, "dashboard"),
    ...dashboardChecks(publicDashboard, "publicDashboard"),
    ...evidenceChecks(evidence, phase, openingIso, Boolean(args.requireLiveProof)),
    ...autoSellRuntimeChecks(status, autoSellStartEvents, { skipSystemd: Boolean(args.skipSystemd) }),
    ...serviceChecks(services)
  ];
  const failed = checks.filter((check) => !check.ok);
  const report = {
    level: "bot4-readiness",
    generatedAt: new Date().toISOString(),
    phase,
    target: {
      openingIso,
      targets: TARGETS.map((target) => targetReadinessSummary(target, openingMs))
    },
    summary: {
      botRunning: status?.mode === "execute",
      walletReady: Boolean(status?.wallet?.balanceReady && status?.wallet?.bnbReady && status?.wallet?.allowanceReady),
      nextBatchStartDate: status?.funding?.nextBatchStartDate ?? null,
      dashboardOk: dashboard?.ok === true,
      publicDashboardOk: publicDashboard?.ok === true,
      evidenceConclusion: evidence?.conclusion ?? null,
      autoSellMonitorStarted: autoSellStartEvents.length > 0,
      serviceCount: services ? Object.keys(services).length : null
    },
    checks,
    ok: failed.length === 0,
    failed
  };

  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) process.exit(1);
}

function profileChecks(env) {
  return [
    check("profile.botName", env.BOT_NAME === "42space-4", env.BOT_NAME ?? null),
    check("profile.dashboardPort", env.DASHBOARD_PORT === "4245", env.DASHBOARD_PORT ?? null),
    check("profile.discoveryFeed", env.EVENT_DISCOVERY === "feed", env.EVENT_DISCOVERY ?? null),
    check("profile.displayDailyTemplates", env.EVENT_DISPLAY_INCLUDE_RULES === "daily_fixed_template", env.EVENT_DISPLAY_INCLUDE_RULES ?? null),
    check("profile.buyQuestionAllowlist", buyAllowlistCoversTargets(env.MARKET_BUY_QUESTION_ALLOWLIST_REGEX), "set"),
    check("profile.namedOutcomeSelection", env.EVENT_OUTCOME_SELECTION === "names", env.EVENT_OUTCOME_SELECTION ?? null),
    check("profile.plannedBuyTargets", plannedBuyFileCoversTargets(env.EVENT_PLANNED_BUYS_FILE), env.EVENT_PLANNED_BUYS_FILE ?? null),
    check("profile.stakePerOutcome", Number(env.STAKE_PER_OUTCOME_USDT) === 5, env.STAKE_PER_OUTCOME_USDT ?? null),
    check("profile.maxStake", Number(env.MAX_STAKE_USDT) === TARGET_MAX_OUTCOME_STAKE_USDT, env.MAX_STAKE_USDT ?? null),
    check("profile.maxMarketStake", Number(env.MAX_MARKET_STAKE_USDT) === TARGET_MAX_MARKET_STAKE_USDT, env.MAX_MARKET_STAKE_USDT ?? null),
    check("profile.maxBatchStake", Number(env.MAX_BATCH_STAKE_USDT) === TARGET_TOTAL_STAKE_USDT, env.MAX_BATCH_STAKE_USDT ?? null),
    check("profile.broadcastDelay", Number(env.OPEN_BROADCAST_DELAY_MS) === DEFAULT_OPEN_BROADCAST_DELAY_MS, env.OPEN_BROADCAST_DELAY_MS ?? null),
    check("profile.openWindow", Number(env.EVENT_OPEN_WINDOW_SECONDS) === DEFAULT_OPEN_WINDOW_SECONDS, env.EVENT_OPEN_WINDOW_SECONDS ?? null),
    check("profile.bundleDisabled", !truthy(env.BUNDLE_DUE_MARKETS), env.BUNDLE_DUE_MARKETS ?? null),
    check("profile.globalBuilderDisabled", !truthy(env.BUILDER_BUNDLE_ENABLED), env.BUILDER_BUNDLE_ENABLED ?? null),
    check("profile.blockrazorEnabled", truthy(env.BLOCKRAZOR_BUILDER_ENABLED), env.BLOCKRAZOR_BUILDER_ENABLED ?? null),
    check("profile.blockrazorAuth", Boolean(env.BLOCKRAZOR_BUILDER_AUTH_TOKEN), Boolean(env.BLOCKRAZOR_BUILDER_AUTH_TOKEN)),
    check("profile.timedExecutorEnabled", truthy(env.BUILDER_TIMED_BUY_EXECUTOR_ENABLED), env.BUILDER_TIMED_BUY_EXECUTOR_ENABLED ?? null),
    check("profile.timedExecutorExactSecond", truthy(env.BUILDER_TIMED_BUY_EXECUTOR_EXACT_SECOND), env.BUILDER_TIMED_BUY_EXECUTOR_EXACT_SECOND ?? null),
    check(
      "profile.timedExecutorAddress",
      sameAddress(env.BUILDER_TIMED_BUY_EXECUTOR_ADDRESS, DEFAULT_TIMED_BUY_EXECUTOR_ADDRESS),
      env.BUILDER_TIMED_BUY_EXECUTOR_ADDRESS ?? null
    ),
    check("profile.priceGateDisabled", !truthy(env.EVENT_PRICE_GATE_ENABLED), env.EVENT_PRICE_GATE_ENABLED ?? null),
    check("profile.buyGas", sameGasPrice(env.GAS_PRICE_GWEI, DEFAULT_BUY_GAS_GWEI), env.GAS_PRICE_GWEI ?? null),
    check("profile.sellGas", sameGasPrice(env.AUTO_SELL_GAS_PRICE_GWEI, DEFAULT_SELL_GAS_GWEI), env.AUTO_SELL_GAS_PRICE_GWEI ?? null),
    check("profile.autoSellStrategy", env.AUTO_SELL_STRATEGY === DEFAULT_AUTO_SELL_STRATEGY, env.AUTO_SELL_STRATEGY ?? null),
    check("profile.openTimedExitDelay", Number(env.AUTO_SELL_OPEN_EXIT_DELAY_SECONDS) === DEFAULT_AUTO_SELL_OPEN_EXIT_DELAY_SECONDS, env.AUTO_SELL_OPEN_EXIT_DELAY_SECONDS ?? null),
    check("profile.openTimedExitPercent", Number(env.AUTO_SELL_OPEN_EXIT_PERCENT) === DEFAULT_AUTO_SELL_OPEN_EXIT_PERCENT, env.AUTO_SELL_OPEN_EXIT_PERCENT ?? null),
    check("profile.autoSellPollMs", Number(env.AUTO_SELL_POLL_MS) === DEFAULT_AUTO_SELL_POLL_MS, env.AUTO_SELL_POLL_MS ?? null),
    check("profile.autoSellApplyAfter", Number.isFinite(Date.parse(env.AUTO_SELL_APPLY_AFTER_ISO ?? "")), env.AUTO_SELL_APPLY_AFTER_ISO ?? null),
    check("profile.noTakeProfitSteps", Number(env.AUTO_SELL_TAKE_PROFIT_STEPS ?? 0) === 0, env.AUTO_SELL_TAKE_PROFIT_STEPS ?? null),
    check("profile.noPreStartExit", Number(env.AUTO_SELL_BEFORE_MARKET_START_SECONDS ?? 0) === 0, env.AUTO_SELL_BEFORE_MARKET_START_SECONDS ?? null),
    check("profile.stopLossDisabled", !truthy(env.AUTO_SELL_STOP_LOSS_ENABLED), env.AUTO_SELL_STOP_LOSS_ENABLED ?? null),
    check("profile.waitForFunding", truthy(env.ARM_WAIT_FOR_FUNDING), env.ARM_WAIT_FOR_FUNDING ?? null)
  ];
}

function statusChecks(status, openingIso) {
  const future = Array.isArray(status?.future) ? status.future : [];
  const targetFuture = future.filter((item) => isTargetQuestion(item?.question));
  const nonTargetFuture = future.filter((item) => item?.prepared && !isTargetQuestion(item?.question));
  const targetBatch = Array.isArray(status?.funding?.nextBatchMarkets)
    ? status.funding.nextBatchMarkets.filter((item) => isTargetQuestion(item?.question))
    : [];
  return [
    check("status.modeExecute", status?.mode === "execute", status?.mode ?? null),
    check("status.walletAddressPresent", Boolean(status?.wallet?.address), Boolean(status?.wallet?.address)),
    check("status.walletBalanceReady", status?.wallet?.balanceReady === true, status?.wallet?.busdtBalance ?? null),
    check("status.walletBnbReady", status?.wallet?.bnbReady === true, status?.wallet?.bnbBalance ?? null),
    check("status.walletAllowanceReady", status?.wallet?.allowanceReady === true, status?.wallet?.allowanceReady ?? null),
    check("status.nextBatchTarget", targetBatchCoversTargets(targetBatch, openingIso), targetBatch.map((item) => item.question)),
    check("status.nextBatchStake", Number(status?.funding?.nextBatchRequiredBusdt) === TARGET_TOTAL_STAKE_USDT, status?.funding?.nextBatchRequiredBusdt ?? null),
    check("status.futureTargetPrepared", futureCoversPreparedTargets(targetFuture), targetFuture.map((item) => ({ question: item.question, prepared: item.prepared }))),
    check("status.noPreparedNonTargetFuture", nonTargetFuture.length === 0, nonTargetFuture.map((item) => item.question)),
    check("status.watchBroadcastDelay", Number(status?.watchConfig?.openBroadcastDelayMs) === DEFAULT_OPEN_BROADCAST_DELAY_MS, status?.watchConfig?.openBroadcastDelayMs ?? null),
    check("status.watchOpenWindow", Number(status?.watchConfig?.eventOpenWindowSeconds) === DEFAULT_OPEN_WINDOW_SECONDS, status?.watchConfig?.eventOpenWindowSeconds ?? null),
    check("status.watchBundleDisabled", status?.watchConfig?.bundleDueMarkets === false, status?.watchConfig?.bundleDueMarkets ?? null),
    check("status.watchGlobalBuilderDisabled", status?.watchConfig?.builderBundle?.enabled === false, status?.watchConfig?.builderBundle?.enabled ?? null),
    check("status.watchTimedExecutorEnabled", status?.watchConfig?.builderBundle?.timedBuyExecutor?.enabled === true, status?.watchConfig?.builderBundle?.timedBuyExecutor ?? null),
    check("status.watchTimedExecutorExactSecond", status?.watchConfig?.builderBundle?.timedBuyExecutor?.exactSecond === true, status?.watchConfig?.builderBundle?.timedBuyExecutor ?? null),
    check(
      "status.watchTimedExecutorAddress",
      sameAddress(status?.watchConfig?.builderBundle?.timedBuyExecutor?.address, DEFAULT_TIMED_BUY_EXECUTOR_ADDRESS),
      status?.watchConfig?.builderBundle?.timedBuyExecutor?.address ?? null
    ),
    check("status.watchBuyGas", sameGasPrice(status?.watchConfig?.gasPriceGwei, DEFAULT_BUY_GAS_GWEI), status?.watchConfig?.gasPriceGwei ?? null),
    check("status.watchOutcomeSelection", status?.watchConfig?.eventOutcomeSelection === "names", status?.watchConfig?.eventOutcomeSelection ?? null),
    check("status.watchStakePerOutcome", Number(status?.watchConfig?.stakePerOutcomeUsdt) === 5, status?.watchConfig?.stakePerOutcomeUsdt ?? null),
    check("status.watchMaxMarketStake", Number(status?.watchConfig?.maxMarketStakeUsdt) === TARGET_MAX_MARKET_STAKE_USDT, status?.watchConfig?.maxMarketStakeUsdt ?? null),
    check("status.watchMaxBatchStake", Number(status?.watchConfig?.maxBatchStakeUsdt) === TARGET_TOTAL_STAKE_USDT, status?.watchConfig?.maxBatchStakeUsdt ?? null),
    check("status.watchAutoSellStrategy", status?.watchConfig?.autoSellStrategy === DEFAULT_AUTO_SELL_STRATEGY, status?.watchConfig?.autoSellStrategy ?? null),
    check("status.watchOpenTimedExitDelay", Number(status?.watchConfig?.autoSellOpenExitDelaySeconds) === DEFAULT_AUTO_SELL_OPEN_EXIT_DELAY_SECONDS, status?.watchConfig?.autoSellOpenExitDelaySeconds ?? null),
    check("status.watchOpenTimedExitPercent", Number(status?.watchConfig?.autoSellOpenExitPercent) === DEFAULT_AUTO_SELL_OPEN_EXIT_PERCENT, status?.watchConfig?.autoSellOpenExitPercent ?? null),
    check("status.watchAutoSellPollMs", Number(status?.watchConfig?.autoSellPollMs) === DEFAULT_AUTO_SELL_POLL_MS, status?.watchConfig?.autoSellPollMs ?? null),
    check("status.watchStopLossDisabled", status?.watchConfig?.autoSellStopLossEnabled === false, {
      enabled: status?.watchConfig?.autoSellStopLossEnabled,
      percent: status?.watchConfig?.autoSellStopLossPercent
    })
  ];
}

function dashboardChecks(payload, prefix) {
  if (!payload || payload.ok !== true) {
    return [check(`${prefix}.ok`, false, payload?.message ?? null)];
  }
  const items = Array.isArray(payload?.newMarkets?.items) ? payload.newMarkets.items : [];
  const nextItems = Array.isArray(payload?.next?.items) ? payload.next.items : [];
  const nonTargetEligible = items.filter((item) => item?.eligible && !isTargetQuestion(item.title));
  return [
    check(`${prefix}.ok`, true, true),
    check(`${prefix}.walletReady`, payload?.wallet?.ready === true || payload?.wallet?.state === "all", payload?.wallet?.label ?? null),
    check(`${prefix}.nextOnlyTargets`, nextItemsCoverTargets(nextItems), nextItems.map((item) => item.title)),
    check(`${prefix}.nextStake`, nextItems.every((item) => Number(item.stake) === expectedStakeForQuestion(item.title)), nextItems.map((item) => ({ title: item.title, stake: item.stake }))),
    check(`${prefix}.nonTargetEligibleEmpty`, nonTargetEligible.length === 0, nonTargetEligible.map((item) => item.title)),
    check(`${prefix}.displayDailyTemplates`, /日常固定模板/u.test(payload?.settings?.ruleSummary?.filterRule ?? ""), payload?.settings?.ruleSummary?.filterRule ?? null),
    check(`${prefix}.windowText`, /T\+19\.9(?:00)?s.*35s/u.test(payload?.settings?.windowText ?? ""), payload?.settings?.windowText ?? null),
    check(
      `${prefix}.autoSellText`,
      /(?:(?:开盘\s*T\+39600s|开盘后\s*11h)\s*卖\s*100%|价格阈值卖出\s*\+\s*19:00清仓).*(?:止损关闭|关闭)/u.test(payload?.settings?.autoSellText ?? ""),
      payload?.settings?.autoSellText ?? null
    )
  ];
}

function evidenceChecks(evidence, phase, openingIso, requireLiveProof) {
  if (phase === "pre_open" && !requireLiveProof) {
    return [check("evidence.preOpenNotRequired", true, evidence?.target?.openingIso ?? null)];
  }
  if (!evidence) return [check("evidence.present", false, null)];
  const expectedPending = phase === "pre_open" && !requireLiveProof;
  const acceptableConclusion = expectedPending ? evidence.conclusion === "pending" : evidence.conclusion === "complete";
  const openingMs = Date.parse(openingIso);
  const evidenceTargets = Array.isArray(evidence?.target?.targets) ? evidence.target.targets : [];
  const targetDelaysOk = TARGETS.every((target) => {
    const row = evidenceTargets.find((item) => item?.id === target.id);
    return row &&
      Number(row.expectedBroadcastDelayMs) === target.expectedBroadcastDelayMs &&
      normalizeIso(row.expectedBroadcastIso) === new Date(openingMs + target.expectedBroadcastDelayMs).toISOString() &&
      Number(row.latestAllowedBroadcastStartDelayMs) === target.latestAllowedBroadcastStartDelayMs;
  });
  return [
    check("evidence.present", true, true),
    check("evidence.conclusion", acceptableConclusion, evidence.conclusion ?? null),
    check("evidence.opening", normalizeIso(evidence?.target?.openingIso) === openingIso, evidence?.target?.openingIso ?? null),
    check("evidence.targetDelays", targetDelaysOk, evidenceTargets.map((target) => ({
      id: target?.id,
      expectedBroadcastDelayMs: target?.expectedBroadcastDelayMs,
      latestAllowedBroadcastStartDelayMs: target?.latestAllowedBroadcastStartDelayMs
    }))),
    check("evidence.botRunning", evidence?.checks?.botRunning === true, evidence?.checks?.botRunning ?? null),
    check("evidence.nextBatchKnown", evidence?.checks?.nextBatchKnown === true, evidence?.checks?.nextBatchKnown ?? null),
    check("evidence.noUnintendedBuys", evidence?.checks?.noUnintendedBuys === true, evidence?.checks?.noUnintendedBuys ?? null)
  ];
}

function autoSellRuntimeChecks(status, autoSellStartEvents, options = {}) {
  return [
    check("autoSell.monitorStarted", options.skipSystemd || autoSellStartEvents.length > 0, options.skipSystemd ? "skipped" : autoSellStartEvents.slice(-3)),
    check("autoSell.stopLossRuntime", status?.watchConfig?.autoSellEnabled === true &&
      status?.watchConfig?.autoSellStopLossEnabled === false, {
      enabled: status?.watchConfig?.autoSellEnabled,
      stopLossEnabled: status?.watchConfig?.autoSellStopLossEnabled,
      stopLossPercent: status?.watchConfig?.autoSellStopLossPercent,
      stopLossSellPercent: status?.watchConfig?.autoSellStopLossSellPercent
    })
  ];
}

function serviceChecks(services) {
  if (!services) return [];
  return Object.entries(services).map(([name, state]) => check(`service.${name}`, state === "active", state));
}

function runEventStatus(appDir, profileEnv) {
  const result = spawnSync("node", ["src/event-sniper.js", "status", "--json"], {
    cwd: appDir,
    env: { ...process.env, ...profileEnv },
    encoding: "utf8",
    timeout: 120000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`event status failed: ${trimForError(result.stderr || result.stdout)}`);
  }
  return JSON.parse(result.stdout);
}

function readServices(names) {
  const services = {};
  for (const name of names) {
    const result = spawnSync("systemctl", ["is-active", name], { encoding: "utf8", timeout: 10000 });
    services[name] = result.stdout.trim() || result.stderr.trim() || `exit-${result.status}`;
  }
  return services;
}

function readJournalEvents(unit, lookbackMs) {
  const since = formatShanghaiJournalTime(Date.now() - Math.max(1000, lookbackMs));
  const result = spawnSync("journalctl", ["-u", unit, "-o", "cat", "--since", since], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000
  });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function fetchJsonSafe(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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

function currentPhase(nowMs, openingMs) {
  if (!Number.isFinite(openingMs)) return "unknown";
  if (nowMs < openingMs) return "pre_open";
  if (nowMs < openingMs + 35 * 60 * 1000) return "evidence_window";
  return "post_evidence_window";
}

function check(id, ok, observed) {
  return { id, ok: Boolean(ok), observed };
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function isTargetQuestion(question) {
  const text = String(question ?? "");
  return TARGETS.some((target) => target.titleRe.test(text));
}

function targetForQuestion(question) {
  const text = String(question ?? "");
  return TARGETS.find((target) => target.titleRe.test(text)) ?? null;
}

function targetOutcomesPresent(value, target) {
  const normalized = normalizeOutcomeText(value);
  return target.outcomes.every((outcome) => normalized.includes(normalizeOutcomeText(outcome)));
}

function buyAllowlistCoversTargets(pattern) {
  try {
    const re = new RegExp(String(pattern ?? ""), "iu");
    return TARGETS.every((target) => re.test(target.sampleQuestion));
  } catch {
    return false;
  }
}

function plannedBuyFileCoversTargets(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.plans) ? json.plans : []);
    return TARGETS.every((target) => rows.some((row) => plannedBuyRowCoversTarget(row, target)));
  } catch {
    return false;
  }
}

function plannedBuyRowCoversTarget(row, target) {
  if (!row || row.enabled === false || row.disabled === true) return false;
  const question = String(row.question ?? row.title ?? "");
  const questionRegex = String(row.questionRegex ?? row.titleRegex ?? "");
  const questionMatches = target.titleRe.test(question) || questionRegexMatches(questionRegex, target.sampleQuestion);
  if (!questionMatches) return false;
  const outcomes = Array.isArray(row.outcomes ?? row.outcomeNames ?? row.names)
    ? (row.outcomes ?? row.outcomeNames ?? row.names).join(",")
    : String(row.outcomes ?? row.outcomeNames ?? row.names ?? "");
  const delayOk = Number(row.openBroadcastDelayMs ?? row.buyDelayMs ?? row.broadcastDelayMs ?? row.openDelayMs) === target.expectedBroadcastDelayMs;
  const gasOk = sameGasPrice(row.gasPriceGwei ?? row.buyGasPriceGwei ?? row.gasGwei ?? row.buyGasGwei, target.gasPriceGwei);
  const builderOk = plannedBuyBuilderBundleCoversTarget(row, target);
  const autoSellOk = plannedBuyAutoSellCoversTarget(row, target);
  const broadcastRpcUrls = Array.isArray(row.broadcastRpcUrls) ? row.broadcastRpcUrls : [];
  const broadcastRpcOk = target.broadcastRpcCount === undefined ||
    broadcastRpcUrls.length === Number(target.broadcastRpcCount);
  return plannedBuyStakeCoversTarget(row, target) &&
    targetOutcomesPresent(outcomes, target) &&
    delayOk &&
    gasOk &&
    broadcastRpcOk &&
    builderOk &&
    autoSellOk;
}

function plannedBuyStakeCoversTarget(row, target) {
  const fallback = Number(row.stakePerOutcomeUsdt ?? row.stake ?? row.stakeUsdt);
  if (fallback !== expectedStakePerOutcomeUsdt(target)) return false;
  const raw = row.stakeByOutcomeUsdt ?? row.outcomeStakesUsdt ?? row.stakesByOutcome ?? {};
  const entries = Array.isArray(raw)
    ? raw.map((item) => [item?.outcome ?? item?.name, item?.stakeUsdt ?? item?.amountUsdt ?? item?.stake])
    : Object.entries(raw);
  const configured = new Map(entries.map(([outcome, stake]) => [normalizeOutcomeText(outcome), Number(stake)]));
  return target.outcomes.every((outcome) => {
    const expected = Number(target.stakeByOutcomeUsdt?.[outcome] ?? expectedStakePerOutcomeUsdt(target));
    const actual = configured.has(normalizeOutcomeText(outcome))
      ? configured.get(normalizeOutcomeText(outcome))
      : fallback;
    return actual === expected;
  });
}

function plannedBuyBuilderBundleCoversTarget(row, target) {
  if (!target.builderBundle) return !row?.builderBundle || row.builderBundle.enabled === false;
  const source = row?.builderBundle ?? row ?? {};
  const enabled = source.enabled ?? source.builderBundleEnabled;
  const mode = source.mode ?? source.builderBundleMode;
  const tipBnb = source.tipBnb ?? source.tip ?? source.tipAmountBnb ?? source.builderBundleTipBnb;
  const timeoutMs = source.timeoutMs ?? source.builderBundleTimeoutMs;
  const timingMode = source.timingMode ?? source.builderBundleTimingMode;
  const prepositionLeadMs = source.prepositionLeadMs ?? source.builderBundlePrepositionLeadMs;
  const noMerge = source.noMerge ?? source.builderBundleNoMerge;
  const positionFirst = source.positionFirst ?? source.builderBundlePositionFirst;
  return truthy(enabled) &&
    String(mode ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_") === target.builderBundle.mode &&
    Number(tipBnb) === Number(target.builderBundle.tipBnb) &&
    Number(timeoutMs) === Number(target.builderBundle.timeoutMs) &&
    String(timingMode ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_") === target.builderBundle.timingMode &&
    Number(prepositionLeadMs) === Number(target.builderBundle.prepositionLeadMs) &&
    Boolean(noMerge) === Boolean(target.builderBundle.noMerge) &&
    Boolean(positionFirst) === Boolean(target.builderBundle.positionFirst);
}

function plannedBuyAutoSellCoversTarget(row, target) {
  if (!target.autoSell) return true;
  const source = row?.autoSell ?? {};
  const configuredTargets = Array.isArray(source.priceTargets) ? source.priceTargets : [];
  const priceTargetsOk = target.autoSell.priceTargets.every((targetPrice) => configuredTargets.some((configured) => (
    String(configured?.outcome ?? "").trim().toLowerCase() === targetPrice.outcome.toLowerCase() &&
    Number(configured?.price) === Number(targetPrice.price) &&
    configured?.enabled !== false
  )));
  return priceTargetsOk &&
    Number(source.priceHotPollMs ?? 1000) === Number(target.autoSell.priceHotPollMs) &&
    Number(source.priceHotWindowSeconds ?? 600) === Number(target.autoSell.priceHotWindowSeconds) &&
    Number(source.priceSellPercent ?? 100) === Number(target.autoSell.priceSellPercent) &&
    Boolean(source.stopLossEnabled ?? source.autoSellStopLossEnabled ?? false) === Boolean(target.autoSell.stopLossEnabled);
}

function expectedStakePerOutcomeUsdt(target) {
  const explicit = Number(target.stakePerOutcomeUsdt);
  if (Number.isFinite(explicit)) return explicit;
  return Number(target.stakeUsdt) / Math.max(1, target.outcomes.length);
}

function questionRegexMatches(pattern, question) {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, "iu").test(question);
  } catch {
    return false;
  }
}

function targetBatchCoversTargets(items, openingIso) {
  return TARGETS.every((target) => items.some((item) =>
    target.titleRe.test(item?.question ?? "") && normalizeIso(item?.startDate) === openingIso
  ));
}

function futureCoversPreparedTargets(items) {
  return TARGETS.every((target) => items.some((item) => target.titleRe.test(item?.question ?? "") && item?.prepared === true));
}

function nextItemsCoverTargets(items) {
  return TARGETS.every((target) => items.some((item) => target.titleRe.test(item?.title ?? ""))) &&
    items.every((item) => isTargetQuestion(item?.title));
}

function expectedStakeForQuestion(question) {
  return targetForQuestion(question)?.stakeUsdt ?? NaN;
}

function targetReadinessSummary(target, openingMs) {
  return {
    id: target.id,
    questionPattern: target.questionPattern,
    outcomes: target.outcomes,
    stakeUsdt: target.stakeUsdt,
    stakePerOutcomeUsdt: expectedStakePerOutcomeUsdt(target),
    stakeByOutcomeUsdt: target.stakeByOutcomeUsdt ?? {},
    expectedBroadcastDelayMs: target.expectedBroadcastDelayMs,
    expectedBroadcastIso: new Date(openingMs + target.expectedBroadcastDelayMs).toISOString(),
    latestAllowedBroadcastStartDelayMs: target.latestAllowedBroadcastStartDelayMs,
    latestAllowedBroadcastStartIso: new Date(openingMs + target.latestAllowedBroadcastStartDelayMs).toISOString(),
    gasPriceGwei: target.gasPriceGwei,
    builderBundle: target.builderBundle ?? null,
    autoSell: target.autoSell ?? null
  };
}

function sameGasPrice(actual, expected) {
  return Number(actual) === Number(expected);
}

function sameAddress(actual, expected) {
  return /^0x[a-fA-F0-9]{40}$/u.test(String(actual ?? "")) &&
    String(actual).toLowerCase() === String(expected).toLowerCase();
}

function normalizeOutcomeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .toLowerCase();
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

function trimForError(text) {
  return String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, 500);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "bot4-readiness-error", message: trimForError(error?.message ?? error) }));
  process.exit(1);
});
