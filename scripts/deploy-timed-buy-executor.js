#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  parseGwei,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  EXACT_TIMED_BUY_EXECUTOR_DEPLOYMENT_BYTECODE,
  EXACT_TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH,
  TIMED_BUY_EXECUTOR_ABI,
  TIMED_BUY_EXECUTOR_DEPLOYMENT_BYTECODE,
  TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH,
  exactTimedBuyExecutorCodeMatches,
  timedBuyExecutorCodeMatches
} from "../src/timed-buy-executor.js";

const BUSDT = "0x55d398326f99059fF775485246999027B3197955";
const ROUTER = "0x888888886619275d33c00D3BC62DF94D700DCD42";
const MAX_UINT256 = (1n << 256n) - 1n;
const READBACK_TIMEOUT_MS = 10_000;
const READBACK_POLL_MS = 200;
const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

const args = parseArgs(process.argv.slice(2));
const sharedEnvFile = path.resolve(args.sharedEnv ?? "/etc/42space/shared-builder.env");
const profileEnvFile = path.resolve(args.profileEnv ?? "/etc/42space/profiles/42space-3.env");
const execute = Boolean(args.execute);
const approveExecutor = Boolean(args.approveExecutor);
const gasPriceGwei = String(args.gasPriceGwei ?? "0.1");
const maxCostBnb = String(args.maxCostBnb ?? "0.003");
const env = { ...loadEnvFile(sharedEnvFile), ...loadEnvFile(profileEnvFile) };
const exactSecond = Boolean(args.exactSecond) || parseBoolean(env.BUILDER_TIMED_BUY_EXECUTOR_EXACT_SECOND);
const deploymentBytecode = exactSecond
  ? EXACT_TIMED_BUY_EXECUTOR_DEPLOYMENT_BYTECODE
  : TIMED_BUY_EXECUTOR_DEPLOYMENT_BYTECODE;
const expectedRuntimeCodeHash = exactSecond
  ? EXACT_TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH
  : TIMED_BUY_EXECUTOR_RUNTIME_CODE_HASH;
const rpcUrls = resolveRpcUrls(env);
const privateKey = normalizePrivateKey(env.PRIVATE_KEY || env.WALLET_PRIVATE_KEY || "");

if (!privateKey) throw new Error("missing private key");
if (rpcUrls.length === 0) throw new Error("missing BSC RPC URL");

const account = privateKeyToAccount(privateKey);
if (env.WALLET_ADDRESS && getAddress(env.WALLET_ADDRESS) !== account.address) {
  throw new Error("profile wallet address does not match private key");
}

const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrls[0]) });
const configuredAddress = args.deployNew
  ? null
  : (args.address || env.BUILDER_TIMED_BUY_EXECUTOR_ADDRESS);
if (configuredAddress) {
  const address = getAddress(configuredAddress);
  const verification = await waitForExecutorReady(address);
  if (!verification.ready) throw new Error("timed buy executor verification failed");
  if (approveExecutor) await ensureWalletApproval(address);
} else {
  await deploy();
}

