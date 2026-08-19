import { readAssets } from "../../../../lib/b20";

/**
 * Every listed equity with its live supply, split state and official icon.
 *
 * Server-side because it is a batched RPC round-trip — 39 `eth_call`s today — and Next's fetch cache
 * collapses it to one per minute across all visitors. Doing it per browser would put every reader on
 * their own chance of a rate-limited public RPC, and a failed read is indistinguishable from a token
 * with genuinely zero supply, which is exactly the fact this page is claiming to report.
 */
export async function GET() {
  const assets = await readAssets();
  return Response.json(
    { assets, fetchedAt: Date.now() },
    { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" } },
  );
}
