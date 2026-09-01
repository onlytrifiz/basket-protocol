import { apiError, isAddress, nativeEth } from "../../shared";
import { batchCall, decodeString, toBigInt } from "../../../../lib/rpc";
import { stockByAddress } from "../../../../lib/stocks";

/**
 * What a pasted contract actually is, before it becomes part of a basket nobody can change.
 *
 * A basket is FIXED AT CREATION — `IndexTreasury` has no setter for it — so an address that turns
 * out not to be a token is not a mistake the creator can correct afterwards: that slice of every
 * future fee simply never gets spent, and sits in the treasury for good. The wizard asks the chain
 * first for that reason, and refuses rather than warns.
 *
 * IT ASKS FOR MORE THAN THE CONTRACT DOES, deliberately. `initialize` only requires an entry to
 * hold code, which a B20 satisfies with a one-byte stub and so does any contract that is not a
 * token at all. What actually has to be true for a name to ever be bought is that the KEEPER can
 * scale it: it reads `decimals()` and skips a name whose scale it cannot get, rather than assuming
 * one — see `lib/decimals`. So a readable `decimals()` is the real admission test, and it is the
 * one applied here.
 *
 * SERVER-SIDE, like `/api/indices/pairing` and for the same reason: the builder shows a creator
 * their address before anything is deployed and before a wallet is connected, so a check that
 * needed an injected provider would be a check most people never get.
 */

const SYMBOL = "0x95d89b41"; // symbol()
const DECIMALS = "0x313ce567"; // decimals()

const WETH = "0x4200000000000000000000000000000000000006";
/** The per-name floor a slice has to clear before the keeper buys it — so the size worth testing. */
const PROBE_WEI = "10000000000000000"; // 0.01 ETH, MIN_BUY_ETH

/**
 * Can this token actually be BOUGHT, and not merely read?
 *
 * The admission test above proves an address is a token. It does not prove a treasury could ever
 * spend a fee on it — and since the basket has no setter, a name with no route keeps its share of
 * every future fee unspent, permanently. So the wizard asks the same router the keeper will use.
 *
 * `ignoreBadUsdPrice` IS NOT OPTIONAL HERE. Velora refuses a pair it cannot price in dollars, which
 * is precisely a freshly launched coin — the keeper measured every size from three cents to three
 * hundred dollars refused identically on a live coin, and every one of them routing once the flag
 * was set. Without it this check would report "no liquidity" for exactly the tokens this field
 * exists to admit.
 *
 * Null, not false, when Velora itself will not answer: a token is not unroutable because our
 * upstream had a bad moment, and the difference decides whether the creator sees a warning or a
 * shrug.
 */
async function routeFor(token: string, decimals: number): Promise<{ routable: boolean | null; venues: string[] }> {
  if (token.toLowerCase() === WETH) return { routable: true, venues: [] };
  const query = new URLSearchParams({
    srcToken: WETH,
    srcDecimals: "18",
    destToken: token,
    destDecimals: String(decimals),
    amount: PROBE_WEI,
    side: "SELL",
    network: "8453",
    version: "6.2",
    ignoreBadUsdPrice: "true",
  });
  try {
    const response = await fetch(`https://api.velora.xyz/prices?${query}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as
      | { priceRoute?: { bestRoute?: Array<{ swaps?: Array<{ swapExchanges?: Array<{ exchange?: string }> }> }> }; error?: string }
      | null;
    if (payload?.priceRoute) {
      const venues = new Set<string>();
      for (const hop of payload.priceRoute.bestRoute ?? []) {
        for (const swap of hop.swaps ?? []) {
          for (const exchange of swap.swapExchanges ?? []) if (exchange.exchange) venues.add(exchange.exchange);
        }
      }
      return { routable: true, venues: [...venues] };
    }
    // A named refusal is an answer about the token; anything else is an answer about the router.
    if (typeof payload?.error === "string" && /liquidity|route/i.test(payload.error)) {
      return { routable: false, venues: [] };
    }
    return { routable: null, venues: [] };
  } catch {
    return { routable: null, venues: [] };
  }
}

export async function GET(request: Request) {
  const address = (new URL(request.url).searchParams.get("address") ?? "").trim();
  if (!isAddress(address)) return apiError("That is not a contract address.", 400);
  if (address.toLowerCase() === nativeEth) {
    return apiError("Native ETH cannot be a basket name — it is what the fees arrive in.", 400);
  }

  // The seed list is the definition for the names this repo ships, not a cache of a chain read.
  const known = stockByAddress(address);
  if (known) {
    const route = await routeFor(known.address, 8);
    return Response.json(
      { found: true, address: known.address, symbol: known.symbol, name: known.name, decimals: 8, listed: true, ...route },
      { headers: { "Cache-Control": "public, max-age=120" } },
    );
  }

  const [symbolResult, decimalsResult] = await batchCall([
    { to: address, data: SYMBOL },
    { to: address, data: DECIMALS },
  ]);

  // A read that never landed is not an answer about the token. Say so, rather than calling a live
  // contract dead because the node had a bad moment.
  if (decimalsResult.state === "unavailable") {
    return apiError("The chain would not answer just now. Try again.", 502);
  }

  const decimals = toBigInt(decimalsResult);
  if (decimals === null || decimals > 36n) {
    return Response.json(
      {
        found: false,
        reason: "That address does not answer `decimals()`, so it is not a token an index can buy.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // A symbol is decoration — some tokens answer with a fixed bytes32, some not at all — so a miss
  // costs a label, never the entry.
  const symbol = decodeString(symbolResult);
  const route = await routeFor(address, Number(decimals));

  return Response.json(
    {
      found: true,
      address,
      symbol: symbol && symbol.length <= 16 ? symbol : null,
      name: null,
      decimals: Number(decimals),
      listed: false,
      ...route,
    },
    { headers: { "Cache-Control": "public, max-age=120" } },
  );
}
