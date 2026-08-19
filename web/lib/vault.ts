import { cached } from "./cache";
import { batchCall, blockNumber, getLogs, pad, toBigInt, type RpcCall } from "./rpc";
import { stockByAddress } from "./stocks";

/**
 * What the dividend vault actually holds and owes, read from Base.
 *
 * THE INDEX IS NOT A CONSTANT IN THIS REPO. `stocksLength()` / `stockAt()` are the source of truth
 * for which equities the vault buys and in what proportion, and ownership can change both between
 * cycles. Reading them means the distributions page cannot drift from what the contract will
 * actually do — a hardcoded list would keep rendering last month's index with total conviction.
 *
 * Every figure here is a live read. The page it feeds is a ledger, and a ledger that shows a
 * plausible number it did not verify is worse than one that shows nothing.
 */

const VAULT = process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS ?? "";
const TOKEN = process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS ?? "";

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
  decimals: number;
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

/** Vault state, refreshed on the cadence a cycle could plausibly change it. */
export function readVault(): Promise<VaultState> {
  return cached("vault", 30_000, loadVault);
}

async function loadVault(): Promise<VaultState> {
  if (!isAddress(VAULT)) return EMPTY;

  // Stage 1 — how many stocks are in the index. Everything else depends on the count.
  const [lengthResult] = await batchCall([{ to: VAULT, data: SIG.stocksLength }]);
  const length = toBigInt(lengthResult);
  if (length === null) return EMPTY;
  const count = Math.min(Number(length), 32);

  // Stage 2 — which stocks, plus the vault-wide figures, in one round.
  const indexCalls: RpcCall[] = Array.from({ length: count }, (_, i) => ({
    to: VAULT,
    data: SIG.stockAt + pad(i.toString(16)),
  }));
  const stateCalls: RpcCall[] = [
    { to: VAULT, data: SIG.cycleActive },
    { to: VAULT, data: SIG.nextDistribution },
    { to: VAULT, data: SIG.availableEth },
    { to: VAULT, data: SIG.eligibleSupply },
    ...(isAddress(TOKEN) ? [{ to: TOKEN, data: SIG.holderCount }, { to: TOKEN, data: SIG.minShareBalance }] : []),
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
    holderCount: isAddress(TOKEN) ? Number(toBigInt(stateAt(4)) ?? 0n) : null,
    minShareBalanceRaw: isAddress(TOKEN) ? asString(5) : null,
  };
}


/**
 * Settled cycles, rebuilt from the vault's own events.
 *
 * The ledger cannot come from view calls: the contract keeps no history array, and it is right not
 * to — paying to store a growing list on-chain to serve a web page would be the wrong trade. The
 * events are the record, so this reads them.
 *
 * WHAT THIS WINDOW IS. See `getLogs`: public endpoints cap the range at 10,000 blocks, about five
 * and a half hours of Base. With cycles targeting hourly cadence that covers the most recent
 * handful, and the page says so rather than implying it is everything that ever settled.
 */
const TOPIC = {
  cycleStarted: "0x6fa249767fee0ff570c08e8f07a9030d8fdb125b55f00a47606480a2e1429134",
  cycleCompleted: "0x4576cab8caca8be887c75752f3e3a9f467370cc86ee932348b0717baad90a827",
  stocksBought: "0x1c956e05cfdb7b91baafeb8ae4eababa635d678602068df516c3f9397e69e3b8",
  stockBought: "0x1560b71ca6695825842f12e8721dc7f437286c08deb7c7ebc708bb3bdc3d01c5",
} as const;

export type Cycle = {
  blockNumber: number;
  txHash: string;
  /** Holders paid in this cycle, from `DistributionCycleCompleted`. */
  holderCount: number;
  /** ETH spent on stock this cycle, from the `StocksBought` that preceded it. */
  stockEthWei: string | null;
  /** Per-asset acquisitions attributed to this cycle. */
  bought: Array<{ address: string; ethSpentWei: string; receivedRaw: string }>;
};

export type CycleLedger = {
  /** False when no endpoint would serve the window — the page then says the ledger is unavailable. */
  available: boolean;
  cycles: Cycle[];
  /** How many blocks back the scan reached, so the page can state its own coverage. */
  windowBlocks: number;
};

/** Split `data` into 32-byte words. */
const words = (data: string) => (data.replace(/^0x/, "").match(/.{64}/g) ?? []);
const wordInt = (data: string, i: number) => {
  const w = words(data)[i];
  return w === undefined ? 0n : BigInt(`0x${w}`);
};

export function readCycles(): Promise<CycleLedger> {
  return cached("vault:cycles", 60_000, loadCycles);
}

async function loadCycles(): Promise<CycleLedger> {
  const span = Math.max(1, Number(process.env.BASE_RPC_LOG_SPAN) || 9_500);
  if (!isAddress(VAULT)) return { available: false, cycles: [], windowBlocks: span };

  const head = await blockNumber();
  if (head === null) return { available: false, cycles: [], windowBlocks: span };
  const from = Math.max(0, head - span);

  // One unfiltered pass over the vault's logs in the window, then sorted here. Four filtered calls
  // would be four times the range requests for the same rows.
  const logs = await getLogs(VAULT, [], from, head);
  if (logs.length === 0) {
    // No logs and no error are indistinguishable from here, but the honest reading of "the vault
    // emitted nothing in the last five hours" is an empty ledger, not a broken one.
    return { available: true, cycles: [], windowBlocks: span };
  }

  const cycles: Cycle[] = [];
  let pendingBought: Cycle["bought"] = [];
  let pendingStockEth: string | null = null;

  for (const log of logs.sort((a, b) => a.blockNumber - b.blockNumber)) {
    const topic = log.topics[0];
    if (topic === TOPIC.stockBought) {
      pendingBought.push({
        address: `0x${(log.topics[1] ?? "").slice(-40)}`,
        ethSpentWei: wordInt(log.data, 0).toString(),
        receivedRaw: wordInt(log.data, 1).toString(),
      });
    } else if (topic === TOPIC.stocksBought) {
      pendingStockEth = wordInt(log.data, 2).toString();
    } else if (topic === TOPIC.cycleCompleted) {
      cycles.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        holderCount: Number(wordInt(log.data, 0)),
        stockEthWei: pendingStockEth,
        bought: pendingBought,
      });
      pendingBought = [];
      pendingStockEth = null;
    }
  }

  // Newest first: a ledger is read from the top.
  return { available: true, cycles: cycles.reverse(), windowBlocks: span };
}
