import type { Metadata } from "next";
import { getCatalog } from "../../../lib/shop/cryptorefills";
import { activeCountry } from "../../../lib/shop/store";
import { countryName } from "../../../lib/shop/countries";
import { BrandTile } from "../../components/shop/brand-tile";
import { PayWithMarks } from "../../components/shop/pay-with-marks";

export const metadata: Metadata = {
  title: "Mobile top-ups",
  description:
    "Top up a phone with $BACKED or a tokenized share. The credit lands on the number itself, usually within a minute.",
};

/**
 * The supplier splits phone credit across three categories — plain credit,
 * data bundles, and talk time — which is a distinction about how the operator
 * books it, not about what anyone is shopping for. Shown as one page.
 */
const TOPUP_CATEGORIES = ["mobile_credits", "mobile_bundle", "mobile_talk_time"];

const NOTES = [
  {
    t: "It goes to the number, not to you",
    d: "There is no code to redeem. Enter the number at checkout and the credit lands on it directly.",
  },
  {
    t: "The country has to match",
    d: "A top-up sold for Italy only credits an Italian number. The checkout refuses a number that does not belong to the operator's country.",
  },
  {
    t: "It cannot be undone",
    d: "Check the number before paying — a transfer to the wrong one is gone, the same as cash.",
  },
  {
    t: "Some operators sell a voucher instead",
    d: "Where both exist, a PIN option is offered alongside: you get a code by email and redeem it on any number yourself.",
  },
];

export default async function TopUpsPage() {
  const country = await activeCountry();
  const catalog = await getCatalog(country);

  const seen = new Set<string>();
  const brands = TOPUP_CATEGORIES.flatMap((key) => catalog.byCategory[key] ?? []).filter((b) => {
    if (b.outOfStock || seen.has(b.slug)) return false;
    seen.add(b.slug);
    return true;
  });

  return (
    <div className="wrap sh-page">
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">Mobile top-ups</span>
      </nav>

      <section className="sh-esim-intro">
        <div>
          <h1 className="sh-h1">Put credit on a phone.</h1>
          <p className="sh-sub">
            {brands.length
              ? `${brands.length} operators in ${countryName(country)}, paid for with $BACKED or a tokenized share. The balance lands on the number itself — usually within a minute of the payment.`
              : `No operators are on sale for ${countryName(country)} right now. Switch the country at the top of the page — coverage differs by market.`}
          </p>
          <div style={{ marginTop: 26 }}>
            <PayWithMarks label="Pay with" />
          </div>
        </div>

        <div className="sh-panel">
          <h3>Before you top up</h3>
          <ol className="sh-howto">
            {NOTES.map((n, i) => (
              <li key={n.t}>
                <span className="n">{i + 1}</span>
                <span>
                  <span className="t">{n.t}</span>
                  <span className="d">{n.d}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {brands.length > 0 && (
        <section style={{ marginTop: 48, paddingTop: 40, borderTop: "1px solid var(--line)" }}>
          <div className="sh-rail-head">
            <h2>Operators in {countryName(country)}</h2>
          </div>
          <div className="sh-grid">
            {brands.map((b) => (
              <BrandTile key={b.slug} brand={b} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
