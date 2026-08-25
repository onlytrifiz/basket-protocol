import "server-only";

/**
 * Per-IP sliding window.
 *
 * Every quote and every order costs us a call to the supplier, against our
 * Partner ID. Without a limit a single script can burn that quota, get the
 * account throttled, and take the shop down with it.
 *
 * This is in-memory, so the window is per server instance rather than global —
 * with several instances the effective limit is a multiple of what is set here.
 * That is enough to stop one client hammering us, which is the realistic abuse;
 * a distributed limiter (Upstash Redis) is the upgrade if that stops being true.
 */
type Hit = { count: number; resetAt: number };

const buckets = new Map<string, Hit>();
let lastSweep = 0;

/** Drops expired buckets so the map cannot grow without bound. */
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hit] of buckets) {
    if (hit.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
};

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const hit = buckets.get(key);
  if (!hit || hit.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }

  hit.count += 1;
  const retryAfter = Math.ceil((hit.resetAt - now) / 1000);
  if (hit.count > limit) return { ok: false, remaining: 0, retryAfter };
  return { ok: true, remaining: limit - hit.count, retryAfter };
}

/** Client identity for limiting. Falls back to a shared bucket if unknown. */
export function clientKey(req: Request): string {
  const h = req.headers;
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    h.get("cf-connecting-ip");
  return ip || "unknown";
}

export function tooMany(result: RateLimitResult, message: string) {
  return Response.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfter),
        "Cache-Control": "no-store",
      },
    },
  );
}
