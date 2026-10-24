import { parseAbi, type Address, type PublicClient } from "viem";

import { erc20Abi, lockerAbi, lockerV2Abi, treasuryAbi } from "./abi.js";
import { IDLE_RECHECKS_PER_PASS, IDLE_RECHECK_SEC, LAUNCH_FEE_TIER, V3_FACTORY, ZERO } from "./config.js";
import { KIND_FEE_OWNER_LOCKER, type Launchpad } from "./launchpads.js";

/**
 * Which treasuries can sit a pass out — and the proof that they can.
 *
 * A pass walks every treasury the factory has ever minted, one after another, at roughly a second
 * apiece, and most of them have nothing to do: a launch that never traded leaves an index whose every
 * pass reads the same state and reaches the same "holding". That costs nothing per treasury and a
 * great deal in total, because the walk is sequential — the pass grows by a second for every index
 * that will never act, and every live round waits behind all of them.
 *
 * So a treasury is skipped when two things are both true, and only then:
 *
 *   1. ITS LAST RUN PROVED IT IDLE. Not "sent nothing" — a run that failed to buy also sends nothing.
 *      Idle is a small set of named endings in `runIndex` (paused; nothing ready; ready with nothing
 *      bought and nothing due; a buyback with nothing to burn), and anything the run tried to do on
 *      the way — a harvest, a buy over its floor, an open round, a missing exclusion, a transaction,
 *      a failure — vetoes it. The default is busy; idle has to be earned.
 *
 *   2. NOTHING IT DEPENDS ON HAS MOVED SINCE. The fingerprint is everything on-chain that can turn an
 *      idle treasury into a busy one: its pool's fee growth (fees only accrue on a swap), its own
 *      quote and coin balances and spendable quote (anything paid in, by a harvest, a fee seller or
 *      a donation), its pause flag, and each basket entry's pending amount and readyAt. Read for every
 *      treasury in a handful of multicalls at the start of a pass.
 *
 * Time is handled separately, because the chain does not move for it: a round that comes due is
 * run at its readyAt, and every skipped treasury is still re-run at least every IDLE_RECHECK_SEC —
 * the one thing the fingerprint cannot see is a PRICE, and a balance held under a dollar floor can
 * cross it without a single state change.
 *
 * Memory is per process. A restart forgets it, so the first pass after boot runs everything, as the
 * keeper always has.
 */

// ─────────────────────────────────────────────────────────────────────── the trace of one run

export type Trace = { idleExit: boolean; busy: string[]; nextReadyAt: number | null };
let current: Trace | null = null;

export function beginTrace(): Trace {
  current = { idleExit: false, busy: [], nextReadyAt: null };
  return current;
}

export function endTrace() {
  current = null;
}

/** Something was done, attempted or left pending: whatever the run ends in, it was not idle. */
export function markBusy(reason: string) {
  if (current && !current.busy.includes(reason)) current.busy.push(reason);
}

/** The run reached one of the endings that mean "nothing to do until something changes". */
export function markIdleExit() {
  if (current) current.idleExit = true;
}

/** A round of this treasury comes due at `at`; a skip must not outlive it. */
export function traceReady(at: number) {
  if (current && (current.nextReadyAt === null || at < current.nextReadyAt)) current.nextReadyAt = at;
}

export const wasIdle = (t: Trace, threw: boolean) => !threw && t.idleExit && t.busy.length === 0;

/**
 * The two busy reasons that come from the PRICE SOURCE rather than from the chain. When a price
 * lookup fails the keeper deliberately acts without a dollar gate — harvests, or buys over a
 * token-sized floor — so a treasury whose state has not moved can still produce a different answer
 * from one pass to the next. A skip in that case spares an action on dust the keeper would have
 * refused had the price arrived. Kept distinct so shadow mode can report it apart from a real miss.
 */
export const UNPRICED_HARVEST = "fees unpriced (harvesting without a dollar floor)";
export const UNPRICED_BUY = "a slice over its unpriced buy floor";
const PRICE_ONLY = new Set([UNPRICED_HARVEST, UNPRICED_BUY]);

/** The run was busy ONLY for price-source reasons — never true of a run that threw or ended busy otherwise. */
export const onlyPriceNoise = (t: Trace, threw: boolean) =>
  !threw && t.idleExit && t.busy.length > 0 && t.busy.every((r) => PRICE_ONLY.has(r));

