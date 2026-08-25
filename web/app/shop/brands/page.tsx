import type { Metadata } from "next";
import { getCatalog } from "../../../lib/shop/cryptorefills";
import { activeCountry } from "../../../lib/shop/store";
import { categoryLabel, countryName } from "../../../lib/shop/countries";
import { BrandTile } from "../../components/shop/brand-tile";

export const metadata: Metadata = { title: "All brands — Shop" };

export default async function BrandsPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; q?: string }>;
}) {
  const { c: category, q } = await searchParams;
  const country = await activeCountry();
  const catalog = await getCatalog(country);

  const source =
    category && catalog.byCategory[category] ? catalog.byCategory[category] : catalog.all;

  const query = q?.trim().toLowerCase();
  const brands = query ? source.filter((b) => b.name.toLowerCase().includes(query)) : source;

  return (
    <div className="wrap sh-page">
      <nav className="sh-crumbs" aria-label="Breadcrumb">
        <a href="/shop">Shop</a>
        <span className="sep">/</span>
        <span className="now">{category ? categoryLabel(category) : "All brands"}</span>
      </nav>

      <h1 className="sh-h1">{category ? categoryLabel(category) : "All brands"}</h1>
      <p className="sh-sub">
        {brands.length} {brands.length === 1 ? "brand" : "brands"} available in{" "}
        {countryName(country)}
      </p>

      <div className="sh-pills" style={{ margin: "24px 0 28px" }}>
        <a className={`sh-pill${!category ? " on" : ""}`} href="/shop/brands">All</a>
        {catalog.categories.map((cat) => (
          <a
            key={cat.category}
            className={`sh-pill${category === cat.category ? " on" : ""}`}
            href={`/shop/brands?c=${encodeURIComponent(cat.category)}`}
          >
            {categoryLabel(cat.category)}
            <span className="n">{cat.count}</span>
          </a>
        ))}
      </div>

      {brands.length === 0 ? (
        <p className="sh-empty">No brands match that. Try another category or search term.</p>
      ) : (
        <div className="sh-grid">
          {brands.map((b) => (
            <BrandTile key={b.slug} brand={b} />
          ))}
        </div>
      )}
    </div>
  );
}
