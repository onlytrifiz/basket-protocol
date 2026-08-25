import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasDatabase, listOrders, orderStats } from "../../../../lib/shop/db";
import { formatMoney } from "../../../../lib/shop/money";

export const metadata: Metadata = { title: "Orders", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Internal order ledger. Guarded by a shared token in ADMIN_TOKEN — this page
 * lists customer emails and phone numbers, so it must never be reachable
 * without one. If no token is configured the page does not exist at all, rather
 * than defaulting to open.
 */
function authorised(token: string | undefined) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  return token === expected;
}

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase().replace(/[^a-z]/g, "");
  const done = ["done", "completed", "delivered", "succeeded"].includes(s);
  const dead = ["expired", "cancelled", "canceled", "failed", "refunded"].includes(s);
  return <span className={`sh-state${done ? " done" : dead ? " dead" : ""}`}>{status}</span>;
}

/**
 * Payment states worth a second line under the order state.
 *
 * An order sat at "PaymentStarted" while its payment said "PaymentQuarantined"
 * — money received, held, nothing delivered — and this table showed only the
 * first of those, so from here it looked like any other unpaid order. The
 * distinction is the whole reason to open this page.
 */
const PAYMENT_NEEDS_A_HUMAN = /quarantin|fail|reject|underpaid|expired|refund/i;

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; all?: string }>;
}) {
  const { token, all } = await searchParams;
  if (!authorised(token)) notFound();

  // The database is shared with the other storefront, so "everything in the
  // table" and "what this shop sold" are different questions. The default
  // answers the second one.
  const everySource = all === "1";

  if (!hasDatabase()) {
    return (
      <div className="wrap sh-page" style={{ maxWidth: 680 }}>
        <h1 className="sh-h1">Orders</h1>
        <p className="sh-sub">
          No database is configured. Set <span className="c">DATABASE_URL</span> and orders will
          start being recorded — the shop works either way, since CryptoRefills remains the system
          of record.
        </p>
      </div>
    );
  }

  const [orders, stats] = await Promise.all([
    listOrders(200, everySource),
    orderStats(everySource),
  ]);

  return (
    <div className="wrap sh-page">
      <h1 className="sh-h1">Orders</h1>
      <p className="sh-sub">
        {everySource
          ? "Every row in the ledger, including the other storefront's."
          : "Sold through the shop. CryptoRefills remains the system of record; redeem codes are deliberately not stored here."}{" "}
        <a
          href={`/shop/admin/orders?token=${encodeURIComponent(token ?? "")}${everySource ? "" : "&all=1"}`}
          style={{ color: "var(--lime-deep)", fontWeight: 600 }}
        >
          {everySource ? "Show only this shop →" : "Show every source →"}
        </a>
      </p>

      {stats && (
        <div className="sh-admin-stats">
          <div className="vs">
            <div className="k">Orders</div>
            <div className="v">{stats.total}</div>
          </div>
          <div className="vs">
            <div className="k">Delivered</div>
            <div className="v">{stats.delivered}</div>
          </div>
          <div className="vs">
            <div className="k">Open</div>
            <div className="v">{stats.pending}</div>
          </div>
          <div className="vs">
            <div className="k">Delivered value</div>
            <div className="v" style={{ fontSize: "1.15rem" }}>
              {stats.revenueByCurrency.length
                ? stats.revenueByCurrency
                    .map((r) => formatMoney(Number(r.total), r.currency))
                    .join(" · ")
                : "—"}
            </div>
          </div>
        </div>
      )}

      {orders.length === 0 ? (
        <p className="sh-empty">No orders recorded yet. They appear here as soon as one is placed.</p>
      ) : (
        <div className="vault-table-card" style={{ marginTop: 18, overflowX: "auto" }}>
          <table className="vtable" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>Placed</th>
                <th>Brand</th>
                <th>Value</th>
                <th>Paid</th>
                <th>Delivered to</th>
                {everySource && <th>Source</th>}
                <th>Status</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.order_id}>
                  <td className="mono muted" style={{ fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                    {new Date(o.created_at).toLocaleString("en-GB", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{o.brand}</div>
                    {o.denomination && <div className="mono muted" style={{ fontSize: "0.76rem" }}>{o.denomination}</div>}
                  </td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {o.face_value ? formatMoney(Number(o.face_value), o.currency ?? "USD") : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>
                    {o.coin_amount} {o.coin}
                  </td>
                  <td style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
                    {o.phone ?? o.email ?? "—"}
                    {/* Where a refund would go. Shown next to the customer
                        rather than in a column of its own: the two are only
                        ever needed together, and only when something has gone
                        wrong. */}
                    {o.payer_address && (
                      <div className="mono muted" style={{ fontSize: "0.7rem", marginTop: 3 }}>
                        paid from {o.payer_address.slice(0, 10)}…{o.payer_address.slice(-6)}
                      </div>
                    )}
                  </td>
                  {everySource && (
                    // Null is left as a dash rather than named: rows predating
                    // the column were written by something else, and saying
                    // which would be a guess dressed as a record.
                    <td className="mono muted" style={{ fontSize: "0.78rem" }}>{o.source ?? "—"}</td>
                  )}
                  <td>
                    <StatusPill status={o.status} />
                    {o.payment_status && PAYMENT_NEEDS_A_HUMAN.test(o.payment_status) && (
                      <div
                        className="mono"
                        style={{ marginTop: 5, fontSize: "0.72rem", fontWeight: 700, color: "#b23b3b" }}
                      >
                        ⚠ {o.payment_status}
                      </div>
                    )}
                  </td>
                  <td>
                    <a className="mono" style={{ fontSize: "0.78rem", color: "var(--lime-deep)" }} href={`/shop/order/${o.order_id}`}>
                      {o.order_id.slice(0, 8)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
