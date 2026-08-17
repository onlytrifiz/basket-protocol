import Link from "next/link";

type ActivePage = "overview" | "distributions" | "protocol" | "docs";

export function BasketMark({ small = false }: { small?: boolean }) {
  return <span className={`basket-mark${small ? " basket-mark-small" : ""}`} aria-hidden="true"><i />B</span>;
}

export function SiteHeader({ active }: { active: ActivePage }) {
  return (
    <nav className="site-nav" aria-label="Primary navigation">
      <div className="site-nav-inner">
        <Link className="brandmark" href="/"><BasketMark /><span>Basket</span></Link>
        <div className="site-links">
          <Link className={active === "overview" ? "active" : ""} href="/">Overview</Link>
          <Link className={active === "distributions" ? "active" : ""} href="/distributions">Distributions</Link>
          <Link className={active === "protocol" ? "active" : ""} href="/protocol">Protocol</Link>
          <Link className={active === "docs" ? "active" : ""} href="/docs">Docs</Link>
        </div>
        <span className="base-pill"><i /> Base</span>
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div><Link className="brandmark" href="/"><BasketMark /><span>Basket</span></Link><p>Stock dividend protocol for Coinbase L2&apos;s tokenized stocks.</p></div>
        <div className="footer-links"><span>Explore</span><Link href="/distributions">Distributions</Link><Link href="/protocol">Protocol notes</Link><Link href="/docs">Documentation</Link><a href="https://base.org" target="_blank" rel="noreferrer">Built on Base ↗</a></div>
      </div>
      <div className="footer-meta"><span>© 2026 Basket</span><span>Pre-launch. No BASKET market is live.</span></div>
    </footer>
  );
}
