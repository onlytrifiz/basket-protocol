"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ESIM_DESTINATIONS, destinationFlag, destinationName } from "../../../lib/shop/esim-destinations";
import { DEFAULT_SETTLEMENT } from "../../../lib/shop/settlement";
import { formatMoney } from "../../../lib/shop/money";
import { useWallet } from "../wallet";

type Plan = {
  denomination: string;
  label: string;
  faceValue: number | null;
  coinAmount: string | null;
  coin: string;
  data: { amount: number; unit: string } | null;
  /** No allowance to state. The supplier signals it with a -1 we never show. */
  unlimited?: boolean;
  days: number | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The eSIM shop.
 *
 * The destination is the travel country, not the storefront country: you buy a
 * Japan eSIM while shopping from Italy, so the two are deliberately separate
 * controls that never sync.
 */
export function EsimShop({ initialDestination }: { initialDestination: string }) {
  const router = useRouter();
  // Same as the card panel: a refund address if one is already to hand.
  const { account } = useWallet();

  const [destination, setDestination] = useState(initialDestination);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  const [price, setPrice] = useState<
    | { status: "idle" | "loading" }
    | {
        status: "ok";
        coinAmount: string;
        coin: string;
        /** The coin/network pair upstream accepted for this plan. */
        settlement: { coin: string; network: string };
      }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const [placing, setPlacing] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const planReq = useRef(0);
  const priceReq = useRef(0);

  useEffect(() => {
    const id = ++planReq.current;
    setLoadingPlans(true);
    setPlans(null);
    setSelected(null);

    fetch(`/api/shop/esim?destination=${destination}`)
      .then((r) => r.json())
      .then((d) => {
        if (id !== planReq.current) return;
        const list: Plan[] = d.plans ?? [];
        setPlans(list);
        setSelected(list[0]?.denomination ?? null);
        setLoadingPlans(false);
      })
      .catch(() => {
        if (id === planReq.current) { setPlans([]); setLoadingPlans(false); }
      });
  }, [destination]);

  const fetchPrice = useCallback(async () => {
    if (!selected) return setPrice({ status: "idle" });
    const id = ++priceReq.current;
    setPrice({ status: "loading" });

    try {
      const res = await fetch("/api/shop/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          family: "eSIM",
          brand: "eSIM",
          countryCode: destination,
          coin: DEFAULT_SETTLEMENT.coin,
          network: DEFAULT_SETTLEMENT.network,
          denomination: selected,
        }),
      });
      const d = await res.json();
      if (id !== priceReq.current) return;

      if (!res.ok || !d.ok) {
        return setPrice({ status: "error", message: d.error ?? "This plan is not available." });
      }
      setPrice({
        status: "ok",
        coinAmount: d.coinAmount,
        coin: d.coin,
        settlement: d.settlement ?? DEFAULT_SETTLEMENT,
      });
    } catch {
      if (id === priceReq.current) setPrice({ status: "error", message: "Could not get a price." });
    }
  }, [selected, destination]);

  useEffect(() => {
    const t = setTimeout(fetchPrice, 240);
    return () => clearTimeout(t);
  }, [fetchPrice]);

  const emailValid = EMAIL.test(email.trim());
  const canBuy = price.status === "ok" && emailValid && !placing && !!selected;

  async function buy() {
    if (!selected) return;
    setPlacing(true);
    setOrderError(null);
    try {
      const res = await fetch("/api/shop/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          family: "eSIM",
          brand: "eSIM",
          countryCode: destination,
          // Whatever the quote settled on: the order has to match it.
          coin: price.status === "ok" ? price.settlement.coin : DEFAULT_SETTLEMENT.coin,
          network: price.status === "ok" ? price.settlement.network : DEFAULT_SETTLEMENT.network,
          denomination: selected,
          email: email.trim(),
          ...(account ? { refundAddress: account } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setOrderError(d.error ?? "The order could not be placed.");
        setPlacing(false);
        return;
      }
      const order = d.order as Record<string, unknown>;
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

  return (
    <div className="sh-esim-shop">
      <div>
        <label className="sh-field" style={{ marginTop: 0, maxWidth: 360 }}>
          <span className="lab">Select country or region</span>
          <select
            className="sh-select"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            {ESIM_DESTINATIONS.map((d) => (
              <option key={d.code} value={d.code}>
                {destinationFlag(d.code)}  {d.name}
              </option>
            ))}
          </select>
        </label>

        <div style={{ marginTop: 30 }}>
          <span className="sh-legend">Select data plan</span>

          {loadingPlans && (
            <ul className="sh-plans">
              {[0, 1, 2].map((i) => <li key={i} className="sh-skel" />)}
            </ul>
          )}

          {!loadingPlans && plans?.length === 0 && (
            <div className="sh-tell">
              <b>No eSIM plans for {destinationName(destination)} right now.</b>
              <br />
              Pick another destination — coverage changes often.
            </div>
          )}

          {!loadingPlans && plans && plans.length > 0 && (
            <ul className="sh-plans">
              {plans.map((p) => (
                <li key={p.denomination}>
                  <button
                    type="button"
                    className={`sh-plan${selected === p.denomination ? " on" : ""}`}
                    onClick={() => setSelected(p.denomination)}
                    aria-pressed={selected === p.denomination}
                  >
                    <span>
                      <span className="big">{p.unlimited ? "Unlimited" : p.data ? `${p.data.amount} ${p.data.unit}` : p.label}</span>
                      <span className="small">
                        {p.days ? `Valid ${p.days} days` : p.label} · {destinationName(destination)}
                      </span>
                    </span>
                    {/* What it costs, in dollars, and nothing else. The row
                        used to carry the plan's face value under the price —
                        "2.77 USDC / ≈ $1.47" — which reads as an exchange rate
                        and is not one: a dollar stablecoin next to a smaller
                        dollar figure says the price is wrong. The face value of
                        a data plan is not what anyone is deciding on. */}
                    <span className="price">
                      {p.coinAmount ? formatMoney(Number(p.coinAmount), "USD") : "—"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="sh-sticky">
        <div className="sh-panel">
          <label className="sh-field" style={{ marginTop: 0 }}>
            <span className="lab">Send the QR code to</span>
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
            {price.status === "ok" ? (
              <span className="v">{formatMoney(Number(price.coinAmount), "USD")}</span>
            ) : price.status === "error" ? (
              <span className="v bad">{price.message}</span>
            ) : (
              <span className="v dim">······</span>
            )}
          </div>

          {orderError && <p className="sh-warn">{orderError}</p>}

          <button type="button" className="button button-ink sh-cta" onClick={buy} disabled={!canBuy}>
            {placing ? "Placing order…" : "Buy eSIM"}
          </button>

          <p className="sh-foot-note">You get a QR code by email. Activate on arrival.</p>
        </div>
      </div>
    </div>
  );
}
