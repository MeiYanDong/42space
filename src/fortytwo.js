import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEventLogs,
  parseGwei,
  parseUnits,
  webSocket
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  encodeTimestampGuardCall,
  TIMESTAMP_GUARD_RUNTIME_CODE_HASH,
  timestampGuardCodeMatches
} from "./timestamp-guard.js";
import {
  EXACT_TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH,
  encodeTimedBuyExecutorCall,
  TIMED_BUY_EXECUTOR_ABI,
  TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH,
  exactTimedBuyExecutorCodeMatches,
  timedBuyExecutorCodeMatches
} from "./timed-buy-executor.js";

export const ADDRESSES = {
  busdt: "0x55d398326f99059fF775485246999027B3197955",
  routerProxy: "0x888888886619275d33c00D3BC62DF94D700DCD42",
  controllerV2: "0x8Fe93361D2B8b9519C4d20d47a319288Feec9072",
  lensV2: "0x4AAd5A856941FB64df10362024e3Ece24023d4d1",
  integrator: "0xc60E3415648684b1D0D0D97e85CB21E6a2bCb620",
  powerCurve: "0xDC26047458FEa8Bd45164217CCb7eE90b9bE10B8",
  powerLdaCurve: "0xa59096C20022a9ec5d7691E0DcDc7D46776b1b3d",
  clockCurve: "0x495B31876c092c236d1b0Df5Cc953D45d41301F1"
};

const INTEGRATOR_FEE_BPS = 40n;
const DEFAULT_MAX_ITERATIONS_EXECUTE = 50n;
const MAX_UINT256 = (1n << 256n) - 1n;
const SINGLE_FAST_GAS_BASE = 1600000n;
const SINGLE_FAST_GAS_PER_OUTCOME = 600000n;
const BUNDLE_FAST_GAS_BASE = 1500000n;
const BUNDLE_FAST_GAS_PER_MARKET = 400000n;
const BUNDLE_FAST_GAS_PER_OUTCOME = 600000n;
const BPS_DENOMINATOR = 10_000n;
const BUILDER_BUNDLE_TIP_GAS_LIMIT = 21_000n;
const STRICT_BUILDER_TIMING_MODES = new Set(["auto", "first_19s_block", "first_20s_block"]);
const timestampGuardCodeChecks = new Set();
const timedBuyExecutorCodeChecks = new Set();
const timestampGuardFallbackTransactions = new Map();

export function resolveBuilderBundleTimingPreset(cfg = {}) {
  const mode = String(cfg.builderBundleTimingMode ?? "legacy")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  const fallbackOffsetMs = Number(cfg.openBroadcastDelayMs ?? 0);
  const configuredTimeoutMs = Number(cfg.builderBundleTimeoutMs ?? 500);
  const prepositionLeadMs = Number(cfg.builderBundlePrepositionLeadMs ?? 1000);
  const fallbackSafetyMs = Number(cfg.builderBundleFallbackSafetyMs ?? 100);
  const base = {
    mode,
    strict: STRICT_BUILDER_TIMING_MODES.has(mode),
    eligible: true,
    reason: null,
    targetSecond: null,
    fallbackOffsetMs,
    earlySubmitOffsetMs: null,
    prepositionLeadMs,
    fallbackSafetyMs,
    configuredTimeoutMs,
    effectiveTimeoutMs: configuredTimeoutMs
  };
  if (mode === "legacy") return base;

  let targetSecond = null;
  if (mode === "first_19s_block") targetSecond = 19;
  if (mode === "first_20s_block") targetSecond = 20;
  if (mode === "auto" && Number.isFinite(fallbackOffsetMs)) {
    const inferred = Math.round(fallbackOffsetMs / 1000);
    if (inferred === 19 || inferred === 20) targetSecond = inferred;
  }
  if (targetSecond === null) {
    return {
      ...base,
      eligible: false,
      reason: `unsupported fallback T+${Number.isFinite(fallbackOffsetMs) ? fallbackOffsetMs : "?"}ms`
    };
  }

  const earlySubmitOffsetMs = targetSecond * 1000 - prepositionLeadMs;
  const targetSecondEndOffsetMs = (targetSecond + 1) * 1000;
  if (
    !Number.isFinite(fallbackOffsetMs) ||
    !Number.isFinite(earlySubmitOffsetMs) ||
    prepositionLeadMs <= 0 ||
    earlySubmitOffsetMs < 0 ||
    fallbackOffsetMs <= earlySubmitOffsetMs ||
    fallbackOffsetMs >= targetSecondEndOffsetMs ||
    configuredTimeoutMs < 50
  ) {
    return {
      ...base,
      eligible: false,
      reason: "builder target timing leaves no valid submit/fallback window",
      targetSecond,
      earlySubmitOffsetMs
    };
  }

  return {
    ...base,
    targetSecond,
    earlySubmitOffsetMs,
    targetBoundaryLeadMs: prepositionLeadMs,
    publicFallbackLeadMs: fallbackOffsetMs - earlySubmitOffsetMs,
    effectiveTimeoutMs: configuredTimeoutMs
  };
}

export function applyBuilderBundleTimingPreset(cfg = {}) {
  const timing = resolveBuilderBundleTimingPreset(cfg);
  if (!cfg.builderBundleEnabled || !timing.strict) {
    return { ...cfg, builderBundleTimingResolved: timing };
  }
  if (!timing.eligible) {
    return {
      ...cfg,
      builderBundleRequestedEnabled: true,
      builderBundleEnabled: false,
      builderBundleTimingDisabledReason: timing.reason,
      builderBundleTimingResolved: timing
    };
  }
  return {
    ...cfg,
    builderBundleRequestedEnabled: true,
    builderBundleEnabled: true,
    builderBundleTargetSecond: timing.targetSecond,
    builderBundleMode: builderBundleMode(cfg) === "builder_only" ? "builder_only" : "builder_then_fanout",
    builderBundleEarlySubmitOffsetMs: timing.earlySubmitOffsetMs,
    builderBundleEarlySubmitLeadMs: timing.targetBoundaryLeadMs,
    builderBundleTargetBoundaryLeadMs: timing.targetBoundaryLeadMs,
    builderBundlePublicFallbackLeadMs: timing.publicFallbackLeadMs,
    builderBundleMinTimestampOffsetMs: 0,
    builderBundleMaxTimestampOffsetMs: timing.targetSecond * 1000,
    builderBundleTimeoutMs: timing.effectiveTimeoutMs,
    builderBundlePositionFirst: true,
    builderBundleTimingDisabledReason: null,
    builderBundleTimingResolved: timing
  };
}

export function getTimestampGuardFallbackTransactions(buyTxHash) {
  return timestampGuardFallbackTransactions.get(String(buyTxHash ?? "").toLowerCase()) ?? null;
}

export function clearTimestampGuardFallbackTransactions(buyTxHash) {
  timestampGuardFallbackTransactions.delete(String(buyTxHash ?? "").toLowerCase());
}

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);

const controllerEventAbi = parseAbi([
  "event CreateNewMarket(address indexed market, address collateral, uint256 parentTokenId, bytes32 questionId, address curve, uint256 timestampStart)",
  "event CreateNewQuestionV2(bytes32 indexed questionId, address indexed oracle, address indexed creator, string title, string imageUri, uint96 timestampEnd, string[] outcomeNames, string[] outcomeImageUris, bytes ancillaryData)",
  "event AddOutcome(bytes32 indexed questionId, uint256 indexOutcomeFromZero, string name)"
]);

const createNewMarketEvent = controllerEventAbi.find((item) => item.type === "event" && item.name === "CreateNewMarket");
const controllerEvents = controllerEventAbi.filter((item) => item.type === "event");
const broadcastClients = new Map();
const creationTxFallbackCache = new Map();
const CREATION_TX_FALLBACK_CACHE_MAX = 256;

const lensAbi = parseAbi([
  "function simulateMint(address market, uint256 tokenId, uint256 amount, bool isExactIn, bytes dataSwap, bytes dataGuess, uint256 integratorFeeBps) returns ((uint256 tokenId, uint256 price, uint256 supply, uint256 totalMarketCap, uint256 payoutPerOt) pre, (uint256 tokenId, uint256 price, uint256 supply, uint256 totalMarketCap, uint256 payoutPerOt) post, (uint256 collateralFromUser, uint256 collateralToTreasury, uint256 collateralToIntegrator, uint256 otToUser) quote)"
]);

const routerAbi = parseAbi([
  "function swap(address market, address receiver, uint256 tokenId, (bool isMint, uint256 amount, bool isExactIn, uint256 minOutOrMaxIn) params, bytes dataSwap, bytes dataGuess, address integrator, uint256 integratorFeeBps)",
  "function multicall((bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] results)"
]);

const marketV2Abi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function isOperator(address owner, address spender) view returns (bool)",
  "function setOperator(address spender, bool approved) returns (bool)",
  "function redeemExactOtToCollateral(address receiver, uint256 tokenId, uint256 otDeltaIn, bytes dataSwap) returns (uint256 collateralOut)"
]);

const dataGuessAbi = parseAbiParameters("uint256 otDeltaGuessOffchain, uint256 maxIterations, uint256 eps");

export async function fetchMarkets(
  cfg,
  { status = "live", topic = cfg.targetTopic, order = "start_timestamp", ascending = false, limit = 500 } = {}
) {
  const url = new URL("/api/v1/markets", cfg.restUrl);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("status", status);
  url.searchParams.set("order", order);
  url.searchParams.set("ascending", String(ascending));
  if (topic) url.searchParams.set("topic", topic);

  const json = await getJsonWithRetry(url, "42 REST");
  return Array.isArray(json.data) ? json.data : [];
}

export async function fetchMarket(cfg, address) {
  const url = new URL(`/api/v1/markets/${getAddress(address)}`, cfg.restUrl);
  const json = await getJsonWithRetry(url, "42 market");
  return json.data ?? json;
}

export async function fetchOpenPositions(cfg, { user, market, limit = 500 } = {}) {
  const url = new URL("/api/v1/market-data/positions", cfg.restUrl);
  url.searchParams.set("user", user);
  url.searchParams.set("limit", String(limit));
  if (market) url.searchParams.set("market", market);

  const json = await getJsonWithRetry(url, "42 positions");
  return Array.isArray(json.data) ? json.data : [];
}

export async function fetchActivity(cfg, { user, market, limit = 100, type } = {}) {
  const url = new URL("/api/v1/market-data/activity", cfg.restUrl);
  if (user) url.searchParams.set("user", user);
  if (market) url.searchParams.set("market", market);
  if (type) url.searchParams.set("type", type);
  url.searchParams.set("limit", String(limit));

  const json = await getJsonWithRetry(url, "42 activity");
  return Array.isArray(json.data) ? json.data : [];
}

export function makeClients(cfg) {
  const publicClient = createPublicClient({
    chain: bsc,
    transport: http(cfg.rpcUrl)
  });

  if (!cfg.privateKey) return { publicClient, walletClient: null, account: null };

  const account = privateKeyToAccount(normalizePrivateKey(cfg.privateKey));
  const walletClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(cfg.rpcUrl)
  });

  return { publicClient, walletClient, account };
}

export function makeWsClient(cfg) {
  return createPublicClient({
    chain: bsc,
    transport: webSocket(cfg.wsUrl)
  });
}

export async function warmBroadcastRpcClients(cfg, { includeGasPrice = true } = {}) {
  const urls = (cfg.broadcastRpcUrls?.length ? cfg.broadcastRpcUrls : [cfg.rpcUrl]).filter(Boolean);
  const results = await Promise.all(urls.map(async (url) => {
    const startedAt = Date.now();
    const client = getBroadcastClient(url);
    try {
      const [blockNumber, gasPrice] = await withTimeout(
        Promise.all([
          client.getBlockNumber(),
          includeGasPrice ? client.getGasPrice() : Promise.resolve(null)
        ]),
        cfg.rpcWarmupTimeoutMs ?? cfg.broadcastTimeoutMs,
        `RPC warmup timeout after ${cfg.rpcWarmupTimeoutMs ?? cfg.broadcastTimeoutMs}ms`
      );
      return {
        provider: providerLabel(url),
        ok: true,
        latencyMs: Date.now() - startedAt,
        blockNumber: blockNumber.toString(),
        gasPriceWei: gasPrice === null ? null : gasPrice.toString()
      };
    } catch (error) {
      return {
        provider: providerLabel(url),
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error?.message ?? String(error)
      };
    }
  }));

  return {
    rpcCount: results.length,
    okCount: results.filter((item) => item.ok).length,
    bestProvider: bestWarmProvider(results),
    results
  };
}

export async function warmBuilderBundleClient(cfg) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  if (!builderBundleReady(cfg)) {
    return {
      provider: providerLabel(cfg?.builderBundleUrl),
      ok: false,
      latencyMs: 0,
      reason: builderBundleDisabledReason(cfg)
    };
  }
  if (typeof fetch !== "function") {
    return {
      provider: providerLabel(cfg?.builderBundleUrl),
      ok: false,
      latencyMs: 0,
      error: "global fetch is unavailable"
    };
  }

  const results = await Promise.all(resolveBuilderBundleTargets(cfg).map((target) => warmBuilderBundleTarget(cfg, target)));
  const best = [...results].filter((item) => item.ok).sort((a, b) => a.latencyMs - b.latencyMs)[0] ?? results[0];
  return {
    ...best,
    builderCount: results.length,
    okCount: results.filter((item) => item.ok).length,
    results
  };
}

async function warmBuilderBundleTarget(cfg, target) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = Math.max(50, Math.min(Number(cfg.builderBundleTimeoutMs ?? 500), 1000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const blockrazorProbe = target.id === "blockrazor";
    const response = await fetch(target.url, {
      method: "POST",
      headers: builderRequestHeaders(target),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: blockrazorProbe ? "eth_sendBundle" : "eth_chainId",
        params: blockrazorProbe
          ? [{ txs: [], maxTimestamp: Math.floor(Date.now() / 1000) + 10 }]
          : []
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`builder warmup HTTP ${response.status}: ${text.slice(0, 120)}`);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`builder warmup returned non-JSON response: ${text.slice(0, 120)}`);
    }
    const expectedBlockrazorProbeError = blockrazorProbe && /bundle missing txs/iu.test(json?.error?.message ?? "");
    if (json?.error && !expectedBlockrazorProbeError) {
      throw new Error(`builder warmup error ${json.error.code ?? ""}: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return {
      id: target.id,
      provider: target.provider,
      ok: true,
      latencyMs: Date.now() - startedAt,
      chainId: blockrazorProbe ? "0x38" : (json?.result ?? null),
      probe: blockrazorProbe ? "eth_sendBundle-empty-validation" : "eth_chainId"
    };
  } catch (error) {
    return {
      id: target.id,
      provider: target.provider,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error?.name === "AbortError"
        ? `builder warmup timeout after ${timeoutMs}ms`
        : conciseProviderError(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveBuilderBundleTargets(cfg) {
  if (!builderBundleReady(cfg)) return [];
  const targets = [{
    id: "48club",
    provider: providerLabel(cfg.builderBundleUrl),
    url: cfg.builderBundleUrl,
    tipTo: getAddress(cfg.builderBundleTipTo),
    authToken: ""
  }];
  if (cfg.blockrazorBuilderEnabled) {
    targets.push({
      id: "blockrazor",
      provider: providerLabel(cfg.blockrazorBuilderUrl),
      url: cfg.blockrazorBuilderUrl,
      tipTo: getAddress(cfg.blockrazorBuilderTipTo),
      authToken: String(cfg.blockrazorBuilderAuthToken ?? "").trim()
    });
  }
  const seen = new Set();
  return targets.filter((target) => {
    const key = `${target.url}|${target.tipTo.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getWalletStatus(cfg) {
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is required for wallet preflight");
  const { publicClient, account } = makeClients(cfg);
  return getWalletStatusForAddress(publicClient, account.address);
}

export async function getWalletStatusForAddress(publicClient, address) {
  const owner = getAddress(address);
  const [bnbBalance, busdtBalance, busdtAllowance, blockNumber] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({
      address: ADDRESSES.busdt,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner]
    }),
    publicClient.readContract({
      address: ADDRESSES.busdt,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, ADDRESSES.routerProxy]
    }),
    publicClient.getBlockNumber()
  ]);

  return {
    address: owner,
    blockNumber: blockNumber.toString(),
    bnbBalance: formatUnits(bnbBalance, 18),
    busdtBalance: formatUnits(busdtBalance, 18),
    busdtAllowanceToRouter: formatUnits(busdtAllowance, 18),
    router: ADDRESSES.routerProxy,
    controllerV2: ADDRESSES.controllerV2
  };
}

export async function estimateFastGasReserve(publicClient, cfg, funding = {}) {
  const gasPriceGwei = funding.nextBatchGasPriceGwei ?? funding.gasPriceGwei ?? cfg.gasPriceGwei;
  const gasPrice = gasPriceGwei ? parseGwei(String(gasPriceGwei)) : await publicClient.getGasPrice();
  return calculateFastGasReserve(cfg, funding, gasPrice);
}

export function calculateFastGasReserve(cfg, funding = {}, gasPrice = null) {
  const fundingGasPriceGwei = funding.nextBatchGasPriceGwei ?? funding.gasPriceGwei;
  const effectiveGasPrice = gasPrice ??
    (fundingGasPriceGwei ? parseGwei(String(fundingGasPriceGwei)) : null) ??
    (cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : null);
  if (!effectiveGasPrice) throw new Error("GAS_PRICE_GWEI is required for synchronous gas reserve calculation");
  const useBundleGas = Boolean(cfg.bundleDueMarkets && Number(funding.nextBatchMarketCount ?? 0) > 1);
  const dynamicGasLimit = useBundleGas
    ? resolveBundleFastGasLimit(cfg, {
      marketCount: funding.nextBatchMarketCount,
      outcomeCount: funding.nextBatchOutcomeCount
    })
    : resolveSingleFastGasLimit(cfg, funding.nextBatchOutcomeCount || cfg.eventOutcomeCount || 1);
  const gasLimit = capFastTxGasLimit(cfg, dynamicGasLimit);
  if (gasLimit <= 0n) throw new Error("FAST_GAS_LIMIT/BUNDLE_FAST_GAS_LIMIT must be positive for gas reserve estimation");
  const builderTipReserve = builderBundleTipReserveWei(cfg);
  const buyGasRequired = gasLimit * effectiveGasPrice;
  const required = buyGasRequired + builderTipReserve.totalWei;
  return {
    mode: useBundleGas ? "bundle_fast_dynamic" : "single_fast",
    gasLimit: gasLimit.toString(),
    gasPriceWei: effectiveGasPrice.toString(),
    gasPriceGwei: formatUnits(effectiveGasPrice, 9),
    requiredBnb: formatUnits(required, 18),
    buyGasRequiredBnb: formatUnits(buyGasRequired, 18),
    builderBundleTipRequiredBnb: builderTipReserve.totalWei > 0n ? formatUnits(builderTipReserve.totalWei, 18) : "0",
    builderBundleTipBnb: builderTipReserve.tipWei > 0n ? formatUnits(builderTipReserve.tipWei, 18) : "0",
    builderBundleTipGasRequiredBnb: builderTipReserve.gasWei > 0n ? formatUnits(builderTipReserve.gasWei, 18) : "0",
    builderTimestampGuardGasRequiredBnb: builderTipReserve.guardGasWei > 0n
      ? formatUnits(builderTipReserve.guardGasWei, 18)
      : "0"
  };
}

function builderBundleTipReserveWei(cfg) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  if (!builderBundleReady(cfg)) {
    return { totalWei: 0n, tipWei: 0n, gasWei: 0n, guardGasWei: 0n };
  }
  const tipWei = parseUnits(String(cfg.builderBundleTipBnb), 18);
  const gasPrice = parseGwei(String(cfg.builderBundleTipGasPriceGwei || cfg.gasPriceGwei || "1"));
  const gasWei = BUILDER_BUNDLE_TIP_GAS_LIMIT * gasPrice;
  const guardGasWei = cfg.builderTimestampGuardEnabled
    ? BigInt(cfg.builderTimestampGuardGasLimit ?? 50000) * parseGwei(String(cfg.gasPriceGwei || "1"))
    : 0n;
  return {
    totalWei: tipWei + gasWei + guardGasWei,
    tipWei,
    gasWei,
    guardGasWei
  };
}

function resolveSingleFastGasLimit(cfg, outcomeCount = 1) {
  const configured = BigInt(cfg.fastGasLimit || 0);
  if (configured <= 0n) return configured;

  const outcomes = BigInt(Math.max(1, Number(outcomeCount ?? 1)));
  const dynamic = SINGLE_FAST_GAS_BASE + SINGLE_FAST_GAS_PER_OUTCOME * outcomes;
  return dynamic > configured ? configured : dynamic;
}

function resolveBundleFastGasLimit(cfg, { marketCount, outcomeCount } = {}) {
  const configured = BigInt(cfg.bundleFastGasLimit || cfg.fastGasLimit);
  if (configured <= 0n) return configured;

  const markets = BigInt(Math.max(1, Number(marketCount ?? 1)));
  const outcomes = BigInt(Math.max(1, Number(outcomeCount ?? 1)));
  const dynamic = BUNDLE_FAST_GAS_BASE + BUNDLE_FAST_GAS_PER_MARKET * markets + BUNDLE_FAST_GAS_PER_OUTCOME * outcomes;
  return dynamic > configured ? configured : dynamic;
}

export function resolveWalletBudgetGasLimit(
  cfg,
  { desiredGasLimit, walletBalance, gasPrice, blockGasLimit = 0n, reservedWei = 0n } = {}
) {
  const desired = BigInt(desiredGasLimit ?? 0);
  if (!cfg.fastGasWalletBudget) return capFastTxGasLimit(cfg, desired);

  const balance = BigInt(walletBalance ?? 0);
  const price = BigInt(gasPrice ?? 0);
  const reserved = BigInt(reservedWei ?? 0);
  if (balance <= 0n || price <= 0n) {
    throw new Error("BNB balance and gas price are required for wallet-budget gas limit");
  }
  if (reserved < 0n || reserved >= balance) {
    throw new Error("BNB balance is too low after reserving Builder tip and guard gas");
  }

  const walletBps = BigInt(cfg.fastGasWalletBudgetBps ?? 10000);
  let limit = (((balance - reserved) * walletBps) / BPS_DENOMINATOR) / price;
  const blockLimit = BigInt(blockGasLimit ?? 0);
  if (blockLimit > 0n) {
    const blockBps = BigInt(cfg.fastGasBlockLimitBps ?? 10000);
    const blockCap = (blockLimit * blockBps) / BPS_DENOMINATOR;
    if (blockCap > 0n && limit > blockCap) limit = blockCap;
  }
  limit = capFastTxGasLimit(cfg, limit);
  if (limit <= 0n) throw new Error("BNB balance is too low to sign a fast transaction");
  return limit;
}

