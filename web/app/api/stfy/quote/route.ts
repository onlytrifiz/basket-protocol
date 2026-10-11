import { apiError, isRateLimited } from "../../shared";
import { quoteStfy } from "../../../../lib/stfy-quote";

/** The exact STFY swap output at the current block. See `lib/stfy-quote`. */
export async function GET(request: Request) {
  if (isRateLimited(request)) return apiError("Too many quotes. Try again in a minute.", 429);
  const params = new URL(request.url).searchParams;
  const side = params.get("side");
  const amount = params.get("amount") ?? "";
  if ((side !== "buy" && side !== "sell") || !/^\d{1,40}$/.test(amount) || BigInt(amount) === 0n) {
    return apiError("Expected side=buy|sell and a positive amount in base units.", 400);
  }
  try {
    const out = await quoteStfy(side, BigInt(amount));
    return Response.json({ out: out.toString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return apiError("The pool could not be quoted just now.", 503);
  }
}
