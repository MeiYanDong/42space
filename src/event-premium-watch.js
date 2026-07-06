#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatUnits, parseUnits } from "viem";

import { appendJsonl, loadSeen, parseArgs, readConfig, saveSeen } from "./config.js";
import { buildEventIntelOptions, runEventIntel } from "./event-intel.js";
import { renderPremiumWatchChartFile } from "../scripts/premium-watch-chart.js";
import {
  buildMarketFromCreationLog,
  buildMarketsFromControllerLogs,
  fetchMarket,
  fetchMarkets,
  makeClients,
  makeWsClient,
  simulateMintAmount,
  watchControllerLogs
} from "./fortytwo.js";

const DEFAULT_SAMPLE_MS = 500;
const DEFAULT_WINDOW_MS = 22_000;
const DEFAULT_MAX_LOCAL_OFFSET_MS = 25_000;
const DEFAULT_POST20_TICKS = 3;
const DEFAULT_QUOTE_CONCURRENCY = 12;
const DEFAULT_MAX_TIMER_DELAY_MS = 12 * 60 * 60 * 1000;

async function main() {
  const cfg = readConfig();
  const args = parseArgs(process.argv.slice(2));
  const opts = buildOptions(cfg, args);
  const { publicClient } = makeClients(cfg);
  const state = {
    entries: new Map(),
    tasks: new Set(),
    intelTasks: new Set(),
    intelSeen: loadIntelSeen(opts.intel),
    stopping: false,
    unwatch: null,
    lastRestScanLogAt: 0
  };

  console.log(JSON.stringify({
    level: "premium-watch-start",
    mode: opts.once ? "once" : "watch",
    pollMs: opts.pollMs,
    sampleMs: opts.sampleMs,
    windowMs: opts.windowMs,
    maxLocalOffsetMs: opts.maxLocalOffsetMs,
    stakesUsdt: opts.stakesUsdt,
    outputDir: opts.outputDir,
    discoveryFile: opts.discoveryFile,
    eventDiscoveryFeedFile: opts.eventDiscoveryFeedFile || null,
    eventIntelEnabled: opts.intel.enabled,
    eventIntelOutputDir: opts.intel.outputDir,
    eventIntelFile: opts.intel.intelFile,
    eventIntelSeenFile: opts.intel.seenFile,
    eventIntelSeenMarkets: state.intelSeen.size,
    eventIntelCreatedAtOpenThresholdMs: opts.intel.createdAtOpenThresholdMs,
    eventIntelNotifyNonTemplate: opts.intel.notifyNonTemplate,
    eventIntelNotifySeenFile: opts.intel.notifySeenFile,
    eventIntelNotifyWebhookConfigured: Boolean(opts.intel.notifyWebhook || (isBot1ProfileName(cfg.botName) && cfg.feishuWebhook)),
    premiumProbesEnabled: opts.probesEnabled,
    readOnly: true
  }));

  if (!opts.noWs) {
    try {
      const wsClient = makeWsClient(cfg);
      state.unwatch = watchControllerLogs(wsClient, {
        onLogs: (logs) => {
          const built = buildMarketsFromControllerLogs(logs, { createdAt: new Date().toISOString() });
          const scheduled = new Set();
          for (const error of built.errors) {
            console.log(JSON.stringify({ level: "premium-watch-ws-parse-error", ...error }));
          }
          for (const market of built.markets) {
            scheduled.add(String(market.address).toLowerCase());
            scheduleMarket({ cfg, opts, publicClient, state, market, source: "wss" });
          }
          for (const log of logs) {
            if (log.eventName !== "CreateNewMarket" || !log.args?.market) continue;
            const key = String(log.args.market).toLowerCase();
            if (scheduled.has(key) || state.entries.has(key)) continue;
            void scheduleFromCreationLogFallback({ cfg, opts, publicClient, state, log });
          }
        },
        onError: (error) => {
          console.log(JSON.stringify({ level: "premium-watch-ws-error", message: errorMessage(error) }));
        }
      });
      console.log(JSON.stringify({ level: "premium-watch-ws-ready" }));
    } catch (error) {
      console.log(JSON.stringify({ level: "premium-watch-ws-disabled", message: errorMessage(error) }));
    }
  }

  await scanRest({ cfg, opts, publicClient, state });

  if (opts.once) {
    await waitForOnce(state, opts);
    stopWatch(state);
    console.log(JSON.stringify({
      level: "premium-watch-once-complete",
      scheduled: state.entries.size,
      running: state.tasks.size,
      intelRunning: state.intelTasks.size
    }));
    return;
  }

  installSignalHandlers(state);
  while (!state.stopping) {
    await sleep(opts.pollMs);
    await scanRest({ cfg, opts, publicClient, state });
  }
  await Promise.allSettled([...state.tasks, ...state.intelTasks]);
  stopWatch(state);
}

async function scheduleFromCreationLogFallback({ cfg, opts, publicClient, state, log }) {
  const address = log.args?.market;
  if (!address) return;
  try {
    const market = await buildMarketFromCreationLog(publicClient, log);
    scheduleMarket({ cfg, opts, publicClient, state, market, source: "wss-receipt" });
    return;
  } catch (error) {
    console.log(JSON.stringify({
      level: "premium-watch-wss-receipt-fallback-error",
      market: address,
      transactionHash: log.transactionHash,
      message: errorMessage(error)
    }));
  }

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const market = await fetchMarket(cfg, address);
      scheduleMarket({ cfg, opts, publicClient, state, market, source: "wss-rest-hydrate" });
      return;
    } catch (error) {
      if (attempt === 6) {
        console.log(JSON.stringify({
          level: "premium-watch-wss-rest-hydrate-error",
          market: address,
          transactionHash: log.transactionHash,
          attempts: attempt,
          message: errorMessage(error)
        }));
        return;
      }
      await sleep(500);
    }
  }
}

