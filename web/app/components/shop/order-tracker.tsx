"use client";
import { useEffect, useState } from "react";
import { PayPanel } from "./pay-panel";
import { payTarget } from "../../../lib/shop/settlement";
import { denominationLabel } from "../../../lib/shop/money";
import type { PayGroupView } from "./token-picker";

/**
 * Shape confirmed against a real order. The payment fields sit at the top level
 * of the order object — not nested under `payment`.
 */
type Delivery = {
  delivery_state?: string;
  deliverable?: {
    brand_name?: string;
    family?: string;
    brand_logo?: string;
    /** The brand's own backdrop, shipped alongside the logo. */
    brand_bg_color?: string;
    localized_denomination?: string;
    denomination?: string;
    /** Range-priced orders carry their value here, not in the denomination. */
    product_value?: number | string | null;
    currency_code?: string | null;
    /** Where it went: an email address, or a phone number for a top-up. */
    beneficiary_account?: string | null;
    delivery_type?: string | null;
    /**
     * The redeem code. Null on a direct top-up, which has nothing to redeem —
     * the credit is applied to the number instead.
     */
    pin_code?: string | null;
    pin_serial?: string | null;
    security_code?: string | null;
    /** The carrier's own reference for a top-up. Worth showing for disputes. */
    operator_reference?: string | null;
    redeem_instructions?: string | null;
    barcode_image_url?: string | null;
    qr_image_url?: string | null;
    failure_reason?: string | null;
    error_description?: string | null;
  };
};

type Order = {
  order_id?: string;
  order_state?: string;
  payment_state?: string;
  wallet_address?: string;
  coin?: string;
  coin_amount?: string;
  network?: string;
  deliveries?: Delivery[];
};

/**
 * Observed upstream values: order_state is "WaitingForPayment" then "Done";
 * delivery_state is "WaitingForPayment" then "Succeeded"; payment_state is
 * "PaymentRequested" then "PaymentReceived". Matched exactly rather than by
 * substring, so an unrecognised state falls through to "pending" and keeps
 * polling instead of being guessed at.
 */
const DONE = new Set(["done", "completed", "delivered", "success", "succeeded", "fulfilled"]);
const DEAD = new Set(["expired", "cancelled", "canceled", "failed", "refunded", "rejected"]);

/**
 * Payment states, read as carefully as the order states above.
 *
 * The first version treated anything that was not "PaymentRequested" as money
 * safely in hand, and a real order proved how wrong that is: 119.36 USDC
 * arrived against 118.21 owed and the supplier answered `PaymentQuarantined` —
 * received, held, not credited, nothing delivered. The page told that buyer
 * "Payment received. Preparing your card" and spun for as long as they cared to
 * watch. A payment that needs a human is the one state where saying nothing is
 * better than guessing, and saying the opposite is worst of all.
 *
 * So only these count as money in hand.
 */
const PAYMENT_SETTLED = new Set([
  "paymentreceived",
  "paymentconfirmed",
  "paymentcompleted",
  "paymentsucceeded",
]);

/** And these need a person, not another poll. */
const PAYMENT_HELD = new Set([
  "paymentquarantined",
  "paymentfailed",
  "paymentrejected",
  "paymentexpired",
  "paymentcancelled",
  "paymentrefunded",
  "paymentunderpaid",
]);

/**
 * Where someone goes when an order stalls.
 *
 * Offered only after a payment has gone out, and then only on a delay: an order
 * that lands in forty seconds needs no help, and a support link sitting under
 * every purchase suggests it often goes wrong. Two minutes is roughly twice the
 * normal wait — long enough that something is genuinely off, short enough to
 * still feel looked after.
 */
const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL ?? "https://t.me/basestocksalerts";
const SUPPORT_AFTER_MS = 2 * 60_000;

/**
 * A turning ring, for a state that is genuinely working rather than merely
 * waiting. A pulsing dot reads as decoration; a spinner reads as something in
 * progress, which is the difference the buyer wants to see while an order
 * settles.
 */
function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="sh-spin" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type StepState = "done" | "active" | "todo";

function StepMark({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className="mk ok">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.9 6.1l-4.4 4.4a.9.9 0 01-1.3 0L4.1 8.4a.9.9 0 011.3-1.3l1.4 1.5 3.8-3.8a.9.9 0 011.3 1.3z" />
        </svg>
      </span>
    );
  }
  if (state === "active") return <span className="mk active"><Spinner /></span>;
  return (
    <span className="mk todo">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </span>
  );
}

