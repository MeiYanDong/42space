import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS,
  normalizeEventDisplayFilterRules
} from "./event-display-rules.js";

const MAX_AUTO_SELL_OPEN_EXIT_DELAY_SECONDS = 86400;

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

function normalizeProfileRole(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

export function readConfig() {
  loadDotEnv(".env.local");
  loadDotEnv();
  loadProviderEnv();
  const runtimeConfigFile = envString("RUNTIME_CONFIG_FILE", "data/runtime-config.json");
  const runtimeConfig = readRuntimeConfig(runtimeConfigFile);

  const cfg = {
    botName: envString("BOT_NAME", "42space"),
    profileRole: normalizeProfileRole(envString("EVENT_PROFILE_ROLE", envString("BOT_PROFILE_ROLE", ""))),
    runtimeConfigFile,
    runtimeConfig,
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
    marketQuestionAllowlistRegex: envRegex("MARKET_QUESTION_ALLOWLIST_REGEX", ""),
    marketBuyQuestionAllowlistRegex: envRegex(
      "MARKET_BUY_QUESTION_ALLOWLIST_REGEX",
      envString("EVENT_BUY_QUESTION_ALLOWLIST_REGEX", "")
    ),
    strategy: envString("STRATEGY", "binance_volume_projection"),
    stakeUsdt: envNumber("STAKE_USDT", 5),
    stakePerOutcomeUsdt: envNumber("STAKE_PER_OUTCOME_USDT", 5),
    maxStakeUsdt: envNumber("MAX_STAKE_USDT", 25),
    maxMarketStakeUsdt: envNumber("MAX_MARKET_STAKE_USDT", 25),
    maxBatchStakeUsdt: envNumber("MAX_BATCH_STAKE_USDT", 100),
    maxOutcomesPerMarket: envInteger("MAX_OUTCOMES_PER_MARKET", 12),
    eventOutcomeSelection: envString("EVENT_OUTCOME_SELECTION", "lowest_odds"),
    eventOutcomeNames: envString("EVENT_OUTCOME_NAMES", ""),
    eventOutcomeCount: envInteger("EVENT_OUTCOME_COUNT", 5),
    eventOutcomeSelectionFallback: envString("EVENT_OUTCOME_SELECTION_FALLBACK", "token_order"),
    eventBuyMode: envString("EVENT_BUY_MODE", "fast"),
    eventDiscovery: envString("EVENT_DISCOVERY", "ws"),
    eventDiscoveryFeedFile: envString("EVENT_DISCOVERY_FEED_FILE", ""),
    eventDiscoveryFeedPollMs: envInteger("EVENT_DISCOVERY_FEED_POLL_MS", 1000),
    eventDiscoveryFeedTailBytes: envInteger("EVENT_DISCOVERY_FEED_TAIL_BYTES", 2 * 1024 * 1024),
    memeRangeSelectionEnabled: envBool("MEME_RANGE_SELECTION_ENABLED", false),
    memeRangeSelectionFile: envString("MEME_RANGE_SELECTION_FILE", "output/meme-range-selection-locks.jsonl"),
    memeRangeSelectionOutcomeCount: envInteger("MEME_RANGE_SELECTION_OUTCOME_COUNT", 3),
    memeRangeSelectionFetchTimeoutMs: envInteger("MEME_RANGE_SELECTION_FETCH_TIMEOUT_MS", 2500),
    memeRangeSelectionFetchAttempts: envInteger("MEME_RANGE_SELECTION_FETCH_ATTEMPTS", 2),
    pythHermesUrl: envString("PYTH_HERMES_URL", "https://hermes.pyth.network"),
    pythApiKey: envString("PYTH_API_KEY", ""),
    pythMaxAgeSeconds: envInteger("PYTH_MAX_AGE_SECONDS", 120),
    restDiscoveryEnabled: envBool("REST_DISCOVERY_ENABLED", true),
    restDiscoveryPollMs: envInteger("REST_DISCOVERY_POLL_MS", 1000),
    watchFundingMode: envString("WATCH_FUNDING_MODE", "next_batch"),
    bundleDueMarkets: envBool("BUNDLE_DUE_MARKETS", true),
    eventMaxDueMarketsPerOpen: envInteger("EVENT_MAX_DUE_MARKETS_PER_OPEN", 0),
    eventPriceGateEnabled: envBool("EVENT_PRICE_GATE_ENABLED", false),
    eventPriceGateMaxEffectivePrice: envNumber("EVENT_PRICE_GATE_MAX_EFFECTIVE_PRICE", 0.0012),
    eventPriceGateRequire: envString("EVENT_PRICE_GATE_REQUIRE", "any"),
    eventPriceGateTimeoutMs: envInteger("EVENT_PRICE_GATE_TIMEOUT_MS", 1000),
    bot3FifaExactScoreAutoBuyEnabled: envBool("BOT3_FIFA_EXACT_SCORE_AUTO_BUY_ENABLED", false),
    bot3FifaExactScoreAutoStakeUsdt: envNumber("BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT", 1),
    eventIntelBuyFilter: envString("EVENT_INTEL_BUY_FILTER", "off").toLowerCase(),
    eventIntelBuyFile: envString("EVENT_INTEL_BUY_FILE", envString("EVENT_INTEL_FILE", "output/event-intel.jsonl")),
    eventDisplayFilterRules: normalizeEventDisplayFilterRules(
      envOptionalString("EVENT_DISPLAY_FILTER_RULES", undefined),
      { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS }
    ),
    eventDisplayIncludeRules: normalizeEventDisplayFilterRules(
      envOptionalString("EVENT_DISPLAY_INCLUDE_RULES", undefined),
      { fallback: [] }
    ),
    fastSkipPreflight: envBool("FAST_SKIP_PREFLIGHT", true),
    fastSkipDueRestHydration: envBool("FAST_SKIP_DUE_REST_HYDRATION", true),
    fastNonceManager: envBool("FAST_NONCE_MANAGER", true),
    preSignFastTx: envBool("PRE_SIGN_FAST_TX", true),
    preSignWindowMs: envInteger("PRE_SIGN_WINDOW_MS", 60000),
    preSignRetryMs: envInteger("PRE_SIGN_RETRY_MS", 250),
    nonceSyncBeforePreSign: envBool("NONCE_SYNC_BEFORE_PRESIGN", true),
    nonceSyncMinIntervalMs: envInteger("NONCE_SYNC_MIN_INTERVAL_MS", 250),
    waitForReceipt: envBool("WAIT_FOR_RECEIPT", false),
    asyncReceiptWatch: envBool("ASYNC_RECEIPT_WATCH", true),
    receiptWatchTimeoutMs: envInteger("RECEIPT_WATCH_TIMEOUT_MS", 120000),
    receiptWatchPollingMs: envInteger("RECEIPT_WATCH_POLLING_MS", 1000),
    executionRetryMs: envInteger("EXECUTION_RETRY_MS", 500),
    eventOpenWindowSeconds: envInteger("EVENT_OPEN_WINDOW_SECONDS", 5),
    fanoutBroadcast: envBool("FANOUT_BROADCAST", true),
    broadcastRpcUrls: [],
    broadcastTimeoutMs: envInteger("BROADCAST_TIMEOUT_MS", 1200),
    builderBundleKillSwitch: envBool("BUILDER_BUNDLE_KILL_SWITCH", false),
    builderBundleEnabled: envBool("BUILDER_BUNDLE_ENABLED", false),
    builderBundleUrl: envString("BUILDER_BUNDLE_URL", "https://puissant-builder.48.club/"),
    builderBundleTipTo: envString("BUILDER_BUNDLE_TIP_TO", "0x4848489f0b2BEdd788c696e2D79b6b69D7484848"),
    builderBundleTipBnb: envString("BUILDER_BUNDLE_TIP_BNB", "0.001"),
    builderBundleTipGasPriceGwei: envString("BUILDER_BUNDLE_TIP_GAS_PRICE_GWEI", "1"),
    builderBundleMaxBlocks: envInteger("BUILDER_BUNDLE_MAX_BLOCKS", 3),
    builderBundleMaxBlockLookup: envBool("BUILDER_BUNDLE_MAX_BLOCK_LOOKUP", false),
    builderBundleMaxTimestampOffsetSeconds: envInteger("BUILDER_BUNDLE_MAX_TIMESTAMP_OFFSET_SECONDS", 10),
    builderBundleTimeoutMs: envInteger("BUILDER_BUNDLE_TIMEOUT_MS", 500),
    builderBundleMode: envString("BUILDER_BUNDLE_MODE", "concurrent").trim().toLowerCase().replace(/[-\s]+/gu, "_"),
    builderBundleFanoutDelayMs: envInteger("BUILDER_BUNDLE_FANOUT_DELAY_MS", 120),
    builderBundleTimingMode: envString("BUILDER_BUNDLE_TIMING_MODE", "legacy").trim().toLowerCase().replace(/[-\s]+/gu, "_"),
    builderBundlePrepositionLeadMs: envInteger("BUILDER_BUNDLE_PREPOSITION_LEAD_MS", 300),
    builderBundleFallbackSafetyMs: envInteger("BUILDER_BUNDLE_FALLBACK_SAFETY_MS", 100),
    builderBundleEarlySubmitLeadMs: envInteger("BUILDER_BUNDLE_EARLY_SUBMIT_LEAD_MS", 0),
    builderBundleMinTimestampOffsetMs: envInteger("BUILDER_BUNDLE_MIN_TIMESTAMP_OFFSET_MS", 0),
    builderBundleNoMerge: envBool("BUILDER_BUNDLE_NO_MERGE", false),
    builderBundlePositionFirst: envBool("BUILDER_BUNDLE_POSITION_FIRST", false),
    builderBundle48spSign: envString("BUILDER_BUNDLE_48SP_SIGN", ""),
    blockrazorBuilderEnabled: envBool("BLOCKRAZOR_BUILDER_ENABLED", false),
    blockrazorBuilderUrl: envString("BLOCKRAZOR_BUILDER_URL", "https://rpc.blockrazor.builders"),
    blockrazorBuilderTipTo: envString("BLOCKRAZOR_BUILDER_TIP_TO", "0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20"),
    blockrazorBuilderAuthToken: envString("BLOCKRAZOR_BUILDER_AUTH_TOKEN", ""),
    builderTimedBuyExecutorEnabled: envBool("BUILDER_TIMED_BUY_EXECUTOR_ENABLED", false),
    builderTimedBuyExecutorAddress: envString("BUILDER_TIMED_BUY_EXECUTOR_ADDRESS", ""),
    builderTimedBuyExecutorExactSecond: envBool("BUILDER_TIMED_BUY_EXECUTOR_EXACT_SECOND", false),
    builderTimedBuyExecutorReleasePollMs: envInteger("BUILDER_TIMED_BUY_EXECUTOR_RELEASE_POLL_MS", 25),
    builderTimestampGuardEnabled: envBool("BUILDER_TIMESTAMP_GUARD_ENABLED", false),
    builderTimestampGuardAddress: envString("BUILDER_TIMESTAMP_GUARD_ADDRESS", ""),
    builderTimestampGuardGasLimit: envInteger("BUILDER_TIMESTAMP_GUARD_GAS_LIMIT", 50000),
    builderTimestampGuardRetryIntervalMs: envInteger("BUILDER_TIMESTAMP_GUARD_RETRY_INTERVAL_MS", 100),
    builderTimestampGuardRetryUntilLeadMs: envInteger("BUILDER_TIMESTAMP_GUARD_RETRY_UNTIL_LEAD_MS", 0),
    builderTimestampGuardReleasePollMs: envInteger("BUILDER_TIMESTAMP_GUARD_RELEASE_POLL_MS", 50),
    rpcKeepaliveMs: envInteger("RPC_KEEPALIVE_MS", 5000),
    rebroadcastIntervalMs: envInteger("REBROADCAST_INTERVAL_MS", 100),
    rebroadcastDurationMs: envInteger("REBROADCAST_DURATION_MS", 2500),
    rpcWarmupTimeoutMs: envInteger("RPC_WARMUP_TIMEOUT_MS", 2500),
    doctorCheckWs: envBool("DOCTOR_CHECK_WS", false),
    gasPriceGwei: envString("GAS_PRICE_GWEI", "2.0"),
    fastGasLimit: envInteger("FAST_GAS_LIMIT", 8000000),
    bundleFastGasLimit: envInteger("BUNDLE_FAST_GAS_LIMIT", 20000000),
    fastGasWalletBudget: envBool("FAST_GAS_WALLET_BUDGET", true),
    fastGasWalletBudgetBps: envInteger("FAST_GAS_WALLET_BUDGET_BPS", 10000),
    fastGasBlockLimitBps: envInteger("FAST_GAS_BLOCK_LIMIT_BPS", 10000),
    fastGasTxLimit: envInteger("FAST_GAS_TX_LIMIT", 16777216),
    logChunkBlocks: envInteger("LOG_CHUNK_BLOCKS", 5000),
    watchScanLimit: envInteger("WATCH_SCAN_LIMIT", 500),
    eventLogLookbackBlocks: envInteger("EVENT_LOG_LOOKBACK_BLOCKS", 50000),
    replayLookbackBlocks: envInteger("REPLAY_LOOKBACK_BLOCKS", 50000),
    marketCategoryAllowlist: envList("MARKET_CATEGORY_ALLOWLIST", ""),
    marketCategoryBlocklist: envList("MARKET_CATEGORY_BLOCKLIST", "Price"),
    marketTagBlocklist: envList("MARKET_TAG_BLOCKLIST", "8 hour,automated"),
    minEventDurationHours: envNumber("MIN_EVENT_DURATION_HOURS", 48),
    minMarketCreatedAt: envString("MIN_MARKET_CREATED_AT", ""),
    watchBuyExisting: envBool("WATCH_BUY_EXISTING", false),
    slippageBps: envInteger("SLIPPAGE_BPS", 800),
    pollMs: envInteger("POLL_MS", 500),
    hotPollMs: envInteger("HOT_POLL_MS", 25),
    preopenHotMs: envInteger("PREOPEN_HOT_MS", 60000),
    prebroadcastMs: envInteger("PREBROADCAST_MS", 750),
    allowPreopenBroadcast: envBool("ALLOW_PREOPEN_BROADCAST", false),
    openBroadcastMode: envString("OPEN_BROADCAST_MODE", "fixed").trim().toLowerCase(),
    openBroadcastDelayMs: envInteger("OPEN_BROADCAST_DELAY_MS", 0),
    openBroadcastScheduleAheadMs: envInteger("OPEN_BROADCAST_SCHEDULE_AHEAD_MS", 60000),
    openBroadcastSpinMs: envInteger("OPEN_BROADCAST_SPIN_MS", 15),
    openBroadcastBlockTargetOffsetMs: envInteger("OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS", 20000),
    openBroadcastBlockAwareLeadMs: envInteger("OPEN_BROADCAST_BLOCK_AWARE_LEAD_MS", 95),
    openBroadcastBlockAwareMaxWaitMs: envInteger("OPEN_BROADCAST_BLOCK_AWARE_MAX_WAIT_MS", 250),
    openBroadcastBlockAwarePreTargetCount: envInteger("OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_COUNT", 2),
    openBroadcastBlockAwarePreTargetSendMs: envInteger("OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_SEND_MS", 120),
    openBroadcastBlockAwareHeadMaxAgeMs: envInteger("OPEN_BROADCAST_BLOCK_AWARE_HEAD_MAX_AGE_MS", 2000),
    wsReceiptFallbackMs: envInteger("WS_RECEIPT_FALLBACK_MS", 0),
    wsReceiptFallbackRetries: envInteger("WS_RECEIPT_FALLBACK_RETRIES", 3),
    watchStartupRetryMs: envInteger("WATCH_STARTUP_RETRY_MS", 5000),
    armWaitForFunding: envBool("ARM_WAIT_FOR_FUNDING", false),
    armFundingRetryMs: envInteger("ARM_FUNDING_RETRY_MS", 60000),
    armFundingHotRetryMs: envInteger("ARM_FUNDING_HOT_RETRY_MS", 1000),
    armFundingHotWindowMs: envInteger("ARM_FUNDING_HOT_WINDOW_MS", 600000),
    armFundingNotifyWindowMs: envInteger("ARM_FUNDING_NOTIFY_WINDOW_MS", 30 * 60 * 1000),
    armCatchUpAfterFunding: envBool("ARM_CATCH_UP_AFTER_FUNDING", true),
    armCatchUpWindowMs: envInteger("ARM_CATCH_UP_WINDOW_MS", 45000),
    autoApproveRouterOnStart: envBool("AUTO_APPROVE_ROUTER_ON_START", true),
    feishuAlertsEnabled: envBool("FEISHU_ALERTS_ENABLED", true),
    feishuWebhook: envString("FEISHU_WEBHOOK", ""),
    feishuAlertCooldownMs: envInteger("FEISHU_ALERT_COOLDOWN_MS", 60000),
    alertStateFile: envString("ALERT_STATE_FILE", path.join(path.dirname(runtimeConfigFile), "alert-state.json")),
    runtimeHealthFile: envString("EVENT_RUNTIME_HEALTH_FILE", path.join(path.dirname(runtimeConfigFile), "runtime-health.json")),
    eventPlannedBuysFile: envString("EVENT_PLANNED_BUYS_FILE", path.join(path.dirname(runtimeConfigFile), "planned-buys.json")),
    autoSellEnabled: envBool("AUTO_SELL_ENABLED", true),
    autoSellPollMs: envInteger("AUTO_SELL_POLL_MS", 5000),
    autoSellStrategy: envString("AUTO_SELL_STRATEGY", "ladder"),
    autoSellStartDelaySeconds: envInteger("AUTO_SELL_START_DELAY_SECONDS", 10),
    autoSellIntervalSeconds: envInteger("AUTO_SELL_INTERVAL_SECONDS", 10),
    autoSellChunkPercent: envNumber("AUTO_SELL_CHUNK_PERCENT", 10),
    autoSellLadderProfitPercent: envNumber("AUTO_SELL_LADDER_PROFIT_PERCENT", 0),
    autoSellOpenExitDelaySeconds: envInteger("AUTO_SELL_OPEN_EXIT_DELAY_SECONDS", 36),
    autoSellOpenExitPercent: envNumber("AUTO_SELL_OPEN_EXIT_PERCENT", 100),
    autoSellFastOpenExitEnabled: envBool("AUTO_SELL_FAST_OPEN_EXIT_ENABLED", false),
    autoSellFastOpenExitMinDelayMs: envInteger("AUTO_SELL_FAST_OPEN_EXIT_MIN_DELAY_MS", 24500),
    autoSellFastOpenExitMaxDelayMs: envInteger("AUTO_SELL_FAST_OPEN_EXIT_MAX_DELAY_MS", 26000),
    autoSellFastOpenExitMonitorPauseMs: envInteger("AUTO_SELL_FAST_OPEN_EXIT_MONITOR_PAUSE_MS", 45000),
    autoSellTakeProfitSteps: envInteger("AUTO_SELL_TAKE_PROFIT_STEPS", 0),
    autoSellBeforeMarketStartSeconds: envInteger("AUTO_SELL_BEFORE_MARKET_START_SECONDS", 0),
    autoSellMarketStartEndOffsetSeconds: envInteger("AUTO_SELL_MARKET_START_END_OFFSET_SECONDS", 0),
    autoSellGasPriceGwei: envString("AUTO_SELL_GAS_PRICE_GWEI", ""),
    autoSellApplyAfterIso: envString("AUTO_SELL_APPLY_AFTER_ISO", ""),
    autoSellProfitMultiplier: envNumber("AUTO_SELL_PROFIT_MULTIPLIER", 2),
    autoSellPercent: envNumber("AUTO_SELL_PERCENT", 50),
    autoSellStopLossEnabled: envBool("AUTO_SELL_STOP_LOSS_ENABLED", true),
    autoSellStopLossPercent: envNumber("AUTO_SELL_STOP_LOSS_PERCENT", 10),
    autoSellStopLossSellPercent: envNumber("AUTO_SELL_STOP_LOSS_SELL_PERCENT", 100),
    autoSellPositionLimit: envInteger("AUTO_SELL_POSITION_LIMIT", 500),
    autoSellStateFile: envString("AUTO_SELL_STATE_FILE", "data/auto-sell-seen.json"),
    autoSellPositionStateFile: envString("AUTO_SELL_POSITION_STATE_FILE", "data/auto-sell-positions.json"),
    autoSellCircuitStateFile: envString("AUTO_SELL_CIRCUIT_STATE_FILE", "data/auto-sell-circuit.json"),
    autoSellBuyGuardBeforeMs: envInteger("AUTO_SELL_BUY_GUARD_BEFORE_MS", 120000),
    autoSellBuyGuardAfterMs: envInteger("AUTO_SELL_BUY_GUARD_AFTER_MS", 10000),
    autoSellPreapproveOperator: envBool("AUTO_SELL_PREAPPROVE_OPERATOR", true),
    autoSellApprovalsPerTick: envInteger("AUTO_SELL_APPROVALS_PER_TICK", 1),
    autoSellRequirePreapprovedOperator: envBool("AUTO_SELL_REQUIRE_PREAPPROVED_OPERATOR", true),
    autoSellMaxOutcomesPerTx: envInteger("AUTO_SELL_MAX_OUTCOMES_PER_TX", 8),
    autoSellMaxMarketsPerTx: envInteger("AUTO_SELL_MAX_MARKETS_PER_TX", 4),
    autoSellMaxGasPerTx: envInteger("AUTO_SELL_MAX_GAS_PER_TX", 12000000),
    autoSellMaxTxPerTick: envInteger("AUTO_SELL_MAX_TX_PER_TICK", 1),
    autoSellMinBnbReserve: envNumber("AUTO_SELL_MIN_BNB_RESERVE", 0.003),
    autoSellFailureCooldownMs: envInteger("AUTO_SELL_FAILURE_COOLDOWN_MS", 3600000),
    autoSellMaxConsecutiveFailures: envInteger("AUTO_SELL_MAX_CONSECUTIVE_FAILURES", 2),
    autoSellCircuitBreakerEnabled: envBool("AUTO_SELL_CIRCUIT_BREAKER_ENABLED", true),
    autoSellCircuitFailureLimit: envInteger("AUTO_SELL_CIRCUIT_FAILURE_LIMIT", 2),
    autoSellCircuitWindowMs: envInteger("AUTO_SELL_CIRCUIT_WINDOW_MS", 600000),
    autoSellCircuitPauseMs: envInteger("AUTO_SELL_CIRCUIT_PAUSE_MS", 3600000),
    autoSellErrorMessageMaxChars: envInteger("AUTO_SELL_ERROR_MESSAGE_MAX_CHARS", 500),
    autoSellAlertCooldownMs: envInteger("AUTO_SELL_ALERT_COOLDOWN_MS", 3600000),
    autoSellEligibleTailBytes: envInteger("AUTO_SELL_ELIGIBLE_TAIL_BYTES", 4194304),
    scanLimit: envInteger("SCAN_LIMIT", 10),
    openWindowSeconds: envInteger("OPEN_WINDOW_SECONDS", 45),
    lookaheadSeconds: envInteger("LOOKAHEAD_SECONDS", 900),
    allowLateBuy: envBool("ALLOW_LATE_BUY", false),
    stateFile: envString("STATE_FILE", "data/seen-markets.json"),
    fillsFile: envString("FILLS_FILE", "data/fills.jsonl"),
    gasLedgerFile: envString("GAS_LEDGER_FILE", path.join(path.dirname(runtimeConfigFile), "gas-ledger.jsonl")),
    decisionFile: envString("MARKET_DECISIONS_FILE", "data/market-decisions.jsonl"),
    marketFollowFile: envString("MARKET_FOLLOW_FILE", path.join(path.dirname(runtimeConfigFile), "market-follow.json"))
  };
  applyRuntimeConfig(cfg, runtimeConfig);
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
  if (!["all", "lowest_odds", "middle", "first", "names"].includes(cfg.eventOutcomeSelection)) {
    throw new Error("EVENT_OUTCOME_SELECTION must be all, lowest_odds, middle, first, or names");
  }
  if (!["token_order", "error"].includes(cfg.eventOutcomeSelectionFallback)) {
    throw new Error("EVENT_OUTCOME_SELECTION_FALLBACK must be token_order or error");
  }
  if (!["fast", "quoted"].includes(cfg.eventBuyMode)) {
    throw new Error("EVENT_BUY_MODE must be fast or quoted");
  }
  if (!["ws", "chain", "rest", "feed"].includes(cfg.eventDiscovery)) {
    throw new Error("EVENT_DISCOVERY must be ws, chain, rest, or feed");
  }
  if (cfg.profileRole && !["bot2_like", "bot3_like"].includes(cfg.profileRole)) {
    throw new Error("EVENT_PROFILE_ROLE must be empty, bot2_like, or bot3_like");
  }
  if (cfg.eventDiscovery === "feed" && !cfg.eventDiscoveryFeedFile) {
    throw new Error("EVENT_DISCOVERY=feed requires EVENT_DISCOVERY_FEED_FILE");
  }
  if (cfg.eventDiscoveryFeedPollMs <= 0) {
    throw new Error("EVENT_DISCOVERY_FEED_POLL_MS must be positive");
  }
  if (cfg.eventDiscoveryFeedTailBytes < 0) {
    throw new Error("EVENT_DISCOVERY_FEED_TAIL_BYTES must be 0 or a positive integer");
  }
  if (cfg.memeRangeSelectionFetchTimeoutMs <= 0) {
    throw new Error("MEME_RANGE_SELECTION_FETCH_TIMEOUT_MS must be positive");
  }
  if (cfg.memeRangeSelectionOutcomeCount <= 0 || cfg.memeRangeSelectionOutcomeCount % 2 === 0) {
    throw new Error("MEME_RANGE_SELECTION_OUTCOME_COUNT must be a positive odd integer");
  }
  if (cfg.memeRangeSelectionOutcomeCount > cfg.maxOutcomesPerMarket) {
    throw new Error("MEME_RANGE_SELECTION_OUTCOME_COUNT exceeds MAX_OUTCOMES_PER_MARKET");
  }
  if (cfg.memeRangeSelectionFetchAttempts <= 0) {
    throw new Error("MEME_RANGE_SELECTION_FETCH_ATTEMPTS must be positive");
  }
  if (cfg.pythMaxAgeSeconds <= 0) {
    throw new Error("PYTH_MAX_AGE_SECONDS must be positive");
  }
  if (cfg.restDiscoveryPollMs <= 0) {
    throw new Error("REST_DISCOVERY_POLL_MS must be positive");
  }
  if (!["next_batch", "upper_bound"].includes(cfg.watchFundingMode)) {
    throw new Error("WATCH_FUNDING_MODE must be next_batch or upper_bound");
  }
  if (cfg.eventMaxDueMarketsPerOpen < 0) {
    throw new Error("EVENT_MAX_DUE_MARKETS_PER_OPEN must be 0 or a positive integer");
  }
  if (cfg.eventPriceGateEnabled && cfg.bundleDueMarkets) {
    throw new Error("EVENT_PRICE_GATE_ENABLED requires BUNDLE_DUE_MARKETS=0");
  }
  if (cfg.eventPriceGateEnabled && cfg.eventPriceGateMaxEffectivePrice <= 0) {
    throw new Error("EVENT_PRICE_GATE_MAX_EFFECTIVE_PRICE must be positive when EVENT_PRICE_GATE_ENABLED=1");
  }
  if (!["any", "all"].includes(cfg.eventPriceGateRequire)) {
    throw new Error("EVENT_PRICE_GATE_REQUIRE must be any or all");
  }
  if (cfg.eventPriceGateTimeoutMs <= 0) {
    throw new Error("EVENT_PRICE_GATE_TIMEOUT_MS must be positive");
  }
  if (cfg.bot3FifaExactScoreAutoStakeUsdt <= 0) {
    throw new Error("BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT must be positive");
  }
  if (cfg.bot3FifaExactScoreAutoStakeUsdt > cfg.maxStakeUsdt) {
    throw new Error("BOT3_FIFA_EXACT_SCORE_AUTO_STAKE_USDT exceeds MAX_STAKE_USDT");
  }
  if (!["off", "strong"].includes(cfg.eventIntelBuyFilter)) {
    throw new Error("EVENT_INTEL_BUY_FILTER must be off or strong");
  }
  if (cfg.fastGasLimit < 0) {
    throw new Error("FAST_GAS_LIMIT must be 0 or a positive integer");
  }
  if (cfg.bundleFastGasLimit < 0) {
    throw new Error("BUNDLE_FAST_GAS_LIMIT must be 0 or a positive integer");
  }
  if (cfg.fastGasWalletBudgetBps <= 0 || cfg.fastGasWalletBudgetBps > 10000) {
    throw new Error("FAST_GAS_WALLET_BUDGET_BPS must be > 0 and <= 10000");
  }
  if (cfg.fastGasBlockLimitBps <= 0 || cfg.fastGasBlockLimitBps > 10000) {
    throw new Error("FAST_GAS_BLOCK_LIMIT_BPS must be > 0 and <= 10000");
  }
  if (cfg.fastGasTxLimit <= 0) {
    throw new Error("FAST_GAS_TX_LIMIT must be positive");
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
  if (!["ladder", "open_timed_exit", "pre_start_exit", "legacy"].includes(cfg.autoSellStrategy)) {
    throw new Error("AUTO_SELL_STRATEGY must be ladder, open_timed_exit, pre_start_exit, or legacy");
  }
  if (cfg.autoSellStartDelaySeconds < 0) {
    throw new Error("AUTO_SELL_START_DELAY_SECONDS must be 0 or a positive integer");
  }
  if (cfg.autoSellIntervalSeconds <= 0) {
    throw new Error("AUTO_SELL_INTERVAL_SECONDS must be positive");
  }
  if (cfg.autoSellChunkPercent <= 0 || cfg.autoSellChunkPercent > 100) {
    throw new Error("AUTO_SELL_CHUNK_PERCENT must be > 0 and <= 100");
  }
  if (cfg.autoSellLadderProfitPercent < 0) {
    throw new Error("AUTO_SELL_LADDER_PROFIT_PERCENT must be 0 or a positive number");
  }
  if (cfg.autoSellOpenExitDelaySeconds < 0) {
    throw new Error("AUTO_SELL_OPEN_EXIT_DELAY_SECONDS must be 0 or a positive integer");
  }
  if (cfg.autoSellOpenExitPercent <= 0 || cfg.autoSellOpenExitPercent > 100) {
    throw new Error("AUTO_SELL_OPEN_EXIT_PERCENT must be > 0 and <= 100");
  }
  if (cfg.autoSellFastOpenExitMinDelayMs < 0 || cfg.autoSellFastOpenExitMaxDelayMs < 0) {
    throw new Error("AUTO_SELL_FAST_OPEN_EXIT delay range must be 0 or positive");
  }
  if (cfg.autoSellFastOpenExitMaxDelayMs < cfg.autoSellFastOpenExitMinDelayMs) {
    throw new Error("AUTO_SELL_FAST_OPEN_EXIT_MAX_DELAY_MS must be >= AUTO_SELL_FAST_OPEN_EXIT_MIN_DELAY_MS");
  }
  if (cfg.autoSellFastOpenExitMonitorPauseMs < 0) {
    throw new Error("AUTO_SELL_FAST_OPEN_EXIT_MONITOR_PAUSE_MS must be 0 or a positive integer");
  }
  if (cfg.autoSellTakeProfitSteps < 0) {
    throw new Error("AUTO_SELL_TAKE_PROFIT_STEPS must be 0 or a positive integer");
  }
  if (cfg.autoSellBeforeMarketStartSeconds < 0) {
    throw new Error("AUTO_SELL_BEFORE_MARKET_START_SECONDS must be 0 or a positive integer");
  }
  if (cfg.autoSellMarketStartEndOffsetSeconds < 0) {
    throw new Error("AUTO_SELL_MARKET_START_END_OFFSET_SECONDS must be 0 or a positive integer");
  }
  if (cfg.autoSellGasPriceGwei) {
    const gasPrice = Number(cfg.autoSellGasPriceGwei);
    if (!Number.isFinite(gasPrice) || gasPrice < 0.01 || gasPrice > 50) {
      throw new Error("AUTO_SELL_GAS_PRICE_GWEI must be between 0.01 and 50");
    }
  }
  if (cfg.autoSellProfitMultiplier <= 1) {
    throw new Error("AUTO_SELL_PROFIT_MULTIPLIER must be greater than 1");
  }
  if (cfg.autoSellPercent <= 0 || cfg.autoSellPercent > 100) {
    throw new Error("AUTO_SELL_PERCENT must be > 0 and <= 100");
  }
  if (cfg.autoSellStopLossPercent <= 0 || cfg.autoSellStopLossPercent > 100) {
    throw new Error("AUTO_SELL_STOP_LOSS_PERCENT must be > 0 and <= 100");
  }
  if (cfg.autoSellStopLossSellPercent <= 0 || cfg.autoSellStopLossSellPercent > 100) {
    throw new Error("AUTO_SELL_STOP_LOSS_SELL_PERCENT must be > 0 and <= 100");
  }
  if (cfg.autoSellPositionLimit <= 0) {
    throw new Error("AUTO_SELL_POSITION_LIMIT must be positive");
  }
  if (cfg.autoSellBuyGuardBeforeMs < 0) {
    throw new Error("AUTO_SELL_BUY_GUARD_BEFORE_MS must be 0 or a positive integer");
  }
  if (cfg.autoSellBuyGuardAfterMs < 0) {
    throw new Error("AUTO_SELL_BUY_GUARD_AFTER_MS must be 0 or a positive integer");
  }
  if (cfg.autoSellApprovalsPerTick < 0) {
    throw new Error("AUTO_SELL_APPROVALS_PER_TICK must be 0 or a positive integer");
  }
  if (cfg.autoSellMaxOutcomesPerTx <= 0) {
    throw new Error("AUTO_SELL_MAX_OUTCOMES_PER_TX must be positive");
  }
  if (cfg.autoSellMaxMarketsPerTx <= 0) {
    throw new Error("AUTO_SELL_MAX_MARKETS_PER_TX must be positive");
  }
  if (cfg.autoSellMaxGasPerTx <= 0) {
    throw new Error("AUTO_SELL_MAX_GAS_PER_TX must be positive");
  }
  if (cfg.autoSellMaxTxPerTick <= 0) {
    throw new Error("AUTO_SELL_MAX_TX_PER_TICK must be positive");
  }
  if (cfg.autoSellMinBnbReserve < 0) {
    throw new Error("AUTO_SELL_MIN_BNB_RESERVE must be 0 or a positive number");
  }
  if (cfg.autoSellFailureCooldownMs < 0) {
    throw new Error("AUTO_SELL_FAILURE_COOLDOWN_MS must be 0 or a positive integer");
  }
  if (cfg.autoSellMaxConsecutiveFailures <= 0) {
    throw new Error("AUTO_SELL_MAX_CONSECUTIVE_FAILURES must be positive");
  }
  if (cfg.autoSellCircuitFailureLimit <= 0) {
    throw new Error("AUTO_SELL_CIRCUIT_FAILURE_LIMIT must be positive");
  }
  if (cfg.autoSellCircuitWindowMs <= 0) {
    throw new Error("AUTO_SELL_CIRCUIT_WINDOW_MS must be positive");
  }
  if (cfg.autoSellCircuitPauseMs < 0) {
    throw new Error("AUTO_SELL_CIRCUIT_PAUSE_MS must be 0 or a positive integer");
  }
  if (cfg.autoSellErrorMessageMaxChars <= 0) {
    throw new Error("AUTO_SELL_ERROR_MESSAGE_MAX_CHARS must be positive");
  }
  if (cfg.autoSellAlertCooldownMs < 0) {
    throw new Error("AUTO_SELL_ALERT_COOLDOWN_MS must be 0 or a positive integer");
  }
  if (cfg.autoSellEligibleTailBytes <= 0) {
    throw new Error("AUTO_SELL_ELIGIBLE_TAIL_BYTES must be positive");
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
  if (cfg.minEventDurationHours < 0) {
    throw new Error("MIN_EVENT_DURATION_HOURS must be 0 or a positive number");
  }
  if (cfg.broadcastTimeoutMs <= 0) {
    throw new Error("BROADCAST_TIMEOUT_MS must be positive");
  }
  if (cfg.builderBundleEnabled) {
    if (!/^https?:\/\//iu.test(String(cfg.builderBundleUrl ?? ""))) {
      throw new Error("BUILDER_BUNDLE_URL must be an HTTP(S) URL when BUILDER_BUNDLE_ENABLED=1");
    }
    try {
      new URL(cfg.builderBundleUrl);
    } catch {
      throw new Error("BUILDER_BUNDLE_URL must be a valid URL when BUILDER_BUNDLE_ENABLED=1");
    }
    if (!/^0x[a-fA-F0-9]{40}$/u.test(String(cfg.builderBundleTipTo ?? ""))) {
      throw new Error("BUILDER_BUNDLE_TIP_TO must be a valid address when BUILDER_BUNDLE_ENABLED=1");
    }
    if (cfg.blockrazorBuilderEnabled) {
      try {
        new URL(cfg.blockrazorBuilderUrl);
      } catch {
        throw new Error("BLOCKRAZOR_BUILDER_URL must be a valid URL when BLOCKRAZOR_BUILDER_ENABLED=1");
      }
      if (!/^https?:\/\//iu.test(String(cfg.blockrazorBuilderUrl ?? ""))) {
        throw new Error("BLOCKRAZOR_BUILDER_URL must be an HTTP(S) URL when BLOCKRAZOR_BUILDER_ENABLED=1");
      }
      if (!/^0x[a-fA-F0-9]{40}$/u.test(String(cfg.blockrazorBuilderTipTo ?? ""))) {
        throw new Error("BLOCKRAZOR_BUILDER_TIP_TO must be a valid address when BLOCKRAZOR_BUILDER_ENABLED=1");
      }
    }
  }
  const builderTipBnb = Number(cfg.builderBundleTipBnb);
  if (!Number.isFinite(builderTipBnb) || builderTipBnb < 0 || builderTipBnb > 10) {
    throw new Error("BUILDER_BUNDLE_TIP_BNB must be between 0 and 10");
  }
  const builderTipGasGwei = Number(cfg.builderBundleTipGasPriceGwei);
  if (!Number.isFinite(builderTipGasGwei) || builderTipGasGwei < 0.01 || builderTipGasGwei > 50) {
    throw new Error("BUILDER_BUNDLE_TIP_GAS_PRICE_GWEI must be between 0.01 and 50");
  }
  if (cfg.builderBundleMaxBlocks <= 0) {
    throw new Error("BUILDER_BUNDLE_MAX_BLOCKS must be positive");
  }
  if (cfg.builderBundleMaxTimestampOffsetSeconds <= 0) {
    throw new Error("BUILDER_BUNDLE_MAX_TIMESTAMP_OFFSET_SECONDS must be positive");
  }
  if (cfg.builderBundleTimeoutMs <= 0) {
    throw new Error("BUILDER_BUNDLE_TIMEOUT_MS must be positive");
  }
  if (!["concurrent", "builder_only", "builder_then_fanout"].includes(cfg.builderBundleMode)) {
    throw new Error("BUILDER_BUNDLE_MODE must be concurrent, builder_only, or builder_then_fanout");
  }
  if (cfg.builderBundleFanoutDelayMs < 0 || cfg.builderBundleFanoutDelayMs > 5000) {
    throw new Error("BUILDER_BUNDLE_FANOUT_DELAY_MS must be between 0 and 5000");
  }
  if (!["legacy", "auto", "first_19s_block", "first_20s_block"].includes(cfg.builderBundleTimingMode)) {
    throw new Error("BUILDER_BUNDLE_TIMING_MODE must be legacy, auto, first_19s_block, or first_20s_block");
  }
  if (cfg.builderBundlePrepositionLeadMs <= 0 || cfg.builderBundlePrepositionLeadMs > 5000) {
    throw new Error("BUILDER_BUNDLE_PREPOSITION_LEAD_MS must be between 1 and 5000");
  }
  if (cfg.builderBundleFallbackSafetyMs < 0 || cfg.builderBundleFallbackSafetyMs > 5000) {
    throw new Error("BUILDER_BUNDLE_FALLBACK_SAFETY_MS must be between 0 and 5000");
  }
  if (cfg.builderBundleEarlySubmitLeadMs < 0 || cfg.builderBundleEarlySubmitLeadMs > 5000) {
    throw new Error("BUILDER_BUNDLE_EARLY_SUBMIT_LEAD_MS must be between 0 and 5000");
  }
  if (cfg.builderBundleMinTimestampOffsetMs < 0 || cfg.builderBundleMinTimestampOffsetMs > 24 * 60 * 60 * 1000) {
    throw new Error("BUILDER_BUNDLE_MIN_TIMESTAMP_OFFSET_MS must be between 0 and 86400000");
  }
  if (
    cfg.builderTimedBuyExecutorEnabled &&
    !/^0x[a-fA-F0-9]{40}$/u.test(String(cfg.builderTimedBuyExecutorAddress ?? ""))
  ) {
    throw new Error("BUILDER_TIMED_BUY_EXECUTOR_ADDRESS must be a valid address when BUILDER_TIMED_BUY_EXECUTOR_ENABLED=1");
  }
  if (cfg.builderTimedBuyExecutorEnabled && cfg.builderTimestampGuardEnabled) {
    throw new Error("BUILDER_TIMED_BUY_EXECUTOR_ENABLED and BUILDER_TIMESTAMP_GUARD_ENABLED cannot both be enabled");
  }
  if (cfg.builderTimedBuyExecutorExactSecond && !cfg.builderTimedBuyExecutorEnabled) {
    throw new Error("BUILDER_TIMED_BUY_EXECUTOR_EXACT_SECOND requires BUILDER_TIMED_BUY_EXECUTOR_ENABLED=1");
  }
  if (cfg.builderTimedBuyExecutorReleasePollMs < 10 || cfg.builderTimedBuyExecutorReleasePollMs > 1000) {
    throw new Error("BUILDER_TIMED_BUY_EXECUTOR_RELEASE_POLL_MS must be between 10 and 1000");
  }
  if (cfg.builderTimestampGuardEnabled && !/^0x[a-fA-F0-9]{40}$/u.test(String(cfg.builderTimestampGuardAddress ?? ""))) {
    throw new Error("BUILDER_TIMESTAMP_GUARD_ADDRESS must be a valid address when BUILDER_TIMESTAMP_GUARD_ENABLED=1");
  }
  if (cfg.builderTimestampGuardGasLimit < 21000 || cfg.builderTimestampGuardGasLimit > 500000) {
    throw new Error("BUILDER_TIMESTAMP_GUARD_GAS_LIMIT must be between 21000 and 500000");
  }
  if (cfg.builderTimestampGuardRetryIntervalMs < 25 || cfg.builderTimestampGuardRetryIntervalMs > 1000) {
    throw new Error("BUILDER_TIMESTAMP_GUARD_RETRY_INTERVAL_MS must be between 25 and 1000");
  }
  if (cfg.builderTimestampGuardRetryUntilLeadMs < 0 || cfg.builderTimestampGuardRetryUntilLeadMs > 1000) {
    throw new Error("BUILDER_TIMESTAMP_GUARD_RETRY_UNTIL_LEAD_MS must be between 0 and 1000");
  }
  if (cfg.builderTimestampGuardReleasePollMs < 25 || cfg.builderTimestampGuardReleasePollMs > 1000) {
    throw new Error("BUILDER_TIMESTAMP_GUARD_RELEASE_POLL_MS must be between 25 and 1000");
  }
  if (cfg.rpcKeepaliveMs < 0) {
    throw new Error("RPC_KEEPALIVE_MS must be 0 or a positive integer");
  }
  if (cfg.rebroadcastIntervalMs <= 0) {
    throw new Error("REBROADCAST_INTERVAL_MS must be positive");
  }
  if (cfg.rebroadcastDurationMs < 0) {
    throw new Error("REBROADCAST_DURATION_MS must be 0 or a positive integer");
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
  if (!["fixed", "block_aware_20s"].includes(cfg.openBroadcastMode)) {
    throw new Error("OPEN_BROADCAST_MODE must be fixed or block_aware_20s");
  }
  if (cfg.openBroadcastDelayMs < 0) {
    throw new Error("OPEN_BROADCAST_DELAY_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastScheduleAheadMs < 0) {
    throw new Error("OPEN_BROADCAST_SCHEDULE_AHEAD_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastSpinMs < 0) {
    throw new Error("OPEN_BROADCAST_SPIN_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastBlockTargetOffsetMs < 0) {
    throw new Error("OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastBlockAwareLeadMs < 0) {
    throw new Error("OPEN_BROADCAST_BLOCK_AWARE_LEAD_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastBlockAwareMaxWaitMs < 0) {
    throw new Error("OPEN_BROADCAST_BLOCK_AWARE_MAX_WAIT_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastBlockAwarePreTargetCount < 0) {
    throw new Error("OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_COUNT must be 0 or a positive integer");
  }
  if (cfg.openBroadcastBlockAwarePreTargetSendMs < 0) {
    throw new Error("OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_SEND_MS must be 0 or a positive integer");
  }
  if (cfg.openBroadcastBlockAwareHeadMaxAgeMs < 0) {
    throw new Error("OPEN_BROADCAST_BLOCK_AWARE_HEAD_MAX_AGE_MS must be 0 or a positive integer");
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
  if (cfg.armFundingNotifyWindowMs < 0) {
    throw new Error("ARM_FUNDING_NOTIFY_WINDOW_MS must be 0 or a positive integer");
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
  if (cfg.eventDiscoveryFeedFile) ensureParentDir(cfg.eventDiscoveryFeedFile);
  if (cfg.memeRangeSelectionFile) ensureParentDir(cfg.memeRangeSelectionFile);
  ensureParentDir(cfg.fillsFile);
  ensureParentDir(cfg.gasLedgerFile);
  ensureParentDir(cfg.decisionFile);
  ensureParentDir(cfg.marketFollowFile);
  ensureParentDir(cfg.alertStateFile);
  ensureParentDir(cfg.runtimeHealthFile);
  ensureParentDir(cfg.autoSellStateFile);
  ensureParentDir(cfg.autoSellPositionStateFile);
  ensureParentDir(cfg.autoSellCircuitStateFile);
  ensureParentDir(cfg.runtimeConfigFile);
  return cfg;
}

export function readRuntimeConfig(file = process.env.RUNTIME_CONFIG_FILE || "data/runtime-config.json") {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Failed to load runtime config ${file}: ${error.message}`);
  }
  return normalizeRuntimeConfig(parsed, { partial: true });
}

export function writeRuntimeConfig(file, input) {
  const config = normalizeRuntimeConfig(input, { partial: false });
  ensureParentDir(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return config;
}

export function normalizeRuntimeConfig(input = {}, { partial = false } = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const result = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  const take = (key, fallback, normalize) => {
    if (!has(key)) {
      if (!partial) result[key] = fallback;
      return;
    }
    result[key] = normalize(raw[key], key);
  };

  take("filterMode", "price_only_test", (value, key) => {
    const mode = String(value ?? "").trim();
    if (!["production", "price_only_test"].includes(mode)) {
      throw new Error(`${key} must be production or price_only_test`);
    }
    return mode;
  });
  take("eventOutcomeCount", 2, integerInRange(1, 12));
  take("stakePerOutcomeUsdt", 1, numberInRange(0.1, 100));
  take("maxMarketStakeUsdt", 2, numberInRange(0.1, 1000));
  take("maxBatchStakeUsdt", 20, numberInRange(0.1, 5000));
  take("minEventDurationHours", 0, numberInRange(0, 87600));
  take("gasPriceGwei", "2.0", decimalStringInRange(0.01, 50));
  take("autoSellEnabled", true, booleanValue);
  take("autoSellStartDelaySeconds", 10, integerInRange(0, 3600));
  take("autoSellIntervalSeconds", 10, integerInRange(1, 3600));
  take("autoSellChunkPercent", 10, numberInRange(0.1, 100));
  take("autoSellStrategy", "ladder", (value, key) => {
    const strategy = String(value ?? "").trim();
    if (!["ladder", "open_timed_exit", "pre_start_exit", "legacy"].includes(strategy)) {
      throw new Error(`${key} must be ladder, open_timed_exit, pre_start_exit, or legacy`);
    }
    return strategy;
  });
  take("autoSellOpenExitDelaySeconds", 36, integerInRange(0, MAX_AUTO_SELL_OPEN_EXIT_DELAY_SECONDS));
  take("autoSellOpenExitPercent", 100, numberInRange(0.1, 100));
  take("autoSellTakeProfitSteps", 0, integerInRange(0, 100));
  take("autoSellBeforeMarketStartSeconds", 0, integerInRange(0, 86400));
  take("autoSellMarketStartEndOffsetSeconds", 0, integerInRange(0, 86400));
  take("autoSellGasPriceGwei", "", (value, key) => {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return decimalStringInRange(0.01, 50)(text, key);
  });
  take("autoSellStopLossEnabled", true, booleanValue);
  take("autoSellStopLossPercent", 10, numberInRange(0.1, 100));
  take("autoSellStopLossSellPercent", 100, numberInRange(0.1, 100));
  take("eventDisplayFilterRules", DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS, (value) =>
    normalizeEventDisplayFilterRules(value, { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS })
  );
  take("eventDisplayIncludeRules", [], (value) =>
    normalizeEventDisplayFilterRules(value, { fallback: [] })
  );

  const mode = result.filterMode ?? (partial ? raw.filterMode : "price_only_test");
  if (!partial || mode === "price_only_test") {
    if (!has("marketCategoryBlocklist") && !partial) result.marketCategoryBlocklist = ["Price"];
    if (!has("marketTagBlocklist") && !partial) result.marketTagBlocklist = ["Price"];
  }
  if (has("marketCategoryBlocklist")) result.marketCategoryBlocklist = stringList(raw.marketCategoryBlocklist, "marketCategoryBlocklist");
  if (has("marketTagBlocklist")) result.marketTagBlocklist = stringList(raw.marketTagBlocklist, "marketTagBlocklist");

  if (
    result.maxMarketStakeUsdt !== undefined &&
    result.eventOutcomeCount !== undefined &&
    result.stakePerOutcomeUsdt !== undefined &&
    result.maxMarketStakeUsdt < result.eventOutcomeCount * result.stakePerOutcomeUsdt
  ) {
    throw new Error("maxMarketStakeUsdt must cover eventOutcomeCount * stakePerOutcomeUsdt");
  }
  if (
    result.maxBatchStakeUsdt !== undefined &&
    result.maxMarketStakeUsdt !== undefined &&
    result.maxBatchStakeUsdt < result.maxMarketStakeUsdt
  ) {
    throw new Error("maxBatchStakeUsdt must be >= maxMarketStakeUsdt");
  }

  return result;
}

function applyRuntimeConfig(cfg, runtimeConfig = {}) {
  if (!runtimeConfig || Object.keys(runtimeConfig).length === 0) return;
  if (runtimeConfig.filterMode) cfg.filterMode = runtimeConfig.filterMode;
  if (runtimeConfig.eventOutcomeCount !== undefined) cfg.eventOutcomeCount = runtimeConfig.eventOutcomeCount;
  if (runtimeConfig.stakePerOutcomeUsdt !== undefined) cfg.stakePerOutcomeUsdt = runtimeConfig.stakePerOutcomeUsdt;
  if (runtimeConfig.maxMarketStakeUsdt !== undefined) cfg.maxMarketStakeUsdt = runtimeConfig.maxMarketStakeUsdt;
  if (runtimeConfig.maxBatchStakeUsdt !== undefined) cfg.maxBatchStakeUsdt = runtimeConfig.maxBatchStakeUsdt;
  if (runtimeConfig.minEventDurationHours !== undefined) cfg.minEventDurationHours = runtimeConfig.minEventDurationHours;
  if (runtimeConfig.gasPriceGwei !== undefined) cfg.gasPriceGwei = runtimeConfig.gasPriceGwei;
  if (runtimeConfig.autoSellEnabled !== undefined) cfg.autoSellEnabled = runtimeConfig.autoSellEnabled;
  if (runtimeConfig.autoSellStrategy !== undefined) cfg.autoSellStrategy = runtimeConfig.autoSellStrategy;
  if (runtimeConfig.autoSellStartDelaySeconds !== undefined) cfg.autoSellStartDelaySeconds = runtimeConfig.autoSellStartDelaySeconds;
  if (runtimeConfig.autoSellIntervalSeconds !== undefined) cfg.autoSellIntervalSeconds = runtimeConfig.autoSellIntervalSeconds;
  if (runtimeConfig.autoSellChunkPercent !== undefined) cfg.autoSellChunkPercent = runtimeConfig.autoSellChunkPercent;
  if (runtimeConfig.autoSellLadderProfitPercent !== undefined) cfg.autoSellLadderProfitPercent = runtimeConfig.autoSellLadderProfitPercent;
  if (runtimeConfig.autoSellOpenExitDelaySeconds !== undefined) cfg.autoSellOpenExitDelaySeconds = runtimeConfig.autoSellOpenExitDelaySeconds;
  if (runtimeConfig.autoSellOpenExitPercent !== undefined) cfg.autoSellOpenExitPercent = runtimeConfig.autoSellOpenExitPercent;
  if (runtimeConfig.autoSellTakeProfitSteps !== undefined) cfg.autoSellTakeProfitSteps = runtimeConfig.autoSellTakeProfitSteps;
  if (runtimeConfig.autoSellBeforeMarketStartSeconds !== undefined) cfg.autoSellBeforeMarketStartSeconds = runtimeConfig.autoSellBeforeMarketStartSeconds;
  if (runtimeConfig.autoSellMarketStartEndOffsetSeconds !== undefined) cfg.autoSellMarketStartEndOffsetSeconds = runtimeConfig.autoSellMarketStartEndOffsetSeconds;
  if (runtimeConfig.autoSellGasPriceGwei !== undefined) cfg.autoSellGasPriceGwei = runtimeConfig.autoSellGasPriceGwei;
  if (runtimeConfig.autoSellStopLossEnabled !== undefined) cfg.autoSellStopLossEnabled = runtimeConfig.autoSellStopLossEnabled;
  if (runtimeConfig.autoSellStopLossPercent !== undefined) cfg.autoSellStopLossPercent = runtimeConfig.autoSellStopLossPercent;
  if (runtimeConfig.autoSellStopLossSellPercent !== undefined) cfg.autoSellStopLossSellPercent = runtimeConfig.autoSellStopLossSellPercent;
  if (runtimeConfig.eventDisplayFilterRules !== undefined) cfg.eventDisplayFilterRules = runtimeConfig.eventDisplayFilterRules;
  if (runtimeConfig.eventDisplayIncludeRules !== undefined) cfg.eventDisplayIncludeRules = runtimeConfig.eventDisplayIncludeRules;
  if (runtimeConfig.marketCategoryBlocklist !== undefined) cfg.marketCategoryBlocklist = runtimeConfig.marketCategoryBlocklist;
  if (runtimeConfig.marketTagBlocklist !== undefined) cfg.marketTagBlocklist = runtimeConfig.marketTagBlocklist;
  if (runtimeConfig.filterMode === "price_only_test") {
    cfg.minEventDurationHours = runtimeConfig.minEventDurationHours ?? 0;
    cfg.marketCategoryBlocklist = ensureListIncludes(runtimeConfig.marketCategoryBlocklist ?? ["Price"], "Price");
    cfg.marketTagBlocklist = ensureListIncludes(runtimeConfig.marketTagBlocklist ?? ["Price"], "Price");
  }
}

function integerInRange(min, max) {
  return (value, key) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return number;
  };
}

function numberInRange(min, max) {
  return (value, key) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`${key} must be a number between ${min} and ${max}`);
    }
    return number;
  };
}

function decimalStringInRange(min, max) {
  return (value, key) => String(numberInRange(min, max)(value, key));
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("boolean value must be true or false");
}

function stringList(value, key) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const normalized = list.map((item) => String(item).trim()).filter(Boolean);
  if (normalized.some((item) => item.length > 80)) throw new Error(`${key} contains an item that is too long`);
  return normalized;
}

function ensureListIncludes(value, required) {
  const list = stringList(value, "list");
  if (list.some((item) => item.toLowerCase() === String(required).toLowerCase())) return list;
  return [...list, required];
}

function loadProviderEnv() {
  const home = process.env.HOME ?? "";
  for (const file of [
    path.join(home, ".codex/secrets/evm-rpc-providers.env"),
    path.join(home, ".codex/secrets/twitterapi-io.env"),
    path.join(home, ".Codex/secrets/twitterapi-io.env"),
    "/etc/42space/secrets/twitterapi-io.env"
  ]) {
    loadDotEnv(file);
  }
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
  if (explicit.length > 0) {
    return uniqueStrings(explicit.filter((url) => /^https?:\/\//i.test(url)));
  }

  const dedicated = [
    process.env.CHAINSTACK_BSC_RPC_URL,
    process.env.ANKR_BSC_RPC_URL
  ].filter(Boolean);
  const urls = dedicated.length > 0 ? dedicated : [primaryRpcUrl];
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
