import { payGroups } from "../../../lib/shop/pay-groups";
import { PayMark } from "./token-picker";

/**
 * A handful of the things you can pay with, as marks.
 *
 * Reads the same list the checkout does, so the storefront and the payment
 * panel cannot drift into advertising different assets. The equities lead
 * because they are the point — a share of Apple buying an Apple gift card — and
 * the row stops at six because a wall of logos stops being read.
 */
export async function PayWithMarks({ label }: { label?: string }) {
  const groups = await payGroups();
  const marks = groups.flatMap((g) => g.tokens).slice(0, 6);
  if (!marks.length) return null;

  return (
    <p className="sh-paywith">
      {label && <span className="k">{label}</span>}
      <span className="marks">
        {marks.map((t) => (
          <span key={t.address} title={t.name}>
            <PayMark token={t} size={25} />
          </span>
        ))}
      </span>
      <span className="more">and more</span>
    </p>
  );
}
