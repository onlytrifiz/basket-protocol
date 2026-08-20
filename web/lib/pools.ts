/**
 * Live pool data for the tokenized equities, via DexScreener.
 *
 * WHY A SERVER ROUTE. Each token needs `token-pairs/v1` — the batch endpoint returns only the single
 * most liquid pair per token, which would hide entire venues, and NVDAc alone trades across thirty
 * pools. Made here, Next's fetch cache collapses a page load into one upstream set per minute for
 * every visitor at once, which is also what keeps us clear of DexScreener's rate limit.
 *
 * THE EQUITY MUST BE THE PAIR'S BASE TOKEN. Where it sits on the quote side, `priceUsd` describes
 * the *other* asset — a memecoin/NVDAc pool would otherwise report a memecoin's price as NVIDIA's.
 */

const DEX_API = "https://api.dexscreener.com/token-pairs/v1/base";
const MAX_ADDRS = 20;

/**
 * A pool must clear this before it is allowed to quote the headline price.
 *
 * Observed live while building this: NVDAc quoted at $220.33 in a $237k Aerodrome pool, $226.91 in a
 * $28k Uniswap v4 pool, and $236.64 in a pool holding $642. Below a few thousand dollars a single
 * retail-sized trade *is* the price. Thin pools are still listed on the detail page — they are real,
 * and someone routing a small order may want them — but they are marked, and they never set the
 * number a visitor reads as "the price of NVDAc".
 */
export const MIN_LIQUIDITY_USD = 5_000;

type DexPair = {
  dexId: string;
  labels?: string[];
  url: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
};

export type Pool = {
  venue: string;
  /** DexScreener's flavour tag: "v4", "CL", … Empty for a plain v2-style pool. */
  label: string;
  pairAddress: string;
  url: string;
  quoteSymbol: string;
  priceUsd: number;
  /** Price in the pair's QUOTE token — for an ETH-quoted pool, the token's price in ETH. This is
   *  what a direct router needs: USD would have to be converted back through an ETH price. */
  priceNative: number;
  liquidityUsd: number;
  volume24Usd: number;
  priceChange24: number;
  txns24: number;
  /** False when the pool is too thin to be trusted with a price. Shown, but never quoted. */
  quotable: boolean;
};

export type TokenPools = {
  /** The deepest quotable pool — the one whose price the UI is allowed to show. */
  best: Pool | null;
  /** Deepest quotable pool per venue, so a visitor can compare Aerodrome against Uniswap. */
  venues: Pool[];
  poolCount: number;
  /** Summed across every pool, thin ones included: this is depth, not a price. */
  liquidityUsd: number;
  volume24Usd: number;
  /** Every pool, deepest first. Only populated when the caller asks for `full=1`. */
  pools?: Pool[];
};

function toPool(pair: DexPair, minLiq: number): Pool {
  const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
  const txns = pair.txns?.h24;
  return {
    venue: pair.dexId,
    label: (pair.labels ?? []).join(" "),
    pairAddress: pair.pairAddress,
    url: pair.url,
    quoteSymbol: pair.quoteToken?.symbol ?? "",
    priceUsd: Number(pair.priceUsd ?? 0),
    priceNative: Number(pair.priceNative ?? 0),
    liquidityUsd: Math.round(liquidityUsd),
    volume24Usd: Math.round(Number(pair.volume?.h24 ?? 0)),
    priceChange24: Number(pair.priceChange?.h24 ?? 0),
    txns24: Number(txns?.buys ?? 0) + Number(txns?.sells ?? 0),
    quotable: Boolean(pair.priceUsd) && liquidityUsd >= minLiq,
  };
}

export async function poolsFor(address: string, minLiq: number, full: boolean): Promise<TokenPools> {
  let pairs: DexPair[] = [];
  try {
    const response = await fetch(`${DEX_API}/${address}`, { next: { revalidate: 60 } });
    if (response.ok) {
      const payload = await response.json() as unknown;
      if (Array.isArray(payload)) pairs = payload as DexPair[];
    }
  } catch {
    // An unreachable price API degrades to "no market" cells, never to a broken page.
  }

  const own = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === address);
  const pools = own.map((p) => toPool(p, minLiq)).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const quotable = pools.filter((p) => p.quotable);

  // One entry per venue, each from that venue's DEEPEST pool. `pools` is already sorted, so the
  // first sighting of a venue is its deepest.
  const seen = new Set<string>();
  const venues = quotable.filter((p) => (seen.has(p.venue) ? false : (seen.add(p.venue), true)));

  return {
    best: quotable[0] ?? null,
    venues,
    poolCount: pools.length,
    liquidityUsd: pools.reduce((sum, p) => sum + p.liquidityUsd, 0),
    volume24Usd: pools.reduce((sum, p) => sum + p.volume24Usd, 0),
    ...(full ? { pools } : {}),
  };
}

/**
 * ETH in dollars, from the deepest WETH pair DexScreener knows.
 *
 * Needed because an index quoted in ether collects and pays in ether, and a figure a reader can
 * weigh has to be in dollars. Taken from the pair data this module already fetches rather than from
 * a new price API: `priceUsd` on a pair whose BASE token is WETH is the ETH price by definition.
 */
export async function ethUsd(): Promise<number | null> {
  const WETH = "0x4200000000000000000000000000000000000006";
  try {
    const response = await fetch(`${DEX_API}/${WETH}`, { next: { revalidate: 120 } });
    if (!response.ok) return null;
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) return null;
    const best = (payload as DexPair[])
      .filter((p) => p.baseToken?.address?.toLowerCase() === WETH && Number(p.priceUsd) > 0)
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
    const price = Number(best?.priceUsd ?? 0);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** Pool data for a set of tokens, keyed by lowercase address. */
export async function poolsForAll(
  addresses: string[],
  opts?: { minLiq?: number; full?: boolean },
): Promise<Record<string, TokenPools>> {
  const addrs = addresses
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
    .slice(0, MAX_ADDRS);
  const entries = await Promise.all(
    addrs.map(async (a) => [a, await poolsFor(a, opts?.minLiq ?? MIN_LIQUIDITY_USD, opts?.full ?? false)] as const),
  );
  return Object.fromEntries(entries);
}
