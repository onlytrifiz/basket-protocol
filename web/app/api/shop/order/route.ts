import {
  SupplierError,
  buildDelivery,
  createOrder,
  hasPartnerId,
  resolveProduct,
  selectPurchase,
} from "../../../../lib/shop/cryptorefills";
import {
  endUserContext,
  isEmail,
  isPhoneForCountry,
  jsonError,
  normalisePhone,
} from "../../../../lib/shop/request";
import { recordOrder } from "../../../../lib/shop/db";
import { phoneExample } from "../../../../lib/shop/countries";
import { DEFAULT_SETTLEMENT, findSettlement } from "../../../../lib/shop/settlement";
import { clientKey, rateLimit, tooMany } from "../../../../lib/shop/rate-limit";

export const runtime = "nodejs";

type Body = {
  family?: string;
  brand?: string;
  countryCode?: string;
  email?: string;
  phone?: string;
  coin?: string;
  network?: string;
  value?: number;
  denomination?: string;
  /** The buyer's own wallet, when one is connected. Never the payer of record:
   *  payments arrive from a bridge relayer, so "refund the sender" pays a
   *  stranger. Best-effort — the field can only be set at creation, and most
   *  buyers connect a wallet on the next screen. */
  refundAddress?: string;
};

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Creates a real order upstream and returns the payment instructions. */
export async function POST(req: Request) {
  // Each call creates a real order upstream, so this is deliberately tight.
  const limit = rateLimit(`order:${clientKey(req)}`, 8, 60_000);
  if (!limit.ok) {
    return tooMany(limit, "Too many orders from this address. Try again shortly.");
  }

  // Refuse to sell unattributed rather than quietly earning nothing.
  if (!hasPartnerId()) {
    console.error(
      "[config] CRYPTOREFILLS_PARTNER_ID is not set — refusing to place orders that would earn no commission.",
    );
    return jsonError(
      "Ordering is temporarily unavailable. Please try again shortly.",
      503,
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonError("Send a JSON body.");
  }

  const { family, brand, countryCode } = body;

  // Always required: the order confirmation goes here even for top-ups.
  if (!isEmail(body.email)) {
    return jsonError("Enter a valid email address for the confirmation.");
  }
  if (!family) return jsonError("family is required.");
  if (!countryCode) return jsonError("countryCode is required.");

  // Pinned to a pair we actually settle on rather than taken on trust. This is
  // a public endpoint, and an order created in some other coin would quote an
  // address the checkout cannot pay and the bridge cannot reach.
  const settlement =
    findSettlement(body.coin, body.network) ??
    (body.coin || body.network ? undefined : DEFAULT_SETTLEMENT);
  if (!settlement) {
    return jsonError("That payment network is not supported.", 409);
  }
  const coin = settlement.coin;

  const email = body.email.trim();

  try {
    const product = await resolveProduct(countryCode, family, coin, brand);
    if (!product) return jsonError("This product is not available right now.", 409);
    if (product.outOfStock) return jsonError("This product is sold out.", 409);

    if (product.isDynamic && typeof body.value !== "number") {
      return jsonError("Choose an amount.");
    }
    if (!product.isDynamic && !body.denomination && typeof body.value !== "number") {
      return jsonError("Choose an option.");
    }

    // Never charge for something the buyer did not pick: if the request cannot
    // be honoured exactly, stop and say what is on sale.
    const pick = selectPurchase(product, {
      value: body.value,
      denomination: body.denomination,
    });

    // Delivery target is a property of the chosen option, not the product: the
    // same brand can sell a by_phone top-up and a by_email PIN at one price.
    let beneficiary = email;
    if (pick.deliversTo === "phone") {
      const phone = normalisePhone(body.phone ?? "");
      // Must belong to the product's country: a WindTre Italy top-up only
      // credits an Italian number, and the transfer cannot be reversed.
      if (!isPhoneForCountry(phone, countryCode)) {
        return jsonError(
          `Enter the number to top up in full international format for ${countryCode} — e.g. ${phoneExample(countryCode)}.`,
        );
      }
      beneficiary = phone;
    }
    if (pick.adjusted) {
      return Response.json(
        {
          error: "That option is not available for this product.",
          isDynamic: product.isDynamic,
          isPlanBased: product.isPlanBased,
          options: product.options,
          min: product.min,
          max: product.max,
          nearest: pick.denomination ?? pick.value,
        },
        { status: 409 },
      );
    }

    // Validated rather than forwarded: this ends up on a payout instruction,
    // and a malformed one is worse than none at all.
    const refundWalletAddress =
      typeof body.refundAddress === "string" && EVM_ADDRESS.test(body.refundAddress.trim())
        ? body.refundAddress.trim()
        : undefined;

    const order = await createOrder({
      email,
      coin: settlement.coin,
      network: settlement.network,
      refundWalletAddress,
      deliveries: [
        buildDelivery({
          brandName: product.brandName,
          countryCode,
          beneficiary,
          value: pick.value,
          denomination: pick.denomination,
        }),
      ],
      user: { email },
      ...endUserContext(req),
    });

    // Record it for our own books. The supplier is the system of record, so a
    // ledger failure must never fail a paid-for order — log and carry on.
    const o = order as Record<string, unknown>;
    const orderId = String(o.order_id ?? o.id ?? "");
    if (orderId) {
      try {
        await recordOrder({
          orderId,
          status: String(o.order_state ?? "Created"),
          paymentStatus: o.payment_state ? String(o.payment_state) : null,
          brand: product.brandName,
          family: product.familyName,
          denomination: pick.denomination ?? pick.label,
          faceValue: pick.faceValue,
          currency: product.currency,
          countryCode,
          coin: o.coin ? String(o.coin) : coin,
          coinAmount: o.coin_amount ? String(o.coin_amount) : null,
          network: o.network ? String(o.network) : settlement.network,
          walletAddress: o.wallet_address ? String(o.wallet_address) : null,
          email,
          phone: pick.deliversTo === "phone" ? beneficiary : null,
          payerAddress: refundWalletAddress ?? null,
        });
      } catch (err) {
        console.error("[ledger] could not record order", orderId, err);
      }
    }

    return Response.json({
      ok: true,
      faceValue: pick.faceValue,
      label: pick.label,
      order,
    });
  } catch (err) {
    if (err instanceof SupplierError) {
      return jsonError("The order could not be placed.", 502, err.body);
    }
    return jsonError("The order could not be placed.", 502);
  }
}
