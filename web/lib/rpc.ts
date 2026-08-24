/**
 * One JSON-RPC transport, shared by every on-chain read on this site.
 *
 * Extracted because the vault reader needs exactly the same defences the B20 reader does, and they
 * are not obvious ones — duplicating the logic would have meant duplicating the bugs it exists to
 * prevent. See `batchCall` and `CallResult` below for what those are.
 */

/**
 * Base endpoints, tried in order.
 *
 * NOT just `mainnet.base.org`. Measured against the 26 calls the stocks hub needs: the official
 * public endpoint caps batches at ten AND rate-limits per element inside them, so it answered for
 * roughly five of thirteen equities and reported the rest as unread. publicnode returns all 26 in
 * one batch in ~235ms; 1rpc does the same more slowly. Ordered accordingly, with the official
 * endpoint kept last as a floor rather than dropped.
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

export type RpcCall = { to: string; data: string };

/**
 * What one `eth_call` actually told us — which is three answers, not two.
 *
 * `reverted` is a LEGITIMATE ANSWER: B20 methods are individually activatable, so "this token does
 * not implement `multiplier()`" arrives as a revert and means the multiplier is 1.0.
 *
 * `unavailable` means we never got an answer. Base's public RPC rate-limits PER ELEMENT INSIDE A
 * BATCH — the response is 200, the array is the right length, and individual entries carry
 * `{code: -32016, "over rate limit"}`. Collapsing that into the same `null` as a revert is what made
 * the stocks hub report every equity as having zero supply while looking entirely healthy. A number
 * we failed to read must never be rendered as a number we read as zero.
 */
export type CallState = "ok" | "reverted" | "unavailable";
export type CallResult = { state: CallState; data?: string };

const UNAVAILABLE: CallResult = { state: "unavailable" };

/** Base's public RPC caps a batch at ten calls. A funded endpoint allows more, hence the knob. */
const BATCH_LIMIT = Math.max(1, Number(process.env.BASE_RPC_BATCH_SIZE) || 10);
/** Rate limits here are per-second. Serialising the chunks costs ~1s and stops the throttling. */
const BATCH_GAP_MS = Math.max(0, Number(process.env.BASE_RPC_GAP_MS) || 120);
const MAX_ROUNDS = Math.max(3, RPCS.length);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON-RPC's "execution reverted" is code 3. Everything else is us failing, not the chain. */
const isRevert = (error: { code?: number } | undefined) => error?.code === 3;

export const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

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
 * throttled tail costs one small follow-up instead of a full replay, and each round moves to the
 * next endpoint — a retry against the provider that just throttled us is the least likely request
 * to succeed.
 */