// ─────────────────────────────────────────────────────────────────────── memory and the plan

type Memory = { fp: string | null; idle: boolean; nextReadyAt: number | null; ranAt: number };
const memory = new Map<string, Memory>();

/** Record what a run found, against the fingerprint read BEFORE it: a state change during the run
 *  then shows up as a difference next pass, which errs toward running again. */
export function remember(treasury: Address, fp: string | null, idle: boolean, nextReadyAt: number | null, at: number) {
  memory.set(treasury.toLowerCase(), { fp, idle, nextReadyAt, ranAt: at });
}

export type Plan = { fp: string | null; skip: boolean; nextReadyAt: number | null };

export function plan(
  treasuries: readonly Address[],
  fps: Map<string, string | null>,
  nowSec: number
): { plans: Map<string, Plan>; rechecked: number } {
  const plans = new Map<string, Plan>();
  const overdue: { key: string; ranAt: number }[] = [];

  for (const t of treasuries) {
    const key = t.toLowerCase();
    const fp = fps.get(key) ?? null;
    const mem = memory.get(key);
    const quiet =
      mem !== undefined &&
      mem.idle &&
      fp !== null &&
      mem.fp === fp &&
      (mem.nextReadyAt === null || nowSec < mem.nextReadyAt);
    plans.set(key, { fp, skip: quiet, nextReadyAt: mem?.nextReadyAt ?? null });
    if (quiet && nowSec - mem!.ranAt >= IDLE_RECHECK_SEC) overdue.push({ key, ranAt: mem!.ranAt });
  }

  // The longest-unchecked first, a bounded number per pass: everything booted in the same pass would
  // otherwise come due in the same pass, and one slow pass every few hours is the thing this avoids.
  overdue.sort((a, b) => a.ranAt - b.ranAt);
  const take = overdue.slice(0, Math.max(0, IDLE_RECHECKS_PER_PASS));
  for (const o of take) plans.get(o.key)!.skip = false;
  return { plans, rechecked: take.length };
}

// ─────────────────────────────────────────────────────────────────────── fingerprints

const poolAbi = parseAbi([
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
]);
const multicall3Abi = parseAbi(["function getEthBalance(address) view returns (uint256)"]);
const v3FactoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);

/** Immutable per treasury once bound, so resolved once per process — and only cached when known. */
type Static = { coin: Address; pool: Address; basketLen: number };
const statics = new Map<string, Static>();

/** The pool a coin trades in, read off its launchpad the way `liquidityHolders` reads it. Null when
 *  it cannot be told, which leaves that treasury running every pass. */
async function launchPool(client: PublicClient, pad: Launchpad, coin: Address): Promise<Address | null> {
  if (pad.kind === KIND_FEE_OWNER_LOCKER) {
    const tokenId = (await client.readContract({
      address: pad.registry, abi: lockerV2Abi, functionName: "positionOf", args: [coin],
    })) as bigint;
    if (tokenId === 0n) return null;
    const info = (await client.readContract({
      address: pad.registry, abi: lockerV2Abi, functionName: "positionsInfo", args: [tokenId],
    })) as [Address, Address, Address, number, boolean, boolean];
    return info[2] && info[2] !== ZERO ? info[2] : null;
  }
  const quoteAsset = (await client.readContract({
    address: pad.registry, abi: lockerAbi, functionName: "tokenQuote", args: [coin],
  })) as Address;
  if (!quoteAsset || quoteAsset === ZERO) return null;
  const pool = (await client.readContract({
    address: V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [coin, quoteAsset, LAUNCH_FEE_TIER],
  })) as Address;
  return pool && pool !== ZERO ? pool : null;
}

const MODE_BUYBACK = 1;
/**
 * Multicall windows, in bytes of inner calldata (viem's measure). The head reads are 4-byte calls,
 * so a 16 KB window would pack ~4,000 of them into one `eth_call` — at thousands of treasuries that
 * is ~40M gas, too close to a node's eth_call cap. 4 KB keeps it near 1,000 calls; the state reads
 * carry an address argument each, so the wider window holds a similar count.
 */
const HEADS_BATCH = 4_096;
const STATE_BATCH = 16_384;

/**
 * One fingerprint per treasury, or null where one could not be read in full — and null always means
 * "run it". Never throws: a failure here must cost the optimisation, not the pass.
 */
