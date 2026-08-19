import { cached } from "./cache";
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
const RPCS = [
  ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
];
const FACTORY = "0xB20f000000000000000000000000000000000000";
const WAD = 10n ** 18n;

/** 4-byte selectors. Kept literal so this module stays dependency-free, as `check-b20.mjs` does. */
const SIG = {
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  multiplier: "0x1b3ed722",
  contractURI: "0xe8a3d485",
  isB20: "0xfa19b927",
} as const;

const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

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
  /** Favicon fallback for the two assets with no on-chain icon to read. */
  domain?: string;
  inIndex: boolean;
};

type RpcCall = { to: string; data: string };

/**
 * What one `eth_call` actually told us — which is three answers, not two.
 *
 * `reverted` is a LEGITIMATE ANSWER: B20 methods are individually activatable, so "this token does
 * not implement `multiplier()`" arrives as a revert and means the multiplier is 1.0.
 *
 * `unavailable` means we never got an answer. Base's public RPC rate-limits PER ELEMENT INSIDE A
 * BATCH — the response is 200, the array is the right length, and individual entries carry
 * `{code: -32016, "over rate limit"}`. Collapsing that into the same `null` as a revert is what made
 * this page report every equity as having zero supply while looking entirely healthy. A number we
 * failed to read must never be rendered as a number we read as zero.
 */
type CallState = "ok" | "reverted" | "unavailable";
type CallResult = { state: CallState; data?: string };

const UNAVAILABLE: CallResult = { state: "unavailable" };

/** Base's public RPC caps a batch at ten calls. A funded endpoint allows more, hence the knob. */
const BATCH_LIMIT = Math.max(1, Number(process.env.BASE_RPC_BATCH_SIZE) || 10);
/** Rate limits here are per-second. Serialising the chunks costs ~1s and stops the throttling. */
const BATCH_GAP_MS = Math.max(0, Number(process.env.BASE_RPC_GAP_MS) || 120);
const MAX_ROUNDS = Math.max(3, RPCS.length);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON-RPC's "execution reverted" is code 3. Everything else is us failing, not the chain. */
const isRevert = (error: { code?: number } | undefined) => error?.code === 3;

async function batchOnce(calls: RpcCall[], rpc: string): Promise<CallResult[]> {
  const body = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index,
    method: "eth_call",
    params: [{ to: call.to, data: call.data }, "latest"],
  }));

  // NOT `next: {revalidate}` — Next never caches a POST. Freshness is `cached()`'s job.
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) return calls.map(() => UNAVAILABLE);

  const payload = await response.json() as Array<{ id?: number; result?: string; error?: { code?: number } }> | unknown;
  // An oversized batch is rejected as ONE top-level error object rather than an array. Everything
  // in it is unread, not absent.
  if (!Array.isArray(payload)) return calls.map(() => UNAVAILABLE);

  const out: CallResult[] = calls.map(() => UNAVAILABLE);
  for (const entry of payload) {
    if (typeof entry?.id !== "number" || entry.id < 0 || entry.id >= out.length) continue;
    if (typeof entry.result === "string") out[entry.id] = { state: "ok", data: entry.result };
    else if (isRevert(entry.error)) out[entry.id] = { state: "reverted" };
  }
  return out;
}

/**
 * Batched `eth_call`s, chunked, paced, and retried until only real answers remain.
 *
 * Retries target the SPECIFIC calls that came back unavailable rather than whole chunks, so a
 * throttled tail costs one small follow-up request instead of a full replay, and the backoff gives
 * the per-second limit time to reset.
 */
async function batchCall(calls: RpcCall[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const out: CallResult[] = calls.map(() => UNAVAILABLE);
  let pending = calls.map((_, index) => index);

  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
    // Each round moves to the next endpoint. A retry against the endpoint that just throttled us is
    // the least likely request to succeed; a different provider is the most likely.
    const rpc = RPCS[Math.min(round, RPCS.length - 1)];
    if (round > 0) await sleep(250 * round);

    for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
      const slice = pending.slice(i, i + BATCH_LIMIT);
      try {
        const results = await batchOnce(slice.map((index) => calls[index]), rpc);
        results.forEach((result, j) => { out[slice[j]] = result; });
      } catch {
        // Transport failure: leave these unavailable and let the next round have them.
      }
      if (i + BATCH_LIMIT < pending.length) await sleep(BATCH_GAP_MS);
    }

    pending = pending.filter((index) => out[index].state === "unavailable");
  }

  return out;
}

const wordOf = (result: CallResult) => (result.state === "ok" ? result.data ?? null : null);

const toBigInt = (result: CallResult) => {
  const word = wordOf(result);
  if (!word || word === "0x") return null;
  try { return BigInt(word); } catch { return null; }
};

/** Decode a solidity `string` return (offset, length, bytes) without pulling in an ABI decoder. */
function decodeString(result: CallResult): string | undefined {
  const word = wordOf(result);
  if (!word || word.length < 130) return undefined;
  try {
    const body = word.slice(2);
    const length = Number(BigInt("0x" + body.slice(64, 128)));
    if (!length || length * 2 > body.length - 128) return undefined;
    const bytes = body.slice(128, 128 + length * 2).match(/.{2}/g) ?? [];
    return new TextDecoder().decode(Uint8Array.from(bytes, (b) => parseInt(b, 16)));
  } catch {
    return undefined;
  }
}

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
