#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbi,
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
} from "../src/timestamp-guard.js";

const BUILDER_CONTROL = getAddress("0x4848489f0b2BEdd788c696e2D79b6b69D7484848");
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
const LENS = getAddress("0x4AAd5A856941FB64df10362024e3Ece24023d4d1");
const REPLAY_MARKET = getAddress("0xAa35c2069A6AbF20FA599eC96e479DE19a3Dd02a");
const REPLAY_TOKEN_IDS = [2n, 4n, 8n, 16n, 32n, 64n];

const lensAbi = parseAbi([
  "function simulateMint(address market, uint256 tokenId, uint256 amount, bool isExactIn, bytes dataSwap, bytes dataGuess, uint256 integratorFeeBps) returns ((uint256 tokenId, uint256 price, uint256 supply, uint256 totalMarketCap, uint256 payoutPerOt) pre, (uint256 tokenId, uint256 price, uint256 supply, uint256 totalMarketCap, uint256 payoutPerOt) post, (uint256 collateralFromUser, uint256 collateralToTreasury, uint256 collateralToIntegrator, uint256 otToUser) quote)"
]);

const multicallAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"
]);

const DEFAULT_MATRIX = [
  ...repeat({ mode: "builder_only", builderLeadMs: 1000 }, 2),
  ...repeat({ mode: "builder_only", builderLeadMs: 500 }, 2),
  ...repeat({ mode: "builder_only", builderLeadMs: 300 }, 6),
  ...repeat({ mode: "builder_only", builderLeadMs: 150 }, 2),
  ...repeat({ mode: "public_only", publicLeadMs: 150 }, 3),
  ...repeat({ mode: "hybrid", builderLeadMs: 300, publicLeadMs: 150 }, 5)
];
const GUARDED_MATRIX = [
  ...repeat({ mode: "builder_only", builderLeadMs: 1000 }, 4),
  ...repeat({ mode: "builder_only", builderLeadMs: 700 }, 4),
  ...repeat({ mode: "builder_only", builderLeadMs: 500 }, 4),
  ...repeat({ mode: "builder_only", builderLeadMs: 300 }, 4)
];

const args = parseArgs(process.argv.slice(2));
const sharedEnvFile = path.resolve(args.sharedEnv ?? "/etc/42space/shared-builder.env");
const profileEnvFile = path.resolve(args.profileEnv ?? "/etc/42space/profiles/42space-2.env");
const outputDir = path.resolve(args.outputDir ?? "output/builder-timing-stress");
const execute = Boolean(args.execute);
const tipBnb = String(args.tipBnb ?? "0.0001");
const gasPriceGwei = String(args.gasPriceGwei ?? "0.05");
const tipGasPriceGwei = String(args.tipGasPriceGwei ?? "0.05");
const maxCostBnb = String(args.maxCostBnb ?? "0.005");
const warmupMs = integerArg(args.warmupMs, 2500);
const receiptTimeoutMs = integerArg(args.receiptTimeoutMs, 15000);
const builderRetryIntervalMs = nonNegativeIntegerArg(args.builderRetryIntervalMs, 0);
const builderRetryUntilLeadMs = nonNegativeIntegerArg(args.builderRetryUntilLeadMs, 0);
const guardAddressValue = args.guardAddress || envValueFromFiles(sharedEnvFile, profileEnvFile, "BUILDER_TIMESTAMP_GUARD_ADDRESS");
const guardAddress = guardAddressValue ? getAddress(guardAddressValue) : null;
const guarded = Boolean(guardAddress);
const requestedRounds = args.rounds === undefined ? null : integerArg(args.rounds, 1);
const requestedBuilderLeadMs = args.builderLeadMs === undefined ? null : integerArg(args.builderLeadMs, 1);
const safePublicFallback = Boolean(args.safePublicFallback);
const matrix = safePublicFallback && requestedRounds
  ? repeat({ mode: "safe_public_fallback", publicLeadMs: 150 }, requestedRounds)
  : requestedRounds && requestedBuilderLeadMs
  ? repeat({ mode: "builder_only", builderLeadMs: requestedBuilderLeadMs }, requestedRounds)
  : guarded
  ? args.quick
    ? [
        { mode: "builder_only", builderLeadMs: 1000 },
        { mode: "builder_only", builderLeadMs: 500 },
        { mode: "builder_only", builderLeadMs: 300 }
      ]
    : GUARDED_MATRIX
  : args.quick
    ? [
      { mode: "builder_only", builderLeadMs: 1000 },
      { mode: "builder_only", builderLeadMs: 300 },
      { mode: "public_only", publicLeadMs: 150 },
      { mode: "hybrid", builderLeadMs: 300, publicLeadMs: 150 }
    ]
    : DEFAULT_MATRIX;

