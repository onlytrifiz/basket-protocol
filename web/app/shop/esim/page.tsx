import type { Metadata } from "next";
import { EsimShop } from "../../components/shop/esim-shop";
import { activeCountry } from "../../../lib/shop/store";
import { ESIM_DESTINATIONS } from "../../../lib/shop/esim-destinations";

export const metadata: Metadata = {
  title: "Buy an eSIM with crypto",
  description:
    "Data plans for 100+ destinations, paid from Base. QR code delivered by email. No ID required.",
};

const FEATURES = [
  { t: "Digital delivery", d: "QR code by email" },
  { t: "Instant activation", d: "Scan and connect" },
  { t: "No ID required", d: "Pay in crypto only" },
  { t: "100+ destinations", d: "Country-specific plans" },
];

const STEPS = [
  { n: "1", t: "Add the eSIM", d: "Open Settings → Mobile Data → Add eSIM on your phone." },
  { n: "2", t: "Scan the QR code", d: "Use the code from your order page or the confirmation email." },
  { n: "3", t: "Turn on roaming", d: "Enable data roaming for the new eSIM. The plan starts when you arrive." },
];

export default async function EsimPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  const { d } = await searchParams;
  const shopCountry = await activeCountry();

  // Default the destination to where the shopper is, when we sell plans there.
  const requested = d?.toUpperCase();
  const initial =
    requested && ESIM_DESTINATIONS.some((x) => x.code === requested)
      ? requested
      : ESIM_DESTINATIONS.some((x) => x.code === shopCountry)
        ? shopCountry
        : "US";

  return (
    <div className="wrap sh-page">
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">eSIM</span>
      </nav>

      <section className="sh-esim-intro">
        <div>
          <h1 className="sh-h1">Data abroad, paid from your wallet.</h1>
          <p className="sh-sub">
            Stay connected without roaming charges or hunting for a local SIM shop. Pay from
            Base and get a QR code by email — no credit card, no ID check.
          </p>
          <ul className="sh-feat">
            {FEATURES.map((f) => (
              <li key={f.t}>
                <div className="t">{f.t}</div>
                <div className="d">{f.d}</div>
              </li>
            ))}
          </ul>
        </div>

        <div className="sh-panel">
          <h3>Works the same everywhere</h3>
          <ol className="sh-howto">
            {STEPS.map((s) => (
              <li key={s.n}>
                <span className="n">{s.n}</span>
                <span>
                  <span className="t">{s.t}</span>
                  <span className="d">{s.d}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section style={{ marginTop: 48, paddingTop: 40, borderTop: "1px solid var(--line)" }}>
        <EsimShop initialDestination={initial} />
      </section>

      <section className="sh-panel" style={{ marginTop: 48 }}>
        <h3>Before you buy</h3>
        <ul className="sh-checklist">
          <li>Your phone must support eSIM and be carrier-unlocked.</li>
          <li>Keep your main SIM active for calls and your own number.</li>
          <li>Plans are data-only and start when you connect on arrival.</li>
          <li>Each QR code installs once — save the email.</li>
        </ul>
      </section>
    </div>
  );
}
