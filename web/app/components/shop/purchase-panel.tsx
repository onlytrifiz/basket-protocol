"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PurchaseOption } from "../../../lib/shop/types";
import { formatMoney } from "../../../lib/shop/money";
import { dialCode, phoneExample } from "../../../lib/shop/countries";
import { DEFAULT_SETTLEMENT } from "../../../lib/shop/settlement";
import { useWallet } from "../wallet";

type Quote =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ok";
      coin: string;
      coinAmount: string;
      faceValue: number | null;
      label: string;
      adjusted: boolean;
      /** The coin/network pair upstream accepted for this brand. */
      settlement: { coin: string; network: string };
    }
  | { status: "unavailable"; reason: "coin" | "unavailable"; coin: string }
  | { status: "error"; message: string };

export type PurchaseProduct = {
  /** Exact brand — disambiguates families holding several products. */
  brandName: string;
  familyName: string;
  countryCode: string;
  isDynamic: boolean;
  isPlanBased: boolean;
  deliversTo: "email" | "phone";
  min: number;
  max: number;
  step: number;
  options: PurchaseOption[];
  suggested: number;
  currency: string;
  outOfStock: boolean;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** The supplier only accepts E.164 for top-ups. */
const E164 = /^\+[1-9]\d{7,14}$/;

function tidyPhone(value: string) {
  const t = value.trim().replace(/[\s()\-.]/g, "");
  return t.startsWith("00") ? `+${t.slice(2)}` : t;
}

/**
 * The buyer is not asked what to pay with here.
 *
 * That decision belongs on the order page, where the amount is fixed and the
 * swap is built against it. Asking twice — once for a settlement asset, again
 * for what to actually spend — only invited people to pick something they would
 * then have to abandon.
 *
 * Which asset the order settles in is the quote's answer, not this component's,
 * and the order is placed on whichever pair actually priced.
 */
export function PurchasePanel({
  product,
  initialValue,
  initialDenomination,
  /** Overrides the delivery-field wording for non-card products. */
  deliveryLabel,
}: {
  product: PurchaseProduct;
  initialValue?: number;
  initialDenomination?: string;
  deliveryLabel?: string;
}) {
  const router = useRouter();
  /**
   * Only to name a refund address on the order, never to gate the purchase.
   * The supplier takes that address at creation and nowhere else, so a buyer
   * who happens to be connected already — most of this site's visitors are —
   * gets one recorded for free. Everyone else has theirs written to our own
   * ledger the moment they pay.
   */
  const { account } = useWallet();
  const firstOption = product.options[0];

  const [amount, setAmount] = useState<number>(
    initialValue && Number.isFinite(initialValue) ? initialValue : product.suggested,
  );
  const [rawAmount, setRawAmount] = useState<string>(String(initialValue ?? product.suggested));
  const [denomination, setDenomination] = useState<string | undefined>(() => {
    if (product.isDynamic) return undefined;
    if (initialDenomination && product.options.some((o) => o.denomination === initialDenomination)) {
      return initialDenomination;
    }
    if (initialValue !== undefined) {
      const match = product.options.find(
        (o) => o.faceValue !== null && Math.abs(o.faceValue - initialValue) < 0.001,
      );
      if (match) return match.denomination;
    }
    return firstOption?.denomination;
  });

  const [email, setEmail] = useState("");
  // Prefilled with the country prefix: the commonest mistake is typing a
  // national number and losing the country code.
  const [phone, setPhone] = useState(() => dialCode(product.countryCode));
  const [quote, setQuote] = useState<Quote>({ status: "idle" });
  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const requestId = useRef(0);

  const fetchQuote = useCallback(async () => {
    if (product.outOfStock) return;
    const id = ++requestId.current;
    setQuote({ status: "loading" });

    try {
      const res = await fetch("/api/shop/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          family: product.familyName,
          brand: product.brandName,
          countryCode: product.countryCode,
          coin: DEFAULT_SETTLEMENT.coin,
          network: DEFAULT_SETTLEMENT.network,
          ...(product.isDynamic ? { value: amount } : { denomination }),
        }),
      });
      const data = await res.json();
      if (id !== requestId.current) return;

      if (!res.ok) return setQuote({ status: "error", message: data.error ?? "Could not get a price." });
      if (!data.ok) {
        return setQuote({
          status: "unavailable",
          reason: data.reason ?? "unavailable",
          coin: data.coin ?? DEFAULT_SETTLEMENT.coin,
        });
      }

      setQuote({
        status: "ok",
        coin: data.coin,
        coinAmount: data.coinAmount,
        faceValue: data.faceValue,
        label: data.label,
        adjusted: Boolean(data.adjusted),
        settlement: data.settlement ?? DEFAULT_SETTLEMENT,
      });

      // Keep the UI honest: show what is actually being priced.
      if (data.adjusted) {
        if (product.isDynamic && typeof data.faceValue === "number") {
          setAmount(data.faceValue);
          setRawAmount(String(data.faceValue));
        } else if (data.denomination) {
          setDenomination(data.denomination);
        }
      }
    } catch {
      if (id === requestId.current) setQuote({ status: "error", message: "Could not get a price." });
    }
  }, [product, amount, denomination]);

  useEffect(() => {
    const t = setTimeout(fetchQuote, 260);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  const emailValid = EMAIL.test(email.trim());
  // Delivery target belongs to the chosen option: a brand can sell a by_phone
  // top-up and a by_email PIN at the same price.
  const selectedOption = product.options.find((o) => o.denomination === denomination);
  const needsPhone = product.isDynamic
    ? product.deliversTo === "phone"
    : selectedOption?.deliversTo === "phone";
  // Mirror the server rule exactly: the number must belong to the product's
  // country. E.164 shape alone would let "+3290626384" through — an Italian
  // number missing its 39 that reads as a valid Belgian one — and a direct
  // top-up sent there cannot be reversed.
  const dial = dialCode(product.countryCode);
  const phoneValid =
    !needsPhone ||
    (E164.test(tidyPhone(phone)) && tidyPhone(phone).startsWith(dial) && tidyPhone(phone).length > dial.length);

  // Some operators sell the same value two ways — a direct top-up and a PIN
  // voucher. The supplier's labels alone ("€5" vs "5 EUR - PIN") do not explain
  // the difference, so say it outright whenever both are on sale.
  const mixedDelivery =
    !product.isDynamic &&
    product.options.some((o) => o.deliversTo === "phone") &&
    product.options.some((o) => o.deliversTo === "email");

  // Entitlements ("1 month") and money ("44.99 EUR") are different products at
  // different prices, so they are shown apart rather than sorted together.
  const entitlements = product.options.filter((o) => !o.isMoney);
  const amounts = product.options.filter((o) => o.isMoney);
  const groups = [
    entitlements.length && { key: "plan", title: "Subscription", options: entitlements },
    amounts.length && { key: "money", title: "Gift card value", options: amounts },
  ].filter(Boolean) as { key: string; title: string; options: PurchaseOption[] }[];

  const canBuy = !product.outOfStock && quote.status === "ok" && emailValid && phoneValid && !placing;

  async function placeOrder() {
    setPlacing(true);
    setOrderError(null);
    try {
      const res = await fetch("/api/shop/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          family: product.familyName,
          brand: product.brandName,
          countryCode: product.countryCode,
          // Whatever the quote settled on — some brands reject Base and price
          // on Arbitrum instead, and the order has to match.
          coin: quote.status === "ok" ? quote.settlement.coin : DEFAULT_SETTLEMENT.coin,
          network: quote.status === "ok" ? quote.settlement.network : DEFAULT_SETTLEMENT.network,
          email: email.trim(),
          ...(account ? { refundAddress: account } : {}),
          ...(needsPhone ? { phone: tidyPhone(phone) } : {}),
          ...(product.isDynamic ? { value: amount } : { denomination }),
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setOrderError(data.error ?? "The order could not be placed.");
        setPlacing(false);
        return;
      }

      const order = data.order as Record<string, unknown>;
      const id = (order?.id as string) ?? (order?.order_id as string) ?? (order?.reference as string);

      if (id) router.push(`/shop/order/${encodeURIComponent(id)}`);
      else {
        setOrderError("The order was created but no reference was returned. Check your email.");
        setPlacing(false);
      }
    } catch {
      setOrderError("The order could not be placed.");
      setPlacing(false);
    }
  }

  function commitAmount(next: string) {
    setRawAmount(next);
    const n = Number(next);
    if (Number.isFinite(n) && n > 0) setAmount(n);
  }

  const money = (v: number) => formatMoney(v, product.currency);

  return (
    <div className="sh-panel">
      <fieldset className="sh-fieldset">
        <legend className="sh-legend">
          {product.isPlanBased ? "Choose a data plan" : "Choose an amount"}
        </legend>

        {product.isDynamic ? (
          <>
            <div className="sh-opts">
              {[25, 50, 100, 200, 500]
                .filter((v) => v >= product.min && v <= product.max)
                .map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`sh-opt${amount === v ? " on" : ""}`}
                    onClick={() => commitAmount(String(v))}
                    aria-pressed={amount === v}
                  >
                    {money(v)}
                  </button>
                ))}
            </div>

            <label className="sh-field">
              <span className="sh-sr">Custom amount</span>
              <span className="sh-amount-wrap" style={{ display: "block" }}>
                <span className="cur">{product.currency}</span>
                <input
                  className="sh-input mono"
                  type="number"
                  inputMode="decimal"
                  min={product.min}
                  max={product.max}
                  step={product.step}
                  value={rawAmount}
                  onChange={(e) => commitAmount(e.target.value)}
                />
              </span>
            </label>
            <p className="sh-hint">
              Any amount from {money(product.min)} to {money(product.max)}
            </p>
          </>
        ) : product.isPlanBased ? (
          // Plans read as rows: the allowance is the headline, price secondary.
          <ul className="sh-plans">
            {product.options.map((o) => (
              <li key={o.denomination}>
                <button
                  type="button"
                  className={`sh-plan${denomination === o.denomination ? " on" : ""}`}
                  onClick={() => setDenomination(o.denomination)}
                  aria-pressed={denomination === o.denomination}
                >
                  <span>
                    <span className="big">{o.unlimited ? "Unlimited" : o.data ? `${o.data.amount} ${o.data.unit}` : o.label}</span>
                    {o.days && <span className="small">Valid {o.days} days</span>}
                  </span>
                  {o.faceValue !== null && <span className="price">{money(o.faceValue)}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          // Brands can list entitlements and money side by side — DAZN sells
          // "1 month" and "44.99 EUR" as separate products. Grouping them keeps
          // the two kinds from reading as duplicates in one jumbled row.
          <div style={{ marginTop: 4 }}>
            {groups.map((group) => (
              <div className="sh-optgroup" key={group.key}>
                {groups.length > 1 && <span className="t">{group.title}</span>}
                <div className="sh-opts">
                  {group.options.map((o) => (
                    <button
                      key={o.denomination}
                      type="button"
                      className={`sh-opt${denomination === o.denomination ? " on" : ""}`}
                      onClick={() => setDenomination(o.denomination)}
                      aria-pressed={denomination === o.denomination}
                    >
                      {o.period ?? o.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {mixedDelivery && (
          <p className="sh-tell">
            {needsPhone ? (
              <>
                <b>Direct top-up.</b> The credit is added to the number you enter below. Pick a
                &ldquo;PIN&rdquo; option instead to get a voucher code by email.
              </>
            ) : (
              <>
                <b>PIN voucher.</b> You get a code by email and redeem it yourself on any number — so
                no phone number is needed here. Pick a plain amount for a direct top-up.
              </>
            )}
          </p>
        )}
      </fieldset>

      {needsPhone && (
        <label className="sh-field">
          <span className="lab">Top up this number</span>
          <input
            className="sh-input mono"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={phoneExample(product.countryCode)}
            autoComplete="tel"
            inputMode="tel"
          />
          <span className="sh-hint">Include the country code. The credit goes straight to this number.</span>
          {phone.length > 0 && !phoneValid && (
            <span className="sh-bad">
              Use the full international format for {product.countryCode} — e.g. {phoneExample(product.countryCode)}.
            </span>
          )}
        </label>
      )}

      <label className="sh-field">
        <span className="lab">
          {deliveryLabel ?? (needsPhone ? "Send the receipt to" : "Deliver the code to")}
        </span>
        <input
          className="sh-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
        />
        {email.length > 0 && !emailValid && <span className="sh-bad">Enter a valid email address.</span>}
      </label>

      <div className="sh-total">
        <span className="k">You pay</span>
        {quote.status === "ok" ? (
          // Shown in dollars, not "29.34 USDC". The buyer is about to pay in
          // whatever token they hold, so the coin name here names something
          // they will never touch.
          <span className="v">{formatMoney(Number(quote.coinAmount), "USD")}</span>
        ) : quote.status === "unavailable" ? (
          <span className="v bad">{quote.reason === "coin" ? `${quote.coin} not accepted` : "Not sold here"}</span>
        ) : quote.status === "error" ? (
          <span className="v bad">{quote.message}</span>
        ) : (
          <span className="v dim">······</span>
        )}
      </div>

      {quote.status === "unavailable" && quote.reason === "coin" && (
        <p className="sh-hint">
          This brand cannot be paid for on any network we settle on. Nothing will be charged.
        </p>
      )}
      {quote.status === "ok" && quote.adjusted && (
        <p className="sh-bad">That option is not sold — adjusted to {quote.label}.</p>
      )}
      {orderError && <p className="sh-warn">{orderError}</p>}

      <button type="button" className="button button-ink sh-cta" onClick={placeOrder} disabled={!canBuy}>
        {product.outOfStock ? "Sold out" : placing ? "Placing order…" : "Buy now"}
      </button>

      <p className="sh-foot-note">
        Choose what to pay with on the next screen — your stock, or STFY. The price is locked once
        you place the order.
      </p>
    </div>
  );
}