const sharedEnv = loadEnvFile(sharedEnvFile);
const profileEnv = loadEnvFile(profileEnvFile);
const env = { ...sharedEnv, ...profileEnv };
const rpcUrls = resolveRpcUrls(env);
const canonicalRpcUrl = rpcUrls[0];
const wsUrl = resolveWsUrl(env);
const builderUrl = env.BUILDER_BUNDLE_URL;
const privateKey = normalizePrivateKey(env.PRIVATE_KEY || env.WALLET_PRIVATE_KEY || "");

if (!canonicalRpcUrl) throw new Error("missing canonical BSC RPC URL");
if (!builderUrl) throw new Error("missing BUILDER_BUNDLE_URL");
if (!privateKey) throw new Error("missing private key");
if (rpcUrls.length < 2) throw new Error("stress test requires two distinct public RPC URLs");
if (guarded && matrix.some((row) => !["builder_only", "safe_public_fallback"].includes(row.mode))) {
  throw new Error("timestamp-guard stress mode only permits atomic builder or safe public fallback rounds");
}

const account = privateKeyToAccount(privateKey);
if (env.WALLET_ADDRESS && getAddress(env.WALLET_ADDRESS) !== account.address) {
  throw new Error("profile wallet address does not match private key");
}

const publicClient = createPublicClient({ chain: bsc, transport: http(canonicalRpcUrl) });
const headTracker = startHeadTracker(wsUrl);
const startedAt = new Date().toISOString();

try {
  await warmEndpoints([...rpcUrls, builderUrl]);
  const preflight = await buildPreflight();
  print({ level: "builder-timing-stress-preflight", execute, ...preflight });
  if (!execute) {
    print({
      level: "builder-timing-stress-dry-run",
      note: "read-only preflight complete; pass --execute to broadcast state-free canary transactions",
      guarded,
      guardAddress,
      matrix: summarizeMatrix(matrix)
    });
    process.exitCode = 0;
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
    const rows = [];
    for (let index = 0; index < matrix.length; index += 1) {
      const row = await runRound(index, matrix[index], preflight.gasLimit, preflight.guardGasLimit);
      rows.push(row);
      print({ level: "builder-timing-stress-round", ...row });
      if (row.abortReason) throw new Error(row.abortReason);
    }
    const report = {
      version: guarded ? 2 : 1,
      startedAt,
      completedAt: new Date().toISOString(),
      wallet: account.address,
      guarded,
      guardAddress,
      matrix: summarizeMatrix(matrix),
      preflight,
      summary: summarizeRows(rows),
      rows
    };
    const stamp = report.completedAt.replace(/[:.]/gu, "-");
    const outputFile = path.join(outputDir, `builder-timing-stress-${stamp}.json`);
    fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    print({ level: "builder-timing-stress-complete", outputFile, summary: report.summary });
  }
} finally {
  headTracker.stop();
}

