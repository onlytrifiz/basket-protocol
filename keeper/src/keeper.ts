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
/**
 * Gas a single payout transaction may occupy. Base rejects a transaction whose limit is too high,
 * and the estimate scales with holders TIMES assets in the index — plus much more on a holder's
 * first ever payout, when every B20 transfer writes a fresh balance slot instead of updating one.
 * A fixed holder count cannot express that, which is why 250 estimated 15.2M and was refused.
 */
const payoutGasTarget = BigInt(process.env.PAYOUT_GAS_TARGET ?? "10000000");
const intervalJitterPct = Math.min(90, Math.max(0, Number(process.env.INTERVAL_JITTER_PCT ?? 10)));
const runOnce = process.env.RUN_ONCE === "1";
/**
 * Where to report a settled cycle, and the secret that proves it was us.
 *
 * The site keeps its own ledger of settled cycles so it does not have to re-read the chain for
 * every visitor, and the keeper is the only party that can say when there is something new: it
 * buys the stock, opens the cycle and pays the batches. Unset means the keeper simply does not
 * announce — the protocol does not depend on this, only the page's freshness does.
 */
const ledgerUrl = process.env.LEDGER_INGEST_URL;
const ledgerSecret = process.env.LEDGER_INGEST_SECRET;
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
/** A stock plus the scale its quotes have to be asked in. See `decimalsOf`. */
type PricedStock = Stock & { decimals: number };
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
/**
 * Unix seconds a deferred payout becomes possible, or undefined when nothing is waiting.
 *
 * The vault refuses to open a cycle until an hour after the last one started. A poll interval that
 * is merely SHORTER than that hour is not enough: at 2900s the keeper arrives at minute 48, is
 * refused, and the next look is minute 96 — so distributions land every 96 minutes instead of 60.
 * Recording the deadline lets the loop wake for it rather than stumble past it.
 */
let payoutDueAt: number | undefined;

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

/**
 * Pay as many holders as fit under `payoutGasTarget`, measuring rather than guessing.
 *
 * Starts from PAYOUT_BATCH_SIZE and scales down by whatever the estimate overshot by, so it
 * converges in a couple of probes instead of halving blindly. Estimation is free; discovering the
 * limit by having Base refuse the transaction is not.
 */
async function distributeSized(remaining: bigint): Promise<void> {
  let count = BigInt(payoutBatchSize);
  if (count > remaining) count = remaining;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const request = { address: vault, abi: vaultAbi, functionName: "distributeBatch", args: [count], account } as const;
    const gas = await publicClient.estimateContractGas(request as any);
    if (gas <= payoutGasTarget || count === 1n) {
      const hash = await walletClient.writeContract({ ...request, gas: (gas * 12n) / 10n } as any);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`distributeBatch reverted: ${hash}`);
      lastWriteBlock = receipt.blockNumber;
      console.log(`  distributeBatch(${count}): ${hash}`);
      return;
    }
    const scaled = (count * payoutGasTarget) / gas;
    count = scaled < 1n ? 1n : scaled;
    console.log(`  ${gas} gas over target, retrying with ${count} holders`);
  }
  throw new Error("distributeBatch: could not fit a batch under the gas target");
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

/**
 * A token's decimals, asked once and kept.
 *
 * NOT A CONSTANT 8. Every Base equity carries eight and the Velora leg was written against that —
 * but the index is whatever `setIndex` was handed, and `DividendVault._setIndex` deliberately
 * admits anything that answers `totalSupply()`. It cannot check for a B20, because B20s are Rust
 * precompiles with no bytecode to inspect. So an eighteen-decimal entry asked the aggregator to
 * price a trade 10^10 the intended size, which does not fail loudly: it quotes something absurd and
 * derives `minOut` from it.
 *
 * `null` means the read did not land — never a guess. Decimals are immutable, so a value that
 * landed is cached for the life of the process and only a failure is retried.
 */
const decimalsCache = new Map<Address, number>();

async function decimalsOf(token: Address): Promise<number | null> {
  const hit = decimalsCache.get(token);
  if (hit !== undefined) return hit;
  try {
    const value = Number(
      await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    );
    if (!Number.isInteger(value) || value < 0 || value > 36) return null;
    decimalsCache.set(token, value);
    return value;
  } catch {
    return null;
  }
}

/**
 * The index with every entry's scale resolved, or null when one of them would not say.
 *
 * ALL OR NOTHING, because `buyStocks` is: it requires one leg per index entry and reverts on any
 * other length, so a name whose scale is unreadable cannot simply be dropped the way the indices
 * keeper drops one. Skipping the whole buy is the same thing this function's caller already does
 * when a single leg has no route — the ETH stays in the vault and the next cycle tries again.
 */