export async function batchCall(calls: RpcCall[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const out: CallResult[] = calls.map(() => UNAVAILABLE);
  let pending = calls.map((_, index) => index);

  for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
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

/**
 * `logIndex` is the position within the BLOCK, which is what makes (txHash, logIndex) a unique key.
 * A stored scan needs one: a transaction can emit the same event twice — a round paying two basket
 * entries emits two `Distributed` logs — and deduping on the tuple's contents would silently drop
 * the second.
 */
export type Log = { address: string; topics: string[]; data: string; blockNumber: number; logIndex: number; timestamp: number; transactionHash: string };

/** Hex or decimal, and absent on a node that omits it. Never throws on a blank. */
const toNumber = (value: unknown) => {
  try { return Number(BigInt(String(value ?? "0") || "0")); } catch { return 0; }
};

/**
 * Logs from Etherscan's V2 API, when a key is configured.
 *
 * WHY A SECOND SOURCE AT ALL. A public Base endpoint refuses an `eth_getLogs` covering more than
 * 10,000 blocks, so reading a contract's whole history means walking it in chunks — and the number
 * of chunks grows with the contract's AGE, forever. Measured against the index factory: one request
 * the week it was deployed, 137 a month later, 1,660 after a year. Every one of them for history
 * that has not changed since the last time it was asked for.
 *
 * Etherscan has no range cap. The same history is one request, whatever the range: `fromBlock=0` to
 * the head answered for the vault's entire life in a single call. What it will not do is take more
 * than one address, which `eth_getLogs` will — so the cost moves from "grows with time" to "grows
 * with how many contracts we watch", and the second is a number that changes slowly and on purpose.
 *
 * Returns null when the explorer cannot answer, so the caller falls back to the chunked path rather
 * than reporting an empty history. "No records found" is NOT that case: it is a real, empty answer.
 */
const EXPLORER = "https://api.etherscan.io/v2/api";
const EXPLORER_KEY = process.env.ETHERSCAN_API_KEY;
/** The API's own page size. A contract busier than this is paged, not truncated. */
const EXPLORER_PAGE = 1_000;
/** Below this many chunks the public RPC is measurably quicker; above it, it stops being bounded. */
const EXPLORER_FROM_CHUNKS = Math.max(1, Number(process.env.BASE_RPC_EXPLORER_AFTER) || 4);

async function explorerLogs(
  addresses: string[],
  topics: (string | null)[],
  fromBlock: number,
  toBlock: number,
): Promise<Log[] | null> {
  if (!EXPLORER_KEY) return null;
  const collected: Log[] = [];

  for (const address of addresses) {
    for (let page = 1; page <= 50; page++) {
      const query = new URLSearchParams({
        chainid: "8453",
        module: "logs",
        action: "getLogs",
        address,
        fromBlock: String(fromBlock),
        toBlock: String(toBlock),
        page: String(page),
        offset: String(EXPLORER_PAGE),
        apikey: EXPLORER_KEY,
      });
      // Only topic0 is worth passing: everything else this app filters on is cheaper to do here
      // than to encode, and a wrong topic slot silently returns nothing.
      if (typeof topics[0] === "string") query.set("topic0", topics[0]);

      let payload: { status?: string; message?: string; result?: unknown };
      try {
        const response = await fetch(`${EXPLORER}?${query}`, { cache: "no-store" });
        if (!response.ok) return null;
        payload = await response.json() as typeof payload;
      } catch {
        return null;
      }

      if (!Array.isArray(payload.result)) {
        // An empty window is an answer; anything else means we did not get one.
        if (payload.status === "0" && /no records found/i.test(String(payload.message ?? ""))) break;
        return null;
      }

      for (const entry of payload.result as Array<Record<string, unknown>>) {
        collected.push({
          address: String(entry.address ?? ""),
          topics: Array.isArray(entry.topics) ? entry.topics as string[] : [],
          data: String(entry.data ?? "0x"),
          blockNumber: toNumber(entry.blockNumber),
          logIndex: toNumber(entry.logIndex),
          // Etherscan spells it `timeStamp`, and always sends it — so dating a row costs nothing.
          timestamp: toNumber(entry.timeStamp),
          transactionHash: String(entry.transactionHash ?? ""),
        });
      }
      if (payload.result.length < EXPLORER_PAGE) break;
    }
  }

  return collected;
}

/**
 * Logs for one or more addresses over an explicit block range.
 *
 * Served by the explorer above when a key is set, and walked in `SPAN`-sized requests when not.
 *
 * THE SPAN IS A REQUEST SIZE, NOT A HORIZON. Public endpoints cap what one `eth_getLogs` may cover
 * — `mainnet.base.org` refuses a range over 10,000 blocks outright, and publicnode calls anything
 * that old an archive request and asks for a token — so a wide range is walked in chunks rather
 * than refused. The caller decides how far back to go; this decides how much to ask for at a time.
 *
 * Returns NULL when no endpoint would serve the range, which is not the same answer as an empty
 * array. Collapsing the two is how a ledger that could not be read renders as a ledger with nothing
 * in it — the caller has to be able to tell "the vault emitted nothing" from "nobody would say".
 */
export async function getLogs(
  /**
   * One address, or many. `eth_getLogs` takes an array here, and using it matters: a service with a
   * dozen contracts to watch is one chunked scan rather than a dozen, so the request count follows
   * the block range instead of multiplying by however many contracts exist.
   */
  address: string | string[],
  topics: (string | null)[],
  fromBlock: number,
  toBlock: number,
): Promise<Log[] | null> {
  const SPAN = Math.max(1, Number(process.env.BASE_RPC_LOG_SPAN) || 9_500);
  const addresses = Array.isArray(address) ? address : [address];
  if (addresses.length === 0) return [];

  /**
   * The explorer only once the range is wide enough to be worth it.
   *
   * Measured on the vault's own history: ten chunks over the public RPC took 220ms, the same window
   * from the explorer one request and 757ms. Per request the explorer is slower, and for a top-up
   * covering minutes of blocks the chunked path is simply better. What it cannot do is stay bounded
   * — that same walk is 137 requests after a month and 1,660 after a year, and there the single slow
   * request wins by any measure.
   *
   * So: narrow ranges keep the fast path, wide ones stop growing. A null from the explorer means it
   * would not answer, and the chunked walk below still can.
   */
  const chunksNeeded = Math.ceil((toBlock - fromBlock + 1) / SPAN);
  if (chunksNeeded > EXPLORER_FROM_CHUNKS) {
    const viaExplorer = await explorerLogs(addresses, topics, fromBlock, toBlock);
    if (viaExplorer !== null) return viaExplorer;
  }

  for (const rpc of RPCS) {
    const collected: Log[] = [];
    let ok = true;

    for (let start = fromBlock; start <= toBlock && ok; start += SPAN) {
      const end = Math.min(start + SPAN - 1, toBlock);
      try {
        const response = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "eth_getLogs",
            params: [{ address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }],
          }),
        });
        const payload = await response.json() as { result?: unknown[]; error?: unknown };
        // A range or archive refusal means this endpoint cannot serve the window at all; move on
        // rather than returning a partial history that would read as a complete one.
        if (!response.ok || payload.error || !Array.isArray(payload.result)) { ok = false; break; }
        for (const entry of payload.result as Array<Record<string, unknown>>) {
          collected.push({
            address: String(entry.address ?? ""),
            topics: Array.isArray(entry.topics) ? entry.topics as string[] : [],
            data: String(entry.data ?? "0x"),
            blockNumber: toNumber(entry.blockNumber),
            logIndex: toNumber(entry.logIndex),
            // op-geth serves `blockTimestamp` on every log, so dating a row costs no extra call.
            // Defaulted rather than required: it is an extension, and a node that omits it should
            // cost a date, not the row.
            timestamp: toNumber(entry.blockTimestamp),
            transactionHash: String(entry.transactionHash ?? ""),
          });
        }
      } catch {
        ok = false;
      }
    }

    if (ok) return collected;
  }
  return null;
}

/** Latest block height, or null when no endpoint answers. */
export async function blockNumber(): Promise<number | null> {
  for (const rpc of RPCS) {
    try {
      const response = await fetch(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const payload = await response.json() as { result?: string };
      if (typeof payload.result === "string") return Number(BigInt(payload.result));
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

const wordOf = (result: CallResult) => (result.state === "ok" ? result.data ?? null : null);

export const toBigInt = (result: CallResult) => {
  const word = wordOf(result);
  if (!word || word === "0x") return null;
  try { return BigInt(word); } catch { return null; }
};

/** The low 20 bytes of a word, as a checksum-free address. */
export const toAddress = (result: CallResult) => {
  const word = wordOf(result);
  return word && word.length >= 66 ? `0x${word.slice(-40)}` : null;
};

/** Decode a solidity `string` return (offset, length, bytes) without pulling in an ABI decoder. */
export function decodeString(result: CallResult): string | undefined {
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