function buildOptions(cfg, args) {
  const sampleMs = positiveInteger(args.sampleMs ?? process.env.PREMIUM_WATCH_SAMPLE_MS, DEFAULT_SAMPLE_MS);
  const windowMs = positiveInteger(args.windowMs ?? process.env.PREMIUM_WATCH_WINDOW_MS, DEFAULT_WINDOW_MS);
  const maxLocalOffsetMs = positiveInteger(
    args.maxLocalOffsetMs ?? process.env.PREMIUM_WATCH_MAX_LOCAL_OFFSET_MS,
    DEFAULT_MAX_LOCAL_OFFSET_MS
  );
  const outputDir = String(args.outputDir ?? process.env.PREMIUM_WATCH_OUTPUT_DIR ?? "output");
  return {
    pollMs: positiveInteger(args.pollMs ?? process.env.PREMIUM_WATCH_POLL_MS, cfg.restDiscoveryPollMs || 1000),
    sampleMs,
    windowMs,
    maxLocalOffsetMs,
    post20Ticks: positiveInteger(args.post20Ticks ?? process.env.PREMIUM_WATCH_POST20_TICKS, DEFAULT_POST20_TICKS),
    limit: positiveInteger(args.limit ?? process.env.PREMIUM_WATCH_LIMIT, cfg.watchScanLimit || 500),
    quoteConcurrency: positiveInteger(
      args.quoteConcurrency ?? process.env.PREMIUM_WATCH_QUOTE_CONCURRENCY,
      DEFAULT_QUOTE_CONCURRENCY
    ),
    restScanLogMs: positiveInteger(args.restScanLogMs ?? process.env.PREMIUM_WATCH_REST_SCAN_LOG_MS, 60_000),
    maxTimerDelayMs: positiveInteger(
      args.maxTimerDelayMs ?? process.env.PREMIUM_WATCH_MAX_TIMER_DELAY_MS,
      DEFAULT_MAX_TIMER_DELAY_MS
    ),
    maxOutcomes: nonNegativeInteger(args.maxOutcomes ?? process.env.PREMIUM_WATCH_MAX_OUTCOMES, 0),
    maxWaitMs: nonNegativeInteger(args.maxWaitMs ?? process.env.PREMIUM_WATCH_MAX_WAIT_MS, 0),
    probesEnabled: args.noProbes ? false : envBool("PREMIUM_WATCH_PROBES_ENABLED", true),
    outputDir,
    discoveryFile: String(
      args.discoveryFile ??
      process.env.PREMIUM_WATCH_DISCOVERY_FILE ??
      path.join(outputDir, "premium-watch-discovery.jsonl")
    ),
    eventDiscoveryFeedFile: String(
      args.eventDiscoveryFeedFile ??
      process.env.EVENT_DISCOVERY_FEED_FILE ??
      ""
    ),
    intel: buildEventIntelOptions(args, { outputDir }),
    stakesUsdt: parseStakes(args.stakes ?? process.env.PREMIUM_WATCH_STAKES, cfg.stakePerOutcomeUsdt),
    noWs: Boolean(args.noWs || envBool("PREMIUM_WATCH_NO_WS", false)),
    once: Boolean(args.once)
  };
}

function parseStakes(raw, configuredStake) {
  const values = raw
    ? String(raw).split(",")
    : ["1", String(configuredStake)];
  const seen = new Set();
  const stakes = [];
  for (const value of values) {
    const number = Number(String(value).trim());
    if (!Number.isFinite(number) || number <= 0) continue;
    const key = number.toFixed(8);
    if (seen.has(key)) continue;
    seen.add(key);
    stakes.push(number);
  }
  return stakes.length ? stakes : [1];
}

async function scanRest({ cfg, opts, publicClient, state }) {
  const startedAt = Date.now();
  const groups = await Promise.all([
    fetchMarketsSafe(cfg, { status: "all", topic: "", order: "created_at", ascending: false, limit: opts.limit }, "all-created"),
    fetchMarketsSafe(cfg, { status: "live", topic: "", order: "created_at", ascending: false, limit: opts.limit }, "live-created"),
    fetchMarketsSafe(cfg, { status: "not_started", topic: "", order: "start_timestamp", ascending: true, limit: opts.limit }, "not-started")
  ]);
  const markets = mergeMarkets(...groups);
  let scheduled = 0;
  let notScheduled = 0;
  let rescheduled = 0;
  for (const market of markets) {
    const result = scheduleMarket({ cfg, opts, publicClient, state, market, source: "rest" });
    if (result === "scheduled") scheduled += 1;
    if (result === "rescheduled") rescheduled += 1;
    if (result === "not-scheduled") notScheduled += 1;
  }
  const shouldLog = scheduled > 0 || rescheduled > 0 || Date.now() - state.lastRestScanLogAt >= opts.restScanLogMs;
  if (shouldLog) {
    state.lastRestScanLogAt = Date.now();
    console.log(JSON.stringify({
      level: "premium-watch-rest-scan",
      rawMarkets: groups.reduce((sum, group) => sum + group.length, 0),
      uniqueMarkets: markets.length,
      scheduled,
      rescheduled,
      notScheduled,
      known: state.entries.size,
      elapsedMs: Date.now() - startedAt
    }));
  }
}

async function fetchMarketsSafe(cfg, params, label) {
  try {
    return await fetchMarkets(cfg, params);
  } catch (error) {
    console.log(JSON.stringify({ level: "premium-watch-rest-error", label, message: errorMessage(error) }));
    return [];
  }
}

function scheduleMarket({ cfg, opts, publicClient, state, market, source }) {
  const decision = getProbeCandidateDecision(market, opts, Date.now());
  if (!market?.address) return "invalid";
  const key = String(market.address).toLowerCase();
  let entry = state.entries.get(key);
  const isNew = !entry;
  if (!entry) {
    entry = {
      key,
      market,
      sources: new Set(),
      discoveredAt: new Date().toISOString(),
      lastSeenAt: null,
      seenCount: 0,
      startMs: null,
      timer: null,
      timerTargetMs: null,
      probeStarted: false,
      completed: false,
      lastDecisionReason: null,
      notScheduledLogged: false,
      intelStarted: false,
      intelCompleted: false
    };
    state.entries.set(key, entry);
  }

  entry.market = mergeMarket(entry.market, market);
  entry.sources.add(source);
  entry.lastSeenAt = new Date().toISOString();
  entry.seenCount += 1;
  appendEventDiscoveryFeed(opts, entry, source, decision);

  if (isNew) {
    appendDiscovery(opts, {
      level: "premium-watch-seen",
      market: entry.market.address,
      question: entry.market.question ?? entry.market.title ?? null,
      status: entry.market.status ?? null,
      startDate: entry.market.startDate ?? null,
      source,
      decisionReason: decision.reason,
      at: entry.discoveredAt
    });
    startIntelTask({ cfg, opts, state, entry, source, decision });
  }

  if (!opts.probesEnabled) {
    entry.lastDecisionReason = "premium-probes-disabled";
    if (!entry.notScheduledLogged) {
      entry.notScheduledLogged = true;
      appendDiscovery(opts, {
        level: "premium-watch-not-scheduled",
        market: entry.market.address,
        question: entry.market.question ?? entry.market.title ?? null,
        status: entry.market.status ?? null,
        startDate: entry.market.startDate ?? null,
        sources: [...entry.sources].sort(),
        reason: "premium-probes-disabled",
        at: new Date().toISOString()
      });
    }
    return "not-scheduled";
  }

  if (!decision.eligible) {
    entry.lastDecisionReason = decision.reason;
    if (!entry.notScheduledLogged) {
      entry.notScheduledLogged = true;
      appendDiscovery(opts, {
        level: "premium-watch-not-scheduled",
        market: entry.market.address,
        question: entry.market.question ?? entry.market.title ?? null,
        status: entry.market.status ?? null,
        startDate: entry.market.startDate ?? null,
        sources: [...entry.sources].sort(),
        reason: decision.reason,
        at: new Date().toISOString()
      });
    }
    return "not-scheduled";
  }

  entry.notScheduledLogged = false;
  entry.lastDecisionReason = "scheduled";
  if (entry.probeStarted || entry.completed) return "known";
  if (entry.timer && entry.timerTargetMs === decision.startMs) return "known";

  const action = entry.timer ? "rescheduled" : "scheduled";
  armProbeTimer({ cfg, opts, publicClient, state, entry, startMs: decision.startMs, source, action });
  return action;
}

