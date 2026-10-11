import Image from "next/image";
import Link from "next/link";
import { LinkPending } from "./link-pending";
import { ThemeToggle } from "./theme-toggle";
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

/**
 * The header's docs mark: a filled page on a brand-blue disc, made to sit beside the theme toggle's
 * tiny sky as its pair. The footer keeps the plain outline `DocsIcon`, where it sits in a text pill.
 */
function DocsTile() {
  return (
    <span aria-hidden="true" className="docs-tile">
      <svg viewBox="0 0 24 24" focusable="false">
        <defs>
          <linearGradient id="docs-tile-page" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#d6e2ff" />
          </linearGradient>
        </defs>
        <path d="M6.6 2.8h7.3l4.9 4.9v11.9a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 19.6V4.4a1.6 1.6 0 0 1 1.6-1.6z" fill="url(#docs-tile-page)" />
        <path d="M13.9 2.8v3.4a1.5 1.5 0 0 0 1.5 1.5h3.4z" fill="#8fb0ff" />
        <path d="M8.2 11.6h7.4M8.2 14.6h7.4M8.2 17.6h4.4" stroke="#0052ff" strokeLinecap="round" strokeWidth="1.5" />
      </svg>
    </span>
  );
}

/**
 * "by The Stonks Exchange": Stockify is built by The Stonks Exchange, and says so beside its own name
 * in the header and above the homepage headline. Their own mark, pixel art, so it is drawn with
 * `image-rendering: pixelated` to stay crisp at small sizes. Links out to their site.
 */
export const STONKS_URL = "https://www.thestonks.exchange/";

export function StonksBy({ variant = "header" }: { variant?: "header" | "hero" }) {
  return (
    <a aria-label="By The Stonks Exchange" className={`stonks-by is-${variant}`} href={STONKS_URL} rel="noreferrer" target="_blank" title="By The Stonks Exchange">
      <span className="stonks-by-word">by</span>
      <Image alt="" className="stonks-by-mark" height={20} src="/partners/stonks-exchange.png" unoptimized width={20} />
      <span className="stonks-by-name">The Stonks Exchange</span>
      {variant === "hero" && <span aria-hidden="true" className="stonks-by-go">↗</span>}
    </a>
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

/* The site ships dark since 2.0, and the toggle is back so a reader who prefers the light palette
   can have it. It sits beside the wallet rather than with the icons, which disappear on phones. */
export function SiteHeader({ active }: { active?: ActivePage }) {
  return (
    <>
    <nav aria-label="Primary navigation" className="site-nav">
      <div className="site-nav-inner">
        <Link className="brandmark" href="/"><StockifyMark /><span>Stockify</span></Link>
        <StonksBy />
        <div className="site-links">
          <Link className={active === "home" ? "active" : ""} href="/">Home<LinkPending /></Link>
          <Link className={active === "stocks" ? "active" : ""} href="/stocks">Stocks<LinkPending /></Link>
          <Link className={active === "dividends" ? "active" : ""} href="/dividends">Dividends<LinkPending /></Link>
          <Link className={active === "indices" ? "active" : ""} href="/indices">Indices<LinkPending /></Link>
          {/* Last, because it is the end of the line rather than another way in:
              the three before it are how value is produced, and this is what it
              is finally spent on. */}
          <Link className={active === "shop" ? "active" : ""} href="/shop">Shop<LinkPending /></Link>
        </div>
        {/* Icons rather than words: these two are destinations people already know the shape of,
            and spending a nav slot on the word "Docs" crowds the ones that name what this site does. */}
        <div className="site-icons">
          {X_URL && (
            <a aria-label="Stockify on X" className="x-link" href={X_URL} rel="noreferrer" target="_blank">
              <span aria-hidden="true" className="x-tile"><XIcon /></span>
            </a>
          )}
          <Link aria-label="Documentation" className={`docs-link${active === "docs" ? " active" : ""}`} href="/docs">
            <DocsTile />
          </Link>
        </div>
        <ThemeToggle />
        <ConnectWalletButton />
      </div>
    </nav>
    <BottomBar active={active} />
    </>
  );
}

/* The phone's navigation. Below 720px the header keeps only the brand, the theme and the wallet, and
   the five destinations move to a bar at the bottom of the screen, where a thumb reaches them. Each
   tab carries one of the site's 3D marks; the current page is lit, the rest sit back. */
const TABS: Array<{ key: ActivePage; href: string; label: string; icon: string }> = [
  { key: "home", href: "/", label: "Home", icon: "/icons/tab-home.png" },
  { key: "stocks", href: "/stocks", label: "Stocks", icon: "/icons/tab-stocks.png" },
  { key: "dividends", href: "/dividends", label: "Dividends", icon: "/icons/loop-receive.png" },
  { key: "indices", href: "/indices", label: "Indices", icon: "/icons/tab-indices.png" },
  { key: "shop", href: "/shop", label: "Shop", icon: "/icons/tab-shop.png" },
];

function BottomBar({ active }: { active?: ActivePage }) {
  return (
    <nav aria-label="Primary navigation, mobile" className="bottom-bar">
      {TABS.map((tab) => (
        <Link aria-current={active === tab.key ? "page" : undefined} className={active === tab.key ? "active" : ""} href={tab.href} key={tab.key}>
          <Image alt="" height={30} src={tab.icon} width={30} />
          <span>{tab.label}</span>
          <LinkPending />
        </Link>
      ))}
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
        <div className="footer-links"><span>Explore</span><Link href="/stocks">Tokenized stocks</Link><Link href="/dividends">Dividends</Link><Link href="/wallet">Your payouts</Link><Link href="/indices">Indices</Link><Link href="/shop">Shop</Link><a href="https://base.org" target="_blank" rel="noreferrer">Built on Base ↗</a></div>
      </div>
      <div className="footer-meta"><span>© 2026 Stockify</span></div>
      {/* The name once more, at the size of the page rather than of a logo: the last thing a reader
          scrolls past is what the site is called. Decorative, since the brandmark above says it. */}
      <p aria-hidden="true" className="footer-wordmark">Stockify</p>
    </footer>
  );
}
