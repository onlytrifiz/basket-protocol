import { B20_DECIMALS } from "../../lib/decimals";
import { stocks } from "../../lib/stocks";

/**
 * Everything this site is willing to route, and what each one is.
 *
 * The allowlist exists because `/api/velora/swap` is a server-side proxy: without it, anyone could
 * point Stockify's partner-tagged Velora quota at an arbitrary token pair. Decimals live here too —
 * resolved server-side rather than trusted from the request body, because a wrong `srcDecimals`
 * does not fail loudly, it silently quotes a trade off by a factor of 10^10.
 */

/** Velora's native-asset sentinel. Paying in ETH needs no wrap and no approval. */
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export type RoutableToken = {
  address: string;
  symbol: string;
  decimals: number;
  /** True for the equities and STFY — the assets this site exists to trade. */
  isAsset: boolean;
};

const STFY = process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS ?? "";

const TOKENS: RoutableToken[] = [
  { address: NATIVE_ETH, symbol: "ETH", decimals: 18, isAsset: false },
  { address: USDC, symbol: "USDC", decimals: 6, isAsset: false },
  // Every B20 equity carries 8 DECIMALS — not the 6 or 18 an ERC-20 integration usually assumes.
  // The constant is safe HERE and only here: this list is built from `lib/stocks`, which is what
  // makes the eight a fact rather than an assumption. Anywhere the address comes from the chain
  // instead, read it — see `lib/decimals`.
  ...stocks.map((s) => ({ address: s.address, symbol: s.symbol, decimals: B20_DECIMALS, isAsset: true })),
  ...(/^0x[a-fA-F0-9]{40}$/.test(STFY) ? [{ address: STFY, symbol: "STFY", decimals: 18, isAsset: true }] : []),
];

const BY_ADDRESS = new Map(TOKENS.map((t) => [t.address.toLowerCase(), t]));

export function routableToken(value: unknown): RoutableToken | undefined {
  return typeof value === "string" ? BY_ADDRESS.get(value.toLowerCase()) : undefined;
}

export const isNative = (address: string) => address.toLowerCase() === NATIVE_ETH.toLowerCase();
