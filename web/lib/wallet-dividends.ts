import "server-only";

import { readAssets } from "./b20";
import { cached } from "./cache";
import { readDecimals, toUnits } from "./decimals";
import { marketBoard } from "./market";
import { batchCall, pad, toBigInt, type RpcCall } from "./rpc";
import { stockByAddress } from "./stocks";

/**
 * Everything the dividend vault has pushed to one wallet, all time.
 *
 * WHERE IT COMES FROM, AND WHY THAT IS CHEAP. The vault pays by calling `transfer` on each stock, so
 * a wallet's history is exactly the `Transfer(vault → wallet)` logs of the stocks it distributes.
 * Those are asked of Etherscan's log API filtered on BOTH indexed topics, which returns only this
 * wallet's rows: one request per stock, whatever the vault's age, and zero RPC traffic for history.
 * Measured 2026-10-11: ~2.4s per stock, the five in parallel (under the 5/sec limit) in about the
 * same time, against 33s for the alternative of pulling every token transfer the wallet ever made.
 *
 * The only chain reads are one batch for what is happening NOW: the wallet's STFY balance against
 * the threshold, and any payout the vault recorded as unpaid because the transfer was refused.
 *
 * Cached per wallet for ten minutes. A lookup a minute later costs nothing; a payout lands hourly at
 * most, so ten minutes cannot hide more than one cycle.
 */

const VAULT = (process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS ?? "").toLowerCase();
const EXPLORER = "https://api.etherscan.io/v2/api";
const EXPLORER_KEY = process.env.ETHERSCAN_API_KEY;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAGE = 1_000;
const TTL_MS = 10 * 60_000;

const SIG = {
  distributionStocksLength: "0x5079ad2f",
  distributionStockAt: "0xef72f35d",
  unpaidDividend: "0x7d25ae81",
  stockifyToken: "0xa0c75e32",
  balanceOf: "0x70a08231",
  minShareBalance: "0xf4e15ee7",
} as const;

export const isWalletAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

export type WalletStock = {
  address: string;
  symbol: string;
  name: string;
  logo?: string;
  domain?: string;
  /** Shares received, all time. */
  shares: number;
  /** The same at today's share price; null when the stock has no quote. */
  value: number | null;
  /** How many separate payouts delivered it. */
  payouts: number;
  /** Shares owed but not yet delivered (a refused transfer the vault will retry). */
  unpaid: number;
  lastPaidAt: number | null;
};

export type WalletDividends = {
  address: string;
  stocks: WalletStock[];
  totalValue: number;
  totalPayouts: number;
  firstPaidAt: number | null;
  lastPaidAt: number | null;
  /** STFY held now, and whether that clears the vault's threshold. Null when unread. */
  stfyBalance: number | null;
  threshold: number | null;
  /** True when some history could not be read; the totals are then a floor, and the page says so. */
  partial: boolean;
};

type Row = { amount: bigint; timestamp: number; block: number; key: string };
type ExplorerPayload = { status?: string; message?: string; result?: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const topicOf = (address: string) => `0x${pad(address.toLowerCase())}`;

/**
 * Every transfer of one stock from the vault to the wallet, oldest first.
 *
 * Walked by BLOCK, not by page: the explorer's `page` silently stops after a few thousand rows, so
 * each request starts at the block of the last row it already has (inclusive, deduplicated by
 * transaction and log index) until a short page says the history is done. Null when the explorer
 * would not answer, so the caller can mark the result partial instead of reporting less than is true.
 */
async function transfersOf(stock: string, wallet: string): Promise<Row[] | null> {
  if (!EXPLORER_KEY) return null;
  const rows = new Map<string, Row>();
  let fromBlock = 0;

  for (let round = 0; round < 50; round++) {
    const query = new URLSearchParams({
      chainid: "8453",
      module: "logs",
      action: "getLogs",
      address: stock,
      fromBlock: String(fromBlock),
      toBlock: "latest",
      topic0: TRANSFER,
      topic1: topicOf(VAULT),
      topic2: topicOf(wallet),
      topic0_1_opr: "and",
      topic1_2_opr: "and",
      page: "1",
      offset: String(PAGE),
      apikey: EXPLORER_KEY,
    });

    let payload = null as ExplorerPayload | null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(`${EXPLORER}?${query}`, { cache: "no-store" });
        payload = response.ok ? await response.json() as ExplorerPayload : null;
      } catch {
        payload = null;
      }
      // Etherscan's rate limit arrives as status 0 with the reason in `result`: wait it out.
      if (payload && !Array.isArray(payload.result) && /rate limit/i.test(String(payload.result ?? ""))) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!payload) return null;
    if (!Array.isArray(payload.result)) {
      if (/no records found/i.test(String(payload.message ?? ""))) break;
      return null;
    }

    const page = payload.result as Array<Record<string, string>>;
    let last = fromBlock;
    for (const entry of page) {
      const block = Number(BigInt(entry.blockNumber));
      const key = `${entry.transactionHash}:${entry.logIndex}`;
      if (!rows.has(key)) {
        rows.set(key, { amount: BigInt(entry.data === "0x" ? 0 : entry.data), timestamp: Number(BigInt(entry.timeStamp)), block, key });
      }
      last = Math.max(last, block);
    }
    if (page.length < PAGE) break;
    fromBlock = last;
  }

  return [...rows.values()].sort((a, b) => a.block - b.block);
}

