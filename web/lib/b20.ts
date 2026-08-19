import { cached } from "./cache";
import { batchCall, pad, toBigInt, decodeString, type CallResult, type RpcCall } from "./rpc";
import { stocks, type IndexStock } from "./stocks";

/**
 * What Base's tokenized equities actually report, read from the chain rather than from a listing.
 *
 * B20 tokens are Rust PRECOMPILES, not EVM contracts: `eth_getCode` returns the single byte 0xef
 * for a token and EMPTY for the factory, yet every call dispatches normally. Nothing here may gate
 * B20 handling on code length, and no EVM simulator can stand in for the live chain.
 *
 * Two facts drive the hub page:
 *
 *   1. SUPPLY IS THE HEADLINE. Most of these have never been issued — `totalSupply()` is literally
 *      zero for the majority today. A listing page that shows thirteen tickers as if they were
 *      thirteen markets is lying by omission; this one reads the number and says so.
 *
 *   2. THE MULTIPLIER IS COSMETIC. Under ERC-8056 it rescales what a holder is SHOWN without
 *      touching any raw balance — it is how Base represents a stock split. Raw units stay canonical
 *      everywhere (routing, approvals, amounts) and the multiplier is applied at the display
 *      boundary only. Feeding it into trade math would misprice every split asset.
 */

/**
 * Base endpoints, tried in order.
 *
 * NOT just `mainnet.base.org`. Measured against the 26 calls this page needs: the official public
 * endpoint caps batches at ten AND rate-limits per element inside them, so it answers roughly five
 * of thirteen equities and reports the rest as unread. publicnode returns all 26 in one batch in
 * ~235ms; 1rpc does the same more slowly. Ordered accordingly, with the official endpoint kept last
 * as a floor rather than dropped.
 *
 * `BASE_RPC_URL` goes to the FRONT rather than replacing the list: a funded endpoint should be
 * preferred, but its outage should degrade to a public one instead of to a blank page.
 */
export type B20Asset = {
  address: string;
  symbol: string;
  name: string;
  /** TradFi ticker for market-data lookups. Absent when the tokenized company has no public
   *  listing to compare against — see the note in `lib/stocks`. */
  ticker?: string;
  decimals: number;
  /** Raw on-chain supply as a decimal string — canonical, never multiplied. `null` when the read
   *  did not land, which is NOT the same as zero and must not be rendered as a number. */
  supplyRaw: string | null;
  /** Supply with the multiplier applied: shares in existence, for display. `null` when unread. */
  shares: number | null;
  /** WAD multiplier as a decimal string; "1000000000000000000" until a corporate action. */
  multiplier: string;
  hasSplit: boolean;
  /** Official Coinbase equity icon, read from the token's own `contractURI()`. */
  logo?: string;
  /** Favicon fallback for the assets with no on-chain icon to read. */
  domain?: string;
  inIndex: boolean;
};

const FACTORY = "0xB20f000000000000000000000000000000000000";
const WAD = 10n ** 18n;

/** 4-byte selectors. Kept literal so this module stays dependency-free, as `check-b20.mjs` does. */
const SIG = {
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  multiplier: "0x1b3ed722",
  contractURI: "0xe8a3d485",
  isB20: "0xfa19b927",
} as const;

/**
 * The official icon, from the token itself.
 *
 * `contractURI()` returns a base64 data-URI carrying `{name, symbol, image}` where `image` points at
 * Coinbase's own equity icon. Reading it means a ticker Base lists tomorrow arrives with correct
 * branding and no asset added to this repo — the difference between a hub and a hardcoded list.
 * Two assets have nothing to read (SPCXc never set one) and fall back to a favicon.
 */
