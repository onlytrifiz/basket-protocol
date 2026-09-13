import Link from "next/link";

import type { B20Asset } from "../../lib/b20";
import { StockLogo } from "./stock-logo";

/**
 * Cumulative shares of one equity pushed to holders, as a staircase.
 *
 * A STAIRCASE RATHER THAN A LINE, because the quantity is not continuous: nothing reaches a holder
 * between cycles, and a sloped segment across that gap would draw a distribution that did not
 * happen. Every horizontal run is a real interval of nothing, every riser is a real settlement.
 *
 * The series only ever goes up — it is a running total — so this chart carries no direction and no
 * up/down colour. Its shape says one thing: whether the payouts kept coming or stopped.
 */
function Staircase({ series, width = 220, height = 42 }: { series: number[]; width?: number; height?: number }) {
  if (series.length < 2) return null;

  const max = series[series.length - 1];
  // Everything is zero until the first cycle that bought this one. Scaling by a zero maximum would
  // divide by zero; drawing it flat along the bottom is the honest picture.
  const span = max || 1;
  const stepX = width / (series.length - 1);
  const y = (value: number) => height - (value / span) * (height - 4) - 2;

  // Step-after: hold the previous level across the interval, then rise at the cycle.
  let d = `M0,${y(series[0]).toFixed(1)}`;
  for (let i = 1; i < series.length; i += 1) {
    const x = (i * stepX).toFixed(1);
    d += ` H${x} V${y(series[i]).toFixed(1)}`;
  }

  return (
    <svg
      aria-hidden="true"
      className="asset-spark"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <path className="asset-spark-fill" d={`${d} V${height} H0 Z`} />
      <path className="asset-spark-line" d={d} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export type AssetCardRow = {
  address: string;
  symbol: string;
  name: string;
  weightBps: number;
  asset?: B20Asset;
  /** Share price of the underlying, when a quote landed. */
  price?: number;
  /** Cumulative shares pushed to holders, all time. */
  distributed: number;
  /** The same quantity in dollars, `null` when the equity has no quote to price it with. */
  distributedValue: number | null;
  /** The company's own mark colour — see `lib/stocks`. */
  brand: string;
  /** Cumulative distributed sampled across every settled cycle, oldest first. */
  series: number[];
};

const fmtShares = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 2 : 4 });

const usd = (value?: number | null) =>
  value === undefined || value === null
    ? "—"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const usdCompact = (value: number) =>
  value >= 1000
    ? `$${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`
    : usd(value);

/**
 * One equity in the index, as a card.
 *
 * WHAT IT REPLACED AND WHY. This was five rows of a table, and a table row can only ever show a
 * total — it has nowhere to put a history. The figure a reader actually wants from this page is not
 * "how many shares" but "is this still happening", and that is a shape, not a number. The card
 * keeps every column the row had and adds the one thing the row could not carry.
 *
 * The headline is in the PAYOUT register. That colour is reserved in this system for value that
 * reached a holder, and cumulative distributed is exactly that — the one number on the page with a
 * claim to it. The line is `--payout-fg` rather than `--lime` itself for the ordinary reason: lime
 * on white is around 1.3:1, which is a decorative colour, not a legible one.
 */
export function AssetCard({ row }: { row: AssetCardRow }) {
  const { asset, brand, distributed, distributedValue, name, price, symbol, weightBps, series } = row;
  const paid = distributed > 0;

  return (
    <Link
      className="asset-card"
      href={asset ? `/stocks/${asset.symbol.toLowerCase()}` : "/stocks"}
      style={{ "--brand": brand } as React.CSSProperties}
    >
      <span className="asset-card-head">
        <StockLogo logo={asset?.logo} stock={{ symbol, domain: asset?.domain }} />
        <span className="asset-card-id">
          <strong>{symbol}</strong>
          <small>{name}</small>
        </span>
        <span className="asset-card-weight">{(weightBps / 100).toFixed(0)}%</span>
        <svg aria-hidden="true" className="equity-go" focusable="false" viewBox="0 0 6 10">
          <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
        </svg>
      </span>

      <span className="asset-card-figure">
        <span className="asset-card-label">Distributed to holders</span>
        <strong className={paid ? "is-payout" : undefined}>
          {paid ? fmtShares(distributed) : "—"}
          {paid && <i>{symbol}</i>}
        </strong>
      </span>

      {/* No series is a real state — a name added to the index this cycle has no history yet — so
          the card keeps its shape and says so rather than collapsing. */}
      {series.length >= 2
        ? <Staircase series={series} />
        : <span className="asset-spark asset-spark-empty">No cycles have bought this one yet</span>}

      <span className="asset-card-foot">
        <span>
          <small>Share price</small>
          <b>{usd(price)}</b>
        </span>
        {/* The same quantity as the headline, in dollars. An equity with no quote shows no figure
            rather than a zero: "we could not price it" and "it is worth nothing" are not the same
            sentence, and only one of them is true. */}
        <span>
          <small>Distributed</small>
          <b>{distributedValue === null ? (paid ? "unpriced" : "—") : usdCompact(distributedValue)}</b>
        </span>
      </span>
    </Link>
  );
}
