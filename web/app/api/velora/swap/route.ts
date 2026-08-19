import { apiError, isAddress, isPositiveInteger, isRateLimited, isSupportedOutput } from "../../shared";

/**
 * Server-side proxy for Velora's Market API.
 *
 * Velora replaces the previous Uniswap Trading API call for one reason that matters here: B20 equity
 * depth is split across venues. On live quotes it routes these assets through Aerodrome Slipstream
 * and Uniswap v4 in the same trade, which a single-venue router cannot do. It also needs no API key,
 * so the site has no secret to leak.
 *
 * Proxied rather than called from the browser so the allowlist below is enforced server-side: only
 * the protocol token and the assets in the published index can be requested.
 */
const ENDPOINT = "https://api.velora.xyz/swap";
/** Velora's native-asset sentinel. The browser leg pays in ETH directly: no wrap, no approval. */
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export async function POST(request: Request) {
  if (isRateLimited(request)) return apiError("Too many requests. Try again shortly.", 429);

  const body = await request.json().catch(() => null) as
    | { amount?: unknown; swapper?: unknown; tokenOut?: unknown; decimals?: unknown }
    | null;
  if (!body) return apiError("Malformed request body.", 400);
  if (!isPositiveInteger(body.amount)) return apiError("Amount must be a positive integer in wei.", 400);
  if (!isAddress(body.swapper)) return apiError("A connected wallet address is required.", 400);
  if (!isSupportedOutput(body.tokenOut)) return apiError("That output token is not part of Stockify.", 400);

  const query = new URLSearchParams({
    amount: body.amount,
    destDecimals: String(typeof body.decimals === "number" ? body.decimals : 8),
    destToken: body.tokenOut,
    network: "8453",
    partner: "stockify",
    receiver: body.swapper,
    side: "SELL",
    slippage: "300",
    srcDecimals: "18",
    srcToken: NATIVE_ETH,
    userAddress: body.swapper,
    version: "6.2",
  });

  const response = await fetch(`${ENDPOINT}?${query}`, { headers: { Accept: "application/json" } });
  const payload = await response.json().catch(() => null) as
    | { error?: string; priceRoute?: Record<string, unknown>; txParams?: Record<string, unknown> }
    | null;

  if (!response.ok || !payload?.priceRoute || !payload.txParams) {
    return apiError(payload?.error || "Velora could not build a route for this trade.", 502);
  }

  const route = payload.priceRoute as { destAmount: string; bestRoute?: Array<{ swaps?: Array<{ swapExchanges?: Array<{ exchange?: string }> }> }> };
  const venues = new Set<string>();
  for (const hop of route.bestRoute ?? []) {
    for (const swap of hop.swaps ?? []) {
      for (const exchange of swap.swapExchanges ?? []) if (exchange.exchange) venues.add(exchange.exchange);
    }
  }

  return Response.json(
    { destAmount: route.destAmount, tx: payload.txParams, venues: [...venues] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