/**
 * Where the order has got to, in the three milestones a buyer cares about.
 *
 * Mapped onto what the supplier actually reports, not invented: the payment
 * step closes when `payment_state` stops saying "requested", and delivery
 * closes when the order reaches a done state.
 */
function Progress({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <ol className="sh-steps">
      {steps.map((s) => (
        <li key={s.label} className={s.state === "active" ? "active" : s.state === "todo" ? "todo" : ""}>
          <StepMark state={s.state} />
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function normalise(state: string) {
  return state.toLowerCase().replace(/[^a-z]/g, "");
}

function classify(state: string) {
  const s = normalise(state);
  return { done: DONE.has(s), dead: DEAD.has(s) };
}

/** "WaitingForPayment" -> "Waiting for payment" */
function humanise(state: string) {
  const spaced = state.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function OrderTracker({
  orderId,
  payGroups,
}: {
  orderId: string;
  /**
   * What can be spent, resolved on the server.
   *
   * Threaded through rather than fetched here because the marks come from the
   * equities' own `contractURI()`, which is a chain read: doing it on the server
   * means the picker is correct in its first paint instead of filling in a
   * moment later, and no visitor pays for the read.
   */
  payGroups: PayGroupView[];
}) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** Flips once the order has been waiting long enough to offer help. */
  const [waitedLongEnough, setWaitedLongEnough] = useState(false);
  /**
   * A transfer has left the buyer's wallet. Deliberately not the same thing as
   * a paid order: only the supplier can say that, and it says it through
   * `payment_state` on the next poll. Kept apart so the page never claims more
   * than it knows.
   */
  const [transferSent, setTransferSent] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/shop/order/${encodeURIComponent(orderId)}`);
        const data = await res.json();
        if (!alive) return;

        if (!res.ok || !data.ok) {
          setError(data.error ?? "Could not load this order.");
          return;
        }

        const next = data.order as Order;
        setOrder(next);

        const { done, dead } = classify(next.order_state ?? "");
        if (!done && !dead) timer = setTimeout(poll, 5000);
      } catch {
        if (alive) timer = setTimeout(poll, 8000);
      }
    }

    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [orderId]);

  /**
   * The clock starts at payment, not at checkout.
   *
   * Before money has moved there is nothing for support to chase — the order is
   * simply unpaid, and offering help would read as something having gone wrong
   * when nothing has.
   */
  useEffect(() => {
    const paymentState = normalise(order?.payment_state ?? "");
    const acknowledged = paymentState !== "" && paymentState !== "paymentrequested";
    if (!acknowledged && !transferSent) return;
    const timer = setTimeout(() => setWaitedLongEnough(true), SUPPORT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [order?.payment_state, transferSent]);

  async function copy(value: string, tag: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* clipboard unavailable — the value is on screen to copy by hand */
    }
  }

  if (error) {
    return (
      <div className="sh-panel">
        <p className="err" style={{ marginTop: 0, fontWeight: 600 }}>{error}</p>
        <p className="sh-hint">Check the order reference and try again.</p>
      </div>
    );
  }

  if (!order) {
    return <div className="sh-panel"><p className="muted">Loading order…</p></div>;
  }

  const state = order.order_state ?? "Pending";
  const { done, dead } = classify(state);

  // Gate the pay block on the payment state as well as the order state: an
  // unfamiliar order_state must never leave a paid order still asking for
  // money. An absent payment_state falls back to the order state rather than
  // hiding the instructions on an order that genuinely still needs paying.
  const paymentState = normalise(order.payment_state ?? "");
  const stillUnpaid = paymentState === "" || paymentState === "paymentrequested";
  const awaitingPayment = !done && !dead && stillUnpaid && Boolean(order.wallet_address);
  /** Held by the supplier. Polling will not move it; only a person will. */
  const held = !done && PAYMENT_HELD.has(paymentState);
  /** Money actually in their hands — claimed only when they say so. */
  const settling = !done && !dead && !held && PAYMENT_SETTLED.has(paymentState);
  /**
   * Paid, unheld, and in a state we do not recognise. Not a reason to claim
   * anything: the steps still show, because something is clearly happening, but
   * the first one stays "sent" rather than "received" until the supplier uses a
   * word we know.
   */
  const inFlight = !done && !dead && !held && !settling && !stillUnpaid;
  const target = payTarget(order);
  const stalled = !done && !dead && !held && waitedLongEnough;

  return (
    <div>
      <div className="sh-panel">
        <div className="sh-status">
          <span className={`sh-state${done ? " done" : dead ? " dead" : ""}`}>
            {!done && !dead && <Spinner />}
            {humanise(state)}
          </span>
          <span className="sh-ref">{order.order_id ?? orderId}</span>
        </div>

        {/* Paying is the checkout's job — see the panel below. The raw address
            and amount used to sit here, but showing both invited the commonest
            way to lose money on this page: paying the exact figure by hand on
            the wrong network. */}
        {awaitingPayment && (
          <p className="sh-sub">
            {transferSent
              ? "Your transfer is on its way. This page updates itself the moment the order confirms it."
              : "Connect your wallet below to pay. This page updates itself the moment the payment lands."}
          </p>
        )}

        {!dead && !held && (settling || done || transferSent || inFlight) && (
          <Progress
            steps={[
              {
                label: settling || done ? "Payment received" : "Payment sent",
                state: settling || done ? "done" : "active",
              },
              { label: "Preparing your card", state: done ? "done" : settling ? "active" : "todo" },
              { label: "Delivered", state: done ? "done" : "todo" },
            ]}
          />
        )}

        {/* Held. The money arrived and the supplier is sitting on it, which is
            neither success nor failure and is the one state this page cannot
            resolve by waiting. Say so plainly, with the reference and the way
            to reach a human, and stop pretending a card is being prepared. */}
        {held && (
          <div className="sh-held">
            <p className="t">This payment is on hold</p>
            <p className="d">
              Your transfer arrived, and the supplier has put it under review before releasing the
              order — nothing has been charged twice and nothing is lost. This does not clear by
              itself: message us with the reference above and we will chase it for you.
            </p>
            <a className="button button-ink" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
              Get this sorted →
            </a>
          </div>
        )}

        {done && <p className="sh-hint">A copy has been emailed to you.</p>}
        {dead && <p className="sh-sub">This order is no longer active. Nothing further will be charged.</p>}
      </div>

      {order.deliveries?.map((d, i) => {
        const item = d.deliverable ?? {};
        const code = item.pin_code;
        const toPhone = item.delivery_type === "by_phone";
        const itemDone = classify(d.delivery_state ?? "").done;
        // An eSIM activation code is an LPA string.
        const isEsim = Boolean(code?.startsWith("LPA:"));
        // The supplier's barcode endpoint defaults to 64px; ask for a size a
        // camera can actually read.
        const upscale = (url: string, w: number, h: number) =>
          url.replace(/([?&])w=\d+/, `$1w=${w}`).replace(/([?&])h=\d+/, `$1h=${h}`);
        const itemQr = item.qr_image_url ? upscale(item.qr_image_url, 512, 512) : null;
        // Barcodes are wide, not square.
        const itemBarcode = item.barcode_image_url ? upscale(item.barcode_image_url, 640, 220) : null;

        return (
          <div className="sh-panel" key={i}>
            <div className="sh-item-head">
              <div className="sh-item-id">
                {item.brand_logo && (
                  <span className="sh-item-logo" style={{ backgroundColor: item.brand_bg_color || "var(--card)" }}>
                    <img src={item.brand_logo} alt="" />
                  </span>
                )}
                <div style={{ minWidth: 0 }}>
                  <h2>{item.brand_name ?? item.family ?? "Gift card"}</h2>
                  {/* Never the raw denomination: a range-priced order comes
                      back with the literal string "range" in both denomination
                      fields. See `denominationLabel`. */}
                  <div className="den">{denominationLabel(item)}</div>
                </div>
              </div>
              <span className="sh-ref">{d.delivery_state && humanise(d.delivery_state)}</span>
            </div>

            {/* A direct top-up has no code to show — the credit went straight to
                the number, so confirm which one, plus the carrier's reference in
                case the customer has to chase it. */}
            {itemDone && !code && toPhone && item.beneficiary_account && (
              <div className="sh-deliver">
                <div className="k">Credited to</div>
                <code className="code">{item.beneficiary_account}</code>
                <p className="sub">The balance is on the number now — there is no code to redeem.</p>
                {item.operator_reference && (
                  <p className="sub mono">Operator reference {item.operator_reference}</p>
                )}
              </div>
            )}

            {itemDone && !code && !toPhone && item.beneficiary_account && (
              <div className="sh-deliver">
                <div className="k">Sent to</div>
                <code className="code">{item.beneficiary_account}</code>
                <p className="sub">Check your inbox for the details.</p>
              </div>
            )}

            {/* An eSIM activation code is meant to be scanned, not typed. The
                supplier renders one but defaults to 64px, too small to read. */}
            {code && itemQr && (
              <div className="sh-scan">
                <h3>Scan to install</h3>
                <p>
                  On the phone that will use the eSIM, open the camera or the Add eSIM screen and scan
                  this.
                </p>
                <img src={itemQr} alt="eSIM installation QR code" width={220} height={220} />
                <p className="sh-hint" style={{ textAlign: "center" }}>
                  Reading this on the same phone? Use the code below instead.
                </p>
              </div>
            )}

            {code && (
              <div className="sh-deliver">
                <div className="k">{isEsim ? "Manual activation code" : "Your redeem code"}</div>
                <code className="code">{code}</code>
                <button
                  type="button"
                  className="button button-ghost"
                  style={{ marginTop: 12, padding: "8px 16px", fontSize: "0.85rem" }}
                  onClick={() => copy(code, `code-${i}`)}
                >
                  {copied === `code-${i}` ? "Copied" : "Copy code"}
                </button>
                {item.pin_serial && <p className="sub mono">Serial {item.pin_serial}</p>}
                {item.security_code && <p className="sub mono">Security code {item.security_code}</p>}
              </div>
            )}

            {(item.failure_reason || item.error_description) && (
              <p className="sh-warn">{item.failure_reason ?? item.error_description}</p>
            )}

            {/* In-store cards ship a barcode for the till. Same reasoning as the
                eSIM QR: it exists to be scanned, and the default size is
                unreadable. */}
            {code && itemBarcode && (
              <div className="sh-scan">
                <h3>Scan in store</h3>
                <p>Show this at the till. The code below works too if the scanner will not read it.</p>
                <img src={itemBarcode} alt="Barcode for in-store redemption" style={{ width: "100%", maxWidth: 420, height: "auto" }} />
              </div>
            )}

            {isEsim && (
              <div className="sh-tell" style={{ marginTop: 16 }}>
                <b>Installing it</b>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                  <li><b>iPhone</b> — Settings → Mobile Service → Add eSIM → Use QR Code.</li>
                  <li><b>Android</b> — Settings → Network &amp; internet → SIMs → Add eSIM.</li>
                  <li>Turn on <b>data roaming</b> for the new eSIM once you arrive, or it will not connect.</li>
                </ul>
                <p style={{ margin: "10px 0 0" }}>
                  Install it before you travel, while you have Wi-Fi — the code is single-use, and
                  removing the eSIM may make it unrecoverable.
                </p>
              </div>
            )}

            {code && item.redeem_instructions && (
              <details className="sh-fold" style={{ marginTop: 8 }}>
                <summary>
                  How to redeem
                  <svg className="chev" width="13" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                    <path d="M1 1l5 5 5-5" strokeLinecap="round" />
                  </svg>
                </summary>
                {/* Sanitised server-side before it reaches this component. */}
                <div className="body" dangerouslySetInnerHTML={{ __html: item.redeem_instructions }} />
              </details>
            )}
          </div>
        );
      })}

      {/* The only way to pay. `payTarget` returns null unless the order is
          denominated in something this rail can actually deliver, so an order
          created outside that set shows nothing rather than a payment that could
          never settle. */}
      {awaitingPayment && target && (
        <PayPanel
          target={target}
          groups={payGroups}
          onSent={() => setTransferSent(true)}
          /**
           * Who paid, written down the moment they commit.
           *
           * The supplier's refund field closed when the order was created, and
           * by then most buyers had not connected a wallet — so if this one has
           * to be unwound, our own ledger is the only place that knows where
           * the money should go back to. Fire and forget: bookkeeping must
           * never stand between a buyer and their payment.
           */
          onPayer={(address) => {
            void fetch(`/api/shop/order/${encodeURIComponent(orderId)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ address }),
            }).catch(() => {});
          }}
        />
      )}

      {stalled && (
        <a className="sh-panel sh-help" href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
          <span className="tg">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.72 0-.6-.27-.84-.95L6.3 13.7l-5.45-1.7c-1.18-.35-1.19-1.16.26-1.75l21.26-8.2c.97-.43 1.9.24 1.53 1.73z" />
            </svg>
          </span>
          <span style={{ minWidth: 0 }}>
            <span className="t">Taking longer than usual</span>
            <span className="d">
              Orders normally land within a minute. Message us on Telegram with your order number and
              we will chase it.
            </span>
          </span>
          <span className="arrow" aria-hidden>→</span>
        </a>
      )}
    </div>
  );
}
