import { createHash, timingSafeEqual } from "node:crypto";

import { ingestCycles } from "../../../lib/ledger";
import { apiError } from "../shared";

/**
 * Announce that something settled, so the ledger walks the blocks since it last looked.
 *
 * THE KEEPER IS THE ONLY CALLER because it is the only actor: it buys the stock, opens the cycle
 * and pays the batches, so nothing settles without it knowing. That makes a schedule redundant —
 * polling on a timer would ask the chain the same question hundreds of times a day to catch an
 * event the one party who caused it could simply report.
 *
 * WHAT IT DOES NOT TRUST is the caller's account of what happened. The body is a notification, not
 * a record: the route re-reads the range from the chain and decodes it itself. A keeper that lied,
 * or announced twice, or announced a cycle it aborted, changes nothing — only what the vault
 * actually emitted reaches the ledger.
 *
 * `from` re-scans an explicit range. That is the repair tool: a decoder fix ships, the range is
 * replayed, and the dedupe keeps everything already stored.
 */
export const dynamic = "force-dynamic";

const SECRET = process.env.CYCLES_INGEST_SECRET;

/**
 * Compared in constant time, and through a digest so the lengths always match.
 *
 * `!==` on a secret leaks how much of it was right in how long it took to say no, and
 * `timingSafeEqual` refuses two buffers of different sizes — which would leak the length instead.
 * Hashing both first makes every comparison 32 bytes against 32 bytes, whatever was offered.
 */
const digest = (value: string) => createHash("sha256").update(value).digest();
const isTheSecret = (offered: string, secret: string) => timingSafeEqual(digest(offered), digest(secret));

export async function POST(request: Request) {
  // No secret configured means no ingest, never an open one. An unauthenticated writer here does
  // not corrupt the ledger — the chain is still the source — but it does hand anyone a lever on the
  // site's RPC budget.
  if (!SECRET) return apiError("Ingest is not configured.", 503);

  const offered = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!offered || !isTheSecret(offered, SECRET)) return apiError("Not authorised.", 401);

  const body = await request.json().catch(() => ({})) as { from?: unknown };
  const from = typeof body.from === "number" && Number.isSafeInteger(body.from) && body.from >= 0
    ? body.from
    : undefined;

  try {
    const result = await ingestCycles(from);
    console.log(`[cycles] ${result.fromBlock}..${result.toBlock}: +${result.added}, ${result.total} total`);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Reported rather than swallowed: the keeper logs it, and the next announcement starts from the
    // same cursor, so a failure here delays the ledger instead of putting a hole in it.
    return apiError((error as Error).message, 502);
  }
}
