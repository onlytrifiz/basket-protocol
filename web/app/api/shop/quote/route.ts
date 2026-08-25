import {
  SupplierError,
  buildDelivery,
  resolveProduct,
  selectPurchase,
  validateOrder,
} from "../../../../lib/shop/cryptorefills";
import {
  endUserContext,
  isEmail,
  isPhoneForCountry,
  jsonError,
  normalisePhone,
} from "../../../../lib/shop/request";
import { dialCode } from "../../../../lib/shop/countries";
import { DEFAULT_SETTLEMENT, QUOTE_EMAIL, SETTLEMENTS } from "../../../../lib/shop/settlement";
import { clientKey, rateLimit, tooMany } from "../../../../lib/shop/rate-limit";

export const runtime = "nodejs";

type Body = {
  /** The supplier's family key. */
  family?: string;
  /** Exact brand, to disambiguate families that hold several products. */
  brand?: string;
  countryCode?: string;
  email?: string;
  phone?: string;
  coin?: string;
  network?: string;
  /** Range-priced products. */
  value?: number;
  /** Option products — the supplier's exact denomination string. */
  denomination?: string;
};

/**
 * Non-committal price check. Returns what the buyer would pay in crypto right
 * now. Creates nothing upstream.
 */
export async function POST(req: Request) {
  // Pricing is chatty by design — it re-fires as the shopper changes amount or
  // coin — so the ceiling is generous but still bounded.
  const limit = rateLimit(`quote:${clientKey(req)}`, 60, 60_000);
  if (!limit.ok) {
    return tooMany(limit, "Too many price checks. Try again in a moment.");
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonError("Send a JSON body.");
  }

  const { family, brand, countryCode, coin = "USDC" } = body;
  if (!family) return jsonError("family is required.");
  if (!countryCode) return jsonError("countryCode is required.");

  try {
    const product = await resolveProduct(countryCode, family, coin, brand);
    if (!product) {
      return Response.json(
        { ok: false, problem: "NOT_AVAILABLE_PRODUCT" },
        { status: 200 },
      );
    }

    const pick = selectPurchase(product, {
      value: body.value,
      denomination: body.denomination,
    });

    // Quotes are anonymous until checkout. Delivery target follows the chosen
    // option, not the product — the same brand sells by_phone and by_email
    // variants at the same price. Top-ups still need a syntactically valid
    // number, so fall back to a placeholder the supplier accepts.
    const beneficiary =
      pick.deliversTo === "phone"
        ? isPhoneForCountry(normalisePhone(body.phone ?? ""), countryCode)
          ? normalisePhone(body.phone!)
          : `${dialCode(countryCode)}3331234567`
        : isEmail(body.email)
          ? body.email.trim()
          : QUOTE_EMAIL;

    const deliveries = [
      buildDelivery({
        brandName: product.brandName,
        countryCode,
        beneficiary,
        value: pick.value,
        denomination: pick.denomination,
      }),
    ];
    const email = isEmail(body.email) ? body.email.trim() : QUOTE_EMAIL;

    /**
     * Not every brand settles on every network. A Rewarble voucher rejects
     * USDC on Base outright yet prices fine on Arbitrum — a rejection about the
     * *network* rather than the coin.
     *
     * `SETTLEMENTS` holds one entry today, because Base is the only chain a
     * payment here can be delivered to, so a brand that refuses Base is
     * genuinely unsellable and is reported as such rather than sold as an order
     * nothing could pay. The walk stays because the list is what would change
     * if a second rail ever existed, and this route should not have to.
     *
     * Only a coin/network rejection is worth moving on from: a genuine "we do
     * not sell this" fails identically everywhere, and retrying it would cost
     * upstream calls to learn nothing.
     */
    let quote: Awaited<ReturnType<typeof validateOrder>> | null = null;
    let settlement = DEFAULT_SETTLEMENT;
    let problem: string | undefined;

    for (const candidate of SETTLEMENTS) {
      const attempt = await validateOrder({
        email,
        coin: candidate.coin,
        network: candidate.network,
        deliveries,
        ...endUserContext(req),
      });

      problem = attempt.problems?.[0]?.problem;
      // A priced quote needs an amount as well as no complaint: upstream can
      // answer with no problems and a null coin_amount, which is not a price.
      if (!problem && Number(attempt.coin_amount) > 0) {
        quote = attempt;
        settlement = candidate;
        break;
      }
      if (problem && problem !== "UNSUPPORTED_PROTOCOL_COIN_COMBINATION") break;
    }

    if (!quote) {
      // Having tried every network we settle on, a coin rejection now means
      // the brand genuinely cannot be paid for here.
      return Response.json(
        {
          ok: false,
          problem: problem ?? "UNSUPPORTED_PROTOCOL_COIN_COMBINATION",
          reason:
            problem && problem !== "UNSUPPORTED_PROTOCOL_COIN_COMBINATION"
              ? "unavailable"
              : "coin",
        },
        { status: 200 },
      );
    }

    const usd = quote.summary?.as_USD?.value_to_pay_in_crypto ?? null;
    const eur = quote.summary?.as_EUR?.value_to_pay_in_crypto ?? null;

    // Compare like with like: an Italian top-up has a EUR face value, so
    // measuring it against the USD settlement overstates the markup by the
    // EUR/USD rate (a €5 card looked like +24% instead of ~+14%).
    const settled =
      product.currency === "EUR" ? eur : product.currency === "USD" ? usd : null;

    const markup =
      settled && pick.faceValue && pick.faceValue > 0
        ? ((Number(settled) - pick.faceValue) / pick.faceValue) * 100
        : null;

    return Response.json({
      ok: true,
      brandName: product.brandName,
      faceValue: pick.faceValue,
      denomination: pick.denomination ?? null,
      label: pick.label,
      /** True when the request could not be honoured exactly. */
      adjusted: pick.adjusted,
      isDynamic: product.isDynamic,
      isPlanBased: product.isPlanBased,
      deliversTo: pick.deliversTo,
      currency: product.currency,
      coin: quote.coin,
      coinAmount: quote.coin_amount,
      /** Which pair actually priced, so the order is placed on the same one. */
      settlement: { coin: settlement.coin, network: settlement.network },
      usd,
      eur,
      /** Settlement value in the product's own currency, for honest compare. */
      settled,
      markupPct: markup === null ? null : Number(markup.toFixed(2)),
      fee: quote.payment_fee?.amount ?? "0",
    });
  } catch (err) {
    if (err instanceof SupplierError) {
      return jsonError("Could not price this product right now.", 502, err.body);
    }
    return jsonError("Could not price this product right now.", 502);
  }
}
