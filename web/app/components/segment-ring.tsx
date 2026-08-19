/**
 * The logo's segmented ring, reduced to a UI primitive: always eight arcs.
 * `filled` marks how many segments are complete; `lit` turns the last filled
 * segment lime, which is only correct when that segment stands for value
 * reaching a holder — a settled distribution or a paid dividend.
 */

const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const STEP = CIRCUMFERENCE / 8;
const GAP = 7.6;
const DASH = STEP - GAP;

type SegmentRingProps = {
  className?: string;
  filled?: number;
  lit?: boolean;
  motion?: "none" | "spin" | "sweep";
  size?: number;
  stroke?: number;
  title?: string;
};

export function SegmentRing({
  className,
  filled = 0,
  lit = false,
  motion = "none",
  size = 34,
  stroke = 10,
  title,
}: SegmentRingProps) {
  const motionClass = motion === "spin" ? "ring-spin" : motion === "sweep" ? "ring-sweep" : undefined;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={`ring${className ? ` ${className}` : ""}`}
      height={size}
      role={title ? "img" : undefined}
      viewBox="0 0 100 100"
      width={size}
    >
      {title ? <title>{title}</title> : null}
      {/* The outer group holds the 12-o'clock start; the inner one animates,
          because a CSS transform would otherwise replace the attribute. */}
      <g transform="rotate(-90 50 50)">
        <g className={motionClass} fill="none" strokeLinecap="butt" strokeWidth={stroke}>
          {Array.from({ length: 8 }, (_, index) => {
            const isFilled = index < filled;
            const isLit = lit && index === filled - 1;
            return (
              <circle
                className={isLit ? "ring-seg-lit" : isFilled ? "ring-seg" : "ring-track"}
                cx="50"
                cy="50"
                key={index}
                r={RADIUS}
                strokeDasharray={`${DASH} ${CIRCUMFERENCE - DASH}`}
                strokeDashoffset={-index * STEP}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
}

/** Ring + ordinal, the standard step marker for 01–0n sequences. */
export function RingMarker({
  filled,
  label,
  lit = false,
  size = 34,
}: {
  filled: number;
  label: string;
  lit?: boolean;
  size?: number;
}) {
  return (
    <span className={`ring-marker${lit ? " is-payout" : ""}`}>
      <SegmentRing filled={filled} lit={lit} size={size} />
      <b>{label}</b>
    </span>
  );
}
