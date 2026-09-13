"use client";

import { useEffect, useState } from "react";

/**
 * How far the vault is through the wait for its next cycle.
 *
 * WHY THIS IS A CLIENT COMPONENT. The figure beside it — "next cycle in 44m" — is a server snapshot,
 * and that is honest for text: a reader understands a printed number as a reading taken at some
 * moment. A progress bar does not read that way. A bar claims to be showing a thing in motion, and
 * one frozen at whatever fraction the request happened to catch is a worse lie than no bar at all.
 * So it ticks.
 *
 * `now` ARRIVES AS A PROP for the first render. Calling `Date.now()` during render would produce
 * one value on the server and a different one in the browser, and React would flag the mismatch and
 * discard the server's markup. Seeded from the server, the two first renders agree; the interval
 * takes over on mount.
 *
 * THE WINDOW IS REAL, not a guess at the cadence. It runs from the settlement that actually
 * happened to the earliest start the vault itself reports, so the bar measures the interval the
 * contract is in rather than an assumed hour. When the vault has not named a next start, or the
 * window would be empty, there is nothing to be a fraction of and the track stays dark.
 */
export function CycleProgress({
  active,
  from,
  label,
  now: seeded,
  to,
}: {
  /** A cycle is settling right now: the wait is over and the fraction is meaningless. */
  active: boolean;
  /** Unix seconds of the last settlement. */
  from: number;
  /** What to call the cycle being waited for — "#543", or "the first cycle". */
  label: string;
  /** Unix seconds at render time, from the server. */
  now: number;
  /** Unix seconds of the earliest start the vault reports. 0 when it reports none. */
  to: number;
}) {
  const [now, setNow] = useState(seeded);

  useEffect(() => {
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const span = to - from;
  const known = to > 0 && span > 0;
  const fraction = active ? 1 : known ? Math.min(1, Math.max(0, (now - from) / span)) : 0;
  const remaining = Math.max(0, Math.round(to - now));

  /* Seconds only inside the last minute. Above it they are noise on a cadence measured in hours,
     and a digit changing every second draws the eye to the least important part of the figure. */
  const countdown = () => {
    if (active) return "settling";
    if (!known) return "unscheduled";
    if (remaining <= 0) return "due now";
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m`;
    return `${remaining}s`;
  };

  return (
    <div className="cycle-progress">
      <div className="cycle-progress-head">
        <span className="cycle-progress-id">
          <i aria-hidden="true" />
          Cycle {label}
        </span>
        <b>{countdown()}</b>
      </div>

      {/* The bar is decoration over the two figures above it, which is why it is hidden rather than
          given a role: a `progressbar` here would make a screen reader read the same wait twice. */}
      <div aria-hidden="true" className={`cycle-progress-track${active ? " is-active" : ""}`}>
        <span style={{ transform: `scaleX(${fraction.toFixed(4)})` }} />
      </div>

      <div className="cycle-progress-foot">
        <span>{active ? "Pushing assets to holders" : "Hook fees accruing"}</span>
        <span>{known || active ? "earliest start" : "no start scheduled"}</span>
      </div>
    </div>
  );
}