async function buildPreflight() {
  const calldata = buildCanaryCalldata(0);
  await publicClient.call({ account: account.address, to: MULTICALL3, data: calldata });
  const [balance, latestNonce, pendingNonce, estimatedGas, builderGasPrice, guardCode, guardEstimatedGas] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.estimateGas({ account: account.address, to: MULTICALL3, data: calldata }),
    rpcRequest(builderUrl, "eth_gasPrice", []),
    guarded ? publicClient.getCode({ address: guardAddress }) : Promise.resolve(null),
    guarded
      ? publicClient.estimateGas({
          account: account.address,
          to: guardAddress,
          data: encodeTimestampGuardCall(0)
        })
      : Promise.resolve(0n)
  ]);
  if (pendingNonce !== latestNonce) {
    throw new Error(`wallet has pending nonce gap latest=${latestNonce} pending=${pendingNonce}`);
  }
  const configuredGasPrice = parseGwei(gasPriceGwei);
  const builderFloor = BigInt(builderGasPrice.result);
  if (configuredGasPrice < builderFloor) {
    throw new Error(`configured gas price is below Builder floor ${formatGwei(builderFloor)}gwei`);
  }
  if (guarded && !timestampGuardCodeMatches(guardCode)) {
    const actualHash = guardCode && guardCode !== "0x" ? keccak256(guardCode) : null;
    throw new Error(`timestamp guard code mismatch expected=${TIMESTAMP_GUARD_RUNTIME_CODE_HASH} actual=${actualHash}`);
  }
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  const guardGasLimit = guarded ? (guardEstimatedGas * 120n + 99n) / 100n : 0n;
  const builderRounds = matrix.filter((row) => ["builder_only", "hybrid"].includes(row.mode)).length;
  const worstGas = gasLimit * configuredGasPrice * BigInt(matrix.length);
  const worstGuardGas = guardGasLimit * configuredGasPrice * BigInt(matrix.length);
  const worstTipGas = 21_000n * parseGwei(tipGasPriceGwei) * BigInt(builderRounds);
  const worstTips = parseUnits(tipBnb, 18) * BigInt(builderRounds);
  const worstCost = worstGas + worstGuardGas + worstTipGas + worstTips;
  const maxCost = parseUnits(maxCostBnb, 18);
  if (worstCost > maxCost) {
    throw new Error(`worst-case cost ${formatEther(worstCost)} BNB exceeds cap ${maxCostBnb} BNB`);
  }
  const reserve = parseUnits("0.002", 18);
  if (balance < worstCost + reserve) {
    throw new Error(`insufficient BNB for capped stress test; balance=${formatEther(balance)} worst=${formatEther(worstCost)}`);
  }
  return {
    wallet: account.address,
    balanceBnb: formatEther(balance),
    latestNonce,
    pendingNonce,
    estimatedGas: estimatedGas.toString(),
    gasLimit: gasLimit.toString(),
    guarded,
    guardAddress,
    guardRuntimeCodeHash: guarded ? keccak256(guardCode) : null,
    expectedGuardRuntimeCodeHash: guarded ? TIMESTAMP_GUARD_RUNTIME_CODE_HASH : null,
    guardEstimatedGas: guarded ? guardEstimatedGas.toString() : null,
    guardGasLimit: guarded ? guardGasLimit.toString() : null,
    gasPriceGwei,
    tipGasPriceGwei,
    tipBnb,
    builderGasFloorGwei: formatGwei(builderFloor),
    rounds: matrix.length,
    builderRounds,
    builderRetryIntervalMs,
    builderRetryUntilLeadMs,
    worstCaseCostBnb: formatEther(worstCost),
    maxCostBnb,
    publicRpcProviders: rpcUrls.map(providerLabel),
    builderProvider: providerLabel(builderUrl),
    wsProvider: wsUrl ? providerLabel(wsUrl) : null,
    canary: guarded
      ? "Atomic [TimestampGuard, Multicall3 heavy Lens simulation, builder tip]; no 42 position or token state change"
      : "Multicall3 aggregate3 of six FTLensV2.simulateMint calls; no 42 position or token state change"
  };
}