function startIntelTask({ cfg, opts, state, entry, source, decision }) {
  if (!opts.intel.enabled || entry.intelStarted) return;
  if (state.intelSeen.has(entry.key)) return;
  entry.intelStarted = true;
  state.intelSeen.add(entry.key);
  saveIntelSeen(opts, state);
  const discovery = {
    discoveredAt: entry.discoveredAt,
    sources: [...entry.sources].sort(),
    decisionReason: decision.reason,
    probeEligible: decision.eligible
  };
  appendDiscovery(opts, {
    level: "event-intel-start",
    market: entry.market.address,
    question: entry.market.question ?? entry.market.title ?? null,
    status: entry.market.status ?? null,
    startDate: entry.market.startDate ?? null,
    source,
    ...discovery,
    at: new Date().toISOString()
  });

  const task = runIntelTask({ cfg, opts, entry, source, discovery })
    .catch((error) => {
      console.log(JSON.stringify({
        level: "event-intel-error",
        market: entry.market.address,
        message: errorMessage(error)
      }));
      appendDiscovery(opts, {
        level: "event-intel-error",
        market: entry.market.address,
        message: errorMessage(error),
        at: new Date().toISOString()
      });
    })
    .finally(() => {
      entry.intelCompleted = true;
      state.intelTasks.delete(task);
    });
  state.intelTasks.add(task);
}

function loadIntelSeen(intelOpts) {
  const seen = new Set();
  try {
    for (const market of loadSeen(intelOpts.seenFile)) {
      if (market) seen.add(String(market).toLowerCase());
    }
  } catch (error) {
    console.log(JSON.stringify({
      level: "event-intel-seen-load-error",
      file: intelOpts.seenFile,
      message: errorMessage(error)
    }));
  }

  try {
    if (fs.existsSync(intelOpts.intelFile)) {
      const lines = fs.readFileSync(intelOpts.intelFile, "utf8").split(/\r?\n/u);
      for (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.market) seen.add(String(row.market).toLowerCase());
      }
    }
  } catch (error) {
    console.log(JSON.stringify({
      level: "event-intel-jsonl-seed-error",
      file: intelOpts.intelFile,
      message: errorMessage(error)
    }));
  }

  if (seen.size > 0) {
    try {
      saveSeen(intelOpts.seenFile, seen);
    } catch (error) {
      console.log(JSON.stringify({
        level: "event-intel-seen-save-error",
        file: intelOpts.seenFile,
        message: errorMessage(error)
      }));
    }
  }
  return seen;
}

function saveIntelSeen(opts, state) {
  try {
    saveSeen(opts.intel.seenFile, state.intelSeen);
  } catch (error) {
    console.log(JSON.stringify({
      level: "event-intel-seen-save-error",
      file: opts.intel.seenFile,
      message: errorMessage(error)
    }));
  }
}

async function runIntelTask({ cfg, opts, entry, source, discovery }) {
  const hydrated = await hydrateMarketForIntel(cfg, entry.market);
  entry.market = mergeMarket(entry.market, hydrated);
  const report = await runEventIntel({ cfg, market: entry.market, source, discovery, opts: opts.intel });
  console.log(JSON.stringify({
    level: "event-intel-complete",
    market: report.market,
    question: report.question,
    eventKind: report.classification.eventKind,
    binanceRelation: report.binanceRelation.level,
    priority: report.priority,
    mdFile: report.files.mdFile,
    jsonFile: report.files.jsonFile
  }));
  appendDiscovery(opts, {
    level: "event-intel-complete",
    market: report.market,
    question: report.question,
    eventKind: report.classification.eventKind,
    binanceRelation: report.binanceRelation.level,
    priority: report.priority,
    mdFile: report.files.mdFile,
    jsonFile: report.files.jsonFile,
    at: new Date().toISOString()
  });
}

async function hydrateMarketForIntel(cfg, market) {
  if (!market?.address) return market;
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const hydrated = await fetchMarket(cfg, market.address);
      if (hydrated?.question || hydrated?.title || attempt === 5) return hydrated;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  if (lastError) {
    console.log(JSON.stringify({
      level: "event-intel-hydrate-error",
      market: market.address,
      message: errorMessage(lastError)
    }));
  }
  return market;
}

function armProbeTimer({ cfg, opts, publicClient, state, entry, startMs, source, action }) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.startMs = startMs;
  entry.timerTargetMs = startMs;
  const finalDelayMs = Math.max(0, startMs - Date.now());
  const chunkDelayMs = Math.min(finalDelayMs, opts.maxTimerDelayMs);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (state.stopping || entry.probeStarted || entry.completed) return;
    if (Date.now() < entry.startMs) {
      armProbeTimer({ cfg, opts, publicClient, state, entry, startMs: entry.startMs, source, action: "timer-refresh" });
      return;
    }
    startProbeTask({ cfg, opts, publicClient, state, entry });
  }, chunkDelayMs);

  appendDiscovery(opts, {
    level: `premium-watch-${action}`,
    market: entry.market.address,
    question: entry.market.question ?? entry.market.title ?? null,
    status: entry.market.status ?? null,
    startDate: entry.market.startDate ?? null,
    sources: [...entry.sources].sort(),
    source,
    finalDelayMs,
    chunkDelayMs,
    at: new Date().toISOString()
  });
  console.log(JSON.stringify({
    level: `premium-watch-${action}`,
    market: entry.market.address,
    question: entry.market.question ?? entry.market.title ?? null,
    startDate: entry.market.startDate,
    source,
    delayMs: finalDelayMs,
    chunkDelayMs
  }));
}

function startProbeTask({ cfg, opts, publicClient, state, entry }) {
  entry.probeStarted = true;
  appendDiscovery(opts, {
    level: "premium-watch-probe-start",
    market: entry.market.address,
    question: entry.market.question ?? entry.market.title ?? null,
    status: entry.market.status ?? null,
    startDate: entry.market.startDate ?? null,
    sources: [...entry.sources].sort(),
    at: new Date().toISOString()
  });
  const task = runProbe({ cfg, opts, publicClient, entry })
    .catch((error) => {
      console.log(JSON.stringify({
        level: "premium-watch-probe-error",
        market: entry.market.address,
        message: errorMessage(error)
      }));
      appendDiscovery(opts, {
        level: "premium-watch-probe-error",
        market: entry.market.address,
        message: errorMessage(error),
        at: new Date().toISOString()
      });
    })
    .finally(() => {
      entry.completed = true;
      state.tasks.delete(task);
    });
  state.tasks.add(task);
}

