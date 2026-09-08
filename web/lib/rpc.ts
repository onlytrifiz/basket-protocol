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
 * Multicall3 — the same address on Base as on nearly every chain that has one.
 *
 * WHY THIS EXISTS. A JSON-RPC batch is still N calls as far as the endpoint is concerned.
 * `BATCH_LIMIT` is ten because that is what Base's public RPC accepts, its rate limit applies PER
 * ELEMENT inside the batch, and the chunks therefore have to be paced apart. The indices hub asks
 * 100 treasuries for 7 fields each: 700 calls, 70 paced chunks, and 13.8 seconds of them measured
 * on the live site against a cold cache.
 *
 * Packed into `aggregate3` the same 700 are four `eth_call`s, because the node runs the whole array
 * inside one call and the rate limit counts one. The three states survive intact: a sub-call that
 * reverts comes back `success: false`, which is still an ANSWER and not a gap, while a chunk the
 * endpoint never served leaves every call in it unavailable for the plain path below to retry.
 *
 * Base's B20 equities are Rust precompiles rather than EVM bytecode. Verified on-chain before
 * relying on it: they answer a `staticcall` arriving from inside Multicall3 exactly as they answer
 * a top-level one, `decimals()` and `balanceOf()` both.
 */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/**
 * Sub-calls per packed request. Set to 0 or 1 to turn packing off and keep only the plain path.
 *
 * Read without the `|| default` idiom the knobs above use, because that idiom cannot express zero:
 * `Number("0") || 200` is 200, so the one value that turns the feature off would silently turn it
 * on — and an off switch that does nothing is worse than no off switch, since it is reached exactly
 * when something has gone wrong and someone is trying to rule this out.
 */
const MULTICALL_SIZE = (() => {
  const raw = process.env.BASE_RPC_MULTICALL_SIZE;
  if (raw === undefined || raw.trim() === "") return 200;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 200;
})();
const AGGREGATE3 = "0x82ad56cb";

/** `aggregate3((address target, bool allowFailure, bytes callData)[])`, encoded by hand. */
function encodeAggregate3(calls: RpcCall[]): string {
  // Each element is a dynamic tuple, so it is written in the data section and pointed at from the
  // head. Inside the tuple the `bytes` offset is relative to the TUPLE's start, not the array's.
  const bodies = calls.map((call) => {
    const data = call.data.replace(/^0x/, "");
    const length = Math.floor(data.length / 2);
    const padded = data.padEnd(Math.ceil(length / 32) * 64, "0");
    return pad(call.to) + pad("1") + pad("60") + pad(length.toString(16)) + padded;
  });

  let cursor = calls.length * 32;
  const heads: string[] = [];
  for (const body of bodies) {
    heads.push(pad(cursor.toString(16)));
    cursor += body.length / 2;
  }

  return AGGREGATE3 + pad("20") + pad(calls.length.toString(16)) + heads.join("") + bodies.join("");
}

/**
 * The `(bool success, bytes returnData)[]` that comes back.
 *
 * Returns null rather than a partial answer whenever the shape is not what was asked for: a decode
 * that guesses would hand the caller data belonging to a different call, which is worse than the
 * unavailable it would otherwise report.
 */
function decodeAggregate3(result: string, expected: number): CallResult[] | null {
  const body = result.replace(/^0x/, "");
  const word = (i: number) => body.slice(i * 64, (i + 1) * 64);
  const num = (hex: string) => {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) return NaN;
    const value = Number(BigInt(`0x${hex}`));
    return Number.isSafeInteger(value) ? value : NaN;
  };

  if (num(word(0)) !== 0x20 || num(word(1)) !== expected) return null;

  const out: CallResult[] = [];
  for (let i = 0; i < expected; i++) {
    const at = num(word(2 + i));
    if (!Number.isFinite(at) || at % 32 !== 0) return null;
    const head = 2 + at / 32;
    const success = num(word(head));
    const to = num(word(head + 1));
    if (!Number.isFinite(success) || !Number.isFinite(to) || to % 32 !== 0) return null;
    const lengthAt = head + to / 32;
    const length = num(word(lengthAt));
    if (!Number.isFinite(length)) return null;
    const data = body.slice((lengthAt + 1) * 64, (lengthAt + 1) * 64 + length * 2);
    if (data.length !== length * 2) return null;
    out.push(success === 1 ? { state: "ok", data: `0x${data}` } : { state: "reverted" });
  }
  return out;
}

/** One packed request, or null when this endpoint did not serve it in the shape it was asked. */
async function multicallOnce(calls: RpcCall[], rpc: string): Promise<CallResult[] | null> {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "eth_call",
      params: [{ to: MULTICALL3, data: encodeAggregate3(calls) }, "latest"],
    }),
    cache: "no-store",
  });
  if (!response.ok) return null;

  const payload = await response.json() as { result?: unknown };
  if (typeof payload?.result !== "string") return null;
  return decodeAggregate3(payload.result, calls.length);
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

  /**
   * One packed pass first, then the plain path for whatever it left unanswered.
   *
   * Additive on purpose. If the endpoint will not serve `aggregate3` — an old node, a gas cap, a
   * proxy that rewrites `eth_call` — the loop below runs exactly as it did before and the only cost
   * is the one attempt, which is why the first refusal breaks out instead of paying for the rest.
   */
  if (MULTICALL_SIZE > 1) {
    for (let i = 0; i < pending.length; i += MULTICALL_SIZE) {
      const slice = pending.slice(i, i + MULTICALL_SIZE);
      let packed: CallResult[] | null = null;
      try {
        packed = await multicallOnce(slice.map((index) => calls[index]), RPCS[0]);
      } catch {
        packed = null;
      }
      if (!packed) break;
      packed.forEach((result, j) => { out[slice[j]] = result; });
      if (i + MULTICALL_SIZE < pending.length) await sleep(BATCH_GAP_MS);
    }
    pending = pending.filter((index) => out[index].state === "unavailable");
  }

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
/** How long to wait between addresses, and how many times a rate-limited page is retried. */
const EXPLORER_GAP_MS = Math.max(0, Number(process.env.BASE_RPC_EXPLORER_GAP_MS) || 250);
const EXPLORER_RETRIES = Math.max(0, Number(process.env.BASE_RPC_EXPLORER_RETRIES) || 3);
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

  for (const [index, address] of addresses.entries()) {
    // Paced, because the limit is per second and this loop is the only thing in the process that
    // can trip it: one address after another, as fast as the network allows.
    if (index > 0) await sleep(EXPLORER_GAP_MS);
    let attempt = 0;
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

        /**
         * A rate limit is a "come back in a moment", not a refusal — and treating it as one is
         * expensive in a way that does not look like it.
         *
         * Etherscan answers it as `status: "0"` with the reason in `result` AS A STRING, so it lands
         * in this branch beside the real failures. Returning null here abandons the explorer for
         * EVERY address in the call, and `getLogs` then falls back to walking the same range over
         * the RPC: 86 chunks of 9,500 blocks for a backfill, which is how a cold `/indices` render
         * went from 13.8s to 42.7s the day the backfill started asking for eight addresses at once.
         *
         * So it is waited out rather than surrendered to. Three attempts, widening, and only then
         * the fallback — which is still there for the failures that really are ones.
         */
        if (/rate limit/i.test(String(payload.result ?? "")) && attempt < EXPLORER_RETRIES) {
          attempt += 1;
          await sleep(400 * attempt);
          page -= 1;
          continue;
        }
        return null;
      }
      attempt = 0;

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