function capFastTxGasLimit(cfg, gasLimit) {
  let limit = BigInt(gasLimit ?? 0);
  const txCap = BigInt(cfg.fastGasTxLimit ?? 16_777_216);
  if (txCap > 0n && limit > txCap) limit = txCap;
  return limit;
}

async function resolveExecutionGasLimit(publicClient, accountAddress, cfg, desiredGasLimit, gasPrice) {
  const desired = BigInt(desiredGasLimit ?? 0);
  if (!cfg.fastGasWalletBudget) return capFastTxGasLimit(cfg, desired);

  const [walletBalance, block] = await Promise.all([
    getPendingBalance(publicClient, accountAddress),
    publicClient.getBlock().catch(() => null)
  ]);
  const reservedWei = builderBundleTipReserveWei(cfg).totalWei;
  const gasLimit = resolveWalletBudgetGasLimit(cfg, {
    desiredGasLimit: desired,
    walletBalance,
    gasPrice,
    blockGasLimit: block?.gasLimit ?? 0n,
    reservedWei
  });
  const maximumRequiredWei = gasLimit * BigInt(gasPrice) + reservedWei;
  if (maximumRequiredWei > walletBalance) {
    throw new Error(
      `BNB balance cannot cover signed buy gas plus Builder/guard reserve: balance=${walletBalance} required=${maximumRequiredWei}`
    );
  }
  return gasLimit;
}

async function getPendingBalance(publicClient, address) {
  try {
    return await publicClient.getBalance({ address, blockTag: "pending" });
  } catch {
    return publicClient.getBalance({ address });
  }
}

export async function approveRouterMax(cfg, { requiredUsdt = cfg.maxMarketStakeUsdt } = {}) {
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is required for router approval");
  const { publicClient, walletClient, account } = makeClients(cfg);
  const requiredAmount = parseUnits(String(requiredUsdt), 18);
  const allowance = await publicClient.readContract({
    address: ADDRESSES.busdt,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, ADDRESSES.routerProxy]
  });

  const base = {
    address: account.address,
    router: ADDRESSES.routerProxy,
    currentAllowance: formatUnits(allowance, 18),
    requiredAllowance: formatUnits(requiredAmount, 18),
    alreadyReady: allowance >= requiredAmount
  };
  if (allowance >= requiredAmount) return base;
  if (cfg.dryRun || !cfg.execute) {
    return { ...base, dryRun: true, wouldApproveMax: true };
  }
  if (cfg.riskAck !== "YES") {
    throw new Error("Refusing approval: set I_UNDERSTAND_42_PRICE_MARKET_RISK=YES");
  }
  if (cfg.eligibilityAck !== "YES") {
    throw new Error("Refusing approval: set I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES");
  }

  const approval = await ensureBusdtAllowance(publicClient, walletClient, account.address, requiredAmount);
  return { ...base, ...approval, approved: true };
}

export async function assertRouterAllowanceReady(cfg, totalAmount) {
  if (!cfg.privateKey) throw new Error("PRIVATE_KEY is required for allowance check");
  const { publicClient, account } = makeClients(cfg);
  const allowance = await publicClient.readContract({
    address: ADDRESSES.busdt,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, ADDRESSES.routerProxy]
  });
  if (allowance < totalAmount) {
    throw new Error(
      `BUSDT allowance ${formatUnits(allowance, 18)} is below required ${formatUnits(totalAmount, 18)}; run event:approve before sniping`
    );
  }
}

export async function fetchMarketCreationLogs(publicClient, { fromBlock, toBlock, chunkSize = 0 }) {
  return fetchLogsChunked(publicClient, {
    address: ADDRESSES.controllerV2,
    event: createNewMarketEvent,
    fromBlock,
    toBlock
  }, chunkSize);
}

export async function fetchControllerLogs(publicClient, { fromBlock, toBlock, chunkSize = 0 }) {
  return fetchLogsChunked(publicClient, {
    address: ADDRESSES.controllerV2,
    events: controllerEvents,
    fromBlock,
    toBlock
  }, chunkSize);
}

export function watchMarketCreationLogs(publicClient, { onLogs, onError }) {
  return publicClient.watchEvent({
    address: ADDRESSES.controllerV2,
    event: createNewMarketEvent,
    onLogs,
    onError
  });
}

export function watchControllerLogs(publicClient, { onLogs, onError }) {
  return publicClient.watchEvent({
    address: ADDRESSES.controllerV2,
    events: controllerEvents,
    onLogs,
    onError
  });
}

export function buildMarketsFromControllerLogs(logs, { createdAt = new Date().toISOString() } = {}) {
  const groups = groupLogsByTransaction(logs.filter((log) => log.address?.toLowerCase() === ADDRESSES.controllerV2.toLowerCase()));
  const markets = [];
  const errors = [];

  for (const txLogs of groups.values()) {
    const createLogs = txLogs.filter((log) => log.eventName === "CreateNewMarket");
    for (const created of createLogs) {
      try {
        markets.push(buildMarketFromParsedControllerLogs(txLogs, created, { createdAt }));
      } catch (error) {
        errors.push({
          market: created.args?.market,
          transactionHash: created.transactionHash,
          blockNumber: created.blockNumber?.toString(),
          transactionIndex: created.transactionIndex?.toString(),
          logIndex: created.logIndex?.toString(),
          message: error.message
        });
      }
    }
  }

  return { markets, errors };
}

export async function buildMarketFromCreationLog(publicClient, log) {
  const { block, parsed } = await getParsedCreationTransaction(publicClient, log.transactionHash);

  const created = parsed.find(
    (item) =>
      item.eventName === "CreateNewMarket" &&
      item.args.market.toLowerCase() === log.args.market.toLowerCase()
  );
  if (!created) throw new Error(`CreateNewMarket event not found in tx ${log.transactionHash}`);

  const question = parsed.find(
    (item) => item.eventName === "CreateNewQuestionV2" && item.args.questionId === created.args.questionId
  );
  const outcomeNames = question?.args.outcomeNames?.length
    ? question.args.outcomeNames
    : parsed
        .filter((item) => item.eventName === "AddOutcome" && item.args.questionId === created.args.questionId)
        .sort((a, b) => Number(a.args.indexOutcomeFromZero - b.args.indexOutcomeFromZero))
        .map((item) => item.args.name);
  if (outcomeNames.length === 0) {
    throw new Error(`No outcome names found in market creation tx ${log.transactionHash}`);
  }

  const timestampStart = Number(created.args.timestampStart);
  const timestampEnd = Number(question?.args.timestampEnd ?? 0);
  const createdAt = new Date(Number(block.timestamp) * 1000).toISOString();

  return {
    question: question?.args.title ?? `Question ${created.args.questionId}`,
    address: created.args.market,
    status: "live",
    createdAt,
    startDate: new Date(timestampStart * 1000).toISOString(),
    endDate: timestampEnd > 0 ? new Date(timestampEnd * 1000).toISOString() : null,
    contractVersion: 2,
    curve: created.args.curve,
    collateral: created.args.collateral,
    parentTokenId: created.args.parentTokenId.toString(),
    questionId: created.args.questionId,
    categories: [],
    tags: ["onchain"],
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
    transactionIndex: log.transactionIndex?.toString(),
    logIndex: log.logIndex?.toString(),
    outcomes: outcomeNames.map((name, index) => ({
      tokenId: (1n << BigInt(index)).toString(),
      name
    }))
  };
}

async function getParsedCreationTransaction(publicClient, txHash) {
  const key = String(txHash).toLowerCase();
  const cached = creationTxFallbackCache.get(key);
  if (cached) return cached;

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const block = await publicClient.getBlock({ blockHash: receipt.blockHash });
  const parsed = parseEventLogs({
    abi: controllerEventAbi,
    logs: receipt.logs,
    strict: false
  }).filter((item) => item.address.toLowerCase() === ADDRESSES.controllerV2.toLowerCase());
  const value = { block, parsed };
  creationTxFallbackCache.set(key, value);
  if (creationTxFallbackCache.size > CREATION_TX_FALLBACK_CACHE_MAX) {
    creationTxFallbackCache.delete(creationTxFallbackCache.keys().next().value);
  }
  return value;
}

function buildMarketFromParsedControllerLogs(logs, created, { createdAt }) {
  const question = logs.find(
    (item) => item.eventName === "CreateNewQuestionV2" && item.args.questionId === created.args.questionId
  );
  const outcomeNames = question?.args.outcomeNames?.length
    ? question.args.outcomeNames
    : logs
        .filter((item) => item.eventName === "AddOutcome" && item.args.questionId === created.args.questionId)
        .sort((a, b) => Number(a.args.indexOutcomeFromZero - b.args.indexOutcomeFromZero))
        .map((item) => item.args.name);
  if (outcomeNames.length === 0) {
    throw new Error(`No outcome names found in tx ${created.transactionHash}`);
  }

  const timestampStart = Number(created.args.timestampStart);
  const timestampEnd = Number(question?.args.timestampEnd ?? 0);
  return {
    question: question?.args.title ?? `Question ${created.args.questionId}`,
    address: created.args.market,
    status: "live",
    createdAt,
    startDate: new Date(timestampStart * 1000).toISOString(),
    endDate: timestampEnd > 0 ? new Date(timestampEnd * 1000).toISOString() : null,
    contractVersion: 2,
    curve: created.args.curve,
    collateral: created.args.collateral,
    parentTokenId: created.args.parentTokenId.toString(),
    questionId: created.args.questionId,
    categories: [],
    tags: ["onchain"],
    transactionHash: created.transactionHash,
    blockNumber: created.blockNumber?.toString(),
    transactionIndex: created.transactionIndex?.toString(),
    logIndex: created.logIndex?.toString(),
    outcomes: outcomeNames.map((name, index) => ({
      tokenId: (1n << BigInt(index)).toString(),
      name
    }))
  };
}

function groupLogsByTransaction(logs) {
  const groups = new Map();
  for (const log of logs) {
    const key = log.transactionHash;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }
  return groups;
}

async function fetchLogsChunked(publicClient, params, chunkSize) {
  const fromBlock = BigInt(params.fromBlock);
  const toBlock = BigInt(params.toBlock);
  const step = BigInt(chunkSize);
  if (step <= 0n || toBlock - fromBlock <= step) {
    return publicClient.getLogs(params);
  }

  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += step) {
    const end = start + step - 1n < toBlock ? start + step - 1n : toBlock;
    logs.push(...await publicClient.getLogs({ ...params, fromBlock: start, toBlock: end }));
  }
  return logs;
}

export async function simulateMint(publicClient, { market, tokenId, stakeUsdt }) {
  const amount = parseUnits(String(stakeUsdt), 18);
  return simulateMintAmount(publicClient, { market, tokenId, amount, stakeUsdt });
}

export async function simulateMintAmount(publicClient, { market, tokenId, amount, stakeUsdt }) {
  const result = await publicClient.readContract({
    address: ADDRESSES.lensV2,
    abi: lensAbi,
    functionName: "simulateMint",
    args: [getAddress(market), BigInt(tokenId), amount, true, "0x", "0x", INTEGRATOR_FEE_BPS]
  });

  const quote = result.quote ?? result[2];
  const pre = result.pre ?? result[0];
  const post = result.post ?? result[1];
  return {
    amount,
    stakeUsdt,
    pre,
    post,
    quote,
    otToUser: quote.otToUser ?? quote[3],
    collateralFromUser: quote.collateralFromUser ?? quote[0],
    collateralToTreasury: quote.collateralToTreasury ?? quote[1],
    collateralToIntegrator: quote.collateralToIntegrator ?? quote[2]
  };
}

export function selectEventOutcomes(outcomes, cfg) {
  const sorted = sortOutcomes(outcomes ?? []);
  if (sorted.length === 0) {
    return {
      outcomes: [],
      metadata: {
        strategy: cfg.eventOutcomeSelection,
        requestedCount: 0,
        selectedCount: 0,
        availableOutcomeCount: 0,
        rankSource: "none",
        fallbackReason: null
      }
    };
  }

  const strategy = cfg.eventOutcomeSelection ?? "lowest_odds";
  if (strategy === "all") {
    return {
      outcomes: sorted,
      metadata: {
        strategy,
        requestedCount: sorted.length,
        selectedCount: sorted.length,
        availableOutcomeCount: sorted.length,
        rankSource: "token_order",
        fallbackReason: null
      }
    };
  }
  if (strategy === "names") {
    const wantedNames = parseOutcomeNames(cfg.eventOutcomeNames);
    if (wantedNames.length === 0) {
      throw new Error("EVENT_OUTCOME_NAMES is required when EVENT_OUTCOME_SELECTION=names");
    }
    const byName = new Map(sorted.map((outcome) => [normalizeOutcomeName(outcome.name), outcome]));
    const selected = [];
    const seen = new Set();
    const missing = [];
    for (const name of wantedNames) {
      const outcome = byName.get(normalizeOutcomeName(name));
      if (!outcome) {
        missing.push(name);
        continue;
      }
      const key = String(outcome.tokenId);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(outcome);
    }
    if (missing.length > 0) {
      throw new Error(`EVENT_OUTCOME_NAMES not found in market: ${missing.join(", ")}`);
    }
    return {
      outcomes: selected,
      metadata: {
        strategy,
        requestedCount: wantedNames.length,
        selectedCount: selected.length,
        availableOutcomeCount: sorted.length,
        rankSource: "name",
        fallbackReason: null,
        requestedNames: wantedNames
      }
    };
  }
  if (strategy === "middle") {
    const requestedCount = Math.min(Number(cfg.eventOutcomeCount ?? 3), sorted.length);
    const start = Math.max(0, Math.floor((sorted.length - requestedCount) / 2));
    return {
      outcomes: sorted.slice(start, start + requestedCount),
      metadata: {
        strategy,
        requestedCount: Number(cfg.eventOutcomeCount ?? 3),
        selectedCount: requestedCount,
        availableOutcomeCount: sorted.length,
        rankSource: "token_order",
        fallbackReason: null
      }
    };
  }
  if (strategy === "first") {
    const requestedCount = Math.min(Number(cfg.eventOutcomeCount ?? 3), sorted.length);
    return {
      outcomes: sorted.slice(0, requestedCount),
      metadata: {
        strategy,
        requestedCount: Number(cfg.eventOutcomeCount ?? 3),
        selectedCount: requestedCount,
        availableOutcomeCount: sorted.length,
        rankSource: "token_order",
        fallbackReason: null
      }
    };
  }
  if (strategy !== "lowest_odds") {
    throw new Error(`Unsupported EVENT_OUTCOME_SELECTION ${strategy}`);
  }

  const requestedCount = Math.min(Number(cfg.eventOutcomeCount ?? 5), sorted.length);
  const { rankSource, fallbackReason } = selectLowestOddsRankSource(sorted, cfg);
  const ranked = [...sorted].sort((a, b) => compareOutcomeRank(a, b, rankSource));
  return {
    outcomes: ranked.slice(0, requestedCount),
    metadata: {
      strategy,
      requestedCount: Number(cfg.eventOutcomeCount ?? 5),
      selectedCount: requestedCount,
      availableOutcomeCount: sorted.length,
      rankSource,
      fallbackReason
    }
  };
}

export function estimateSelectedOutcomeCount(market, cfg) {
  const availableCount = market.outcomes?.length ?? 0;
  if (availableCount <= 0) return 0;
  if ((cfg.eventOutcomeSelection ?? "lowest_odds") === "all") return availableCount;
  if ((cfg.eventOutcomeSelection ?? "lowest_odds") === "names") return parseOutcomeNames(cfg.eventOutcomeNames).length;
  return Math.min(Number(cfg.eventOutcomeCount ?? 5), availableCount);
}

export function estimateMaxSelectedOutcomeCount(cfg) {
  if ((cfg.eventOutcomeSelection ?? "lowest_odds") === "all") return cfg.maxOutcomesPerMarket;
  if ((cfg.eventOutcomeSelection ?? "lowest_odds") === "names") {
    return Math.min(parseOutcomeNames(cfg.eventOutcomeNames).length, cfg.maxOutcomesPerMarket);
  }
  return Math.min(Number(cfg.eventOutcomeCount ?? 5), cfg.maxOutcomesPerMarket);
}

export async function quoteBuyAllOutcomes(publicClient, market, cfg, overrides = {}) {
  if (Number(market.contractVersion) !== 2) {
    throw new Error("Event buy simulation currently supports only contractVersion=2 markets");
  }
  const availableOutcomes = sortOutcomes(market.outcomes ?? []);
  if (availableOutcomes.length === 0) throw new Error("Market has no outcomes");
  if (availableOutcomes.length > cfg.maxOutcomesPerMarket && !allowsExplicitLargeMarketSelection(cfg)) {
    throw new Error(`Market has ${availableOutcomes.length} outcomes, above MAX_OUTCOMES_PER_MARKET ${cfg.maxOutcomesPerMarket}`);
  }
  const selection = selectEventOutcomes(availableOutcomes, cfg);
  const outcomes = selection.outcomes;
  assertSelectedOutcomeLimit(outcomes, cfg);

  const stakePlan = resolveOutcomeStakePlan(outcomes, cfg, overrides);
  const { stakePerOutcomeUsdt, stakeByOutcomeUsdt, totalStakeUsdt, maxStakePerOutcomeUsdt } = stakePlan;
  if (totalStakeUsdt > cfg.maxMarketStakeUsdt) {
    throw new Error(`Total stake ${totalStakeUsdt} exceeds MAX_MARKET_STAKE_USDT ${cfg.maxMarketStakeUsdt}`);
  }

  const quotedOutcomes = await Promise.all(outcomes.map(async (outcome) => {
    const stakeUsdt = stakePlan.stakeForOutcome(outcome);
    const amount = parseUnits(String(stakeUsdt), 18);
    const simulated = await simulateMintAmount(publicClient, {
      market: market.address,
      tokenId: outcome.tokenId,
      amount,
      stakeUsdt
    });
    return {
      ...outcome,
      stakeUsdt,
      simulated,
      minOut: applySlippage(simulated.otToUser, cfg.slippageBps)
    };
  }));

  return {
    dryRun: cfg.dryRun || !cfg.execute,
    action: selection.metadata.strategy === "all" ? "mint_all_outcomes" : "mint_selected_outcomes",
    market,
    outcomes: addSelectionDetails(quotedOutcomes, selection.metadata),
    selection: selection.metadata,
    stakePerOutcomeUsdt,
    stakeByOutcomeUsdt,
    maxStakePerOutcomeUsdt,
    totalStakeUsdt,
    totalAmount: quotedOutcomes.reduce((sum, outcome) => sum + plannedAmount(outcome), 0n),
    slippageBps: cfg.slippageBps,
    source: "42 REST + FTLensV2.simulateMint",
    createdAt: new Date().toISOString()
  };
}

export function buildDirectBuyAllOutcomesPlan(market, cfg, overrides = {}) {
  if (Number(market.contractVersion) !== 2) {
    throw new Error("Event buy currently supports only contractVersion=2 markets");
  }
  if (!isSupportedCollateralMarket(market)) {
    throw new Error("Only BUSDT collateral markets with parentTokenId=0 are supported for direct buys");
  }
  const availableOutcomes = sortOutcomes(market.outcomes ?? []);
  if (availableOutcomes.length === 0) throw new Error("Market has no outcomes");
  if (availableOutcomes.length > cfg.maxOutcomesPerMarket && !allowsExplicitLargeMarketSelection(cfg)) {
    throw new Error(`Market has ${availableOutcomes.length} outcomes, above MAX_OUTCOMES_PER_MARKET ${cfg.maxOutcomesPerMarket}`);
  }
  const selection = selectEventOutcomes(availableOutcomes, cfg);
  const outcomes = selection.outcomes;
  assertSelectedOutcomeLimit(outcomes, cfg);

  const stakePlan = resolveOutcomeStakePlan(outcomes, cfg, overrides);
  const { stakePerOutcomeUsdt, stakeByOutcomeUsdt, totalStakeUsdt, maxStakePerOutcomeUsdt } = stakePlan;
  if (totalStakeUsdt > cfg.maxMarketStakeUsdt) {
    throw new Error(`Total stake ${totalStakeUsdt} exceeds MAX_MARKET_STAKE_USDT ${cfg.maxMarketStakeUsdt}`);
  }
  const plannedOutcomes = outcomes.map((outcome) => {
    const stakeUsdt = stakePlan.stakeForOutcome(outcome);
    return {
      ...outcome,
      stakeUsdt,
      amount: parseUnits(String(stakeUsdt), 18),
      minOut: 1n,
      dataGuess: "0x"
    };
  });

  return {
    dryRun: cfg.dryRun || !cfg.execute,
    action: selection.metadata.strategy === "all" ? "mint_all_outcomes_fast" : "mint_selected_outcomes_fast",
    market,
    outcomes: addSelectionDetails(plannedOutcomes, selection.metadata),
    selection: selection.metadata,
    stakePerOutcomeUsdt,
    stakeByOutcomeUsdt,
    maxStakePerOutcomeUsdt,
    totalStakeUsdt,
    totalAmount: plannedOutcomes.reduce((sum, outcome) => sum + outcome.amount, 0n),
    slippageBps: 10_000,
    source: market.transactionHash
      ? "42 controller CreateNewMarket log + direct router swap"
      : "42 REST + direct router swap",
    createdAt: new Date().toISOString()
  };
}

export function withPrebuiltFastExecution(plan, receiverAddress) {
  const market = getAddress(plan.market.address);
  const receiver = getAddress(receiverAddress);
  const calls = buildOutcomeSwapCalls(plan, market, receiver);
  const multicallData = encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [calls]
  });
  return {
    ...plan,
    prebuiltFastExecution: {
      market,
      receiver,
      calls,
      multicallData,
      preparedAt: new Date().toISOString()
    }
  };
}