function getProbeCandidateDecision(market, opts, nowMs) {
  if (!market?.address) return { eligible: false, reason: "missing-address" };
  if (!["live", "not_started"].includes(String(market.status ?? ""))) {
    return { eligible: false, reason: "status" };
  }
  const startMs = new Date(market.startDate).getTime();
  if (!Number.isFinite(startMs)) return { eligible: false, reason: "missing-start" };
  if (startMs + opts.maxLocalOffsetMs < nowMs) return { eligible: false, reason: "expired" };
  return { eligible: true, startMs };
}

async function runProbe({ cfg, opts, publicClient, entry }) {
  let market = entry.market;
  const initialOutcomes = selectProbeOutcomes(market, opts);
  if (initialOutcomes.length > 0) {
    void hydrateMarketInBackground(cfg, entry);
  }
  if (initialOutcomes.length === 0) {
    const hydrated = await hydrateMarket(cfg, entry.market);
    entry.market = mergeMarket(entry.market, hydrated);
    market = entry.market;
  }
  const outcomes = selectProbeOutcomes(market, opts);
  const startedAt = new Date().toISOString();
  const outputBase = premiumWatchOutputBase(opts.outputDir, market, startedAt);
  const jsonlFile = `${outputBase}.jsonl`;
  const enrichedJsonlFile = `${outputBase}.enriched.jsonl`;
  const csvFile = `${outputBase}.csv`;
  const mdFile = `${outputBase}.md`;
  const chartFile = `${outputBase}.chart.html`;
  const header = {
    rowType: "header",
    mode: "event:premium-watch",
    readOnly: true,
    market: market.address,
    question: market.question ?? market.title ?? "",
    status: market.status ?? null,
    createdAt: market.createdAt ?? null,
    discoveredAt: entry.discoveredAt,
    discoverySources: [...entry.sources].sort(),
    startDate: market.startDate,
    endDate: market.endDate ?? null,
    contractVersion: market.contractVersion ?? null,
    curve: market.curve ?? null,
    outcomeCount: outcomes.length,
    outcomes: outcomes.map((outcome) => ({
      tokenId: String(outcome.tokenId),
      name: outcomeName(outcome),
      price: outcome.price ?? null,
      payout: outcome.payout ?? null
    })),
    stakesUsdt: opts.stakesUsdt,
    sampleMs: opts.sampleMs,
    windowMs: opts.windowMs,
    maxLocalOffsetMs: opts.maxLocalOffsetMs,
    post20Ticks: opts.post20Ticks,
    startedAt,
    note: "Read-only simulateMint samples. Estimated premium is inferred from quote markup after subtracting the same market/outcome/stake post-20s baseline."
  };

  fs.mkdirSync(path.dirname(jsonlFile), { recursive: true });
  appendJsonl(jsonlFile, header);
  console.log(JSON.stringify({
    level: "premium-watch-probe-start",
    market: market.address,
    question: header.question,
    startDate: market.startDate,
    outcomes: outcomes.length,
    stakesUsdt: opts.stakesUsdt,
    jsonlFile
  }));

  const samples = [];
  if (outcomes.length === 0) {
    const common = await buildSampleCommon(publicClient, market, entry, Date.now());
    const row = {
      ok: false,
      ...common,
      tokenId: null,
      outcomeName: null,
      outcomeRestPrice: null,
      outcomeRestPayout: null,
      stakeUsdt: null,
      amountInRaw: null,
      quoteLatencyMs: null,
      error: "no-outcomes-after-hydration"
    };
    appendJsonl(jsonlFile, row);
    samples.push(row);
    const analysis = analyzeSamples(samples);
    writeJsonl(enrichedJsonlFile, analysis.enriched);
    fs.writeFileSync(csvFile, renderCsv(analysis.enriched));
    const renderedChartFile = renderChartSafely({ enrichedJsonlFile, chartFile, market });
    fs.writeFileSync(mdFile, renderMarkdown({ header, analysis, files: { jsonlFile, enrichedJsonlFile, csvFile, mdFile, chartFile: renderedChartFile } }));
    appendDiscovery(opts, {
      level: "premium-watch-probe-complete",
      market: market.address,
      samples: samples.length,
      validSamples: 0,
      error: "no-outcomes-after-hydration",
      jsonlFile,
      enrichedJsonlFile,
      csvFile,
      mdFile,
      chartFile: renderedChartFile,
      at: new Date().toISOString()
    });
    console.log(JSON.stringify({
      level: "premium-watch-probe-complete",
      market: market.address,
      samples: samples.length,
      validSamples: 0,
      error: "no-outcomes-after-hydration",
      jsonlFile,
      enrichedJsonlFile,
      csvFile,
      mdFile,
      chartFile: renderedChartFile
    }));
    return;
  }

  let tick = 0;
  let post20TickCount = 0;
  let seenPost20AtThisTick = false;
  while (true) {
    const dueAt = entry.startMs + tick * opts.sampleMs;
    const waitMs = dueAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    const localNow = Date.now();
    const common = await buildSampleCommon(publicClient, market, entry, localNow);
    const rows = await sampleMarketTick({ publicClient, market, outcomes, stakesUsdt: opts.stakesUsdt, common, opts });
    seenPost20AtThisTick = rows.some((row) => row.ok && Number(row.chainOffsetSeconds) >= 20);
    if (seenPost20AtThisTick) post20TickCount += 1;
    for (const row of rows) {
      appendJsonl(jsonlFile, row);
      samples.push(row);
    }

    const chainDone = Number(common.chainOffsetSeconds) >= opts.windowMs / 1000 && post20TickCount >= opts.post20Ticks;
    const localDone = Number(common.localOffsetMs) >= opts.maxLocalOffsetMs;
    if (chainDone || localDone) break;
    tick += 1;
  }

  const analysis = analyzeSamples(samples);
  writeJsonl(enrichedJsonlFile, analysis.enriched);
  fs.writeFileSync(csvFile, renderCsv(analysis.enriched));
  const renderedChartFile = renderChartSafely({ enrichedJsonlFile, chartFile, market });
  fs.writeFileSync(mdFile, renderMarkdown({ header, analysis, files: { jsonlFile, enrichedJsonlFile, csvFile, mdFile, chartFile: renderedChartFile } }));
  console.log(JSON.stringify({
    level: "premium-watch-probe-complete",
    market: market.address,
    samples: samples.length,
    validSamples: samples.filter((sample) => sample.ok).length,
    jsonlFile,
    enrichedJsonlFile,
    csvFile,
    mdFile,
    chartFile: renderedChartFile
  }));
  appendDiscovery(opts, {
    level: "premium-watch-probe-complete",
    market: market.address,
    samples: samples.length,
    validSamples: samples.filter((sample) => sample.ok).length,
    jsonlFile,
    enrichedJsonlFile,
    csvFile,
    mdFile,
    chartFile: renderedChartFile,
    at: new Date().toISOString()
  });
}

