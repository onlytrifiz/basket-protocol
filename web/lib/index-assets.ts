import { cached } from "./cache";
import { poolsFor } from "./pools";
import { stockByAddress } from "./stocks";

/**
 * Assets in the dividend index that are NOT Coinbase B20 equities.
 *
 * The index admits any ERC-20 (`DividendVault._setIndex`), and since 2026-10-11 it holds STONKEX,
 * the token of The Stonks Exchange, beside the five B20s. Everything about a B20 (symbol, logo,
 * brand colour, ticker for a share price) comes from `lib/stocks` and the token's contractURI; a
 * token like this has none of that, so it is described here. Identity was checked on-chain at the
 * address itself: name "The Stonks Exchange", symbol STONKEX, 18 decimals, 1B supply.
 */
export type IndexAsset = {
  address: string;
  symbol: string;
  name: string;
  logo: string;
  /** Colour for its slice, card wash and strip segment. */
  brand: string;
  /** Where its card links: it has no page of its own on this site. */
  href: string;
};

export const INDEX_ASSETS: IndexAsset[] = [
  {
    address: "0x5ab000ff9b9ffe0349ce5ffa5fd86f217c3680f5",
    symbol: "STONKEX",
    name: "The Stonks Exchange",
    logo: "/partners/stonks-exchange.png",
    brand: "#3dbb4a",
    href: "https://www.thestonks.exchange/",
  },
];

const byAddress = new Map(INDEX_ASSETS.map((asset) => [asset.address, asset]));

export const indexAsset = (address: string) => byAddress.get(address.toLowerCase());

const PRICE_TTL_MS = 120_000;

/**
 * USD for one unit of any asset the vault distributes.
 *
 * A B20 takes its share price from the market board the caller already holds. Anything else takes
 * the price of its deepest pool, the same source /indices values coins with, and keeps the last
 * good one when a read fails, so one refused upstream call does not turn a figure into a dash.
 * Null only when the token has never been priced in this process.
 */
export async function assetUsd(address: string, quotes: Record<string, { price: number } | undefined>): Promise<number | null> {
  const ticker = stockByAddress(address)?.ticker;
  const quoted = ticker ? quotes[ticker]?.price : undefined;
  if (typeof quoted === "number" && Number.isFinite(quoted) && quoted > 0) return quoted;
  if (ticker) return null;
  try {
    return await cached(`asset:price:${address.toLowerCase()}`, PRICE_TTL_MS, async () => {
      const price = (await poolsFor(address.toLowerCase(), 0, false)).best?.priceUsd ?? null;
      if (price === null || !Number.isFinite(price) || price <= 0) throw new Error("unpriced");
      return price;
    });
  } catch {
    return null;
  }
}