async function runRound(index, spec, gasLimitValue, guardGasLimitValue = null) {
  const targetMs = Math.ceil((Date.now() + warmupMs) / 1000) * 1000;
  const targetTimestamp = Math.floor(targetMs / 1000);
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  const latestNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" });
  if (nonce !== latestNonce) {
    return baseRound(index, spec, targetMs, nonce, `pending nonce before round latest=${latestNonce} pending=${nonce}`);
  }

  const gasLimit = BigInt(gasLimitValue);
  const buyNonce = nonce + (guarded ? 1 : 0);
  let guard = null;
  if (guarded) {
    const raw = await account.signTransaction({
      chainId: bsc.id,
      to: guardAddress,
      data: encodeTimestampGuardCall(targetTimestamp),
      gas: BigInt(guardGasLimitValue),
      gasPrice: parseGwei(gasPriceGwei),
      nonce,
      value: 0n,
      type: "legacy"
    });
    guard = { raw, hash: transactionHash(raw), nonce };
  }
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to: MULTICALL3,
    data: buildCanaryCalldata(index + 1),
    gas: gasLimit,
    gasPrice: parseGwei(gasPriceGwei),
    nonce: buyNonce,
    value: 0n,
    type: "legacy"
  });
  const buyHash = transactionHash(serializedTransaction);
  let tip = null;
  if (["builder_only", "hybrid"].includes(spec.mode)) {
    const tipValue = parseUnits(tipBnb, 18) + BigInt(index);
    const raw = await account.signTransaction({
      chainId: bsc.id,
      to: BUILDER_CONTROL,
      value: tipValue,
      gas: 21_000n,
      gasPrice: parseGwei(tipGasPriceGwei),
      nonce: buyNonce + 1,
      type: "legacy"
    });
    tip = { raw, hash: transactionHash(raw), value: tipValue };
  }

  const builderAtMs = spec.builderLeadMs ? targetMs - spec.builderLeadMs : null;
  const publicAtMs = spec.publicLeadMs ? targetMs - spec.publicLeadMs : null;
  const builderPromise = builderAtMs === null
    ? Promise.resolve(null)
    : sendBuilderBundleAtTargets({
        firstTargetMs: builderAtMs,
        finalTargetMs: guarded ? targetMs - builderRetryUntilLeadMs : builderAtMs,
        retryIntervalMs: guarded ? builderRetryIntervalMs : 0,
        bundle: {
        guardRaw: guard?.raw ?? null,
        buyRaw: serializedTransaction,
        tipRaw: tip.raw,
        guardHash: guard?.hash ?? null,
        buyHash,
        tipHash: tip.hash,
          maxTimestamp: targetTimestamp
        }
      });
  const publicPromise = publicAtMs === null
    ? Promise.resolve(null)
    : runAt(publicAtMs, () => sendPublicFanout(serializedTransaction, buyHash));
  const [builderSubmission, publicFanout] = await Promise.all([builderPromise, publicPromise]);
  const builderAttempts = builderSubmission?.attempts ?? [];
  const builder = builderSubmission?.selected ?? null;

  let guardPublicFanout = null;
  let buyPublicRebroadcast = null;
  if (spec.mode === "safe_public_fallback") {
    await waitForChainTimestamp(targetTimestamp);
    guardPublicFanout = await sendPublicFanout(guard.raw, guard.hash);
    buyPublicRebroadcast = await sendPublicFanout(serializedTransaction, buyHash);
  }

  let receipt = null;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash: buyHash,
      timeout: receiptTimeoutMs,
      pollingInterval: 100
    });
  } catch {}
  if (!receipt && !["public_only", "hybrid", "safe_public_fallback"].includes(spec.mode)) {
    await waitForChainTimestamp(targetTimestamp + 1);
  }
  if (!receipt && ["public_only", "hybrid", "safe_public_fallback"].includes(spec.mode)) {
    return {
      ...baseRound(index, spec, targetMs, nonce, "public canary did not receive a receipt before timeout"),
      buyHash,
      tipHash: tip?.hash ?? null,
      builder,
      publicFanout,
      guardPublicFanout,
      buyPublicRebroadcast
    };
  }

  const guardReceipt = guard && receipt
    ? await publicClient.getTransactionReceipt({ hash: guard.hash }).catch(() => null)
    : null;
  const tipReceipt = tip && receipt
    ? await publicClient.getTransactionReceipt({ hash: tip.hash }).catch(() => null)
    : null;
  const block = receipt
    ? await publicClient.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: true })
    : null;
  const guardBlock = guardReceipt
    ? guardReceipt.blockNumber === receipt?.blockNumber
      ? block
      : await publicClient.getBlock({ blockNumber: guardReceipt.blockNumber })
    : null;
  const blockNumber = receipt?.blockNumber?.toString() ?? null;
  const blockTimestamp = block ? Number(block.timestamp) : null;
  const guardBlockTimestamp = guardBlock ? Number(guardBlock.timestamp) : null;
  const guardTxIndex = guardReceipt ? Number(guardReceipt.transactionIndex) : null;
  const buyTxIndex = receipt ? Number(receipt.transactionIndex) : null;
  const tipTxIndex = tipReceipt ? Number(tipReceipt.transactionIndex) : null;
  const marker = block?.transactions?.[0] && typeof block.transactions[0] !== "string"
    ? block.transactions[0]
    : null;
  const markerIs48Club = Boolean(
    marker &&
    String(marker.from).toLowerCase() === BUILDER_CONTROL.toLowerCase() &&
    String(marker.to).toLowerCase() === BUILDER_CONTROL.toLowerCase()
  );
  const builderProven = Boolean(
    tipReceipt &&
    receipt &&
    tipReceipt.blockNumber === receipt.blockNumber &&
    tipTxIndex === buyTxIndex + 1 &&
    (!guarded || (
      guardReceipt &&
      guardReceipt.status === "success" &&
      guardReceipt.blockNumber === receipt.blockNumber &&
      buyTxIndex === guardTxIndex + 1
    )) &&
    markerIs48Club
  );
  const safePublicFallbackProven = Boolean(
    spec.mode === "safe_public_fallback" &&
    guardReceipt?.status === "success" &&
    receipt?.status === "success" &&
    guardReceipt.blockNumber <= receipt.blockNumber &&
    guardBlockTimestamp >= targetTimestamp &&
    blockTimestamp >= targetTimestamp
  );
  const head = blockNumber ? headTracker.get(blockNumber) : null;
  const buyGasCost = receipt ? receipt.gasUsed * receipt.effectiveGasPrice : 0n;
  const guardGasCost = guardReceipt ? guardReceipt.gasUsed * guardReceipt.effectiveGasPrice : 0n;
  const tipGasCost = tipReceipt ? tipReceipt.gasUsed * tipReceipt.effectiveGasPrice : 0n;
  const tipValuePaid = tipReceipt ? tip.value : 0n;
  let abortReason = null;
  if (guarded && blockTimestamp !== null && blockTimestamp < targetTimestamp) {
    abortReason = `timestamp guard violation block=${blockTimestamp} target=${targetTimestamp}`;
  } else if (guarded && receipt && (!guardReceipt || guardReceipt.status !== "success")) {
    abortReason = "guarded canary mined without a successful guard receipt";
  } else if (guarded && receipt && !builderProven && !safePublicFallbackProven) {
    abortReason = "guarded canary mined without complete atomic Builder proof";
  }

  return {
    index: index + 1,
    guarded,
    mode: spec.mode,
    builderLeadMs: spec.builderLeadMs ?? null,
    publicLeadMs: spec.publicLeadMs ?? null,
    targetAt: new Date(targetMs).toISOString(),
    targetTimestamp,
    nonce,
    buyNonce,
    guardAddress,
    guardHash: guard?.hash ?? null,
    buyHash,
    tipHash: tip?.hash ?? null,
    builder,
    builderAttemptCount: builderAttempts.length,
    builderRejectedAttemptCount: builderAttempts.filter((attempt) => !attempt.submitted).length,
    builderAttempts,
    publicFanout,
    guardPublicFanout,
    buyPublicRebroadcast,
    receiptStatus: receipt?.status ?? "not_found",
    guardReceiptStatus: guardReceipt?.status ?? "not_found",
    blockNumber,
    blockTimestamp,
    guardBlockTimestamp,
    blockTimestampOffsetSeconds: blockTimestamp === null ? null : blockTimestamp - targetTimestamp,
    guardTxIndex,
    buyTxIndex,
    tipTxIndex,
    markerIs48Club,
    builderProven,
    safePublicFallbackProven,
    guardTargetSatisfied: guarded && blockTimestamp !== null ? blockTimestamp >= targetTimestamp : null,
    wsHeadReceivedAt: head?.receivedAt ?? null,
    wsHeadLagFromTimestampMs: head && blockTimestamp !== null
      ? Date.parse(head.receivedAt) - blockTimestamp * 1000
      : null,
    gasUsed: receipt?.gasUsed?.toString() ?? null,
    effectiveGasPriceGwei: receipt ? formatGwei(receipt.effectiveGasPrice) : null,
    paidBnb: formatEther(guardGasCost + buyGasCost + tipGasCost + tipValuePaid),
    abortReason
  };
}

