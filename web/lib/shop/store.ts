import "server-only";

import { cookies, headers } from "next/headers";
import {
  COUNTRY_COOKIE,
  DEFAULT_COUNTRY,
  isSupportedCountry,
} from "./countries";

function supported(code: string | undefined | null): code is string {
  return isSupportedCountry(code);
}

/**
 * The country the shopper is buying for.
 *
 * An explicit choice always wins. Otherwise we guess from the edge's geo header
 * — Vercel sets `x-vercel-ip-country`, and Cloudflare `cf-ipcountry` — so a
 * visitor from Italy lands on the Italian catalogue instead of the US one.
 * The guess is never written to the cookie: only the shopper's own choice is,
 * so the guess can improve without being frozen on first visit.
 */
export async function activeCountry(): Promise<string> {
  const store = await cookies();
  const chosen = store.get(COUNTRY_COOKIE)?.value;
  if (supported(chosen)) return chosen;

  const h = await headers();
  const geo =
    h.get("x-vercel-ip-country") ??
    h.get("cf-ipcountry") ??
    h.get("x-geo-country");
  const guess = geo?.trim().toUpperCase();
  if (supported(guess)) return guess;

  return DEFAULT_COUNTRY;
}
