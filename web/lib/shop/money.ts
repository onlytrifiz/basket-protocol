/**
 * Catalogue prices are not always in dollars — an Italian top-up is priced in
 * EUR — so nothing may hardcode a currency symbol.
 */
export function formatMoney(value: number, currency = "USD"): string {
  try {
    /**
     * A round face value reads better whole — "$50", not "$50.00" — but a price
     * with cents has to show both of them. Leaving the minimum at zero printed
     * a real quote as "$103.4", which is the kind of number that makes a
     * shopper wonder what else on the page is approximate.
     */
    const whole = Number.isInteger(value);
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(value);
  } catch {
    // Unknown currency code: show the number and the code rather than guess.
    return `${value} ${currency}`;
  }
}

/**
 * The sentinel a range-priced order is placed with, echoed back.
 *
 * Ordering a dynamically-priced product REQUIRES sending
 * `denomination: "range"` plus `product_value` — sending the literal "5 EUR"
 * resolves to a different, dearer product, which is why `buildDelivery` does it
 * that way. The supplier then hands the string straight back on the order, in
 * BOTH `denomination` and `localized_denomination`, so anything that renders
 * "whichever of those exists" prints the word `range` where the buyer expects
 * to see what they bought.
 *
 * Seen on a real order: a €5 Amazon.it card came back as
 * `denomination: "range"`, `localized_denomination: "range"`,
 * `product_value: 5`, `currency_code: "EUR"`.
 *
 * Null rather than the sentinel when there is no value to substitute: showing
 * nothing is better than showing upstream's plumbing.
 */
export function denominationLabel(item: {
  denomination?: string | null;
  localized_denomination?: string | null;
  product_value?: number | string | null;
  currency_code?: string | null;
}): string | null {
  const localized = item.localized_denomination?.trim() || null;
  const raw = item.denomination?.trim() || null;
  const shown = localized ?? raw;

  if (shown?.toLowerCase() === "range") {
    const value = Number(item.product_value);
    if (Number.isFinite(value) && value > 0) {
      return formatMoney(value, item.currency_code ?? "USD");
    }
    return null;
  }
  return shown;
}
