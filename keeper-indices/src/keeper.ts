/**
 * Stockify Indices keeper — runs the cycle for every index the factory has minted.
 *
 * Per index, per cycle:
 *   1. harvest()      pull the launch's creator fees (permissionless, but nobody else will)
 *   2. swap()         turn each name's slice of those fees into equity, on a 0x quote
 *   3. distribute()   push what's been bought to the coin's holders, pro-rata on balance
 *
 * The treasury bounds what this process can do with funds, and the code below is written to match:
 * it can only reach a venue the factory has allowlisted, it can only buy what is already in the
 * basket, and it never decides who is owed what — balances do. What it CAN get wrong is who gets
 * *included* in a round and when a round is worth running, which is what most of this file is about.
 *
 * Run one instance. Two racing on the same round both open batches against the same cursor and one
 * of them simply burns gas on reverts.
 */
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { creatorSplitSetAbi, erc20Abi, factoryAbi, lockerAbi, treasuryAbi, v3FactoryAbi } from "./abi.js";
import {
  BALANCE_CHUNK,
  DEAD,
  DRY_RUN,
  ETH_CUSHION,
  EXTRA_EXCLUDES,
  FACTORY,
  FEE_LOCKER,
  GAS_BASE,
  GAS_PER_HOLDER,
  INTERVAL_SEC,
  KEEPER_PRIVATE_KEY,
  LOG_CHUNK,
  MAX_HOLDERS_PER_TX,
  MIN_PAYOUT_UNITS,
  MIN_ROUND_UNPRICED,
  MIN_ROUND_USD,
  MIN_PAYOUT_USD,
  MIN_HARVEST_USD,
  ONLY_INDEXES,
  PAYOUT_COST_MAX_BPS,
  POSITION_MANAGER,
  RPC_TIMEOUT_MS,
  RPC_URL,
  RUN_ONCE,
  SPLIT_CANDIDATES,
  SPLIT_LOOKBACK,
  V3_FACTORY,
  LAUNCH_FEE_TIER,
  WETH,
  ZERO,
  chain,
} from "./config.js";
import { quote } from "./venue.js";
import { unitsForUsd, usdPrice, usdValue } from "./prices.js";
import { fetchHolders } from "./holders.js";
import { announce } from "./notify.js";


const account = privateKeyToAccount(KEEPER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL, { batch: true, timeout: RPC_TIMEOUT_MS }) });
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL, { timeout: RPC_TIMEOUT_MS }) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Treasuries whose implementation predates `allocate()`: asked once, then never again. */
const noAllocatePath = new Set<Address>();
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const now = () => Math.floor(Date.now() / 1000);
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
/** `mode` on the treasury: 0 buys the basket and pays it out, 1 buys the coin back and destroys it. */
const MODE_BUYBACK = 1;

/**
 * A token's decimals, asked once and kept.
 *
 * NOT A CONSTANT 8. Every Base equity carries eight, and the buy leg was written against that — but
 * `basket` is whatever `createIndex` was given, and the treasury only requires each entry to hold
 * code. It never checks that an entry is a B20, because it has no way to: they are Rust precompiles.
 * So an eighteen-decimal token in a basket asked Velora to route a trade 10^10 the intended size,
 * which either fails to quote or quotes something absurd, and printed every figure about it wrong.
 *
 * `null` means the read did not land. Callers must SKIP the name rather than assume — a wrong scale
 * on a swap is not a display bug, it is the wrong amount of money through a router.
 *
 * Decimals are immutable, so a value that landed is cached for the life of the process, and only a
 * failure is retried.
 */
const decimalsCache = new Map<Address, number>();

async function decimalsOf(token: Address): Promise<number | null> {
  const hit = decimalsCache.get(token);
  if (hit !== undefined) return hit;
  try {
    const value = Number(
      await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
    );
    if (!Number.isInteger(value) || value < 0 || value > 36) return null;
    decimalsCache.set(token, value);
    return value;
  } catch {
    return null;
  }
}

/** An amount rendered at its own scale, or in raw units when that scale could not be read. */
const fmt = (amount: bigint, decimals: number | null) =>
  decimals === null ? `${amount} (raw)` : formatUnits(amount, decimals);
/** viem wraps the useful part; "unknown RPC error" on its own is never enough to act on. */
const why = (e: unknown) => {
  const x = e as { details?: string; shortMessage?: string; message?: string; cause?: { message?: string } };
  return x?.details ?? x?.cause?.message ?? x?.shortMessage ?? x?.message ?? String(e);
};

/**
 * The name of the custom error a call reverted with, or null if it did not revert at all — a
 * timeout, a dropped connection, a node having a bad minute.
 *
 * The distinction is the whole point: a contract saying no will say no again, and anything else is
 * worth another try.
 */
function revertName(e: unknown): string | null {
  const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown };
  if (typeof err?.walk !== "function") return null;
  const reverted = err.walk((x) => x instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | null;
  if (!reverted) return null;
  // A revert we cannot name is still a revert, and still deterministic.
  return reverted.data?.errorName ?? reverted.reason ?? "an error it does not declare";
}

