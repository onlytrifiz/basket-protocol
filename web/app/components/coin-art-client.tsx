"use client";

import { useEffect } from "react";

/**
 * Fetches the cards' coin artwork FROM THE BROWSER when the server could not.
 *
 * WHY THE SERVER COULD NOT. DexScreener rate-limits by source address, and every render of this
 * page leaves from the same small pool of Vercel egress IPs — so production answered `429` on
 * almost every attempt while the identical request from a laptop returned 200 in 0.4s. Measured
 * live: ten requests to the deployed page, ten without artwork. It is not a timing problem and no
 * amount of caching fixes it, because the address doing the asking is the thing being refused.
 *
 * A visitor's own IP is not in that pool, and DexScreener sends `access-control-allow-origin: *`,
 * so their browser is allowed to ask.
 *
 * ONE REQUEST FOR ALL OF THEM, WHICH IS THE WHOLE TRICK. The first version of this asked per card.
 * Three calls at once from one address is a burst, the throttled reply comes back WITHOUT the CORS
 * header, and the browser reports that as `net::ERR_FAILED` rather than as the 429 it is — so it
 * looked like a CORS bug and was a rate limit. The batch endpoint takes thirty addresses; three
 * cards are one call.
 *
 * THE SERVER PATH IS STILL TRIED FIRST and is still the good case: when it works the pictures are
 * in the HTML, with no request from the reader and nothing arriving late. This only asks for the
 * cards the server did not fill.
 *
 * It renders nothing. Everything the artwork drives — the blurred cap, the round mark, the chip, the
 * bar on a buyback — reads one custom property, so filling it in is a single assignment per card.
 */

/** The same host, shape and size the server path accepts. See `lib/coin-art`. */
const SAFE = /^https:\/\/cdn\.dexscreener\.com\/[\w/.-]+(\?[\w=&.-]*)?$/;
const SIZE = 128;

function resized(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("width")) parsed.searchParams.set("width", String(SIZE));
    if (parsed.searchParams.has("height")) parsed.searchParams.set("height", String(SIZE));
    return parsed.toString();
  } catch {
    return url;
  }
}

type Pair = { baseToken?: { address?: string }; info?: { imageUrl?: string } };

/** Shared by every mount on the page: what has been answered, and what is waiting to be asked. */
const known = new Map<string, string | null>();
const queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
/** Consecutive refusals; each one doubles the wait before the next batch, up to a minute. */
let refusals = 0;
const BATCH = 30;
const STORE_KEY = "stfy-coin-art";

function paint(address: string) {
  const url = known.get(address);
  if (!url) return;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-coin="${address}"]:not(.has-art)`)) {
    el.style.setProperty("--art", `url("${url}")`);
    el.classList.add("has-art");
  }
}

function remember() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify([...known].filter(([, url]) => url))); } catch { /* storage blocked */ }
}

/**
 * Ask for whatever is queued, thirty at a time and ONE REQUEST AT A TIME. Parallel calls from one
 * browser are the burst that earns a 429 (see above). A refused batch goes back on the queue and the
 * queue waits — five seconds, then ten, up to a minute — so the cards wear initials for a while
 * instead of for good, and a throttled reader never retries in a tight loop.
 */
function flush() {
  if (inFlight || queue.size === 0) return;
  const wanted = [...queue].slice(0, BATCH);
  wanted.forEach((a) => queue.delete(a));
  inFlight = true;
  fetch(`https://api.dexscreener.com/tokens/v1/base/${wanted.join(",")}`, { headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((pairs: Pair[] | null) => {
      if (!Array.isArray(pairs)) throw new Error("refused");
      refusals = 0;
      for (const pair of pairs) {
        const address = pair.baseToken?.address?.toLowerCase();
        const image = pair.info?.imageUrl;
        if (!address || !image || known.get(address)) continue;
        const url = resized(image);
        if (SAFE.test(url)) known.set(address, url);
      }
      // Answered without a picture is an answer too: not asked again on this page.
      for (const address of wanted) if (!known.has(address)) known.set(address, null);
      wanted.forEach(paint);
      remember();
    })
    .catch(() => {
      wanted.forEach((a) => queue.add(a));
      refusals += 1;
    })
    .finally(() => {
      inFlight = false;
      if (queue.size) timer = setTimeout(flush, refusals ? Math.min(60_000, 2_500 * 2 ** refusals) : 400);
    });
}

function request(address: string) {
  if (known.has(address)) return paint(address);
  queue.add(address);
  // While backing off, the scheduled retry will pick this up; do not jump the queue.
  if (refusals) return;
  clearTimeout(timer);
  timer = setTimeout(flush, 120);
}

/**
 * Fills in coin artwork on every `[data-coin]` element the server left without it: the index cards,
 * the rows of the full table, the mark on an index's own page.
 *
 * LAZY, because the full table is hundreds of coins. Each element is asked for only when it comes
 * within a screen of the viewport, so a visit that reads the first twenty rows makes one request,
 * and the answers are kept for the session so moving between pages does not ask twice.
 *
 * Renders nothing; mount it once per surface. Several mounts share one queue and one cache.
 */
export function CoinArtClient() {
  useEffect(() => {
    if (known.size === 0) {
      try {
        for (const [address, url] of JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "[]") as Array<[string, string]>) {
          if (SAFE.test(url)) known.set(address, url);
        }
      } catch { /* storage blocked or malformed */ }
    }

    // Per mount, not shared: a remount (Strict Mode does one on purpose) must observe afresh, and a
    // shared set would tell it everything was already being watched by an observer now disconnected.
    const watched = new WeakSet<Element>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const address = (entry.target as HTMLElement).dataset.coin;
        if (address) request(address);
      }
    }, { rootMargin: "600px 0px" });

    const scan = () => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-coin]:not(.has-art)")) {
        if (watched.has(el)) continue;
        watched.add(el);
        observer.observe(el);
      }
    };
    scan();
    // Client-side navigation and filters swap rows in without remounting this.
    const mutations = new MutationObserver(scan);
    mutations.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, []);

  return null;
}