async function sendBuilderBundleAtTargets({ firstTargetMs, finalTargetMs, retryIntervalMs, bundle }) {
  const targets = [firstTargetMs];
  if (retryIntervalMs > 0 && finalTargetMs > firstTargetMs) {
    for (let targetMs = firstTargetMs + retryIntervalMs; targetMs <= finalTargetMs; targetMs += retryIntervalMs) {
      targets.push(targetMs);
    }
    if (targets.at(-1) !== finalTargetMs) targets.push(finalTargetMs);
  }
  const attempts = await Promise.all(targets.map((targetMs, attemptIndex) =>
    runAt(targetMs, () => sendBuilderBundle({ ...bundle, attemptIndex: attemptIndex + 1, scheduledAtMs: targetMs }))
  ));
  return {
    attempts,
    selected: attempts.find((attempt) => attempt.submitted) ?? attempts.at(-1) ?? null
  };
}

async function sendBuilderBundle({
  guardRaw,
  buyRaw,
  tipRaw,
  guardHash,
  buyHash,
  tipHash,
  maxTimestamp,
  attemptIndex = 1,
  scheduledAtMs = null
}) {
  const requestStartedAtMs = Date.now();
  const response = await fetch(builderUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestStartedAtMs,
      method: "eth_sendBundle",
      params: [{
        txs: [guardRaw, buyRaw, tipRaw].filter(Boolean),
        ...(guardRaw ? { minTimestamp: maxTimestamp } : {}),
        maxTimestamp,
        positionFirst: true
      }]
    })
  });
  const acceptedAtMs = Date.now();
  const json = await response.json().catch(() => ({}));
  return {
    provider: providerLabel(builderUrl),
    attemptIndex,
    scheduledAt: Number.isFinite(scheduledAtMs) ? new Date(scheduledAtMs).toISOString() : null,
    requestStartedAt: new Date(requestStartedAtMs).toISOString(),
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    requestStartedOffsetMs: requestStartedAtMs - maxTimestamp * 1000,
    acceptedOffsetMs: acceptedAtMs - maxTimestamp * 1000,
    latencyMs: acceptedAtMs - requestStartedAtMs,
    httpStatus: response.status,
    submitted: response.ok && !json.error && Boolean(json.result),
    bundleHash: typeof json.result === "string" ? json.result : null,
    error: json.error?.message ?? (!response.ok ? `HTTP ${response.status}` : null),
    guardHash,
    buyHash,
    tipHash,
    minTimestamp: guardRaw ? maxTimestamp : null,
    maxTimestamp
  };
}