/**
 * Sends a transaction, and asks the chain again if the nonce has moved underneath it.
 *
 * This keeper is not the only thing that can hold its key. A redeploy overlaps two containers for a
 * few seconds; the vault keeper runs on the same account; and a human sending one transaction by
 * hand moves the account too. All three look identical from here — the node rejects a nonce viem
 * worked out moments earlier — and all three are fixed the same way, by asking what the nonce is
 * now and sending again. Anything that is not a nonce complaint is a real failure and is rethrown.
 */
async function send(tx: (nonce?: number) => Promise<Hex>): Promise<Hex> {
  try {
    return await tx();
  } catch (e) {
    const msg = why(e).toLowerCase();
    if (!msg.includes("nonce")) throw e;
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    console.log(`      nonce moved under us — resending at ${nonce}`);
    return tx(nonce);
  }
}

/**
 * Baskets whose bind the chain has already refused, with the reason.
 *
 * Without this, a basket the keeper cannot bind costs a log scan and a failed simulation every
 * cycle, forever, and prints the same error each time. Nothing is lost by giving up: if the owner
 * binds it themselves, `coin` stops being zero and the basket never reaches this branch again.
 */
const unbindable = new Map<Address, string>();

/** Curves resolved once per process — a coin's curve never changes. */
const curveCache = new Map<Address, Address | null>();
const partyPoolCache = new Map<Address, Address | null>();
/**
 * Coin lookups, including the misses.
 *
 * A basket that is not bound yet costs a log scan to work out, and without remembering the miss the
 * keeper would redo that scan every single cycle — which is how a public RPC starts answering 429 to
 * everything, payouts included. A miss is retried, just not on every pass.
 */
const coinCache = new Map<Address, { coin: Address | null; at: number }>();
const COIN_MISS_TTL = Number(process.env.COIN_MISS_TTL_SEC ?? "1800");
/** Baskets whose static exclusions have been checked this process. */
const exclusionsDone = new Set<Address>();

/**
 * The soonest a round comes due anywhere, as a unix time — the cycle fills this in as it goes.
 *
 * Polling on a fixed interval means a round that ripens one second after a cycle waits a whole
 * cycle to be noticed: with a 15-minute basket and a 5-minute poll, payouts land up to five minutes
 * late for no reason. The keeper already learns every readyAt on its way past, so it can simply
 * sleep until the first one instead.
 */
let soonestReady: number | null = null;
const noteReady = (at: number) => {
  if (soonestReady === null || at < soonestReady) soonestReady = at;
};

// ─────────────────────────────────────────────────────────────────────── exclusions

/**
 * The pons bonding curve for a coin, from the launch event. Not every coin has one (a treasury can
 * be bound to any ERC20), so a miss is normal and not an error.
 */
/**
 * The pool that holds a coin's launch liquidity — never a holder in any meaningful sense.
 *
 * The whole supply is minted into one Uniswap V3 position at launch, so the pool is the largest
 * balance on nearly every coin and paying it would hand the round straight back to the pool. It is
 * derived rather than looked up: the coin, the quote it was launched against and the fee tier fix
 * the address, and `tokenQuote` on the locker is the authority on the second.
 */
async function liquidityHolders(coin: Address): Promise<Address[]> {
  try {
    const quoteAsset = (await publicClient.readContract({
      address: FEE_LOCKER,
      abi: lockerAbi,
      functionName: "tokenQuote",
      args: [coin],
    })) as Address;
    if (!quoteAsset || quoteAsset === ZERO) return [POSITION_MANAGER];

    const pool = (await publicClient.readContract({
      address: V3_FACTORY,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [coin, quoteAsset, LAUNCH_FEE_TIER],
    })) as Address;

    return pool && pool !== ZERO ? [pool, POSITION_MANAGER] : [POSITION_MANAGER];
  } catch {
    // The position manager alone is still worth excluding; a missed pool costs accuracy, not safety.
    return [POSITION_MANAGER];
  }
}

/**
 * Which coin an unbound treasury collects for, read off the locker rather than assumed.
 *
 * The sibling protocol needed two hops — an escrow credit naming a curve, then a launch record
 * turning that curve into a coin. Here it is one: `CreatorSplitSet` says a coin's split changed, and
 * `splitsOf` says whether this treasury is what it now points at. Nobody can forge that pair without
 * actually pointing a real launch's fees here, which is what makes it safe for the keeper to bind
 * rather than asking the creator to.
 *
 * The scan is bounded and walks backwards from the tip. A basket is created within hours of the
 * launch it collects for, so the first chunk normally answers — and an unbounded scan from block
 * zero is exactly what ran a sibling project's RPC bill up once before.
 *
 * Returns null when nothing points here yet: the ordinary case for a basket created ahead of its
 * launch, and a reason to wait rather than to guess.
 */
async function resolveCoinFor(treasury: Address, _quoteToken: Address): Promise<Address | null> {
  const seen = coinCache.get(treasury);
  if (seen?.coin) return seen.coin;
  if (seen && now() - seen.at < COIN_MISS_TTL) return null;

  const found = await _resolveCoinFor(treasury);
  coinCache.set(treasury, { coin: found, at: now() });
  return found;
}

