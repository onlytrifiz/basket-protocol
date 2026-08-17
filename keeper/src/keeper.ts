/**
 * Stockify keeper for Base.
 *
 * The keeper discovers stock routes off-chain, but the dividend cap table is entirely on-chain:
 * StockifyToken maintains it and DividendVault snapshots then pays it in batches. The keeper never
 * submits a holder list and does not depend on a block explorer for distribution.
 */
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { quoteStock } from "./uniswap.js";

const BPS = 10_000n;
const PLATFORM_FEE_BPS = 1_000n;
const chain = {
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [must("RPC_URL")] } },
} as const;

const rpcUrl = must("RPC_URL");
const privateKey = must("KEEPER_PRIVATE_KEY") as Hex;
const vault = getAddress(must("VAULT_ADDRESS"));
const account = privateKeyToAccount(privateKey);
const intervalSeconds = positiveInteger(process.env.INTERVAL_SEC, 300);
const minEthToBuy = parseEther(process.env.MIN_ETH_TO_BUY ?? "0.01");
const slippageBps = Number(process.env.SLIPPAGE_BPS ?? "300");
const snapshotBatchSize = positiveInteger(process.env.SNAPSHOT_BATCH_SIZE, 250);
const payoutBatchSize = positiveInteger(process.env.PAYOUT_BATCH_SIZE, 25);
const maxBatchTransactions = positiveInteger(process.env.MAX_BATCH_TRANSACTIONS, 100);
const runOnce = process.env.RUN_ONCE === "1";
const dryRun = process.env.DRY_RUN === "1";

const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60_000 }) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl, { timeout: 60_000 }) });

const vaultAbi = [
  { type: "function", name: "availableEth", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxGrossSpendPerCycle", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "stocksLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "stockAt",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ name: "token", type: "address" }, { name: "weightBps", type: "uint16" }],
  },
  { type: "function", name: "cycleActive", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "snapshotPending", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "nextDistribution", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "snapshotRemaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distributionRemaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "buyStocks",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256[]" }, { type: "bytes[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "snapshotHolders",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "startCycle", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "distributeBatch",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }],
    outputs: [],
  },
] as const;

type Stock = { token: Address; weightBps: bigint };
type WriteFunction = "buyStocks" | "snapshotHolders" | "startCycle" | "distributeBatch";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function write(functionName: WriteFunction, args: readonly unknown[]) {
  const request = {
    address: vault,
    abi: vaultAbi,
    functionName,
    args,
    account,
  } as const;
  const gas = await publicClient.estimateContractGas(request as any);
  const hash = await walletClient.writeContract({ ...request, gas: (gas * 12n) / 10n } as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  console.log(`  ${functionName}: ${hash}`);
}

async function readStocks(): Promise<Stock[]> {
  const count = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "stocksLength" })) as bigint;
  const stocks: Stock[] = [];
  for (let index = 0n; index < count; index += 1n) {
    const [token, weightBps] = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "stockAt",
      args: [index],
    })) as [Address, number];
    stocks.push({ token: getAddress(token), weightBps: BigInt(weightBps) });
  }
  return stocks;
}

async function buy(stocks: Stock[]): Promise<void> {
  let gross = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "availableEth" })) as bigint;
  const cap = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "maxGrossSpendPerCycle" })) as bigint;
  if (cap !== 0n && gross > cap) gross = cap;
  if (gross < minEthToBuy) {
    console.log(`  buy skipped: ${formatEther(gross)} ETH available`);
    return;
  }

  const stockBudget = (gross * (BPS - PLATFORM_FEE_BPS)) / BPS;
  const quotes = await Promise.all(
    stocks.map(async (stock) => {
      const amountIn = (stockBudget * stock.weightBps) / BPS;
      return quoteStock({ tokenOut: stock.token, amountIn, recipient: vault, slippageBps });
    }),
  );
  if (quotes.some((quote) => quote === null)) {
    console.log("  buy skipped: at least one B20 stock still has no complete Uniswap route");
    return;
  }
  if (dryRun) return console.log("  dry run: all routes available");

  await write(
    "buyStocks",
    [
      quotes.map((quote) => quote!.minOut),
      quotes.map((quote) => quote!.calldata),
    ],
  );
}

async function distributeFromOnchainRegistry(): Promise<void> {
  let active = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "cycleActive" })) as boolean;
  if (dryRun) {
    console.log(`  dry run: on-chain payout cycle is ${active ? "active" : "idle"}`);
    return;
  }

  let transactions = 0;
  if (!active) {
    const next = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nextDistribution" })) as bigint;
    if (next !== 0n && next > BigInt(Math.floor(Date.now() / 1_000))) {
      console.log(`  payout not due until ${new Date(Number(next) * 1_000).toISOString()}`);
      return;
    }

    while (true) {
      const remaining = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "snapshotRemaining" })) as bigint;
      if (remaining === 0n) break;
      if (transactions >= maxBatchTransactions) return console.log("  payout paused: snapshot transaction cap reached");
      console.log(`  snapshotting ${remaining} registry holders`);
      await write("snapshotHolders", [BigInt(snapshotBatchSize)]);
      transactions += 1;
    }

    await write("startCycle", []);
    active = true;
  }

  while (active) {
    const remaining = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "distributionRemaining" })) as bigint;
    if (remaining === 0n) return;
    if (transactions >= maxBatchTransactions) return console.log("  payout paused: distribution transaction cap reached");
    console.log(`  paying ${remaining} snapshotted holders`);
    await write("distributeBatch", [BigInt(payoutBatchSize)]);
    transactions += 1;
    active = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "cycleActive" })) as boolean;
  }
}

async function cycle(): Promise<void> {
  const stocks = await readStocks();
  console.log(`[cycle] ${new Date().toISOString()} | ${stocks.length} B20 stocks`);
  await buy(stocks);
  await distributeFromOnchainRegistry();
}

async function main() {
  console.log(`Stockify keeper ${account.address} → ${vault}; poll interval ${intervalSeconds}s`);
  do {
    try {
      await cycle();
    } catch (error) {
      console.error(`cycle failed: ${(error as Error).message}`);
    }
    if (!runOnce) await sleep(intervalSeconds * 1_000);
  } while (!runOnce);
}

function must(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function parseEther(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(18, "0").slice(0, 18)}`);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