async function deploy() {
  const [latestNonce, pendingNonce, balance, estimatedGas] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.getBalance({ address: account.address }),
    publicClient.estimateGas({ account: account.address, data: deploymentBytecode })
  ]);
  assertNoPendingNonceGap(latestNonce, pendingNonce);

  const gas = withGasMargin(estimatedGas);
  const gasPrice = parseGwei(gasPriceGwei);
  const maxCost = gas * gasPrice;
  assertCostAndBalance(maxCost, balance);
  const expectedAddress = getContractAddress({ from: account.address, nonce: BigInt(pendingNonce) });
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    data: deploymentBytecode,
    gas,
    gasPrice,
    nonce: pendingNonce,
    type: "legacy"
  });
  const txHash = keccak256(serializedTransaction);
  print({
    level: "timed-buy-executor-deploy-preflight",
    execute,
    approveExecutor,
    exactSecond,
    wallet: account.address,
    nonce: pendingNonce,
    expectedAddress,
    txHash,
    estimatedGas: estimatedGas.toString(),
    gas: gas.toString(),
    gasPriceGwei,
    maxCostBnb: formatEther(maxCost),
    balanceBnb: formatEther(balance),
    rpcProviders: rpcUrls.map(providerLabel),
    expectedRuntimeCodeHash
  });
  if (!execute) return;

  const broadcast = await sendPublicFanout(serializedTransaction, txHash);
  if (broadcast.acceptedCount === 0) {
    throw new Error(`executor deployment was rejected by all RPCs: ${JSON.stringify(broadcast.results)}`);
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000, pollingInterval: 100 });
  const receiptAddressMatches = String(receipt.contractAddress ?? "").toLowerCase() === expectedAddress.toLowerCase();
  const verification = await waitForExecutorReady(expectedAddress);
  print({
    level: "timed-buy-executor-deployed",
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    contractAddress: receipt.contractAddress,
    expectedAddress,
    receiptAddressMatches,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceGwei: formatGwei(receipt.effectiveGasPrice),
    broadcast,
    verification
  });
  if (receipt.status !== "success" || !receiptAddressMatches || !verification.ready) {
    throw new Error("timed buy executor deployment verification failed");
  }
  if (approveExecutor) await ensureWalletApproval(expectedAddress);
}

async function verifyExecutor(address, { quiet = false } = {}) {
  const code = await publicClient.getCode({ address });
  const codeMatches = exactSecond
    ? exactTimedBuyExecutorCodeMatches(code)
    : timedBuyExecutorCodeMatches(code);
  const [owner, operator, router, collateral, allowance] = codeMatches
    ? await Promise.all([
        publicClient.readContract({ address, abi: TIMED_BUY_EXECUTOR_ABI, functionName: "owner" }),
        publicClient.readContract({ address, abi: TIMED_BUY_EXECUTOR_ABI, functionName: "operators", args: [account.address] }),
        publicClient.readContract({ address, abi: TIMED_BUY_EXECUTOR_ABI, functionName: "ROUTER" }),
        publicClient.readContract({ address, abi: TIMED_BUY_EXECUTOR_ABI, functionName: "COLLATERAL" }),
        publicClient.readContract({ address: BUSDT, abi: erc20Abi, functionName: "allowance", args: [account.address, address] })
      ])
    : [null, false, null, null, 0n];
  const result = {
    level: "timed-buy-executor-existing",
    address,
    exactSecond,
    runtimeCodeHash: code && code !== "0x" ? keccak256(code) : null,
    expectedRuntimeCodeHash,
    codeMatches,
    owner,
    ownerMatches: owner?.toLowerCase() === account.address.toLowerCase(),
    operator: Boolean(operator),
    router,
    routerMatches: router?.toLowerCase() === ROUTER.toLowerCase(),
    collateral,
    collateralMatches: collateral?.toLowerCase() === BUSDT.toLowerCase(),
    walletAllowanceBusdt: formatUnits(allowance, 18)
  };
  result.ready = Boolean(
    result.codeMatches && result.ownerMatches && result.operator && result.routerMatches && result.collateralMatches
  );
  if (!quiet) print(result);
  return result;
}

async function waitForExecutorReady(address) {
  const deadline = Date.now() + READBACK_TIMEOUT_MS;
  let result = null;
  do {
    result = await verifyExecutor(address, { quiet: true });
    if (result.ready) break;
    await sleep(READBACK_POLL_MS);
  } while (Date.now() < deadline);
  print(result);
  return result;
}