function renderChartSafely({ enrichedJsonlFile, chartFile, market }) {
  try {
    return renderPremiumWatchChartFile({ inputFile: enrichedJsonlFile, outputFile: chartFile });
  } catch (error) {
    console.log(JSON.stringify({
      level: "premium-watch-chart-error",
      market: market.address,
      enrichedJsonlFile,
      chartFile,
      message: errorMessage(error)
    }));
    return null;
  }
}

async function hydrateMarket(cfg, market) {
  try {
    return await fetchMarket(cfg, market.address);
  } catch (error) {
    console.log(JSON.stringify({
      level: "premium-watch-hydrate-error",
      market: market.address,
      message: errorMessage(error)
    }));
    return market;
  }
}

function hydrateMarketInBackground(cfg, entry) {
  return hydrateMarket(cfg, entry.market)
    .then((hydrated) => {
      entry.market = mergeMarket(entry.market, hydrated);
      return entry.market;
    })
    .catch((error) => {
      console.log(JSON.stringify({
        level: "premium-watch-hydrate-background-error",
        market: entry.market?.address ?? null,
        message: errorMessage(error)
      }));
      return entry.market;
    });
}

function selectProbeOutcomes(market, opts) {
  const outcomes = sortOutcomes(market.outcomes ?? []);
  if (opts.maxOutcomes > 0) return outcomes.slice(0, opts.maxOutcomes);
  return outcomes;
}

async function buildSampleCommon(publicClient, market, entry, localNow) {
  const blockStartedAt = Date.now();
  let block = null;
  let blockError = null;
  try {
    block = await publicClient.getBlock({ blockTag: "latest" });
  } catch (error) {
    blockError = errorMessage(error);
  }
  const chainTimestampMs = block?.timestamp !== undefined ? Number(block.timestamp) * 1000 : null;
  const chainOffsetSeconds = Number.isFinite(chainTimestampMs) ? (chainTimestampMs - entry.startMs) / 1000 : null;
  return {
    rowType: "sample",
    market: market.address,
    question: market.question ?? market.title ?? "",
    status: market.status ?? null,
    startDate: market.startDate,
    endDate: market.endDate ?? null,
    createdAt: market.createdAt ?? null,
    discoveredAt: entry.discoveredAt,
    discoverySources: [...entry.sources].sort(),
    sampleAt: new Date(localNow).toISOString(),
    localOffsetMs: Math.round(localNow - entry.startMs),
    chainBlock: block?.number?.toString() ?? null,
    chainTimestamp: Number.isFinite(chainTimestampMs) ? new Date(chainTimestampMs).toISOString() : null,
    chainOffsetSeconds: chainOffsetSeconds === null ? null : roundNumber(chainOffsetSeconds, 3),
    blockLatencyMs: Date.now() - blockStartedAt,
    blockError
  };
}

async function sampleMarketTick({ publicClient, market, outcomes, stakesUsdt, common, opts }) {
  const jobs = [];
  for (const outcome of outcomes) {
    for (const stakeUsdt of stakesUsdt) {
      jobs.push({ outcome, stakeUsdt });
    }
  }
  return runConcurrent(jobs, opts.quoteConcurrency, ({ outcome, stakeUsdt }) =>
    sampleOutcomeStake(publicClient, market, outcome, stakeUsdt, common)
  );
}

async function sampleOutcomeStake(publicClient, market, outcome, stakeUsdt, common) {
  const quoteStartedAt = Date.now();
  const amount = parseUnits(String(stakeUsdt), 18);
  const base = {
    ...common,
    tokenId: String(outcome.tokenId),
    outcomeName: outcomeName(outcome),
    outcomeRestPrice: numberOrNull(outcome.price),
    outcomeRestPayout: numberOrNull(outcome.payout),
    stakeUsdt,
    amountInRaw: amount.toString()
  };

  try {
    const simulated = await simulateMintAmount(publicClient, {
      market: market.address,
      tokenId: outcome.tokenId,
      amount,
      stakeUsdt
    });
    const pre = simulated.pre ?? {};
    const post = simulated.post ?? {};
    const prePriceRaw = curveField(pre, "price", 1);
    const preSupplyRaw = curveField(pre, "supply", 2);
    const preTotalMarketCapRaw = curveField(pre, "totalMarketCap", 3);
    const prePayoutPerOtRaw = curveField(pre, "payoutPerOt", 4);
    const postPriceRaw = curveField(post, "price", 1);
    const postSupplyRaw = curveField(post, "supply", 2);
    const postTotalMarketCapRaw = curveField(post, "totalMarketCap", 3);
    const postPayoutPerOtRaw = curveField(post, "payoutPerOt", 4);
    const collateralFromUserRaw = simulated.collateralFromUser;
    const collateralToTreasuryRaw = simulated.collateralToTreasury;
    const collateralToIntegratorRaw = simulated.collateralToIntegrator;
    const otToUserRaw = simulated.otToUser;
    const prePrice = tokenNumber(prePriceRaw);
    const collateralFromUser = tokenNumber(collateralFromUserRaw);
    const otToUser = tokenNumber(otToUserRaw);
    const effectiveCost = otToUser > 0 ? collateralFromUser / otToUser : null;
    const quoteMarkupPct = effectiveCost !== null && prePrice > 0
      ? (effectiveCost / prePrice - 1) * 100
      : null;
    return {
      ok: true,
      ...base,
      quoteLatencyMs: Date.now() - quoteStartedAt,
      prePriceRaw: bigString(prePriceRaw),
      preSupplyRaw: bigString(preSupplyRaw),
      preTotalMarketCapRaw: bigString(preTotalMarketCapRaw),
      prePayoutPerOtRaw: bigString(prePayoutPerOtRaw),
      postPriceRaw: bigString(postPriceRaw),
      postSupplyRaw: bigString(postSupplyRaw),
      postTotalMarketCapRaw: bigString(postTotalMarketCapRaw),
      postPayoutPerOtRaw: bigString(postPayoutPerOtRaw),
      collateralFromUserRaw: bigString(collateralFromUserRaw),
      collateralToTreasuryRaw: bigString(collateralToTreasuryRaw),
      collateralToIntegratorRaw: bigString(collateralToIntegratorRaw),
      otToUserRaw: bigString(otToUserRaw),
      prePrice: roundNumber(prePrice, 9),
      preSupply: roundNumber(tokenNumber(preSupplyRaw), 6),
      preTotalMarketCap: roundNumber(tokenNumber(preTotalMarketCapRaw), 6),
      prePayoutPerOt: roundNumber(tokenNumber(prePayoutPerOtRaw), 9),
      postPrice: roundNumber(tokenNumber(postPriceRaw), 9),
      postSupply: roundNumber(tokenNumber(postSupplyRaw), 6),
      postTotalMarketCap: roundNumber(tokenNumber(postTotalMarketCapRaw), 6),
      postPayoutPerOt: roundNumber(tokenNumber(postPayoutPerOtRaw), 9),
      collateralFromUser: roundNumber(collateralFromUser, 9),
      collateralToTreasury: roundNumber(tokenNumber(collateralToTreasuryRaw), 9),
      collateralToIntegrator: roundNumber(tokenNumber(collateralToIntegratorRaw), 9),
      otToUser: roundNumber(otToUser, 9),
      otPerUsdt: collateralFromUser > 0 ? roundNumber(otToUser / collateralFromUser, 9) : null,
      effectiveCost: effectiveCost === null ? null : roundNumber(effectiveCost, 9),
      quoteMarkupPct: quoteMarkupPct === null ? null : roundNumber(quoteMarkupPct, 6),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      ...base,
      quoteLatencyMs: Date.now() - quoteStartedAt,
      error: errorMessage(error)
    };
  }
}

function analyzeSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    if (!sample.ok) continue;
    const key = sampleGroupKey(sample);
    const rows = groups.get(key) ?? [];
    rows.push(sample);
    groups.set(key, rows);
  }

  const baselines = new Map();
  for (const [key, rows] of groups.entries()) {
    const baselineRows = rows
      .filter((row) => Number(row.chainOffsetSeconds) >= 20 && Number.isFinite(Number(row.quoteMarkupPct)))
      .sort(compareOffsets);
    if (baselineRows.length === 0) continue;
    baselines.set(key, {
      baselineMarkupPct: median(baselineRows.map((row) => Number(row.quoteMarkupPct))),
      baselineEffectiveCost: median(baselineRows.map((row) => Number(row.effectiveCost))),
      baselineOtToUser: median(baselineRows.map((row) => Number(row.otToUser))),
      baselineChainOffsetSeconds: baselineRows[0].chainOffsetSeconds,
      baselineLocalOffsetMs: baselineRows[0].localOffsetMs,
      baselineSampleCount: baselineRows.length
    });
  }

  const enriched = samples.map((sample) => enrichSample(sample, baselines.get(sampleGroupKey(sample))));
  enriched.sort((a, b) =>
    String(a.market).localeCompare(String(b.market)) ||
    Number(a.stakeUsdt ?? 0) - Number(b.stakeUsdt ?? 0) ||
    compareTokenId(a, b) ||
    Number(a.localOffsetMs ?? 0) - Number(b.localOffsetMs ?? 0)
  );

  return {
    enriched,
    summaries: summarizeGroups(enriched),
    aggregate: {
      chainOffset: aggregateCurve(enriched, { field: "chainOffsetSeconds", bucketSize: 0.5, outputField: "chainOffsetSeconds" }),
      localOffset: aggregateCurve(enriched, { field: "localOffsetMs", bucketSize: 500, outputField: "localOffsetMs" })
    }
  };
}

function enrichSample(sample, baseline) {
  const next = { ...sample };
  next.baselineMarkupPct = baseline?.baselineMarkupPct === undefined ? null : roundNumber(baseline.baselineMarkupPct, 6);
  next.baselineEffectiveCost = baseline?.baselineEffectiveCost === undefined ? null : roundNumber(baseline.baselineEffectiveCost, 9);
  next.baselineOtToUser = baseline?.baselineOtToUser === undefined ? null : roundNumber(baseline.baselineOtToUser, 9);
  next.baselineChainOffsetSeconds = baseline?.baselineChainOffsetSeconds ?? null;
  next.baselineLocalOffsetMs = baseline?.baselineLocalOffsetMs ?? null;
  next.baselineSampleCount = baseline?.baselineSampleCount ?? 0;
  if (!sample.ok || !baseline || !Number.isFinite(Number(sample.effectiveCost)) || !Number.isFinite(Number(sample.prePrice))) {
    next.estimatedPremiumPctOfBase = null;
    next.estimatedPremiumUsdt = null;
    next.observedCostPremiumPct = null;
    next.otShortfallPct = null;
    return next;
  }

  const estimatedPremiumPctOfBase = Math.max(0, Number(sample.quoteMarkupPct) - baseline.baselineMarkupPct);
  const normalCost = Number(sample.prePrice) * (1 + baseline.baselineMarkupPct / 100);
  const estimatedPremiumUsdt = Math.max(0, Number(sample.effectiveCost) - normalCost) * Number(sample.otToUser);
  next.estimatedPremiumPctOfBase = roundNumber(estimatedPremiumPctOfBase, 6);
  next.estimatedPremiumUsdt = roundNumber(estimatedPremiumUsdt, 9);
  next.observedCostPremiumPct = baseline.baselineEffectiveCost > 0
    ? roundNumber((Number(sample.effectiveCost) / baseline.baselineEffectiveCost - 1) * 100, 6)
    : null;
  next.otShortfallPct = baseline.baselineOtToUser > 0
    ? roundNumber((1 - Number(sample.otToUser) / baseline.baselineOtToUser) * 100, 6)
    : null;
  return next;
}

function summarizeGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = sampleGroupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const valid = group.filter((row) => row.ok);
    const premiums = valid.map((row) => Number(row.estimatedPremiumPctOfBase)).filter(Number.isFinite);
    const premiumUsdt = valid.map((row) => Number(row.estimatedPremiumUsdt)).filter(Number.isFinite);
    const first = group[0];
    return {
      market: first.market,
      question: first.question,
      tokenId: first.tokenId,
      outcomeName: first.outcomeName,
      stakeUsdt: first.stakeUsdt,
      sampleCount: group.length,
      validSampleCount: valid.length,
      baselineMarkupPct: first.baselineMarkupPct,
      baselineEffectiveCost: first.baselineEffectiveCost,
      baselineChainOffsetSeconds: first.baselineChainOffsetSeconds,
      baselineSampleCount: first.baselineSampleCount,
      maxEstimatedPremiumPctOfBase: premiums.length ? roundNumber(Math.max(...premiums), 6) : null,
      medianEstimatedPremiumPctOfBase: premiums.length ? roundNumber(median(premiums), 6) : null,
      maxEstimatedPremiumUsdt: premiumUsdt.length ? roundNumber(Math.max(...premiumUsdt), 9) : null,
      firstValidChainOffsetSeconds: valid[0]?.chainOffsetSeconds ?? null,
      firstError: group.find((row) => !row.ok)?.error ?? null
    };
  }).sort((a, b) =>
    Number(a.stakeUsdt ?? 0) - Number(b.stakeUsdt ?? 0) ||
    compareTokenId(a, b)
  );
}