/** The stocks the vault has ever distributed. The list only grows, so it is the whole history. */
function distributionStocks(): Promise<string[]> {
  return cached("wallet:distribution-stocks", 60 * 60_000, async () => {
    const [length] = await batchCall([{ to: VAULT, data: SIG.distributionStocksLength }]);
    const count = toBigInt(length);
    if (count === null) throw new Error("vault: distributionStocksLength unread");
    const calls: RpcCall[] = Array.from({ length: Math.min(Number(count), 64) }, (_, i) => ({
      to: VAULT, data: SIG.distributionStockAt + pad(i.toString(16)),
    }));
    const results = await batchCall(calls);
    return results.map((r) => `0x${(r.data ?? "").replace(/^0x/, "").slice(24, 64)}`).filter((a) => isWalletAddress(a));
  });
}

async function load(wallet: string): Promise<WalletDividends> {
  const stocks = await distributionStocks();

  // History: one filtered log request per stock, four at a time to stay under the 5/sec limit.
  const histories: Array<Row[] | null> = [];
  for (let i = 0; i < stocks.length; i += 4) {
    const slice = stocks.slice(i, i + 4);
    histories.push(...await Promise.all(slice.map((s, j) => sleep(j * 120).then(() => transfersOf(s, wallet)))));
    if (i + 4 < stocks.length) await sleep(1_000);
  }

  // The present: STFY balance, the threshold, and anything owed but undelivered. One batch.
  const [tokenResult] = await batchCall([{ to: VAULT, data: SIG.stockifyToken }]);
  const tokenWord = (tokenResult.data ?? "").replace(/^0x/, "");
  const stfy = tokenWord.length >= 64 ? `0x${tokenWord.slice(24, 64)}` : null;
  const nowCalls: RpcCall[] = [
    ...stocks.map((s) => ({ to: VAULT, data: SIG.unpaidDividend + pad(s) + pad(wallet) })),
    ...(stfy ? [{ to: stfy, data: SIG.balanceOf + pad(wallet) }, { to: stfy, data: SIG.minShareBalance }] : []),
  ];
  const now = await batchCall(nowCalls);

  const [decimals, assets] = await Promise.all([readDecimals(stocks), readAssets()]);
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const tickers = stocks.map((s) => byAddress.get(s)?.ticker ?? stockByAddress(s)?.ticker).filter(Boolean) as string[];
  const board = tickers.length ? await marketBoard(tickers) : { quotes: {} as Record<string, { price: number }> };

  let partial = false;
  const rows: WalletStock[] = stocks.map((address, i) => {
    const history = histories[i];
    if (history === null) partial = true;
    const scale = decimals.get(address) ?? null;
    const total = (history ?? []).reduce((sum, row) => sum + row.amount, 0n);
    const shares = toUnits(total.toString(), scale) ?? 0;
    const unpaidRaw = toBigInt(now[i]);
    const asset = byAddress.get(address);
    const seed = stockByAddress(address);
    const ticker = asset?.ticker ?? seed?.ticker;
    const price = ticker ? (board.quotes as Record<string, { price: number } | undefined>)[ticker]?.price : undefined;
    return {
      address,
      symbol: asset?.symbol ?? seed?.symbol ?? `${address.slice(0, 6)}…`,
      name: seed?.name ?? asset?.name ?? "",
      logo: asset?.logo,
      domain: asset?.domain ?? seed?.domain,
      shares,
      value: price ? shares * price : null,
      payouts: history?.length ?? 0,
      unpaid: unpaidRaw === null ? 0 : (toUnits(unpaidRaw.toString(), scale) ?? 0),
      lastPaidAt: history?.length ? history[history.length - 1].timestamp : null,
    };
  });

  const received = rows.filter((r) => r.shares > 0 || r.unpaid > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const times = (histories.flat().filter(Boolean) as Row[]).map((r) => r.timestamp);
  const balanceRaw = stfy ? toBigInt(now[stocks.length]) : null;
  const thresholdRaw = stfy ? toBigInt(now[stocks.length + 1]) : null;

  return {
    address: wallet,
    stocks: received,
    totalValue: received.reduce((sum, r) => sum + (r.value ?? 0), 0),
    totalPayouts: Math.max(0, ...rows.map((r) => r.payouts)),
    firstPaidAt: times.length ? Math.min(...times) : null,
    lastPaidAt: times.length ? Math.max(...times) : null,
    stfyBalance: balanceRaw === null ? null : Number(balanceRaw) / 1e18,
    threshold: thresholdRaw === null ? null : Number(thresholdRaw) / 1e18,
    partial,
  };
}

export function readWalletDividends(address: string): Promise<WalletDividends> {
  const wallet = address.toLowerCase();
  return cached(`wallet:dividends:${wallet}`, TTL_MS, () => load(wallet));
}
