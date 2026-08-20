import Image from "next/image";
import Link from "next/link";
import { ConnectWalletButton } from "./wallet";


type ActivePage = "home" | "stocks" | "dividends" | "indices" | "docs";

/**
 * The account the site links to, and why it is not written here.
 *
 * A header icon is the most trusted link on a page — it is read as "this is us" — and an X handle
 * that has not been verified can belong to anybody. `updates-pill.tsx` hardcodes its channel only
 * because that one was checked first. This one has not been, so it is configuration: set it and the
 * icon appears, leave it and there is no icon rather than a link to a stranger.
 */
const X_URL = process.env.NEXT_PUBLIC_X_URL ?? "";

function XIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path
        d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.66l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.11z"
        fill="currentColor"
      />
    </svg>
  );
}

function DocsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
      <path
        d="M5.5 4.75A1.75 1.75 0 0 1 7.25 3h6.19c.46 0 .9.18 1.23.51l3.56 3.56c.33.33.52.77.52 1.24v10.94A1.75 1.75 0 0 1 17 21H7.25a1.75 1.75 0 0 1-1.75-1.75z"
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
      />
      <path d="M13.5 3.5v4.25h4.5M9 12.5h6M9 16h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The 3D coin render at UI scale — the brand's material world in miniature. */
export function StockifyMark({ small = false }: { small?: boolean }) {
  const size = small ? 26 : 34;
  return (
    <span aria-hidden="true" className={`stockify-mark${small ? " stockify-mark-small" : ""}`}>
      <Image alt="" height={size} priority src="/logo.png" width={size} />
    </span>
  );
}

/* `ThemeToggle` is deliberately still in the tree and deliberately not rendered: the site ships
   light for now, and the component plus its whole dark palette are kept for when it comes back. */
export function SiteHeader({ active }: { active: ActivePage }) {
  return (
    <nav aria-label="Primary navigation" className="site-nav">
      <div className="site-nav-inner">
        <Link className="brandmark" href="/"><StockifyMark /><span>Stockify</span></Link>
        <div className="site-links">
          <Link className={active === "home" ? "active" : ""} href="/">Home</Link>
          <Link className={active === "stocks" ? "active" : ""} href="/stocks">Stocks</Link>
          <Link className={active === "dividends" ? "active" : ""} href="/dividends">Dividends</Link>
          <Link className={active === "indices" ? "active" : ""} href="/indices">Indices</Link>
        </div>
        {/* Icons rather than words: these two are destinations people already know the shape of,
            and spending a nav slot on the word "Docs" crowds the four that name what this site does. */}
        <div className="site-icons">
          {X_URL && (
            <a aria-label="Stockify on X" href={X_URL} rel="noreferrer" target="_blank"><XIcon /></a>
          )}
          <Link aria-label="Documentation" className={active === "docs" ? "active" : ""} href="/docs">
            <DocsIcon />
          </Link>
        </div>
        <ConnectWalletButton />
      </div>
    </nav>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div><Link className="brandmark" href="/"><StockifyMark /><span>Stockify</span></Link><p>Stock dividend protocol for Coinbase L2&apos;s tokenized stocks.</p></div>
        <div className="footer-links"><span>Explore</span><Link href="/stocks">Tokenized stocks</Link><Link href="/dividends">Dividends</Link><Link href="/docs">Documentation</Link><a href="https://base.org" target="_blank" rel="noreferrer">Built on Base ↗</a></div>
      </div>
      <div className="footer-meta"><span>© 2026 Stockify</span><span>Pre-launch. No STFY market is live.</span></div>
    </footer>
  );
}