export function buildFastBuyBundlePlan(cfg, plans, receiverAddress) {
  if (!Array.isArray(plans) || plans.length === 0) throw new Error("Bundle requires at least one plan");
  const receiver = getAddress(receiverAddress);
  const calls = [];
  let totalAmount = 0n;
  let totalStakeUsdt = 0;
  let outcomeCount = 0;
  const markets = [];

  for (const plan of plans) {
    const isFastPlan = plan.action?.endsWith("_fast") || plan.outcomes.some((outcome) => !outcome.simulated);
    if (!isFastPlan) throw new Error("Bundle only supports fast plans");
    if (Number(plan.market.contractVersion) !== 2) {
      throw new Error("Bundle only supports contractVersion=2 markets");
    }
    const market = getAddress(plan.market.address);
    const prebuilt = getReusablePrebuiltFastExecution(plan, market, receiver);
    const planCalls = prebuilt?.calls ?? buildOutcomeSwapCalls(plan, market, receiver);
    calls.push(...planCalls);
    const amount = plan.outcomes.reduce((sum, outcome) => sum + plannedAmount(outcome), 0n);
    totalAmount += amount;
    totalStakeUsdt += Number(plan.totalStakeUsdt ?? plan.stakePerOutcomeUsdt * plan.outcomes.length);
    outcomeCount += plan.outcomes.length;
    markets.push({
      question: plan.market.question,
      address: plan.market.address,
      startDate: plan.market.startDate,
      outcomeCount: plan.outcomes.length,
      availableOutcomeCount: plan.selection?.availableOutcomeCount ?? plan.market.outcomes?.length ?? plan.outcomes.length,
      selection: plan.selection ?? null,
      totalStakeUsdt: Number(plan.totalStakeUsdt ?? plan.stakePerOutcomeUsdt * plan.outcomes.length)
    });
  }

  if (totalStakeUsdt > cfg.maxBatchStakeUsdt) {
    throw new Error(`Bundle stake ${totalStakeUsdt} exceeds MAX_BATCH_STAKE_USDT ${cfg.maxBatchStakeUsdt}`);
  }

  return {
    dryRun: cfg.dryRun || !cfg.execute,
    action: "mint_event_markets_bundle_fast",
    markets,
    plans,
    calls,
    multicallData: encodeFunctionData({
      abi: routerAbi,
      functionName: "multicall",
      args: [calls]
    }),
    marketCount: plans.length,
    outcomeCount,
    totalStakeUsdt,
    totalAmount,
    source: "42 controller/REST plans + bundled direct router swaps",
    createdAt: new Date().toISOString()
  };
}

export async function preSignFastBuyTransaction(cfg, plan, runtime = null) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  assertExecutionAllowed(cfg, plan);
  const isFastPlan = plan.action?.endsWith("_fast") || plan.outcomes.some((outcome) => !outcome.simulated);
  if (!isFastPlan) throw new Error("preSignFastBuyTransaction requires a fast plan");

  const { publicClient, account } = makeClients(cfg);
  const receiver = getAddress(runtime?.receiverAddress || cfg.walletAddress || account.address);
  const market = getAddress(plan.market.address);
  const prebuilt = getReusablePrebuiltFastExecution(plan, market, receiver);
  const calls = prebuilt?.calls ?? buildOutcomeSwapCalls(plan, market, receiver);
  const gasPrice = cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : await publicClient.getGasPrice();
  const gas = await resolveExecutionGasLimit(publicClient, account.address, cfg, resolveFastPlanGasLimit(cfg, plan), gasPrice);
  if (!gas || gas <= 0n) throw new Error("FAST_GAS_LIMIT is required for pre-signed fast transactions");
  const builderWindow = resolveBuilderBundleTimestampWindow(cfg, [plan.market]);
  const timedExecutorRequired = builderTimedBuyExecutorRequired(cfg);
  const guardRequired = builderTimestampGuardRequired(cfg) && !timedExecutorRequired;
  if ((guardRequired || timedExecutorRequired) && !builderWindow) {
    throw new Error("Builder time gate requires first_19s_block/first_20s_block targeted timing");
  }
  const baseNonce = runtime?.nextNonce !== undefined
    ? runtime.nextNonce
    : await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending"
      });
  const nonce = baseNonce + (guardRequired ? 1 : 0);
  const routerData = prebuilt?.multicallData ?? encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [calls]
  });
  const totalAmount = BigInt(plan.totalAmount ?? plan.outcomes.reduce((sum, outcome) => sum + plannedAmount(outcome), 0n));
  let to = ADDRESSES.routerProxy;
  let data = routerData;
  if (timedExecutorRequired) {
    await assertTimedBuyExecutorReady(publicClient, account.address, totalAmount, cfg);
    to = getAddress(cfg.builderTimedBuyExecutorAddress);
    data = encodeTimedBuyExecutorCall(builderWindow.executorTargetTimestamp, totalAmount, routerData);
  }
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to,
    data,
    gas,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy"
  });
  const txHash = keccak256(serializedTransaction);
  const signed = {
    txHash,
    serializedTransaction,
    nonce,
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    market,
    receiver,
    timedBuyExecutorEnabled: timedExecutorRequired,
    timedBuyExecutorAddress: timedExecutorRequired ? to : null,
    timedBuyExecutorExactSecond: timedExecutorRequired && Boolean(cfg.builderTimedBuyExecutorExactSecond),
    timedBuyExecutorTargetTimestamp: timedExecutorRequired ? builderWindow.executorTargetTimestamp : null,
    timedBuyExecutorCollateralAmount: timedExecutorRequired ? totalAmount.toString() : null,
    preparedAt: new Date().toISOString()
  };
  applyBuilderBundleTimestampWindow(signed, builderWindow);
  if (guardRequired) {
    await assertTimestampGuardCode(publicClient, cfg);
    signed.preSignedTimestampGuardTransaction = await signTimestampGuardTransaction(
      cfg,
      account,
      signed,
      baseNonce,
      gasPrice
    );
    rememberTimestampGuardFallbackTransactions(signed);
  }
  const builderPreSign = await preSignBuilderBundleForSignedTransaction(cfg, account, signed);
  if (builderPreSign) {
    Object.assign(signed, builderPreSign);
  }
  if (runtime?.nextNonce !== undefined) {
    runtime.nextNonce += 1 + (builderPreSign ? 1 : 0) + (guardRequired ? 1 : 0);
    runtime.lastNonceSyncAt = 0;
  }

  return signed;
}

export async function preSignFastBundleTransaction(cfg, bundle, runtime = null) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  assertExecutionAllowed(cfg, bundle, { checkMarketStake: false });
  if (bundle.totalStakeUsdt > cfg.maxBatchStakeUsdt) {
    throw new Error(`Bundle stake ${bundle.totalStakeUsdt} exceeds MAX_BATCH_STAKE_USDT ${cfg.maxBatchStakeUsdt}`);
  }

  const { publicClient, account } = makeClients(cfg);
  const gasPrice = cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : await publicClient.getGasPrice();
  const gas = await resolveExecutionGasLimit(publicClient, account.address, cfg, resolveBundleFastGasLimit(cfg, bundle), gasPrice);
  if (!gas || gas <= 0n) throw new Error("BUNDLE_FAST_GAS_LIMIT is required for pre-signed bundle transactions");
  const builderWindow = resolveBuilderBundleTimestampWindow(cfg, bundle.markets);
  const timedExecutorRequired = builderTimedBuyExecutorRequired(cfg);
  const guardRequired = builderTimestampGuardRequired(cfg) && !timedExecutorRequired;
  if ((guardRequired || timedExecutorRequired) && !builderWindow) {
    throw new Error("Builder time gate requires first_19s_block/first_20s_block targeted timing");
  }
  const baseNonce = runtime?.nextNonce !== undefined
    ? runtime.nextNonce
    : await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending"
      });
  const nonce = baseNonce + (guardRequired ? 1 : 0);
  let to = ADDRESSES.routerProxy;
  let data = bundle.multicallData;
  if (timedExecutorRequired) {
    await assertTimedBuyExecutorReady(publicClient, account.address, bundle.totalAmount, cfg);
    to = getAddress(cfg.builderTimedBuyExecutorAddress);
    data = encodeTimedBuyExecutorCall(builderWindow.executorTargetTimestamp, bundle.totalAmount, bundle.multicallData);
  }
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to,
    data,
    gas,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy"
  });
  const txHash = keccak256(serializedTransaction);
  const signed = {
    txHash,
    serializedTransaction,
    nonce,
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    marketCount: bundle.marketCount,
    outcomeCount: bundle.outcomeCount,
    timedBuyExecutorEnabled: timedExecutorRequired,
    timedBuyExecutorAddress: timedExecutorRequired ? to : null,
    timedBuyExecutorExactSecond: timedExecutorRequired && Boolean(cfg.builderTimedBuyExecutorExactSecond),
    timedBuyExecutorTargetTimestamp: timedExecutorRequired ? builderWindow.executorTargetTimestamp : null,
    timedBuyExecutorCollateralAmount: timedExecutorRequired ? bundle.totalAmount.toString() : null,
    preparedAt: new Date().toISOString()
  };
  applyBuilderBundleTimestampWindow(signed, builderWindow);
  if (guardRequired) {
    await assertTimestampGuardCode(publicClient, cfg);
    signed.preSignedTimestampGuardTransaction = await signTimestampGuardTransaction(
      cfg,
      account,
      signed,
      baseNonce,
      gasPrice
    );
    rememberTimestampGuardFallbackTransactions(signed);
  }
  const builderPreSign = await preSignBuilderBundleForSignedTransaction(cfg, account, signed);
  if (builderPreSign) {
    Object.assign(signed, builderPreSign);
  }
  if (runtime?.nextNonce !== undefined) {
    runtime.nextNonce += 1 + (builderPreSign ? 1 : 0) + (guardRequired ? 1 : 0);
    runtime.lastNonceSyncAt = 0;
  }
  return signed;
}

export async function executeFastBuyBundle(cfg, bundle, runtime = null) {
  assertExecutionAllowed(cfg, bundle, { checkMarketStake: false });
  if (bundle.totalStakeUsdt > cfg.maxBatchStakeUsdt) {
    throw new Error(`Bundle stake ${bundle.totalStakeUsdt} exceeds MAX_BATCH_STAKE_USDT ${cfg.maxBatchStakeUsdt}`);
  }

  let broadcast = null;
  let preSignedError = null;
  if (bundle.preSignedFastBundleTransaction) {
    try {
      broadcast = await broadcastPreSignedFastTransaction(cfg, bundle.preSignedFastBundleTransaction);
    } catch (error) {
      preSignedError = error?.message ?? String(error);
    }
  }

  if (!broadcast && builderTimedBuyExecutorRequired(applyBuilderBundleTimingPreset(cfg))) {
    throw new Error(`Timed Builder bundle requires its pre-signed atomic transaction: ${preSignedError ?? "missing pre-sign"}`);
  }

  if (!broadcast) {
    const { publicClient, walletClient, account } = makeClients(cfg);
    const gasPrice = cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : await publicClient.getGasPrice();
    const request = {
      address: ADDRESSES.routerProxy,
      abi: routerAbi,
      functionName: "multicall",
      args: [bundle.calls],
      gas: await resolveExecutionGasLimit(publicClient, account.address, cfg, resolveBundleFastGasLimit(cfg, bundle), gasPrice),
      gasPrice
    };
    const reusePreSignedNonce = shouldReusePreSignedNonce(preSignedError) &&
      bundle.preSignedFastBundleTransaction?.nonce !== undefined;
    let reservedRuntimeNonce = null;
    if (reusePreSignedNonce) {
      request.nonce = bundle.preSignedFastBundleTransaction.nonce;
    } else if (preSignedError && account) {
      request.nonce = await getFreshPendingNonce(publicClient, account, runtime);
    } else if (runtime?.nextNonce !== undefined) {
      reservedRuntimeNonce = reserveRuntimeNonce(runtime);
      request.nonce = reservedRuntimeNonce;
    }
    try {
      if (cfg.fanoutBroadcast && cfg.broadcastRpcUrls.length > 1) {
        broadcast = await writeFastMulticallFanout(
          cfg,
          publicClient,
          account,
          request,
          bundle.calls,
          runtime,
          bundle.multicallData,
          bundle.markets
        );
        broadcast.mode = `bundle_${broadcast.mode}`;
      } else {
        broadcast = { txHash: await walletClient.writeContract(request), mode: "bundle_single", rpcCount: 1 };
      }
    } catch (error) {
      restoreRuntimeNonce(runtime, reservedRuntimeNonce);
      throw error;
    }
  }

  const receipt = cfg.waitForReceipt
    ? await waitForReceiptWithConfig(cfg, broadcast.txHash)
    : null;

  return {
    txHash: broadcast.txHash,
    status: receipt?.status ?? "broadcast",
    blockNumber: receipt?.blockNumber?.toString() ?? null,
    broadcastMode: broadcast.mode,
    broadcastRpcCount: broadcast.rpcCount,
    firstBroadcastProvider: broadcast.firstProvider ?? null,
    broadcastStartedAt: broadcast.broadcastStartedAt ?? null,
    firstAcceptedAt: broadcast.firstAcceptedAt ?? null,
    firstAcceptedLatencyMs: broadcast.firstAcceptedLatencyMs ?? null,
    gas: broadcast.gas ?? null,
    gasPrice: broadcast.gasPrice ?? null,
    gasPriceGwei: broadcast.gasPriceGwei ?? null,
    nonce: broadcast.nonce ?? null,
    rebroadcastIntervalMs: broadcast.rebroadcastIntervalMs ?? null,
    rebroadcastDurationMs: broadcast.rebroadcastDurationMs ?? null,
    publicBroadcastSkipped: Boolean(broadcast.publicBroadcastSkipped),
    publicBroadcastFailed: Boolean(broadcast.publicBroadcastFailed),
    ...broadcastBuilderBundleResultFields(broadcast),
    usedPreSignedTransaction: Boolean(bundle.preSignedFastBundleTransaction && !preSignedError),
    preSignedError,
    preSignedNonceStale: Boolean(preSignedError && !shouldReusePreSignedNonce(preSignedError)),
    preSignedAt: bundle.preSignedFastBundleTransaction?.preparedAt ?? null,
    preSignedNonce: bundle.preSignedFastBundleTransaction?.nonce ?? null,
    waitedForReceipt: Boolean(receipt),
    marketCount: bundle.marketCount,
    outcomeCount: bundle.outcomeCount,
    totalAmount: formatUnits(bundle.totalAmount, 18),
    totalStakeUsdt: bundle.totalStakeUsdt,
    markets: bundle.markets,
    ...receiptGasFields(receipt)
  };
}

export async function buyOutcomesBatch(cfg, plan, runtime = null) {
  assertExecutionAllowed(cfg, plan);
  if (Number(plan.market.contractVersion) !== 2) {
    throw new Error("Real execution currently supports only contractVersion=2 markets");
  }

  const { publicClient, walletClient, account } = makeClients(cfg);
  const receiver = getAddress(cfg.walletAddress || account.address);
  const market = getAddress(plan.market.address);
  const totalAmount = plan.outcomes.reduce((sum, outcome) => sum + plannedAmount(outcome), 0n);
  const isFastPlan = plan.action?.endsWith("_fast") || plan.outcomes.some((outcome) => !outcome.simulated);

  if (!isFastPlan || !cfg.fastSkipPreflight) {
    const balance = await publicClient.readContract({
      address: ADDRESSES.busdt,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    });
    if (balance < totalAmount) {
      throw new Error(`BUSDT balance ${formatUnits(balance, 18)} is below required ${formatUnits(totalAmount, 18)}`);
    }

    await assertRouterAllowanceReady(cfg, totalAmount);
  }

  let broadcast = null;
  let preSignedError = null;
  if (isFastPlan && plan.preSignedFastTransaction) {
    try {
      broadcast = await broadcastPreSignedFastTransaction(cfg, plan.preSignedFastTransaction);
    } catch (error) {
      preSignedError = error?.message ?? String(error);
    }
  }

  if (!broadcast && isFastPlan && builderTimedBuyExecutorRequired(applyBuilderBundleTimingPreset(cfg))) {
    throw new Error(`Timed Builder buy requires its pre-signed atomic transaction: ${preSignedError ?? "missing pre-sign"}`);
  }

  const prebuilt = broadcast ? null : getReusablePrebuiltFastExecution(plan, market, receiver);
  const calls = broadcast ? null : (prebuilt?.calls ?? buildOutcomeSwapCalls(plan, market, receiver));

  let request = null;
  if (!broadcast) {
    const fastOptions = await fastTransactionOptions(cfg, publicClient, account, isFastPlan, plan);
    request = {
      address: ADDRESSES.routerProxy,
      abi: routerAbi,
      functionName: "multicall",
      args: [calls],
      ...fastOptions
    };
  }
  if (!broadcast && !isFastPlan) {
    const simulated = await publicClient.simulateContract({
      address: ADDRESSES.routerProxy,
      abi: routerAbi,
      functionName: "multicall",
      args: [calls],
      account: account.address
    });
    Object.assign(request, simulated.request);
    request.account = account;
  }

  let reservedRuntimeNonce = null;
  if (!broadcast && isFastPlan) {
    const reusePreSignedNonce = shouldReusePreSignedNonce(preSignedError) &&
      plan.preSignedFastTransaction?.nonce !== undefined;
    if (reusePreSignedNonce) {
      request.nonce = plan.preSignedFastTransaction.nonce;
    } else if (preSignedError && account) {
      request.nonce = await getFreshPendingNonce(publicClient, account, runtime);
    } else if (runtime?.nextNonce !== undefined) {
      reservedRuntimeNonce = reserveRuntimeNonce(runtime);
      request.nonce = reservedRuntimeNonce;
    }
  }
  if (!broadcast) {
    try {
      broadcast = isFastPlan && cfg.fanoutBroadcast && cfg.broadcastRpcUrls.length > 1
        ? await writeFastMulticallFanout(cfg, publicClient, account, request, calls, runtime, prebuilt?.multicallData, [plan.market])
        : { txHash: await walletClient.writeContract(request), mode: "single", rpcCount: 1 };
    } catch (error) {
      restoreRuntimeNonce(runtime, reservedRuntimeNonce);
      throw error;
    }
  }
  const receipt = cfg.waitForReceipt || !isFastPlan
    ? await waitForReceiptWithConfig(cfg, broadcast.txHash)
    : null;

  return {
    approveHash: null,
    resetHash: null,
    txHash: broadcast.txHash,
    status: receipt?.status ?? "broadcast",
    blockNumber: receipt?.blockNumber?.toString() ?? null,
    broadcastMode: broadcast.mode,
    broadcastRpcCount: broadcast.rpcCount,
    firstBroadcastProvider: broadcast.firstProvider ?? null,
    broadcastStartedAt: broadcast.broadcastStartedAt ?? null,
    firstAcceptedAt: broadcast.firstAcceptedAt ?? null,
    firstAcceptedLatencyMs: broadcast.firstAcceptedLatencyMs ?? null,
    gas: broadcast.gas ?? null,
    gasPrice: broadcast.gasPrice ?? null,
    gasPriceGwei: broadcast.gasPriceGwei ?? null,
    nonce: broadcast.nonce ?? null,
    rebroadcastIntervalMs: broadcast.rebroadcastIntervalMs ?? null,
    rebroadcastDurationMs: broadcast.rebroadcastDurationMs ?? null,
    publicBroadcastSkipped: Boolean(broadcast.publicBroadcastSkipped),
    publicBroadcastFailed: Boolean(broadcast.publicBroadcastFailed),
    ...broadcastBuilderBundleResultFields(broadcast),
    skippedPreflight: isFastPlan && cfg.fastSkipPreflight,
    usedPreSignedTransaction: Boolean(plan.preSignedFastTransaction && !preSignedError),
    preSignedError,
    preSignedNonceStale: Boolean(preSignedError && !shouldReusePreSignedNonce(preSignedError)),
    preSignedAt: plan.preSignedFastTransaction?.preparedAt ?? null,
    preSignedNonce: plan.preSignedFastTransaction?.nonce ?? null,
    waitedForReceipt: Boolean(receipt),
    totalAmount: formatUnits(totalAmount, 18),
    outcomes: plan.outcomes.map((outcome) => ({
      tokenId: String(outcome.tokenId),
      name: outcome.name,
      simulatedOtToUser: outcome.simulated ? formatUnits(outcome.simulated.otToUser, 18) : null,
      minOut: formatUnits(outcome.minOut, 18),
      collateralFromUser: outcome.simulated ? formatUnits(outcome.simulated.collateralFromUser, 18) : formatUnits(outcome.amount, 18)
    })),
    ...receiptGasFields(receipt)
  };
}

function buildOutcomeSwapCalls(plan, market, receiver) {
  return plan.outcomes.map((outcome) => {
    if (outcome.minOut <= 0n) throw new Error(`minOut is zero for tokenId ${outcome.tokenId}`);
    const amount = plannedAmount(outcome);
    const dataGuess = outcome.dataGuess ?? encodeDataGuess(
      outcome.simulated.otToUser,
      DEFAULT_MAX_ITERATIONS_EXECUTE,
      smartEps(outcome.stakeUsdt)
    );
    const callData = encodeFunctionData({
      abi: routerAbi,
      functionName: "swap",
      args: [
        market,
        receiver,
        BigInt(outcome.tokenId),
        [true, amount, true, outcome.minOut],
        "0x",
        dataGuess,
        ADDRESSES.integrator,
        INTEGRATOR_FEE_BPS
      ]
    });
    return { allowFailure: false, callData };
  });
}

function getReusablePrebuiltFastExecution(plan, market, receiver) {
  const prepared = plan.prebuiltFastExecution;
  if (!prepared) return null;
  if (String(prepared.market).toLowerCase() !== String(market).toLowerCase()) return null;
  if (String(prepared.receiver).toLowerCase() !== String(receiver).toLowerCase()) return null;
  return prepared;
}

