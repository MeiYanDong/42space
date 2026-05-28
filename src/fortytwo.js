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
  const gasPrice = cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : await publicClient.getGasPrice();
  return calculateFastGasReserve(cfg, funding, gasPrice);
}

export function calculateFastGasReserve(cfg, funding = {}, gasPrice = null) {
  const effectiveGasPrice = gasPrice ?? (cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : null);
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
  const required = gasLimit * effectiveGasPrice;
  return {
    mode: useBundleGas ? "bundle_fast_dynamic" : "single_fast",
    gasLimit: gasLimit.toString(),
    gasPriceWei: effectiveGasPrice.toString(),
    gasPriceGwei: formatUnits(effectiveGasPrice, 9),
    requiredBnb: formatUnits(required, 18)
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

export function resolveWalletBudgetGasLimit(cfg, { desiredGasLimit, walletBalance, gasPrice, blockGasLimit = 0n } = {}) {
  const desired = BigInt(desiredGasLimit ?? 0);
  if (!cfg.fastGasWalletBudget) return capFastTxGasLimit(cfg, desired);

  const balance = BigInt(walletBalance ?? 0);
  const price = BigInt(gasPrice ?? 0);
  if (balance <= 0n || price <= 0n) {
    throw new Error("BNB balance and gas price are required for wallet-budget gas limit");
  }

  const walletBps = BigInt(cfg.fastGasWalletBudgetBps ?? 10000);
  let limit = ((balance * walletBps) / BPS_DENOMINATOR) / price;
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
  return resolveWalletBudgetGasLimit(cfg, {
    desiredGasLimit: desired,
    walletBalance,
    gasPrice,
    blockGasLimit: block?.gasLimit ?? 0n
  });
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
  return Math.min(Number(cfg.eventOutcomeCount ?? 5), availableCount);
}

export function estimateMaxSelectedOutcomeCount(cfg) {
  if ((cfg.eventOutcomeSelection ?? "lowest_odds") === "all") return cfg.maxOutcomesPerMarket;
  return Math.min(Number(cfg.eventOutcomeCount ?? 5), cfg.maxOutcomesPerMarket);
}

export async function quoteBuyAllOutcomes(publicClient, market, cfg, overrides = {}) {
  if (Number(market.contractVersion) !== 2) {
    throw new Error("Event buy simulation currently supports only contractVersion=2 markets");
  }
  const availableOutcomes = sortOutcomes(market.outcomes ?? []);
  if (availableOutcomes.length === 0) throw new Error("Market has no outcomes");
  if (availableOutcomes.length > cfg.maxOutcomesPerMarket) {
    throw new Error(`Market has ${availableOutcomes.length} outcomes, above MAX_OUTCOMES_PER_MARKET ${cfg.maxOutcomesPerMarket}`);
  }
  const selection = selectEventOutcomes(availableOutcomes, cfg);
  const outcomes = selection.outcomes;

  const stakePerOutcomeUsdt = Number(overrides.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  const totalStakeUsdt = stakePerOutcomeUsdt * outcomes.length;
  if (totalStakeUsdt > cfg.maxMarketStakeUsdt) {
    throw new Error(`Total stake ${totalStakeUsdt} exceeds MAX_MARKET_STAKE_USDT ${cfg.maxMarketStakeUsdt}`);
  }

  const quotedOutcomes = await Promise.all(outcomes.map(async (outcome) => {
    const amount = parseUnits(String(stakePerOutcomeUsdt), 18);
    const simulated = await simulateMintAmount(publicClient, {
      market: market.address,
      tokenId: outcome.tokenId,
      amount,
      stakeUsdt: stakePerOutcomeUsdt
    });
    return {
      ...outcome,
      stakeUsdt: stakePerOutcomeUsdt,
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
    totalStakeUsdt,
    totalAmount: parseUnits(String(stakePerOutcomeUsdt), 18) * BigInt(outcomes.length),
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
  if (availableOutcomes.length > cfg.maxOutcomesPerMarket) {
    throw new Error(`Market has ${availableOutcomes.length} outcomes, above MAX_OUTCOMES_PER_MARKET ${cfg.maxOutcomesPerMarket}`);
  }
  const selection = selectEventOutcomes(availableOutcomes, cfg);
  const outcomes = selection.outcomes;

  const stakePerOutcomeUsdt = Number(overrides.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt);
  const totalStakeUsdt = stakePerOutcomeUsdt * outcomes.length;
  if (totalStakeUsdt > cfg.maxMarketStakeUsdt) {
    throw new Error(`Total stake ${totalStakeUsdt} exceeds MAX_MARKET_STAKE_USDT ${cfg.maxMarketStakeUsdt}`);
  }
  const amount = parseUnits(String(stakePerOutcomeUsdt), 18);

  return {
    dryRun: cfg.dryRun || !cfg.execute,
    action: selection.metadata.strategy === "all" ? "mint_all_outcomes_fast" : "mint_selected_outcomes_fast",
    market,
    outcomes: addSelectionDetails(outcomes.map((outcome) => ({
      ...outcome,
      stakeUsdt: stakePerOutcomeUsdt,
      amount,
      minOut: 1n,
      dataGuess: "0x"
    })), selection.metadata),
    selection: selection.metadata,
    stakePerOutcomeUsdt,
    totalStakeUsdt,
    totalAmount: amount * BigInt(outcomes.length),
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
  const nonce = runtime?.nextNonce !== undefined
    ? runtime.nextNonce
    : await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending"
      });
  const data = prebuilt?.multicallData ?? encodeFunctionData({
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
    market,
    receiver,
    preparedAt: new Date().toISOString()
  };
}

export async function preSignFastBundleTransaction(cfg, bundle, runtime = null) {
  assertExecutionAllowed(cfg, bundle, { checkMarketStake: false });
  if (bundle.totalStakeUsdt > cfg.maxBatchStakeUsdt) {
    throw new Error(`Bundle stake ${bundle.totalStakeUsdt} exceeds MAX_BATCH_STAKE_USDT ${cfg.maxBatchStakeUsdt}`);
  }

  const { publicClient, account } = makeClients(cfg);
  const gasPrice = cfg.gasPriceGwei ? parseGwei(String(cfg.gasPriceGwei)) : await publicClient.getGasPrice();
  const gas = await resolveExecutionGasLimit(publicClient, account.address, cfg, resolveBundleFastGasLimit(cfg, bundle), gasPrice);
  if (!gas || gas <= 0n) throw new Error("BUNDLE_FAST_GAS_LIMIT is required for pre-signed bundle transactions");
  const nonce = runtime?.nextNonce !== undefined
    ? runtime.nextNonce
    : await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending"
      });
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to: ADDRESSES.routerProxy,
    data: bundle.multicallData,
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
    marketCount: bundle.marketCount,
    outcomeCount: bundle.outcomeCount,
    preparedAt: new Date().toISOString()
  };
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
          bundle.multicallData
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
    markets: bundle.markets
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
        ? await writeFastMulticallFanout(cfg, publicClient, account, request, calls, runtime, prebuilt?.multicallData)
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
    }))
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

async function writeFastMulticallFanout(cfg, publicClient, account, request, calls, runtime, prebuiltMulticallData = null) {
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
  const broadcastStartedAt = Date.now();
  const attempts = cfg.broadcastRpcUrls.map((url) =>
    sendRawTransactionVia(url, serializedTransaction, txHash, cfg.broadcastTimeoutMs, broadcastStartedAt)
  );

  try {
    const first = await Promise.any(attempts);
    return {
      txHash: first.txHash,
      mode: "fanout_raw",
      rpcCount: cfg.broadcastRpcUrls.length,
      firstProvider: first.provider,
      broadcastStartedAt: new Date(broadcastStartedAt).toISOString(),
      firstAcceptedAt: first.acceptedAt,
      firstAcceptedLatencyMs: first.latencyMs,
      gas: gas.toString(),
      gasPrice: gasPrice.toString(),
      gasPriceGwei: formatUnits(gasPrice, 9),
      nonce
    };
  } catch {
    const settled = await Promise.allSettled(attempts);
    const messages = settled.map((item) =>
      item.status === "rejected" ? item.reason?.message ?? String(item.reason) : "unexpected success"
    );
    throw new Error(`Fanout broadcast failed on all RPCs: ${messages.join(" | ")}`);
  }
}

async function broadcastPreSignedFastTransaction(cfg, signed) {
  if (!signed?.serializedTransaction || !signed?.txHash) {
    throw new Error("Missing pre-signed fast transaction");
  }
  const urls = cfg.broadcastRpcUrls?.length ? cfg.broadcastRpcUrls : [cfg.rpcUrl];
  if (cfg.fanoutBroadcast && urls.length > 1) {
    const broadcastStartedAt = Date.now();
    const attempts = urls.map((url) =>
      sendRawTransactionVia(url, signed.serializedTransaction, signed.txHash, cfg.broadcastTimeoutMs, broadcastStartedAt)
    );
    try {
      const first = await Promise.any(attempts);
      scheduleRawTransactionRebroadcast(cfg, signed, urls, first.provider);
      return {
        txHash: first.txHash,
        mode: "presigned_fanout_raw",
        rpcCount: urls.length,
        firstProvider: first.provider,
        broadcastStartedAt: new Date(broadcastStartedAt).toISOString(),
        firstAcceptedAt: first.acceptedAt,
        firstAcceptedLatencyMs: first.latencyMs,
        gas: signed.gas ?? null,
        gasPrice: signed.gasPrice ?? null,
        gasPriceGwei: signed.gasPrice ? formatUnits(BigInt(signed.gasPrice), 9) : null,
        nonce: signed.nonce ?? null,
        rebroadcastIntervalMs: cfg.rebroadcastIntervalMs,
        rebroadcastDurationMs: cfg.rebroadcastDurationMs
      };
    } catch {
      const settled = await Promise.allSettled(attempts);
      const messages = settled.map((item) =>
        item.status === "rejected" ? item.reason?.message ?? String(item.reason) : "unexpected success"
      );
      throw new Error(`Pre-signed fanout broadcast failed on all RPCs: ${messages.join(" | ")}`);
    }
  }

  const broadcastStartedAt = Date.now();
  const first = await sendRawTransactionVia(
    urls[0],
    signed.serializedTransaction,
    signed.txHash,
    cfg.broadcastTimeoutMs,
    broadcastStartedAt
  );
  scheduleRawTransactionRebroadcast(cfg, signed, [urls[0]], first.provider);
  return {
    txHash: first.txHash,
    mode: "presigned_single_raw",
    rpcCount: 1,
    firstProvider: first.provider,
    broadcastStartedAt: new Date(broadcastStartedAt).toISOString(),
    firstAcceptedAt: first.acceptedAt,
    firstAcceptedLatencyMs: first.latencyMs,
    gas: signed.gas ?? null,
    gasPrice: signed.gasPrice ?? null,
    gasPriceGwei: signed.gasPrice ? formatUnits(BigInt(signed.gasPrice), 9) : null,
    nonce: signed.nonce ?? null,
    rebroadcastIntervalMs: cfg.rebroadcastIntervalMs,
    rebroadcastDurationMs: cfg.rebroadcastDurationMs
  };
}

function scheduleRawTransactionRebroadcast(cfg, signed, urls, firstProvider) {
  const intervalMs = Number(cfg.rebroadcastIntervalMs ?? 0);
  const durationMs = Number(cfg.rebroadcastDurationMs ?? 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;

  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  let round = 0;
  const activeUrls = [...new Set(urls.filter(Boolean))];

  const tick = () => {
    if (Date.now() >= deadline) {
      console.log(JSON.stringify({
        level: "raw-tx-rebroadcast-done",
        txHash: signed.txHash,
        rounds: round,
        durationMs,
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

export async function quoteSellOutcome(publicClient, { market, tokenId, owner, amountOt, percent = 100, slippageBps = 800 }) {
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
    : parseUnits(String(amountOt), 18);
  if (amount <= 0n) throw new Error("Sell amount is zero");
  if (amount > balance) {
    throw new Error(`Sell amount ${formatUnits(amount, 18)} exceeds outcome balance ${formatUnits(balance, 18)}`);
  }

  const [operatorApproved, collateralOutRaw] = await Promise.all([
    publicClient.readContract({
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
    : parseUnits(String(amountOt), 18);
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
    ...(cfg.gasPriceGwei ? { gasPrice: parseGwei(String(cfg.gasPriceGwei)) } : {})
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return {
    market,
    operatorApproved: receipt.status === "success",
    approved: receipt.status === "success",
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString() ?? null
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
      args: [ADDRESSES.routerProxy, true]
    });
    await publicClient.waitForTransactionReceipt({ hash: operatorApprovalHash });
    operatorApproved = true;
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
    ...(cfg.gasPriceGwei ? { gasPrice: parseGwei(String(cfg.gasPriceGwei)) } : {})
  };
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    operatorApprovalHash,
    operatorApproved,
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber?.toString() ?? null,
    market,
    receiver,
    tokenId: tokenId.toString(),
    amountOt: formatUnits(amount, 18),
    minCollateralOut: formatUnits(minOut, 18),
    expectedCollateralToUser: formatUnits(sellPlan.expectedCollateralToUser, 18),
    slippageBps: sellPlan.slippageBps
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
        ...(cfg.gasPriceGwei ? { gasPrice: parseGwei(String(cfg.gasPriceGwei)) } : {})
      });
      await publicClient.waitForTransactionReceipt({ hash: operatorApprovalHash });
      approved = true;
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
    ...(cfg.gasPriceGwei ? { gasPrice: parseGwei(String(cfg.gasPriceGwei)) } : {})
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
    requirePreapprovedOperator
  };
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
    totalStakeUsdt: plan.totalStakeUsdt,
    slippageBps: plan.slippageBps,
    selection: plan.selection ?? null,
    outcomes: plan.outcomes.map((outcome) => formatPlannedOutcome(outcome)),
    source: plan.source
  };
}

function assertExecutionAllowed(cfg, plan, { checkMarketStake = true } = {}) {
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
  if (bps === 10_000n) return value;
  const amount = (value * bps) / 10_000n;
  return roundDownSellAmount(amount);
}

function roundDownSellAmount(amount) {
  const minStep = 10n ** 16n; // 0.01 outcome token; partial redeems revert below this precision.
  if (amount < minStep) return amount;
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
  if (allowance > 0n) {
    resetHash = await walletClient.writeContract({
      address: ADDRESSES.busdt,
      abi: erc20Abi,
      functionName: "approve",
      args: [ADDRESSES.routerProxy, 0n]
    });
    await publicClient.waitForTransactionReceipt({ hash: resetHash });
  }

  const approveHash = await walletClient.writeContract({
    address: ADDRESSES.busdt,
    abi: erc20Abi,
    functionName: "approve",
    args: [ADDRESSES.routerProxy, MAX_UINT256]
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  return {
    allowance: formatUnits(allowance, 18),
    approveHash,
    resetHash
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
      return response.json();
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
