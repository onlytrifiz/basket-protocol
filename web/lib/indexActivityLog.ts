import { head, put } from "@vercel/blob";

import { blockNumber, getLogs, type Log } from "./rpc";

/**
 * The stored log of everything the index treasuries have ever done.
 *
 * WHY THIS EXISTS. `readActivity` used to re-scan every treasury's ENTIRE history on each cold
 * cache — `FACTORY_BLOCK` to the chain head, on every instance, forever. Measured on the live set:
 * 163,000 blocks, 18 chunks. Served by the explorer that is one request and 1.9 seconds; served by
 * the chunked RPC walk it is 27.7 seconds, and the page took exactly that whenever the explorer
 * declined. There was no middle ground, and the range grows by ~43,000 blocks a day, so the bad
 * case gets worse on its own.
 *
 * The fix is the one the dividend ledger already uses: walk each block range exactly ONCE. What
 * lands below the cursor is decoded and kept; the chain is only ever asked about what lies above
 * it, which is minutes of blocks. That drops the steady-state scan to a single `eth_getLogs` —
 * under `EXPLORER_FROM_CHUNKS`, so the page stops depending on an explorer key at all.
 *
 * WHAT IS STORED IS RAW LOGS, not decoded events. Decoding lives with the reader in `lib/indices`,
 * so a decoder fix applies to the whole history without a re-scan — and there is exactly one place
 * that knows what a `Harvested` topic means.
 */
const PATHNAME = "ledger/indices-activity.json";
const VERSION = 1;

/** The block the factory was created in — nothing it minted can predate it. */
const FACTORY_BLOCK = Math.max(0, Number(process.env.INDEX_FACTORY_DEPLOY_BLOCK) || 50_225_995);

/**
 * How far the cursor may fall behind before a quiet poll writes anyway.
 *
 * A write on every cold render would bill a blob PUT for a scan that found nothing. Writing only
 * when something happened is the other extreme: through a quiet night the cursor stays put and each
 * cold instance re-scans a widening range, which is the problem this file exists to remove. So a
 * poll that finds nothing still commits its cursor once it has drifted about three hours of Base
 * blocks — bounding both the write rate and the scan.
 */
const STALE_BLOCKS = Math.max(1, Number(process.env.INDEX_ACTIVITY_STALE_BLOCKS) || 5_000);

/**
 * How many never-seen treasuries one request may backfill.
 *
 * A backfill covers the factory's whole life, which is wide enough to route to the explorer — and
 * the explorer takes ONE ADDRESS PER REQUEST. So the cost of this branch is linear in how many
 * addresses are new, and the day the caller stopped truncating its list to a page it went from
 * "one new treasury now and then" to 110 at once: ~82 seconds of explorer calls, comfortably past
 * the function timeout, on a request that would then have written nothing and started over.
 *
 * Bounded instead, newest first, and the cursor records only what was actually fetched. Coverage
 * converges over a handful of requests, and every one of them commits its share.
 *
 * EIGHT, because the explorer answers in ~500ms per address measured against the live factory: at
 * eight that is four seconds on the one render that does the work, and at twenty-five it was twelve.
 * Sized for the steady state rather than for a migration — treasuries appear one or two at a time,
 * so this ceiling should never be the thing that binds once coverage has caught up.
 */
const BACKFILL_LIMIT = Math.max(1, Number(process.env.INDEX_ACTIVITY_BACKFILL) || 8);

type Stored = {
  version: number;
  /** Every block up to and including this one has been scanned, for every address in `covered`. */
  lastBlock: number;
  /**
   * The treasuries the cursor actually accounts for.
   *
   * Load-bearing. `getLogs` filters by address, so a treasury created BEFORE the cursor but minted
   * after the last scan has history the cursor claims to have covered and never fetched. Recording
   * what was asked for is what lets a new address be backfilled once, on its own, instead of
   * appearing with its first rounds missing and no way to notice.
   */
  covered: string[];
  logs: Log[];
};

/** Same tri-state as the dividend ledger, for the same reason — see `loadStored` there. */
type Found = { state: "missing" } | { state: "unreadable" } | { state: "ok"; stored: Stored };

let resolvedUrl: string | null = null;

async function storeUrl(): Promise<string | null> {
  if (resolvedUrl) return resolvedUrl;
  try {
    resolvedUrl = (await head(PATHNAME)).url;
    return resolvedUrl;
  } catch {
    return null;
  }
}

