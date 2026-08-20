import { type Address, type Hex } from "viem";
import { SLIPPAGE_BPS, WETH, ZERO, CHAIN_ID } from "./config.js";

/**
 * Where a buy is routed — Velora (formerly ParaSwap) Market API.
 *
 * Ported from the sibling protocol's keeper, which has been routing live B20 buys through it: on a
 * probe it split one leg across `aerodromeslipstreamfactory3` and `kipseli` and beat a hand-built
 * two-hop route. It searches every venue on Base rather than the one we happened to know about, and
 * it needs no API key.
 *
 * THE CONSTRAINT THAT BINDS THERE DOES NOT BIND HERE, and it is worth saying why. Augustus v6.2
 * encodes `srcAmount` TWICE, so a caller that patches one word leaves the other stale — which is
 * what forces StockVault to use Velora only when its spend cap binds and the amount is predictable.
 * BasketTreasury never rewrites calldata: it forwards what it was handed and MEASURES what was
 * actually spent and received. There is nothing to patch and nothing to fall out of step, so Velora
 * can be used on every buy regardless of size.
 *
 * What does carry over is the operational cost: Velora routes through RFQ venues whose calldata
 * holds a market maker's signed order, valid for seconds. A quote can be dead before the transaction
 * lands, and the swap reverts. Nothing is lost — the fees stay in the treasury and the next cycle
 * quotes again — but expect it in the logs rather than treating it as a fault.
 */
const ENDPOINT = process.env.VELORA_API ?? "https://api.velora.xyz/swap";
export const AUGUSTUS = "0x6A000F20005980200259B80c5102003040001068" as Address;

export type Quote = {
  venue: Address;
  /** What the treasury is told to sell. Native is quoted as WETH — see below. */
  sellToken: Address;
  sellAmount: bigint;
  buyToken: Address;
  /** The floor the treasury enforces against its own measured balance delta. */
  minBuyAmount: bigint;
  data: Hex;
  venues: string[];
};

const why = (e: any) => e?.cause?.message ?? e?.message ?? String(e);

/**
 * A route for `sellAmount` of `sellToken` into `buyToken`, delivered to `taker`.
 *
 * Native sells are quoted as WETH and settled as an allowance pull. The treasury wraps just-in-time
 * and approves exactly the amount it declares, so a route asking for native `value` would leave that
 * approval unused and fail — which is why a non-zero `value` is refused rather than sent.
 */
export async function quote(
  taker: Address,
  sellToken: Address,
  sellAmount: bigint,
  sellDecimals: number,
  buyToken: Address,
  buyDecimals: number
): Promise<Quote | null> {
  const sell = sellToken === ZERO ? WETH : sellToken;
  const query = new URLSearchParams({
    srcToken: sell,
    srcDecimals: String(sellToken === ZERO ? 18 : sellDecimals),
    destToken: buyToken,
    destDecimals: String(buyDecimals),
    amount: sellAmount.toString(),
    side: "SELL",
    network: String(CHAIN_ID),
    version: "6.2",
    userAddress: taker,
    receiver: taker,
    slippage: String(SLIPPAGE_BPS),
    partner: "stonks",
  });

  /**
   * Velora refuses a pair it cannot price in dollars, and a freshly launched coin is exactly that.
   *
   *   "Bad USD price. Pass ignoreBadUsdPrice=true as a query param to bypass the USD impact check"
   *
   * IT IS ABOUT THE PAIR, NOT THE SIZE, which is worth knowing before treating it as a thin-pool
   * problem. Measured against the live buyback coin, every amount from three cents to three hundred
   * dollars was refused identically, and every one of them routed once the flag was set:
   *
   *   $0.03  Bad USD price      $0.03  ok
   *   $3.12  Bad USD price      $55    ok, through a plain Uniswap v3 pool
   *   $312   Bad USD price
   *
   * So it is not a liquidity floor. Velora's impact check needs a dollar price for both sides, a
   * coin minted an hour ago has none anywhere, and the check cannot run — so it refuses and hands
   * back the flag to skip it. Every freshly launched coin meets this. For a buyback index it is not
   * an edge case, it is the ordinary state of the thing it exists to buy.
   *
   * Retried rather than waived up front, so the check still applies wherever it can run.
   *
   * WHAT STILL PROTECTS THE FILL: `minBuyAmount`, derived from the route's own quoted output at our
   * slippage and enforced by the treasury against its own measured balance delta. A floor on what
   * actually arrives, owing nothing to whether anyone can price either side.
   */
  const ask = async (bypass: boolean) => {
    const q = new URLSearchParams(query);
    if (bypass) q.set("ignoreBadUsdPrice", "true");
    const res = await fetch(`${ENDPOINT}?${q}`, { signal: AbortSignal.timeout(25_000) });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) as any };
  };

  let payload: any;
  try {
    let r = await ask(false);
    if (!r.ok && /bad usd price/i.test(String(r.body?.error ?? ""))) {
      console.log("    velora cannot price this pair — retrying without its USD impact check");
      r = await ask(true);
    }
    if (!r.ok) {
      console.error(`    velora → HTTP ${r.status}${r.body?.error ? `: ${String(r.body.error).slice(0, 90)}` : ""}`);
      return null;
    }
    payload = r.body;
  } catch (e) {
    console.error(`    velora → ${why(e)}`);
    return null;
  }
  if (payload.error || !payload.priceRoute || !payload.txParams) {
    console.error(`    velora → ${String(payload?.error ?? "no route").slice(0, 100)}`);
    return null;
  }

  const { priceRoute, txParams } = payload;

  // The route has to be an allowance pull of exactly what we asked for, delivered to the treasury.
  if (BigInt(priceRoute.srcAmount) !== sellAmount) {
    console.error("    velora → quoted a different srcAmount");
    return null;
  }
  if (BigInt(txParams.value ?? "0") !== 0n) {
    console.error("    velora → route wants native value, expected a WETH pull");
    return null;
  }
  /**
   * Refused rather than submitted. The treasury only calls venues its factory allowlists, so this
   * would revert anyway — but learning that Velora moved its entrypoint from a reverted transaction
   * costs gas and says nothing about the cause.
   */
  if (String(txParams.to).toLowerCase() !== AUGUSTUS.toLowerCase()) {
    console.error(`    velora → unexpected router ${txParams.to}`);
    return null;
  }

  /**
   * The floor the treasury measures its own balance delta against, and therefore the only protection
   * on the fill. Derived from the route's own quoted output at the slippage asked, rather than a
   * number this keeper invented — a guess here would be a guess the contract then enforces.
   */
  const minBuyAmount = (BigInt(priceRoute.destAmount) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  if (minBuyAmount === 0n) {
    console.error("    velora → quote rounds to a zero minimum, refusing");
    return null;
  }

  const venues = new Set<string>();
  for (const hop of priceRoute.bestRoute ?? []) {
    for (const swap of hop.swaps ?? []) {
      for (const exchange of swap.swapExchanges ?? []) venues.add(exchange.exchange);
    }
  }

  return {
    venue: AUGUSTUS,
    sellToken: sell,
    sellAmount,
    buyToken,
    minBuyAmount,
    data: txParams.data as Hex,
    venues: [...venues],
  };
}
