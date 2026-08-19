import { apiError } from "../shared";
import { LISTED, marketBoard, marketDetail } from "../../../lib/market";

/**
 * HTTP surface for `lib/market` — the same data the server components read directly, exposed for
 * client-side refresh. The ticker is matched against the seed list rather than trusted, so this
 * cannot be pointed at an arbitrary symbol or used to proxy traffic to the upstreams.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const single = params.get("ticker");

  if (single) {
    const ticker = single.toUpperCase();
    if (!LISTED.has(ticker)) return apiError("That ticker is not listed on Stockify.", 400);
    return Response.json(
      await marketDetail(ticker, params.get("range") ?? "1y"),
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
    );
  }

  const tickers = (params.get("tickers") ?? "").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.some((t) => LISTED.has(t))) return apiError("No listed tickers requested.", 400);

  return Response.json(
    { ...(await marketBoard(tickers)), fetchedAt: Date.now() },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } },
  );
}
