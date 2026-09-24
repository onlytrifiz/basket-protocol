import type { Address, PublicClient } from "viem";

import { factoryAbi, lockerAbi, lockerV2Abi, v3FactoryAbi } from "./abi.js";
import { FACTORY, LAUNCH_FEE_TIER, POSITION_MANAGER, V3_FACTORY, ZERO } from "./config.js";

/**
 * The launchpads a treasury may collect for — read from the factory, never configured here.
 *
 * The factory keeps a REGISTRY, and the treasuries resolve it on every harvest, so a locker that is
 * superseded moves every basket at once with a single write. A keeper holding its own copy of that
 * address would quietly disagree with the contracts the day it changed, which is the failure this
 * module exists to make impossible: there is nowhere left to put a stale locker.
 */
export type Launchpad = { id: number; registry: Address; kind: number; enabled: boolean };

/** StonkFeeLocker2: a creator role, a list of positions, `collectAll`. */
export const KIND_CREATOR_LOCKER = 0;
/** StonksExchangeFeeLockerV2: a fee-owner role, ONE position per coin, `collect`. */
export const KIND_FEE_OWNER_LOCKER = 1;

/**
 * Re-read once a cycle rather than cached for the process.
 *
 * `setLaunchpad` is rare but it is the lever that repoints every live treasury, so a keeper that
 * only read it at boot would keep cranking the old registry until someone restarted it — and a
 * restart is exactly what nobody does while things look like they are working.
 */
const TTL_MS = Number(process.env.LAUNCHPADS_TTL_MS ?? "300000");
let cache: { at: number; pads: Launchpad[] } | null = null;

export async function launchpads(client: PublicClient): Promise<Launchpad[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.pads;

  const ids = (await client.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "launchpadList",
  })) as readonly number[];

  const rows = await client.multicall({
    contracts: ids.map((id) => ({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "launchpads",
      args: [id],
    })),
    allowFailure: false,
  });

  const pads = rows.map((row, i) => {
    const [registry, kind, enabled] = row as unknown as [Address, number, boolean];
    return { id: Number(ids[i]), registry, kind, enabled };
  });
  cache = { at: Date.now(), pads };
  return pads;
}

/** The launchpad a bound treasury collects from, or null when the factory no longer lists it. */
export async function launchpadById(client: PublicClient, id: number): Promise<Launchpad | null> {
  return (await launchpads(client)).find((p) => p.id === id) ?? null;
}

/**
 * Addresses that hold a coin without being holders in any sense a payout should honour.
 *
 * Getting this wrong does not fail, it PAYS — a round's equity goes to a pool or a locker instead of
 * to the people the programme exists for, and nothing in the logs looks wrong. So each shape
 * answers for its own:
 *
 *   kind 0 — the launch pool, derived from the coin, its quote and the launchpad's fixed 1% tier,
 *            plus the Uniswap position manager that custodies every launch's whole supply.
 *
 *   kind 1 — the pool comes out of the position record verbatim, which is better than deriving it:
 *            Slipstream keys pools on tick spacing, and the V2 launcher opens at three of them.
 *            THE LOCKER IS ALSO EXCLUDED, and that one is specific to V2: under `quoteOnly` it
 *            holds the fee owner's whole coin leg until a platform keeper converts it, so it can
 *            carry a large balance of a coin it is merely custodying.
 *
 * NULL MEANS "COULD NOT TELL", and it is not the same as an empty list. A rate-limited node returns
 * the same nothing as a coin with no pool, and the two deserve opposite treatment: one is a reason
 * to try again, the other is an answer. Measured on Base's public endpoint this fires on roughly
 * one call in three, so the distinction is not theoretical — callers act on it.
 */
export async function liquidityHolders(
  client: PublicClient,
  pad: Launchpad,
  coin: Address
): Promise<Address[] | null> {
  /**
   * Asked again before giving up, because giving up is expensive here.
   *
   * Null makes the caller wait — exclusions retry, and a payout skips its round rather than pay a
   * pool. That is the right way to be wrong about a custodian, but it means a single flaky read
   * costs a whole cycle, and on a busy endpoint a single flaky read is ordinary: measured against
   * Base's public RPC this call answered three times and then failed twice in a row. A treasury can
   * sit unable to pay while nothing at all is wrong with it.
   *
   * Three attempts, briefly spaced. A registry that genuinely does not know the coin says so on the
   * first try and is not retried — that answer is `null` from inside, not a throw.
   */
  for (let attempt = 1; ; attempt++) {
    const answer = await attempt_(client, pad, coin);
    if (answer !== THREW) return answer;
    if (attempt >= 3) return null;
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
}

/** Distinguishes "the read blew up" from "the registry answered, and the answer is nothing". */
const THREW = Symbol("threw");

async function attempt_(
  client: PublicClient,
  pad: Launchpad,
  coin: Address
): Promise<Address[] | null | typeof THREW> {
  try {
    if (pad.kind === KIND_FEE_OWNER_LOCKER) {
      const tokenId = (await client.readContract({
        address: pad.registry,
        abi: lockerV2Abi,
        functionName: "positionOf",
        args: [coin],
      })) as bigint;
      /**
       * The registry does not know this coin — so this is the WRONG REGISTRY, not a coin without a
       * pool, and answering "no custodians" would be answering a question that was never asked.
       * Null, so the caller waits and asks again.
       */
      if (tokenId === 0n) return null;

      const info = (await client.readContract({
        address: pad.registry,
        abi: lockerV2Abi,
        functionName: "positionsInfo",
        args: [tokenId],
      })) as [Address, Address, Address, number, boolean, boolean];
      const pool = info[2];
      return pool && pool !== ZERO ? [pool, pad.registry] : [pad.registry];
    }

    const quoteAsset = (await client.readContract({
      address: pad.registry,
      abi: lockerAbi,
      functionName: "tokenQuote",
      args: [coin],
    })) as Address;
    // Same reasoning as the V2 branch above: a registry that does not recognise the coin is being
    // asked about somebody else's launch, and its silence is not a fact about this one.
    if (!quoteAsset || quoteAsset === ZERO) return null;

    const pool = (await client.readContract({
      address: V3_FACTORY,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [coin, quoteAsset, LAUNCH_FEE_TIER],
    })) as Address;

    return pool && pool !== ZERO ? [pool, POSITION_MANAGER] : [POSITION_MANAGER];
  } catch {
    return THREW;
  }
}