async function pricedStocks(stocks: Stock[]): Promise<PricedStock[] | null> {
  const resolved = await Promise.all(
    stocks.map(async (stock) => ({ stock, decimals: await decimalsOf(stock.token) })),
  );
  const unread = resolved.filter((entry) => entry.decimals === null);
  if (unread.length > 0) {
    console.log(`  buy skipped: decimals unreadable for ${unread.map((e) => e.stock.token).join(", ")}`);
    return null;
  }
  return resolved.map(({ stock, decimals }) => ({ ...stock, decimals: decimals as number }));
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

  // Every entry's scale before anything is quoted: a wrong one is not a display bug, it is the
  // wrong amount of money through a router. See `decimalsOf`.
  const priced = await pricedStocks(stocks);
  if (!priced) return;

  const stockBudget = (gross * (BPS - PLATFORM_FEE_BPS)) / BPS;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const legs = await Promise.all(
    priced.map(async (stock) => {
      const amountIn = (stockBudget * stock.weightBps) / BPS;
      const velora = capBinds
        ? await buildVeloraLeg({
            srcToken: WETH,
            srcDecimals: 18,
            destToken: stock.token,
            destDecimals: stock.decimals,
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
    priced.map((stock) =>
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
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
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

/**
 * Finish or open a payout cycle. Returns true when one is settled by the time we walk away.
 *
 * The return value drives the ledger announcement, so it has to mean "the vault emitted
 * DistributionCycleCompleted", not "we did some work" — a paused batch run and a deferred payout
 * both leave a cycle open and must not be reported as closed.
 */
async function distributeFromOnchainRegistry(): Promise<boolean> {
  payoutDueAt = undefined;
  let active = await read<boolean>("cycleActive");
  // A cycle already open still has to be finished; only a fresh one needs stock to divide.
  if (!active && !(await hasDistributionWork())) {
    console.log("  nothing to distribute: the vault holds no stock yet");
    return false;
  }
  if (dryRun) {
    console.log(`  dry run: on-chain payout cycle is ${active ? "active" : "idle"}`);
    return false;
  }

  let transactions = 0;
  if (!active) {
    const next = await read<bigint>("nextDistribution");
    if (next !== 0n && next > BigInt(Math.floor(Date.now() / 1_000))) {
      payoutDueAt = Number(next);
      console.log(`  payout not due until ${new Date(payoutDueAt * 1_000).toISOString()}`);
      return false;
    }

    while (true) {
      const remaining = await read<bigint>("snapshotRemaining");
      if (remaining === 0n) break;
      if (transactions >= maxBatchTransactions) {
        console.log("  payout paused: snapshot transaction cap reached");
        return false;
      }
      console.log(`  snapshotting ${remaining} registry holders`);
      await write("snapshotHolders", [BigInt(snapshotBatchSize)]);
      transactions += 1;
    }

    await write("startCycle", []);
    active = true;
  }

  while (active) {
    const remaining = await read<bigint>("distributionRemaining");
    if (remaining === 0n) return true;
    if (transactions >= maxBatchTransactions) {
      console.log("  payout paused: distribution transaction cap reached");
      return false;
    }
    console.log(`  paying ${remaining} snapshotted holders`);
    await distributeSized(remaining);
    transactions += 1;
    active = await read<boolean>("cycleActive");
  }
  // The loop only ends here when the last batch closed the cycle.
  return true;
}

/**
 * Tell the site a cycle settled, so it walks the blocks since it last looked.
 *
 * DELIBERATELY NOT A RECORD OF WHAT HAPPENED. Sending the decoded cycle would make the keeper the
 * author of the ledger, and then a keeper bug would be a wrong page with no way to notice. It sends
 * a nudge; the site re-reads the chain from its own cursor and decodes it there.
 *
 * A failure is logged and dropped. The site scans from where its last successful ingest ended, so a
 * lost announcement is picked up by the next one rather than leaving a hole.
 */
async function announceSettlement(): Promise<void> {
  if (!ledgerUrl || !ledgerSecret) return;
  try {
    const response = await fetch(ledgerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ledgerSecret}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null) as { added?: number; total?: number } | null;
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
    console.log(`  ledger: +${payload?.added ?? 0} cycles, ${payload?.total ?? "?"} total`);
  } catch (error) {
    console.error(`  ledger announcement failed (recovers on the next one): ${(error as Error).message}`);
  }
}

async function cycle(): Promise<void> {
  lastWriteBlock = undefined;
  const stocks = await readStocks();
  console.log(`[cycle] ${new Date().toISOString()} | ${stocks.length} B20 stocks`);
  await buy(stocks);
  if (await distributeFromOnchainRegistry()) await announceSettlement();
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

    // Wake for the payout deadline when one is pending and it lands sooner than the next poll.
    // Always a little AFTER it, never on it: arriving a second early just earns a TooSoon revert,
    // and the scatter keeps the exact moment off a timetable anyone can read.
    let delay = nextDelayMs();
    if (payoutDueAt !== undefined) {
      const untilDue = payoutDueAt * 1_000 - Date.now();
      const scatter = Math.random() * intervalSeconds * (intervalJitterPct / 100) * 1_000;
      const wakeForPayout = Math.max(1_000, untilDue + 2_000 + scatter);
      if (wakeForPayout < delay) {
        delay = wakeForPayout;
        console.log(`  waking for the payout window rather than the full interval`);
      }
    }
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
