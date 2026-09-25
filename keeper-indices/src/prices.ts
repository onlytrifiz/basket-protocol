import type { Address } from "viem";

import { WETH, ZERO } from "./config.js";

/**
 * What a token is worth in dollars.
 *
 * WHY THIS EXISTS AT ALL, given the design goes out of its way not to depend on a price feed.
 *
 * It is not used to decide WHAT to buy or to validate a fill — those stay exactly as they were, on
 * the venue's own quote and the treasury's measured balance delta. It is used for one thing: to size
 * a gas threshold. "Is this slice worth the transaction it would take to move it" is a question
 * about dollars and gas, and there is no way to answer it in units of an arbitrary token.
 *
 * The old thresholds tried anyway, in whole units of the quote asset, and the result is a constant
 * whose real value swings by eight orders of magnitude depending on what a coin happened to be
 * paired against:
 *
 *     MIN_ROUND_QUOTE = 20  ->  $20 against USDC
 *                           ->  $6,245 against AAPLc
 *                           ->  $64,000 against WETH
 *                           ->  $0.0000008 against a memecoin
 *
 * The first live equity-quoted index needed to accumulate 22,000x what it held before the keeper
 * would touch it. Its own comment in `keeper.ts` names this shape — it had already happened once
 * with USDG — and it was patched for WETH by seeding the rate, which fixed one asset rather than
 * the reasoning.
 *
 * FAILING TO PRICE MUST BE PERMISSIVE. That is the other half. The old fallback was "20 whole
 * units", which for anything valuable means never acting again — a silent, permanent stall that
 * looks exactly like an index with no fees. A price we cannot fetch has to degrade to "we cannot
 * gate on value", never to "refuse forever".
 */

const DEX = "https://api.dexscreener.com/token-pairs/v1/base";
/** Prices move; a few minutes is plenty for sizing a threshold, and it keeps the API quiet. */
const TTL_MS = Number(process.env.PRICE_TTL_MS ?? "300000");

/**
 * How old a last-known price may be and still stand in for one that did not arrive.
 *
 * Every caller uses a price for one thing — sizing a gate — and a gate is coarse: a $10 floor, a 5%
 * gas ratio. A price from a few hours ago answers those as well as a fresh one. What it must not
 * become is a price from a different market, so past this age a miss is a miss again and the gates
 * fall back to permissive, as they always did.
 */
const STALE_MAX_MS = Number(process.env.PRICE_STALE_MAX_MS ?? "86400000");

const cache = new Map<string, { usd: number | null; at: number }>();
/**
 * The last price that actually arrived, per token, however long ago — kept apart from `cache`,
 * which also remembers misses.
 *
 * Without it, one refused request to the price API was a five-minute hole in which every treasury
 * quoted in that token acted without a dollar gate: seen on 2026-09-25, when NVDAc, GOOGLc and AAPLc
 * went unpriced for a pass and treasuries whose fees had been priced at $0.03 minutes earlier were
 * harvested anyway — a transaction's gas to move three cents.
 */
const lastGood = new Map<string, { usd: number; at: number }>();

/** The last real price, if it is recent enough to gate on; null otherwise. */
function lastKnown(key: string): number | null {
  const good = lastGood.get(key);
  return good && Date.now() - good.at < STALE_MAX_MS ? good.usd : null;
}

async function fetchUsd(token: Address): Promise<number | null> {
  try {
    const response = await fetch(`${DEX}/${token}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const pairs = await response.json() as Array<{
      baseToken?: { address?: string };
      priceUsd?: string;
      liquidity?: { usd?: number };
    }>;
    if (!Array.isArray(pairs)) return null;

    // The token must be the pair's BASE side, or `priceUsd` describes the other asset — the same
    // trap `lib/pools.ts` documents on the web side. Deepest pool wins.
    const own = pairs
      .filter((p) => p.baseToken?.address?.toLowerCase() === token.toLowerCase() && Number(p.priceUsd) > 0)
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0));

    const price = Number(own[0]?.priceUsd ?? 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Dollars for one whole unit of `token`. Native and WETH are the same asset.
 *
 * A lookup that fails answers with the last price that arrived, up to STALE_MAX_MS old; `null` only
 * when there has never been one, or none recently enough.
 */
export async function usdPrice(token: Address): Promise<number | null> {
  const key = (token === ZERO ? WETH : token).toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.usd ?? lastKnown(key);

  const usd = await fetchUsd(key as Address);
  // A miss is cached too, briefly, so a token nothing prices does not mean a request every cycle.
  cache.set(key, { usd, at: Date.now() });
  if (usd !== null) {
    lastGood.set(key, { usd, at: Date.now() });
    return usd;
  }
  const fallback = lastKnown(key);
  if (fallback !== null) {
    const ageMin = Math.round((Date.now() - lastGood.get(key)!.at) / 60_000);
    // Once per miss window, not per caller: the miss itself is cached for TTL_MS.
    console.log(`    price for ${key.slice(0, 8)}…${key.slice(-4)} unavailable — using the last one, ${ageMin} min old`);
  }
  return fallback;
}

/**
 * `amount` of `token`, in dollars — or null when the token cannot be priced.
 *
 * Callers treat null as "no opinion" and fall through to whatever they do without a price, which
 * must never be "refuse". See the note at the top.
 */
export async function usdValue(token: Address, amount: bigint, decimals: number): Promise<number | null> {
  const price = await usdPrice(token);
  if (price === null) return null;
  return (Number(amount) / 10 ** decimals) * price;
}

/** Whole units of `token` that come to `usd` dollars, or null when it cannot be priced. */
export async function unitsForUsd(token: Address, usd: number, decimals: number): Promise<bigint | null> {
  const price = await usdPrice(token);
  if (price === null || price <= 0) return null;
  return BigInt(Math.floor((usd / price) * 10 ** decimals));
}