async function writeFastMulticallFanout(
  cfg,
  publicClient,
  account,
  request,
  calls,
  runtime,
  prebuiltMulticallData = null,
  builderMarkets = []
) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  const gas = request.gas ?? BigInt(cfg.fastGasLimit);
  if (!gas || gas <= 0n) throw new Error("FAST_GAS_LIMIT is required for fanout fast broadcast");
  const gasPrice = request.gasPrice ?? await publicClient.getGasPrice();
  const nonce = request.nonce ?? await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  });
  if (runtime?.nextNonce !== undefined && request.nonce === undefined) {
    runtime.nextNonce = nonce;
  }

  const data = prebuiltMulticallData ?? encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [calls]
  });
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to: ADDRESSES.routerProxy,
    data,
    gas,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy"
  });

  const txHash = keccak256(serializedTransaction);
  const signed = {
    txHash,
    serializedTransaction,
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    nonce
  };
  applyBuilderBundleTimestampWindow(signed, resolveBuilderBundleTimestampWindow(cfg, builderMarkets));
  const broadcastStartedAt = Date.now();
  const strictFallbackOnly = Boolean(cfg.builderBundleTimingResolved?.strict);
  const mode = strictFallbackOnly ? "concurrent" : effectiveBuilderBundleMode(cfg);
  if (mode === "builder_only") {
    return submitBuilderOnlyBroadcast(cfg, signed, "builder_bundle_only", cfg.broadcastRpcUrls.length, broadcastStartedAt);
  }
  const builderBundlePromise = strictFallbackOnly
    ? Promise.resolve(null)
    : submitBuilderBundleForSignedTransaction(cfg, signed, broadcastStartedAt);
  const builderDelayMs = mode === "builder_then_fanout" ? builderBundleFanoutDelayMs(cfg) : null;
  const builderWait = mode === "builder_then_fanout"
    ? await waitForBuilderBundleBeforeFanout(builderBundlePromise, builderDelayMs)
    : null;
  if (builderWait?.builderBundle?.submitted) {
    return builderOnlyBroadcastResult(
      signed,
      builderWait.builderBundle,
      "builder_then_fanout_builder_first",
      cfg.broadcastRpcUrls.length,
      broadcastStartedAt,
      {
        publicBroadcastSkipped: true,
        builderBundleFanoutDelayMs: builderDelayMs,
        builderBundlePublicFanoutDelayed: true,
        builderBundleWaitTimedOut: false
      }
    );
  }
  const attempts = buildRawTransactionFanoutAttempts(
    cfg.broadcastRpcUrls,
    serializedTransaction,
    txHash,
    cfg.broadcastTimeoutMs,
    broadcastStartedAt
  );

  try {
    const first = await Promise.any(attempts);
    logRawTransactionFanoutSettled("raw-tx-fanout-settled", txHash, attempts);
    scheduleRawTransactionRebroadcast(cfg, {
      txHash,
      serializedTransaction,
      gas: signed.gas,
      gasPrice: signed.gasPrice,
      nonce
    }, cfg.broadcastRpcUrls, first.provider);
    const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
    return {
      txHash: first.txHash,
      mode: mode === "builder_then_fanout" ? "builder_then_fanout_raw" : "fanout_raw",
      rpcCount: cfg.broadcastRpcUrls.length,
      firstProvider: first.provider,
      firstAlreadyKnown: Boolean(first.alreadyKnown),
      broadcastStartedAt: new Date(broadcastStartedAt).toISOString(),
      firstAcceptedAt: first.acceptedAt,
      firstAcceptedLatencyMs: first.latencyMs,
      gas: gas.toString(),
      gasPrice: gasPrice.toString(),
      gasPriceGwei: formatUnits(gasPrice, 9),
      nonce,
      rebroadcastIntervalMs: cfg.rebroadcastIntervalMs,
      rebroadcastDurationMs: cfg.rebroadcastDurationMs,
      builderBundleFanoutDelayMs: builderDelayMs,
      builderBundlePublicFanoutDelayed: mode === "builder_then_fanout",
      builderBundleWaitTimedOut: Boolean(builderWait?.timedOut),
      ...builderBundleResultFields(builderBundle)
    };
  } catch {
    const settled = await Promise.allSettled(attempts);
    const messages = settled.map((item) =>
      item.status === "rejected" ? conciseProviderError(item.reason) : "unexpected success"
    );
    const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
    if (builderBundle?.submitted) {
      return builderOnlyBroadcastResult(
        signed,
        builderBundle,
        mode === "builder_then_fanout" ? "builder_then_fanout_builder_after_public_failed" : "builder_bundle_raw",
        cfg.broadcastRpcUrls.length,
        broadcastStartedAt,
        {
          builderBundleFanoutDelayMs: builderDelayMs,
          builderBundlePublicFanoutDelayed: mode === "builder_then_fanout",
          builderBundleWaitTimedOut: Boolean(builderWait?.timedOut)
        }
      );
    }
    const builderMessage = builderBundle?.error ? ` | builder: ${builderBundle.error}` : "";
    throw new Error(`Fanout broadcast failed on all RPCs: ${messages.join(" | ")}${builderMessage}`);
  }
}

export async function broadcastPreSignedFastTransaction(cfg, signed) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  if (!signed?.serializedTransaction || !signed?.txHash) {
    throw new Error("Missing pre-signed fast transaction");
  }
  const urls = cfg.broadcastRpcUrls?.length ? cfg.broadcastRpcUrls : [cfg.rpcUrl];
  if (cfg.fanoutBroadcast && urls.length > 1) {
    const broadcastStartedAt = Date.now();
    const mode = effectiveBuilderBundleMode(cfg);
    if (mode === "builder_only") {
      return submitBuilderOnlyBroadcast(cfg, signed, "presigned_builder_bundle_only", urls.length, broadcastStartedAt);
    }
    const {
      preSubmittedBuilderBundle,
      builderBundlePromise,
      builderDelayMs,
      builderWait
    } = await preparePreSignedBuilderFanout(cfg, signed, broadcastStartedAt, mode);
    if (builderWait?.builderBundle?.submitted && !builderTimeGateAttached(cfg, signed)) {
      return builderOnlyBroadcastResult(
        signed,
        builderWait.builderBundle,
        preSubmittedBuilderBundle
          ? "presigned_prepositioned_builder_first"
          : "presigned_builder_then_fanout_builder_first",
        urls.length,
        broadcastStartedAt,
        {
          publicBroadcastSkipped: true,
          builderBundleFanoutDelayMs: builderDelayMs,
          builderBundlePublicFanoutDelayed: true,
          builderBundleWaitTimedOut: false
        }
      );
    }
    const timedFallback = await waitForTimedBuyExecutorPublicFallback(cfg, signed);
    if (timedFallback?.receipt) {
      const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
      return builderOnlyBroadcastResult(
        signed,
        builderBundle?.submitted ? builderBundle : fallbackBuilderReceiptResult(cfg, signed, timedFallback),
        "presigned_timed_builder_included",
        urls.length,
        broadcastStartedAt,
        { publicBroadcastSkipped: true, timedFallback }
      );
    }
    const attempts = buildRawTransactionFanoutAttempts(
      urls,
      signed.serializedTransaction,
      signed.txHash,
      cfg.broadcastTimeoutMs,
      broadcastStartedAt
    );
    try {
      const first = await Promise.any(attempts);
      logRawTransactionFanoutSettled("presigned-raw-tx-fanout-settled", signed.txHash, attempts);
      scheduleRawTransactionRebroadcast(cfg, signed, urls, first.provider);
      const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
      return {
        txHash: first.txHash,
        mode: mode === "builder_then_fanout" ? "presigned_builder_then_fanout_raw" : "presigned_fanout_raw",
        rpcCount: urls.length,
        firstProvider: first.provider,
        firstAlreadyKnown: Boolean(first.alreadyKnown),
        broadcastStartedAt: earliestBroadcastStartedAt(builderBundle, broadcastStartedAt),
        publicBroadcastStartedAt: new Date(broadcastStartedAt).toISOString(),
        firstAcceptedAt: first.acceptedAt,
        firstAcceptedLatencyMs: first.latencyMs,
        gas: signed.gas ?? null,
        gasPrice: signed.gasPrice ?? null,
        gasPriceGwei: signed.gasPrice ? formatUnits(BigInt(signed.gasPrice), 9) : null,
        nonce: signed.nonce ?? null,
        rebroadcastIntervalMs: cfg.rebroadcastIntervalMs,
        rebroadcastDurationMs: cfg.rebroadcastDurationMs,
        builderBundleFanoutDelayMs: builderDelayMs,
        builderBundlePublicFanoutDelayed: mode === "builder_then_fanout",
        builderBundlePublicFanoutWhileInFlight: Boolean(builderWait?.inFlight),
        builderBundleWaitTimedOut: Boolean(builderWait?.timedOut),
        builderTimedBuyExecutorFallbackReleasedAt: timedFallback?.releasedAt ?? null,
        builderTimedBuyExecutorFallbackBlockNumber: timedFallback?.observedBlockNumber ?? null,
        builderTimedBuyExecutorFallbackBlockTimestamp: timedFallback?.observedBlockTimestamp ?? null,
        ...builderBundleResultFields(builderBundle)
      };
    } catch {
      const settled = await Promise.allSettled(attempts);
      const messages = settled.map((item) =>
        item.status === "rejected" ? conciseProviderError(item.reason) : "unexpected success"
      );
      const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
      if (builderBundle?.submitted) {
        return builderOnlyBroadcastResult(
          signed,
          builderBundle,
          mode === "builder_then_fanout" ? "presigned_builder_then_fanout_builder_after_public_failed" : "presigned_builder_bundle",
          urls.length,
          broadcastStartedAt,
          {
            builderBundleFanoutDelayMs: builderDelayMs,
            builderBundlePublicFanoutDelayed: mode === "builder_then_fanout",
            builderBundleWaitTimedOut: Boolean(builderWait?.timedOut)
          }
        );
      }
      const builderMessage = builderBundle?.error ? ` | builder: ${builderBundle.error}` : "";
      throw new Error(`Pre-signed fanout broadcast failed on all RPCs: ${messages.join(" | ")}${builderMessage}`);
    }
  }

  const broadcastStartedAt = Date.now();
  const mode = effectiveBuilderBundleMode(cfg);
  if (mode === "builder_only") {
    return submitBuilderOnlyBroadcast(cfg, signed, "presigned_builder_bundle_only", 1, broadcastStartedAt);
  }
  const {
    preSubmittedBuilderBundle,
    builderBundlePromise,
    builderDelayMs,
    builderWait
  } = await preparePreSignedBuilderFanout(cfg, signed, broadcastStartedAt, mode);
  if (builderWait?.builderBundle?.submitted && !builderTimeGateAttached(cfg, signed)) {
    return builderOnlyBroadcastResult(
      signed,
      builderWait.builderBundle,
      preSubmittedBuilderBundle
        ? "presigned_prepositioned_builder_first"
        : "presigned_builder_then_fanout_builder_first",
      1,
      broadcastStartedAt,
      {
        publicBroadcastSkipped: true,
        builderBundleFanoutDelayMs: builderDelayMs,
        builderBundlePublicFanoutDelayed: true,
        builderBundleWaitTimedOut: false
      }
    );
  }
  const timedFallback = await waitForTimedBuyExecutorPublicFallback(cfg, signed);
  if (timedFallback?.receipt) {
    const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
    return builderOnlyBroadcastResult(
      signed,
      builderBundle?.submitted ? builderBundle : fallbackBuilderReceiptResult(cfg, signed, timedFallback),
      "presigned_timed_builder_included",
      1,
      broadcastStartedAt,
      { publicBroadcastSkipped: true, timedFallback }
    );
  }
  let first = null;
  try {
    first = await sendRawTransactionVia(
      urls[0],
      signed.serializedTransaction,
      signed.txHash,
      cfg.broadcastTimeoutMs,
      broadcastStartedAt
    );
  } catch (error) {
    const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
    if (builderBundle?.submitted) {
      return builderOnlyBroadcastResult(
        signed,
        builderBundle,
        mode === "builder_then_fanout" ? "presigned_builder_then_fanout_builder_after_public_failed" : "presigned_builder_bundle",
        1,
        broadcastStartedAt,
        {
          builderBundleFanoutDelayMs: builderDelayMs,
          builderBundlePublicFanoutDelayed: mode === "builder_then_fanout",
          builderBundleWaitTimedOut: Boolean(builderWait?.timedOut)
        }
      );
    }
    const builderMessage = builderBundle?.error ? ` | builder: ${builderBundle.error}` : "";
    throw new Error(`Pre-signed single broadcast failed: ${conciseProviderError(error)}${builderMessage}`);
  }
  scheduleRawTransactionRebroadcast(cfg, signed, [urls[0]], first.provider);
  const builderBundle = builderWait?.builderBundle ?? await builderBundlePromise;
  return {
    txHash: first.txHash,
    mode: mode === "builder_then_fanout" ? "presigned_builder_then_fanout_single_raw" : "presigned_single_raw",
    rpcCount: 1,
    firstProvider: first.provider,
    broadcastStartedAt: earliestBroadcastStartedAt(builderBundle, broadcastStartedAt),
    publicBroadcastStartedAt: new Date(broadcastStartedAt).toISOString(),
    firstAcceptedAt: first.acceptedAt,
    firstAcceptedLatencyMs: first.latencyMs,
    gas: signed.gas ?? null,
    gasPrice: signed.gasPrice ?? null,
    gasPriceGwei: signed.gasPrice ? formatUnits(BigInt(signed.gasPrice), 9) : null,
    nonce: signed.nonce ?? null,
    rebroadcastIntervalMs: cfg.rebroadcastIntervalMs,
    rebroadcastDurationMs: cfg.rebroadcastDurationMs,
    builderBundleFanoutDelayMs: builderDelayMs,
    builderBundlePublicFanoutDelayed: mode === "builder_then_fanout",
    builderBundlePublicFanoutWhileInFlight: Boolean(builderWait?.inFlight),
    builderBundleWaitTimedOut: Boolean(builderWait?.timedOut),
    builderTimedBuyExecutorFallbackReleasedAt: timedFallback?.releasedAt ?? null,
    builderTimedBuyExecutorFallbackBlockNumber: timedFallback?.observedBlockNumber ?? null,
    builderTimedBuyExecutorFallbackBlockTimestamp: timedFallback?.observedBlockTimestamp ?? null,
    ...builderBundleResultFields(builderBundle)
  };
}

async function waitForTimedBuyExecutorPublicFallback(cfg, signed) {
  if (!builderTimedBuyExecutorAttached(cfg, signed)) return null;
  const targetTimestamp = Number(signed.timedBuyExecutorTargetTimestamp);
  const pollMs = Math.max(10, Number(cfg.builderTimedBuyExecutorReleasePollMs ?? 25));
  const deadlineMs = Date.now() + 10_000;
  const { publicClient } = makeClients(cfg);
  let latestBlock = null;
  while (Date.now() < deadlineMs) {
    latestBlock = await publicClient.getBlock({ blockTag: "latest" });
    const observedTimestamp = Number(latestBlock.timestamp);
    if (observedTimestamp >= targetTimestamp) break;
    await sleepMs(pollMs);
  }
  if (!latestBlock || Number(latestBlock.timestamp) < targetTimestamp) {
    throw new Error(`chain timestamp did not reach timed buy target ${targetTimestamp}`);
  }
  const observedTimestamp = Number(latestBlock.timestamp);
  if (observedTimestamp > targetTimestamp) {
    throw new Error(`timed buy target second was missed target=${targetTimestamp} observed=${observedTimestamp}`);
  }
  const receipt = await publicClient.getTransactionReceipt({ hash: signed.txHash }).catch(() => null);
  return {
    receipt,
    targetTimestamp,
    observedBlockNumber: latestBlock.number?.toString() ?? null,
    observedBlockTimestamp: latestBlock.timestamp?.toString() ?? null,
    releasedAt: new Date().toISOString()
  };
}

function fallbackBuilderReceiptResult(cfg, signed, timedFallback) {
  const now = new Date().toISOString();
  return {
    submitted: true,
    targetId: "receipt",
    provider: "chain-receipt",
    acceptedAt: now,
    latencyMs: 0,
    requestStartedAt: now,
    requestLatencyMs: 0,
    buyTxHash: signed.txHash,
    ...builderTimeGateResultFields(signed),
    minTimestamp: signed.builderBundleMinTimestamp ?? null,
    maxTimestamp: signed.builderBundleMaxTimestamp ?? null,
    timingMode: cfg.builderBundleTimingMode ?? null,
    targetSecond: signed.builderBundleTargetSecond ?? null,
    targetBoundaryAtMs: signed.builderBundleTargetBoundaryAtMs ?? null,
    timedFallback
  };
}

async function preparePreSignedBuilderFanout(cfg, signed, broadcastStartedAt, mode) {
  const inFlightBuilderBundlePromise = signed.preSubmittedBuilderBundlePromise ?? null;
  const preSubmittedBuilderBundle = signed.preSubmittedBuilderBundle ?? (
    inFlightBuilderBundlePromise ? null : strictBuilderEarlySubmissionMiss(cfg, signed)
  );
  if (preSubmittedBuilderBundle && !signed.preSubmittedBuilderBundle) {
    signed.preSubmittedBuilderBundle = preSubmittedBuilderBundle;
  }
  const builderBundlePromise = preSubmittedBuilderBundle
    ? Promise.resolve(preSubmittedBuilderBundle)
    : inFlightBuilderBundlePromise ?? submitBuilderBundleForSignedTransaction(cfg, signed, broadcastStartedAt);
  const builderDelayMs = mode === "builder_then_fanout" ? builderBundleFanoutDelayMs(cfg) : null;
  const builderWait = mode !== "builder_then_fanout"
    ? null
    : preSubmittedBuilderBundle
      ? { timedOut: false, inFlight: false, builderBundle: preSubmittedBuilderBundle }
      : inFlightBuilderBundlePromise
        ? { timedOut: false, inFlight: true, builderBundle: null }
        : await waitForBuilderBundleBeforeFanout(builderBundlePromise, builderDelayMs);
  return {
    preSubmittedBuilderBundle,
    builderBundlePromise,
    builderDelayMs,
    builderWait
  };
}

function strictBuilderEarlySubmissionMiss(cfg, signed) {
  const timing = cfg?.builderBundleTimingResolved ?? resolveBuilderBundleTimingPreset(cfg);
  if (!cfg?.builderBundleEnabled || !timing.strict || !signed?.preSignedBuilderBundle) return null;
  return {
    submitted: false,
    provider: providerLabel(cfg.builderBundleUrl),
    buyTxHash: signed.txHash,
    timestampGuardEnabled: Boolean(signed.preSignedTimestampGuardTransaction),
    timestampGuardAddress: signed.preSignedTimestampGuardTransaction?.to ?? null,
    timestampGuardTxHash: signed.preSignedTimestampGuardTransaction?.txHash ?? null,
    timestampGuardNonce: signed.preSignedTimestampGuardTransaction?.nonce ?? null,
    timestampGuardTargetTimestamp: signed.preSignedTimestampGuardTransaction?.targetTimestamp ?? null,
    timedBuyExecutorEnabled: Boolean(signed.timedBuyExecutorEnabled),
    timedBuyExecutorAddress: signed.timedBuyExecutorAddress ?? null,
    timedBuyExecutorExactSecond: Boolean(signed.timedBuyExecutorExactSecond),
    timedBuyExecutorTargetTimestamp: signed.timedBuyExecutorTargetTimestamp ?? null,
    tipTxHash: signed.preSignedBuilderBundleTipTransaction?.txHash ?? null,
    tipTo: signed.preSignedBuilderBundleTipTransaction?.to ?? null,
    tipBnb: signed.preSignedBuilderBundleTipTransaction?.valueBnb ?? null,
    tipGasPriceGwei: signed.preSignedBuilderBundleTipTransaction?.gasPriceGwei ?? null,
    tipPreSigned: Boolean(signed.preSignedBuilderBundleTipTransaction),
    tipNonceReleased: true,
    payloadPrebuilt: Boolean(signed.preSignedBuilderBundle?.payloadSkeleton),
    minTimestamp: signed.builderBundleMinTimestamp ?? null,
    maxTimestamp: signed.builderBundleMaxTimestamp ?? null,
    timingMode: cfg.builderBundleTimingMode ?? "legacy",
    targetSecond: signed.builderBundleTargetSecond ?? null,
    earlySubmitAtMs: signed.builderBundleEarlySubmitAtMs ?? null,
    error: "strict builder early submission was not completed before RPC fallback"
  };
}

async function submitBuilderBundleForSignedTransaction(cfg, signed, broadcastStartedAt) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  if (!builderBundleReady(cfg)) return null;
  assertStrictBuilderBundleWindow(cfg, signed);
  const startedAt = broadcastStartedAt ?? Date.now();
  const maxBlockLookupEnabled = Boolean(cfg.builderBundleMaxBlockLookup);
  let maxBlockNumber = null;
  let maxBlockLookupStartedAt = null;
  let maxBlockResolvedAt = null;
  let maxBlockLookupLatencyMs = null;
  if (maxBlockLookupEnabled) {
    const maxBlockLookupStartedAtMs = Date.now();
    maxBlockLookupStartedAt = new Date(maxBlockLookupStartedAtMs).toISOString();
    maxBlockNumber = await resolveBuilderBundleMaxBlockNumber(makeClients(cfg).publicClient, cfg);
    const maxBlockResolvedAtMs = Date.now();
    maxBlockResolvedAt = new Date(maxBlockResolvedAtMs).toISOString();
    maxBlockLookupLatencyMs = maxBlockResolvedAtMs - maxBlockLookupStartedAtMs;
  }
  const lookup = {
    maxBlockLookupEnabled,
    maxBlockNumber,
    maxBlockLookupStartedAt,
    maxBlockResolvedAt,
    maxBlockLookupLatencyMs
  };
  const targets = resolveBuilderBundleTargets(cfg);
  const targetResults = await Promise.all(targets.map((target) =>
    submitBuilderBundleTarget(cfg, target, signed, startedAt, lookup)
  ));
  const submitted = targetResults.filter((result) => result.submitted);
  const selected = [...submitted].sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt))[0]
    ?? targetResults[0]
    ?? null;
  if (!selected) return null;
  const result = {
    ...selected,
    submitted: submitted.length > 0,
    targetCount: targetResults.length,
    submittedTargetCount: submitted.length,
    targetResults,
    tipCandidates: targetResults.filter((item) => item.tipTxHash).map((item) => ({
      targetId: item.targetId,
      provider: item.provider,
      tipTxHash: item.tipTxHash,
      tipTo: item.tipTo,
      tipBnb: item.tipBnb
    })),
    error: submitted.length > 0
      ? null
      : targetResults.map((item) => `${item.provider}: ${item.error ?? "not submitted"}`).join(" | ")
  };
  const log = {
    level: result.submitted ? "builder-bundle-submitted" : "builder-bundle-error",
    provider: result.provider,
    buyTxHash: result.buyTxHash,
    tipTxHash: result.tipTxHash,
    tipBnb: result.tipBnb,
    targetCount: result.targetCount,
    submittedTargetCount: result.submittedTargetCount,
    targets: targetResults.map((item) => ({
      targetId: item.targetId,
      provider: item.provider,
      submitted: item.submitted,
      requestLatencyMs: item.requestLatencyMs ?? null,
      tipTxHash: item.tipTxHash ?? null,
      error: item.error ?? null
    })),
    minTimestamp: result.minTimestamp,
    maxTimestamp: result.maxTimestamp,
    acceptedAt: result.acceptedAt,
    latencyMs: result.latencyMs,
    message: result.error,
    at: new Date().toISOString()
  };
  (result.submitted ? console.log : console.error)(JSON.stringify(log));
  return result;
}

