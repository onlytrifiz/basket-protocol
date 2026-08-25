import type { BrandCard } from "../../../lib/shop/types";

/**
 * One brand, as a card.
 *
 * The artwork keeps the brand's own backdrop colour — shipped by the supplier
 * alongside the logo — because half of these marks are white on transparent
 * and would vanish on cream. Ours is the frame around it: our radius, our
 * rule, our lime on hover. Recolouring the art itself would leave a Steam card
 * nobody recognises.
 */
export function BrandTile({ brand }: { brand: BrandCard }) {
  const range =
    brand.minLabel && brand.maxLabel
      ? `${brand.minLabel} – ${brand.maxLabel}`
      : (brand.minLabel ?? null);

  return (
    <a className="sh-tile" href={`/shop/b/${brand.slug}`}>
      <div className="art" style={{ backgroundColor: brand.bgColor || "var(--card)" }}>
        {brand.logo ? (
          <img src={brand.logo} alt="" loading="lazy" />
        ) : (
          <span className="fallback">{brand.name}</span>
        )}
        {brand.outOfStock && <span className="sold">Sold out</span>}
      </div>
      <div className="nm">{brand.name}</div>
      {range && <div className="rg">{range}</div>}
    </a>
  );
}
