import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function loadDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return;

  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function readConfig() {
  loadDotEnv(".env.local");
  loadDotEnv();
  loadProviderEnv();

  const cfg = {
    restUrl: envString("FORTYTWO_REST_URL", "https://rest.ft.42.space"),
    rpcUrl: envFirst(
      ["BSC_RPC_URL", "CHAINSTACK_BSC_RPC_URL", "ANKR_BSC_RPC_URL"],
      "https://bsc-rpc.publicnode.com"
    ),
    wsUrl: envFirst(
      ["BSC_WS_URL", "CHAINSTACK_BSC_WS_URL", "ANKR_BSC_WS_URL", "ANKR_BSC_WS_RPC_URL"],
      "wss://bsc-rpc.publicnode.com"
    ),
    privateKey: envString("PRIVATE_KEY", "") || readKeychainPrivateKey(),
    walletAddress: envString("WALLET_ADDRESS", ""),
    dryRun: envBool("DRY_RUN", true),
    execute: envBool("EXECUTE", false),
    riskAck: envString("I_UNDERSTAND_42_PRICE_MARKET_RISK", "NO"),
    eligibilityAck: envString("I_AM_NOT_IN_RESTRICTED_JURISDICTION", "NO"),
    targetTopic: envOptionalString("TARGET_TOPIC", "BTC"),
    targetQuestionRegex: envRegex("TARGET_QUESTION_REGEX", "BTC.*(Futures Daily Volume|Price|USDT)"),
    targetOutcomeRegex: envRegex("TARGET_OUTCOME_REGEX", ""),
    strategy: envString("STRATEGY", "binance_volume_projection"),
    stakeUsdt: envNumber("STAKE_USDT", 5),
    stakePerOutcomeUsdt: envNumber("STAKE_PER_OUTCOME_USDT", 5),
    maxStakeUsdt: envNumber("MAX_STAKE_USDT", 25),
    maxMarketStakeUsdt: envNumber("MAX_MARKET_STAKE_USDT", 25),
    maxBatchStakeUsdt: envNumber("MAX_BATCH_STAKE_USDT", 100),
    maxOutcomesPerMarket: envInteger("MAX_OUTCOMES_PER_MARKET", 12),
    eventOutcomeSelection: envString("EVENT_OUTCOME_SELECTION", "lowest_odds"),
    eventOutcomeCount: envInteger("EVENT_OUTCOME_COUNT", 5),
    eventOutcomeSelectionFallback: envString("EVENT_OUTCOME_SELECTION_FALLBACK", "token_order"),
    eventBuyMode: envString("EVENT_BUY_MODE", "fast"),
    eventDiscovery: envString("EVENT_DISCOVERY", "ws"),
    restDiscoveryEnabled: envBool("REST_DISCOVERY_ENABLED", true),
    restDiscoveryPollMs: envInteger("REST_DISCOVERY_POLL_MS", 1000),
    watchFundingMode: envString("WATCH_FUNDING_MODE", "next_batch"),
    bundleDueMarkets: envBool("BUNDLE_DUE_MARKETS", true),
    fastSkipPreflight: envBool("FAST_SKIP_PREFLIGHT", true),
    fastSkipDueRestHydration: envBool("FAST_SKIP_DUE_REST_HYDRATION", true),
    fastNonceManager: envBool("FAST_NONCE_MANAGER", true),
    preSignFastTx: envBool("PRE_SIGN_FAST_TX", true),
    preSignWindowMs: envInteger("PRE_SIGN_WINDOW_MS", 5000),
    preSignRetryMs: envInteger("PRE_SIGN_RETRY_MS", 250),
    nonceSyncBeforePreSign: envBool("NONCE_SYNC_BEFORE_PRESIGN", true),
    nonceSyncMinIntervalMs: envInteger("NONCE_SYNC_MIN_INTERVAL_MS", 250),
    waitForReceipt: envBool("WAIT_FOR_RECEIPT", true),
    asyncReceiptWatch: envBool("ASYNC_RECEIPT_WATCH", true),
    receiptWatchTimeoutMs: envInteger("RECEIPT_WATCH_TIMEOUT_MS", 120000),
    receiptWatchPollingMs: envInteger("RECEIPT_WATCH_POLLING_MS", 1000),
    executionRetryMs: envInteger("EXECUTION_RETRY_MS", 500),
    eventOpenWindowSeconds: envInteger("EVENT_OPEN_WINDOW_SECONDS", 60),
    fanoutBroadcast: envBool("FANOUT_BROADCAST", true),
    broadcastRpcUrls: [],
    broadcastTimeoutMs: envInteger("BROADCAST_TIMEOUT_MS", 1200),
    rpcWarmupTimeoutMs: envInteger("RPC_WARMUP_TIMEOUT_MS", 2500),
    doctorCheckWs: envBool("DOCTOR_CHECK_WS", false),
    gasPriceGwei: envString("GAS_PRICE_GWEI", "0.12"),
    fastGasLimit: envInteger("FAST_GAS_LIMIT", 5000000),
    bundleFastGasLimit: envInteger("BUNDLE_FAST_GAS_LIMIT", 12000000),
    logChunkBlocks: envInteger("LOG_CHUNK_BLOCKS", 5000),
    watchScanLimit: envInteger("WATCH_SCAN_LIMIT", 500),
    eventLogLookbackBlocks: envInteger("EVENT_LOG_LOOKBACK_BLOCKS", 50000),
    replayLookbackBlocks: envInteger("REPLAY_LOOKBACK_BLOCKS", 50000),
    marketCategoryAllowlist: envList("MARKET_CATEGORY_ALLOWLIST", ""),
    marketCategoryBlocklist: envList("MARKET_CATEGORY_BLOCKLIST", "Price"),
    marketTagBlocklist: envList("MARKET_TAG_BLOCKLIST", "8 hour,automated"),
    minMarketCreatedAt: envString("MIN_MARKET_CREATED_AT", ""),
    watchBuyExisting: envBool("WATCH_BUY_EXISTING", false),
    slippageBps: envInteger("SLIPPAGE_BPS", 800),
    pollMs: envInteger("POLL_MS", 500),
    hotPollMs: envInteger("HOT_POLL_MS", 50),
    preopenHotMs: envInteger("PREOPEN_HOT_MS", 5000),
    prebroadcastMs: envInteger("PREBROADCAST_MS", 0),
    wsReceiptFallbackMs: envInteger("WS_RECEIPT_FALLBACK_MS", 0),
    wsReceiptFallbackRetries: envInteger("WS_RECEIPT_FALLBACK_RETRIES", 3),
    watchStartupRetryMs: envInteger("WATCH_STARTUP_RETRY_MS", 5000),
    armWaitForFunding: envBool("ARM_WAIT_FOR_FUNDING", false),
    armFundingRetryMs: envInteger("ARM_FUNDING_RETRY_MS", 60000),
    armFundingHotRetryMs: envInteger("ARM_FUNDING_HOT_RETRY_MS", 1000),
    armFundingHotWindowMs: envInteger("ARM_FUNDING_HOT_WINDOW_MS", 600000),
    armCatchUpAfterFunding: envBool("ARM_CATCH_UP_AFTER_FUNDING", true),
    armCatchUpWindowMs: envInteger("ARM_CATCH_UP_WINDOW_MS", 45000),
    feishuAlertsEnabled: envBool("FEISHU_ALERTS_ENABLED", true),
    feishuWebhook: envString("FEISHU_WEBHOOK", ""),
    feishuAlertCooldownMs: envInteger("FEISHU_ALERT_COOLDOWN_MS", 60000),
    autoSellEnabled: envBool("AUTO_SELL_ENABLED", true),
    autoSellPollMs: envInteger("AUTO_SELL_POLL_MS", 30000),
    autoSellProfitMultiplier: envNumber("AUTO_SELL_PROFIT_MULTIPLIER", 2),
    autoSellPercent: envNumber("AUTO_SELL_PERCENT", 50),
    autoSellPositionLimit: envInteger("AUTO_SELL_POSITION_LIMIT", 500),
    autoSellStateFile: envString("AUTO_SELL_STATE_FILE", "data/auto-sell-seen.json"),
    scanLimit: envInteger("SCAN_LIMIT", 10),
    openWindowSeconds: envInteger("OPEN_WINDOW_SECONDS", 45),
    lookaheadSeconds: envInteger("LOOKAHEAD_SECONDS", 900),
    allowLateBuy: envBool("ALLOW_LATE_BUY", false),
    stateFile: envString("STATE_FILE", "data/seen-markets.json"),
    fillsFile: envString("FILLS_FILE", "data/fills.jsonl")
  };
  cfg.broadcastRpcUrls = resolveBroadcastRpcUrls(cfg.rpcUrl);

  if (cfg.stakeUsdt <= 0) throw new Error("STAKE_USDT must be positive");
  if (cfg.stakePerOutcomeUsdt <= 0) throw new Error("STAKE_PER_OUTCOME_USDT must be positive");
  if (cfg.maxStakeUsdt <= 0) throw new Error("MAX_STAKE_USDT must be positive");
  if (cfg.maxMarketStakeUsdt <= 0) throw new Error("MAX_MARKET_STAKE_USDT must be positive");
  if (cfg.maxBatchStakeUsdt <= 0) throw new Error("MAX_BATCH_STAKE_USDT must be positive");
  if (cfg.maxOutcomesPerMarket <= 0) throw new Error("MAX_OUTCOMES_PER_MARKET must be positive");
  if (cfg.eventOutcomeCount <= 0) throw new Error("EVENT_OUTCOME_COUNT must be positive");
  if (cfg.stakeUsdt > cfg.maxStakeUsdt) {
    throw new Error(`STAKE_USDT ${cfg.stakeUsdt} exceeds MAX_STAKE_USDT ${cfg.maxStakeUsdt}`);
  }
  if (cfg.stakePerOutcomeUsdt > cfg.maxStakeUsdt) {
    throw new Error(`STAKE_PER_OUTCOME_USDT ${cfg.stakePerOutcomeUsdt} exceeds MAX_STAKE_USDT ${cfg.maxStakeUsdt}`);
  }
  if (cfg.slippageBps < 0 || cfg.slippageBps > 5000) {
    throw new Error("SLIPPAGE_BPS must be between 0 and 5000");
  }
  if (!["all", "lowest_odds"].includes(cfg.eventOutcomeSelection)) {
    throw new Error("EVENT_OUTCOME_SELECTION must be all or lowest_odds");
  }
  if (!["token_order", "error"].includes(cfg.eventOutcomeSelectionFallback)) {
    throw new Error("EVENT_OUTCOME_SELECTION_FALLBACK must be token_order or error");
  }
  if (!["fast", "quoted"].includes(cfg.eventBuyMode)) {
    throw new Error("EVENT_BUY_MODE must be fast or quoted");
  }
  if (!["ws", "chain", "rest"].includes(cfg.eventDiscovery)) {
    throw new Error("EVENT_DISCOVERY must be ws, chain, or rest");
  }
  if (cfg.restDiscoveryPollMs <= 0) {
    throw new Error("REST_DISCOVERY_POLL_MS must be positive");
  }
  if (!["next_batch", "upper_bound"].includes(cfg.watchFundingMode)) {
    throw new Error("WATCH_FUNDING_MODE must be next_batch or upper_bound");
  }
  if (cfg.fastGasLimit < 0) {
    throw new Error("FAST_GAS_LIMIT must be 0 or a positive integer");
  }
  if (cfg.bundleFastGasLimit < 0) {
    throw new Error("BUNDLE_FAST_GAS_LIMIT must be 0 or a positive integer");
  }
  if (cfg.preSignWindowMs < 0) {
    throw new Error("PRE_SIGN_WINDOW_MS must be 0 or a positive integer");
  }
  if (cfg.preSignRetryMs < 0) {
    throw new Error("PRE_SIGN_RETRY_MS must be 0 or a positive integer");
  }
  if (cfg.nonceSyncMinIntervalMs < 0) {
    throw new Error("NONCE_SYNC_MIN_INTERVAL_MS must be 0 or a positive integer");
  }
  if (cfg.receiptWatchTimeoutMs <= 0) {
    throw new Error("RECEIPT_WATCH_TIMEOUT_MS must be positive");
  }
  if (cfg.receiptWatchPollingMs <= 0) {
    throw new Error("RECEIPT_WATCH_POLLING_MS must be positive");
  }
  if (cfg.autoSellPollMs <= 0) {
    throw new Error("AUTO_SELL_POLL_MS must be positive");
  }
  if (cfg.autoSellProfitMultiplier <= 1) {
    throw new Error("AUTO_SELL_PROFIT_MULTIPLIER must be greater than 1");
  }
  if (cfg.autoSellPercent <= 0 || cfg.autoSellPercent > 100) {
    throw new Error("AUTO_SELL_PERCENT must be > 0 and <= 100");
  }
  if (cfg.autoSellPositionLimit <= 0) {
    throw new Error("AUTO_SELL_POSITION_LIMIT must be positive");
  }
  if (cfg.feishuAlertCooldownMs < 0) {
    throw new Error("FEISHU_ALERT_COOLDOWN_MS must be 0 or a positive integer");
  }
  if (cfg.executionRetryMs <= 0) {
    throw new Error("EXECUTION_RETRY_MS must be positive");
  }
  if (cfg.eventOpenWindowSeconds <= 0) {
    throw new Error("EVENT_OPEN_WINDOW_SECONDS must be positive");
  }
  if (cfg.logChunkBlocks < 0) {
    throw new Error("LOG_CHUNK_BLOCKS must be 0 or a positive integer");
  }
  if (cfg.broadcastTimeoutMs <= 0) {
    throw new Error("BROADCAST_TIMEOUT_MS must be positive");
  }
  if (cfg.rpcWarmupTimeoutMs <= 0) {
    throw new Error("RPC_WARMUP_TIMEOUT_MS must be positive");
  }
  if (cfg.pollMs <= 0) {
    throw new Error("POLL_MS must be positive");
  }
  if (cfg.hotPollMs <= 0) {
    throw new Error("HOT_POLL_MS must be positive");
  }
  if (cfg.preopenHotMs < 0) {
    throw new Error("PREOPEN_HOT_MS must be 0 or a positive integer");
  }
  if (cfg.prebroadcastMs < 0) {
    throw new Error("PREBROADCAST_MS must be 0 or a positive integer");
  }
  if (cfg.wsReceiptFallbackMs < 0) {
    throw new Error("WS_RECEIPT_FALLBACK_MS must be 0 or a positive integer");
  }
  if (cfg.wsReceiptFallbackRetries < 0) {
    throw new Error("WS_RECEIPT_FALLBACK_RETRIES must be 0 or a positive integer");
  }
  if (cfg.watchStartupRetryMs <= 0) {
    throw new Error("WATCH_STARTUP_RETRY_MS must be positive");
  }
  if (cfg.armFundingRetryMs <= 0) {
    throw new Error("ARM_FUNDING_RETRY_MS must be positive");
  }
  if (cfg.armFundingHotRetryMs <= 0) {
    throw new Error("ARM_FUNDING_HOT_RETRY_MS must be positive");
  }
  if (cfg.armFundingHotWindowMs < 0) {
    throw new Error("ARM_FUNDING_HOT_WINDOW_MS must be 0 or a positive integer");
  }
  if (cfg.armCatchUpWindowMs < 0) {
    throw new Error("ARM_CATCH_UP_WINDOW_MS must be 0 or a positive integer");
  }
  if (!["binance_volume_projection", "binance_price_projection", "cheapest", "configured"].includes(cfg.strategy)) {
    throw new Error("STRATEGY must be binance_volume_projection, binance_price_projection, cheapest, or configured");
  }
  if (cfg.strategy === "configured" && !cfg.targetOutcomeRegex) {
    throw new Error("configured strategy requires TARGET_OUTCOME_REGEX");
  }

  ensureParentDir(cfg.stateFile);
  ensureParentDir(cfg.fillsFile);
  return cfg;
}