async function _resolveCoinFor(treasury: Address): Promise<Address | null> {
  try {
    const tip = await publicClient.getBlockNumber();
    const floor = tip > SPLIT_LOOKBACK ? tip - SPLIT_LOOKBACK : 0n;
    const candidates: Address[] = [];

    for (let to = tip; to >= floor && candidates.length < SPLIT_CANDIDATES; to -= LOG_CHUNK) {
      const from = to - LOG_CHUNK + 1n > floor ? to - LOG_CHUNK + 1n : floor;
      const logs = await publicClient.getLogs({
        address: FEE_LOCKER,
        event: creatorSplitSetAbi[0],
        fromBlock: from,
        toBlock: to,
      });
      // Newest first: a coin whose split was repointed twice should be judged on the latest state,
      // and `splitsOf` below reads exactly that.
      for (const l of logs.reverse()) {
        const token = (l.args as Record<string, unknown>)?.token as Address | undefined;
        if (token && !candidates.includes(token)) candidates.push(token);
      }
      if (from === floor) break;
    }

    for (const coin of candidates) {
      const splits = (await publicClient.readContract({
        address: FEE_LOCKER,
        abi: lockerAbi,
        functionName: "splitsOf",
        args: [coin],
      })) as readonly { to: Address; bps: bigint }[];
      // The treasury binds on a whole stream only, so anything else is not its coin.
      if (splits.length === 1 && splits[0].bps === 10_000n && eq(splits[0].to, treasury)) return coin;
    }
    return null;
  } catch (e) {
    console.error(`    coin lookup failed: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
}

async function ensureExclusions(treasury: Address, coin: Address) {
  if (exclusionsDone.has(treasury)) return;
  exclusionsDone.add(treasury);

  const candidates: Address[] = [POSITION_MANAGER, ...EXTRA_EXCLUDES, ...(await liquidityHolders(coin))];

  const missing: Address[] = [];
  for (const a of candidates) {
    const [already, code] = await Promise.all([
      publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "excluded", args: [a] }),
      publicClient.getBytecode({ address: a }),
    ]);
    if (!already && code && code !== "0x") missing.push(a);
  }
  if (missing.length === 0) return;

  console.log(`    excluding ${missing.map(short).join(", ")}`);
  if (DRY_RUN) return;
  const hash = await send((nonce) =>
    wallet.writeContract({
      address: treasury,
      abi: treasuryAbi,
      functionName: "setExcludedBatch",
      args: [missing, true],
      nonce,
    })
  );
  await publicClient.waitForTransactionReceipt({ hash });
}

// ─────────────────────────────────────────────────────────────────────── the cycle

/**
 * Pull the launch's fees in — when there are enough of them to be worth the trip.
 *
 * `harvest()` RETURNS what it would collect, so a simulation answers the question for free and the
 * decision costs nothing. It already refused a literal zero; the floor is the same idea carried to
 * its conclusion, because a collect measured 335,000-449,000 gas on the live index and a fee stream
 * arrives as a trickle. Cranking every five minutes to move a tenth of a cent is a real cost paid
 * against no benefit.
 *
 * NOTHING IS LOST BY WAITING. The fees sit in the launchpad's locker either way, and `received` is
 * everything held that has not been split yet rather than what one call brought in — so a skipped
 * harvest is added to the next one instead of forgotten. If somebody else cranks the locker in the
 * meantime, the watermark counts that too.
 *
 * The floor matches the buy floor on purpose: money collected below it cannot be spent on anything
 * anyway, so harvesting it only moves it from one address to another and pays gas to do it.
 */
async function harvest(treasury: Address, quoteToken: Address, quoteDecimals: number) {
  try {
    const { result } = await publicClient.simulateContract({
      address: treasury,
      abi: treasuryAbi,
      functionName: "harvest",
      account,
    });
    const received = result as bigint;
    if (received === 0n) return 0n; // nothing pending: don't pay gas to learn that again

    // Priced, because "is this worth a transaction" is a question about dollars. An unpriced quote
    // falls through and harvests, which is the permissive direction the rest of these gates take.
    const worth = await usdValue(quoteToken, received, quoteDecimals);
    if (worth !== null && worth < MIN_HARVEST_USD) {
      console.log(
        `    holding: $${worth.toFixed(4)} of fees waiting, under the $${MIN_HARVEST_USD} floor — they keep accruing`
      );
      return 0n;
    }

    // The quote's own scale, not ether's. An 8-decimal quote printed as ether reads 10^10 too small.
    console.log(`    harvest ${fmt(received, quoteDecimals)}${worth === null ? "" : ` ($${worth.toFixed(2)})`}`);
    if (DRY_RUN) return result as bigint;
    const hash = await send((nonce) =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "harvest", nonce })
    );
    await publicClient.waitForTransactionReceipt({ hash });
    return result as bigint;
  } catch (e) {
    console.error(`    harvest skipped: ${(e as Error).message.split("\n")[0]}`);
    return 0n;
  }
}

/**
 * Buys each name whose slice is worth a round of its own.
 *
 * Slices come off ONE snapshot of the spendable balance taken up front, and what has already been
 * spent is tracked against it — sizing each buy off a freshly-read balance would let the last names
 * in the basket quietly spend the first ones' money.
 */
/**
 * What MIN_ROUND_ETH is worth in some other quote asset, priced once per cycle per token.
 *
 * pons launches pair against whatever the creator chose — a fifth of recent ones pair against a
 * stock rather than ether — and "is this slice worth a round" is a question about value, not about
 * a count of units. A single number in quote units cannot answer it for both a dollar stablecoin
 * and a $250 share: the same 20 means twenty dollars in one and five thousand in the other.
 *
 * So the rate is asked of the venue, which is already the thing that decides what anything is worth
 * here. A miss falls back to the configured unit count, which is wrong in the same way it always
 * was, rather than blocking the round.
 */
/**
 * An amount of some quote asset expressed in ether, or null if it cannot be priced.
 *
 * Only used to compare against gas, which is always in wei. Comparing a token amount directly
 * against a gas cost is out by however many orders of magnitude separate the two units — for a
 * six-decimal stablecoin that is twelve, which is enough to make every round look uneconomic
 * forever.
 */
async function valueInEth(quoteToken: Address, amount: bigint, decimals: number): Promise<bigint | null> {
  const [quoteUsd, ethUsd] = await Promise.all([usdPrice(quoteToken), usdPrice(WETH)]);
  if (quoteUsd === null || ethUsd === null || ethUsd <= 0) return null;
  const dollars = (Number(amount) / 10 ** decimals) * quoteUsd;
  return BigInt(Math.floor((dollars / ethUsd) * 1e18));
}

/**
 * The per-name spend gate, converted from dollars into the quote the basket is paid in.
 *
 * The gate asks whether a slice is worth the transaction that would move it, and a transaction
 * costs dollars — so the threshold has to be stated in dollars and converted, not written in units
 * of whatever a coin was paired against. Written in units it was a different threshold for every
 * index: $20 against a stablecoin and $6,245 against AAPLc, which is why the first live
 * equity-quoted index would have had to grow 22,000x before anything happened.
 *
 * A quote nobody prices falls through to a floor low enough to be no gate at all. That direction is
 * deliberate: the old fallback refused forever, and an unpriced asset should cost us a check rather
 * than the programme. `PAYOUT_COST_MAX_BPS` still stands behind this on the expensive half.
 */
async function thresholdIn(quoteToken: Address, decimals: number): Promise<bigint> {
  const units = await unitsForUsd(quoteToken, MIN_ROUND_USD, decimals);
  if (units !== null && units > 0n) return units;
  console.log(`    ${short(quoteToken)} has no price — buying without a value floor`);
  return parseUnits(MIN_ROUND_UNPRICED, decimals);
}

async function allocate(treasury: Address, index: number, size: bigint, decimals: number): Promise<bigint> {
  if (noAllocatePath.has(treasury)) return 0n;

  const args = [BigInt(index), size] as const;
  console.log(`    allocate ${formatUnits(size, decimals)} (the fees are already the right asset)`);
  if (DRY_RUN) return size;

  try {
    await publicClient.simulateContract({
      address: treasury, abi: treasuryAbi, functionName: "allocate", args, account,
    });
  } catch (e) {
    if (!revertName(e)) {
      noAllocatePath.add(treasury);
      console.log("      this basket predates allocate() — its quote asset cannot be paid out");
    } else {
      console.error(`      allocate would revert: ${why(e)}`);
    }
    return 0n;
  }

  try {
    const hash = await send((nonce) =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "allocate", args, nonce })
    );
    await publicClient.waitForTransactionReceipt({ hash });
    return size;
  } catch (e) {
    console.error(`    allocate failed: ${why(e)}`);
    return 0n;
  }
}

async function buy(
  treasury: Address,
  quoteToken: Address,
  basket: readonly Address[],
  weights: readonly number[]
): Promise<bigint> {
  let spentTotal = 0n;
  const isNative = quoteToken === ZERO;
  const spendableRaw = (await publicClient.readContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "spendableQuote",
  })) as bigint;

  // One rule for both: ether is priced like anything else, so the native branch only decides where
  // the decimals come from.
  const decimals = isNative
    ? 18
    : Number(await publicClient.readContract({ address: quoteToken, abi: erc20Abi, functionName: "decimals" }));
  const threshold = await thresholdIn(quoteToken, decimals);

  // The treasury pays no gas, but leaving it bone dry means an owner rescue has nothing to work with.
  const spendable = isNative
    ? spendableRaw > ETH_CUSHION ? spendableRaw - ETH_CUSHION : 0n
    : spendableRaw;
  if (spendable === 0n) return 0n;

  let left = spendable;
  for (let i = 0; i < basket.length; i++) {
    const slice = (spendable * BigInt(weights[i])) / 10_000n;
    const size = slice > left ? left : slice;
    if (size < threshold) continue;

    /**
     * The basket entry that IS the quote asset needs no venue at all.
     *
     * A coin paired against NVDA is paid its fees in NVDA, so that slice is already the right asset:
     * buying it would mean selling it to itself and paying a spread to stand still. The treasury
     * moves it across its own books instead, and the round pays it out like anything else.
     */
    if (!isNative && basket[i].toLowerCase() === quoteToken.toLowerCase()) {
      const moved = await allocate(treasury, i, size, decimals);
      if (moved > 0n) {
        left -= moved;
        spentTotal += moved;
      }
      continue;
    }

    /**
     * Ask both venues and take the better fill.
     *
     * Rialto looked like the obvious first choice and measurement says otherwise: on the same size
     * at the same moment, Uniswap came out ahead on Take-Two by 1.9%, on Roblox by 0.05% and on
     * Trump Media by 0.11%, and never behind. They price differently — one an inventory, the other
     * public pools — so which is better is a question about this token at this size right now, not a
     * standing preference. Asking twice costs one HTTP request and can only improve the fill.
     *
     * Uniswap is asked only for native-quoted baskets: it pulls ERC20s through Permit2 rather than
     * an allowance, and the treasury deliberately does not implement that.
     */
    /**
     * One venue, asked once.
     *
     * The sibling protocol raced two integrations here because its chain had an RFQ desk with its
     * own inventory and a public-pool fallback for the names that desk would not carry. Base has no
     * such split: 0x already prices across Aerodrome, Uniswap and the rest in one request, so a
     * second route would be another way to get the same answer rather than a fallback.
     */
    /**
     * Both sides priced in the units they actually use, READ rather than assumed.
     *
     * Equities on Base carry 8 decimals and not 18, which is what the literal here used to say. It
     * was right about every asset the builder offers and wrong as a rule: `basket` is whatever
     * `createIndex` was handed, and `initialize` only requires an entry to hold code. Getting this
     * wrong does not fail loudly — it asks for a route 10^10 off and takes whatever comes back.
     */
    const buyDecimals = await decimalsOf(basket[i]);
    if (buyDecimals === null) {
      console.error(`    ${short(basket[i])}: decimals unreadable, skipping rather than guessing a scale`);
      continue;
    }

    const q = await quote(treasury, isNative ? ZERO : quoteToken, size, decimals, basket[i], buyDecimals);
    if (!q) continue;

    /**
     * The treasury refuses any venue its factory has not allowlisted, so this check only turns a
     * wasted transaction into a log line — but that matters: 0x rotates its Settler deployments, and
     * learning about it from a revert costs gas and says nothing about the cause.
     */
    const allowed = (await publicClient.readContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "venue",
      args: [q.venue],
    })) as boolean;
    if (!allowed) {
      console.error(`    quote targets ${short(q.venue)}, which the factory has not allowlisted — skipped`);
      continue;
    }

    console.log(
      `    buy ${formatUnits(q.sellAmount, decimals)} → ${short(basket[i])}`
        + ` (min ${formatUnits(q.minBuyAmount, buyDecimals)} via ${q.venues.join("+") || "velora"})`
    );
    if (DRY_RUN) {
      left -= q.sellAmount;
      spentTotal += q.sellAmount;
      continue;
    }
    try {
      const hash = await send((nonce) =>
        wallet.writeContract({
          address: treasury,
          abi: treasuryAbi,
          functionName: "swap",
          // A native-quoted basket sells WETH: the treasury wraps just-in-time and approves exactly
          // what it declares, which is what an allowance-based venue expects.
          args: [q.venue, q.sellToken, q.sellAmount, basket[i], q.minBuyAmount, q.data],
          nonce,
        })
      );
      await publicClient.waitForTransactionReceipt({ hash });
      left -= q.sellAmount;
      spentTotal += q.sellAmount;
    } catch (e) {
      console.error(`    swap failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return spentTotal;
}

/**
 * Coin balances for a list of addresses, in chunks.
 *
 * Firing several hundred eth_calls as one batch is how you find out what a node's limits are, and a
 * single dropped read here would silently drop a holder from the round. Chunked, retried, and null
 * on real failure so the caller can skip the round instead of paying an incomplete list.
 */
async function balancesOf(coin: Address, addrs: Address[]): Promise<bigint[] | null> {
  const out: bigint[] = [];
  for (let i = 0; i < addrs.length; i += BALANCE_CHUNK) {
    const slice = addrs.slice(i, i + BALANCE_CHUNK);
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        const bals = await Promise.all(
          slice.map((a) =>
            publicClient.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [a] })
          )
        );
        out.push(...(bals as bigint[]));
        done = true;
      } catch (e) {
        if (attempt === 3) {
          console.error(`    balance reads failed: ${(e as Error).message.split("\n")[0]}`);
          return null;
        }
        await sleep(400 * attempt);
      }
    }
  }
  return out;
}

