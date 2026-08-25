import type { ResolvedProduct } from "../../../lib/shop/cryptorefills";

function Fold({ title, html, open = false }: { title: string; html: string; open?: boolean }) {
  return (
    <details className="sh-fold" open={open}>
      <summary>
        {title}
        <svg className="chev" width="13" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
          <path d="M1 1l5 5 5-5" strokeLinecap="round" />
        </svg>
      </summary>
      {/* Sanitised server-side in lib/shop/sanitize.ts. */}
      <div className="body" dangerouslySetInnerHTML={{ __html: html }} />
    </details>
  );
}

/**
 * The supplier writes these notes for their own storefront, and signs them
 * "#protip" — a voice that is theirs and reads as borrowed anywhere else. The
 * advice underneath is worth keeping (it is brand-specific and often the reason
 * a card fails to redeem), so the marker goes and our own label takes its
 * place.
 */
function stripSupplierVoice(html: string): string {
  return html.replace(/(<p[^>]*>\s*)?#\s*pro\s*-?\s*tip\b[:\s]*/i, (_m, open) => open ?? "");
}

/** The supplier's own editorial copy, folded away under the artwork. */
export function ProductContent({ product }: { product: ResolvedProduct }) {
  const { description, howToRedeem, termsAndConditions, note } = product.content;

  // Fall back to the plain-text blurb when a brand has no rich description.
  const intro = description ?? (product.terms ? `<p>${product.terms}</p>` : null);
  if (!intro && !howToRedeem && !termsAndConditions && !note) return null;

  return (
    <div className="sh-prose">
      {note && (
        <aside className="sh-note">
          <span className="k">Worth knowing before you buy</span>
          <div dangerouslySetInnerHTML={{ __html: stripSupplierVoice(note) }} />
        </aside>
      )}
      {intro && <Fold title="Description" html={intro} open />}
      {howToRedeem && <Fold title="How to redeem" html={howToRedeem} />}
      {termsAndConditions && <Fold title="Terms and conditions" html={termsAndConditions} />}
    </div>
  );
}