function loadProviderEnv() {
  const file = path.join(process.env.HOME ?? "", ".codex/secrets/evm-rpc-providers.env");
  loadDotEnv(file);
}

function readKeychainPrivateKey() {
  if (process.platform !== "darwin" || envBool("DISABLE_KEYCHAIN_PRIVATE_KEY", false)) return "";
  const service = envString("PRIVATE_KEY_KEYCHAIN_SERVICE", "42space-event-bot-private-key");
  const account = envString("PRIVATE_KEY_KEYCHAIN_ACCOUNT", "42space");
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      service,
      "-w"
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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

export function loadSeen(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(readSeenArray(file));
}

export function saveSeen(file, seen) {
  ensureParentDir(file);
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const backup = `${file}.bak`;
  const body = `${JSON.stringify([...seen].sort(), null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
  }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function appendJsonl(file, row) {
  ensureParentDir(file);
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function readSeenArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const backup = `${file}.bak`;
    if (fs.existsSync(backup)) {
      const parsed = JSON.parse(fs.readFileSync(backup, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    }
    throw new Error(`Failed to load seen file ${file}: ${error.message}`);
  }
}

function envString(key, fallback) {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function envFirst(keys, fallback) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function envOptionalString(key, fallback) {
  const value = process.env[key];
  return value === undefined ? fallback : value;
}

function envNumber(key, fallback) {
  const raw = envString(key, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function envInteger(key, fallback) {
  const value = envNumber(key, fallback);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function envBool(key, fallback) {
  const raw = envString(key, fallback ? "1" : "0").toLowerCase();
  return ["1", "true", "yes", "y"].includes(raw);
}

function envRegex(key, fallback) {
  const raw = envString(key, fallback);
  return raw ? new RegExp(raw, "i") : null;
}

function envList(key, fallback) {
  const raw = envString(key, fallback);
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveBroadcastRpcUrls(primaryRpcUrl) {
  const explicit = envList("BROADCAST_RPC_URLS", "");
  const urls = explicit.length > 0
    ? explicit
    : [
        primaryRpcUrl,
        process.env.CHAINSTACK_BSC_RPC_URL,
        process.env.ANKR_BSC_RPC_URL
      ];
  return uniqueStrings(urls.filter(Boolean).filter((url) => /^https?:\/\//i.test(url)));
}

function uniqueStrings(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = String(item).trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function ensureParentDir(file) {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
}
