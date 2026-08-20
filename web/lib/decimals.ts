import { batchCall, toBigInt, type RpcCall } from "./rpc";
import { stockByAddress } from "./stocks";

/**
 * How many decimals a token carries — asked, not assumed.
 *
 * EIGHT IS A B20 FACT, NOT A DEFAULT. Every tokenized equity Coinbase issues on Base carries eight
 * decimals, and writing that constant beside an address from `lib/stocks` is correct precisely
 * because the seed list is what makes it true. It stops being true the moment an address does not
 * come from there — and three surfaces here take addresses that do not:
 *
 *   the dividend vault publishes its own index from `stockAt()`, and `lib/vault` deliberately
 *   renders an entry this repo has never heard of rather than dropping it;
 *   the settled-cycle ledger names assets from the vault's own logs, including ones since rotated
 *   out of the active index;
 *   an index treasury takes ANY ERC-20 as its quote asset — `IndexTreasury` explicitly supports a
 *   coin paired against an equity, which is 8, while the page divided every one of them by 1e18.
 *
 * An assumed scale is not a rounding error. A B20 balance divided by 1e18 renders as zero and an
 * 18-decimal balance divided by 1e8 renders as ten billion times itself, both with exactly the same
 * confidence as a correct figure — which is the one failure this site's chain layer is built to
 * refuse everywhere else.
 *
 * NULL MEANS UNREAD. Never a guess, never a fallback: the formatters in `lib/format` already render
 * null as "—", and a scale we could not read has to reach them as null rather than as a plausible
 * eight. This is the same rule `lib/rpc` states for every other number on this site; it matters more
 * here than anywhere, because a wrong balance looks wrong and a wrong scale does not.
 */

const DECIMALS = "0x313ce567"; // decimals()
const NATIVE = "0x0000000000000000000000000000000000000000";

/** Decimals never change, so a read that landed is kept for the life of the process. */
const resolved = new Map<string, number>();

const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

/**
 * The answer we already have without asking the chain: native ETH, and the seed list.
 *
 * The seed list is not a cache of a chain read — it is the definition. Consulting it first is what
 * keeps the ordinary page (thirteen known equities) at zero extra calls, so reading decimals
 * properly costs a round-trip only for an address that genuinely is not ours.
 */
function locallyKnown(address: string): number | undefined {
  const key = address.toLowerCase();
  if (key === NATIVE) return 18;
  if (stockByAddress(key)) return 8;
  return resolved.get(key);
}

/**
 * Decimals for a set of tokens, keyed by lowercase address.
 *
 * A value is `number` when we know it and `null` when the chain would not say. Addresses that are
 * not addresses are simply absent from the map, which reads the same as unread at every call site.
 */
export async function readDecimals(addresses: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const ask: string[] = [];

  for (const raw of addresses) {
    if (!isAddress(raw)) continue;
    const key = raw.toLowerCase();
    if (out.has(key)) continue;
    const known = locallyKnown(key);
    if (known !== undefined) out.set(key, known);
    else ask.push(key);
  }
  if (ask.length === 0) return out;

  const calls: RpcCall[] = ask.map((to) => ({ to, data: DECIMALS }));
  const results = await batchCall(calls);

  ask.forEach((key, i) => {
    const value = toBigInt(results[i]);
    // A revert is an answer — this token does not implement `decimals()` — but it is not a scale,
    // so it lands as null exactly like a call that never came back. Above 36 is not a token either.
    if (value === null || value > 36n) {
      out.set(key, null);
      return;
    }
    const decimals = Number(value);
    resolved.set(key, decimals);
    out.set(key, decimals);
  });

  return out;
}

/** One token. Same rules; `null` still means unread. */
export async function readDecimalsOf(address: string): Promise<number | null> {
  const map = await readDecimals([address]);
  return map.get(address.toLowerCase()) ?? null;
}

/**
 * Raw base units to a human number, or null when either half is unknown.
 *
 * Both arguments are nullable on purpose: `raw` is null when the balance went unread and `decimals`
 * is null when the scale did, and neither may be rendered as a number. Keeping the guard here means
 * no caller has to remember which of the two it is holding.
 */
export function toUnits(raw: string | null | undefined, decimals: number | null | undefined): number | null {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return Number(BigInt(raw)) / 10 ** decimals;
  } catch {
    return null;
  }
}

/**
 * What a Coinbase B20 equity carries.
 *
 * Named rather than written as a literal at each site that is entitled to it — the seed list in
 * `lib/stocks`, and the trade panels that only ever offer assets from it. A named constant is how
 * the next reader tells "8 because this is a B20" apart from "8 because nobody checked", which is
 * the whole distinction this module exists to draw.
 */
export const B20_DECIMALS = 8;