async function sendPublicFanout(serializedTransaction, expectedHash) {
  const results = await Promise.all(rpcUrls.map(async (url) => {
    const requestStartedAtMs = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestStartedAtMs,
          method: "eth_sendRawTransaction",
          params: [serializedTransaction]
        })
      });
      const acceptedAtMs = Date.now();
      const json = await response.json().catch(() => ({}));
      const alreadyKnown = /already known|known transaction/iu.test(json.error?.message ?? "");
      return {
        provider: providerLabel(url),
        requestStartedAt: new Date(requestStartedAtMs).toISOString(),
        acceptedAt: new Date(acceptedAtMs).toISOString(),
        latencyMs: acceptedAtMs - requestStartedAtMs,
        accepted: Boolean(json.result) || alreadyKnown,
        alreadyKnown,
        hashMatches: !json.result || String(json.result).toLowerCase() === expectedHash.toLowerCase(),
        error: json.error?.message ?? (!response.ok ? `HTTP ${response.status}` : null)
      };
    } catch (error) {
      const failedAtMs = Date.now();
      return {
        provider: providerLabel(url),
        requestStartedAt: new Date(requestStartedAtMs).toISOString(),
        acceptedAt: new Date(failedAtMs).toISOString(),
        latencyMs: failedAtMs - requestStartedAtMs,
        accepted: false,
        alreadyKnown: false,
        hashMatches: false,
        error: String(error?.message ?? error)
      };
    }
  }));
  return {
    startedAt: results.map((row) => row.requestStartedAt).sort()[0] ?? null,
    firstAcceptedAt: results.filter((row) => row.accepted).map((row) => row.acceptedAt).sort()[0] ?? null,
    firstAcceptedLatencyMs: Math.min(...results.filter((row) => row.accepted).map((row) => row.latencyMs), Infinity),
    acceptedCount: results.filter((row) => row.accepted).length,
    results
  };
}

