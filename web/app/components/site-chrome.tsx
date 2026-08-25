import Image from "next/image";
import Link from "next/link";
import { ConnectWalletButton } from "./wallet";


type ActivePage = "home" | "stocks" | "dividends" | "indices" | "shop" | "docs";

/**
 * The account the site links to, and why it is not written here.
 *
 * A header icon is the most trusted link on a page — it is read as "this is us" — and an X handle
 * that has not been verified can belong to anybody. So this one was checked before it went in, the
 * same rule `updates-pill.tsx` applies to its Telegram channel: x.com/Stockify_fi answers 200 and
 * does not redirect elsewhere.
 *
 * Hardcoded rather than env-only for the reason that file gives: `.env.local` is gitignored, so a
 * link configured only there works in development and quietly vanishes in production.
 * `NEXT_PUBLIC_X_URL` still overrides, and setting it empty removes the icon.
 */
const X_URL = process.env.NEXT_PUBLIC_X_URL ?? "https://x.com/Stockify_fi";

/**
 * The handle, read off the URL rather than written twice.
 *
 * In the footer the mark alone is not enough — an unlabelled glyph in a list of
 * labelled ones reads as a missing word — and labelling it "X" next to the X
 * mark says the same letter twice. The handle is the thing worth printing, and
 * deriving it means an overridden `NEXT_PUBLIC_X_URL` cannot end up pointing at
 * one account while the label names another.
 */
const X_HANDLE = (() => {
  const slug = X_URL.split("?")[0].replace(/\/+$/, "").split("/").pop();
  return slug && slug !== "x.com" ? `@${slug}` : "X";
})();

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
          {/* Last, because it is the end of the line rather than another way in:
              the three before it are how value is produced, and this is what it
              is finally spent on. */}
          <Link className={active === "shop" ? "active" : ""} href="/shop">Shop</Link>
        </div>
        {/* Icons rather than words: these two are destinations people already know the shape of,
            and spending a nav slot on the word "Docs" crowds the ones that name what this site does. */}
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
        <div>
          <Link className="brandmark" href="/"><StockifyMark /><span>Stockify</span></Link>
          <p>Stock dividend protocol for Coinbase L2&apos;s tokenized stocks.</p>
          {/* The same two the header carries as icons — and the reason they are
              repeated here rather than merely mirrored: `.site-icons` is
              display:none below 720px, so on a phone the header's X and docs
              links do not exist at all. This is where they do.

              Labelled rather than icon-only. In a header an unlabelled glyph is
              read from its position; in a footer it is just a small shape. */}
          <div className="footer-icons">
            {X_URL && (
              <a href={X_URL} rel="noreferrer" target="_blank"><XIcon /><span>{X_HANDLE}</span></a>
            )}
            <Link href="/docs"><DocsIcon /><span>Docs</span></Link>
          </div>
        </div>
        {/* Documentation is deliberately absent from this list: it is one line
            away, in the row above, and naming the same destination twice in a
            footer this small reads as an oversight rather than as emphasis. */}
        <div className="footer-links"><span>Explore</span><Link href="/stocks">Tokenized stocks</Link><Link href="/dividends">Dividends</Link><Link href="/shop">Shop</Link><a href="https://base.org" target="_blank" rel="noreferrer">Built on Base ↗</a></div>
      </div>
      <div className="footer-meta"><span>© 2026 Stockify</span><span>Pre-launch. No STFY market is live.</span></div>
    </footer>
  );
}
