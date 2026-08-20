import { getAddress, type Address } from "viem";
import { EXPLORER_API, EXPLORER_API_KEY, CHAIN_ID } from "./config.js";

const UA = "stockify-indices-keeper/1.0";
const PAGE_SIZE = Number(process.env.HOLDERS_PAGE_SIZE ?? "1000");
const PAGE_PAUSE_MS = Number(process.env.HOLDERS_PAGE_PAUSE_MS ?? "220");
const ATTEMPTS = Number(process.env.HOLDERS_ATTEMPTS ?? "3");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const why = (e: any) => e?.cause?.message ?? e?.cause?.code ?? e?.message ?? String(e);

/**
 * One page, with retries.
 *
 * A holder list is a burst of requests to the same host, which is exactly the shape that trips a
 * rate limiter — and a single refused page in the middle would otherwise throw away the whole round.
 * Backoff costs a second; a skipped round costs an hour.
 */
async function page(url: URL): Promise<any | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        console.error(`    explorer → HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      if (attempt === ATTEMPTS) {
        console.error(`    explorer → ${why(e)} (after ${ATTEMPTS} attempts)`);
        return null;
      }
      await sleep(500 * attempt);
    }
  }
  return null;
}

/**
 * The holder list.
 *
 * There is no on-chain way to enumerate ERC20 holders — no token offers it — so this comes from the
 * explorer's index. That makes it the one part of a round that depends on a third party: if the
 * explorer is unavailable the round is skipped (nothing is lost, the stock waits for the next one),
 * and a partial list would pay fewer people and leave the rest for later.
 *
 * `tokenholderlist` is an Etherscan **Pro** endpoint. Without a Pro key it answers "API Pro endpoint"
 * with `status: 0`, which this reads as a failure and skips the round — the honest outcome, rather
 * than paying out against an empty list. Base's Blockscout is not an alternative: it serves token
 * metadata but does not index balances, and returns an empty holder set for every token.
 *
 * Paged by `page`/`offset` rather than a cursor, so the end of the list is a short page — there is no
 * "next" flag to trust or to break.
 */
export async function fetchHolders(coin: Address): Promise<Address[] | null> {
  const out: Address[] = [];

  for (let p = 1; p <= 100; p++) {
    const url = new URL(EXPLORER_API);
    url.searchParams.set("chainid", String(CHAIN_ID));
    url.searchParams.set("module", "token");
    url.searchParams.set("action", "tokenholderlist");
    url.searchParams.set("contractaddress", coin);
    url.searchParams.set("page", String(p));
    url.searchParams.set("offset", String(PAGE_SIZE));
    url.searchParams.set("apikey", EXPLORER_API_KEY);

    const body = await page(url);
    if (!body) return null;

    const rows = body?.result;
    if (!Array.isArray(rows)) {
      // `status: 0` with a string result is how this API reports both "no holders" and "your key
      // cannot call this". The first is a real answer for a coin nobody holds yet; the second must
      // not be mistaken for it, or every round would pay nobody and report success.
      const msg = String(rows ?? body?.message ?? "");
      if (/no .*found/i.test(msg)) return out;
      console.error(`    explorer → ${msg.slice(0, 120)}`);
      return null;
    }

    for (const row of rows) {
      const a = row?.TokenHolderAddress;
      if (a) out.push(getAddress(a));
    }

    if (rows.length < PAGE_SIZE) return out;
    if (PAGE_PAUSE_MS > 0) await sleep(PAGE_PAUSE_MS);
  }

  // A hundred full pages is not a long tail, it is a broken cursor. Better to skip the round than to
  // pay out against a list we no longer trust.
  console.error("    explorer → pagination did not terminate");
  return null;
}
