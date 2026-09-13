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

export function CoinArtClient({ coins }: { coins: string[] }) {
  const key = coins.join(",");

  useEffect(() => {
    const cards = [...document.querySelectorAll<HTMLElement>(".index-card[data-coin]")]
      .filter((card) => !card.classList.contains("has-art"));
    // The server got them all. Asking anyway would cost every reader a request to a third party
    // for pictures that are already on screen.
    if (cards.length === 0) return;

    const wanted = [...new Set(cards.map((c) => c.dataset.coin).filter(Boolean) as string[])];
    const stop = new AbortController();

    fetch(`https://api.dexscreener.com/tokens/v1/base/${wanted.join(",")}`, {
      headers: { accept: "application/json" },
      signal: stop.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((pairs: Pair[] | null) => {
        if (!Array.isArray(pairs)) return;
        const art = new Map<string, string>();
        for (const pair of pairs) {
          const address = pair.baseToken?.address?.toLowerCase();
          const image = pair.info?.imageUrl;
          if (!address || !image || art.has(address)) continue;
          const url = resized(image);
          if (SAFE.test(url)) art.set(address, url);
        }
        for (const card of cards) {
          const url = card.dataset.coin ? art.get(card.dataset.coin) : undefined;
          if (!url) continue;
          card.style.setProperty("--art", `url("${url}")`);
          card.classList.add("has-art");
        }
      })
      // A refusal here is the same non-event it is on the server: the cards keep their initials.
      .catch(() => {});

    return () => stop.abort();
  }, [key]);

  return null;
}