function aggregateCurve(rows, { field, bucketSize, outputField }) {
  const buckets = new Map();
  for (const row of rows) {
    if (!row.ok || row.estimatedPremiumPctOfBase === null || row.estimatedPremiumPctOfBase === undefined) continue;
    const fieldValue = Number(row[field]);
    if (!Number.isFinite(fieldValue)) continue;
    const bucketValue = Math.round(fieldValue / bucketSize) * bucketSize;
    const key = `${row.stakeUsdt}:${bucketValue}`;
    const bucket = buckets.get(key) ?? {
      stakeUsdt: row.stakeUsdt,
      [outputField]: bucketValue,
      estimatedPremiumPctOfBase: [],
      estimatedPremiumUsdt: [],
      observedCostPremiumPct: []
    };
    bucket.estimatedPremiumPctOfBase.push(Number(row.estimatedPremiumPctOfBase));
    if (Number.isFinite(Number(row.estimatedPremiumUsdt))) bucket.estimatedPremiumUsdt.push(Number(row.estimatedPremiumUsdt));
    if (Number.isFinite(Number(row.observedCostPremiumPct))) bucket.observedCostPremiumPct.push(Number(row.observedCostPremiumPct));
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => Number(a.stakeUsdt) - Number(b.stakeUsdt) || Number(a[outputField]) - Number(b[outputField]))
    .map((bucket) => ({
      stakeUsdt: bucket.stakeUsdt,
      [outputField]: roundNumber(bucket[outputField], 3),
      medianEstimatedPremiumPctOfBase: roundNumber(median(bucket.estimatedPremiumPctOfBase), 6),
      p25EstimatedPremiumPctOfBase: roundNumber(quantile(bucket.estimatedPremiumPctOfBase, 0.25), 6),
      p75EstimatedPremiumPctOfBase: roundNumber(quantile(bucket.estimatedPremiumPctOfBase, 0.75), 6),
      medianEstimatedPremiumUsdt: roundNumber(median(bucket.estimatedPremiumUsdt), 9),
      medianObservedCostPremiumPct: roundNumber(median(bucket.observedCostPremiumPct), 6),
      sampleCount: bucket.estimatedPremiumPctOfBase.length
    }));
}

