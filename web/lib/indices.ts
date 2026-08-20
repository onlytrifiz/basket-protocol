import { cached } from "./cache";
import { batchCall, pad, toBigInt, type RpcCall } from "./rpc";

/**
 * Indices — what a launch's creator fees are turned into.
 *
 * A coin launched on Stonks Exchange can point its creator fee stream at a treasury deployed here.
 * From then on those fees buy tokenized equity and it is pushed to that coin's holders, or they buy
 * the coin back and burn it. One CREATE2 clone per coin, and what it buys is fixed the day it is
 * created.
 *
 * Everything here is read from the chain at request time. The service is ours, the launchpad is not,
 * and that is exactly why nothing is taken from a database: an index states what it holds and who it
 * pays, and no record of ours could be more authoritative than the contract itself.
 */
const FACTORY = process.env.NEXT_PUBLIC_INDEX_FACTORY ?? "";
const isAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v);

export const indicesLive = isAddress(FACTORY);
export const INDEX_FACTORY = FACTORY;

/** The launchpad these treasuries collect from. An index is created there, not here. */
export const LAUNCHPAD = {
  name: "Stonks Exchange",
  url: "https://www.thestonks.exchange/launch",
} as const;

const SEL = {
  indexCount: "0x19a0bc4a",
  indexesPaged: "0x601adf02",
  platformFeeBps: "0x22dcd13e",
  coin: "0x11df9995",
  quote: "0x999b93af",
  mode: "0x295a5212",
  interval: "0x947a36fb",
  creatorShareBps: "0xb1a25c94",
  paused: "0x5c975abb",
  bindIsPermanent: "0x6fe1e2d7",
  basketAll: "0x415bdc42",
  symbol: "0x95d89b41",
} as const;

export type Index = {
  address: string;
  coin: string;
  coinSymbol: string | null;
  quote: string;
  /** 0 = buy the basket and pay it to holders. 1 = buy the coin back and burn it. */
  mode: number;
  interval: number;
  creatorShareBps: number;
  paused: boolean;
  /** True only when the treasury holds the launchpad's creator ROLE, which the creator cannot move. */
  permanent: boolean;
  basket: string[];
  weights: number[];
};

const word = (hex: string, i: number) => hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const addrOf = (hex?: string | null) => (hex ? `0x${word(hex, 0).slice(24)}` : null);
const numOf = (hex?: string | null) => (hex ? Number(BigInt(`0x${word(hex, 0)}`)) : 0);

/**
 * A string returned by an `eth_call`, or null.
 *
 * `symbol()` is optional on an ERC20 and some tokens answer with a fixed `bytes32` instead — both
 * are why a missing symbol falls back to the address rather than breaking a row.
 */
function stringOf(hex?: string | null): string | null {
  if (!hex) return null;
  const body = hex.replace(/^0x/, "");
  if (body.length < 128) return null;
  try {
    const len = Number(BigInt(`0x${body.slice(64, 128)}`));
    if (len === 0 || len > 64) return null;
    const decoded = Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
    return decoded.replace(/[^\x20-\x7e]/g, "").trim() || null;
  } catch {
    return null;
  }
}

/** `basketAll()` returns two arrays in one blob: the tokens, then their weights in bps. */
function decodeBasket(hex: string): { tokens: string[]; bps: number[] } {
  const body = hex.replace(/^0x/, "");
  if (body.length < 128) return { tokens: [], bps: [] };
  try {
    const readArray = (offsetWord: number) => {
      const off = Number(BigInt(`0x${body.slice(offsetWord * 64, (offsetWord + 1) * 64)}`)) * 2;
      const len = Number(BigInt(`0x${body.slice(off, off + 64)}`));
      return Array.from({ length: len }, (_, i) =>
        body.slice(off + 64 + i * 64, off + 64 + (i + 1) * 64)
      );
    };
    return {
      tokens: readArray(0).map((w) => `0x${w.slice(24)}`),
      bps: readArray(1).map((w) => Number(BigInt(`0x${w}`))),
    };
  } catch {
    return { tokens: [], bps: [] };
  }
}

