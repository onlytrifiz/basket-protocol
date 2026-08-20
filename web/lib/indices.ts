import { cached } from "./cache";
import { readDecimals } from "./decimals";
import { marketBoard } from "./market";
import { ethUsd } from "./pools";
import { stockByAddress } from "./stocks";
import { batchCall, blockNumber, getLogs, pad, toBigInt, type RpcCall } from "./rpc";

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
  creatorClaimable: "0x9e5f358a",
  feeRecipientNow: "0x31b8dc20",
  spendableQuote: "0x97fe6127",
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

export type IndexDetail = Index & {
  /** Quote set aside for the creator, in wei of the quote asset. */
  creatorClaimable: bigint;
  /** Quote a round may still spend — what has been through the split and is not promised elsewhere. */
  spendable: bigint;
  /**
   * Who the launchpad pays for this coin RIGHT NOW.
   *
   * `permanent` is a snapshot taken when the index bound and never revised, so a split that has since
   * been pointed away would still read as bound. This is the live answer, and the only way the page
   * can stop telling holders a programme is running when it is not.
   */
  paidNow: string | null;
  stillCollecting: boolean;
};

/** One index with the figures the list does not need. Null when nothing there answers as one. */
export async function readIndexDetail(address: string): Promise<IndexDetail | null> {
  const base = await readIndex(address);
  if (!base) return null;

  const [claimable, spendable, recipient] = await batchCall([
    { to: base.address, data: SEL.creatorClaimable },
    { to: base.address, data: SEL.spendableQuote },
    { to: base.address, data: SEL.feeRecipientNow },
  ]);

  const paidNow = recipient.state === "ok" && recipient.data ? `0x${word(recipient.data, 0).slice(24)}` : null;
  return {
    ...base,
    creatorClaimable: toBigInt(claimable) ?? 0n,
    spendable: toBigInt(spendable) ?? 0n,
    paidNow,
    stillCollecting: !!paidNow && paidNow.toLowerCase() === base.address.toLowerCase(),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   What an index has actually DONE.

   The figures that matter on these pages are not state — they are history. How much has reached
   holders, how many rounds have run, how many wallets were paid: none of it is stored on the
   treasury, because paying to keep a growing tally on-chain to serve a web page would be the wrong
   trade. The events are the record, so this reads them.

   ONE SCAN FOR EVERY TREASURY AT ONCE. `eth_getLogs` accepts an array of addresses, so the request
   count follows the block range and not the number of indexes — a hundred of them cost exactly what
   one does. Cached, because a settled round cannot change.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

const TOPIC = {
  /** Harvested(uint256 amount, uint256 platformFee, uint256 creatorShare) — all in the data. */
  harvested: "0xebdd323f18ba49318367d0c92a04d5c51a67f15a60ad50d46523db464661a302",
  /** Distributed(uint256 indexed basketIdx, address indexed token, uint256 amount, uint256 holders) */
  distributed: "0xebfe46b2b9627430364d1cff67d061f2e2f59dfedbd307f28a227b9ba08ad807",
  /** Burned(address indexed coin, uint256 amount) */
  burned: "0x696de425f79f4a40bc6d2122ca50507f0efbeabbff86a84871b7196ab8ea8df7",
} as const;

/** The block the factory was created in — nothing it minted can predate it. */
const FACTORY_BLOCK = Math.max(0, Number(process.env.INDEX_FACTORY_DEPLOY_BLOCK) || 50_225_995);

const dataWord = (data: string, i: number) => {
  const w = (data.replace(/^0x/, "").match(/.{64}/g) ?? [])[i];
  return w === undefined ? 0n : BigInt(`0x${w}`);
};

/** One thing an index did, for the activity feed. */
export type IndexEvent = {
  kind: "fees" | "paid" | "burn";
  treasury: string;
  blockNumber: number;
  timestamp: number;
  txHash: string;
  /** Raw units — of the quote for `fees`, of the paid token for `paid`, of the coin for `burn`. */
  amountRaw: string;
  /** Only on `paid`: which basket entry, and how many wallets it reached. */
  token?: string;
  holders?: number;
};

export type IndexActivity = {
  /** Raw quote units collected, ever. */
  feesRaw: bigint;
  /** Raw quote units accrued to the creator. */
  creatorRaw: bigint;
  /** Raw units pushed to holders, per token. */
  distributed: Map<string, bigint>;
  /** Rounds that actually paid, and the wallet payments inside them. */
  rounds: number;
  payments: number;
  /** Newest first. */
  events: IndexEvent[];
};

const emptyActivity = (): IndexActivity => ({
  feesRaw: 0n,
  creatorRaw: 0n,
  distributed: new Map(),
  rounds: 0,
  payments: 0,
  events: [],
});

/**
 * Every index's history, keyed by treasury address.
 *
 * Returns null when no endpoint would serve the range — which is not the same as "nothing has
 * happened", and the pages render it as unread rather than as zero.
 */
export function readActivity(): Promise<Map<string, IndexActivity> | null> {
  return cached("indices:activity", 120_000, loadActivity).catch(() => null);
}

async function loadActivity(): Promise<Map<string, IndexActivity> | null> {
  const all = await readIndices();
  if (all.length === 0) return new Map();

  const tip = await blockNumber();
  if (tip === null) return null;

  const logs = await getLogs(all.map((i) => i.address), [], FACTORY_BLOCK, tip);
  if (logs === null) return null;

  const out = new Map<string, IndexActivity>();
  for (const index of all) out.set(index.address.toLowerCase(), emptyActivity());

  for (const log of logs) {
    const key = log.address.toLowerCase();
    const entry = out.get(key);
    if (!entry) continue;
    const topic = log.topics[0];

    if (topic === TOPIC.harvested) {
      const amount = dataWord(log.data, 0);
      entry.feesRaw += amount;
      entry.creatorRaw += dataWord(log.data, 2);
      // A harvest that brought nothing in is the ordinary empty poll, not an event worth a row.
      if (amount > 0n) {
        entry.events.push({
          kind: "fees", treasury: key, blockNumber: log.blockNumber, timestamp: log.timestamp,
          txHash: log.transactionHash, amountRaw: amount.toString(),
        });
      }
    } else if (topic === TOPIC.distributed) {
      const amount = dataWord(log.data, 0);
      const holders = Number(dataWord(log.data, 1));
      const token = `0x${(log.topics[2] ?? "").slice(-40)}`;
      entry.distributed.set(token.toLowerCase(), (entry.distributed.get(token.toLowerCase()) ?? 0n) + amount);
      entry.rounds += 1;
      entry.payments += holders;
      entry.events.push({
        kind: "paid", treasury: key, blockNumber: log.blockNumber, timestamp: log.timestamp,
        txHash: log.transactionHash, amountRaw: amount.toString(), token, holders,
      });
    } else if (topic === TOPIC.burned) {
      entry.events.push({
        kind: "burn", treasury: key, blockNumber: log.blockNumber, timestamp: log.timestamp,
        txHash: log.transactionHash, amountRaw: dataWord(log.data, 0).toString(),
      });
    }
  }

  for (const entry of out.values()) entry.events.sort((a, b) => b.blockNumber - a.blockNumber);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   The rows the tables render.

   Assembled here rather than in the pages because both the list and the full set need the same
   figures, and a second copy of "how do we price a distribution" is a second place for it to be
   wrong. The pages stay presentational.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

export type IndexRow = Index & {
  /** Dollars pushed to holders, ever. Null when nothing priced — never a confident zero. */
  paidUsd: number | null;
  /** Per-token, for the sub-line: [symbol, units]. */
  paidUnits: Array<{ token: string; symbol: string; units: number }>;
  /** Dollars collected in fees, ever. */
  feesUsd: number | null;
  rounds: number;
  payments: number;
  /** True when the history could not be read; the row shows dashes rather than zeros. */
  unread: boolean;
};

export type IndexTotals = {
  paidUsd: number | null;
  count: number;
  withRounds: number;
  rounds: number;
  payments: number;
};

/** Dollar price of one whole unit of a token, or null. ETH from a pool, equities from Nasdaq. */
async function priceOf(token: string, quotes: Record<string, { price: number }>): Promise<number | null> {
  if (token === ZERO_ADDRESS) return ethUsd();
  const known = stockByAddress(token);
  const price = known?.ticker ? quotes[known.ticker]?.price : undefined;
  return typeof price === "number" && Number.isFinite(price) ? price : null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Every index with its history priced, newest first. */
export function readIndexRows(): Promise<{ rows: IndexRow[]; totals: IndexTotals }> {
  return cached("indices:rows", 60_000, loadRows).catch(() => ({
    rows: [],
    totals: { paidUsd: null, count: 0, withRounds: 0, rounds: 0, payments: 0 },
  }));
}

async function loadRows(): Promise<{ rows: IndexRow[]; totals: IndexTotals }> {
  const [all, activity] = await Promise.all([readIndices(), readActivity()]);

  // Every token any index touches, so decimals and prices are fetched once for the whole page.
  const tokens = new Set<string>();
  for (const index of all) {
    tokens.add(index.quote.toLowerCase());
    for (const t of index.basket) tokens.add(t.toLowerCase());
  }
  const tickers = [...tokens].map((t) => stockByAddress(t)?.ticker).filter(Boolean) as string[];
  const [decimals, board] = await Promise.all([
    readDecimals([...tokens]),
    tickers.length ? marketBoard(tickers) : Promise.resolve({ quotes: {} as Record<string, never> }),
  ]);
  const quotes = board.quotes as Record<string, { price: number }>;

  const priced = new Map<string, number | null>();
  await Promise.all(
    [...tokens].map(async (t) => priced.set(t, await priceOf(t, quotes)))
  );

  const usd = (token: string, raw: bigint) => {
    const d = decimals.get(token.toLowerCase());
    const p = priced.get(token.toLowerCase());
    if (d === null || d === undefined || p === null || p === undefined) return null;
    return (Number(raw) / 10 ** d) * p;
  };

  const rows: IndexRow[] = all.map((index) => {
    const a = activity?.get(index.address.toLowerCase());
    if (!a) {
      return { ...index, paidUsd: null, paidUnits: [], feesUsd: null, rounds: 0, payments: 0, unread: true };
    }

    const paidUnits: IndexRow["paidUnits"] = [];
    let paidUsd: number | null = null;
    for (const [token, raw] of a.distributed) {
      const d = decimals.get(token);
      if (d !== null && d !== undefined) {
        paidUnits.push({
          token,
          symbol: stockByAddress(token)?.symbol ?? `${token.slice(0, 6)}…`,
          units: Number(raw) / 10 ** d,
        });
      }
      const value = usd(token, raw);
      if (value !== null) paidUsd = (paidUsd ?? 0) + value;
    }

    return {
      ...index,
      paidUsd,
      paidUnits,
      feesUsd: a.feesRaw === 0n ? 0 : usd(index.quote, a.feesRaw),
      rounds: a.rounds,
      payments: a.payments,
      unread: false,
    };
  });

  /**
   * A treasury with no coin bound is not something anyone can look at yet.
   *
   * It has no name, no holders and nothing to show, and it is the state every index passes through
   * between being deployed and its launch actually pointing fees at it. Half-built things crowding
   * the list make the finished ones harder to find.
   *
   * Hidden from the LIST only. Its own page still works — whoever deployed it has the link and needs
   * to watch it bind — so this changes what the set advertises, not what exists.
   */
  const bound = rows.filter((r) => r.coin && BigInt(r.coin) !== 0n);

  // Biggest payer first: the list is a record of what has actually worked, not of what exists.
  bound.sort((a, b) => (b.paidUsd ?? -1) - (a.paidUsd ?? -1) || b.rounds - a.rounds);

  const totals: IndexTotals = {
    paidUsd: bound.some((r) => r.paidUsd !== null)
      ? bound.reduce((sum, r) => sum + (r.paidUsd ?? 0), 0)
      : null,
    count: bound.length,
    withRounds: bound.filter((r) => r.rounds > 0).length,
    rounds: bound.reduce((sum, r) => sum + r.rounds, 0),
    payments: bound.reduce((sum, r) => sum + r.payments, 0),
  };

  return { rows: bound, totals };
}


/** One index's own history, priced. Null when the range could not be read. */
export async function readIndexHistory(address: string): Promise<{
  paidUsd: number | null;
  paidUnits: Array<{ token: string; symbol: string; units: number }>;
  feesUsd: number | null;
  feesUnits: number | null;
  creatorUsd: number | null;
  rounds: number;
  payments: number;
  events: IndexEvent[];
} | null> {
  const [index, activity] = await Promise.all([readIndex(address), readActivity()]);
  if (!index || !activity) return null;
  const a = activity.get(address.toLowerCase());
  if (!a) return null;

  const tokens = [index.quote.toLowerCase(), ...[...a.distributed.keys()]];
  const tickers = tokens.map((t) => stockByAddress(t)?.ticker).filter(Boolean) as string[];
  const [decimals, board] = await Promise.all([
    readDecimals(tokens),
    tickers.length ? marketBoard(tickers) : Promise.resolve({ quotes: {} as Record<string, never> }),
  ]);
  const quotes = board.quotes as Record<string, { price: number }>;

  const priced = new Map<string, number | null>();
  await Promise.all(tokens.map(async (t) => priced.set(t, await priceOf(t, quotes))));

  const units = (token: string, raw: bigint) => {
    const d = decimals.get(token.toLowerCase());
    return d === null || d === undefined ? null : Number(raw) / 10 ** d;
  };
  const value = (token: string, raw: bigint) => {
    const u = units(token, raw);
    const p = priced.get(token.toLowerCase());
    return u === null || p === null || p === undefined ? null : u * p;
  };

  const paidUnits: Array<{ token: string; symbol: string; units: number }> = [];
  let paidUsd: number | null = null;
  for (const [token, raw] of a.distributed) {
    const u = units(token, raw);
    if (u !== null) paidUnits.push({ token, symbol: stockByAddress(token)?.symbol ?? `${token.slice(0, 6)}…`, units: u });
    const v = value(token, raw);
    if (v !== null) paidUsd = (paidUsd ?? 0) + v;
  }

  return {
    paidUsd,
    paidUnits,
    feesUsd: a.feesRaw === 0n ? 0 : value(index.quote, a.feesRaw),
    feesUnits: units(index.quote, a.feesRaw),
    creatorUsd: a.creatorRaw === 0n ? 0 : value(index.quote, a.creatorRaw),
    rounds: a.rounds,
    payments: a.payments,
    events: a.events,
  };
}
