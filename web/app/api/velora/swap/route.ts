import { apiError, isAddress, isPositiveInteger, isRateLimited } from "../../shared";
import { isNative, routableToken } from "../../tokens";

/**
 * Server-side proxy for Velora's Market API — both directions.
 *
 * Velora rather than a single-venue router because B20 depth is SPLIT ACROSS VENUES: a live sell
 * quote taken while building this filled across three Uniswap v4 pools and Kipseli in one trade,
 * which no single-venue integration can reproduce. It also needs no API key, so the site holds no
 * secret to leak.
 *
 * WHAT THIS ROUTE ENFORCES that a browser call could not:
 *
 *   - Both legs must be on the allowlist in `../tokens`, and at least one must be an asset this site
 *     actually lists. Otherwise the proxy is a free, partner-tagged swap API for the whole internet.
 *   - Decimals come from that allowlist, never from the request. The equities are 8-decimal tokens
 *     and a client-supplied 18 would quote a trade a hundred million times too large.
 *
 * `tokenTransferProxy` is returned because selling an equity — or paying in USDC — needs an ERC-20
 * approval first, and the spender is Velora's proxy rather than the transaction's `to`.
 */
const ENDPOINT = "https://api.velora.xyz/swap";

export async function POST(request: Request) {
  if (isRateLimited(request)) return apiError("Too many requests. Try again shortly.", 429);

  const body = await request.json().catch(() => null) as
    | { amount?: unknown; swapper?: unknown; srcToken?: unknown; destToken?: unknown; slippageBps?: unknown }
    | null;
  if (!body) return apiError("Malformed request body.", 400);

  const src = routableToken(body.srcToken);
  const dest = routableToken(body.destToken);
  if (!src) return apiError("That input token is not tradable on Stockify.", 400);
  if (!dest) return apiError("That output token is not tradable on Stockify.", 400);
  if (src.address.toLowerCase() === dest.address.toLowerCase()) return apiError("Pick two different tokens.", 400);
  if (!src.isAsset && !dest.isAsset) return apiError("One side of the trade must be a Stockify asset.", 400);
  if (!isPositiveInteger(body.amount)) return apiError("Amount must be a positive integer in base units.", 400);
  if (!isAddress(body.swapper)) return apiError("A wallet address is required to price a trade.", 400);

  // Clamped rather than rejected: a slippage a user cannot set out of range is one they cannot get
  // wrong, and the equity pools here are thin enough that 0.1% would simply never fill.
  const requested = typeof body.slippageBps === "number" ? body.slippageBps : 300;
  const slippage = String(Math.min(3_000, Math.max(10, Math.round(requested))));

  const query = new URLSearchParams({
    amount: body.amount,
    srcToken: src.address,
    srcDecimals: String(src.decimals),
    destToken: dest.address,
    destDecimals: String(dest.decimals),
    network: "8453",
    partner: "stockify",
    receiver: body.swapper,
    // SELL means "spend exactly this much of srcToken", which is what both directions of the panel
    // ask for — buying with 0.1 ETH and selling 3 NVDAc are the same shape of question.
    side: "SELL",
    slippage,
    userAddress: body.swapper,
    version: "6.2",
  });

  let payload: { error?: string; priceRoute?: Record<string, unknown>; txParams?: Record<string, unknown> } | null = null;
  try {
    const response = await fetch(`${ENDPOINT}?${query}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.priceRoute || !payload.txParams) {
      return apiError(payload?.error || "Velora could not build a route for this trade.", 502);
    }
  } catch {
    return apiError("The routing service is unreachable right now.", 502);
  }

  const route = payload.priceRoute as {
    destAmount: string;
    srcUSD?: string;
    destUSD?: string;
    gasCostUSD?: string;
    tokenTransferProxy?: string;
    bestRoute?: Array<{ swaps?: Array<{ swapExchanges?: Array<{ exchange?: string }> }> }>;
  };

  // Naming the venues is the point of routing through an aggregator: the trader should see that
  // their order filled across Aerodrome and Uniswap rather than in one pool.
  const venues = new Set<string>();
  for (const hop of route.bestRoute ?? []) {
    for (const swap of hop.swaps ?? []) {
      for (const exchange of swap.swapExchanges ?? []) if (exchange.exchange) venues.add(exchange.exchange);
    }
  }

  return Response.json(
    {
      destAmount: route.destAmount,
      destDecimals: dest.decimals,
      srcUsd: Number(route.srcUSD ?? 0),
      destUsd: Number(route.destUSD ?? 0),
      gasCostUsd: Number(route.gasCostUSD ?? 0),
      // Absent for a native-ETH sale, where there is nothing to approve.
      spender: isNative(src.address) ? null : route.tokenTransferProxy ?? null,
      tx: payload.txParams,
      venues: [...venues],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
