import { cached } from "./cache";
import { readDecimals } from "./decimals";
import { marketBoard } from "./market";
import { ethUsd, poolsFor } from "./pools";
import { stockByAddress } from "./stocks";
import { batchCall, pad, toBigInt, type RpcCall } from "./rpc";
import { readActivityLogs } from "./indexActivityLog";

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
  basketAll: "0x415bdc42",
  symbol: "0x95d89b41",
  creatorClaimable: "0x9e5f358a",
  feeRecipientNow: "0x31b8dc20",
  spendableQuote: "0x97fe6127",
  isIndex: "0x47cbab9a",
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

/**
 * The fields of one or more treasuries, or a THROW when the chain would not answer.
 *
 * A read that never landed is not a zero. `numOf(undefined)` is 0 and `decodeBasket("")` is an
 * empty basket, so a throttled batch used to render a live index as "0 names, fixed at creation",
 * `paused` false and a zero interval — with exactly the confidence of a real read. That is the one
 * failure `lib/rpc` draws its `unavailable` state to prevent, and the rule the vault reader already
 * follows: throw, so `cached()` can serve its last good answer instead of a plausible wrong one.
 *
 * A REVERT is left alone. It is a real answer — the address does not implement this — and the
 * caller decides what it means.
 */
const FIELDS = ["coin", "quote", "mode", "interval", "creatorShareBps", "paused", "basketAll"] as const;

async function loadIndexRows(addresses: string[]): Promise<Index[]> {
  if (addresses.length === 0) return [];

  const calls: RpcCall[] = [];
  for (const a of addresses) for (const f of FIELDS) calls.push({ to: a, data: SEL[f] });
  const results = await batchCall(calls);

  const rows: Index[] = addresses.map((address, i) => {
    const at = (f: (typeof FIELDS)[number]) => results[i * FIELDS.length + FIELDS.indexOf(f)];
    const unread = FIELDS.filter((f) => at(f).state === "unavailable");
    if (unread.length > 0) throw new Error(`indices: ${address} unread (${unread.join(", ")})`);

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
      basket: tokens,
      weights: bps,
    };
  });

  // A symbol is decoration: an unbound coin has none to read, so a miss falls back to the address
  // rather than taking the row down with it.
  const symbols = await batchCall(rows.map((r) => ({ to: r.coin, data: SEL.symbol })));
  rows.forEach((r, i) => {
    r.coinSymbol = stringOf(symbols[i]?.data);
  });

  return rows;
}

async function loadIndices(): Promise<Index[]> {
  if (!indicesLive) return [];

  const [countRes] = await batchCall([{ to: FACTORY, data: SEL.indexCount }]);
  // Same rule as the fields below: a count nobody would give us is not a count of zero, and
  // returning [] for it renders the whole service as "no indexes yet".
  if (countRes.state === "unavailable") throw new Error("indices: indexCount unread");
  const count = Number(toBigInt(countRes) ?? 0n);
  if (count === 0) return [];

  // One page. Past this the LIST is truncated — reported as `totals.truncated`, which the set page
  // says out loud — but no index becomes unreachable: `readIndex` reads a treasury directly when it
  // is not on the page.
  const limit = Math.min(count, PAGE_LIMIT);
  const [pageRes] = await batchCall([
    { to: FACTORY, data: SEL.indexesPaged + pad("0") + pad(limit.toString(16)) },
  ]);
  if (pageRes.state === "unavailable") throw new Error("indices: indexesPaged unread");
  if (pageRes.state !== "ok" || !pageRes.data) return [];

  const body = pageRes.data.replace(/^0x/, "");
  const n = Number(BigInt(`0x${body.slice(64, 128)}`));
  const addresses = Array.from(
    { length: n },
    (_, i) => `0x${body.slice(128 + i * 64 + 24, 128 + (i + 1) * 64)}`
  );

  // Newest first: the factory appends, so the tail is the most recent.
  return (await loadIndexRows(addresses)).reverse();
}

/** How many the list reads in one page. The registry itself is not capped — see `readIndex`. */
export const PAGE_LIMIT = 100;

