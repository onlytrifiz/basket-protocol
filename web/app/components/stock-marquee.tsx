import Link from "next/link";

import { stocks, washColor, type IndexStock } from "../../lib/stocks";
import { StockLogo } from "./stock-logo";

/**
 * The listed universe as two rows of tickers drifting in opposite directions.
 *
 * It replaces a 131-tile grid that was the tallest thing on the homepage while being the least read:
 * nobody scans a catalogue on the way past it, and the full list with search and sorting is one
 * click away on /stocks. What this section has to say is "there are a lot of these, and each one
 * is a real company", which breadth in motion says better than a wall.
 *
 * Each row is rendered twice so the loop can translate by exactly half its width and wrap without a
 * seam. The second copy is hidden from assistive tech and from the tab order, so a keyboard or
 * screen-reader user meets every ticker exactly once. Under reduced motion the animation is off and
 * the row becomes an ordinary horizontal scroller instead.
 */
function Row({ items, reverse = false }: { items: IndexStock[]; reverse?: boolean }) {
  return (
    <div className={`marquee-row${reverse ? " is-reverse" : ""}`}>
      <div className="marquee-track">
        {[0, 1].map((copy) => (
          <ul aria-hidden={copy === 1 || undefined} className="marquee-set" key={copy}>
            {items.map((stock) => (
              <li key={stock.symbol}>
                <Link
                  className="marquee-chip"
                  href={`/stocks/${stock.symbol.toLowerCase()}`}
                  style={{ "--brand": washColor(stock) } as React.CSSProperties}
                  tabIndex={copy === 1 ? -1 : undefined}
                >
                  <StockLogo stock={stock} size="small" />
                  <strong>{stock.symbol}</strong>
                  <span>{stock.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

export function StockMarquee() {
  const half = Math.ceil(stocks.length / 2);
  return (
    <div aria-label="Listed B20 equities" className="stock-marquee" role="region">
      <Row items={stocks.slice(0, half)} />
      <Row items={stocks.slice(half)} reverse />
    </div>
  );
}