/** Eligible holders, ascending — the order the contract requires so no address can appear twice. */
async function eligibleHolders(coin: Address, treasury: Address, floor: bigint): Promise<Address[] | null> {
  const raw = await fetchHolders(coin);
  if (!raw) return null;

  const skip = new Set<string>(
    [ZERO, DEAD, POSITION_MANAGER, treasury, coin, ...EXTRA_EXCLUDES].map((a) => a.toLowerCase())
  );
  for (const a of await liquidityHolders(coin)) skip.add(a.toLowerCase());

  const candidates = raw.filter((a) => !skip.has(a.toLowerCase()));
  if (candidates.length === 0) return [];

  const balances = await balancesOf(coin, candidates);
  if (!balances) return null;

  return candidates
    .filter((_, i) => balances[i] >= floor)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
}

/**
 * Pays out one name.
 *
 * Everything in one transaction when it fits, because `distribute()` pays the whole balance and
 * needs no arithmetic from us. When it doesn't fit, the round is split — and each batch is given its
 * share of the round's total, computed off the same snapshot, so the proportions survive the split.
 * The contract fixes the round's budget when the first batch opens it, which is what stops a swap
 * landing mid-round from being paid out as if it had been there all along.
 */
async function payOut(
  treasury: Address,
  coin: Address,
  index: number,
  amount: bigint,
  holders: Address[],
  /**
   * The scale of the token being handed out — which is the BASKET entry, not the coin and not ether.
   *
   * Every figure below used to be printed at 18. For an equity that is eight orders out: a round
   * moving 2.23 shares announced 0.00000000000000000223, and the Telegram post said the same. The
   * transfers were always right; only the account of them was wrong, which is the kind of error that
   * survives because nothing reverts.
   */
  decimals: number | null
) {
  const gas = (n: number) => GAS_BASE + GAS_PER_HOLDER * BigInt(n);

  if (holders.length <= MAX_HOLDERS_PER_TX) {
    console.log(`    pay [${index}] ${fmt(amount, decimals)} to ${holders.length} holders`);
    if (DRY_RUN) return;
    const hash = await send((nonce) =>
      wallet.writeContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "distribute",
        args: [BigInt(index), holders],
        gas: gas(holders.length),
        nonce,
      })
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    await announce(`Paid out ${fmt(amount, decimals)} to ${holders.length} holders`, receipt.transactionHash);
    return;
  }

  /**
   * Read what is actually there, as late as possible.
   *
   * `distribute()` reads the balance itself, so the single-batch path cannot get this wrong. The
   * batched path has to name an amount, and an amount read before the buy it was meant to hand out
   * is an amount that pays the previous round's dust instead: one round moved 61 wei to ten holders
   * while 2.23 shares sat untouched in the treasury.
   */
  const [onHand] = (await publicClient.readContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "pending",
    args: [BigInt(index)],
  })) as [bigint, bigint];
  if (onHand !== amount) {
    console.log(`    pay [${index}] balance moved since the round was sized: ${fmt(amount, decimals)} → ${fmt(onHand, decimals)}`);
    amount = onHand;
  }
  if (amount === 0n) return;

  const batches: Address[][] = [];
  for (let i = 0; i < holders.length; i += MAX_HOLDERS_PER_TX) {
    batches.push(holders.slice(i, i + MAX_HOLDERS_PER_TX));
  }

  const weights: bigint[] = [];
  let grand = 0n;
  for (const batch of batches) {
    const bals = await balancesOf(coin, batch);
    if (!bals) return; // an incomplete weighting would skew every batch that follows
    const sum = bals.reduce((s, b) => s + b, 0n);
    weights.push(sum);
    grand += sum;
  }
  if (grand === 0n) return;

  console.log(`    pay [${index}] ${fmt(amount, decimals)} to ${holders.length} holders in ${batches.length} batches`);
  if (DRY_RUN) return;

  let spent = 0n;
  for (let k = 0; k < batches.length; k++) {
    // The last batch takes the remainder rather than its own rounded share, so the batches add up to
    // exactly the round's budget and never one wei over it.
    const share = k === batches.length - 1 ? amount - spent : (amount * weights[k]) / grand;
    if (share <= 0n) continue;
    const hash = await send((nonce) =>
      wallet.writeContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "distributeAmount",
        args: [BigInt(index), share, batches[k]],
        gas: gas(batches[k].length),
        nonce,
      })
    );
    await publicClient.waitForTransactionReceipt({ hash });
    spent += share;
    console.log(`      batch ${k + 1}/${batches.length}: ${fmt(share, decimals)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────── per basket

async function runIndex(treasury: Address) {
  let [coin, quoteToken, paused, mode] = (await Promise.all([
    publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "coin" }),
    publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "quote" }),
    publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "paused" }),
    publicClient.readContract({ address: treasury, abi: treasuryAbi, functionName: "mode" }),
  ])) as [Address, Address, boolean, number];

  if (paused) return console.log(`  ${short(treasury)} paused`);

  if (coin === ZERO) {
    const refused = unbindable.get(treasury);
    if (refused) return console.log(`  ${short(treasury)} ${refused}`);

    const found = await resolveCoinFor(treasury, quoteToken);
    if (!found) return console.log(`  ${short(treasury)} not bound, and no launch has paid it yet`);
    console.log(`  ${short(treasury)} binding ${short(found)} (from the launchpad's own events)`);
    if (DRY_RUN) return;
    // Simulate first: a basket cloned from an older implementation will refuse, and sending anyway
    // would burn gas on the same revert every cycle.
    try {
      await publicClient.simulateContract({
        address: treasury, abi: treasuryAbi, functionName: "bind", args: [found], account,
      });
    } catch (e) {
      const name = revertName(e);
      if (!name) return console.error(`    bind failed: ${why(e)} — retrying next cycle`);
      /**
       * The permissionless bind — the one that proves itself against pons' launch registry — only
       * exists on the current implementation. A basket cloned from an earlier one keeps that one
       * forever, and there the call is owner-only, so this is the creator's to make, not ours.
       */
      const owner = await publicClient
        .readContract({ address: treasury, abi: treasuryAbi, functionName: "owner" })
        .catch(() => null);
      const note =
        name === "NotOwner"
          ? `cannot be bound by the keeper: it was cloned from an older implementation, where bind is owner-only${owner ? ` — only ${short(owner as string)} can call it` : ""}`
          : `cannot be bound: the treasury refuses with ${name}`;
      unbindable.set(treasury, note);
      return console.error(`    ${note}`);
    }
    const hash = await send((nonce) =>
      wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "bind", args: [found], nonce })
    );
    await publicClient.waitForTransactionReceipt({ hash });
    coin = found;
  }

  const symbol = await publicClient
    .readContract({ address: coin, abi: erc20Abi, functionName: "symbol" })
    .catch(() => short(coin));
  console.log(`  ${short(treasury)} · ${symbol}`);

  await ensureExclusions(treasury, coin);
  const quoteDecimals = quoteToken === ZERO ? 18 : (await decimalsOf(quoteToken)) ?? 18;
  await harvest(treasury, quoteToken, quoteDecimals);

  /**
   * A buyback has no basket by construction — what it buys is the coin, fixed when it bound. Read as
   * a one-name basket at 100% so it goes through the SAME buy as everything else: same dollar gate,
   * same venue, same measured fill. Buying a coin is not different from buying an equity, and the
   * treasury already permits it (`_swap` accepts `buyToken == coin` in this mode).
   */
  const [tokens, weights] = (mode === MODE_BUYBACK
    ? [[coin], [10_000]]
    : await publicClient.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "basketAll",
      })) as [Address[], number[]];

  /**
   * A buyback is a buy and a burn, and nothing else.
   *
   * It returns here rather than falling through, because everything below is about a payout ROUND —
   * `pending()`, the interval, the holder list — and a buyback has none of that. Reading `pending(0)`
   * on a treasury whose basket is empty by construction simply reverts, which is how this path
   * announced itself.
   *
   * No round gate either: `swap()` and `burn()` carry no interval on the treasury, and the dollar
   * floor inside `buy()` is the only thing that needs to hold.
   */
  if (mode === MODE_BUYBACK) {
    await buy(treasury, quoteToken, tokens, weights);
    const held = (await publicClient.readContract({
      address: coin, abi: erc20Abi, functionName: "balanceOf", args: [treasury],
    })) as bigint;
    if (held === 0n) return console.log("    nothing bought back to burn");

    const coinDecimals = (await decimalsOf(coin)) ?? 18;
    console.log(`    burn ${fmt(held, coinDecimals)}`);
    if (DRY_RUN) return;
    try {
      const hash = await send((nonce) =>
        wallet.writeContract({ address: treasury, abi: treasuryAbi, functionName: "burn", nonce })
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      await announce(`Burned ${fmt(held, coinDecimals)} ${symbol}`, receipt.transactionHash);
    } catch (e) {
      console.error(`    burn failed: ${why(e)}`);
    }
    return;
  }
  const stockSymbols = await Promise.all(
    tokens.map((t) =>
      publicClient.readContract({ address: t, abi: erc20Abi, functionName: "symbol" }).catch(() => short(t))
    )
  );

  // Which names' rounds have come due — on time alone, because the buy happens after this.
  const ready: number[] = [];
  const waiting: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const [, readyAt] = (await publicClient.readContract({
      address: treasury,
      abi: treasuryAbi,
      functionName: "pending",
      args: [BigInt(i)],
    })) as [bigint, bigint];
    if (Number(readyAt) <= now()) ready.push(i);
    else {
      noteReady(Number(readyAt));
      waiting.push(`${stockSymbols[i] ?? short(tokens[i])} in ${Math.ceil((Number(readyAt) - now()) / 60)}m`);
    }
  }

  // Saying nothing when a round has not come round yet reads exactly like a failure — and it is the
  // most common thing the keeper does.
  if (ready.length === 0) {
    if (waiting.length) console.log(`    holding: next round ${waiting.join(", ")}`);
    return;
  }

  /**
   * Buy immediately before paying out, not on every cycle that finds fees.
   *
   * The fees arrive continuously and the round is periodic, so buying eagerly meant several small
   * fills per payout — and each fill pays the spread on its own size. One larger fill per round is
   * strictly cheaper on a venue that quotes per trade, and the stock spends the same time held
   * either way, because it leaves in the very next transaction.
   */
  const spent = await buy(treasury, quoteToken, tokens, weights);

  const bought = spent > 0n;

  // Holders are fetched once and reused across the names, because it is the same list for all.
  const due: { index: number; amount: bigint }[] = [];
  for (const i of ready) {
    const [amount] = (await publicClient.readContract({
      address: treasury,
      abi: treasuryAbi,
      functionName: "pending",
      args: [BigInt(i)],
    })) as [bigint, bigint];
    // What survives a round is rounding dust: a few wei that divided into nothing. Paying it out
    // costs a full distribution's gas to move a millionth of a cent, and reads as a real payout in
    // the history. A round pays what it bought, or waits.
    if (amount > (bought ? 0n : MIN_PAYOUT_UNITS)) due.push({ index: i, amount });
  }
  if (due.length === 0) {
    console.log(bought ? "    nothing to pay out" : "    holding: under the buy threshold, nothing bought this round");
    return;
  }

  const floor = (await publicClient.readContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "minHolderBalance",
  })) as bigint;

  const holders = await eligibleHolders(coin, treasury, floor);
  if (holders === null) return console.error("    holder list unavailable — round skipped");
  if (holders.length === 0) return console.log("    no eligible holders");

  /**
   * Two gates, and they answer different questions.
   *
   * The payout is the expensive half of everything this keeper does: ~72,000 gas PER HOLDER measured
   * on live batches, against 306,000 for an entire swap. At 150 holders that is ~11M gas, thirty-five
   * times the buy — and `distribute()` runs once per basket entry, so a basket of four pays it four
   * times. The gas is the keeper's, not the treasury's, so a round that is not worth running is our
   * money, not the holders'.
   *
   * FIRST, IS IT WORTH ANYTHING. A dollar floor, because a round's value is a dollar amount and the
   * cost it is weighed against is too. Everything the round would pay out, priced.
   *
   * SECOND, IS IT WORTH IT TODAY. The floor alone cannot survive a gas spike — at 0.3 gwei a
   * 150-holder round costs about $7.60, which would eat a third of a $20 payout — so the ratio gate
   * stands behind it. It used to be reachable only for ether-quoted baskets, because nothing ever
   * priced anything else and `valueInEth` returned null for every one of them; it applies to all of
   * them now.
   *
   * Neither gate loses anything. The stock stays in the treasury and goes out in the next round,
   * which is the same stock plus more of it, moved once instead of twice.
   */
  let roundUsd: number | null = 0;
  for (const d of due) {
    const value = await usdValue(tokens[d.index], d.amount, (await decimalsOf(tokens[d.index])) ?? 8);
    if (value === null) { roundUsd = null; break; }
    roundUsd += value;
  }

  if (roundUsd !== null && roundUsd < MIN_PAYOUT_USD) {
    return console.log(
      `    holding: the round is worth $${roundUsd.toFixed(2)}, under the $${MIN_PAYOUT_USD} floor — it keeps accruing`
    );
  }

  const gasPrice = await publicClient.getGasPrice().catch(() => 0n);
  const gasCost = gasPrice * (GAS_BASE + GAS_PER_HOLDER * BigInt(holders.length));
  const worth = spent > 0n ? await valueInEth(quoteToken, spent, quoteDecimals) : null;
  if (worth !== null && worth > 0n && gasCost * 10_000n > worth * BigInt(PAYOUT_COST_MAX_BPS)) {
    return console.log(
      `    holding: paying ${holders.length} holders would cost ${formatEther(gasCost)} ETH ` +
        `against a round worth ${formatEther(worth)} — waiting for a bigger one`
    );
  }

  for (const d of due) {
    try {
      // The scale of the entry being paid out, not the coin's and not ether's. Cached after the
      // first name, so a basket of twelve costs at most twelve reads for the life of the process.
      await payOut(treasury, coin, d.index, d.amount, holders, await decimalsOf(tokens[d.index]));
    } catch (e) {
      console.error(`    payout [${d.index}] failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────── main

async function cycle() {
  soonestReady = null;
  const count = (await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "indexCount",
  })) as bigint;

  if (count === 0n) return console.log("no indexes yet");

  const all = (await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "indexesPaged",
    args: [0n, count],
  })) as Address[];

  const baskets = ONLY_INDEXES.size === 0 ? all : all.filter((b) => ONLY_INDEXES.has(b.toLowerCase()));

  console.log(
    `${baskets.length} index(es)${ONLY_INDEXES.size ? ` of ${all.length} (ONLY_INDEXES)` : ""}`
  );
  for (const b of baskets) {
    try {
      await runIndex(b);
    } catch (e) {
      console.error(`  ${short(b)} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function main() {
  // The poll interval belongs in the banner: "nothing happened" and "nothing happened yet" look the
  // same in a log, and only one of them is a problem.
  console.log(
    `indices keeper · ${account.address} · factory ${short(FACTORY)} · every ${INTERVAL_SEC}s${DRY_RUN ? " · DRY RUN" : ""}`
  );

  // The single operational mistake worth failing loudly on: an unauthorised wallet reverts every
  // swap and every payout, one at a time, forever, while looking perfectly healthy in the logs.
  const authorised = (await publicClient.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "keeper",
    args: [account.address],
  })) as boolean;
  if (!authorised) {
    throw new Error(`${account.address} is not an authorised keeper — run factory.setKeeper(${account.address}, true)`);
  }

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`gas balance ${formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("keeper wallet has no ETH for gas");

  /**
   * Say up front what the gates are, because they decide whether this keeper does anything at all.
   *
   * A seeded WETH rate used to live here — the one asset that could be priced, patched in so a
   * WETH-quoted basket would not stall. Every asset is priced now, so there is nothing to seed and
   * nothing left that only works for ether.
   */
  console.log(
    `collect at $${MIN_HARVEST_USD}+ · buy at $${MIN_ROUND_USD}+ per name · pay out at $${MIN_PAYOUT_USD}+ per round` +
      ` · gas capped at ${PAYOUT_COST_MAX_BPS / 100}% of it`
  );

  for (;;) {
    const started = Date.now();
    try {
      await cycle();
    } catch (e) {
      console.error(`cycle failed: ${(e as Error).message.split("\n")[0]}`);
    }
    if (RUN_ONCE) return;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    /**
     * Wake for the next round, or for the routine pass, whichever comes first.
     *
     * The routine pass still matters — fees arrive between rounds and a new basket can appear at any
     * time — but a round that ripens just after a cycle should not wait a whole cycle to be noticed.
     * The extra second is so the chain's clock is unambiguously past readyAt when the call lands.
     */
    const routine = Math.max(5, INTERVAL_SEC - elapsed);
    const untilRound = soonestReady === null ? routine : Math.max(5, soonestReady - now() + 1);
    const wait = Math.min(routine, untilRound);
    if (wait < routine) console.log(`sleeping ${wait}s — a round comes due before the next pass`);
    await sleep(wait * 1000);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
