#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  formatEther,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseGwei,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import {
  TIMESTAMP_GUARD_DEPLOYMENT_BYTECODE,
  TIMESTAMP_GUARD_RUNTIME_CODE_HASH,
  timestampGuardCodeMatches
} from "../src/timestamp-guard.js";

const args = parseArgs(process.argv.slice(2));
const sharedEnvFile = path.resolve(args.sharedEnv ?? "/etc/42space/shared-builder.env");
const profileEnvFile = path.resolve(args.profileEnv ?? "/etc/42space/profiles/42space-2.env");
const execute = Boolean(args.execute);
const gasPriceGwei = String(args.gasPriceGwei ?? "0.1");
const maxCostBnb = String(args.maxCostBnb ?? "0.001");
const env = { ...loadEnvFile(sharedEnvFile), ...loadEnvFile(profileEnvFile) };
const rpcUrls = resolveRpcUrls(env);
const privateKey = normalizePrivateKey(env.PRIVATE_KEY || env.WALLET_PRIVATE_KEY || "");

if (!privateKey) throw new Error("missing private key");
if (rpcUrls.length === 0) throw new Error("missing BSC RPC URL");

const account = privateKeyToAccount(privateKey);
if (env.WALLET_ADDRESS && getAddress(env.WALLET_ADDRESS) !== account.address) {
  throw new Error("profile wallet address does not match private key");
}

const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrls[0]) });
const configuredAddress = args.address || env.BUILDER_TIMESTAMP_GUARD_ADDRESS;
if (configuredAddress) {
  const address = getAddress(configuredAddress);
  const code = await publicClient.getCode({ address });
  print({
    level: "timestamp-guard-existing",
    address,
    runtimeCodeHash: code && code !== "0x" ? keccak256(code) : null,
    expectedRuntimeCodeHash: TIMESTAMP_GUARD_RUNTIME_CODE_HASH,
    codeMatches: timestampGuardCodeMatches(code)
  });
  if (!timestampGuardCodeMatches(code)) process.exitCode = 1;
} else {
  await deploy();
}

async function deploy() {
  const [latestNonce, pendingNonce, balance, estimatedGas] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.getBalance({ address: account.address }),
    publicClient.estimateGas({ account: account.address, data: TIMESTAMP_GUARD_DEPLOYMENT_BYTECODE })
  ]);
  if (latestNonce !== pendingNonce) {
    throw new Error(`wallet has pending nonce gap latest=${latestNonce} pending=${pendingNonce}`);
  }

  const gas = (estimatedGas * 120n + 99n) / 100n;
  const gasPrice = parseGwei(gasPriceGwei);
  const maxCost = gas * gasPrice;
  const costCap = parseUnits(maxCostBnb, 18);
  if (maxCost > costCap) {
    throw new Error(`deployment max cost ${formatEther(maxCost)} exceeds cap ${maxCostBnb} BNB`);
  }
  if (balance < maxCost + parseUnits("0.001", 18)) {
    throw new Error(`insufficient deployment reserve balance=${formatEther(balance)} maxCost=${formatEther(maxCost)}`);
  }

  const expectedAddress = getContractAddress({ from: account.address, nonce: BigInt(pendingNonce) });
  const serializedTransaction = await account.signTransaction({
    chainId: bsc.id,
    data: TIMESTAMP_GUARD_DEPLOYMENT_BYTECODE,
    gas,
    gasPrice,
    nonce: pendingNonce,
    type: "legacy"
  });
  const txHash = keccak256(serializedTransaction);
  print({
    level: "timestamp-guard-deploy-preflight",
    execute,
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
    expectedRuntimeCodeHash: TIMESTAMP_GUARD_RUNTIME_CODE_HASH
  });
  if (!execute) return;

  const broadcast = await sendPublicFanout(serializedTransaction, txHash);
  if (broadcast.acceptedCount === 0) {
    throw new Error(`guard deployment was rejected by all RPCs: ${JSON.stringify(broadcast.results)}`);
  }
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 30_000,
    pollingInterval: 100
  });
  const code = await publicClient.getCode({ address: expectedAddress });
  const codeMatches = timestampGuardCodeMatches(code);
  const receiptAddressMatches = String(receipt.contractAddress ?? "").toLowerCase() === expectedAddress.toLowerCase();
  print({
    level: "timestamp-guard-deployed",
    txHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    contractAddress: receipt.contractAddress,
    expectedAddress,
    receiptAddressMatches,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceGwei: formatGwei(receipt.effectiveGasPrice),
    runtimeCodeHash: code && code !== "0x" ? keccak256(code) : null,
    expectedRuntimeCodeHash: TIMESTAMP_GUARD_RUNTIME_CODE_HASH,
    codeMatches,
    broadcast
  });
  if (receipt.status !== "success" || !receiptAddressMatches || !codeMatches) {
    throw new Error("timestamp guard deployment verification failed");
  }
}

async function sendPublicFanout(serializedTransaction, expectedHash) {
  const results = await Promise.all(rpcUrls.map(async (url) => {
    const startedAtMs = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: startedAtMs,
          method: "eth_sendRawTransaction",
          params: [serializedTransaction]
        })
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
      return {
        provider: providerLabel(url),
        accepted: false,
        alreadyKnown: false,
        hashMatches: false,
        latencyMs: Date.now() - startedAtMs,
        error: String(error?.message ?? error)
      };
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