/** Every index the factory has minted, newest first. */
export function readIndices(): Promise<Index[]> {
  return cached("indices:all", 60_000, loadIndices).catch(() => []);
}

async function loadIndices(): Promise<Index[]> {
  if (!indicesLive) return [];

  const [countRes] = await batchCall([{ to: FACTORY, data: SEL.indexCount }]);
  const count = Number(toBigInt(countRes) ?? 0n);
  if (count === 0) return [];

  // One page is plenty for a long time. A service past this has earned a real pager.
  const limit = Math.min(count, 100);
  const [pageRes] = await batchCall([
    { to: FACTORY, data: SEL.indexesPaged + pad("0") + pad(limit.toString(16)) },
  ]);
  if (pageRes.state !== "ok" || !pageRes.data) return [];

  const body = pageRes.data.replace(/^0x/, "");
  const n = Number(BigInt(`0x${body.slice(64, 128)}`));
  const addresses = Array.from(
    { length: n },
    (_, i) => `0x${body.slice(128 + i * 64 + 24, 128 + (i + 1) * 64)}`
  );

  const fields = [
    "coin", "quote", "mode", "interval", "creatorShareBps", "paused", "bindIsPermanent", "basketAll",
  ] as const;
  const calls: RpcCall[] = [];
  for (const a of addresses) for (const f of fields) calls.push({ to: a, data: SEL[f] });
  const results = await batchCall(calls);

  const rows: Index[] = addresses.map((address, i) => {
    const at = (f: (typeof fields)[number]) => results[i * fields.length + fields.indexOf(f)];
    const { tokens, bps } = decodeBasket(at("basketAll").data ?? "");
    return {
      address,
      coin: addrOf(at("coin").data) ?? "",
      coinSymbol: null,
      quote: addrOf(at("quote").data) ?? "",
      mode: numOf(at("mode").data),
      interval: numOf(at("interval").data),
      creatorShareBps: numOf(at("creatorShareBps").data),
      paused: numOf(at("paused").data) === 1,
      permanent: numOf(at("bindIsPermanent").data) === 1,
      basket: tokens,
      weights: bps,
    };
  });

  const symbols = await batchCall(rows.map((r) => ({ to: r.coin, data: SEL.symbol })));
  rows.forEach((r, i) => {
    r.coinSymbol = stringOf(symbols[i]?.data);
  });

  // Newest first: the factory appends, so the tail is the most recent.
  return rows.reverse();
}

/** One index, or null when nothing at that address answers as one. */
export async function readIndex(address: string): Promise<Index | null> {
  if (!isAddress(address)) return null;
  const all = await readIndices();
  return all.find((i) => i.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/** The service's cut, off the top of every harvest. Read from the factory rather than assumed. */
export function readPlatformFeeBps(): Promise<number> {
  return cached("indices:fee", 300_000, async () => {
    if (!indicesLive) return 1_000;
    const [res] = await batchCall([{ to: FACTORY, data: SEL.platformFeeBps }]);
    return Number(toBigInt(res) ?? 1_000n);
  }).catch(() => 1_000);
}

/** What one equity's slice must be worth before the keeper buys it. Per name, not per round. */
export const MIN_BUY_ETH = 0.01;
/** Whole coins a wallet must hold to be paid, resolved on-chain against the coin's decimals. */
export const MIN_HOLDER_COINS = 10_000;

export const MODE = { distribute: 0, buyback: 1 } as const;

/** The three-way split of a harvest, in bps of the gross: platform first, then the creator's cut. */
export function splitOf(creatorShareBps: number, platformBps: number) {
  const rest = 10_000 - platformBps;
  const creator = Math.round((rest * creatorShareBps) / 10_000);
  return { platform: platformBps, creator, holders: rest - creator };
}