async function loadStored(): Promise<Found> {
  const url = await storeUrl();
  if (!url) return { state: "missing" };
  try {
    const response = await fetch(url);
    if (response.status === 404) return { state: "missing" };
    if (!response.ok) return { state: "unreadable" };
    const payload = await response.json() as Partial<Stored>;
    if (
      typeof payload.lastBlock !== "number"
      || !Array.isArray(payload.logs)
      || !Array.isArray(payload.covered)
      || payload.version !== VERSION
    ) return { state: "unreadable" };
    return { state: "ok", stored: payload as Stored };
  } catch {
    return { state: "unreadable" };
  }
}

const key = (log: Log) => `${log.transactionHash.toLowerCase()}:${log.logIndex}`;

/**
 * Every log the given treasuries have emitted, from the factory's first block to the head.
 *
 * Returns null when no endpoint would serve the range — which is not "nothing has happened", and
 * the pages render it as unread rather than as zero.
 *
 * `keepTopics` is passed in rather than known here: the decoder owns the list of events it can
 * read, and storing a topic nothing decodes would grow the document for no reader.
 */
export async function readActivityLogs(addresses: string[], keepTopics: string[]): Promise<Log[] | null> {
  if (addresses.length === 0) return [];

  const tip = await blockNumber();
  if (tip === null) return null;

  const wanted = new Set(keepTopics.map((t) => t.toLowerCase()));
  const keep = (logs: Log[]) => logs.filter((log) => wanted.has((log.topics[0] ?? "").toLowerCase()));

  const found = await loadStored();

  /**
   * A store we could not read is not an empty store.
   *
   * Rebuilding on a transient fetch failure would overwrite a good document with whatever this one
   * request managed to see. So the read falls back to the old behaviour — a direct full scan, slow
   * but correct — and deliberately writes nothing.
   */
  if (found.state === "unreadable") {
    const logs = await getLogs(addresses, [], FACTORY_BLOCK, tip);
    return logs === null ? null : keep(logs);
  }

  const stored: Stored = found.state === "ok"
    ? found.stored
    : { version: VERSION, lastBlock: 0, covered: [], logs: [] };

  const covered = new Set(stored.covered.map((a) => a.toLowerCase()));
  const fresh: Log[] = [];

  // A treasury the cursor never asked about is backfilled on its own, once, over the range the
  // cursor already claims. Its first log cannot predate its creation, so this is one cheap request
  // per new address rather than a reason to rewind the cursor for everybody.
  //
  // Newest first: the tail of the registry is what people are looking at, and a treasury created an
  // hour ago is the one whose absent history reads as a fact about it rather than as a gap.
  const unseen = addresses.filter((a) => !covered.has(a.toLowerCase()));
  const batch = unseen.slice(-BACKFILL_LIMIT);
  if (batch.length > 0 && stored.lastBlock > FACTORY_BLOCK) {
    const backfill = await getLogs(batch, [], FACTORY_BLOCK, stored.lastBlock);
    if (backfill === null) return null;
    fresh.push(...keep(backfill));
    for (const a of batch) covered.add(a.toLowerCase());
  }

  const from = stored.lastBlock > 0 ? stored.lastBlock + 1 : FACTORY_BLOCK;
  if (from <= tip) {
    const recent = await getLogs(addresses, [], from, tip);
    if (recent === null) return null;
    fresh.push(...keep(recent));
    // A scan that starts at the factory's own block leaves nothing earlier to backfill: this one
    // pass covers every address it asked about, and saying so is what stops a rebuilt document from
    // then backfilling all of them a batch at a time over ranges it has already read.
    if (from <= FACTORY_BLOCK) for (const a of addresses) covered.add(a.toLowerCase());
  }

  const seen = new Set(stored.logs.map(key));
  const added = fresh.filter((log) => !seen.has(key(log)));
  const logs = [...stored.logs, ...added].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const grew = added.length > 0 || batch.length > 0;
  if (grew || tip - stored.lastBlock >= STALE_BLOCKS) {
    try {
      await put(
        PATHNAME,
        /**
         * `covered` is what was actually FETCHED over the cursor's range, not what was asked for.
         *
         * Writing the request list instead would mark a treasury as covered on the pass that
         * deferred it — the backfill is bounded, so most passes defer most of them — and it would
         * never be fetched again. The set only ever grows, so a deferred address stays pending
         * until some pass gets to it.
         */
        JSON.stringify({ version: VERSION, lastBlock: tip, covered: [...covered], logs } satisfies Stored),
        { access: "public", allowOverwrite: true, cacheControlMaxAge: 60, contentType: "application/json" },
      );
    } catch {
      /**
       * A failed write costs the next reader a slightly wider scan, nothing else.
       *
       * Two instances committing at once is the same: the later cursor wins, and whatever the loser
       * had scanned above it is simply found again next time. The document is append-only and
       * derived entirely from the chain, so it cannot be corrupted by losing that race.
       */
    }
  }

  return logs;
}
