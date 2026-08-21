import { head, put } from "@vercel/blob";

import { cached } from "./cache";
import { blockNumber } from "./rpc";
import { scanCycles, type Cycle } from "./vault";

/**
 * The settled-cycle ledger, kept rather than re-derived.
 *
 * WHY THIS EXISTS. A settled cycle is immutable — its holder count, its purchases and its
 * settlement transaction are fixed the moment the block lands. Reading the chain for them on every
 * render therefore spent an `eth_getLogs` per visitor to compute an answer that could not have
 * changed, and bought only what a public endpoint would serve in one request: about five hours.
 * Cycles older than that were not missing from the page by design, they were simply out of reach.
 *
 * So each block range is walked exactly ONCE, ever. `lastBlock` is the cursor; everything below it
 * has been decoded and is in `cycles`. The chain is asked only about what lies above it, which is
 * whatever has happened since the previous ingest — minutes of blocks, not hours.
 *
 * WHY A BLOB AND NOT A DATABASE. The whole ledger is one append-only list with no query beyond
 * "give me a page of it". At hourly cadence that is ~8,800 rows a year, a few megabytes — a single
 * JSON document the CDN can hold. A table would buy indexes and joins nothing here would use.
 */
const PATHNAME = "ledger/cycles.json";
const VERSION = 1;

/**
 * Where the cursor starts when the ledger is empty — the vault's own deploy block.
 *
 * This is what makes the backfill automatic rather than a migration someone has to remember: the
 * first ingest finds no cursor, starts here, and walks the entire history in chunked requests. Set
 * it WRONG-LOW and the first ingest wastes requests on blocks predating the contract; leave it
 * unset and the ledger begins at whenever the first ingest happened to run, losing everything
 * before it with no error to notice.
 */
const DEPLOY_BLOCK = Math.max(0, Number(process.env.VAULT_DEPLOY_BLOCK) || 0);

/** A cycle plus the two things only the ledger can know: its ordinal, and that it is settled. */
export type StoredCycle = Cycle & {
  /** 1-based, absolute, assigned once. The first cycle the vault ever settled is #1 forever. */
  n: number;
};

export type Ledger = {
  version: number;
  /** Every block up to and including this one has been scanned. */
  lastBlock: number;
  /** Newest first — a ledger is read from the top, and page one is the page people read. */
  cycles: StoredCycle[];
  /** False when the store could not be read at all, which is not the same as having no rows. */
  available: boolean;
};

const EMPTY: Ledger = { version: VERSION, lastBlock: 0, cycles: [], available: false };

/**
 * The blob's public URL, resolved once per process.
 *
 * `addRandomSuffix` defaults to false, so the pathname fixes the URL for the life of the store and
 * a lookup that succeeded once cannot go stale. Reads then cost a plain CDN fetch, with no Blob API
 * call in the request path at all.
 */
let resolvedUrl: string | null = null;

async function ledgerUrl(): Promise<string | null> {
  if (resolvedUrl) return resolvedUrl;
  try {
    const blob = await head(PATHNAME);
    resolvedUrl = blob.url;
    return resolvedUrl;
  } catch {
    // Not written yet, or the store is unreachable. Both mean "no ledger to read".
    return null;
  }
}

/**
 * What a read of the store found — and the distinction the ingest depends on.
 *
 * "Nothing written yet" and "written, but we could not read it" look identical to a page, which is
 * why `readLedger` flattens both to unavailable. They are opposites to a WRITER: the first means
 * start from the vault's deploy block, the second means do not touch anything. Collapsing them is
 * how a transient fetch failure turns into a full re-scan of the entire chain history, ending in an
 * overwrite of a ledger that was fine.
 */
type Stored =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; ledger: Ledger };

/** The stored ledger. Cached in-process for a minute; the underlying data moves hourly. */
export function readLedger(): Promise<Ledger> {
  return cached("ledger:cycles", 60_000, loadLedger).catch(() => EMPTY);
}

async function loadLedger(): Promise<Ledger> {
  const stored = await loadStored();
  return stored.state === "ok" ? stored.ledger : EMPTY;
}