async function ensureWalletApproval(executor) {
  const allowance = await publicClient.readContract({
    address: BUSDT,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, executor]
  });
  if (allowance === MAX_UINT256) {
    print({ level: "timed-buy-executor-approval", executor, alreadyReady: true, allowance: formatUnits(allowance, 18) });
    return;
  }
  const [latestNonce, pendingNonce, balance] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.getBalance({ address: account.address })
  ]);
  assertNoPendingNonceGap(latestNonce, pendingNonce);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [executor, MAX_UINT256] });
  const estimatedGas = await publicClient.estimateGas({ account: account.address, to: BUSDT, data });
  const gas = withGasMargin(estimatedGas);
  const gasPrice = parseGwei(gasPriceGwei);
  const maxCost = gas * gasPrice;
  assertCostAndBalance(maxCost, balance);
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    to: BUSDT,
    data,
    gas,
    gasPrice,
    nonce: pendingNonce,
    value: 0n,
    type: "legacy"
  });
  const txHash = keccak256(serializedTransaction);
  print({
    level: "timed-buy-executor-approval-preflight",
    execute,
    executor,
    txHash,
    nonce: pendingNonce,
    gas: gas.toString(),
    gasPriceGwei,
    maxCostBnb: formatEther(maxCost)
  });
  if (!execute) return;
  const broadcast = await sendPublicFanout(serializedTransaction, txHash);
  if (broadcast.acceptedCount === 0) throw new Error("executor approval was rejected by all RPCs");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000, pollingInterval: 100 });
  const updated = await waitForWalletAllowance(executor, MAX_UINT256);
  print({
    level: "timed-buy-executor-approved",
    executor,
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    allowance: formatUnits(updated, 18),
    broadcast
  });
  if (receipt.status !== "success" || updated !== MAX_UINT256) throw new Error("executor BUSDT approval verification failed");
}

async function waitForWalletAllowance(executor, expected) {
  const deadline = Date.now() + READBACK_TIMEOUT_MS;
  let allowance = 0n;
  do {
    allowance = await publicClient.readContract({
      address: BUSDT,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, executor]
    });
    if (allowance === expected) return allowance;
    await sleep(READBACK_POLL_MS);
  } while (Date.now() < deadline);
  return allowance;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNoPendingNonceGap(latestNonce, pendingNonce) {
  if (latestNonce !== pendingNonce) throw new Error(`wallet has pending nonce gap latest=${latestNonce} pending=${pendingNonce}`);
}

function withGasMargin(estimatedGas) {
  return (BigInt(estimatedGas) * 120n + 99n) / 100n;
}

function assertCostAndBalance(maxCost, balance) {
  const costCap = parseUnits(maxCostBnb, 18);
  if (maxCost > costCap) throw new Error(`transaction max cost ${formatEther(maxCost)} exceeds cap ${maxCostBnb} BNB`);
  if (balance < maxCost + parseUnits("0.001", 18)) {
    throw new Error(`insufficient BNB reserve balance=${formatEther(balance)} maxCost=${formatEther(maxCost)}`);
  }
}

async function sendPublicFanout(serializedTransaction, expectedHash) {
  const results = await Promise.all(rpcUrls.map(async (url) => {
    const startedAtMs = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: startedAtMs, method: "eth_sendRawTransaction", params: [serializedTransaction] })
      });
      const acceptedAtMs = Date.now();
      const json = await response.json().catch(() => ({}));
      const alreadyKnown = /already known|known transaction/iu.test(json.error?.message ?? "");
      const accepted = Boolean(json.result) || alreadyKnown;
      return {
        provider: providerLabel(url),
        accepted,
        alreadyKnown,
        hashMatches: !json.result || String(json.result).toLowerCase() === expectedHash.toLowerCase(),
        latencyMs: acceptedAtMs - startedAtMs,
        error: json.error?.message ?? (!response.ok ? `HTTP ${response.status}` : null)
      };
    } catch (error) {
      return { provider: providerLabel(url), accepted: false, latencyMs: Date.now() - startedAtMs, error: String(error?.message ?? error) };
    }
  }));
  return {
    acceptedCount: results.filter((row) => row.accepted).length,
    firstAcceptedLatencyMs: Math.min(...results.filter((row) => row.accepted).map((row) => row.latencyMs), Infinity),
    results
  };
}

function resolveRpcUrls(values) {
  return [...new Set([
    ...(values.BROADCAST_RPC_URLS ?? "").split(","),
    values.CHAINSTACK_BSC_RPC_URL,
    values.ANKR_BSC_RPC_URL,
    values.BSC_RPC_URL,
    values.RPC_URL
  ].map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function loadEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const match = rawLine.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (match) values[match[1]] = unquote(match[2].trim());
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

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function formatGwei(value) {
  const wei = BigInt(value);
  const whole = wei / 1_000_000_000n;
  const fraction = (wei % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function providerLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
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
