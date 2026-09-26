import { apiError } from "../shared";
import { poolsForAll } from "../../../lib/pools";

/**
 * Addresses one request may ask about. The cap lives HERE, at the edge where the list comes from a
 * stranger, so this route cannot be turned into a free DexScreener proxy. It used to live inside
 * `poolsForAll`, where it also cut the site's own listing off at twenty.
 */
const MAX_ADDRS = 20;

/** HTTP surface for `lib/pools` — the same data the server components read directly. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const addrs = (params.get("addrs") ?? params.get("addr") ?? "").split(",").slice(0, MAX_ADDRS);
  const minLiqParam = Number(params.get("minLiq"));

  const pools = await poolsForAll(addrs, {
    full: params.get("full") === "1",
    minLiq: Number.isFinite(minLiqParam) && minLiqParam >= 0 ? minLiqParam : undefined,
  });
  if (Object.keys(pools).length === 0) return apiError("No valid token addresses.", 400);

  return Response.json(
    { pools, fetchedAt: Date.now() },
    { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" } },
  );
}
