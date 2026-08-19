"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Series } from "../../lib/market";
import { usd } from "../../lib/format";

const RANGES = ["1mo", "6mo", "1y", "5y"] as const;
const LABEL: Record<string, string> = { "1mo": "1M", "6mo": "6M", "1y": "1Y", "5y": "5Y" };

/**
 * The underlying's price history, drawn as a filled area with a hover readout.
 *
 * Hand-rolled SVG rather than a charting library, for the same reason the wallet is hand-rolled: the
 * dependency would outweigh the entire app to draw one line. The shape is a single path plus a
 * gradient fill, and the crosshair is arithmetic over the same points.
 *
 * The initial series is rendered on the SERVER, so the chart is in the first paint and only a range
 * CHANGE costs a request. A failed range leaves the previous line up rather than blanking the panel:
 * the data did not stop being true because the next fetch failed.
 */
export function PriceChart({ ticker, initial }: { ticker: string; initial: Series | null }) {
  const [range, setRange] = useState<string>("1y");
  const [series, setSeries] = useState<Series | null>(initial);
  const [isLoading, setIsLoading] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const cache = useRef<Record<string, Series>>(initial ? { "1y": initial } : {});
  const box = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const hit = cache.current[range];
    if (hit) { setSeries(hit); return; }

    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/market?ticker=${encodeURIComponent(ticker)}&range=${range}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("range unavailable"))))
      .then((body: { series: Series | null }) => {
        if (cancelled || !body.series?.c?.length) return;
        cache.current[range] = body.series;
        setSeries(body.series);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [range, ticker]);

  const geometry = useMemo(() => {
    const closes = series?.c ?? [];
    if (closes.length < 2) return null;
    const width = 1000;
    const height = 260;
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    // 6% of head-room top and bottom: a line that touches the frame reads as clipped.
    const pad = span * 0.06;
    const scaleY = (value: number) => height - ((value - (min - pad)) / (span + pad * 2)) * height;
    const stepX = width / (closes.length - 1);
    const points = closes.map((close, i) => [i * stepX, scaleY(close)] as const);
    return {
      width, height, min, max,
      line: points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "),
      area: `M0 ${height} ${points.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} L${width} ${height} Z`,
      points,
    };
  }, [series]);

  const closes = series?.c ?? [];
  const rising = closes.length > 1 && closes[closes.length - 1] >= closes[0];
  const activeIndex = hover ?? (closes.length ? closes.length - 1 : 0);
  const activeClose = closes[activeIndex];
  const activeStamp = series?.t?.[activeIndex];

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!geometry || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * (closes.length - 1));
    setHover(Math.min(closes.length - 1, Math.max(0, index)));
  }

  return (
    <div className="chart-panel">
      <div className="chart-head">
        <div className="chart-readout">
          <b>{usd(activeClose)}</b>
          <span>
            {activeStamp
              ? new Date(activeStamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              : `${ticker} close`}
          </span>
        </div>
        <div className="chart-ranges" role="group" aria-label="Chart range">
          {RANGES.map((key) => (
            <button
              className={key === range ? "is-active" : undefined}
              disabled={isLoading && key !== range}
              key={key}
              onClick={() => setRange(key)}
              type="button"
            >
              {LABEL[key]}
            </button>
          ))}
        </div>
      </div>

      {geometry ? (
        <svg
          className={`chart-svg${rising ? " is-up" : " is-down"}`}
          ref={box}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          preserveAspectRatio="none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`${ticker} price history over ${LABEL[range]}`}
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="chart-area" d={geometry.area} fill="url(#chart-fill)" />
          <path className="chart-line" d={geometry.line} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          {hover !== null && geometry.points[hover] && (
            <g className="chart-cursor">
              <line
                x1={geometry.points[hover][0]} x2={geometry.points[hover][0]}
                y1={0} y2={geometry.height}
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={geometry.points[hover][0]} cy={geometry.points[hover][1]} r="4" vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </svg>
      ) : (
        <p className="chart-empty">
          {isLoading ? "Loading price history…" : "Price history is unavailable right now."}
        </p>
      )}

      {geometry && (
        <div className="chart-foot">
          <span>Low {usd(geometry.min)}</span>
          <span>High {usd(geometry.max)}</span>
        </div>
      )}
    </div>
  );
}
