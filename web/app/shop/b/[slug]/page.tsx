import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCatalog, resolveProduct } from "../../../../lib/shop/cryptorefills";
import { activeCountry } from "../../../../lib/shop/store";
import { categoryLabel, countryName } from "../../../../lib/shop/countries";
import { formatMoney } from "../../../../lib/shop/money";
import { PurchasePanel } from "../../../components/shop/purchase-panel";
import { ProductContent } from "../../../components/shop/product-content";
import { BrandTile } from "../../../components/shop/brand-tile";

type Params = { slug: string };
type Search = { v?: string; coin?: string };

async function load(slug: string) {
  const country = await activeCountry();
  const catalog = await getCatalog(country);
  const card = catalog.all.find((b) => b.slug === slug);
  if (!card) return null;
  return { country, catalog, card };
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const found = await load(slug);
  if (!found) return { title: "Brand not found" };
  const isTopUp = found.card.kind === "mobile_recharge";
  return {
    title: isTopUp ? `${found.card.name} top-up` : `${found.card.name} gift card`,
    description: isTopUp
      ? `Top up ${found.card.name} with crypto from Base. Credited in minutes.`
      : `Buy a ${found.card.name} gift card with $BACKED or a tokenized share. Delivered by email in minutes.`,
  };
}

export default async function BrandPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { slug } = await params;
  const { v, coin } = await searchParams;

  const found = await load(slug);
  if (!found) notFound();

  const { country, catalog, card } = found;
  // Pass the brand: several families return more than one product.
  const product = await resolveProduct(country, card.family, coin ?? "USDC", card.name);
  if (!product) notFound();

  const related = (catalog.byCategory[card.category] ?? [])
    .filter((b) => b.slug !== card.slug && !b.outOfStock)
    .slice(0, 8);

  const requested = v ? Number(v) : undefined;

  return (
    <div className="wrap sh-page">
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <a href={`/shop/brands?c=${encodeURIComponent(card.category)}`}>
          {categoryLabel(card.category)}
        </a>
        <span className="sep">/</span>
        <span className="now">{card.name}</span>
      </nav>

      <div className="sh-product">
        <div>
          <div className="sh-art" style={{ backgroundColor: card.bgColor || "var(--card)" }}>
            {card.logo && <img src={card.logo} alt={card.name} />}
          </div>

          <h1 className="sh-h1">
            {card.name}
            {product.kind === "giftcard" ? " gift card" : ""}
          </h1>
          <p className="sh-meta">
            {product.isDynamic
              ? // Never hardcode the symbol: an Italian card is priced in EUR,
                // and "$5 to $2000" under a €100 amount is simply wrong.
                `Any amount from ${formatMoney(product.min, product.currency)} to ${formatMoney(product.max, product.currency)}`
              : product.isPlanBased
                ? `${product.options.length} plans`
                : `Available in ${product.options.length} fixed amounts`}
            {" · "}
            {product.deliversTo === "phone" ? "Credited to a phone number" : countryName(country)}
          </p>

          {product.isPlanBased && (
            <p style={{ marginTop: 14 }}>
              <a href="/shop/esim" style={{ color: "var(--lime-deep)", fontWeight: 600, fontSize: "0.9rem" }}>
                Browse eSIM plans by destination →
              </a>
            </p>
          )}

          {product.redeemMethods.length > 0 && (
            <ul className="sh-chips">
              {product.redeemMethods.map((m) => (
                <li key={m}>Redeem {m.toLowerCase()}</li>
              ))}
            </ul>
          )}

          <ProductContent product={product} />
        </div>

        <div className="sh-sticky">
          <PurchasePanel
            product={{
              brandName: product.brandName,
              familyName: product.familyName,
              countryCode: country,
              isDynamic: product.isDynamic,
              isPlanBased: product.isPlanBased,
              deliversTo: product.deliversTo,
              min: product.min,
              max: product.max,
              step: product.step,
              options: product.options,
              suggested: product.suggested,
              currency: product.currency,
              outOfStock: product.outOfStock,
            }}
            initialValue={requested}
            deliveryLabel={product.isPlanBased ? "Send the QR code to" : undefined}
          />
        </div>
      </div>

      {related.length > 0 && (
        <section style={{ marginTop: 56 }}>
          <div className="sh-rail-head">
            <h2>More in {categoryLabel(card.category)}</h2>
            <a className="all" href={`/shop/brands?c=${encodeURIComponent(card.category)}`}>See all →</a>
          </div>
          <div className="sh-rail">
            {related.map((b) => (
              <BrandTile key={b.slug} brand={b} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
