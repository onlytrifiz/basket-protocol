import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Track an order" };

async function findOrder(formData: FormData) {
  "use server";
  const id = String(formData.get("orderId") ?? "").trim();
  if (id) redirect(`/shop/order/${encodeURIComponent(id)}`);
}

export default function TrackOrderPage() {
  return (
    <div className="wrap sh-page" style={{ maxWidth: 620 }}>
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">Track an order</span>
      </nav>

      <h1 className="sh-h1">Track an order</h1>
      <p className="sh-sub">Enter the order reference from your confirmation email.</p>

      <form action={findOrder} className="row" style={{ marginTop: 22 }}>
        <label style={{ flex: 1, minWidth: 200 }}>
          <span className="sh-sr">Order reference</span>
          <input className="sh-input mono" name="orderId" required placeholder="ord_abc123xyz" style={{ marginTop: 0 }} />
        </label>
        <button type="submit" className="button button-ink">Find order</button>
      </form>
    </div>
  );
}
