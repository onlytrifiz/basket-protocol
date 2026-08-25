import type { Metadata } from "next";
import { OrderTracker } from "../../../components/shop/order-tracker";
import { payGroups } from "../../../../lib/shop/pay-groups";

export const metadata: Metadata = { title: "Your order" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Resolved here so the pay-with list carries the equities' own marks and is
  // right in the first paint. See `lib/shop/pay-groups`.
  const groups = await payGroups();

  return (
    <div className="wrap sh-page" style={{ maxWidth: 720 }}>
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">Order</span>
      </nav>

      {/* No status line here: the tracker knows the state and says it there, so
          a static "waiting for payment" note cannot go stale. */}
      <h1 className="sh-h1" style={{ marginBottom: 22 }}>
        Your order
      </h1>

      <OrderTracker orderId={id} payGroups={groups} />
    </div>
  );
}
