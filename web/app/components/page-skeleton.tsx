import { SiteHeader } from "./site-chrome";

type Active = "home" | "stocks" | "dividends" | "indices" | "shop" | "docs";

/**
 * What a page shows while its chain reads are still running.
 *
 * Every page under /stocks, /indices, /dividends and the homepage renders per request and waits on
 * RPC and market reads, so without a loading boundary a click did nothing visible for seconds: Next
 * keeps the old page until the new one is ready, and the nav looked broken. Each of those routes now
 * has a `loading.tsx` returning one of these, which Next prefetches, so the new page opens at once
 * with its real header and this outline in place of the content, then swaps in the data.
 *
 * The shapes follow the page they stand for, so nothing jumps when the content arrives: the heading
 * canvas, a stats panel, and either a table, a row of cards or the homepage's poster hero.
 */
export function PageSkeleton({ active, body = "table" }: { active?: Active; body?: "hero" | "table" | "cards" | "detail" }) {
  return (
    <div className="site-shell">
      <SiteHeader active={active} />
      <main aria-busy="true" className="skeleton-page">
        <span className="sr-only" role="status">Loading</span>

        {body === "hero" ? (
          <div className="hero-card skeleton-hero" aria-hidden="true">
            <div className="hero-v2-top">
              <i className="sk sk-line sk-xs" />
              <i className="sk sk-title" />
              <i className="sk sk-title sk-title-2" />
              <div className="skeleton-row"><i className="sk sk-line sk-m" /><i className="sk sk-pill" /></div>
            </div>
            <div className="skeleton-fan">
              {[0, 1, 2, 3, 4].map((n) => <i className="sk sk-card" key={n} />)}
            </div>
          </div>
        ) : (
          <div className={`${body === "detail" ? "detail-canvas" : "hub-head"} skeleton-head`} aria-hidden="true">
            <div>
              <i className="sk sk-line sk-xs" />
              <i className="sk sk-title" />
              {body !== "detail" && <i className="sk sk-title sk-title-2" />}
              <i className="sk sk-line sk-l" />
              <i className="sk sk-line sk-m" />
            </div>
          </div>
        )}

        <div className="stats-band skeleton-stats" aria-hidden="true">
          <div className="stats-inner">
            {[0, 1, 2, 3].map((n) => (
              <div key={n}><i className="sk sk-line sk-xs" /><i className="sk sk-figure" /><i className="sk sk-line sk-s" /></div>
            ))}
          </div>
        </div>

        <div className="wrap skeleton-body" aria-hidden="true">
          {body === "cards" || body === "hero" ? (
            <div className="skeleton-cards">{[0, 1, 2].map((n) => <i className="sk sk-block" key={n} />)}</div>
          ) : (
            <div className="skeleton-table">{[0, 1, 2, 3, 4, 5].map((n) => <i className="sk sk-rowline" key={n} />)}</div>
          )}
        </div>
      </main>
    </div>
  );
}

/** The shop's body while a shop page loads; its layout keeps the header and shop bar on screen. */
export function ShopSkeleton() {
  return (
    <div aria-busy="true" className="wrap skeleton-body skeleton-shop">
      <span className="sr-only" role="status">Loading</span>
      {[0, 1, 2].map((row) => (
        <div aria-hidden="true" className="skeleton-shop-row" key={row}>
          <i className="sk sk-line sk-s" />
          <div className="skeleton-shop-tiles">{[0, 1, 2, 3, 4, 5].map((n) => <i className="sk sk-tile" key={n} />)}</div>
        </div>
      ))}
    </div>
  );
}
