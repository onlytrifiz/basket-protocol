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

export async function GET(request: Request) {
  const address = (new URL(request.url).searchParams.get("address") ?? "").trim();
  if (!isAddress(address)) return apiError("That is not a contract address.", 400);
  if (address.toLowerCase() === nativeEth) {
    return apiError("Native ETH cannot be a basket name — it is what the fees arrive in.", 400);
  }

  // The seed list is the definition for the names this repo ships, not a cache of a chain read.
  const known = stockByAddress(address);
  if (known) {
    return Response.json(
      { found: true, address: known.address, symbol: known.symbol, name: known.name, decimals: 8, listed: true },
      { headers: { "Cache-Control": "public, max-age=300" } },
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

  return Response.json(
    {
      found: true,
      address,
      symbol: symbol && symbol.length <= 16 ? symbol : null,
      name: null,
      decimals: Number(decimals),
      listed: false,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
