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
 *   1. SUPPLY IS THE HEADLINE. Issuance has spread — thirty-nine of fifty-three reported a non-zero
 *      `totalSupply()` on 29 September 2026, where once it was four — but supply is still not a
 *      market: a name can be issued and have no pool anywhere, and a new batch lists at zero. A listing page
 *      that shows every ticker as if it were a market is lying by omission; this one reads the
 *      number and says so.
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
const ICON = /^https:\/\/metadata\.coinbase\.com\/equity_icons\/[0-9a-f]{64}\.png$/;
/** Coinbase's metadata endpoint, which `contractURI()` has named instead of inline JSON since ~2026-10-13. */
const METADATA = /^https:\/\/api\.coinbase\.com\/v1\/tokenized-stocks\/metadata\/[A-Za-z0-9.]+$/;
const REMOTE_ICON = /^https:\/\/api\.coinbase\.com\/v1\/tokenized-stocks\/images\/[A-Za-z0-9.]+\.png$/;
/** A remote icon's answer is kept this long, a missing one included: Coinbase uploads them late. */
const ICON_TTL_MS = 6 * 3_600_000;
const ICON_BATCH = 80;
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
 * `contractURI()` used to return a base64 data-URI carrying `{name, symbol, image}`. Around
 * 13 October 2026 Coinbase switched EVERY token, old listings included, to a URL instead —
 * `https://api.coinbase.com/v1/tokenized-stocks/metadata/<SYMBOL>` — and every official icon on the
 * site silently fell back to a favicon. Both shapes are read: inline JSON as before, or that one
 * metadata URL, which `remoteIcon` resolves. Any other URL is ignored: the token controls this
 * string, and a hostile issuer should not get to send our server to an arbitrary host.
 */
function decodeContractURI(result: CallResult): { name?: string; symbol?: string; image?: string; metadataUrl?: string } | undefined {
  const uri = decodeString(result);
  if (uri && METADATA.test(uri)) return { metadataUrl: uri };
  if (!uri?.startsWith("data:application/json;base64,")) return undefined;
  try {
    const json = JSON.parse(Buffer.from(uri.split(",", 2)[1], "base64").toString("utf8")) as Record<string, unknown>;
    const pick = (key: string) => (typeof json[key] === "string" ? json[key] as string : undefined);
    const image = pick("image");
    // Only Coinbase's own metadata host is trusted as an <img> src: the token controls this string,
    // and a hostile issuer should not get to point our pages at an arbitrary URL. And only in the
    // shape every working icon has, a 64-hex content hash: LYVc listed pointing at a 63-character
    // one, which Coinbase answers 403, and a broken image is worse than the favicon it displaced.
    return { name: pick("name"), symbol: pick("symbol"), image: image && ICON.test(image) ? image : undefined };
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
const staticFacts = new Map<string, { logo?: string; metadataUrl?: string; decimals: number }>();

/**
 * The icon behind a metadata URL, or undefined when Coinbase has none to serve.
 *
 * Two requests, because the metadata alone is not proof: on 16 October ten listings named an
 * `images/<SYMBOL>.png` that answered 404, and four more had empty metadata. So the JSON must name
 * this very token and an image in the expected shape, and the image itself must answer before it
 * becomes an `<img src>`. A request that did not land throws, so `cached` keeps the last answer and
 * asks again next time rather than filing a timeout as "no icon".
 */
async function resolveRemoteIcon(address: string, metadataUrl: string): Promise<string | undefined> {
  const meta = await fetch(metadataUrl, { signal: AbortSignal.timeout(6_000), cache: "no-store" });
  if (meta.status === 404) return undefined;
  if (!meta.ok) throw new Error(`coinbase metadata ${meta.status}`);
  const json = await meta.json() as Record<string, unknown>;
  const image = typeof json.image === "string" ? json.image : undefined;
  const self = typeof json.contract_address === "string" && json.contract_address.toLowerCase() === address;
  if (!image || !self || !REMOTE_ICON.test(image)) return undefined;
  const head = await fetch(image, { method: "HEAD", signal: AbortSignal.timeout(6_000), cache: "no-store" });
  if (head.ok) return image;
  if (head.status === 404 || head.status === 403) return undefined;
  throw new Error(`coinbase icon ${head.status}`);
}

const remoteIcon = (address: string, metadataUrl: string) =>
  cached(`icon:${address}`, ICON_TTL_MS, () => resolveRemoteIcon(address, metadataUrl)).catch(() => undefined);

/**
 * Resolve many remote icons, eighty at a time. Measured on 159 listings: sixteen at a time took 8.6s
 * of a cold render, eighty took 2.3s, and Coinbase refused none of either. Only a cold instance pays
 * this; every answer is then kept for six hours.
 */
async function remoteIcons(entries: Array<[string, string]>): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  for (let i = 0; i < entries.length; i += ICON_BATCH) {
    const slice = entries.slice(i, i + ICON_BATCH);
    const icons = await Promise.all(slice.map(([address, url]) => remoteIcon(address, url)));
    slice.forEach(([address], j) => out.set(address, icons[j]));
  }
  return out;
}

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
        metadataUrl: meta?.metadataUrl,
        decimals: decimals !== null ? Number(decimals) : 8,
      });
    }
  });

  const remote = await remoteIcons(list.flatMap((stock) => {
    const facts = staticFacts.get(stock.address.toLowerCase());
    return facts?.metadataUrl ? [[stock.address.toLowerCase(), facts.metadataUrl] as [string, string]] : [];
  }));

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
      logo: known?.logo ?? remote.get(stock.address.toLowerCase()),
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