function decodeContractURI(result: CallResult): { name?: string; symbol?: string; image?: string } | undefined {
  const uri = decodeString(result);
  if (!uri?.startsWith("data:application/json;base64,")) return undefined;
  try {
    const json = JSON.parse(Buffer.from(uri.split(",", 2)[1], "base64").toString("utf8")) as Record<string, unknown>;
    const pick = (key: string) => (typeof json[key] === "string" ? json[key] as string : undefined);
    const image = pick("image");
    // Only Coinbase's own metadata host is trusted as an <img> src: the token controls this string,
    // and a hostile issuer should not get to point our pages at an arbitrary URL.
    return { name: pick("name"), symbol: pick("symbol"), image: image?.startsWith("https://metadata.coinbase.com/") ? image : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Immutable per-token facts: the official icon and the decimals.
 *
 * Neither ever changes, so they are read once and kept for the life of the instance, which also
 * halves the steady-state call count against a rate-limited endpoint. Only a read that actually
 * LANDED is cached — committing the result of a throttled request would pin a token to "no icon,
 * assume 8 decimals" forever on the strength of one bad second.
 */
const staticFacts = new Map<string, { logo?: string; decimals: number }>();

/** Raw units to displayed shares. See the multiplier note at the top of this file. */
export function toShares(raw: bigint, decimals: number, multiplier = WAD): number {
  return Number((raw * multiplier) / WAD) / 10 ** decimals;
}

/**
 * Every listed equity, with its live supply and split state.
 *
 * The seed list supplies tickers and index membership — facts no contract knows — while every
 * number and every icon comes from the chain. Adding an asset Base lists later is one line in
 * `lib/stocks.ts`; nothing else here needs to change.
 */
export function readAssets(list: IndexStock[] = stocks): Promise<B20Asset[]> {
  // Supply moves only when an issuer mints. A minute is fresh; a per-visitor round-trip is not.
  return cached(`assets:${list.length}`, 60_000, () => loadAssets(list));
}

async function loadAssets(list: IndexStock[]): Promise<B20Asset[]> {
  const unknown = list.filter((s) => !staticFacts.has(s.address.toLowerCase()));

  const calls: RpcCall[] = [
    ...list.flatMap((s) => [
      { to: s.address, data: SIG.totalSupply },
      { to: s.address, data: SIG.multiplier },
    ]),
    ...unknown.flatMap((s) => [
      { to: s.address, data: SIG.contractURI },
      { to: s.address, data: SIG.decimals },
    ]),
  ];

  const results = await batchCall(calls);
  const staticBase = list.length * 2;

  unknown.forEach((stock, i) => {
    const meta = decodeContractURI(results[staticBase + i * 2]);
    const decimalsResult = results[staticBase + i * 2 + 1];
    const decimals = toBigInt(decimalsResult);
    // Commit only when the chain actually answered — see the note on `staticFacts`.
    if (meta || decimals !== null) {
      staticFacts.set(stock.address.toLowerCase(), {
        logo: meta?.image,
        decimals: decimals !== null ? Number(decimals) : 8,
      });
    }
  });

  return list.map((stock, i) => {
    const known = staticFacts.get(stock.address.toLowerCase());
    const supplyResult = results[i * 2];
    const supply = toBigInt(supplyResult);
    // A reverted `multiplier()` means the method is not activated on this token, not that the token
    // has a zero multiplier — treating it as zero would erase the whole supply from the page.
    const multiplier = toBigInt(results[i * 2 + 1]) || WAD;
    const decimals = known?.decimals ?? 8;
    // Unread is not zero. The hub renders this as "—", never as a token nobody has issued.
    const unread = supplyResult.state === "unavailable";

    return {
      address: stock.address,
      symbol: stock.symbol,
      name: stock.name,
      ticker: stock.ticker,
      decimals,
      supplyRaw: unread ? null : (supply ?? 0n).toString(),
      shares: unread ? null : toShares(supply ?? 0n, decimals, multiplier),
      multiplier: multiplier.toString(),
      hasSplit: multiplier !== WAD,
      logo: known?.logo,
      domain: stock.domain,
      inIndex: Boolean(stock.inIndex),
    };
  });
}

/** Does the B20 factory recognise this address? Used to vet anything not in the seed list. */
export async function isB20(address: string): Promise<boolean> {
  const [result] = await batchCall([{ to: FACTORY, data: SIG.isB20 + pad(address) }]);
  const value = toBigInt(result);
  return value !== null && value !== 0n;
}
