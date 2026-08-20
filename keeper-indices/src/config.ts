import "dotenv/config";
import { defineChain, parseEther, type Address, type Hex } from "viem";

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

export const RPC_URL = must("RPC_URL");
export const KEEPER_PRIVATE_KEY = must("KEEPER_PRIVATE_KEY") as Hex;
export const FACTORY = must("INDEX_FACTORY") as Address;

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 8453);

export const chain = defineChain({
  id: CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Basescan", url: "https://basescan.org" } },
});

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const DEAD = "0x000000000000000000000000000000000000dEaD" as Address;
export const WETH = "0x4200000000000000000000000000000000000006" as Address;

/**
 * The launchpad's fee locker — the same address the factory has registered as launchpad 0.
 *
 * The keeper reads it for two things a treasury cannot tell it: which coin's split points at a
 * given treasury (so an unbound one can be repaired), and whether a split it is already collecting
 * for has since been pointed away.
 */
export const FEE_LOCKER = (process.env.FEE_LOCKER
  ?? "0x71D1D363176723f85d98B8B430DF33cde89f0A7f") as Address;

/**
 * Etherscan V2 — the holder list, and nothing else.
 *
 * `tokenholderlist` is a **Pro** endpoint. Base's Blockscout is not a fallback: it serves token
 * metadata but does not index balances and answers every holder query with an empty set, so a key
 * that loses Pro means rounds are skipped, not that they quietly pay nobody. See `holders.ts`.
 */
export const EXPLORER_API = process.env.EXPLORER_API ?? "https://api.etherscan.io/v2/api";
export const EXPLORER_API_KEY = must("ETHERSCAN_API_KEY");

/**
 * Slippage the route is asked to respect, and therefore the floor the treasury enforces.
 *
 * There is no venue key to configure: Velora's Market API needs none, which is also why it is what
 * the sibling protocol's keeper already routes live buys through. See `venue.ts`.
 */
export const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? "300");

/**
 * A stock is only bought once its own slice of the pending fees is worth this much.
 *
 * The gate is PER STOCK, not per round, because a payout costs gas per stock per holder. A basket of
 * seven therefore needs seven times this accumulated before it moves at all; small weights simply
 * pay less often, and nothing is lost while they wait.
 */
export const MIN_ROUND_ETH = parseEther(process.env.MIN_ROUND_ETH ?? "0.01");
/** The same gate for an ERC20-quoted basket, in whole units of that quote. */
export const MIN_ROUND_QUOTE = process.env.MIN_ROUND_QUOTE ?? "20";

/**
 * Distribution gas is linear in holders; beyond this the round is split into batches.
 *
 * Base is an OP Stack chain with a 30M block gas limit, so a batch has to fit well inside it —
 * unlike the Orbit chain this keeper came from, where the constraint was the per-transaction cap.
 */
export const MAX_HOLDERS_PER_TX = Number(process.env.MAX_HOLDERS_PER_TX ?? "150");
export const GAS_PER_HOLDER = BigInt(process.env.GAS_PER_HOLDER ?? "70000");
export const GAS_BASE = BigInt(process.env.GAS_BASE ?? "400000");

export const INTERVAL_SEC = Number(process.env.INTERVAL_SEC ?? "300");
export const RUN_ONCE = process.env.RUN_ONCE === "1";
export const DRY_RUN = process.env.DRY_RUN === "1";

/** Native ETH left in a treasury so a later claim has room to move. */
export const ETH_CUSHION = parseEther(process.env.ETH_CUSHION ?? "0.00002");

/**
 * Addresses that hold a coin but are not holders in any meaningful sense.
 *
 * The Uniswap V3 position manager is the big one: every launch's whole supply is minted into a
 * single position it custodies, so it is always the largest "holder" of a coin that has not traded
 * much, and paying it would hand the round back to the pool. The pool itself is added per basket at
 * bind time, resolved from the locker's registered position.
 */
export const POSITION_MANAGER =
  "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as Address;
export const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address;

/**
 * How far back to look for the split that names a treasury.
 *
 * A bounded scan, and deliberately so: an unbounded `getLogs` from block zero is what ran a sibling
 * project's RPC bill up once before. A basket is created within hours of the launch it collects for,
 * so the first chunk normally answers, and a coin older than the window is bound by hand rather than
 * by paying for a full-history scan on every cycle.
 */
export const SPLIT_LOOKBACK = BigInt(process.env.SPLIT_LOOKBACK ?? "500000");
export const LOG_CHUNK = BigInt(process.env.LOG_CHUNK ?? "9500");
export const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? "60000");

/** Run the cycle for these baskets only, comma-separated. Empty means all of them. */
export const ONLY_INDEXES = new Set(
  (process.env.ONLY_INDEXES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export const EXTRA_EXCLUDES = (process.env.EXTRA_EXCLUDES ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean) as Address[];

/** `balanceOf` reads per multicall. A few hundred in one batch finds a node's limits. */
export const BALANCE_CHUNK = Number(process.env.BALANCE_CHUNK ?? "50");

/**
 * Dust floor on a payout, in raw units of the stock being paid.
 *
 * Base equities carry 8 decimals, not 18 — so this is 0.001 of a share here, where the same
 * intent on an 18-decimal chain was written as 1e15. Copying that number across would have set a
 * floor ten orders of magnitude too high and silently stopped every payout.
 */
export const MIN_PAYOUT_UNITS = BigInt(process.env.MIN_PAYOUT_UNITS ?? "100000"); // 0.001 share @ 8dp

/** A round is deferred when its gas would eat more than this share of what it pays out. */
export const PAYOUT_COST_MAX_BPS = Number(process.env.PAYOUT_COST_MAX_BPS ?? "500"); // 5%

/** How many split events one repair pass will inspect before giving up for this cycle. */
export const SPLIT_CANDIDATES = Number(process.env.SPLIT_CANDIDATES ?? "200");

/**
 * The pool tier every launch opens at, and therefore the one the liquidity sits in.
 *
 * Fixed in StonkLauncher2, not a setting — see the 1% config note in DEPLOYMENTS.md. The keeper only
 * needs it to derive the pool address so it can exclude it from a payout.
 */
export const LAUNCH_FEE_TIER = Number(process.env.LAUNCH_FEE_TIER ?? "10000");

/** How long an unnamed basket waits before its coin is looked for again. */
export const COIN_MISS_TTL = Number(process.env.COIN_MISS_TTL_SEC ?? "1800");