async function submitBuilderBundleTarget(cfg, target, signed, startedAt, lookup) {
  const preSignedTarget = signed?.preSignedBuilderBundleTargets?.find((item) => item.id === target.id) ?? null;
  const primaryTarget = resolveBuilderBundleTargets(cfg)[0];
  let tip = preSignedTarget?.tipTransaction ?? (
    target.id === primaryTarget?.id ? signed?.preSignedBuilderBundleTipTransaction : null
  );
  let tipSignedAt = signed?.builderBundleTipSignedAt ?? null;
  let tipSignLatencyMs = signed?.builderBundleTipSignLatencyMs ?? null;
  const tipPreSigned = Boolean(tip);
  try {
    if (!tip) {
      const tipSignStartedAt = Date.now();
      tip = await signBuilderBundleTipTransaction(cfg, makeClients(cfg).account, signed, target);
      const tipSignedAtMs = Date.now();
      tipSignedAt = new Date(tipSignedAtMs).toISOString();
      tipSignLatencyMs = tipSignedAtMs - tipSignStartedAt;
    }
    const payloadBuildStartedAt = Date.now();
    const payload = payloadForBuilderTarget(target, finalizeBuilderBundlePayload(
      cfg,
      preSignedTarget?.payloadSkeleton ?? (
        target.id === primaryTarget?.id && signed?.preSignedBuilderBundle?.payloadSkeleton
          ? signed.preSignedBuilderBundle.payloadSkeleton
          : buildBuilderBundlePayloadSkeleton(cfg, signed, tip)
      ),
      { maxBlockNumber: lookup.maxBlockNumber, nowMs: Date.now() }
    ));
    const payloadBuiltAtMs = Date.now();
    const response = await sendBuilderBundlePayload(cfg, target, payload, startedAt);
    return {
      submitted: true,
      targetId: target.id,
      provider: target.provider,
      acceptedAt: response.acceptedAt,
      latencyMs: response.latencyMs,
      requestStartedAt: response.requestStartedAt,
      requestLatencyMs: response.requestLatencyMs,
      bundleHash: response.bundleHash,
      buyTxHash: signed.txHash,
      ...builderTimeGateResultFields(signed),
      tipTxHash: tip.txHash,
      tipTo: tip.to,
      tipBnb: tip.valueBnb,
      tipGasPriceGwei: tip.gasPriceGwei,
      tipPreSigned,
      tipSignedAt,
      tipSignLatencyMs,
      payloadPrebuilt: Boolean(preSignedTarget?.payloadSkeleton || signed?.preSignedBuilderBundle?.payloadSkeleton),
      payloadBuiltAt: new Date(payloadBuiltAtMs).toISOString(),
      payloadBuildLatencyMs: payloadBuiltAtMs - payloadBuildStartedAt,
      ...lookup,
      txCount: payload.txs.length,
      minTimestamp: payload.minTimestamp ?? null,
      maxBlockNumber: payload.maxBlockNumber ?? null,
      maxTimestamp: payload.maxTimestamp ?? null,
      timingMode: cfg.builderBundleTimingMode ?? "legacy",
      targetSecond: signed?.builderBundleTargetSecond ?? null,
      targetBoundaryAtMs: signed?.builderBundleTargetBoundaryAtMs ?? null,
      targetBoundaryLeadMs: signed?.builderBundleTargetBoundaryLeadMs ?? null,
      publicFallbackLeadMs: signed?.builderBundlePublicFallbackLeadMs ?? null,
      earlySubmitAtMs: signed?.builderBundleEarlySubmitAtMs ?? null,
      noMerge: Boolean(payload.noMerge),
      positionFirst: Boolean(payload.positionFirst)
    };
  } catch (error) {
    return {
      submitted: false,
      targetId: target.id,
      provider: target.provider,
      buyTxHash: signed?.txHash ?? null,
      ...builderTimeGateResultFields(signed),
      tipTxHash: tip?.txHash ?? null,
      tipTo: tip?.to ?? target.tipTo,
      tipBnb: tip?.valueBnb ?? cfg.builderBundleTipBnb ?? null,
      tipGasPriceGwei: tip?.gasPriceGwei ?? cfg.builderBundleTipGasPriceGwei ?? null,
      tipPreSigned,
      payloadPrebuilt: Boolean(preSignedTarget?.payloadSkeleton || signed?.preSignedBuilderBundle?.payloadSkeleton),
      ...lookup,
      minTimestamp: signed?.builderBundleMinTimestamp ?? null,
      maxTimestamp: signed?.builderBundleMaxTimestamp ?? null,
      timingMode: cfg.builderBundleTimingMode ?? "legacy",
      targetSecond: signed?.builderBundleTargetSecond ?? null,
      targetBoundaryAtMs: signed?.builderBundleTargetBoundaryAtMs ?? null,
      targetBoundaryLeadMs: signed?.builderBundleTargetBoundaryLeadMs ?? null,
      publicFallbackLeadMs: signed?.builderBundlePublicFallbackLeadMs ?? null,
      earlySubmitAtMs: signed?.builderBundleEarlySubmitAtMs ?? null,
      noMerge: Boolean(cfg.builderBundleNoMerge),
      positionFirst: Boolean(cfg.builderBundlePositionFirst),
      error: conciseProviderError(error)
    };
  }
}

function builderTimeGateResultFields(signed) {
  return {
    timestampGuardEnabled: Boolean(signed?.preSignedTimestampGuardTransaction),
    timestampGuardAddress: signed?.preSignedTimestampGuardTransaction?.to ?? null,
    timestampGuardTxHash: signed?.preSignedTimestampGuardTransaction?.txHash ?? null,
    timestampGuardNonce: signed?.preSignedTimestampGuardTransaction?.nonce ?? null,
    timestampGuardTargetTimestamp: signed?.preSignedTimestampGuardTransaction?.targetTimestamp ?? null,
    timedBuyExecutorEnabled: Boolean(signed?.timedBuyExecutorEnabled),
    timedBuyExecutorAddress: signed?.timedBuyExecutorAddress ?? null,
    timedBuyExecutorExactSecond: Boolean(signed?.timedBuyExecutorExactSecond),
    timedBuyExecutorTargetTimestamp: signed?.timedBuyExecutorTargetTimestamp ?? null
  };
}

export async function submitPreSignedBuilderBundle(cfg, signed) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  const startedAtMs = Date.now();
  const timeGateRetry = builderTimeGateAttached(cfg, signed);
  const result = timeGateRetry
    ? await submitTimestampGuardBuilderRetries(cfg, signed, startedAtMs)
    : await submitBuilderBundleForSignedTransaction(cfg, signed, startedAtMs);
  if (!result) return null;
  return {
    ...result,
    earlySubmitted: true,
    earlySubmitStartedAt: new Date(startedAtMs).toISOString(),
    earlySubmitLeadMs: Number(cfg?.builderBundleEarlySubmitLeadMs ?? 0)
  };
}

async function submitTimestampGuardBuilderRetries(cfg, signed, startedAtMs) {
  const targetBoundaryAtMs = Number(signed?.builderBundleTargetBoundaryAtMs);
  if (!Number.isFinite(targetBoundaryAtMs) || targetBoundaryAtMs <= startedAtMs) {
    return submitBuilderBundleForSignedTransaction(cfg, signed, startedAtMs);
  }
  const retryIntervalMs = Math.max(25, Number(cfg.builderTimestampGuardRetryIntervalMs ?? 100));
  const retryUntilLeadMs = Math.max(0, Number(cfg.builderTimestampGuardRetryUntilLeadMs ?? 0));
  const finalAttemptAtMs = targetBoundaryAtMs - retryUntilLeadMs;
  const targets = [startedAtMs];
  for (let targetMs = startedAtMs + retryIntervalMs; targetMs <= finalAttemptAtMs; targetMs += retryIntervalMs) {
    targets.push(targetMs);
  }
  if (targets.at(-1) < finalAttemptAtMs) targets.push(finalAttemptAtMs);

  const attempts = await Promise.all(targets.map(async (targetMs) => {
    if (Date.now() < targetMs) await sleepMs(targetMs - Date.now());
    return submitBuilderBundleForSignedTransaction(cfg, signed, Date.now());
  }));
  const selected = attempts.find((attempt) => attempt?.submitted) ?? attempts.at(-1) ?? null;
  if (!selected) return null;
  return {
    ...selected,
    retryAttemptCount: attempts.length,
    retrySubmittedCount: attempts.filter((attempt) => attempt?.submitted).length,
    retryRejectedCount: attempts.filter((attempt) => attempt && !attempt.submitted).length,
    retryFirstStartedAt: attempts[0]?.requestStartedAt ?? null,
    retryLastAcceptedAt: attempts.at(-1)?.acceptedAt ?? null
  };
}

async function preSignBuilderBundleForSignedTransaction(cfg, account, signed) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  if (!builderBundleReady(cfg)) return null;
  assertStrictBuilderBundleWindow(cfg, signed);
  const tipSignStartedAt = Date.now();
  const targetBundles = await Promise.all(resolveBuilderBundleTargets(cfg).map(async (target) => {
    const tipTransaction = await signBuilderBundleTipTransaction(cfg, account, signed, target);
    return {
      id: target.id,
      provider: target.provider,
      tipTransaction,
      payloadSkeleton: buildBuilderBundlePayloadSkeleton(cfg, signed, tipTransaction)
    };
  }));
  const tipSignedAtMs = Date.now();
  const primary = targetBundles[0];
  if (!primary) throw new Error("Builder pre-sign requires at least one target");
  const tip = primary.tipTransaction;
  const payloadSkeleton = primary.payloadSkeleton;
  return {
    preSignedBuilderBundleTipTransaction: tip,
    preSignedBuilderBundleTargets: targetBundles,
    preSignedBuilderBundle: {
      targetId: primary.id,
      provider: primary.provider,
      buyTxHash: signed.txHash,
      buyNonce: Number(signed.nonce),
      timestampGuardEnabled: Boolean(signed.preSignedTimestampGuardTransaction),
      timestampGuardAddress: signed.preSignedTimestampGuardTransaction?.to ?? null,
      timestampGuardTxHash: signed.preSignedTimestampGuardTransaction?.txHash ?? null,
      timestampGuardNonce: signed.preSignedTimestampGuardTransaction?.nonce ?? null,
      timestampGuardTargetTimestamp: signed.preSignedTimestampGuardTransaction?.targetTimestamp ?? null,
      timedBuyExecutorEnabled: Boolean(signed.timedBuyExecutorEnabled),
      timedBuyExecutorAddress: signed.timedBuyExecutorAddress ?? null,
      timedBuyExecutorExactSecond: Boolean(signed.timedBuyExecutorExactSecond),
      timedBuyExecutorTargetTimestamp: signed.timedBuyExecutorTargetTimestamp ?? null,
      tipTxHash: tip.txHash,
      tipNonce: tip.nonce,
      tipTo: tip.to,
      tipBnb: tip.valueBnb,
      tipGasPriceGwei: tip.gasPriceGwei,
      txCount: payloadSkeleton.txs.length,
      minTimestamp: payloadSkeleton.minTimestamp ?? null,
      maxTimestamp: payloadSkeleton.maxTimestamp ?? null,
      targetSecond: signed.builderBundleTargetSecond ?? null,
      targetBoundaryAtMs: signed.builderBundleTargetBoundaryAtMs ?? null,
      targetBoundaryLeadMs: signed.builderBundleTargetBoundaryLeadMs ?? null,
      publicFallbackLeadMs: signed.builderBundlePublicFallbackLeadMs ?? null,
      earlySubmitAtMs: signed.builderBundleEarlySubmitAtMs ?? null,
      payloadSkeleton,
      noMerge: Boolean(payloadSkeleton.noMerge),
      positionFirst: Boolean(payloadSkeleton.positionFirst),
      preparedAt: new Date(tipSignedAtMs).toISOString()
    },
    builderBundleTipPreSigned: true,
    builderBundleTipSignedAt: new Date(tipSignedAtMs).toISOString(),
    builderBundleTipSignLatencyMs: tipSignedAtMs - tipSignStartedAt,
    builderBundlePayloadPrebuilt: true,
    builderBundleTargetCount: targetBundles.length
  };
}

export async function buildBuilderBundleDryRun(cfg, signed, options = {}) {
  cfg = applyBuilderBundleTimingPreset(cfg);
  if (!builderBundleReady(cfg)) {
    return {
      enabled: Boolean(cfg?.builderBundleEnabled),
      ready: false,
      reason: builderBundleDisabledReason(cfg)
    };
  }
  assertStrictBuilderBundleWindow(cfg, signed);
  const { account } = makeClients(cfg);
  const targets = await Promise.all(resolveBuilderBundleTargets(cfg).map(async (target) => {
    const preSigned = signed.preSignedBuilderBundleTargets?.find((item) => item.id === target.id) ?? null;
    const tip = preSigned?.tipTransaction ?? (
      target.id === "48club" ? signed.preSignedBuilderBundleTipTransaction : null
    ) ?? await signBuilderBundleTipTransaction(cfg, account, signed, target);
    const payload = payloadForBuilderTarget(target, buildBuilderBundlePayload(cfg, signed, tip, {
      maxBlockNumber: options.maxBlockNumber ?? 123456789,
      nowMs: options.nowMs ?? Date.now()
    }));
    return {
      targetId: target.id,
      provider: target.provider,
      txCount: payload.txs.length,
      minTimestamp: payload.minTimestamp ?? null,
      maxBlockNumber: payload.maxBlockNumber ?? null,
      maxTimestamp: payload.maxTimestamp ?? null,
      tipTxHash: tip.txHash,
      tipNonce: tip.nonce,
      tipTo: tip.to,
      tipBnb: tip.valueBnb,
      tipGasPriceGwei: tip.gasPriceGwei,
      noMerge: Boolean(payload.noMerge),
      positionFirst: Boolean(payload.positionFirst)
    };
  }));
  const primary = targets[0];
  return {
    enabled: true,
    ready: true,
    provider: primary.provider,
    targetCount: targets.length,
    targets,
    txCount: primary.txCount,
    minTimestamp: primary.minTimestamp,
    maxBlockNumber: primary.maxBlockNumber,
    maxTimestamp: primary.maxTimestamp,
    timingMode: cfg.builderBundleTimingMode ?? "legacy",
    targetSecond: signed.builderBundleTargetSecond ?? null,
    buyTxHash: signed.txHash,
    buyNonce: Number(signed.nonce),
    timestampGuardEnabled: Boolean(signed.preSignedTimestampGuardTransaction),
    timestampGuardAddress: signed.preSignedTimestampGuardTransaction?.to ?? null,
    timestampGuardTxHash: signed.preSignedTimestampGuardTransaction?.txHash ?? null,
    timestampGuardNonce: signed.preSignedTimestampGuardTransaction?.nonce ?? null,
    timestampGuardTargetTimestamp: signed.preSignedTimestampGuardTransaction?.targetTimestamp ?? null,
    timedBuyExecutorEnabled: Boolean(signed.timedBuyExecutorEnabled),
    timedBuyExecutorAddress: signed.timedBuyExecutorAddress ?? null,
    timedBuyExecutorExactSecond: Boolean(signed.timedBuyExecutorExactSecond),
    timedBuyExecutorTargetTimestamp: signed.timedBuyExecutorTargetTimestamp ?? null,
    tipTxHash: primary.tipTxHash,
    tipNonce: primary.tipNonce,
    tipTo: primary.tipTo,
    tipBnb: primary.tipBnb,
    tipGasPriceGwei: primary.tipGasPriceGwei,
    tipPreSigned: Boolean(signed.preSignedBuilderBundleTipTransaction),
    payloadPrebuilt: Boolean(signed.preSignedBuilderBundle?.payloadSkeleton),
    noMerge: primary.noMerge,
    positionFirst: primary.positionFirst
  };
}

function assertStrictBuilderBundleWindow(cfg, signed) {
  const timing = cfg?.builderBundleTimingResolved ?? resolveBuilderBundleTimingPreset(cfg);
  if (!timing.strict) return;
  const maxTimestamp = Number(signed?.builderBundleMaxTimestamp);
  if (!Number.isSafeInteger(maxTimestamp) || maxTimestamp <= 0) {
    throw new Error("targeted builder bundle requires maxTimestamp for the target second");
  }
  if (cfg.builderTimestampGuardEnabled && !cfg.builderTimedBuyExecutorEnabled) {
    const minTimestamp = Number(signed?.builderBundleMinTimestamp);
    const guardTarget = Number(signed?.preSignedTimestampGuardTransaction?.targetTimestamp);
    if (!Number.isSafeInteger(minTimestamp) || minTimestamp !== maxTimestamp) {
      throw new Error("guarded Builder bundle requires minTimestamp=maxTimestamp at the target second");
    }
    if (!Number.isSafeInteger(guardTarget) || guardTarget !== maxTimestamp) {
      throw new Error("guarded Builder bundle transaction target does not match maxTimestamp");
    }
  }
  if (cfg.builderTimedBuyExecutorEnabled) {
    const minTimestamp = Number(signed?.builderBundleMinTimestamp);
    const executorTarget = Number(signed?.timedBuyExecutorTargetTimestamp);
    if (cfg.builderTimedBuyExecutorExactSecond) {
      if (
        !Number.isSafeInteger(minTimestamp) ||
        !Number.isSafeInteger(executorTarget) ||
        minTimestamp !== executorTarget ||
        maxTimestamp !== executorTarget + 1
      ) {
        throw new Error("exact-second Builder buy requires minTimestamp=target and maxTimestamp=target+1");
      }
    } else {
      if (!Number.isSafeInteger(minTimestamp) || minTimestamp !== maxTimestamp) {
        throw new Error("timed Builder buy requires minTimestamp=maxTimestamp at the target second");
      }
      if (!Number.isSafeInteger(executorTarget) || executorTarget !== maxTimestamp) {
        throw new Error("timed Builder buy transaction target does not match maxTimestamp");
      }
    }
  }
}

function builderBundleReady(cfg) {
  return !builderBundleDisabledReason(cfg);
}

function builderBundleMode(cfg) {
  const mode = String(cfg?.builderBundleMode ?? "concurrent")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  if (mode === "builder_only") return "builder_only";
  if (mode === "builder_then_fanout") return "builder_then_fanout";
  return "concurrent";
}

function effectiveBuilderBundleMode(cfg) {
  return builderBundleReady(cfg) ? builderBundleMode(cfg) : "concurrent";
}

function builderBundleFanoutDelayMs(cfg) {
  const value = Number(cfg?.builderBundleFanoutDelayMs ?? 120);
  if (!Number.isFinite(value)) return 120;
  return Math.max(0, value);
}

function builderBundleDisabledReason(cfg) {
  if (cfg?.builderBundleKillSwitch) return "kill-switch";
  if (!cfg?.builderBundleEnabled) {
    if (cfg?.builderBundleRequestedEnabled) {
      return cfg.builderBundleTimingDisabledReason || "timing-disabled";
    }
    return "disabled";
  }
  if (!cfg.builderBundleUrl) return "missing-url";
  if (!cfg.privateKey) return "missing-private-key";
  const tipBnb = Number(cfg.builderBundleTipBnb);
  if (!Number.isFinite(tipBnb) || tipBnb <= 0) return "missing-tip";
  if (!cfg.builderBundleTipTo) return "missing-tip-address";
  return "";
}

async function submitBuilderOnlyBroadcast(cfg, signed, mode, rpcCount, broadcastStartedAt) {
  let inFlight = signed?.preSubmittedBuilderBundlePromise ?? null;
  let preSubmitted = signed?.preSubmittedBuilderBundle ?? (inFlight ? await inFlight : null);
  let builderBundle = preSubmitted;
  if (!builderBundle?.submitted) {
    inFlight = signed.preSubmittedBuilderBundlePromise ?? submitBuilderBundleForSignedTransaction(
      cfg,
      signed,
      broadcastStartedAt
    );
    signed.preSubmittedBuilderBundlePromise = inFlight;
    try {
      builderBundle = await inFlight;
      if (builderBundle?.submitted) signed.preSubmittedBuilderBundle = builderBundle;
    } finally {
      if (signed.preSubmittedBuilderBundlePromise === inFlight) {
        delete signed.preSubmittedBuilderBundlePromise;
      }
    }
  }
  if (builderBundle?.submitted) {
    return builderOnlyBroadcastResult(signed, builderBundle, mode, rpcCount, broadcastStartedAt, {
      publicBroadcastSkipped: true
    });
  }
  const reason = builderBundle?.error || builderBundleDisabledReason(cfg) || "not-submitted";
  throw new Error(`Builder-only broadcast failed before public RPC fallback: ${reason}`);
}

