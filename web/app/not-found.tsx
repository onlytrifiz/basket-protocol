import Image from "next/image";
import Link from "next/link";

import { SiteFooter, SiteHeader } from "./components/site-chrome";

export const metadata = { title: "Not found · Stockify" };

/**
 * The site's own 404, in the same frame as every other page.
 *
 * Most people land here from a stock link with a mistyped ticker or from an address that predates
 * a rename, so the copy names that case and the two exits are the home page and the stock list.
 */
export default function NotFound() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main className="wrap not-found">
        <div className="not-found-copy">
          <p className="eyebrow">404</p>
          <h1>Nothing trades at this address.</h1>
          <p>
            The link may be out of date, or a ticker may be misspelled. Stock pages live at
            /stocks/ followed by the B20 symbol, for example <code>/stocks/nvdac</code>.
          </p>
          <div className="hero-actions">
            <Link className="button button-ink" href="/">Back to home <span>→</span></Link>
            <Link className="button button-ghost" href="/stocks">Browse every stock</Link>
          </div>
        </div>
        <div aria-hidden="true" className="not-found-art">
          <Image alt="" fill priority sizes="(max-width: 760px) 70vw, 420px" src="/stocks.png" />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
