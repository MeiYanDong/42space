#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";

const DEFAULT_PROFILE_ENV = "/etc/42space/profiles/42space.env";
const DEFAULT_LIMIT = 30;
const DEFAULT_TARGET_OFFSET_MS = 20000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileEnvFile = args.profileEnv ?? DEFAULT_PROFILE_ENV;
  const profileEnv = fs.existsSync(profileEnvFile) ? parseEnvFile(profileEnvFile) : {};
  const env = { ...process.env, ...profileEnv };
  const dataDir = path.dirname(env.RUNTIME_CONFIG_FILE ?? "/opt/42space/data/42space/runtime-config.json");
  const fillsFile = args.fillsFile ?? env.FILLS_FILE ?? path.join(dataDir, "fills.jsonl");
  const targetOffsetMs = positiveNumber(args.targetOffsetMs ?? env.OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS, DEFAULT_TARGET_OFFSET_MS);
  const limit = positiveInteger(args.limit, DEFAULT_LIMIT);
  const sinceMs = args.since ? Date.parse(args.since) : null;
  const gasFilter = args.gasPriceGwei === undefined ? null : Number(args.gasPriceGwei);

  const fills = readJsonl(fillsFile);
  const receiptRows = receiptRowsByHash(fills);
  const buys = fills
    .filter((row) => row?.plan?.market?.startDate && row?.result?.txHash)
    .filter((row) => row.result.broadcastStartedAt && row.result.firstAcceptedAt)
    .filter((row) => !Number.isFinite(sinceMs) || Date.parse(row.plan.market.startDate) >= sinceMs)
    .filter((row) => !Number.isFinite(gasFilter) || Number(row.result.gasPriceGwei) === gasFilter)
    .slice(-limit);

  const rpcUrl = args.rpcUrl ?? env.BSC_RPC_URL ?? env.CHAINSTACK_BSC_RPC_URL ?? env.ANKR_BSC_RPC_URL ?? null;
  const publicClient = rpcUrl ? createPublicClient({ chain: bsc, transport: http(rpcUrl) }) : null;
  const samples = [];
  for (const row of buys) {
    samples.push(await buildSample(row, receiptRows.get(String(row.result.txHash).toLowerCase()), publicClient, targetOffsetMs));
  }

  const usable = samples.filter((sample) => Number.isFinite(sample.firstAcceptedLeadToTargetMs));
  const targetSecond = usable.filter((sample) => sample.blockOffsetMs === targetOffsetMs);
  const preTarget = usable.filter((sample) => Number.isFinite(sample.blockOffsetMs) && sample.blockOffsetMs < targetOffsetMs);
  const postTarget = usable.filter((sample) => Number.isFinite(sample.blockOffsetMs) && sample.blockOffsetMs > targetOffsetMs);
  const latencies = usable.map((sample) => sample.firstAcceptedLatencyMs).filter(Number.isFinite);
  const targetLeads = targetSecond.map((sample) => sample.firstAcceptedLeadToTargetMs).filter(Number.isFinite);
  const preTargetLeads = preTarget.map((sample) => sample.firstAcceptedLeadToTargetMs).filter(Number.isFinite);

  const latencyP75 = percentile(latencies, 75);
  const targetMaxAcceptedLead = max(targetLeads);
  const preTargetMinAcceptedLead = min(preTargetLeads);
  const desiredAcceptedLeadMs = Number.isFinite(targetMaxAcceptedLead)
    ? clamp(targetMaxAcceptedLead + 20, 20, 45)
    : 25;
  const rawSuggestedLeadMs = Number.isFinite(latencyP75)
    ? Math.round(clamp(latencyP75 + desiredAcceptedLeadMs, 70, 110))
    : 95;
  const nominalLeadMs = Number.isFinite(rawSuggestedLeadMs)
    ? Math.min(rawSuggestedLeadMs, 95)
    : 80;
  const armLeadMs = Math.max(nominalLeadMs, 100);

  const report = {
    level: "bot1-block-aware-calibration",
    generatedAt: new Date().toISOString(),
    input: {
      profileEnvFile,
      fillsFile,
      rpcHost: rpcUrl ? rpcHost(rpcUrl) : null,
      limit,
      since: args.since ?? null,
      gasPriceGwei: args.gasPriceGwei ?? null,
      targetOffsetMs
    },
    sampleCount: samples.length,
    summary: {
      latencyMs: summarize(latencies),
      firstAcceptedLeadToTargetMs: summarize(usable.map((sample) => sample.firstAcceptedLeadToTargetMs)),
      targetSecondCount: targetSecond.length,
      preTargetCount: preTarget.length,
      postTargetCount: postTarget.length,
      targetMaxAcceptedLeadMs: targetMaxAcceptedLead,
      preTargetMinAcceptedLeadMs: preTargetMinAcceptedLead
    },
    recommendation: {
      openBroadcastDelayMs: 19900,
      openBroadcastBlockAwareLeadMs: nominalLeadMs,
      openBroadcastBlockAwarePreTargetCount: 2,
      openBroadcastBlockAwarePreTargetSendMs: 120,
      armLeadMs,
      rawSuggestedLeadMs,
      rationale: [
        `p75 first-accepted RPC latency is ${formatMs(latencyP75)}`,
        `latest target-second max accepted lead is ${formatMs(targetMaxAcceptedLead)}`,
        `nearest observed pre-target accepted lead is ${formatMs(preTargetMinAcceptedLead)}`,
        "use T+19.900 as the earliest arm, nominally target T+20 minus the recommended lead, and release at arm only after two fresh T+19s heads"
      ]
    },
    samples
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.quiet) {
    console.log(JSON.stringify({
      level: report.level,
      generatedAt: report.generatedAt,
      sampleCount: report.sampleCount,
      recommendation: report.recommendation,
      out: args.out ? path.resolve(args.out) : null
    }));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

async function buildSample(row, receiptRow, publicClient, targetOffsetMs) {
  const startMs = Date.parse(row.plan.market.startDate);
  const result = row.result;
  let blockNumber = receiptRow?.blockNumber ?? result.blockNumber ?? null;
  let blockOffsetMs = null;
  let transactionIndex = null;
  if (publicClient && result.txHash) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: result.txHash });
      const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
      blockNumber = receipt.blockNumber.toString();
      transactionIndex = Number(receipt.transactionIndex);
      blockOffsetMs = Number(block.timestamp) * 1000 - startMs;
    } catch {
      // Keep timing-only samples usable when an RPC cannot fetch the receipt.
    }
  }
  return {
    question: row.plan.market.question ?? null,
    market: row.plan.market.address ?? null,
    txHash: result.txHash,
    startDate: row.plan.market.startDate,
    gasPriceGwei: result.gasPriceGwei ?? null,
    broadcastOffsetMs: offsetMs(result.broadcastStartedAt, startMs),
    firstAcceptedOffsetMs: offsetMs(result.firstAcceptedAt, startMs),
    firstAcceptedLatencyMs: numberOrNull(result.firstAcceptedLatencyMs),
    firstAcceptedLeadToTargetMs: Number.isFinite(startMs)
      ? startMs + targetOffsetMs - Date.parse(result.firstAcceptedAt ?? "")
      : null,
    broadcastLeadToTargetMs: Number.isFinite(startMs)
      ? startMs + targetOffsetMs - Date.parse(result.broadcastStartedAt ?? "")
      : null,
    blockNumber,
    transactionIndex,
    blockOffsetMs,
    classification: classifyBlockOffset(blockOffsetMs, targetOffsetMs)
  };
}

function receiptRowsByHash(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row?.level !== "event-receipt" || !row.txHash) continue;
    map.set(String(row.txHash).toLowerCase(), row);
  }
  return map;
}

function classifyBlockOffset(blockOffsetMs, targetOffsetMs) {
  if (!Number.isFinite(blockOffsetMs)) return "unknown";
  if (blockOffsetMs < targetOffsetMs) return "pre_target";
  if (blockOffsetMs === targetOffsetMs) return "target_second";
  return "post_target";
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
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

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function summarize(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: nums.length,
    min: nums[0] ?? null,
    p50: percentile(nums, 50),
    p75: percentile(nums, 75),
    p90: percentile(nums, 90),
    max: nums.at(-1) ?? null
  };
}

function percentile(values, pct) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((pct / 100) * nums.length) - 1));
  return nums[index];
}

function min(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? Math.min(...nums) : null;
}

function max(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

function offsetMs(value, startMs) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) && Number.isFinite(startMs) ? ms - startMs : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function rpcHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "<unknown>";
  }
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

main().catch((error) => {
  console.error(JSON.stringify({
    level: "bot1-block-aware-calibration-error",
    message: error?.message ?? String(error)
  }));
  process.exit(1);
});
