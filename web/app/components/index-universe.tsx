"use client";

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
 * The dividend index as a donut — the four equities the vault actually buys, at their on-chain
 * weights.
 *
 * It used to draw all thirteen listed assets grouped by sector, sized by TITLE COUNT, with a
 * footnote admitting that was "not a target allocation". That is a chart of nothing: the segments
 * answered a question — how many names are in each sector — that no reader of a dividend page has.
 * The weights are real and on-chain, so the ring can mean what a ring normally means.
 *
 * Slices come from the server, which reads `stockAt()`. Ownership can change them between cycles.
 *
 * Each arc carries its company's OWN colour rather than a slot from a house palette, and the legend
 * carries the mark. Four blues told a reader which slice was which only by position; NVIDIA green
 * next to Apple silver is legible without the legend at all.
 */
const RADIUS = 58;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function IndexUniverse({ slices }: { slices: IndexSlice[] }) {
  const [active, setActive] = useState<number | null>(null);

  // No slices means the vault did not answer, not that it buys nothing. Drawing "0 assets" in a
  // donut would state the second while meaning the first.
  if (slices.length === 0) {
    return (
      <aside className="index-universe is-unread" aria-label="Dividend index weights">
        <div className="universe-head"><span>DIVIDEND INDEX</span><b>—</b></div>
        <p className="universe-unread">
          The vault&apos;s index could not be read just now. It is not shown as empty, because empty
          is a different claim.
        </p>
      </aside>
    );
  }

  const total = slices.reduce((sum, slice) => sum + slice.weightBps, 0) || 1;
  let offset = 0;
  const arcs = slices.map((slice) => {
    const percentage = (slice.weightBps / total) * 100;
    const arc = { ...slice, percentage, offset, color: slice.brand };
    offset += percentage;
    return arc;
  });

  return (
    <aside className="index-universe" aria-label="Dividend index weights">
      <div className="universe-head">
        <span>DIVIDEND INDEX</span>
        <b>{slices.length} B20</b>
      </div>
      <div className="universe-body">
        <div className="universe-ring" aria-hidden="true">
          <svg viewBox="0 0 144 144">
            {arcs.map((arc, index) => (
              <circle
                className={active !== null && active !== index ? "is-dimmed" : ""}
                cx="72"
                cy="72"
                fill="none"
                key={arc.symbol}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
                r={RADIUS}
                stroke={arc.color}
                strokeDasharray={`${(arc.percentage / 100) * CIRCUMFERENCE - 3} ${CIRCUMFERENCE}`}
                strokeDashoffset={-((arc.offset / 100) * CIRCUMFERENCE)}
                strokeWidth="14"
              />
            ))}
          </svg>
          <div>
            <strong style={active === null ? undefined : { color: arcs[active].color }}>
              {active === null ? slices.length : `${(arcs[active].percentage).toFixed(0)}%`}
            </strong>
            <span>{active === null ? "assets" : arcs[active].symbol}</span>
          </div>
        </div>
        <div className="universe-legend">
          {arcs.map((arc, index) => (
            <button
              className={active !== null && active !== index ? "is-dimmed" : ""}
              key={arc.symbol}
              onBlur={() => setActive(null)}
              onFocus={() => setActive(index)}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              type="button"
            >
              <StockLogo logo={arc.logo} size="small" stock={{ symbol: arc.symbol, domain: arc.domain }} />
              <span>{arc.name}</span>
              <b>{(arc.weightBps / 100).toFixed(0)}%</b>
            </button>
          ))}
        </div>
      </div>
      <p>Target weights read from the vault — the index can change between cycles.</p>
    </aside>
  );
}