async function waitForBuilderBundleBeforeFanout(builderBundlePromise, delayMs) {
  if (!builderBundlePromise || delayMs <= 0) return { timedOut: true, builderBundle: null };
  let timer = null;
  try {
    return await Promise.race([
      builderBundlePromise.then((builderBundle) => ({
        timedOut: false,
        builderBundle: builderBundle ?? null
      })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, builderBundle: null }), delayMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function builderTimestampGuardRequired(cfg) {
  return Boolean(builderBundleReady(cfg) && cfg.builderTimestampGuardEnabled);
}

function builderTimestampGuardAttached(cfg, signed) {
  return Boolean(cfg?.builderTimestampGuardEnabled && signed?.preSignedTimestampGuardTransaction);
}

function builderTimedBuyExecutorRequired(cfg) {
  return Boolean(builderBundleReady(cfg) && cfg.builderTimedBuyExecutorEnabled);
}

function builderTimedBuyExecutorAttached(cfg, signed) {
  return Boolean(
    cfg?.builderTimedBuyExecutorEnabled &&
    signed?.timedBuyExecutorEnabled &&
    signed?.timedBuyExecutorAddress &&
    Number.isSafeInteger(Number(signed?.timedBuyExecutorTargetTimestamp))
  );
}

function builderTimeGateAttached(cfg, signed) {
  return builderTimestampGuardAttached(cfg, signed) || builderTimedBuyExecutorAttached(cfg, signed);
}

async function assertTimedBuyExecutorReady(publicClient, accountAddress, requiredAmount, cfg) {
  const address = getAddress(cfg.builderTimedBuyExecutorAddress);
  const owner = getAddress(accountAddress);
  const exactSecond = Boolean(cfg.builderTimedBuyExecutorExactSecond);
  const expectedCodeHash = exactSecond
    ? EXACT_TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH
    : TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH;
  const codeMatches = exactSecond ? exactTimedBuyExecutorCodeMatches : timedBuyExecutorCodeMatches;
  const key = `${bsc.id}:${address.toLowerCase()}:${expectedCodeHash}`;
  if (!timedBuyExecutorCodeChecks.has(key)) {
    const code = await publicClient.getCode({ address });
    if (!codeMatches(code)) {
      const actualHash = code && code !== "0x" ? keccak256(code) : null;
      throw new Error(`Timed buy executor code mismatch expected=${expectedCodeHash} actual=${actualHash}`);
    }
    timedBuyExecutorCodeChecks.add(key);
  }
  const [operator, allowance] = await Promise.all([
    publicClient.readContract({
      address,
      abi: TIMED_BUY_EXECUTOR_ABI,
      functionName: "operators",
      args: [owner]
    }),
    publicClient.readContract({
      address: ADDRESSES.busdt,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, address]
    })
  ]);
  if (!operator) throw new Error(`Bot wallet ${owner} is not an enabled timed buy executor operator`);
  if (allowance < BigInt(requiredAmount)) {
    throw new Error(
      `BUSDT allowance to timed buy executor ${formatUnits(allowance, 18)} is below required ${formatUnits(BigInt(requiredAmount), 18)}`
    );
  }
}

async function assertTimestampGuardCode(publicClient, cfg) {
  const address = getAddress(cfg.builderTimestampGuardAddress);
  const key = `${bsc.id}:${address.toLowerCase()}:${TIMESTAMP_GUARD_RUNTIME_CODE_HASH}`;
  if (timestampGuardCodeChecks.has(key)) return;
  const code = await publicClient.getCode({ address });
  if (!timestampGuardCodeMatches(code)) {
    const actualHash = code && code !== "0x" ? keccak256(code) : null;
    throw new Error(`Builder timestamp guard code mismatch expected=${TIMESTAMP_GUARD_RUNTIME_CODE_HASH} actual=${actualHash}`);
  }
  timestampGuardCodeChecks.add(key);
}

async function signTimestampGuardTransaction(cfg, account, signed, nonce, gasPrice) {
  const targetTimestamp = Number(signed?.builderBundleMaxTimestamp);
  if (!Number.isSafeInteger(targetTimestamp) || targetTimestamp <= 0) {
    throw new Error("Builder timestamp guard requires a positive target timestamp");
  }
  const to = getAddress(cfg.builderTimestampGuardAddress);
  const gas = BigInt(cfg.builderTimestampGuardGasLimit ?? 50000);
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to,
    data: encodeTimestampGuardCall(targetTimestamp),
    gas,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy"
  });
  return {
    serializedTransaction,
    txHash: keccak256(serializedTransaction),
    nonce,
    to,
    targetTimestamp,
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    gasPriceGwei: formatUnits(gasPrice, 9)
  };
}

function rememberTimestampGuardFallbackTransactions(signed) {
  const guard = signed?.preSignedTimestampGuardTransaction;
  if (!guard || !signed?.txHash || !signed?.serializedTransaction) return;
  const key = String(signed.txHash).toLowerCase();
  timestampGuardFallbackTransactions.set(key, {
    guard: { ...guard },
    buy: {
      txHash: signed.txHash,
      serializedTransaction: signed.serializedTransaction,
      nonce: signed.nonce,
      gas: signed.gas ?? null,
      gasPrice: signed.gasPrice ?? null
    },
    targetTimestamp: guard.targetTimestamp,
    preparedAt: signed.preparedAt ?? new Date().toISOString()
  });
  while (timestampGuardFallbackTransactions.size > 256) {
    timestampGuardFallbackTransactions.delete(timestampGuardFallbackTransactions.keys().next().value);
  }
}

async function signBuilderBundleTipTransaction(cfg, account, signed, target = resolveBuilderBundleTargets(cfg)[0]) {
  if (signed?.nonce === undefined || signed?.nonce === null || signed?.nonce === "") {
    throw new Error("builder bundle tip requires the buy transaction nonce");
  }
  const nonce = Number(signed.nonce) + 1;
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`invalid builder bundle tip nonce from buy nonce ${signed.nonce}`);
  }
  if (!target) throw new Error("builder bundle tip requires at least one configured Builder target");
  const to = getAddress(target.tipTo);
  const value = parseUnits(String(cfg.builderBundleTipBnb), 18);
  if (value <= 0n) throw new Error("BUILDER_BUNDLE_TIP_BNB must be positive to submit builder bundle");
  const gasPrice = parseGwei(String(cfg.builderBundleTipGasPriceGwei || cfg.gasPriceGwei || "1"));
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to,
    value,
    gas: BUILDER_BUNDLE_TIP_GAS_LIMIT,
    gasPrice,
    nonce,
    type: "legacy"
  });
  return {
    serializedTransaction,
    txHash: keccak256(serializedTransaction),
    nonce,
    to,
    targetId: target.id,
    provider: target.provider,
    value: value.toString(),
    valueBnb: formatUnits(value, 18),
    gas: BUILDER_BUNDLE_TIP_GAS_LIMIT.toString(),
    gasPrice: gasPrice.toString(),
    gasPriceGwei: formatUnits(gasPrice, 9)
  };
}

async function resolveBuilderBundleMaxBlockNumber(publicClient, cfg) {
  const timeoutMs = Math.max(50, Math.min(Number(cfg.builderBundleTimeoutMs ?? 500), 500));
  const urls = [...new Set((cfg.broadcastRpcUrls?.length ? cfg.broadcastRpcUrls : [cfg.rpcUrl]).filter(Boolean))];
  if (urls.length > 0) {
    try {
      const blockNumber = await withTimeout(
        Promise.any(urls.map(async (url) => getBroadcastClient(url).getBlockNumber())),
        timeoutMs,
        "builder bundle broadcast RPC block number timeout"
      );
      return Number(blockNumber) + Number(cfg.builderBundleMaxBlocks ?? 3);
    } catch {}
  }
  try {
    const blockNumber = await withTimeout(
      publicClient.getBlockNumber(),
      timeoutMs,
      "builder bundle block number timeout"
    );
    return Number(blockNumber) + Number(cfg.builderBundleMaxBlocks ?? 3);
  } catch {
    return null;
  }
}

function buildBuilderBundlePayload(cfg, signed, tip, { maxBlockNumber = null, nowMs = Date.now() } = {}) {
  return finalizeBuilderBundlePayload(cfg, buildBuilderBundlePayloadSkeleton(cfg, signed, tip), {
    maxBlockNumber,
    nowMs
  });
}

function buildBuilderBundlePayloadSkeleton(cfg, signed, tip) {
  const guard = signed?.preSignedTimestampGuardTransaction ?? null;
  if (cfg.builderTimestampGuardEnabled && !cfg.builderTimedBuyExecutorEnabled && !guard) {
    throw new Error("Builder timestamp guard is enabled but the pre-signed guard transaction is missing");
  }
  if (cfg.builderTimedBuyExecutorEnabled && !builderTimedBuyExecutorAttached(cfg, signed)) {
    throw new Error("Timed buy executor is enabled but the pre-signed atomic buy transaction is missing");
  }
  const payload = {
    txs: [guard?.serializedTransaction, signed.serializedTransaction, tip.serializedTransaction].filter(Boolean)
  };
  if (Number.isSafeInteger(Number(signed?.builderBundleMinTimestamp)) && Number(signed.builderBundleMinTimestamp) > 0) {
    payload.minTimestamp = Number(signed.builderBundleMinTimestamp);
  }
  if (Number.isSafeInteger(Number(signed?.builderBundleMaxTimestamp)) && Number(signed.builderBundleMaxTimestamp) > 0) {
    payload.maxTimestamp = Number(signed.builderBundleMaxTimestamp);
  }
  if (cfg.builderBundleNoMerge) payload.noMerge = true;
  if (cfg.builderBundlePositionFirst) payload.positionFirst = true;
  if (cfg.builderBundle48spSign) payload["48spSign"] = String(cfg.builderBundle48spSign);
  return payload;
}

function resolveBuilderBundleTimestampWindow(cfg, markets = []) {
  if (!cfg?.builderBundleEnabled) return null;
  const starts = markets
    .map((market) => Date.parse(market?.startDate ?? ""))
    .filter(Number.isFinite);
  if (starts.length === 0) return null;

  const timing = cfg?.builderBundleTimingResolved ?? resolveBuilderBundleTimingPreset(cfg);
  if (!timing.strict) return null;
  if (!timing.eligible || !Number.isSafeInteger(Number(timing.targetSecond))) return null;
  const targetTimestamps = starts.map((startMs) => Math.ceil((startMs + timing.targetSecond * 1000) / 1000));
  const targetBoundaryTimes = starts.map((startMs) => startMs + timing.targetSecond * 1000);
  const earlySubmitTimes = starts.map((startMs) => startMs + timing.earlySubmitOffsetMs);
  if (
    new Set(targetTimestamps).size !== 1 ||
    new Set(targetBoundaryTimes).size !== 1 ||
    new Set(earlySubmitTimes).size !== 1
  ) {
    throw new Error("targeted builder bundle requires all markets to share one target timestamp");
  }
  const executorTargetTimestamp = targetTimestamps[0];
  const exactSecond = Boolean(
    cfg.builderTimedBuyExecutorEnabled && cfg.builderTimedBuyExecutorExactSecond
  );
  return {
    minTimestamp: cfg.builderTimestampGuardEnabled || cfg.builderTimedBuyExecutorEnabled
      ? executorTargetTimestamp
      : null,
    maxTimestamp: exactSecond ? executorTargetTimestamp + 1 : executorTargetTimestamp,
    executorTargetTimestamp,
    exactSecond,
    targetSecond: timing.targetSecond,
    targetBoundaryAtMs: targetBoundaryTimes[0],
    targetBoundaryLeadMs: timing.targetBoundaryLeadMs,
    publicFallbackLeadMs: timing.publicFallbackLeadMs,
    earlySubmitAtMs: earlySubmitTimes[0],
    timingMode: timing.mode
  };
}

function applyBuilderBundleTimestampWindow(signed, window) {
  if (!signed || !window) return signed;
  if (window.minTimestamp) signed.builderBundleMinTimestamp = window.minTimestamp;
  if (window.maxTimestamp) signed.builderBundleMaxTimestamp = window.maxTimestamp;
  if (window.targetSecond) signed.builderBundleTargetSecond = window.targetSecond;
  if (window.targetBoundaryAtMs) signed.builderBundleTargetBoundaryAtMs = window.targetBoundaryAtMs;
  if (window.targetBoundaryLeadMs) signed.builderBundleTargetBoundaryLeadMs = window.targetBoundaryLeadMs;
  if (window.publicFallbackLeadMs) signed.builderBundlePublicFallbackLeadMs = window.publicFallbackLeadMs;
  if (window.earlySubmitAtMs) signed.builderBundleEarlySubmitAtMs = window.earlySubmitAtMs;
  signed.builderBundleTimingMode = window.timingMode;
  return signed;
}

function finalizeBuilderBundlePayload(cfg, payloadSkeleton, { maxBlockNumber = null, nowMs = Date.now() } = {}) {
  const strictMaxTimestamp = Number(payloadSkeleton?.maxTimestamp);
  const payload = {
    ...payloadSkeleton,
    txs: [...(payloadSkeleton?.txs ?? [])],
    maxTimestamp: Number.isSafeInteger(strictMaxTimestamp) && strictMaxTimestamp > 0
      ? strictMaxTimestamp
      : Math.floor(nowMs / 1000) + Number(cfg.builderBundleMaxTimestampOffsetSeconds ?? 10)
  };
  if (Number.isSafeInteger(Number(maxBlockNumber)) && Number(maxBlockNumber) > 0) {
    payload.maxBlockNumber = Number(maxBlockNumber);
  }
  return payload;
}

function payloadForBuilderTarget(target, payload) {
  if (target.id !== "blockrazor") return payload;
  const providerPayload = Object.fromEntries([
    "txs",
    "minTimestamp",
    "maxTimestamp",
    "maxBlockNumber",
    "noMerge",
    "positionFirst"
  ].filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
  if (
    Number.isSafeInteger(Number(providerPayload.minTimestamp)) &&
    Number(providerPayload.minTimestamp) === Number(providerPayload.maxTimestamp)
  ) {
    delete providerPayload.minTimestamp;
  }
  return providerPayload;
}

function builderRequestHeaders(target) {
  const headers = { "content-type": "application/json" };
  if (target?.authToken) headers.Authorization = target.authToken;
  return headers;
}

async function sendBuilderBundlePayload(cfg, target, payload, broadcastStartedAt) {
  if (typeof fetch !== "function") throw new Error("global fetch is unavailable for builder bundle submission");
  const controller = new AbortController();
  const timeoutMs = Number(cfg.builderBundleTimeoutMs ?? 500);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestStartedAtMs = Date.now();
    const response = await fetch(target.url, {
      method: "POST",
      headers: builderRequestHeaders(target),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "eth_sendBundle",
        params: [payload]
      }),
      signal: controller.signal
    });
    const acceptedAtMs = Date.now();
    const text = await response.text();
    if (!response.ok) throw new Error(`builder bundle HTTP ${response.status}: ${text.slice(0, 200)}`);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`builder bundle returned non-JSON response: ${text.slice(0, 200)}`);
    }
    if (json?.error) {
      throw new Error(`builder bundle error ${json.error.code ?? ""}: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return {
      acceptedAt: new Date(acceptedAtMs).toISOString(),
      latencyMs: acceptedAtMs - broadcastStartedAt,
      requestStartedAt: new Date(requestStartedAtMs).toISOString(),
      requestLatencyMs: acceptedAtMs - requestStartedAtMs,
      bundleHash: typeof json?.result === "string"
        ? json.result
        : (json?.result?.bundleHash ?? json?.result?.bundle_hash ?? null)
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`builder bundle timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function builderBundleResultFields(builderBundle) {
  if (!builderBundle) return {};
  return {
    builderBundleEnabled: true,
    builderBundleSubmitted: Boolean(builderBundle.submitted),
    builderBundleProvider: builderBundle.provider ?? null,
    builderBundleAcceptedAt: builderBundle.acceptedAt ?? null,
    builderBundleLatencyMs: builderBundle.latencyMs ?? null,
    builderBundleRequestStartedAt: builderBundle.requestStartedAt ?? null,
    builderBundleRequestLatencyMs: builderBundle.requestLatencyMs ?? null,
    builderBundleHash: builderBundle.bundleHash ?? null,
    builderBundleBuyTxHash: builderBundle.buyTxHash ?? null,
    builderTimestampGuardEnabled: Boolean(builderBundle.timestampGuardEnabled),
    builderTimestampGuardAddress: builderBundle.timestampGuardAddress ?? null,
    builderTimestampGuardTxHash: builderBundle.timestampGuardTxHash ?? null,
    builderTimestampGuardNonce: builderBundle.timestampGuardNonce ?? null,
    builderTimestampGuardTargetTimestamp: builderBundle.timestampGuardTargetTimestamp ?? null,
    builderTimedBuyExecutorEnabled: Boolean(builderBundle.timedBuyExecutorEnabled),
    builderTimedBuyExecutorAddress: builderBundle.timedBuyExecutorAddress ?? null,
    builderTimedBuyExecutorExactSecond: Boolean(builderBundle.timedBuyExecutorExactSecond),
    builderTimedBuyExecutorTargetTimestamp: builderBundle.timedBuyExecutorTargetTimestamp ?? null,
    builderBundleTipTxHash: builderBundle.tipTxHash ?? null,
    builderBundleTipTo: builderBundle.tipTo ?? null,
    builderBundleTipBnb: builderBundle.tipBnb ?? null,
    builderBundleTipGasPriceGwei: builderBundle.tipGasPriceGwei ?? null,
    builderBundleTipPreSigned: builderBundle.tipPreSigned ?? null,
    builderBundleTipSignedAt: builderBundle.tipSignedAt ?? null,
    builderBundleTipSignLatencyMs: builderBundle.tipSignLatencyMs ?? null,
    builderBundleTipNonceReleased: Boolean(builderBundle.tipNonceReleased),
    builderBundleTargetCount: builderBundle.targetCount ?? null,
    builderBundleSubmittedTargetCount: builderBundle.submittedTargetCount ?? null,
    builderBundleTargetResults: builderBundle.targetResults ?? null,
    builderBundleTipCandidates: builderBundle.tipCandidates ?? null,
    builderBundlePayloadPrebuilt: builderBundle.payloadPrebuilt ?? null,
    builderBundlePayloadBuiltAt: builderBundle.payloadBuiltAt ?? null,
    builderBundlePayloadBuildLatencyMs: builderBundle.payloadBuildLatencyMs ?? null,
    builderBundleMaxBlockLookupEnabled: builderBundle.maxBlockLookupEnabled ?? null,
    builderBundleMaxBlockLookupStartedAt: builderBundle.maxBlockLookupStartedAt ?? null,
    builderBundleMaxBlockResolvedAt: builderBundle.maxBlockResolvedAt ?? null,
    builderBundleMaxBlockLookupLatencyMs: builderBundle.maxBlockLookupLatencyMs ?? null,
    builderBundleTxCount: builderBundle.txCount ?? null,
    builderBundleMinTimestamp: builderBundle.minTimestamp ?? null,
    builderBundleMaxBlockNumber: builderBundle.maxBlockNumber ?? null,
    builderBundleMaxTimestamp: builderBundle.maxTimestamp ?? null,
    builderBundleTimingMode: builderBundle.timingMode ?? null,
    builderBundleTargetSecond: builderBundle.targetSecond ?? null,
    builderBundleTargetBoundaryAtMs: builderBundle.targetBoundaryAtMs ?? null,
    builderBundleTargetBoundaryLeadMs: builderBundle.targetBoundaryLeadMs ?? null,
    builderBundlePublicFallbackLeadMs: builderBundle.publicFallbackLeadMs ?? null,
    builderBundleEarlySubmitAtMs: builderBundle.earlySubmitAtMs ?? null,
    builderBundleNoMerge: builderBundle.noMerge ?? null,
    builderBundlePositionFirst: builderBundle.positionFirst ?? null,
    builderBundleEarlySubmitted: Boolean(builderBundle.earlySubmitted),
    builderBundleEarlySubmitStartedAt: builderBundle.earlySubmitStartedAt ?? null,
    builderBundleEarlySubmitLeadMs: builderBundle.earlySubmitLeadMs ?? null,
    builderTimestampGuardRetryAttemptCount: builderBundle.retryAttemptCount ?? null,
    builderTimestampGuardRetrySubmittedCount: builderBundle.retrySubmittedCount ?? null,
    builderTimestampGuardRetryRejectedCount: builderBundle.retryRejectedCount ?? null,
    builderTimestampGuardRetryFirstStartedAt: builderBundle.retryFirstStartedAt ?? null,
    builderTimestampGuardRetryLastAcceptedAt: builderBundle.retryLastAcceptedAt ?? null,
    builderBundleError: builderBundle.error ?? null
  };
}

function broadcastBuilderBundleResultFields(broadcast) {
  if (
    !broadcast ||
    (
      !broadcast.builderBundleEnabled &&
      !broadcast.builderBundleSubmitted &&
      !broadcast.builderBundleTipTxHash &&
      !broadcast.builderBundleError
    )
  ) {
    return {};
  }
  return {
    builderBundleEnabled: Boolean(broadcast.builderBundleEnabled),
    builderBundleSubmitted: Boolean(broadcast.builderBundleSubmitted),
    builderBundleProvider: broadcast.builderBundleProvider ?? null,
    builderBundleAcceptedAt: broadcast.builderBundleAcceptedAt ?? null,
    builderBundleLatencyMs: broadcast.builderBundleLatencyMs ?? null,
    builderBundleRequestStartedAt: broadcast.builderBundleRequestStartedAt ?? null,
    builderBundleRequestLatencyMs: broadcast.builderBundleRequestLatencyMs ?? null,
    builderBundleHash: broadcast.builderBundleHash ?? null,
    builderBundleBuyTxHash: broadcast.builderBundleBuyTxHash ?? null,
    builderTimestampGuardEnabled: Boolean(broadcast.builderTimestampGuardEnabled),
    builderTimestampGuardAddress: broadcast.builderTimestampGuardAddress ?? null,
    builderTimestampGuardTxHash: broadcast.builderTimestampGuardTxHash ?? null,
    builderTimestampGuardNonce: broadcast.builderTimestampGuardNonce ?? null,
    builderTimestampGuardTargetTimestamp: broadcast.builderTimestampGuardTargetTimestamp ?? null,
    builderTimedBuyExecutorEnabled: Boolean(broadcast.builderTimedBuyExecutorEnabled),
    builderTimedBuyExecutorAddress: broadcast.builderTimedBuyExecutorAddress ?? null,
    builderTimedBuyExecutorExactSecond: Boolean(broadcast.builderTimedBuyExecutorExactSecond),
    builderTimedBuyExecutorTargetTimestamp: broadcast.builderTimedBuyExecutorTargetTimestamp ?? null,
    builderBundleTipTxHash: broadcast.builderBundleTipTxHash ?? null,
    builderBundleTipTo: broadcast.builderBundleTipTo ?? null,
    builderBundleTipBnb: broadcast.builderBundleTipBnb ?? null,
    builderBundleTipGasPriceGwei: broadcast.builderBundleTipGasPriceGwei ?? null,
    builderBundleTipPreSigned: broadcast.builderBundleTipPreSigned ?? null,
    builderBundleTipSignedAt: broadcast.builderBundleTipSignedAt ?? null,
    builderBundleTipSignLatencyMs: broadcast.builderBundleTipSignLatencyMs ?? null,
    builderBundleTipNonceReleased: Boolean(broadcast.builderBundleTipNonceReleased),
    builderBundleTargetCount: broadcast.builderBundleTargetCount ?? null,
    builderBundleSubmittedTargetCount: broadcast.builderBundleSubmittedTargetCount ?? null,
    builderBundleTargetResults: broadcast.builderBundleTargetResults ?? null,
    builderBundleTipCandidates: broadcast.builderBundleTipCandidates ?? null,
    builderBundlePayloadPrebuilt: broadcast.builderBundlePayloadPrebuilt ?? null,
    builderBundlePayloadBuiltAt: broadcast.builderBundlePayloadBuiltAt ?? null,
    builderBundlePayloadBuildLatencyMs: broadcast.builderBundlePayloadBuildLatencyMs ?? null,
    builderBundleMaxBlockLookupEnabled: broadcast.builderBundleMaxBlockLookupEnabled ?? null,
    builderBundleMaxBlockLookupStartedAt: broadcast.builderBundleMaxBlockLookupStartedAt ?? null,
    builderBundleMaxBlockResolvedAt: broadcast.builderBundleMaxBlockResolvedAt ?? null,
    builderBundleMaxBlockLookupLatencyMs: broadcast.builderBundleMaxBlockLookupLatencyMs ?? null,
    builderBundleTxCount: broadcast.builderBundleTxCount ?? null,
    builderBundleMinTimestamp: broadcast.builderBundleMinTimestamp ?? null,
    builderBundleMaxBlockNumber: broadcast.builderBundleMaxBlockNumber ?? null,
    builderBundleMaxTimestamp: broadcast.builderBundleMaxTimestamp ?? null,
    builderBundleTimingMode: broadcast.builderBundleTimingMode ?? null,
    builderBundleTargetSecond: broadcast.builderBundleTargetSecond ?? null,
    builderBundleTargetBoundaryAtMs: broadcast.builderBundleTargetBoundaryAtMs ?? null,
    builderBundleTargetBoundaryLeadMs: broadcast.builderBundleTargetBoundaryLeadMs ?? null,
    builderBundlePublicFallbackLeadMs: broadcast.builderBundlePublicFallbackLeadMs ?? null,
    builderBundleEarlySubmitAtMs: broadcast.builderBundleEarlySubmitAtMs ?? null,
    builderBundleNoMerge: broadcast.builderBundleNoMerge ?? null,
    builderBundlePositionFirst: broadcast.builderBundlePositionFirst ?? null,
    builderBundleEarlySubmitted: Boolean(broadcast.builderBundleEarlySubmitted),
    builderBundleEarlySubmitStartedAt: broadcast.builderBundleEarlySubmitStartedAt ?? null,
    builderBundleEarlySubmitLeadMs: broadcast.builderBundleEarlySubmitLeadMs ?? null,
    builderTimestampGuardRetryAttemptCount: broadcast.builderTimestampGuardRetryAttemptCount ?? null,
    builderTimestampGuardRetrySubmittedCount: broadcast.builderTimestampGuardRetrySubmittedCount ?? null,
    builderTimestampGuardRetryRejectedCount: broadcast.builderTimestampGuardRetryRejectedCount ?? null,
    builderTimestampGuardRetryFirstStartedAt: broadcast.builderTimestampGuardRetryFirstStartedAt ?? null,
    builderTimestampGuardRetryLastAcceptedAt: broadcast.builderTimestampGuardRetryLastAcceptedAt ?? null,
    builderBundleFanoutDelayMs: broadcast.builderBundleFanoutDelayMs ?? null,
    builderBundlePublicFanoutDelayed: Boolean(broadcast.builderBundlePublicFanoutDelayed),
    builderBundlePublicFanoutWhileInFlight: Boolean(broadcast.builderBundlePublicFanoutWhileInFlight),
    builderBundleWaitTimedOut: broadcast.builderBundleWaitTimedOut ?? null,
    builderTimedBuyExecutorFallbackReleasedAt: broadcast.builderTimedBuyExecutorFallbackReleasedAt ?? null,
    builderTimedBuyExecutorFallbackBlockNumber: broadcast.builderTimedBuyExecutorFallbackBlockNumber ?? null,
    builderTimedBuyExecutorFallbackBlockTimestamp: broadcast.builderTimedBuyExecutorFallbackBlockTimestamp ?? null,
    builderBundleError: broadcast.builderBundleError ?? null
  };
}

function builderOnlyBroadcastResult(signed, builderBundle, mode, rpcCount, broadcastStartedAt, options = {}) {
  const publicBroadcastSkipped = Boolean(options.publicBroadcastSkipped);
  return {
    txHash: signed.txHash,
    mode,
    rpcCount,
    firstProvider: builderBundle.provider ?? null,
    firstAlreadyKnown: false,
    publicBroadcastSkipped,
    publicBroadcastFailed: !publicBroadcastSkipped,
    broadcastStartedAt: earliestBroadcastStartedAt(builderBundle, broadcastStartedAt),
    publicBroadcastStartedAt: publicBroadcastSkipped ? null : new Date(broadcastStartedAt).toISOString(),
    firstAcceptedAt: builderBundle.acceptedAt ?? null,
    firstAcceptedLatencyMs: builderBundle.latencyMs ?? null,
    gas: signed.gas ?? null,
    gasPrice: signed.gasPrice ?? null,
    gasPriceGwei: signed.gasPrice ? formatUnits(BigInt(signed.gasPrice), 9) : null,
    nonce: signed.nonce ?? null,
    rebroadcastIntervalMs: null,
    rebroadcastDurationMs: null,
    builderBundleFanoutDelayMs: options.builderBundleFanoutDelayMs ?? null,
    builderBundlePublicFanoutDelayed: Boolean(options.builderBundlePublicFanoutDelayed),
    builderBundlePublicFanoutWhileInFlight: Boolean(options.builderBundlePublicFanoutWhileInFlight),
    builderBundleWaitTimedOut: options.builderBundleWaitTimedOut ?? null,
    builderTimedBuyExecutorFallbackReleasedAt: options.timedFallback?.releasedAt ?? null,
    builderTimedBuyExecutorFallbackBlockNumber: options.timedFallback?.observedBlockNumber ?? null,
    builderTimedBuyExecutorFallbackBlockTimestamp: options.timedFallback?.observedBlockTimestamp ?? null,
    ...builderBundleResultFields(builderBundle)
  };
}

function earliestBroadcastStartedAt(builderBundle, publicBroadcastStartedAtMs) {
  const builderStartedAtMs = Date.parse(
    builderBundle?.requestStartedAt ?? builderBundle?.earlySubmitStartedAt ?? ""
  );
  const publicStartedAtMs = Number(publicBroadcastStartedAtMs);
  if (Number.isFinite(builderStartedAtMs) && Number.isFinite(publicStartedAtMs)) {
    return new Date(Math.min(builderStartedAtMs, publicStartedAtMs)).toISOString();
  }
  if (Number.isFinite(builderStartedAtMs)) return new Date(builderStartedAtMs).toISOString();
  return new Date(publicStartedAtMs).toISOString();
}

function buildRawTransactionFanoutAttempts(urls, serializedTransaction, txHash, timeoutMs, broadcastStartedAt) {
  return urls.map((url) => {
    const provider = providerLabel(url);
    return sendRawTransactionVia(url, serializedTransaction, txHash, timeoutMs, broadcastStartedAt)
      .catch((error) => {
        error.provider = provider;
        throw error;
      });
  });
}

function logRawTransactionFanoutSettled(level, txHash, attempts) {
  if (!attempts?.length) return;
  void Promise.allSettled(attempts).then((settled) => {
    const results = settled.map((item) => {
      if (item.status === "fulfilled") {
        return {
          provider: item.value.provider ?? null,
          status: item.value.alreadyKnown ? "already_known" : "accepted",
          latencyMs: item.value.latencyMs ?? null
        };
      }
      return {
        provider: item.reason?.provider ?? null,
        status: "rejected",
        message: conciseProviderError(item.reason)
      };
    });
    console.log(JSON.stringify({
      level,
      txHash,
      rpcCount: settled.length,
      accepted: results.filter((item) => item.status === "accepted" || item.status === "already_known").length,
      alreadyKnown: results.filter((item) => item.status === "already_known").length,
      rejected: results.filter((item) => item.status === "rejected").length,
      results,
      at: new Date().toISOString()
    }));
  }).catch(() => {});
}

function scheduleRawTransactionRebroadcast(cfg, signed, urls, firstProvider) {
  const intervalMs = Number(cfg.rebroadcastIntervalMs ?? 0);
  const durationMs = Number(cfg.rebroadcastDurationMs ?? 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;

  const startedAt = Date.now();
  const strictTargetEndMs = Number.isSafeInteger(Number(signed?.builderBundleMaxTimestamp))
    ? (Number(signed.builderBundleMaxTimestamp) + 1) * 1000
    : null;
  const deadline = strictTargetEndMs
    ? Math.min(startedAt + durationMs, strictTargetEndMs)
    : startedAt + durationMs;
  if (deadline <= startedAt) return;
  let round = 0;
  const activeUrls = [...new Set(urls.filter(Boolean))];

  const tick = () => {
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({
        level: "raw-tx-rebroadcast-done",
        txHash: signed.txHash,
        rounds: round,
        durationMs,
        effectiveDurationMs: deadline - startedAt,
        strictTargetEndAt: strictTargetEndMs ? new Date(strictTargetEndMs).toISOString() : null,
        firstProvider
      }));
      return;
    }
    round += 1;
    void Promise.allSettled(activeUrls.map((url) =>
      sendRawTransactionVia(url, signed.serializedTransaction, signed.txHash, cfg.broadcastTimeoutMs)
    )).then((settled) => {
      const accepted = settled.filter((item) => item.status === "fulfilled").length;
      const rejected = settled.length - accepted;
      if (round === 1 || rejected > 0) {
        console.log(JSON.stringify({
          level: "raw-tx-rebroadcast",
          txHash: signed.txHash,
          round,
          accepted,
          rejected,
          rpcCount: activeUrls.length
        }));
      }
    });
    setTimeout(tick, intervalMs).unref?.();
  };

  setTimeout(tick, intervalMs).unref?.();
}

function shouldReusePreSignedNonce(preSignedError) {
  if (!preSignedError) return false;
  return !/nonce too low|nonce has already been used|already used|invalid nonce|replacement transaction underpriced|nonce is too low/i.test(
    String(preSignedError)
  );
}

function reserveRuntimeNonce(runtime) {
  const nonce = runtime.nextNonce;
  runtime.nextNonce += 1;
  return nonce;
}

function restoreRuntimeNonce(runtime, reservedNonce) {
  if (!runtime || reservedNonce === null || reservedNonce === undefined) return;
  if (runtime.nextNonce === reservedNonce + 1) {
    runtime.nextNonce = reservedNonce;
  }
  runtime.lastNonceSyncAt = 0;
}

async function waitForReceiptWithConfig(cfg, txHash) {
  const { publicClient } = makeClients(cfg);
  return publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: cfg.receiptWatchTimeoutMs,
    pollingInterval: cfg.receiptWatchPollingMs
  });
}