function buildCanaryCalldata(roundIndex) {
  const amount = parseUnits("20", 18) + BigInt(roundIndex);
  const calls = REPLAY_TOKEN_IDS.map((tokenId) => ({
    target: LENS,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: lensAbi,
      functionName: "simulateMint",
      args: [REPLAY_MARKET, tokenId, amount, true, "0x", "0x", 40n]
    })
  }));
  return encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [calls] });
}

function startHeadTracker(url) {
  const heads = new Map();
  if (!url) return { get: () => null, stop: () => {} };
  const client = createPublicClient({ chain: bsc, transport: webSocket(url, { retryCount: 5 }) });
  const unwatch = client.watchBlocks({
    emitMissed: true,
    onBlock: (block) => {
      const key = block.number?.toString();
      if (!key) return;
      heads.set(key, {
        number: key,
        timestamp: Number(block.timestamp),
        receivedAt: new Date().toISOString()
      });
      if (heads.size > 256) heads.delete(heads.keys().next().value);
    },
    onError: () => {}
  });
  return {
    get: (blockNumber) => heads.get(String(blockNumber)) ?? null,
    stop: () => {
      unwatch();
      client.transport?.value?.socket?.close?.();
    }
  };
}

async function waitForChainTimestamp(timestamp) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const block = await publicClient.getBlock({ blockTag: "latest" });
    if (Number(block.timestamp) >= timestamp) return;
    await sleep(100);
  }
  throw new Error(`chain timestamp did not reach ${timestamp}`);
}

async function runAt(targetMs, fn) {
  const coarseWait = targetMs - Date.now() - 15;
  if (coarseWait > 0) await sleep(coarseWait);
  while (Date.now() < targetMs) {}
  return fn();
}

async function warmEndpoints(urls) {
  await Promise.all(urls.map((url) => rpcRequest(url, "eth_chainId", []).catch(() => null)));
}

async function rpcRequest(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  });
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(`${providerLabel(url)} ${method}: ${json.error?.message ?? response.status}`);
  return json;
}

function summarizeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.mode}:builder-${row.builderLeadMs ?? "none"}:public-${row.publicLeadMs ?? "none"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const byMode = {};
  for (const [key, group] of groups.entries()) {
    const builderLatencies = group.map((row) => row.builder?.latencyMs).filter(Number.isFinite);
    const builderAcceptedOffsets = group.map((row) => row.builder?.acceptedOffsetMs).filter(Number.isFinite);
    const publicLatencies = group.flatMap((row) => row.publicFanout?.results ?? []).map((row) => row.latencyMs).filter(Number.isFinite);
    byMode[key] = {
      rounds: group.length,
      mined: group.filter((row) => row.blockNumber).length,
      targetMinusOne: group.filter((row) => row.blockTimestampOffsetSeconds === -1).length,
      targetSecond: group.filter((row) => row.blockTimestampOffsetSeconds === 0).length,
      targetPlusOneOrLater: group.filter((row) => Number(row.blockTimestampOffsetSeconds) >= 1).length,
      missed: group.filter((row) => !row.blockNumber).length,
      builderProven: group.filter((row) => row.builderProven).length,
      builderAccepted: group.filter((row) => row.builder?.submitted).length,
      safePublicFallbackProven: group.filter((row) => row.safePublicFallbackProven).length,
      guardViolations: group.filter((row) => row.guardTargetSatisfied === false).length,
      guardedTargetSatisfied: group.filter((row) => row.guardTargetSatisfied === true).length,
      builderLatencyP50Ms: percentile(builderLatencies, 0.5),
      builderLatencyP95Ms: percentile(builderLatencies, 0.95),
      builderAcceptedOffsetP50Ms: percentile(builderAcceptedOffsets, 0.5),
      publicLatencyP50Ms: percentile(publicLatencies, 0.5),
      paidBnb: formatEther(group.reduce((sum, row) => sum + parseUnits(String(row.paidBnb ?? "0"), 18), 0n))
    };
  }
  return {
    rounds: rows.length,
    mined: rows.filter((row) => row.blockNumber).length,
    targetMinusOne: rows.filter((row) => row.blockTimestampOffsetSeconds === -1).length,
    targetSecond: rows.filter((row) => row.blockTimestampOffsetSeconds === 0).length,
    targetPlusOneOrLater: rows.filter((row) => Number(row.blockTimestampOffsetSeconds) >= 1).length,
    missed: rows.filter((row) => !row.blockNumber).length,
    builderProven: rows.filter((row) => row.builderProven).length,
    builderAccepted: rows.filter((row) => row.builder?.submitted).length,
    safePublicFallbackProven: rows.filter((row) => row.safePublicFallbackProven).length,
    guardViolations: rows.filter((row) => row.guardTargetSatisfied === false).length,
    guardedTargetSatisfied: rows.filter((row) => row.guardTargetSatisfied === true).length,
    paidBnb: formatEther(rows.reduce((sum, row) => sum + parseUnits(String(row.paidBnb ?? "0"), 18), 0n)),
    byMode
  };
}

function summarizeMatrix(rows) {
  return rows.reduce((result, row) => {
    const key = `${row.mode}:builder-${row.builderLeadMs ?? "none"}:public-${row.publicLeadMs ?? "none"}`;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function baseRound(index, spec, targetMs, nonce, abortReason) {
  return {
    index: index + 1,
    guarded,
    mode: spec.mode,
    builderLeadMs: spec.builderLeadMs ?? null,
    publicLeadMs: spec.publicLeadMs ?? null,
    targetAt: new Date(targetMs).toISOString(),
    targetTimestamp: Math.floor(targetMs / 1000),
    nonce,
    abortReason
  };
}

function envValueFromFiles(sharedFile, profileFile, key) {
  const profile = loadEnvFile(profileFile);
  const shared = loadEnvFile(sharedFile);
  return profile[key] || shared[key] || "";
}

function resolveRpcUrls(env) {
  const values = [
    ...(env.BROADCAST_RPC_URLS ?? "").split(","),
    env.CHAINSTACK_BSC_RPC_URL,
    env.ANKR_BSC_RPC_URL,
    env.BSC_RPC_URL,
    env.RPC_URL
  ].map((value) => String(value ?? "").trim()).filter(Boolean);
  return [...new Set(values)];
}

function resolveWsUrl(env) {
  return env.CHAINSTACK_BSC_WS_URL || env.ANKR_BSC_WS_URL || env.BSC_WS_URL || env.WS_URL || "";
}

function loadEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const match = rawLine.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizePrivateKey(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return normalized.startsWith("0x") ? normalized : `0x${normalized}`;
}

function transactionHash(serializedTransaction) {
  return keccak256(serializedTransaction);
}

function providerLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function formatGwei(value) {
  const wei = BigInt(value);
  const whole = wei / 1_000_000_000n;
  const fraction = (wei % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function repeat(value, count) {
  return Array.from({ length: count }, () => ({ ...value }));
}

function integerArg(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer ${value}`);
  return parsed;
}

function nonNegativeIntegerArg(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid non-negative integer ${value}`);
  return parsed;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
