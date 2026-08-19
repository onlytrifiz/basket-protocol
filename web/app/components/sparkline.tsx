import type { Series } from "../../lib/market";

/**
 * A month of closes as a bare path — no axes, no grid, no library.
 *
 * Deliberately unlabelled: at this size a reader can only take shape from it, and any number small
 * enough to fit would be too small to read honestly. The figure beside it carries the actual value.
 *
 * Renders nothing when the series is missing, which is a real state rather than an error — Yahoo
 * throttles, and a row without its mini-chart is a page that still works.
 */
export function Sparkline({ series, width = 78, height = 26 }: { series?: Series | null; width?: number; height?: number }) {
  const closes = series?.c ?? [];
  if (closes.length < 2) return <span className="sparkline sparkline-empty" aria-hidden="true" />;

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  // A flat line would divide by zero and, drawn at the top of the box, would read as a rally.
  const span = max - min || 1;
  const stepX = width / (closes.length - 1);

  const points = closes.map((close, i) => {
    const x = i * stepX;
    const y = height - ((close - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const rising = closes[closes.length - 1] >= closes[0];

  return (
    <svg
      className={`sparkline${rising ? " is-up" : " is-down"}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points={points.join(" ")} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
