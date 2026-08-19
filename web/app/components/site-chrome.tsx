import Image from "next/image";
import Link from "next/link";
import { ConnectWalletButton } from "./wallet";
import { ThemeToggle } from "./theme-toggle";

type ActivePage = "overview" | "stocks" | "distributions" | "protocol" | "docs";

/** The 3D coin render at UI scale — the brand's material world in miniature. */
export function StockifyMark({ small = false }: { small?: boolean }) {
  const size = small ? 26 : 34;
  return (
    <span aria-hidden="true" className={`stockify-mark${small ? " stockify-mark-small" : ""}`}>
      <Image alt="" height={size} priority src="/logo.png" width={size} />
    </span>
  );
}

export function SiteHeader({ active }: { active: ActivePage }) {
  return (
    <nav aria-label="Primary navigation" className="site-nav">
      <div className="site-nav-inner">
        <Link className="brandmark" href="/"><StockifyMark /><span>Stockify</span></Link>
        <div className="site-links">
          <Link className={active === "overview" ? "active" : ""} href="/">Overview</Link>
          <Link className={active === "stocks" ? "active" : ""} href="/stocks">Stocks</Link>
          <Link className={active === "distributions" ? "active" : ""} href="/distributions">Distributions</Link>
          <Link className={active === "protocol" ? "active" : ""} href="/protocol">Protocol</Link>
          <Link className={active === "docs" ? "active" : ""} href="/docs">Docs</Link>
        </div>
        <span className="base-pill"><i /> Base</span>
        <ConnectWalletButton />
        <ThemeToggle />
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div><Link className="brandmark" href="/"><StockifyMark /><span>Stockify</span></Link><p>Stock dividend protocol for Coinbase L2&apos;s tokenized stocks.</p></div>
        <div className="footer-links"><span>Explore</span><Link href="/stocks">Tokenized stocks</Link><Link href="/distributions">Distributions</Link><Link href="/protocol">Protocol notes</Link><Link href="/docs">Documentation</Link><a href="https://base.org" target="_blank" rel="noreferrer">Built on Base ↗</a></div>
      </div>
      <div className="footer-meta"><span>© 2026 Stockify</span><span>Pre-launch. No STFY market is live.</span></div>
    </footer>
  );
}
