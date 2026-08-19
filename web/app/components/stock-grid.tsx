import Link from "next/link";

import { stocks } from "../../lib/stocks";
import { StockLogo } from "./stock-logo";

/**
 * The listed universe as a grid of marks.
 *
 * Each card is a link to that asset's page rather than to a block explorer: the explorer answers
 * "does this address exist", which is not the question anyone browsing a universe is asking, and
 * the contract address is on the detail page anyway. That also lets the cards lose their footer
 * row, which is most of why they were too heavy for a section the page passes through.
 */
export function StockGrid({ children, compact = false }: { children?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={`equity-grid${compact ? " equity-grid-compact" : ""}`}>
      {stocks.map((stock) => (
        <Link className="equity-card" href={`/stocks/${stock.symbol.toLowerCase()}`} key={stock.symbol}>
          <StockLogo stock={stock} size="small" />
          <span className="equity-name">
            <strong>{stock.symbol}</strong>
            <span>{stock.name}</span>
          </span>
          {/* Nothing about a tile of text says "this opens". Faint until hover, then it moves. */}
          <svg aria-hidden="true" className="equity-go" viewBox="0 0 6 10" focusable="false">
            <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
          </svg>
        </Link>
      ))}
      {children}
    </div>
  );
}
