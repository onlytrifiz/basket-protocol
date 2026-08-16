"use client";

import { useState } from "react";
import { stocks } from "../../lib/stocks";
import { StockLogo } from "./stock-logo";

const groups = [
  { label: "Mega-cap technology", symbols: ["AAPLc", "GOOGLc", "METAc", "MSFTc"], color: "#7aa8ff" },
  { label: "Semiconductors", symbols: ["NVDAc", "INTCc", "SNDKc"], color: "#ffffff" },
  { label: "Market infrastructure", symbols: ["COINc", "CRCLc", "MSTRc"], color: "#5b88ec" },
  { label: "Consumer", symbols: ["AMZNc", "TSLAc"], color: "#a9c6ff" },
  { label: "Space", symbols: ["SPCXc"], color: "#274f9f" },
];

const radius = 58;
const circumference = 2 * Math.PI * radius;

/** Adapted from 21st's Sectors Donut (component 20086): hover/focus links the
 * SVG ring and the legend. Here it reports title count, never a fake allocation. */
export function BasketUniverse() {
  const [active, setActive] = useState<number | null>(null);
  let offset = 0;

  const arcs = groups.map((group) => {
    const percentage = (group.symbols.length / stocks.length) * 100;
    const arc = { ...group, percentage, offset };
    offset += percentage;
    return arc;
  });

  return (
    <aside className="basket-universe" aria-label="Initial B20 equity universe">
      <div className="universe-head"><span>INITIAL UNIVERSE</span><b>13 B20</b></div>
      <div className="universe-body">
        <div className="universe-ring" aria-hidden="true">
          <svg viewBox="0 0 144 144">
            {arcs.map((arc, index) => (
              <circle
                className={active !== null && active !== index ? "is-dimmed" : ""}
                cx="72"
                cy="72"
                fill="none"
                key={arc.label}
                onMouseEnter={() => setActive(index)}
                onMouseLeave={() => setActive(null)}
                r={radius}
                stroke={arc.color}
                strokeDasharray={`${(arc.percentage / 100) * circumference - 3} ${circumference}`}
                strokeDashoffset={-((arc.offset / 100) * circumference)}
                strokeWidth="14"
              />
            ))}
          </svg>
          <div><strong>13</strong><span>titles</span></div>
        </div>
        <div className="universe-legend">
          {arcs.map((arc, index) => (
            <button
              className={active !== null && active !== index ? "is-dimmed" : ""}
              key={arc.label}
              onBlur={() => setActive(null)}
              onFocus={() => setActive(index)}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              type="button"
            >
              <i style={{ background: arc.color }} />
              <span>{arc.label}</span>
              <b>{arc.symbols.length}</b>
            </button>
          ))}
        </div>
      </div>
      <div className="universe-tickers">
        {stocks.map((stock) => <StockLogo key={stock.symbol} size="small" stock={stock} />)}
      </div>
      <p>Universe by title count — not a target allocation.</p>
    </aside>
  );
}