function renderCsv(rows) {
  const headers = [
    ["sampleAt", "采样时间"],
    ["localOffsetMs", "本地开盘后毫秒"],
    ["chainOffsetSeconds", "链上开盘后秒"],
    ["chainBlock", "区块"],
    ["market", "市场地址"],
    ["question", "问题"],
    ["outcomeName", "选项"],
    ["tokenId", "选项ID"],
    ["stakeUsdt", "模拟买入金额U"],
    ["otToUser", "买到数量"],
    ["effectiveCost", "实际每份成本U"],
    ["prePrice", "开盘前价格U"],
    ["quoteMarkupPct", "报价相对开盘前价格溢价%"],
    ["baselineMarkupPct", "20秒后正常溢价基线%"],
    ["estimatedPremiumPctOfBase", "估算premium%"],
    ["estimatedPremiumUsdt", "估算premium金额U"],
    ["observedCostPremiumPct", "实际成本曲线溢价%"],
    ["otShortfallPct", "数量少拿%"],
    ["quoteLatencyMs", "报价耗时毫秒"],
    ["error", "错误"]
  ];
  const lines = [headers.map(([, label]) => csvCell(label)).join(",")];
  for (const row of rows) {
    lines.push(headers.map(([key]) => csvCell(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderMarkdown({ header, analysis, files }) {
  const lines = [
    "# Anti-Sniping Premium 实时探针报告",
    "",
    `- 市场：${header.question || header.market}`,
    `- 地址：\`${header.market}\``,
    `- 开盘时间：${header.startDate}`,
    `- 发现来源：${header.discoverySources.join(", ") || "n/a"}`,
    `- 模拟金额：${header.stakesUsdt.map((stake) => `${stake}U`).join("、")}`,
    `- 采样：开盘后每 ${header.sampleMs}ms，一直到链上 T+${header.windowMs / 1000}s，并要求至少 ${header.post20Ticks} 个 T+20s 之后有效样本`,
    "",
    "## 怎么算",
    "",
    "- 每次探针都只是问合约：现在模拟买入，会花多少 BUSDT、拿到多少 OT。",
    "- 先算“实际每份成本”：实际花费 BUSDT / 拿到的 OT。",
    "- 再算“报价相对开盘前价格的溢价”：实际每份成本 / quote 里的开盘前价格 - 1。",
    "- 最后用同一个市场、同一个选项、同一个金额在链上 T+20s 之后的正常溢价做基线；当前溢价减掉这个基线，就是报告里的估算 premium。",
    "- “实际成本曲线溢价”没有扣基线，会混进别人买入造成的曲线变化；它能看真实狙击成本，但不能当成纯协议税率。",
    "",
    "## 链上时间走势",
    ""
  ];

  const stakes = [...new Set(analysis.aggregate.chainOffset.map((row) => row.stakeUsdt))].sort((a, b) => Number(a) - Number(b));
  if (stakes.length === 0) {
    lines.push("没有足够的 T+20s 后基线样本，暂时无法估算 premium。");
  } else {
    for (const stake of stakes) {
      lines.push(`### 模拟买入 ${stake}U`, "");
      lines.push("| 链上开盘后 | 估算 premium 中位数 | 估算 premium 金额中位数 | 实际成本曲线溢价中位数 | 样本数 |");
      lines.push("| --- | ---: | ---: | ---: | ---: |");
      for (const row of analysis.aggregate.chainOffset.filter((item) => item.stakeUsdt === stake)) {
        lines.push(`| T+${fmt(row.chainOffsetSeconds)}s | ${fmt(row.medianEstimatedPremiumPctOfBase)}% | ${fmt(row.medianEstimatedPremiumUsdt)}U | ${fmt(row.medianObservedCostPremiumPct)}% | ${row.sampleCount} |`);
      }
      lines.push("");
    }
  }

  lines.push("## 每个选项的基线", "");
  lines.push("| 选项 | 金额 | 20秒后正常溢价基线 | 20秒后每份成本 | 最大估算 premium | 最大估算 premium 金额 | 有效样本 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  if (analysis.summaries.length === 0) {
    lines.push("| n/a | n/a | n/a | n/a | n/a | n/a | 0 |");
  } else {
    for (const summary of analysis.summaries) {
      lines.push(`| ${escapeMarkdown(summary.outcomeName)} | ${fmt(summary.stakeUsdt)}U | ${fmt(summary.baselineMarkupPct)}% | ${fmt(summary.baselineEffectiveCost)}U | ${fmt(summary.maxEstimatedPremiumPctOfBase)}% | ${fmt(summary.maxEstimatedPremiumUsdt)}U | ${summary.validSampleCount} |`);
    }
  }

  lines.push(
    "",
    "## 文件",
    "",
    `- 原始逐笔样本：\`${files.jsonlFile}\``,
    `- 带基线和估算 premium 的逐笔样本：\`${files.enrichedJsonlFile}\``,
    `- 中文 CSV：\`${files.csvFile}\``,
    ...(files.chartFile ? [`- 中文曲线图：\`${files.chartFile}\``] : []),
    `- 当前报告：\`${files.mdFile}\``,
    "",
    "## 结论边界",
    "",
    "这个报告基于真实合约 quote 数据，不猜官方线性公式；但因为 quote 本身会受别人买入和曲线状态影响，估算 premium 仍然是“扣除 20 秒后正常报价基线后的剩余溢价”，不是合约内部单独吐出的字段。"
  );
  return `${lines.join("\n")}\n`;
}

async function waitForOnce(state, opts) {
  const until = Date.now() + opts.maxWaitMs;
  while (true) {
    const running = state.tasks.size > 0 || state.intelTasks.size > 0;
    const dueEntries = [...state.entries.values()].filter((entry) =>
      !entry.completed && Number.isFinite(entry.startMs) && entry.startMs <= until
    );
    if (!running && dueEntries.length === 0) return;
    if (Date.now() > until && !running) return;
    await sleep(Math.min(500, Math.max(50, opts.sampleMs)));
  }
}

function stopWatch(state) {
  state.stopping = true;
  for (const entry of state.entries.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }
  if (typeof state.unwatch === "function") {
    try {
      state.unwatch();
    } catch {
      // no-op
    }
  }
}

function installSignalHandlers(state) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      console.log(JSON.stringify({ level: "premium-watch-stopping", signal }));
      stopWatch(state);
      const deadline = setTimeout(() => process.exit(0), 25_000);
      Promise.allSettled([...state.tasks, ...state.intelTasks]).then(() => {
        clearTimeout(deadline);
        process.exit(0);
      });
    });
  }
}

function mergeMarkets(...groups) {
  const byAddress = new Map();
  for (const market of groups.flat()) {
    if (!market?.address) continue;
    const key = String(market.address).toLowerCase();
    byAddress.set(key, mergeMarket(byAddress.get(key), market));
  }
  return [...byAddress.values()];
}

function mergeMarket(existing, next) {
  if (!existing) return next;
  if (!next) return existing;
  return {
    ...existing,
    ...next,
    outcomes: Array.isArray(next.outcomes) && next.outcomes.length ? next.outcomes : existing.outcomes,
    categories: Array.isArray(next.categories) && next.categories.length ? next.categories : existing.categories,
    tags: Array.isArray(next.tags) && next.tags.length ? next.tags : existing.tags
  };
}

function premiumWatchOutputBase(outputDir, market, startedAt) {
  const safeDate = String(market.startDate ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const safeStarted = String(startedAt).replace(/[:.]/g, "-");
  const address = String(market.address ?? "unknown").replace(/^0x/i, "").slice(0, 10);
  return path.join(String(outputDir), `premium-watch-${safeDate}-${address}-${safeStarted}`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function appendDiscovery(opts, row) {
  appendJsonl(opts.discoveryFile, row);
}

function appendEventDiscoveryFeed(opts, entry, source, decision) {
  if (!opts.eventDiscoveryFeedFile) return false;
  const market = compactMarketForDiscoveryFeed(entry.market);
  if (!market.address) return false;
  const signature = JSON.stringify(market);
  if (entry.feedLastSignature === signature) return false;
  entry.feedLastSignature = signature;
  appendJsonl(opts.eventDiscoveryFeedFile, {
    level: "event-discovery-feed",
    market,
    address: market.address,
    question: market.question ?? market.title ?? null,
    status: market.status ?? null,
    startDate: market.startDate ?? null,
    source,
    sources: [...entry.sources].sort(),
    discoveredAt: entry.discoveredAt,
    lastSeenAt: entry.lastSeenAt,
    decisionReason: decision?.reason ?? null,
    probeEligible: Boolean(decision?.eligible),
    at: new Date().toISOString()
  });
  return true;
}

function compactMarketForDiscoveryFeed(market = {}) {
  return omitUndefined({
    address: stringOrNull(market.address),
    question: market.question ?? market.title ?? null,
    title: market.title ?? null,
    status: market.status ?? null,
    createdAt: market.createdAt ?? null,
    startDate: market.startDate ?? null,
    endDate: market.endDate ?? null,
    contractVersion: numberOrString(market.contractVersion),
    collateral: stringOrNull(market.collateral),
    parentTokenId: stringOrNull(market.parentTokenId),
    curve: stringOrNull(market.curve),
    questionId: stringOrNull(market.questionId),
    categories: stringArray(market.categories),
    tags: stringArray(market.tags),
    transactionHash: stringOrNull(market.transactionHash),
    blockNumber: stringOrNull(market.blockNumber),
    transactionIndex: stringOrNull(market.transactionIndex),
    logIndex: stringOrNull(market.logIndex),
    outcomes: Array.isArray(market.outcomes)
      ? market.outcomes.map(compactOutcomeForDiscoveryFeed).filter((outcome) => outcome.tokenId || outcome.name)
      : []
  });
}

function compactOutcomeForDiscoveryFeed(outcome = {}) {
  return omitUndefined({
    tokenId: stringOrNull(outcome.tokenId),
    name: outcome.name ?? outcome.title ?? null,
    title: outcome.title ?? null,
    price: numberOrString(outcome.price),
    payout: numberOrString(outcome.payout),
    volume: numberOrString(outcome.volume),
    mintedQuantity: numberOrString(outcome.mintedQuantity)
  });
}

function omitUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function numberOrString(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

async function runConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function sampleGroupKey(row) {
  return `${String(row.market ?? "").toLowerCase()}:${String(row.tokenId ?? "")}:${String(row.stakeUsdt ?? "")}`;
}

function sortOutcomes(outcomes) {
  return [...outcomes].sort(compareTokenId);
}

function compareTokenId(a, b) {
  const left = safeBigInt(a?.tokenId ?? 0);
  const right = safeBigInt(b?.tokenId ?? 0);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareOffsets(a, b) {
  return Number(a.chainOffsetSeconds ?? 0) - Number(b.chainOffsetSeconds ?? 0) ||
    Number(a.localOffsetMs ?? 0) - Number(b.localOffsetMs ?? 0);
}

function curveField(value, key, index) {
  return value?.[key] ?? value?.[index] ?? 0n;
}

function outcomeName(outcome) {
  return String(outcome?.name ?? outcome?.title ?? outcome?.outcome ?? "");
}

function tokenNumber(value) {
  if (value === null || value === undefined) return 0;
  return Number(formatUnits(BigInt(value), 18));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits));
}

function median(values) {
  return quantile(values, 0.5);
}

function quantile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function fmt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return String(value);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/\|/g, "\\|");
}

function bigString(value) {
  if (value === null || value === undefined) return null;
  return BigInt(value).toString();
}

function safeBigInt(value) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function envBool(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function isBot1ProfileName(botName) {
  const normalized = String(botName ?? "").trim().toLowerCase();
  return normalized === "42space" || normalized.startsWith("bot1");
}

function errorMessage(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "premium-watch-fatal", message: errorMessage(error) }));
  process.exitCode = 1;
});
