import { SupplierError, getOrder } from "../../../../../lib/shop/cryptorefills";
import { cleanHtml } from "../../../../../lib/shop/sanitize";
import { jsonError } from "../../../../../lib/shop/request";
import { recordPayer, upsertFromSupplier } from "../../../../../lib/shop/db";
import { clientKey, rateLimit, tooMany } from "../../../../../lib/shop/rate-limit";

export const runtime = "nodejs";

/**
 * Supplier order payloads carry HTML (redeem instructions, terms). Scrub it
 * here so the tracker can render it without re-checking.
 */
function sanitiseOrder(order: Record<string, unknown>) {
  const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];

  return {
    ...order,
    deliveries: deliveries.map((d) => {
      const rec = d as Record<string, unknown>;
      const item = (rec.deliverable ?? {}) as Record<string, unknown>;
      return {
        ...rec,
        deliverable: {
          ...item,
          redeem_instructions: cleanHtml(item.redeem_instructions as string),
          terms_and_conditions: cleanHtml(item.terms_and_conditions as string),
          pin_usage_instructions: cleanHtml(
            item.pin_usage_instructions as string,
          ),
        },
      };
    }),
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // The tracker polls this every 5s while an order settles, and each call can
  // write to the ledger — generous enough for several open tabs, bounded
  // enough that it cannot be used to hammer the supplier.
  const limit = rateLimit(`status:${clientKey(req)}`, 90, 60_000);
  if (!limit.ok) return tooMany(limit, "Too many requests. Try again shortly.");

  const { id } = await params;
  if (!id) return jsonError("Missing order id.");

  try {
    const order = await getOrder(id);

    // The tracker polls this while an order settles, which makes it the natural
    // place to keep our ledger in step. Never let a ledger write break the page.
    try {
      await upsertFromSupplier(order);
    } catch (err) {
      console.error("[ledger] could not update order", id, err);
    }

    return Response.json({ ok: true, order: sanitiseOrder(order) });
  } catch (err) {
    if (err instanceof SupplierError && err.status === 404) {
      return jsonError("That order does not exist.", 404);
    }
    return jsonError("Could not load this order.", 502);
  }
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Records the wallet that is paying this order.
 *
 * Called as the buyer signs, because that is the first moment the address is
 * known and the supplier's own refund field closed at order creation. Writes
 * nothing else and answers the same either way: this is bookkeeping, and a
 * buyer must never see a payment fail because our ledger was busy.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limit = rateLimit(`payer:${clientKey(req)}`, 30, 60_000);
  if (!limit.ok) return tooMany(limit, "Too many requests. Try again shortly.");

  const { id } = await params;
  if (!id) return jsonError("Missing order id.");

  let address: unknown;
  try {
    ({ address } = await req.json());
  } catch {
    return jsonError("Send a JSON body.");
  }
  if (typeof address !== "string" || !EVM_ADDRESS.test(address.trim())) {
    return jsonError("That is not a wallet address.");
  }

  try {
    await recordPayer(id, address.trim());
  } catch (err) {
    console.error("[ledger] could not record payer for", id, err);
  }
  return Response.json({ ok: true });
}