async function loadStored(): Promise<Stored> {
  const url = await ledgerUrl();
  if (!url) return { state: "missing" };

  try {
    // `cacheControlMaxAge` on the write already bounds how stale this can be; asking the CDN not to
    // hand back its own copy on top of that would defeat the point of storing it there.
    const response = await fetch(url);
    if (response.status === 404) return { state: "missing" };
    if (!response.ok) return { state: "unreadable" };
    const payload = await response.json() as Partial<Ledger>;
    if (!Array.isArray(payload.cycles) || typeof payload.lastBlock !== "number") return { state: "unreadable" };
    return {
      state: "ok",
      ledger: {
        version: payload.version ?? VERSION,
        lastBlock: payload.lastBlock,
        cycles: payload.cycles,
        available: true,
      },
    };
  } catch {
    return { state: "unreadable" };
  }
}

export type IngestResult = {
  added: number;
  total: number;
  fromBlock: number;
  toBlock: number;
};

/**
 * Walk the chain from the cursor to the head, append whatever settled, move the cursor.
 *
 * SELF-HEALING BY CONSTRUCTION, which is what lets a single announcer be enough. The scan starts at
 * the stored cursor rather than at the block being announced, so a notification that never arrived
 * — the site mid-deploy, the keeper restarted, a network blip — is not a hole in the ledger. It is
 * simply picked up by the next one, whose range still begins where the last successful ingest
 * ended. Nothing is lost until nothing announces at all.
 */
export async function ingestCycles(fromOverride?: number): Promise<IngestResult> {
  const found = await loadStored();
  // Refused, not rebuilt. Everything below is written on the assumption that the cursor reflects
  // what is already stored, and a ledger we could not read is one we cannot make that claim about.
  if (found.state === "unreadable") throw new Error("the stored ledger exists but could not be read");
  const stored = found.state === "ok" ? found.ledger : EMPTY;

  // `tip`, not `head`: this module already imports Blob's `head`, and shadowing it here would make
  // the next edit in this function a puzzle.
  const tip = await blockNumber();
  if (tip === null) throw new Error("no endpoint would report the chain head");

  const cursor = found.state === "ok" ? stored.lastBlock : 0;
  /**
   * Refused rather than started from genesis.
   *
   * With no cursor and no `VAULT_DEPLOY_BLOCK`, `from` was 0 — and a backfill from block 0 is one
   * `eth_getLogs` per 9,500 blocks over the whole of Base whenever the explorer cannot answer:
   * thousands of requests to find the first cycle, every one of them for blocks that predate the
   * contract. The variable is a required input, not a tunable, so an ingest without it stops and
   * says which one is missing instead of quietly running that.
   */
  if (fromOverride === undefined && cursor === 0 && DEPLOY_BLOCK === 0) {
    throw new Error("VAULT_DEPLOY_BLOCK is unset, so there is no block to backfill the ledger from");
  }
  const from = fromOverride ?? (cursor > 0 ? cursor + 1 : DEPLOY_BLOCK);
  if (from > tip) return { added: 0, total: stored.cycles.length, fromBlock: from, toBlock: tip };

  const scanned = await scanCycles(from, tip);
  if (scanned === null) throw new Error(`no endpoint would serve logs for ${from}..${tip}`);

  // Dedupe by settlement transaction, not by block: a re-scanned range must not double-count, and
  // `fromOverride` exists precisely so a range CAN be re-scanned to repair a bad decode.
  const seen = new Set(stored.cycles.map((cycle) => cycle.txHash.toLowerCase()));
  const fresh = scanned.filter((cycle) => !seen.has(cycle.txHash.toLowerCase()));

  // Numbered from the highest ordinal already assigned, so an existing row's number never moves
  // under a reader who bookmarked it.
  let next = stored.cycles.reduce((max, cycle) => Math.max(max, cycle.n), 0);
  const added: StoredCycle[] = fresh.map((cycle) => ({ ...cycle, n: (next += 1) }));

  const cycles = [...added, ...stored.cycles].sort((a, b) => b.blockNumber - a.blockNumber);

  await put(PATHNAME, JSON.stringify({ version: VERSION, lastBlock: tip, cycles }), {
    access: "public",
    allowOverwrite: true,
    // The floor the API allows, and it matches the page's own revalidate: a row that settled a
    // minute ago is not worth a cache miss for every reader who arrives in that minute.
    cacheControlMaxAge: 60,
    contentType: "application/json",
  });

  return { added: added.length, total: cycles.length, fromBlock: from, toBlock: tip };
}
