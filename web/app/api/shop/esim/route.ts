import { resolveProduct } from "../../../../lib/shop/cryptorefills";
import { jsonError } from "../../../../lib/shop/request";
import { clientKey, rateLimit, tooMany } from "../../../../lib/shop/rate-limit";

export const runtime = "nodejs";

/** Data plans available for one travel destination. */
export async function GET(req: Request) {
  const limit = rateLimit(`esim:${clientKey(req)}`, 60, 60_000);
  if (!limit.ok) return tooMany(limit, "Too many requests. Try again shortly.");

  const url = new URL(req.url);
  const destination = (url.searchParams.get("destination") ?? "").toUpperCase();
  const coin = url.searchParams.get("coin") ?? "USDC";

  if (!/^[A-Z]{2}$/.test(destination)) {
    return jsonError("Pick a destination.");
  }

  try {
    const product = await resolveProduct(destination, "eSIM", coin, "eSIM");
    if (!product || product.outOfStock || !product.options.length) {
      return Response.json({ ok: true, destination, plans: [] });
    }

    return Response.json({
      ok: true,
      destination,
      brandName: product.brandName,
      familyName: product.familyName,
      logo: product.logo,
      terms: product.terms,
      content: product.content,
      plans: product.options.map((o) => ({
        denomination: o.denomination,
        label: o.label,
        faceValue: o.faceValue,
        coinAmount: o.coinAmount ?? null,
        coin: o.coin ?? coin,
        data: o.data ?? null,
        unlimited: Boolean(o.unlimited),
        days: o.days ?? null,
      })),
    });
  } catch {
    return jsonError("Could not load plans for that destination.", 502);
  }
}
