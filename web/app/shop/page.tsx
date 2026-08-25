import { countBrands, getCatalog } from "../../lib/shop/cryptorefills";
import { activeCountry } from "../../lib/shop/store";
import { categoryLabel, countryFlag, countryName } from "../../lib/shop/countries";
import { BrandTile } from "../components/shop/brand-tile";
import { BrandRail } from "../components/shop/brand-rail";
import { CategoryStrip } from "../components/shop/category-strip";
import { PayWithMarks } from "../components/shop/pay-with-marks";
import { RingMarker } from "../components/segment-ring";

/** Category rails shown on the storefront, in the order shoppers expect. */
const HOME_RAILS = ["e-commerce", "games", "streaming", "food", "retail", "travel_flights"];

export default async function ShopPage() {
  const country = await activeCountry();
  /**
   * Two counts, because they answer different questions: how big is this shop,
   * and what can *I* buy. The supplier has no global brand endpoint —
   * /v2/brands needs a country — so the headline figure is assembled from thirty
   * markets and counted rather than claimed. Null on a supplier wobble, and the
   * copy falls back to the local count rather than printing a gap.
   */
  const [catalog, worldwide] = await Promise.all([
    getCatalog(country),
    countBrands().catch(() => null),
  ]);

  const popular = catalog.all.filter((b) => !b.outOfStock).slice(0, 6);

  return (
    <>
      {/* The same band the home page opens with — full-bleed, hairline-ruled,
          with the soft chip glow at the top — rather than a rounded gradient
          card floating on the page. The shop is a room in this building, and
          this is the shape its front door is. */}
      <header className="hero-card sh-hero-band">
        <div className="hero-inner sh-hero">
          <div className="hero-copy">
            <p className="eyebrow">Gift cards · eSIM · top-ups</p>
            {/* The second line in Base Blue rather than in italic. The italic
                was the borrowed part — this site sets its emphasis in colour,
                the way the home page's "Receive stocks." does. */}
            <h1>
              Your dividends.
              <br />
              <span>Spent on something real.</span>
            </h1>
            {/* Both figures, stated together. One on its own always reads as a
                contradiction of the other — a headline counting the whole
                catalogue next to a shelf counting your country. */}
            <p className="hero-lede">
              Stockify pays holders in tokenized stock. This is where that stock buys something:
              gift cards, eSIM data and mobile top-ups.{" "}
              {worldwide
                ? `${worldwide.toLocaleString()} brands, ${catalog.all.length} of them on sale in ${countryName(country)}.`
                : `${catalog.all.length} brands in ${countryName(country)}.`}{" "}
              A share of Apple buys an Apple gift card.
            </p>
            <div className="hero-actions">
              <a className="button button-ink" href="/shop/brands">
                Browse all brands <span>→</span>
              </a>
              <a className="button button-ghost" href="/shop/esim">
                Buy an eSIM
              </a>
            </div>
            {/* The three figures that were a row of stat tiles, stated as one
                line of facts — which is how this site states facts under a
                headline. The last of them is the one no other gift-card shop
                can print. */}
            <p className="hero-note">
              <i /> {(worldwide ?? catalog.all.length).toLocaleString()} brands · code in under a
              minute · one transaction
            </p>
            <PayWithMarks label="Pay with" />
          </div>

          <div className="sh-hero-side">
            <h2>
              Popular in {countryName(country)} <span aria-hidden>{countryFlag(country)}</span>
            </h2>
            <div className="grid">
              {popular.map((b) => (
                <BrandTile key={b.slug} brand={b} />
              ))}
            </div>
          </div>
        </div>
      </header>

      <CategoryStrip categories={catalog.categories} />

      {HOME_RAILS.map((key) => {
        const brands = (catalog.byCategory[key] ?? [])
          .filter((b) => !b.outOfStock)
          .slice(0, 12);
        if (!brands.length) return null;
        return (
          <BrandRail
            key={key}
            title={categoryLabel(key)}
            brands={brands}
            href={`/shop/brands?c=${encodeURIComponent(key)}`}
          />
        );
      })}

      {/* How it works — the same three-step block the rest of the site uses. */}
      <section className="section wrap" style={{ paddingTop: 40 }}>
        <div className="section-head">
          <span className="eyebrow">How it works</span>
          <h2>Three steps, no account.</h2>
          <p>
            The catalogue is fulfilled by CryptoRefills. What is ours is the payment: the stock is
            sold and the order is paid in the same transaction, on Base, without either amount ever
            passing through us.
          </p>
        </div>
        {/* The same three-step component the home page's dividend loop is
            built from — `.steps-grid` / `.step-card` and the segment ring —
            rather than a second implementation of it under different class
            names. `lit` stays false on all three: a ring segment is only ever
            lit where value reaches a holder, and a shop is where it leaves. */}
        <div className="steps-grid">
          {[
            {
              n: "01",
              filled: 3,
              t: "Pick a brand and a value",
              c: "Any brand on sale in your country, at a fixed value or any amount you name.",
            },
            {
              n: "02",
              filled: 6,
              t: "Pay with your stock",
              c: "One amount, one button. Any of the equities the vault distributes, or STFY — the price is locked when the order is placed.",
            },
            {
              n: "03",
              filled: 8,
              t: "Get the code by email",
              c: "Usually inside a minute of the payment landing. Top-ups credit the number directly.",
            },
          ].map((step) => (
            <article className="step-card" key={step.n}>
              <RingMarker filled={step.filled} label={step.n} lit={false} />
              <h3>{step.t}</h3>
              <p>{step.c}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
