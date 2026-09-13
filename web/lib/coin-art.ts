import { cached } from "./cache";

/**
 * Launch-coin artwork, from DexScreener.
 *
 * WHY THIS IS SAFE TO ADD TO A PAGE THAT MUST NOT GET HEAVIER. One request covers every coin on the
 * card row — the batch endpoint takes up to thirty addresses — and the answer is cached for six
 * hours, because a token's picture is the least volatile thing about it. Three featured coins
 * therefore cost roughly four requests a day, not one per render.
 *
 * IT IS ALSO EASY TO GET WRONG. Six calls in quick succession while testing this returned
 * `429` with a Cloudflare body rather than JSON, so nothing here may assume a parseable response
 * and nothing may throw: a throttled upstream has to mean cards without pictures, never a page
 * that does not render. `cached()` keeps serving its last good answer through an outage.
 *
 * NOT FOR /indices/all. 168 coins is six requests and 168 more images on the heaviest page there
 * is. The full set stays on marks it already has.
 */

/** The batch endpoint's ceiling. Above it the request is rejected outright. */
const MAX_PER_CALL = 30;
const TTL_MS = 6 * 3_600_000;

/**
 * DexScreener hands back an 800×800 render by default — 84 KB measured, for a 44px avatar and a
 * backdrop that is blurred past recognition. The same image at 128 is 4 KB.
 */
const SIZE = 128;

/** Only this host, and only the shape its CDN actually emits. The URL ends up in a `style`
 *  attribute, where a stray quote would let the value close early and add declarations of its own. */
const SAFE = /^https:\/\/cdn\.dexscreener\.com\/[\w/.-]+(\?[\w=&.-]*)?$/;

type Pair = {
  baseToken?: { address?: string };
  info?: { imageUrl?: string };
};

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

async function load(addresses: string[]): Promise<Map<string, string>> {
  const art = new Map<string, string>();
  const batch = addresses.slice(0, MAX_PER_CALL).join(",");
  if (!batch) return art;

  const response = await fetch(`https://api.dexscreener.com/tokens/v1/base/${batch}`, {
    headers: { accept: "application/json" },
    // The six-hour memo above is the cache; asking the fetch layer to keep its own copy on top of
    // it only widens the window in which a stale picture can outlive a rename.
    cache: "no-store",
    /* BOUNDED. `fetch` in Node waits indefinitely by default, and this call is awaited during
       render on a page that is already careful about what it loads — a third party that stops
       answering would hold the whole page open rather than costing it three pictures. The abort
       rejects, `coinArt` catches, the cards fall back to initials. */
    signal: AbortSignal.timeout(2_500),
  });
  // A throttled answer is an HTML challenge page, not JSON. Reading it as JSON would throw inside
  // `cached`, which is exactly what the caller must never see.
  if (!response.ok) return art;

  const pairs = await response.json() as Pair[] | null;
  if (!Array.isArray(pairs)) return art;

  for (const pair of pairs) {
    const address = pair.baseToken?.address?.toLowerCase();
    const image = pair.info?.imageUrl;
    if (!address || !image || art.has(address)) continue;
    const url = resized(image);
    if (SAFE.test(url)) art.set(address, url);
  }
  return art;
}

/**
 * Artwork for the given coin addresses, keyed lowercase. Missing entries are the normal case — a
 * coin with no pair, or an upstream that said no — and the card falls back to its initials.
 */
export function coinArt(addresses: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].sort();
  if (wanted.length === 0) return Promise.resolve(new Map());
  return cached(`coin-art:${wanted.join(",")}`, TTL_MS, () => load(wanted)).catch(() => new Map());
}