/** Is this address a treasury this factory minted? The only thing that makes a direct read safe. */
async function factoryKnows(address: string): Promise<boolean> {
  const [res] = await batchCall([{ to: FACTORY, data: SEL.isIndex + pad(address) }]);
  if (res.state === "unavailable") throw new Error("indices: isIndex unread");
  return (toBigInt(res) ?? 0n) !== 0n;
}

/**
 * One index, or null when nothing at that address answers as one.
 *
 * Served from the paged list when it is on it, and read DIRECTLY when it is not. The list stops at
 * `PAGE_LIMIT`, and resolving a detail page out of it meant index 101 rendering as "Nothing at this
 * address is an index" — the same sentence a wrong address gets, for one that exists and is running.
 * `isIndex()` on the factory is what makes the direct read safe: without it any address at all
 * would decode into a row of empty fields.
 */
export async function readIndex(address: string): Promise<Index | null> {
  if (!isAddress(address)) return null;
  const key = address.toLowerCase();

  const all = await readIndices();
  const listed = all.find((i) => i.address.toLowerCase() === key);
  if (listed) return listed;

  return cached(`indices:one:${key}`, 60_000, async () => {
    if (!indicesLive || !(await factoryKnows(address))) return null;
    return (await loadIndexRows([address]))[0] ?? null;
  }).catch(() => null);
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
   * The only question worth putting to a holder: is anything still arriving? Whether it COULD have
   * been stopped is a term, and terms do not change; whether it HAS been is a fact, and this is the
   * only way to know it — `bindIsPermanent` on the treasury is a snapshot taken at bind and never
   * revised, so an index whose split was pointed away still reads as bound there.
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

   EVERY BLOCK IS WALKED ONCE, EVER. A settled round cannot change, so re-deriving it on each cold
   cache was work with no possible new answer — and the range it covered grew by ~43,000 blocks a
   day, forever. `lib/indexActivityLog` owns the cursor; this module owns the decoder, and reads
   through it. One `eth_getLogs` for every treasury at once, over minutes of blocks.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

const TOPIC = {
  /** Harvested(uint256 amount, uint256 platformFee, uint256 creatorShare) — all in the data. */
  harvested: "0xebdd323f18ba49318367d0c92a04d5c51a67f15a60ad50d46523db464661a302",
  /** Distributed(uint256 indexed basketIdx, address indexed token, uint256 amount, uint256 holders) */
  distributed: "0xebfe46b2b9627430364d1cff67d061f2e2f59dfedbd307f28a227b9ba08ad807",
  /** Burned(address indexed coin, uint256 amount) */
  burned: "0x696de425f79f4a40bc6d2122ca50507f0efbeabbff86a84871b7196ab8ea8df7",
  /** Swapped(address indexed sellToken, uint256 spent, address indexed buyToken, uint256 bought) */
  swapped: "0xdb587d878116df0bdd4fe154699aa2c5f439da001cc811dfd05d9f589fc5a8ee",
} as const;

const dataWord = (data: string, i: number) => {
  const w = (data.replace(/^0x/, "").match(/.{64}/g) ?? [])[i];
  return w === undefined ? 0n : BigInt(`0x${w}`);
};

/** One thing an index did, for the activity feed. */
export type IndexEvent = {
  /** `bought` sits between the other two: the fee arrives, becomes equity, then leaves. */
  kind: "fees" | "bought" | "paid" | "burn";
  treasury: string;
  blockNumber: number;
  timestamp: number;
  txHash: string;
  /** Raw units — of the quote for `fees`, of the paid token for `paid`, of the coin for `burn`. */
  amountRaw: string;
  /** On `paid` and `bought`: which equity. */
  token?: string;
  /** Only on `paid`: how many wallets it reached. */
  holders?: number;
  /** Only on `bought`: raw quote units it cost. */
  spentRaw?: string;
};

export type IndexActivity = {
  /** Raw quote units collected, ever. */
  feesRaw: bigint;
  /** Raw quote units accrued to the creator. */
  creatorRaw: bigint;
  /** Raw units pushed to holders, per token. */
  distributed: Map<string, bigint>;
  /** Raw units of the coin destroyed. A buyback's whole output, and the only thing it produces. */
  burnedRaw: bigint;
  /**
   * Raw QUOTE units put through a buy, ever — what the treasury paid, not what it received.
   *
   * Kept because it is the one measure of a buyback's output that does not depend on the coin's own
   * price. `burnedRaw` is denominated in a launch coin, which is priced off a single small pool and
   * answers `null` as often as not; the quote is ether or an equity, which this module always
   * prices. See `returnedUsd`.
   */
  spentRaw: bigint;
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
  burnedRaw: 0n,
  spentRaw: 0n,
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

  /**
   * Read through the stored log rather than re-derived from the chain.
   *
   * Every block range is walked exactly once, ever — see `lib/indexActivityLog`. This used to be a
   * full `FACTORY_BLOCK`-to-head scan on every cold cache, which cost 1.9s when the explorer
   * answered and 27.7s when it did not, and grew by ~43,000 blocks a day either way.
   */
  const logs = await readActivityLogs(all.map((i) => i.address), Object.values(TOPIC));
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
    } else if (topic === TOPIC.swapped) {
      // topics: [sig, sellToken, buyToken] · data: [spent, bought]
      entry.spentRaw += dataWord(log.data, 0);
      entry.events.push({
        kind: "bought", treasury: key, blockNumber: log.blockNumber, timestamp: log.timestamp,
        txHash: log.transactionHash, amountRaw: dataWord(log.data, 1).toString(),
        token: `0x${(log.topics[2] ?? "").slice(-40)}`, spentRaw: dataWord(log.data, 0).toString(),
      });
    } else if (topic === TOPIC.burned) {
      entry.burnedRaw += dataWord(log.data, 0);
      entry.events.push({
        kind: "burn", treasury: key, blockNumber: log.blockNumber, timestamp: log.timestamp,
        txHash: log.transactionHash, amountRaw: dataWord(log.data, 0).toString(),
        // `Burned(address indexed coin, uint256 amount)` — the token is in the topic, and without
        // it the feed has nothing to scale the amount by and renders an em dash.
        token: `0x${(log.topics[1] ?? "").slice(-40)}`,
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
  /** For a buyback, what has been destroyed — the figure that stands where a payout would. */
  burnedUsd: number | null;
  burnedUnits: number | null;
  /** Dollars put through a buy, priced in the QUOTE. The floor under `burnedUsd`; see `returnedUsd`. */
  spentUsd: number | null;
  rounds: number;
  payments: number;
  /** True when the history could not be read; the row shows dashes rather than zeros. */
  unread: boolean;
};

export type IndexTotals = {
  /** Dollars the whole set has given back — payouts and buybacks together. See `returnedUsd`. */
  returnedUsd: number | null;
  count: number;
  withRounds: number;
  rounds: number;
  payments: number;
  /**
   * True when the registry has more indexes than one page reads, so this set is not the whole set.
   *
   * Surfaced rather than left implicit because a page titled "Every index" is a claim. Nothing goes
   * missing — `readIndex` reads a treasury directly whichever page it falls on — but the LIST stops
   * at `PAGE_LIMIT`, and a truncated list that says nothing is the same kind of confident wrong
   * answer this module refuses everywhere else.
   */
  truncated: boolean;
};

/** Dollar price of one whole unit of a token, or null. ETH from a pool, equities from Nasdaq. */
/**
 * A token in dollars: Nasdaq for the equities, a pool for everything else.
 *
 * The seed list answers for anything this repo ships, which is every equity and ether. It does not
 * answer for a LAUNCH COIN, and a buyback's entire output is denominated in one — so without the
 * fallback a buyback index reports what it burned as nothing at all.
 */
async function priceOf(token: string, quotes: Record<string, { price: number }>): Promise<number | null> {
  if (token === ZERO_ADDRESS) return ethUsd();
  const known = stockByAddress(token);
  const price = known?.ticker ? quotes[known.ticker]?.price : undefined;
  if (typeof price === "number" && Number.isFinite(price)) return price;

  // No minimum: a coin minutes old trades in one small pool, and that pool is its price.
  const pools = await poolsFor(token.toLowerCase(), 0, false);
  const fromPool = pools.best?.priceUsd;
  return typeof fromPool === "number" && Number.isFinite(fromPool) && fromPool > 0 ? fromPool : null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** `mode` on a treasury: buy the coin back and destroy it, rather than pay a basket out. */
export const MODE_BUYBACK = 1;

/**
 * What an index has actually returned to its holders, in dollars — the one figure both modes have.
 *
 * A buyback pays nobody, so `paidUsd` is null for every one of them however much they have
 * destroyed. Reading the list on that alone put an index that had burned 14.8M coins BELOW one that
 * had never run a round, never collected a fee and never bought anything. The row already knew
 * better — it prints the burn where a payout would go — but the ORDER did not, so the list
 * contradicted the rows it was made of.
 *
 * The fallback to `spentUsd` is what makes this usable rather than merely correct. `burnedUsd`
 * values the burn at the coin's own price, and a launch coin is priced off one small pool that
 * answers `null` more often than not — measured on the live set, every buyback came back unpriced
 * on one read and priced on the next, so ordering on it alone is a list that reshuffles itself.
 * What the treasury PAID is denominated in the quote, which is ether or an equity and always
 * prices. It undercounts, because it misses the coin-side fee leg that `harvest` burns without
 * buying, so it is a floor and never a replacement.
 *
 * Null still means null: an index whose output cannot be priced at all is not a confident zero.
 */
export function returnedUsd(
  row: Pick<IndexRow, "mode" | "paidUsd" | "burnedUsd" | "spentUsd">,
): number | null {
  if (row.mode !== MODE_BUYBACK) return row.paidUsd;
  return row.burnedUsd ?? row.spentUsd;
}

/**
 * Has this index done the thing it exists to do — whether or not the result can be priced?
 *
 * Ranked ahead of the dollar figure, because "we cannot price it" and "it has never run" are
 * different states that a dollars-only sort collapses into the same bottom of the list.
 */
function hasRun(row: IndexRow): boolean {
  return row.mode === MODE_BUYBACK ? (row.burnedUnits ?? 0) > 0 : row.rounds > 0;
}


/** Every index with its history priced, newest first. */
export function readIndexRows(): Promise<{ rows: IndexRow[]; totals: IndexTotals }> {
  return cached("indices:rows", 60_000, loadRows).catch(() => ({
    rows: [],
    totals: { returnedUsd: null, count: 0, withRounds: 0, rounds: 0, payments: 0, truncated: false },
  }));
}

async function loadRows(): Promise<{ rows: IndexRow[]; totals: IndexTotals }> {
  const [all, activity] = await Promise.all([readIndices(), readActivity()]);

  // Every token any index touches, so decimals and prices are fetched once for the whole page.
  const tokens = new Set<string>();
  for (const index of all) {
    tokens.add(index.quote.toLowerCase());
    for (const t of index.basket) tokens.add(t.toLowerCase());
    // The coin too: a buyback's only output is denominated in it.
    if (index.coin && BigInt(index.coin) !== 0n) tokens.add(index.coin.toLowerCase());
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
      return {
        ...index, paidUsd: null, paidUnits: [], feesUsd: null,
        burnedUsd: null, burnedUnits: null, spentUsd: null, rounds: 0, payments: 0, unread: true,
      };
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

    // A buyback pays nobody: everything it does ends at the burn, so that is the figure that has to
    // stand where a payout would, or its row reads as an index that has never done anything.
    const coinDecimals = decimals.get(index.coin.toLowerCase());
    const burnedUnits = a.burnedRaw === 0n || coinDecimals === null || coinDecimals === undefined
      ? (a.burnedRaw === 0n ? 0 : null)
      : Number(a.burnedRaw) / 10 ** coinDecimals;
    const coinPrice = priced.get(index.coin.toLowerCase());

    return {
      ...index,
      paidUsd,
      paidUnits,
      feesUsd: a.feesRaw === 0n ? 0 : usd(index.quote, a.feesRaw),
      burnedUnits,
      burnedUsd: burnedUnits === null || coinPrice === null || coinPrice === undefined
        ? null
        : burnedUnits * coinPrice,
      spentUsd: a.spentRaw === 0n ? 0 : usd(index.quote, a.spentRaw),
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

  /**
   * Biggest first: the list is a record of what has actually worked, not of what exists.
   *
   * Three keys, in this order, because each one runs out. Anything that has RUN outranks anything
   * that has not, in either mode. Among those, the dollars actually returned. And when two indexes
   * both return an unpriceable figure, the fees they have collected — priced in the quote, so
   * always readable — stand in for scale.
   */
  bound.sort(
    (a, b) =>
      Number(hasRun(b)) - Number(hasRun(a))
      || (returnedUsd(b) ?? 0) - (returnedUsd(a) ?? 0)
      || (b.feesUsd ?? 0) - (a.feesUsd ?? 0),
  );

  const totals: IndexTotals = {
    /**
     * Both mechanisms, in one figure — and the tile that shows it names both.
     *
     * This used to be payouts only, on the reasoning that a burn returns value by shrinking the
     * supply rather than by sending anything, so adding them would be one number describing two
     * mechanisms. The objection was really to the LABEL: a total headed "Paid to holders" that
     * quietly included coins nobody was paid is the dishonest part, not the addition. With the tile
     * reading "Paid to holders / Bought back" the sum says exactly what it is, and leaving the
     * buybacks out would understate the set by more than it contains — every index that has given
     * back the most is one.
     */
    returnedUsd: bound.some((r) => returnedUsd(r) !== null)
      ? bound.reduce((sum, r) => sum + (returnedUsd(r) ?? 0), 0)
      : null,
    count: bound.length,
    withRounds: bound.filter((r) => r.rounds > 0).length,
    rounds: bound.reduce((sum, r) => sum + r.rounds, 0),
    payments: bound.reduce((sum, r) => sum + r.payments, 0),
    // A full page is the only signal available here that there may be another one behind it.
    truncated: all.length >= PAGE_LIMIT,
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
  /** A buyback's entire output: what it destroyed. Zero-safe, null when the coin has no price. */
  burnedUsd: number | null;
  burnedUnits: number | null;
  /** Dollars put through a buy, priced in the quote — the same floor the list uses. See `returnedUsd`. */
  spentUsd: number | null;
  rounds: number;
  payments: number;
  events: IndexEvent[];
} | null> {
  const [index, activity] = await Promise.all([readIndex(address), readActivity()]);
  if (!index || !activity) return null;
  const a = activity.get(address.toLowerCase());
  if (!a) return null;

  /**
   * The coin belongs in here too: a buyback denominates everything it does in it.
   *
   * THE ZERO ADDRESS IS AN ANSWER, NOT A GAP. A native-quoted index — which is what the builder
   * creates by default — collects and pays in ether, so `quote` is legitimately `0x0…0`. Excluding
   * it left `readDecimals` and `priceOf` without the one entry every fee figure on the page is
   * scaled and priced by, and the detail page reported "Fees collected —" and "Creator earnings —"
   * for an index that had been harvesting for weeks. Both already know what it means: 18 decimals,
   * and the ETH price. `loadRows` never filtered it, which is why the list and the detail page
   * disagreed about the same index.
   *
   * Deduped rather than filtered, so an UNBOUND treasury — whose `coin` is also `0x0…0` — costs one
   * entry instead of two.
   */
  const tokens = [
    ...new Set(
      [index.quote.toLowerCase(), index.coin.toLowerCase(), ...a.distributed.keys()]
        .filter((t) => /^0x[a-f0-9]{40}$/.test(t)),
    ),
  ];
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
    burnedUsd: a.burnedRaw === 0n ? 0 : value(index.coin, a.burnedRaw),
    burnedUnits: a.burnedRaw === 0n ? 0 : units(index.coin, a.burnedRaw),
    spentUsd: a.spentRaw === 0n ? 0 : value(index.quote, a.spentRaw),
    rounds: a.rounds,
    payments: a.payments,
    events: a.events,
  };
}
