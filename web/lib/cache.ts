/**
 * A TTL cache that prefers stale data to no data.
 *
 * Next's own fetch cache does not cover either of the upstreams this site depends on: the RPC is a
 * POST (never cached), and Yahoo is an undocumented endpoint that answers 429 the moment a page
 * asks it thirteen questions at once — which is exactly what building this page did to it.
 *
 * Three behaviours, each one earned:
 *
 *   FRESH within the TTL, so a burst of visitors costs one upstream call.
 *   DEDUPED while a load is in flight, so ten simultaneous cold requests make one call, not ten.
 *   STALE-ON-FAILURE, which is the important one. A rate-limited quote endpoint should leave the
 *   page showing a price from two minutes ago, not a row of dashes. Data this page shows is
 *   reference data on a minute scale; the failure mode of showing it slightly late is nothing next
 *   to the failure mode of showing nothing.
 */

type Entry<T> = { value: T; at: number; inflight?: Promise<T> };

const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit?.inflight) return hit.inflight;

  const inflight = load()
    .then((value) => {
      store.set(key, { value, at: Date.now() });
      return value;
    })
    .catch((error) => {
      // Keep serving the last good answer, but let its age stand so the next caller retries.
      if (hit) { store.set(key, { value: hit.value, at: hit.at }); return hit.value; }
      store.delete(key);
      throw error;
    });

  store.set(key, { value: hit?.value as T, at: hit?.at ?? 0, inflight });
  return inflight;
}