function receiptGasFields(receipt, prefix = "") {
  if (!receipt?.gasUsed || !receipt?.effectiveGasPrice) return {};
  const gasUsed = BigInt(receipt.gasUsed);
  const effectiveGasPrice = BigInt(receipt.effectiveGasPrice);
  const gasFeeWei = gasUsed * effectiveGasPrice;
  const fields = {
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    gasFeeWei: gasFeeWei.toString(),
    gasFeeBnb: formatUnits(gasFeeWei, 18)
  };
  if (!prefix) return fields;
  const capitalized = prefix[0].toUpperCase() + prefix.slice(1);
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`${prefix}${capitalized ? key[0].toUpperCase() + key.slice(1) : key}`, value])
  );
}

async function getFreshPendingNonce(publicClient, account, runtime = null) {
  const nonce = Number(await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending"
  }));
  if (runtime?.nextNonce !== undefined) {
    runtime.nextNonce = Math.max(runtime.nextNonce, nonce + 1);
    runtime.lastNonceSyncAt = Date.now();
  }
  return nonce;
}

async function sendRawTransactionVia(url, serializedTransaction, txHash, timeoutMs, broadcastStartedAt = Date.now()) {
  const client = getBroadcastClient(url);
  try {
    const sentHash = await withTimeout(
      client.sendRawTransaction({ serializedTransaction }),
      timeoutMs,
      `sendRawTransaction timeout after ${timeoutMs}ms`
    );
    const acceptedAt = Date.now();
    return {
      txHash: sentHash,
      provider: providerLabel(url),
      acceptedAt: new Date(acceptedAt).toISOString(),
      latencyMs: acceptedAt - broadcastStartedAt
    };
  } catch (error) {
    if (/already known|already imported|known transaction|transaction already/i.test(error?.message ?? "")) {
      const acceptedAt = Date.now();
      return {
        txHash,
        provider: providerLabel(url),
        alreadyKnown: true,
        acceptedAt: new Date(acceptedAt).toISOString(),
        latencyMs: acceptedAt - broadcastStartedAt
      };
    }
    throw error;
  }
}

function getBroadcastClient(url) {
  const key = String(url);
  let client = broadcastClients.get(key);
  if (!client) {
    client = createPublicClient({
      chain: bsc,
      transport: http(key)
    });
    broadcastClients.set(key, client);
  }
  return client;
}

function bestWarmProvider(results) {
  const ok = results
    .filter((item) => item.ok)
    .sort((a, b) => a.latencyMs - b.latencyMs);
  return ok[0]?.provider ?? null;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function buyOutcome(cfg, plan) {
  const { publicClient, walletClient, account } = makeClients(cfg);
  const quote = await simulateMint(publicClient, {
    market: plan.market.address,
    tokenId: plan.outcome.tokenId,
    stakeUsdt: plan.stakeUsdt
  });
  const batchPlan = {
    ...plan,
    action: "mint_single_outcome",
    stakePerOutcomeUsdt: plan.stakeUsdt,
    totalStakeUsdt: plan.stakeUsdt,
    outcomes: [{ ...plan.outcome, stakeUsdt: plan.stakeUsdt, simulated: quote, minOut: applySlippage(quote.otToUser, cfg.slippageBps) }]
  };
  void walletClient;
  void account;
  return buyOutcomesBatch(cfg, batchPlan);
}

export async function quoteSellOutcome(publicClient, {
  market,
  tokenId,
  owner,
  amountOt,
  percent = 100,
  slippageBps = 800,
  operatorApproved: knownOperatorApproved
}) {
  const marketAddress = getAddress(market);
  const ownerAddress = getAddress(owner);
  const id = BigInt(tokenId);
  const balance = await publicClient.readContract({
    address: marketAddress,
    abi: marketV2Abi,
    functionName: "balanceOf",
    args: [ownerAddress, id]
  });
  const amount = amountOt === undefined || amountOt === null || amountOt === ""
    ? applyPercent(balance, percent)
    : roundDownSellAmount(parseUnits(String(amountOt), 18));
  if (amount <= 0n) throw new Error("Sell amount is zero");
  if (amount > balance) {
    throw new Error(`Sell amount ${formatUnits(amount, 18)} exceeds outcome balance ${formatUnits(balance, 18)}`);
  }

  const [operatorApproved, collateralOutRaw] = await Promise.all([
    typeof knownOperatorApproved === "boolean"
      ? Promise.resolve(knownOperatorApproved)
      : publicClient.readContract({
          address: marketAddress,
          abi: marketV2Abi,
          functionName: "isOperator",
          args: [ownerAddress, ADDRESSES.routerProxy]
        }),
    publicClient.simulateContract({
      address: marketAddress,
      abi: marketV2Abi,
      functionName: "redeemExactOtToCollateral",
      account: ownerAddress,
      args: [ownerAddress, id, amount, "0x"]
    })
  ]);
  const collateralOutBeforeIntegrator = collateralOutRaw.result;
  const collateralToIntegrator = (collateralOutBeforeIntegrator * INTEGRATOR_FEE_BPS) / 10_000n;
  const expectedCollateralToUser = collateralOutBeforeIntegrator - collateralToIntegrator;
  const minCollateralOut = applySlippage(expectedCollateralToUser, slippageBps);

  return {
    market: marketAddress,
    owner: ownerAddress,
    tokenId: id.toString(),
    balance,
    amount,
    percent: Number(percent),
    operatorApproved,
    collateralOutBeforeIntegrator,
    collateralToIntegrator,
    expectedCollateralToUser,
    minCollateralOut,
    slippageBps
  };
}

export async function buildDirectSellPlan(publicClient, { market, tokenId, owner, amountOt, percent = 100 }) {
  const marketAddress = getAddress(market);
  const ownerAddress = getAddress(owner);
  const id = BigInt(tokenId);
  const balance = await publicClient.readContract({
    address: marketAddress,
    abi: marketV2Abi,
    functionName: "balanceOf",
    args: [ownerAddress, id]
  });
  const amount = amountOt === undefined || amountOt === null || amountOt === ""
    ? applyPercent(balance, percent)
    : roundDownSellAmount(parseUnits(String(amountOt), 18));
  if (amount <= 0n) throw new Error("Sell amount is zero");
  if (amount > balance) {
    throw new Error(`Sell amount ${formatUnits(amount, 18)} exceeds outcome balance ${formatUnits(balance, 18)}`);
  }
  const operatorApproved = await publicClient.readContract({
    address: marketAddress,
    abi: marketV2Abi,
    functionName: "isOperator",
    args: [ownerAddress, ADDRESSES.routerProxy]
  });

  return {
    market: marketAddress,
    owner: ownerAddress,
    tokenId: id.toString(),
    balance,
    amount,
    percent: Number(percent),
    operatorApproved,
    collateralOutBeforeIntegrator: 0n,
    collateralToIntegrator: 0n,
    expectedCollateralToUser: 0n,
    minCollateralOut: 1n,
    slippageBps: 10000,
    directNoQuote: true
  };
}

export async function sellOutcome(cfg, sellPlan) {
  assertSellExecutionAllowed(cfg, sellPlan);
  const { publicClient, walletClient, account } = makeClients(cfg);
  const receiver = getAddress(cfg.walletAddress || account.address);
  const market = getAddress(sellPlan.market);
  const tokenId = BigInt(sellPlan.tokenId);
  const amount = sellPlan.amount;
  const minOut = sellPlan.minCollateralOut;

  const currentBalance = await publicClient.readContract({
    address: market,
    abi: marketV2Abi,
    functionName: "balanceOf",
    args: [account.address, tokenId]
  });
  if (currentBalance < amount) {
    throw new Error(`Outcome balance ${formatUnits(currentBalance, 18)} is below sell amount ${formatUnits(amount, 18)}`);
  }

  let operatorApprovalHash = null;
  let operatorApprovalReceipt = null;
  let operatorApproved = sellPlan.operatorApproved;
  if (!operatorApproved) {
    operatorApproved = await publicClient.readContract({
      address: market,
      abi: marketV2Abi,
      functionName: "isOperator",
      args: [account.address, ADDRESSES.routerProxy]
    });
  }
  if (!operatorApproved) {
    operatorApprovalHash = await walletClient.writeContract({
      address: market,
      abi: marketV2Abi,
      functionName: "setOperator",
      args: [ADDRESSES.routerProxy, true],
      ...sellGasPriceOverride(cfg)
    });
    operatorApprovalReceipt = await publicClient.waitForTransactionReceipt({ hash: operatorApprovalHash });
    operatorApproved = operatorApprovalReceipt.status === "success";
  }

  const args = [
    market,
    receiver,
    tokenId,
    [false, amount, true, minOut],
    "0x",
    "0x",
    ADDRESSES.integrator,
    INTEGRATOR_FEE_BPS
  ];
  const simulated = await publicClient.simulateContract({
    address: ADDRESSES.routerProxy,
    abi: routerAbi,
    functionName: "swap",
    args,
    account: account.address
  });
  const request = {
    ...simulated.request,
    account,
    ...sellGasPriceOverride(cfg)
  };
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    operatorApprovalHash,
    operatorApproved,
    operatorApprovalStatus: operatorApprovalReceipt?.status ?? null,
    operatorApprovalBlockNumber: operatorApprovalReceipt?.blockNumber?.toString() ?? null,
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString() ?? null,
    market,
    receiver,
    tokenId: tokenId.toString(),
    amountOt: formatUnits(amount, 18),
    minCollateralOut: formatUnits(minOut, 18),
    expectedCollateralToUser: formatUnits(sellPlan.expectedCollateralToUser, 18),
    slippageBps: sellPlan.slippageBps,
    ...receiptGasFields(operatorApprovalReceipt, "operatorApproval"),
    ...receiptGasFields(receipt)
  };
}

export async function isMarketOperatorApproved(publicClient, { owner, market }) {
  return publicClient.readContract({
    address: getAddress(market),
    abi: marketV2Abi,
    functionName: "isOperator",
    args: [getAddress(owner), ADDRESSES.routerProxy]
  });
}

