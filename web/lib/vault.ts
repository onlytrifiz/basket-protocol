import { cached } from "./cache";
import { readDecimals } from "./decimals";
import { batchCall, getLogs, pad, toBigInt, type Log, type RpcCall } from "./rpc";
import { stockByAddress } from "./stocks";

/**
 * What the dividend vault actually holds and owes, read from Base.
 *
 * THE INDEX IS NOT A CONSTANT IN THIS REPO. `stocksLength()` / `stockAt()` are the source of truth
 * for which equities the vault buys and in what proportion, and ownership can change both between
 * cycles. Reading them means the dividend page cannot drift from what the contract will
 * actually do — a hardcoded list would keep rendering last month's index with total conviction.
 *
 * Every figure here is a live read. The page it feeds is a ledger, and a ledger that shows a
 * plausible number it did not verify is worse than one that shows nothing.
 */

const VAULT = process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS ?? "";

/**
 * The share token is read FROM THE VAULT, not from the environment.
 *
 * `NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS` answers "what does the swap card trade", and those are the
 * same token in production but not today: the card points at a plain test ERC-20 while the real
 * StockifyToken stays deployed and keeps the holder registry. Reading the env var here meant asking
 * a token with no registry for its holder count, which reverts — and the page had no way to tell
 * that apart from a protocol with no holders.
 *
 * `stockifyToken()` is immutable on the vault, so this cannot drift from what the vault accounts
 * against, whatever the front end happens to be trading.
 */
async function shareToken(): Promise<string | null> {
  const [result] = await batchCall([{ to: VAULT, data: SIG.stockifyToken }]);
  const word = result.state === "ok" ? (result.data ?? "").replace(/^0x/, "") : "";
  if (word.length < 64) return null;
  const address = `0x${word.slice(24, 64)}`;
  return isAddress(address) && BigInt(address) !== 0n ? address : null;
}

/** Generated with `cast sig`; this module stays dependency-free like the rest of the chain layer. */
const SIG = {
  stocksLength: "0x609b67a7",
  stockAt: "0xbcb40097",
  unpaidTotal: "0xc1860b84",
  cycleActive: "0x8a097f37",
  nextDistribution: "0x38b0789d",
  availableEth: "0x1b9f4cf3",
  eligibleSupply: "0x6ade07b0",
  platformClaimable: "0x044991d8",
  balanceOf: "0x70a08231",
  holderCount: "0x1aab9a9f",
  minShareBalance: "0xf4e15ee7",
  stockifyToken: "0xa0c75e32",
} as const;

const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

export type IndexHolding = {
  address: string;
  symbol: string;
  name: string;
  /** Target share of each cycle's stock budget, in basis points. 2500 = 25%. */
  weightBps: number;
  /** Raw units the vault holds right now — acquired, not yet pushed out. `null` when unread. */
  heldRaw: string | null;
  /** Raw units already credited to holders and awaiting their transfer. `null` when unread. */
  unpaidRaw: string | null;
  /**
   * The token's own scale, read from the token. `null` when unread — never assumed.
   *
   * This used to be a literal 8, which was right for as long as every entry came from `lib/stocks`.
   * The index does not: it is read from `stockAt()`, and the row above deliberately renders an asset
   * this repo has never heard of. Pairing "we do not know what this is" with "we know how to scale
   * it" was the contradiction. See `lib/decimals`.
   */
  decimals: number | null;
};

export type VaultState = {
  /** False when the addresses are unset or the chain did not answer — the page then says so. */
  live: boolean;
  holdings: IndexHolding[];
  cycleActive: boolean;
  /** Unix seconds the next cycle may start. 0 before the first one has ever run. */
  nextDistribution: number;
  availableEthWei: string | null;
  eligibleSupplyRaw: string | null;
  holderCount: number | null;
  /** STFY a wallet must hold to be counted, in raw 18-decimal units. */
  minShareBalanceRaw: string | null;
};

const EMPTY: VaultState = {
  live: false, holdings: [], cycleActive: false, nextDistribution: 0,
  availableEthWei: null, eligibleSupplyRaw: null, holderCount: null, minShareBalanceRaw: null,
};

/**
 * Vault state, refreshed on the cadence a cycle could plausibly change it.
 *
 * `loadVault` THROWS when the chain does not answer rather than returning an empty state, so
 * `cached()` can fall back to its last good read. Returning `EMPTY` looked harmless and was not:
 * a hiccup pinned "0 assets, 0% weights" for the whole TTL and the homepage donut rendered it as
 * fact — the same read-failure-as-zero mistake the B20 loader was built to avoid.
 */
