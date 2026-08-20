import { apiError, isAddress } from "../../shared";
import { batchCall, pad } from "../../../../lib/rpc";

/**
 * What a coin is paired against, according to the launchpad that issued it.
 *
 * The builder needs this before it can create anything: `IndexTreasury.bind()` refuses a treasury
 * whose `quote` is not the asset the launchpad actually pays, and `quote` is fixed at creation with
 * no setter — so a wrong answer here is a treasury that can never bind and cannot be repaired.
 *
 * SERVER-SIDE, and that is the point of the route existing at all. Doing it through the injected
 * provider meant the pairing could only be read by someone who had already connected a wallet, and
 * the whole reason the builder shows an address before anything is deployed is that a creator can
 * plan a launch without connecting one. It also gets the fallback endpoints and retries in
 * `lib/rpc`, which a single call through a browser wallet does not.
 *
 * ASKED THE SAME WAY `bind()` ASKS. The factory's launchpad list is walked in order, and the first
 * enabled registry that names an asset for this coin settles it — so an answer here cannot disagree
 * with the answer that decides whether the treasury works.
 */

const FACTORY = process.env.NEXT_PUBLIC_INDEX_FACTORY ?? "";
const ZERO = "0x0000000000000000000000000000000000000000";
const WETH = "0x4200000000000000000000000000000000000006";

// From `cast sig`. A wrong selector here reads as "no launchpad knows your coin", which is exactly
// the answer that would send a creator on to build the broken thing.
const SEL = {
  launchpadList: "0x43ffc6fe", // launchpadList()
  launchpads: "0xf12131dd", // launchpads(uint8)
  tokenQuote: "0xbcd40a0c", // tokenQuote(address)
} as const;

const word = (hex: string, i: number) => hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);

export async function GET(request: Request) {
  const coin = new URL(request.url).searchParams.get("coin") ?? "";
  if (!isAddress(coin)) return apiError("That is not an address.", 400);
  if (!isAddress(FACTORY)) return apiError("The index factory is not configured.", 503);

  const [listResult] = await batchCall([{ to: FACTORY, data: SEL.launchpadList }]);
  if (listResult.state !== "ok" || !listResult.data) {
    return apiError("The launchpad register could not be read.", 502);
  }

  // `launchpadList()` returns a dynamic uint8[]: an offset word, a length word, then the ids.
  const data = listResult.data;
  const body = data.replace(/^0x/, "");
  const count = body.length >= 128 ? Number(BigInt(`0x${word(data, 1)}`)) : 0;
  const ids = Array.from({ length: count }, (_, i) => word(data, 2 + i))
    .filter((w) => w.length === 64)
    .map((w) => Number(BigInt(`0x${w}`)));
  if (ids.length === 0) return Response.json({ found: false }, { headers: { "Cache-Control": "no-store" } });

  const pads = await batchCall(ids.map((id) => ({ to: FACTORY, data: SEL.launchpads + pad(id.toString(16)) })));

  for (const result of pads) {
    if (result.state !== "ok" || !result.data) continue;
    const registry = `0x${word(result.data, 0).slice(24)}`;
    const enabled = BigInt(`0x${word(result.data, 2)}`) !== 0n;
    if (!enabled || !isAddress(registry) || BigInt(registry) === 0n) continue;

    const [quoteResult] = await batchCall([{ to: registry, data: SEL.tokenQuote + pad(coin) }]);
    // A registry that does not know this coin reverts or answers zero. Both mean "ask the next one".
    if (quoteResult.state !== "ok" || !quoteResult.data) continue;
    const paired = `0x${word(quoteResult.data, 0).slice(24)}`;
    if (!isAddress(paired) || BigInt(paired) === 0n) continue;

    return Response.json(
      {
        found: true,
        // Native and wrapped are one asset to a treasury: it unwraps whatever the locker pays, and
        // quoting native is what keeps the ETH-routed venues reachable.
        quote: paired.toLowerCase() === WETH.toLowerCase() ? ZERO : paired,
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  }

  // Not an error: a coin that has not launched yet has no pairing to read, which is the ordinary
  // case for someone reserving an address before their launch.
  return Response.json({ found: false }, { headers: { "Cache-Control": "no-store" } });
}
