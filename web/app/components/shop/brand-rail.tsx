import { BrandTile } from "./brand-tile";
import type { BrandCard } from "../../../lib/shop/types";

/** A shelf of brands that scrolls sideways rather than wrapping. */
export function BrandRail({
  title,
  brands,
  href,
}: {
  title: string;
  brands: BrandCard[];
  href?: string;
}) {
  if (!brands.length) return null;

  return (
    <section className="sh-section wrap">
      <div className="sh-rail-head">
        <h2>{title}</h2>
        {href && (
          <a className="all" href={href}>
            See all →
          </a>
        )}
      </div>
      <div className="sh-rail">
        {brands.map((b) => (
          <BrandTile key={b.slug} brand={b} />
        ))}
      </div>
    </section>
  );
}