export function readVault(): Promise<VaultState> {
  return cached("vault", 30_000, loadVault).catch(() => EMPTY);
}

async function loadVault(): Promise<VaultState> {
  if (!isAddress(VAULT)) return EMPTY;

  // Stage 1 — how many stocks are in the index. Everything else depends on the count.
  const [lengthResult] = await batchCall([{ to: VAULT, data: SIG.stocksLength }]);
  const length = toBigInt(lengthResult);
  if (length === null) throw new Error("vault: stocksLength unreadable");
  const count = Math.min(Number(length), 32);

  // Stage 2 — which stocks, plus the vault-wide figures, in one round.
  const indexCalls: RpcCall[] = Array.from({ length: count }, (_, i) => ({
    to: VAULT,
    data: SIG.stockAt + pad(i.toString(16)),
  }));
  const token = await shareToken();
  const stateCalls: RpcCall[] = [
    { to: VAULT, data: SIG.cycleActive },
    { to: VAULT, data: SIG.nextDistribution },
    { to: VAULT, data: SIG.availableEth },
    { to: VAULT, data: SIG.eligibleSupply },
    ...(token ? [{ to: token, data: SIG.holderCount }, { to: token, data: SIG.minShareBalance }] : []),
  ];

  const results = await batchCall([...indexCalls, ...stateCalls]);
  const stateAt = (i: number) => results[count + i];

  /**
   * `stockAt` returns TWO words — (address, uint16 weightBps) — and each has to be sliced out by
   * position. The generic `toAddress` helper takes the last 20 bytes of the whole return, which for
   * a two-word tuple is the tail of the SECOND word: it read every entry's address as 0x…09c4, the
   * weight 2500. Four rows then shared one React key and the ledger silently collapsed.
   */
  const entries = results.slice(0, count).map((result) => {
    const word = result.state === "ok" ? (result.data ?? "").replace(/^0x/, "") : "";
    if (word.length < 128) return null;
    const address = `0x${word.slice(24, 64)}`;
    if (!isAddress(address)) return null;
    return { address, weightBps: Number(BigInt(`0x${word.slice(64, 128)}`)) };
  }).filter(Boolean) as Array<{ address: string; weightBps: number }>;

  // Stage 3 — what the vault holds of each, and what it already owes.
  const holdingCalls: RpcCall[] = entries.flatMap((entry) => [
    { to: entry.address, data: SIG.balanceOf + pad(VAULT) },
    { to: VAULT, data: SIG.unpaidTotal + pad(entry.address) },
  ]);
  const holdingResults = await batchCall(holdingCalls);

  const holdings: IndexHolding[] = entries.map((entry, i) => {
    const known = stockByAddress(entry.address);
    const held = holdingResults[i * 2];
    const unpaid = holdingResults[i * 2 + 1];
    return {
      address: entry.address,
      // An index entry we have no metadata for is still real; it renders by address rather than
      // being dropped, because a vault buying something this repo has never heard of is exactly the
      // thing a ledger must not hide.
      symbol: known?.symbol ?? `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`,
      name: known?.name ?? "Unlisted B20 asset",
      weightBps: entry.weightBps,
      heldRaw: held.state === "unavailable" ? null : (toBigInt(held) ?? 0n).toString(),
      unpaidRaw: unpaid.state === "unavailable" ? null : (toBigInt(unpaid) ?? 0n).toString(),
      decimals: 8,
    };
  });

  const asString = (i: number) => {
    const value = toBigInt(stateAt(i));
    return value === null ? null : value.toString();
  };

  return {
    live: true,
    holdings,
    cycleActive: (toBigInt(stateAt(0)) ?? 0n) !== 0n,
    nextDistribution: Number(toBigInt(stateAt(1)) ?? 0n),
    availableEthWei: asString(2),
    eligibleSupplyRaw: asString(3),
    // Null means UNREAD, never zero: `?? 0n` here once turned a reverted registry read into a
    // confident "0 eligible holders".
    holderCount: token ? (toBigInt(stateAt(4)) === null ? null : Number(toBigInt(stateAt(4)))) : null,
    minShareBalanceRaw: token ? asString(5) : null,
  };
}


/**
 * Settled cycles, rebuilt from the vault's own events.
 *
 * The ledger cannot come from view calls: the contract keeps no history array, and it is right not
 * to — paying to store a growing list on-chain to serve a web page would be the wrong trade. The
 * events are the record, so this reads them.
 *
 * SCANNED ONCE, NOT PER VISITOR. A settled cycle never changes, so re-deriving the same rows on
 * every render was work with no possible new answer — and it bought only what the public log window
 * happened to reach, roughly five hours, which quietly hid every older cycle. What lives here now
 * is the decoder; `lib/ledger.ts` owns the scanning cursor and keeps the results.
 */