export async function readFingerprints(
  client: PublicClient,
  treasuries: readonly Address[],
  padFor: (treasury: Address) => Promise<Launchpad | null>,
  multicall3: Address
): Promise<Map<string, string | null>> {
  const fps = new Map<string, string | null>();
  try {
    const heads = await client.multicall({
      allowFailure: true,
      batchSize: HEADS_BATCH,
      contracts: treasuries.flatMap((t) => [
        { address: t, abi: treasuryAbi, functionName: "coin" },
        { address: t, abi: treasuryAbi, functionName: "paused" },
        { address: t, abi: treasuryAbi, functionName: "mode" },
        { address: t, abi: treasuryAbi, functionName: "quote" },
        { address: t, abi: treasuryAbi, functionName: "spendableQuote" },
      ] as const),
    });

    type Head = { t: Address; coin: Address; paused: boolean; mode: number; quote: Address; spendable: bigint };
    const bound: Head[] = [];
    treasuries.forEach((t, i) => {
      const r = heads.slice(i * 5, i * 5 + 5);
      fps.set(t.toLowerCase(), null);
      if (r.some((x) => x.status !== "success")) return;
      const coin = r[0].result as Address;
      // Unbound: its run is the bind attempt, which is never skipped.
      if (!coin || coin === ZERO) return;
      bound.push({
        t, coin, paused: r[1].result as boolean, mode: Number(r[2].result), quote: r[3].result as Address,
        spendable: r[4].result as bigint,
      });
    });

    // Statics for the ones seen for the first time, a few dozen at a time so the reads batch.
    const unknown = bound.filter((h) => statics.get(h.t.toLowerCase())?.coin !== h.coin);
    for (let i = 0; i < unknown.length; i += 50) {
      await Promise.all(
        unknown.slice(i, i + 50).map(async (h) => {
          try {
            const pad = await padFor(h.t);
            if (!pad) return;
            const pool = await launchPool(client, pad, h.coin);
            if (!pool) return;
            const basketLen = h.mode === MODE_BUYBACK
              ? 0
              : ((await client.readContract({ address: h.t, abi: treasuryAbi, functionName: "basketAll" })) as [
                  Address[],
                  number[],
                ])[0].length;
            statics.set(h.t.toLowerCase(), { coin: h.coin, pool, basketLen });
          } catch {
            // Not cached: asked again next pass, and this treasury runs meanwhile.
          }
        })
      );
    }

    const known = bound.filter((h) => statics.get(h.t.toLowerCase())?.coin === h.coin);
    const calls = known.map((h) => {
      const s = statics.get(h.t.toLowerCase())!;
      return [
        { address: s.pool, abi: poolAbi, functionName: "feeGrowthGlobal0X128" },
        { address: s.pool, abi: poolAbi, functionName: "feeGrowthGlobal1X128" },
        { address: h.coin, abi: erc20Abi, functionName: "balanceOf", args: [h.t] },
        h.quote === ZERO
          ? { address: multicall3, abi: multicall3Abi, functionName: "getEthBalance", args: [h.t] }
          : { address: h.quote, abi: erc20Abi, functionName: "balanceOf", args: [h.t] },
        ...Array.from({ length: s.basketLen }, (_, k) => ({
          address: h.t, abi: treasuryAbi, functionName: "pending", args: [BigInt(k)],
        })),
      ];
    });
    // Heterogeneous calls (pools, tokens, the treasury, Multicall3 itself), so typed by hand.
    const res = (await client.multicall({ allowFailure: true, batchSize: STATE_BATCH, contracts: calls.flat() } as never)) as {
      status: "success" | "failure";
      result?: unknown;
    }[];

    let at = 0;
    known.forEach((h, i) => {
      const part = res.slice(at, at + calls[i].length);
      at += calls[i].length;
      if (part.some((x) => x.status !== "success")) return;
      const values = [h.coin, h.paused, h.mode, h.quote, h.spendable, ...part.map((x) => x.result)];
      fps.set(h.t.toLowerCase(), JSON.stringify(values, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    });
  } catch (e) {
    console.error(`  fingerprints unread (${(e as Error).message.split("\n")[0]}) — running every index this pass`);
    for (const t of treasuries) fps.set(t.toLowerCase(), null);
  }
  return fps;
}
