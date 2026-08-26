"use client";

import { useMemo, useRef, useState } from "react";
import type { MarketChartData } from "../../lib/blockworks";
import { usdCompact, compactNumber } from "../../lib/format";

/**
 * The market section's chart, hand-rolled like `PriceChart` and for the same reason: a charting
 * library would outweigh the app to draw lines and rectangles.
 *
 * The chart KINDS mirror the Blockworks originals widget for widget — supply as an area, per-
 * entity composition as a stacked area, flows as stacked bars, counts as lines — read out of
 * their dashboard's own widget config, so a reader landing here from there is never asked to
 * re-learn a chart.
 *
 * Same interaction contract as `PriceChart` too — no floating tooltip. The values live in the
 * legend chips and the date in the readout, and HOVER RETARGETS BOTH: a tooltip chasing the
 * pointer over a six-series chart covers the very lines it annotates, while chips that update in
 * place keep every series legible at once. With no hover the chips show the newest point, so the
 * resting state is already an answer, and identity is carried by name-beside-swatch rather than
 * color alone.
 *
 * The timeframe buttons slice the series the page already shipped — the full history is in the
 * payload either way, so a range change costs zero requests and works offline from the first
 * paint. The y-scale refits the slice, which is the whole point of zooming.
 *
 * The SVG stretches (`preserveAspectRatio="none"`) and contains no text, so nothing distorts;
 * strokes hold their width through `vectorEffect`.
 */

const W = 1000;
const H = 240;
// 6% head-room: a mark that touches the frame reads as clipped.
const PAD = 0.06;

const RANGES = [
  { key: "3m", label: "3M", months: 3 },
  { key: "6m", label: "6M", months: 6 },
  { key: "1y", label: "1Y", months: 12 },
  { key: "all", label: "ALL", months: null },
] as const;

type Kind = "area" | "stack" | "lines" | "bars";
type Fmt = "usd" | "count";

const fmt = (kind: Fmt, value: number | null | undefined) =>
  value === null || value === undefined ? "—" : kind === "usd" ? usdCompact(value) : compactNumber(value);

function label(date: string | undefined, weekly: boolean): string {
  if (!date) return "";
  const text = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  return weekly ? `Week of ${text}` : text;
}

