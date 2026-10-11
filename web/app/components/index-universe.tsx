"use client";

import Link from "next/link";
import { useState } from "react";

import { StockLogo } from "./stock-logo";

export type IndexSlice = {
  symbol: string;
  name: string;
  weightBps: number;
  /** The company's own mark colour — see `lib/stocks`. */
  brand: string;
  /** Official Coinbase equity icon, read from the token's `contractURI()`. */
  logo?: string;
  domain?: string;
};

/**
 * The dividend index as a composition mosaic: one column per equity the vault buys, each as wide as
 * its on-chain weight, in that company's own colour.
 *
 * It replaced a donut and a legend table. A ring of five equal slices said "five" and little else,
 * and the eye had to cross from arc to legend to learn which was which. Here the company, its mark,
 * its weight and its ticker are the same object, the width IS the weight, and the strip under the
 * columns states the whole composition again in one line. Each column opens that stock's page.
 *
 * Slices come from the server, which reads `stockAt()`. Ownership can change them between cycles.
 */

/** Whole percent when the weight is whole, one decimal when it is not: 20% stays "20%", and an
 *  index weighted 33.33 / 33.33 / 33.34 does not round three slices into the same figure. */
const formatWeight = (percentage: number) =>
  `${Number.isInteger(Math.round(percentage * 10) / 10) ? percentage.toFixed(0) : percentage.toFixed(1)}%`;

export function IndexUniverse({ slices }: { slices: IndexSlice[] }) {
  const [active, setActive] = useState<number | null>(null);

  // No slices means the vault did not answer, not that it buys nothing. Drawing an empty mosaic
  // would state the second while meaning the first.
  if (slices.length === 0) {
    return (
      <aside className="index-universe is-unread" aria-label="Dividend index weights">
        <div className="universe-head"><span>DIVIDEND INDEX</span><b>—</b></div>
        <p className="universe-unread">
          The vault&apos;s index could not be read just now. Try again in a minute.
        </p>
      </aside>
    );
  }

  const total = slices.reduce((sum, slice) => sum + slice.weightBps, 0) || 1;
  const parts = slices.map((slice) => ({ ...slice, percentage: (slice.weightBps / total) * 100 }));
  const dim = (index: number) => (active !== null && active !== index ? " is-dimmed" : "");

  return (
    <aside className="index-universe index-mosaic" aria-label="Dividend index weights">
      <div className="universe-head">
        <span>DIVIDEND INDEX</span>
        <b>{slices.length} B20</b>
      </div>

      <ul className="mosaic">
        {parts.map((part, index) => (
          <li
            className={`mosaic-col${dim(index)}`}
            key={part.symbol}
            style={{ "--arc": part.brand, flexGrow: part.percentage } as React.CSSProperties}
          >
            <Link
              aria-label={`${part.name}, ${formatWeight(part.percentage)} of the index`}
              href={`/stocks/${part.symbol.toLowerCase()}`}
              onBlur={() => setActive(null)}
              onFocus={() => setActive(index)}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
            >
              <StockLogo logo={part.logo} size="small" stock={{ symbol: part.symbol, domain: part.domain }} />
              <span className="mosaic-figures">
                <b>{formatWeight(part.percentage)}</b>
                <small>{part.symbol}</small>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {/* The same composition in one line: each segment as long as its weight. */}
      <div aria-hidden="true" className="mosaic-strip">
        {parts.map((part, index) => (
          <i
            className={dim(index).trim()}
            key={part.symbol}
            style={{ "--arc": part.brand, flexGrow: part.percentage } as React.CSSProperties}
          />
        ))}
      </div>

      <p>Target weights. The index can change between cycles.</p>
    </aside>
  );
}