export async function ensureMarketOperatorApproval(cfg, marketAddress) {
  assertSellExecutionAllowed(cfg);
  const { publicClient, walletClient, account } = makeClients(cfg);
  const market = getAddress(marketAddress);
  const alreadyApproved = await isMarketOperatorApproved(publicClient, {
    owner: account.address,
    market
  });
  if (alreadyApproved) {
    return {
      market,
      operatorApproved: true,
      approved: false,
      txHash: null,
      status: "ready"
    };
  }

  const txHash = await walletClient.writeContract({
    address: market,
    abi: marketV2Abi,
    functionName: "setOperator",
    args: [ADDRESSES.routerProxy, true],
    ...sellGasPriceOverride(cfg)
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return {
    market,
    operatorApproved: receipt.status === "success",
    approved: receipt.status === "success",
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString() ?? null,
    ...receiptGasFields(receipt)
  };
}

export async function sellOutcomesBatch(cfg, sellPlans, options = {}) {
  assertSellExecutionAllowed(cfg);
  const plans = Array.isArray(sellPlans) ? sellPlans : [];
  if (plans.length === 0) throw new Error("sellOutcomesBatch requires at least one sell plan");
  const requirePreapprovedOperator = Boolean(options.requirePreapprovedOperator);

  const { publicClient, walletClient, account } = makeClients(cfg);
  const receiver = getAddress(cfg.walletAddress || account.address);
  const markets = [...new Set(plans.map((plan) => getAddress(plan.market)))];

  const approvals = [];
  for (const market of markets) {
    let approved = await isMarketOperatorApproved(publicClient, {
      owner: account.address,
      market
    });
    let operatorApprovalHash = null;
    if (!approved && requirePreapprovedOperator) {
      throw new Error(`Operator approval missing for market ${market}`);
    }
    if (!approved) {
      operatorApprovalHash = await walletClient.writeContract({
        address: market,
        abi: marketV2Abi,
        functionName: "setOperator",
        args: [ADDRESSES.routerProxy, true],
        ...sellGasPriceOverride(cfg)
      });
      const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: operatorApprovalHash });
      approved = true;
      approvals.push({
        market,
        operatorApproved: approved,
        operatorApprovalHash,
        ...receiptGasFields(approvalReceipt, "operatorApproval")
      });
      continue;
    }
    approvals.push({ market, operatorApproved: approved, operatorApprovalHash });
  }

  const calls = [];
  const positions = [];
  for (const plan of plans) {
    const market = getAddress(plan.market);
    const tokenId = BigInt(plan.tokenId);
    const amount = plan.amount;
    const currentBalance = await publicClient.readContract({
      address: market,
      abi: marketV2Abi,
      functionName: "balanceOf",
      args: [account.address, tokenId]
    });
    if (currentBalance < amount) {
      throw new Error(`Outcome balance ${formatUnits(currentBalance, 18)} is below sell amount ${formatUnits(amount, 18)}`);
    }

    const minOut = plan.minCollateralOut > 0n ? plan.minCollateralOut : 1n;
    calls.push({
      allowFailure: false,
      callData: encodeFunctionData({
        abi: routerAbi,
        functionName: "swap",
        args: [
          market,
          receiver,
          tokenId,
          [false, amount, true, minOut],
          "0x",
          "0x",
          ADDRESSES.integrator,
          INTEGRATOR_FEE_BPS
        ]
      })
    });
    positions.push({
      market,
      tokenId: tokenId.toString(),
      amountOt: formatUnits(amount, 18),
      minCollateralOut: formatUnits(minOut, 18),
      expectedCollateralToUser: formatUnits(plan.expectedCollateralToUser ?? 0n, 18),
      directNoQuote: Boolean(plan.directNoQuote)
    });
  }

  const gas = 1500000n + 1000000n * BigInt(plans.length);
  const txHash = await walletClient.writeContract({
    address: ADDRESSES.routerProxy,
    abi: routerAbi,
    functionName: "multicall",
    args: [calls],
    account,
    gas,
    ...sellGasPriceOverride(cfg)
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString() ?? null,
    receiver,
    approvals,
    positions,
    gas: gas.toString(),
    marketCount: markets.length,
    positionCount: positions.length,
    requirePreapprovedOperator,
    ...receiptGasFields(receipt)
  };
}

export async function preSignSellOutcomesBatch(cfg, sellPlans, runtime = null, options = {}) {
  assertSellExecutionAllowed(cfg);
  const plans = Array.isArray(sellPlans) ? sellPlans : [];
  if (plans.length === 0) throw new Error("preSignSellOutcomesBatch requires at least one sell plan");
  const requirePreapprovedOperator = Boolean(options.requirePreapprovedOperator);
  if (requirePreapprovedOperator) {
    const missing = plans.find((plan) => !plan.operatorApproved);
    if (missing) throw new Error(`Operator approval missing for market ${missing.market}`);
  }

  const { publicClient, account } = makeClients(cfg);
  const receiver = getAddress(cfg.walletAddress || account.address);
  const calls = [];
  const positions = [];

  for (const plan of plans) {
    const market = getAddress(plan.market);
    const tokenId = BigInt(plan.tokenId);
    const amount = plan.amount;
    const minOut = plan.minCollateralOut > 0n ? plan.minCollateralOut : 1n;
    if (amount <= 0n) throw new Error(`Sell amount is zero for tokenId ${tokenId.toString()}`);
    calls.push({
      allowFailure: false,
      callData: encodeFunctionData({
        abi: routerAbi,
        functionName: "swap",
        args: [
          market,
          receiver,
          tokenId,
          [false, amount, true, minOut],
          "0x",
          "0x",
          ADDRESSES.integrator,
          INTEGRATOR_FEE_BPS
        ]
      })
    });
    positions.push({
      market,
      tokenId: tokenId.toString(),
      amountOt: formatUnits(amount, 18),
      minCollateralOut: formatUnits(minOut, 18),
      expectedCollateralToUser: formatUnits(plan.expectedCollateralToUser ?? 0n, 18),
      directNoQuote: Boolean(plan.directNoQuote)
    });
  }

  const gas = 1500000n + 1000000n * BigInt(plans.length);
  const gasPrice = cfg.autoSellGasPriceGwei || cfg.gasPriceGwei
    ? parseGwei(String(cfg.autoSellGasPriceGwei || cfg.gasPriceGwei))
    : await publicClient.getGasPrice();
  const nonce = runtime?.nextNonce !== undefined
    ? runtime.nextNonce
    : await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending"
      });
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "multicall",
    args: [calls]
  });
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to: ADDRESSES.routerProxy,
    data,
    gas,
    gasPrice,
    nonce,
    value: 0n,
    type: "legacy"
  });
  if (runtime?.nextNonce !== undefined) runtime.nextNonce += 1;
  const txHash = keccak256(serializedTransaction);

  return {
    txHash,
    serializedTransaction,
    nonce,
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    gasPriceGwei: formatUnits(gasPrice, 9),
    receiver,
    positions,
    marketCount: new Set(plans.map((plan) => getAddress(plan.market))).size,
    positionCount: positions.length,
    requirePreapprovedOperator,
    preparedAt: new Date().toISOString()
  };
}

export async function broadcastSignedTransaction(cfg, signed) {
  return broadcastPreSignedFastTransaction(cfg, signed);
}

export function describePlan(plan) {
  return {
    dryRun: plan.dryRun,
    action: "mint",
    strategy: plan.strategy,
    reason: plan.reason,
    market: {
      question: plan.market.question,
      address: plan.market.address,
      startDate: plan.market.startDate,
      endDate: plan.market.endDate,
      contractVersion: plan.market.contractVersion,
      curve: plan.market.curve
    },
    outcome: {
      tokenId: plan.outcome.tokenId,
      name: plan.outcome.name,
      price: plan.outcome.price,
      payout: plan.outcome.payout,
      mintedQuantity: plan.outcome.mintedQuantity,
      volume: plan.outcome.volume
    },
    stakeUsdt: plan.stakeUsdt,
    slippageBps: plan.slippageBps,
    source: plan.source
  };
}

export function describeFastBundlePlan(bundle, overrides = {}) {
  return {
    dryRun: overrides.dryRun ?? bundle.dryRun,
    action: bundle.action,
    marketCount: bundle.marketCount,
    outcomeCount: bundle.outcomeCount,
    totalStakeUsdt: bundle.totalStakeUsdt,
    totalAmount: formatUnits(bundle.totalAmount, 18),
    source: bundle.source,
    markets: bundle.markets
  };
}

export function describeSellPlan(plan, overrides = {}) {
  return {
    dryRun: overrides.dryRun ?? true,
    action: "redeem_outcome",
    market: plan.market,
    owner: plan.owner,
    tokenId: plan.tokenId,
    balanceOt: formatUnits(plan.balance, 18),
    sellAmountOt: formatUnits(plan.amount, 18),
    percent: plan.percent,
    operatorApproved: plan.operatorApproved,
    wouldSetOperator: !plan.operatorApproved,
    collateralOutBeforeIntegrator: formatUnits(plan.collateralOutBeforeIntegrator, 18),
    collateralToIntegrator: formatUnits(plan.collateralToIntegrator, 18),
    expectedCollateralToUser: formatUnits(plan.expectedCollateralToUser, 18),
    minCollateralOut: formatUnits(plan.minCollateralOut, 18),
    slippageBps: plan.slippageBps,
    route: "FTRouterProxy.swap(isMint=false, isExactIn=true)"
  };
}

export function describeEventPlan(plan) {
  return {
    dryRun: plan.dryRun,
    action: plan.action,
    market: {
      question: plan.market.question,
      address: plan.market.address,
      status: plan.market.status,
      createdAt: plan.market.createdAt,
      startDate: plan.market.startDate,
      endDate: plan.market.endDate,
      contractVersion: plan.market.contractVersion,
      curve: plan.market.curve,
      categories: plan.market.categories ?? [],
      tags: plan.market.tags ?? [],
      oddsHydratedFrom: plan.market.oddsHydratedFrom ?? null,
      oddsHydrationError: plan.market.oddsHydrationError ?? null,
      oddsHydrationSkipped: plan.market.oddsHydrationSkipped ?? null
    },
    stakePerOutcomeUsdt: plan.stakePerOutcomeUsdt,
    stakeByOutcomeUsdt: plan.stakeByOutcomeUsdt ?? {},
    maxStakePerOutcomeUsdt: plan.maxStakePerOutcomeUsdt ?? plan.stakePerOutcomeUsdt,
    totalStakeUsdt: plan.totalStakeUsdt,
    slippageBps: plan.slippageBps,
    selection: plan.selection ?? null,
    outcomes: plan.outcomes.map((outcome) => formatPlannedOutcome(outcome)),
    source: plan.source
  };
}

export function assertExecutionAllowed(cfg, plan, { checkMarketStake = true } = {}) {
  if (cfg.dryRun || !cfg.execute) {
    throw new Error("Refusing real buy: set DRY_RUN=0 and EXECUTE=1");
  }
  if (cfg.riskAck !== "YES") {
    throw new Error("Refusing real buy: set I_UNDERSTAND_42_PRICE_MARKET_RISK=YES");
  }
  if (cfg.eligibilityAck !== "YES") {
    throw new Error("Refusing real buy: set I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES");
  }
  if (!cfg.privateKey) {
    throw new Error("PRIVATE_KEY is required for real buy");
  }
  if (plan.stakeUsdt && plan.stakeUsdt > cfg.maxStakeUsdt) {
    throw new Error("Plan stake exceeds MAX_STAKE_USDT");
  }
  if (plan.stakePerOutcomeUsdt && plan.stakePerOutcomeUsdt > cfg.maxStakeUsdt) {
    throw new Error("Plan per-outcome stake exceeds MAX_STAKE_USDT");
  }
  const maxOutcomeStakeUsdt = Math.max(0, ...(plan.outcomes ?? []).map((outcome) => Number(outcome?.stakeUsdt ?? 0)));
  if (maxOutcomeStakeUsdt > cfg.maxStakeUsdt) {
    throw new Error("Plan outcome stake exceeds MAX_STAKE_USDT");
  }
  if (checkMarketStake && plan.totalStakeUsdt && plan.totalStakeUsdt > cfg.maxMarketStakeUsdt) {
    throw new Error("Plan total stake exceeds MAX_MARKET_STAKE_USDT");
  }
}

function assertSellExecutionAllowed(cfg) {
  if (cfg.dryRun || !cfg.execute) {
    throw new Error("Refusing real sell: set DRY_RUN=0 and EXECUTE=1");
  }
  if (cfg.riskAck !== "YES") {
    throw new Error("Refusing real sell: set I_UNDERSTAND_42_PRICE_MARKET_RISK=YES");
  }
  if (cfg.eligibilityAck !== "YES") {
    throw new Error("Refusing real sell: set I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES");
  }
  if (!cfg.privateKey) {
    throw new Error("PRIVATE_KEY is required for real sell");
  }
}

function applySlippage(value, bps) {
  return (value * BigInt(10_000 - bps)) / 10_000n;
}

function applyPercent(value, percent) {
  const bps = BigInt(Math.floor(Number(percent) * 100));
  if (bps <= 0n || bps > 10_000n) throw new Error("percent must be > 0 and <= 100");
  if (bps === 10_000n) return roundDownSellAmount(value);
  const amount = (value * bps) / 10_000n;
  return roundDownSellAmount(amount);
}

export function roundDownSellAmount(amount) {
  const minStep = 10n ** 16n; // 0.01 outcome token; partial redeems revert below this precision.
  if (amount < minStep) return 0n;
  return (amount / minStep) * minStep;
}

async function ensureBusdtAllowance(publicClient, walletClient, owner, amount) {
  const allowance = await publicClient.readContract({
    address: ADDRESSES.busdt,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, ADDRESSES.routerProxy]
  });
  if (allowance >= amount) {
    return {
      allowance: formatUnits(allowance, 18),
      approveHash: null,
      resetHash: null
    };
  }

  let resetHash = null;
  let resetReceipt = null;
  if (allowance > 0n) {
    resetHash = await walletClient.writeContract({
      address: ADDRESSES.busdt,
      abi: erc20Abi,
      functionName: "approve",
      args: [ADDRESSES.routerProxy, 0n]
    });
    resetReceipt = await publicClient.waitForTransactionReceipt({ hash: resetHash });
  }

  const approveHash = await walletClient.writeContract({
    address: ADDRESSES.busdt,
    abi: erc20Abi,
    functionName: "approve",
    args: [ADDRESSES.routerProxy, MAX_UINT256]
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  return {
    allowance: formatUnits(allowance, 18),
    approveHash,
    approveStatus: approveReceipt.status,
    approveBlockNumber: approveReceipt.blockNumber?.toString() ?? null,
    resetHash,
    resetStatus: resetReceipt?.status ?? null,
    resetBlockNumber: resetReceipt?.blockNumber?.toString() ?? null,
    ...receiptGasFields(approveReceipt, "approve"),
    ...receiptGasFields(resetReceipt, "reset")
  };
}

function encodeDataGuess(otDeltaGuessOffchain, maxIterations, eps) {
  return encodeAbiParameters(dataGuessAbi, [otDeltaGuessOffchain, maxIterations, eps]);
}

function smartEps(amountUsdt) {
  const amount = Number(amountUsdt);
  if (amount < 5) return parseUnits("0.2", 18);
  if (amount <= 3000) return parseUnits("0.001", 18);
  return BigInt(Math.floor((1 / amount) * 1e18));
}

function resolveFastPlanGasLimit(cfg, plan) {
  return resolveSingleFastGasLimit(cfg, plan?.outcomes?.length ?? cfg.eventOutcomeCount ?? 1);
}

async function fastTransactionOptions(cfg, publicClient, account, isFastPlan, plan = null) {
  if (!isFastPlan) return {};
  const options = {};
  const gasPrice = cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : await publicClient.getGasPrice();
  const desiredGasLimit = plan ? resolveFastPlanGasLimit(cfg, plan) : BigInt(cfg.fastGasLimit);
  if (desiredGasLimit > 0n) {
    options.gas = await resolveExecutionGasLimit(publicClient, account.address, cfg, desiredGasLimit, gasPrice);
  }
  options.gasPrice = gasPrice;
  return options;
}

function providerLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function conciseProviderError(error) {
  const message = error?.shortMessage ?? error?.message ?? String(error);
  return redactProviderUrls(String(message).replace(/\s+/g, " ")).slice(0, 300);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function redactProviderUrls(message) {
  return String(message).replace(/https?:\/\/[^\s)"']+/g, (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return "http(s)://redacted";
    }
  });
}

function sortOutcomes(outcomes) {
  return [...outcomes].sort(compareTokenIdAsc);
}

function selectLowestOddsRankSource(outcomes, cfg) {
  if (outcomes.every((outcome) => finiteNumber(outcome.payout) !== null)) {
    return { rankSource: "payout", fallbackReason: null };
  }
  if (outcomes.every((outcome) => finiteNumber(outcome.price) !== null)) {
    return { rankSource: "price", fallbackReason: "missing_complete_payout_data" };
  }
  if ((cfg.eventOutcomeSelectionFallback ?? "token_order") === "error") {
    throw new Error("Cannot select lowest odds: outcomes have neither complete payout nor complete price data");
  }
  return { rankSource: "token_order", fallbackReason: "missing_complete_odds_data" };
}

function compareOutcomeRank(a, b, rankSource) {
  if (rankSource === "payout") {
    const delta = finiteNumber(a.payout) - finiteNumber(b.payout);
    if (delta !== 0) return delta;
  } else if (rankSource === "price") {
    const delta = finiteNumber(b.price) - finiteNumber(a.price);
    if (delta !== 0) return delta;
  }
  return compareTokenIdAsc(a, b);
}

function parseOutcomeNames(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOutcomeName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\u2265/gu, ">=")
    .replace(/\u2264/gu, "<=")
    .replace(/\s+/gu, " ")
    .replace(/([<>]=?)\s+(?=[\d.])/gu, "$1")
    .toLowerCase();
}

function resolveOutcomeStakePlan(outcomes, cfg, overrides = {}) {
  const stakePerOutcomeUsdt = Number(overrides.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  if (!Number.isFinite(stakePerOutcomeUsdt) || stakePerOutcomeUsdt <= 0) {
    throw new Error("stakePerOutcomeUsdt must be positive");
  }
  const source = overrides.stakeByOutcomeUsdt ?? cfg.stakeByOutcomeUsdt;
  const selectedByKey = new Map(outcomes.map((outcome) => [normalizeOutcomeName(outcome?.name), outcome?.name]));
  const configured = new Map();
  const entries = Array.isArray(source)
    ? source.map((row) => [row?.outcome ?? row?.name, row?.stakeUsdt ?? row?.amountUsdt ?? row?.stake])
    : source && typeof source === "object"
      ? Object.entries(source)
      : [];

  for (const [rawOutcome, rawStake] of entries) {
    const key = normalizeOutcomeName(rawOutcome);
    if (!key) throw new Error("Outcome stake override is missing an outcome name");
    if (configured.has(key)) throw new Error(`Duplicate outcome stake override: ${rawOutcome}`);
    const selectedOutcome = selectedByKey.get(key);
    if (!selectedOutcome) throw new Error(`Outcome stake override is not selected: ${rawOutcome}`);
    const stakeUsdt = Number(rawStake);
    if (!Number.isFinite(stakeUsdt) || stakeUsdt <= 0) {
      throw new Error(`Invalid stake override for outcome ${rawOutcome}`);
    }
    configured.set(key, { outcome: selectedOutcome, stakeUsdt });
  }

  const stakeForOutcome = (outcome) => configured.get(normalizeOutcomeName(outcome?.name))?.stakeUsdt ?? stakePerOutcomeUsdt;
  const stakes = outcomes.map(stakeForOutcome);
  const stakeByOutcomeUsdt = Object.fromEntries([...configured.values()].map((row) => [row.outcome, row.stakeUsdt]));
  return {
    stakePerOutcomeUsdt,
    stakeByOutcomeUsdt,
    maxStakePerOutcomeUsdt: Math.max(...stakes),
    totalStakeUsdt: Number(stakes.reduce((sum, stake) => sum + stake, 0).toFixed(12)),
    stakeForOutcome
  };
}

function allowsExplicitLargeMarketSelection(cfg) {
  return (cfg.eventOutcomeSelection ?? "lowest_odds") === "names";
}

function assertSelectedOutcomeLimit(outcomes, cfg) {
  if (outcomes.length > cfg.maxOutcomesPerMarket) {
    throw new Error(`Selected ${outcomes.length} outcomes, above MAX_OUTCOMES_PER_MARKET ${cfg.maxOutcomesPerMarket}`);
  }
}

function compareTokenIdAsc(a, b) {
  try {
    const left = BigInt(a.tokenId);
    const right = BigInt(b.tokenId);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  } catch {
    return String(a.tokenId).localeCompare(String(b.tokenId));
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function addSelectionDetails(outcomes, metadata) {
  return outcomes.map((outcome, index) => ({
    ...outcome,
    selectionRank: index + 1,
    selectionRankSource: metadata.rankSource,
    selectionScore: selectionScore(outcome, metadata.rankSource)
  }));
}

function selectionScore(outcome, rankSource) {
  if (rankSource === "payout") return finiteNumber(outcome.payout);
  if (rankSource === "price") return finiteNumber(outcome.price);
  return String(outcome.tokenId);
}

function formatPlannedOutcome(outcome) {
  const amount = plannedAmount(outcome);
  if (!outcome.simulated) {
    return {
      tokenId: String(outcome.tokenId),
      name: outcome.name,
      currentPrice: outcome.price ?? null,
      currentPayout: outcome.payout ?? null,
      selectionRank: outcome.selectionRank ?? null,
      selectionRankSource: outcome.selectionRankSource ?? null,
      selectionScore: outcome.selectionScore ?? null,
      stakeUsdt: outcome.stakeUsdt,
      minOut: formatUnits(outcome.minOut, 18),
      mode: "fast_direct_no_quote",
      amount: formatUnits(amount, 18)
    };
  }

  const otToUser = outcome.simulated.otToUser;
  const ot = Number(formatUnits(otToUser, 18));
  const cost = Number(formatUnits(amount, 18));
  const post = outcome.simulated.post ?? {};
  const postPayoutPerOtRaw = post.payoutPerOt ?? post[4] ?? 0n;
  const postPayoutPerOt = Number(formatUnits(postPayoutPerOtRaw, 18));
  const effectiveCost = ot > 0 ? cost / ot : null;
  const approxPayoutIfRight = ot * postPayoutPerOt;
  const approxPayoutMultiplier = cost > 0 ? approxPayoutIfRight / cost : null;
  return {
    tokenId: String(outcome.tokenId),
    name: outcome.name,
    currentPrice: outcome.price,
    currentPayout: outcome.payout,
    selectionRank: outcome.selectionRank ?? null,
    selectionRankSource: outcome.selectionRankSource ?? null,
    selectionScore: outcome.selectionScore ?? null,
    stakeUsdt: outcome.stakeUsdt,
    expectedOt: formatUnits(otToUser, 18),
    minOut: formatUnits(outcome.minOut, 18),
    effectiveCost: effectiveCost === null ? null : Number(effectiveCost.toFixed(9)),
    otPerUsdt: cost > 0 ? Number((ot / cost).toFixed(6)) : null,
    postPayoutPerOt: Number(postPayoutPerOt.toFixed(9)),
    approxPayoutIfRight: Number(approxPayoutIfRight.toFixed(6)),
    approxPayoutMultiplier: approxPayoutMultiplier === null ? null : Number(approxPayoutMultiplier.toFixed(3)),
    collateralFromUser: formatUnits(outcome.simulated.collateralFromUser, 18),
    collateralToTreasury: formatUnits(outcome.simulated.collateralToTreasury, 18),
    collateralToIntegrator: formatUnits(outcome.simulated.collateralToIntegrator, 18)
  };
}

function plannedAmount(outcome) {
  return outcome.simulated?.amount ?? outcome.amount;
}

function isSupportedCollateralMarket(market) {
  const collateral = market.collateral ?? ADDRESSES.busdt;
  const parentTokenId = market.parentTokenId ?? "0";
  return (
    String(collateral).toLowerCase() === ADDRESSES.busdt.toLowerCase() &&
    BigInt(parentTokenId) === 0n
  );
}

function sellGasPriceOverride(cfg) {
  const gasPriceGwei = cfg.autoSellGasPriceGwei || cfg.gasPriceGwei;
  return gasPriceGwei ? { gasPrice: parseGwei(String(gasPriceGwei)) } : {};
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function getJsonWithRetry(url, label, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "42-btc-open-sniper/0.1"
        }
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${label} ${response.status}: ${body.slice(0, 500)}`);
      }
      try {
        return await response.json();
      } catch (error) {
        throw new Error(`${label} invalid JSON: ${error.message}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