export function MarketChart({
  title, hint, data, kind, format = "usd", weekly = false, defaultRange = "all",
}: {
  title: string;
  hint: string;
  data: MarketChartData;
  kind: Kind;
  format?: Fmt;
  weekly?: boolean;
  /** Where the chart opens. Slow stocks read best over a year, weekly flows over months. */
  defaultRange?: "3m" | "6m" | "1y" | "all";
}) {
  const [range, setRange] = useState<string>(defaultRange);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<SVGSVGElement>(null);

  // The visible slice. Cut by calendar months back from the NEWEST point (not from today, so a
  // stale upstream still yields a full window), and never down to fewer than two points.
  const view = useMemo(() => {
    const months = RANGES.find((r) => r.key === range)?.months;
    if (!months) return data;
    const cut = new Date(`${data.dates[data.dates.length - 1]}T00:00:00Z`);
    cut.setUTCMonth(cut.getUTCMonth() - months);
    const cutoff = cut.toISOString().slice(0, 10);
    let start = data.dates.findIndex((d) => d >= cutoff);
    if (start <= 0) return data;
    start = Math.min(start, data.dates.length - 2);
    return {
      dates: data.dates.slice(start),
      series: data.series.map((s) => ({ ...s, v: s.v.slice(start) })),
    };
  }, [data, range]);

  const { dates, series } = view;
  const last = dates.length - 1;
  const active = hover ?? last;
  const stacked = kind === "stack" || kind === "bars";

  const geometry = useMemo(() => {
    const totals = dates.map((_, i) => series.reduce((sum, s) => sum + (s.v[i] ?? 0), 0));
    const peak = stacked
      ? Math.max(...totals)
      : Math.max(...series.flatMap((s) => s.v.filter((v): v is number => v !== null)));
    if (!Number.isFinite(peak) || peak <= 0) return null;
    const top = peak * (1 + PAD);
    const y = (value: number) => H - (value / top) * H;
    const x = (i: number) => (dates.length > 1 ? (i / (dates.length - 1)) * W : W / 2);

    if (kind === "bars") {
      const bw = W / dates.length;
      const bars = dates.map((_, i) => {
        let acc = 0;
        const slices = series.map((s) => {
          const value = s.v[i] ?? 0;
          const y1 = y(acc + value);
          const slice = { color: s.color, y: y1, h: y(acc) - y1 };
          acc += value;
          return slice;
        });
        return { x: i * bw + bw * 0.15, w: bw * 0.7, slices, total: acc };
      });
      return { bars, bands: null, lines: null, area: null, x, y, totals };
    }

    if (kind === "stack") {
      // Bands, largest series at the baseline. A null contributes nothing to the stack — an
      // issuer that is not live yet is absent, which for a composition is the same thing.
      const cums = series.map(() => new Array<number>(dates.length).fill(0));
      dates.forEach((_, i) => {
        let acc = 0;
        series.forEach((s, si) => { acc += s.v[i] ?? 0; cums[si][i] = acc; });
      });
      const bands = series
        // A series that is zero through the whole window would still paint its 2px edge along the
        // band below it — an issuer with nothing minted read as owning the top of the stack. Not
        // drawn at all; it keeps its legend chip, where "$0" says the same thing honestly.
        .map((s, si) => ({ s, si }))
        .filter(({ s }) => s.v.some((v) => (v ?? 0) > 0))
        .map(({ s, si }) => {
          const topEdge = dates.map((_, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(cums[si][i]).toFixed(1)}`).join("");
          const back = [...dates.keys()].reverse()
            .map((i) => `L${x(i).toFixed(1)} ${y(si ? cums[si - 1][i] : 0).toFixed(1)}`).join("");
          return { color: s.color, fill: `${topEdge}${back}Z`, edge: topEdge, topOf: (i: number) => y(cums[si][i]) };
        });
      return { bars: null, bands, lines: null, area: null, x, y, totals };
    }

    // Lines (and the single-series area): a null breaks the path rather than drawing a dive to zero.
    const lines = series.map((s) => {
      let d = "";
      let pen = false;
      s.v.forEach((value, i) => {
        if (value === null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
        pen = true;
      });
      return { color: s.color, d };
    });
    const area =
      kind === "area" && series.length === 1
        ? `M0 ${H} ${series[0].v.map((v, i) => `L${x(i).toFixed(1)} ${y(v ?? 0).toFixed(1)}`).join(" ")} L${W} ${H} Z`
        : null;
    return { bars: null, bands: null, lines, area, x, y, totals };
  }, [dates, series, kind, stacked]);

  if (!geometry) return null;

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!box.current) return;
    const rect = box.current.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    setHover(Math.min(last, Math.max(0, Math.round(ratio * last))));
  }

  const total = stacked ? geometry.totals[active] : series.length === 1 ? series[0].v[active] : null;

  return (
    <article className="mkt-card">
      <header className="mkt-card-head">
        <div>
          <h3>{title}</h3>
          <p>{hint}</p>
        </div>
        <div className="mkt-head-side">
          <div className="mkt-readout">
            {total !== null && <b>{fmt(format, total)}</b>}
            <span>{label(dates[active], weekly)}</span>
          </div>
          <div aria-label={`${title} range`} className="mkt-ranges" role="group">
            {RANGES.map((r) => (
              <button
                className={r.key === range ? "is-active" : undefined}
                key={r.key}
                onClick={() => { setRange(r.key); setHover(null); }}
                type="button"
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <svg
        aria-label={`${title} — ${hint}`}
        className="mkt-svg"
        onPointerLeave={() => setHover(null)}
        onPointerMove={onMove}
        preserveAspectRatio="none"
        ref={box}
        role="img"
        viewBox={`0 0 ${W} ${H}`}
      >
        {geometry.bars &&
          geometry.bars.map((bar, i) => (
            <g key={i} opacity={hover === null || hover === i ? 1 : 0.45}>
              {bar.slices.map((slice, j) =>
                slice.h > 0 ? <rect fill={slice.color} height={slice.h} key={j} width={bar.w} x={bar.x} y={slice.y} /> : null,
              )}
            </g>
          ))}

        {geometry.bands && (
          <>
            {/* Quiet fills, loud edges: the 2px edge carries each hue at full strength for the
                color-blind separation the palette was validated for. */}
            {geometry.bands.map((band, i) => (
              <path d={band.fill} fill={band.color} fillOpacity="0.4" key={`f${i}`} />
            ))}
            {geometry.bands.map((band, i) => (
              <path d={band.edge} fill="none" key={`e${i}`} stroke={band.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            ))}
            {hover !== null && (
              <g className="mkt-cursor">
                <line vectorEffect="non-scaling-stroke" x1={geometry.x(hover)} x2={geometry.x(hover)} y1={0} y2={H} />
                {geometry.bands.map((band, i) => (
                  <circle cx={geometry.x(hover)} cy={band.topOf(hover)} fill={band.color} key={i} r="4" vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            )}
          </>
        )}

        {geometry.lines && (
          <>
            {geometry.area && <path className="mkt-area" d={geometry.area} fill={series[0].color} />}
            {geometry.lines.map((line, i) => (
              <path d={line.d} fill="none" key={i} stroke={line.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            ))}
            {hover !== null && (
              <g className="mkt-cursor">
                <line vectorEffect="non-scaling-stroke" x1={geometry.x(hover)} x2={geometry.x(hover)} y1={0} y2={H} />
                {series.map((s, i) =>
                  s.v[hover] !== null ? (
                    <circle cx={geometry.x(hover)} cy={geometry.y(s.v[hover]!)} fill={s.color} key={i} r="4" vectorEffect="non-scaling-stroke" />
                  ) : null,
                )}
              </g>
            )}
          </>
        )}
      </svg>

      {series.length > 1 && (
        <footer className="mkt-legend">
          {series.map((s) => (
            <span className="mkt-chip" key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
              <b>{fmt(format, s.v[active])}</b>
            </span>
          ))}
        </footer>
      )}
    </article>
  );
}