const TOPIC = {
  cycleStarted: "0x6fa249767fee0ff570c08e8f07a9030d8fdb125b55f00a47606480a2e1429134",
  cycleCompleted: "0x4576cab8caca8be887c75752f3e3a9f467370cc86ee932348b0717baad90a827",
  stocksBought: "0x1c956e05cfdb7b91baafeb8ae4eababa635d678602068df516c3f9397e69e3b8",
  stockBought: "0x1560b71ca6695825842f12e8721dc7f437286c08deb7c7ebc708bb3bdc3d01c5",
} as const;

export type Cycle = {
  blockNumber: number;
  /** Unix seconds of the settling block, from the log itself. */
  timestamp: number;
  txHash: string;
  /** Holders paid in this cycle, from `DistributionCycleCompleted`. */
  holderCount: number;
  /** ETH spent on stock this cycle, from the `StocksBought` that preceded it. */
  stockEthWei: string | null;
  /** Per-asset acquisitions attributed to this cycle. */
  bought: Array<{ address: string; ethSpentWei: string; receivedRaw: string }>;
};

/** Split `data` into 32-byte words. */
const words = (data: string) => (data.replace(/^0x/, "").match(/.{64}/g) ?? []);
const wordInt = (data: string, i: number) => {
  const w = words(data)[i];
  return w === undefined ? 0n : BigInt(`0x${w}`);
};

/**
 * Every cycle that settled between two blocks, oldest first, or null if the range went unread.
 *
 * One unfiltered pass over the vault's logs, then sorted here. Four filtered calls would be four
 * times the range requests for the same rows.
 */
export async function scanCycles(fromBlock: number, toBlock: number): Promise<Cycle[] | null> {
  if (!isAddress(VAULT) || toBlock < fromBlock) return null;
  const logs = await getLogs(VAULT, [], fromBlock, toBlock);
  return logs === null ? null : decodeCycles(logs);
}

/**
 * Logs to cycles, oldest first.
 *
 * A PARTIAL FIRST CYCLE IS THE PRICE OF ANY WINDOW. Purchases are attributed to the cycle that
 * settles after them, so a scan starting mid-cycle sees the settlement but not the buys that fed
 * it. Starting from the vault's deploy block is what makes that theoretical; starting from a stored
 * cursor keeps it that way, because every earlier block has already been walked exactly once.
 */
export function decodeCycles(logs: Log[]): Cycle[] {
  const cycles: Cycle[] = [];
  // Keyed by asset, because a cycle spans every purchase made since the previous one settled — the
  // keeper buys on its own poll interval while a cycle can only START hourly, so an hour of trading
  // is a dozen StockBought events per asset. Listing them raw drew twelve near-identical rows for
  // one cycle; what a reader wants is what that cycle acquired, once per asset.
  let pendingBought = new Map<string, { address: string; ethSpentWei: bigint; receivedRaw: bigint }>();
  let pendingStockEth = 0n;
  let sawStockEth = false;

  for (const log of [...logs].sort((a, b) => a.blockNumber - b.blockNumber)) {
    const topic = log.topics[0];
    if (topic === TOPIC.stockBought) {
      const address = `0x${(log.topics[1] ?? "").slice(-40)}`;
      const key = address.toLowerCase();
      const running = pendingBought.get(key) ?? { address, ethSpentWei: 0n, receivedRaw: 0n };
      running.ethSpentWei += wordInt(log.data, 0);
      running.receivedRaw += wordInt(log.data, 1);
      pendingBought.set(key, running);
    } else if (topic === TOPIC.stocksBought) {
      // Summed, not assigned. Overwriting reported only the LAST purchase before settlement, so a
      // cycle that had deployed several ETH claimed the few hundredths of its final top-up.
      pendingStockEth += wordInt(log.data, 2);
      sawStockEth = true;
    } else if (topic === TOPIC.cycleCompleted) {
      cycles.push({
        blockNumber: log.blockNumber,
        timestamp: log.timestamp,
        txHash: log.transactionHash,
        holderCount: Number(wordInt(log.data, 0)),
        stockEthWei: sawStockEth ? pendingStockEth.toString() : null,
        bought: [...pendingBought.values()].map((b) => ({
          address: b.address,
          ethSpentWei: b.ethSpentWei.toString(),
          receivedRaw: b.receivedRaw.toString(),
        })),
      });
      pendingBought = new Map();
      pendingStockEth = 0n;
      sawStockEth = false;
    }
  }

  return cycles;
}
