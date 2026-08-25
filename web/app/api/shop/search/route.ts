import { getCatalog } from "../../../../lib/shop/cryptorefills";
import { DEFAULT_COUNTRY } from "../../../../lib/shop/countries";
import { clientKey, rateLimit, tooMany } from "../../../../lib/shop/rate-limit";

export const runtime = "nodejs";

/** Type-ahead over the country catalogue. Kept server-side so the client never
 *  has to download 500+ brands to search them. */
export async function GET(req: Request) {
  const limit = rateLimit(`search:${clientKey(req)}`, 120, 60_000);
  if (!limit.ok) return tooMany(limit, "Too many searches. Try again shortly.");

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const country = url.searchParams.get("country") ?? DEFAULT_COUNTRY;

  if (q.length < 2) return Response.json({ ok: true, results: [] });

  try {
    const catalog = await getCatalog(country);
    const starts: typeof catalog.all = [];
    const contains: typeof catalog.all = [];

    for (const b of catalog.all) {
      const name = b.name.toLowerCase();
      if (name.startsWith(q)) starts.push(b);
      else if (name.includes(q)) contains.push(b);
      if (starts.length >= 8) break;
    }

    const results = [...starts, ...contains].slice(0, 8).map((b) => ({
      slug: b.slug,
      name: b.name,
      logo: b.logo,
      bgColor: b.bgColor,
      minLabel: b.minLabel,
      maxLabel: b.maxLabel,
    }));

    return Response.json({ ok: true, results });
  } catch {
    return Response.json({ ok: true, results: [] });
  }
}
