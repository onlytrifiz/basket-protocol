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
import { buildLeg, WETH } from "./route.js";
import { buildVeloraLeg } from "./velora.js";

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
const routeDeadlineSeconds = positiveInteger(process.env.ROUTE_DEADLINE_SEC, 900);
const intervalJitterPct = Math.min(90, Math.max(0, Number(process.env.INTERVAL_JITTER_PCT ?? 10)));
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
  { type: "function", name: "distributionStocksLength", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distributionStockAt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "unpaidTotal", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "snapshotPending", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "nextDistribution", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "snapshotRemaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distributionRemaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "buyStocks",
    stateMutability: "nonpayable",
    inputs: [{ type: "address[]" }, { type: "bytes[]" }, { type: "uint256[]" }, { type: "uint256[]" }],
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

/**
 * The poll interval, scattered by +/- INTERVAL_JITTER_PCT.
 *
 * A fixed cadence publishes the one moment that matters: `snapshotHolders` decides who is counted
 * for a distribution, so a clock anyone can read is an invitation to hold STFY only across the
 * snapshot and sell straight after. The live-balance clamp already limits what that earns, but there
 * is no reason to hand out the timetable. Set to 0 to disable.
 */
function nextDelayMs(): number {
  if (intervalJitterPct === 0) return intervalSeconds * 1_000;
  const spread = intervalSeconds * (intervalJitterPct / 100);
  const seconds = intervalSeconds + (Math.random() * 2 - 1) * spread;
  return Math.max(1, Math.round(seconds)) * 1_000;
}

/**
 * The block of our most recent transaction, or undefined before the first one in a cycle.
 *
 * Every read after a write is pinned to it. Without that the keeper decides on state older than its
 * own transaction: RPC endpoints load-balance across nodes, and one a block behind reports the cycle
 * we have just opened as not existing, or a cycle we have just finished as still owing a payout. Both
 * happened on the first live run — the keeper walked away from a started cycle, then retried a batch
 * on a closed one and ate a revert.
 */
let lastWriteBlock: bigint | undefined;

/** Read vault state, never older than our own last transaction, retrying a lagging node. */
async function read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await publicClient.readContract({
        abi: vaultAbi,
        address: vault,
        args: args as never,
        functionName: functionName as never,
        ...(lastWriteBlock === undefined ? {} : { blockNumber: lastWriteBlock }),
      })) as T;
    } catch (error) {
      // A node that has not caught up yet rejects the pinned block. Give it time rather than
      // falling back to "latest", which is the stale answer we are guarding against.
      if (attempt >= 4) throw error;
      await sleep(700 * (attempt + 1));
    }
  }
}

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
  lastWriteBlock = receipt.blockNumber;
  console.log(`  ${functionName}: ${hash}`);
}

async function readStocks(): Promise<Stock[]> {
  const count = await read<bigint>("stocksLength");
  const stocks: Stock[] = [];
  for (let index = 0n; index < count; index += 1n) {
    const [token, weightBps] = await read<[Address, number]>("stockAt", [index]);
    stocks.push({ token: getAddress(token), weightBps: BigInt(weightBps) });
  }
  return stocks;
}

async function buy(stocks: Stock[]): Promise<void> {
  let gross = await read<bigint>("availableEth");
  const cap = await read<bigint>("maxGrossSpendPerCycle");
  if (cap !== 0n && gross > cap) gross = cap;
  if (gross < minEthToBuy) {
    console.log(`  buy skipped: ${formatEther(gross)} ETH available`);
    return;
  }

  // Mirror the vault's own split so each leg is quoted against the amount it will actually be
  // handed. The vault patches the real spend into the calldata, so a later arrival only makes the
  // fill better than quoted; a smaller one reverts the leg instead of filling badly.
  // An aggregator route may only be used when the cap BINDS. Above it `gross` is pinned to the cap
  // and the per-leg spend is fixed, so the quote and the forwarded amount are identical and the
  // vault's patch is a harmless no-op — necessary because Augustus encodes srcAmount twice while the
  // vault rewrites one word. Below the cap `gross` tracks a balance that keeps growing, so the two
  // would disagree.
  //
  // That is a reason to skip VELORA, not to skip the purchase. The self-built Slipstream route
  // encodes the amount once, which is exactly what patching is for: the vault writes the real spend
  // and the leg follows. Deferring anyway left hook fees idle for as long as volume stayed thin —
  // potentially forever, if it never reached the cap again.
  const capBinds = cap !== 0n && gross >= cap;
  if (!capBinds) {
    console.log(`  ${formatEther(gross)} ETH below the ${formatEther(cap)} cap: direct route only`);
  }

  const stockBudget = (gross * (BPS - PLATFORM_FEE_BPS)) / BPS;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const legs = await Promise.all(
    stocks.map(async (stock) => {
      const amountIn = (stockBudget * stock.weightBps) / BPS;
      const velora = capBinds
        ? await buildVeloraLeg({
        srcToken: WETH,
        srcDecimals: 18,
        destToken: stock.token,
        destDecimals: 8,
        amountIn,
            vault,
            slippageBps,
          })
        : null;
      if (velora) {
        console.log(`  ${stock.token} via ${velora.venues.join("+") || "velora"}`);
        return velora;
      }
      // The self-built two-hop Slipstream route: used below the cap by design, and above it
      // whenever the aggregator has nothing to offer.
      if (capBinds) console.log(`  ${stock.token}: velora unavailable, using the direct route`);
      return buildLeg({
        client: publicClient,
        equity: stock.token,
        amountIn,
        recipient: vault,
        slippageBps,
        deadlineSeconds: routeDeadlineSeconds,
        nowSeconds,
      });
    }),
  );
  if (legs.some((leg) => leg === null)) {
    console.log("  buy skipped: at least one B20 stock has no route");
    return;
  }
  if (dryRun) return console.log("  dry run: all routes available");

  try {
    await submitBuy(legs as Leg[]);
    return;
  } catch (error) {
    // Velora routes through RFQ venues whose calldata carries a market maker's SIGNED order, valid
    // for seconds. Quoting, estimating and broadcasting takes longer than that, so the order can be
    // dead before the transaction lands and the whole buy reverts with RouterCallFailed. The
    // self-built Slipstream route has no signature and no expiry but our own deadline, so it is
    // what the protocol falls back to rather than skipping a cycle.
    console.log(`  aggregator route failed (${(error as Error).message.split("\n")[0]}); rebuilding direct`);
  }

  const nowRetry = Math.floor(Date.now() / 1_000);
  const direct = await Promise.all(
    stocks.map((stock) =>
      buildLeg({
        client: publicClient,
        equity: stock.token,
        amountIn: (stockBudget * stock.weightBps) / BPS,
        recipient: vault,
        slippageBps,
        deadlineSeconds: routeDeadlineSeconds,
        nowSeconds: nowRetry,
      }),
    ),
  );
  if (direct.some((leg) => leg === null)) {
    console.log("  buy skipped: the direct Slipstream route is unavailable too");
    return;
  }
  await submitBuy(direct as Leg[]);
}

type Leg = { target: Address; calldata: `0x${string}`; amountInOffset: bigint; minOut: bigint };

async function submitBuy(legs: Leg[]): Promise<void> {
  await write("buyStocks", [
    legs.map((leg) => leg.target),
    legs.map((leg) => leg.calldata),
    legs.map((leg) => leg.amountInOffset),
    legs.map((leg) => leg.minOut),
  ]);
}

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Is there anything to hand out? Mirrors the vault's own `_hasDistributionWork`, which is private.
 *
 * Without this the keeper opens a snapshot for a cycle the vault will refuse with
 * NoDistributionWork, which is the contract being right: once a distribution has emptied the vault
 * of every B20, there is nothing to divide until the next purchase lands. It costs no gas — the
 * revert surfaces during estimation — but a recurring error in the logs is where a real one hides.
 */
async function hasDistributionWork(): Promise<boolean> {
  const count = await read<bigint>("distributionStocksLength");
  for (let index = 0n; index < count; index += 1n) {
    const stock = await read<Address>("distributionStockAt", [index]);
    const [held, owed] = await Promise.all([
      publicClient.readContract({ address: stock, abi: erc20Abi, functionName: "balanceOf", args: [vault] }) as Promise<bigint>,
      read<bigint>("unpaidTotal", [stock]),
    ]);
    if (held > owed || owed !== 0n) return true;
  }
  return false;
}

async function distributeFromOnchainRegistry(): Promise<void> {
  let active = await read<boolean>("cycleActive");
  // A cycle already open still has to be finished; only a fresh one needs stock to divide.
  if (!active && !(await hasDistributionWork())) {
    console.log("  nothing to distribute: the vault holds no stock yet");
    return;
  }
  if (dryRun) {
    console.log(`  dry run: on-chain payout cycle is ${active ? "active" : "idle"}`);
    return;
  }

  let transactions = 0;
  if (!active) {
    const next = await read<bigint>("nextDistribution");
    if (next !== 0n && next > BigInt(Math.floor(Date.now() / 1_000))) {
      console.log(`  payout not due until ${new Date(Number(next) * 1_000).toISOString()}`);
      return;
    }

    while (true) {
      const remaining = await read<bigint>("snapshotRemaining");
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
    const remaining = await read<bigint>("distributionRemaining");
    if (remaining === 0n) return;
    if (transactions >= maxBatchTransactions) return console.log("  payout paused: distribution transaction cap reached");
    console.log(`  paying ${remaining} snapshotted holders`);
    await write("distributeBatch", [BigInt(payoutBatchSize)]);
    transactions += 1;
    active = await read<boolean>("cycleActive");
  }
}

async function cycle(): Promise<void> {
  lastWriteBlock = undefined;
  const stocks = await readStocks();
  console.log(`[cycle] ${new Date().toISOString()} | ${stocks.length} B20 stocks`);
  await buy(stocks);
  await distributeFromOnchainRegistry();
}

async function main() {
  console.log(
    `Stockify keeper ${account.address} → ${vault}; poll ~${intervalSeconds}s ±${intervalJitterPct}%`,
  );
  do {
    try {
      await cycle();
    } catch (error) {
      console.error(`cycle failed: ${(error as Error).message}`);
    }
    if (runOnce) break;
    const delay = nextDelayMs();
    console.log(`  next cycle in ${Math.round(delay / 1_000)}s`);
    await sleep(delay);
  } while (true);
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
