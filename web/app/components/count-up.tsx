"use client";

import { useEffect, useRef } from "react";

import { compactNumber, shares, usdCompact } from "../../lib/format";

const FORMATS = { usdCompact, shares, integer: (n: number) => Math.round(n).toLocaleString("en-US"), compact: compactNumber };

/**
 * A headline figure that counts up from zero the first time it scrolls into view.
 *
 * The server renders the FINAL figure, so the markup is identical on both sides (no hydration
 * mismatch), a reader without JavaScript sees the real number, and so does one who asked for less
 * motion: the count only ever runs on the client, after mount, and only when motion is allowed.
 * Frames write `textContent` directly rather than setting state, so a count is not 60 re-renders.
 */
export function CountUp({ value, format, duration = 1100 }: { value: number; format: keyof typeof FORMATS; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !Number.isFinite(value) || value <= 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const render = FORMATS[format];
    let frame = 0;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 4;
        el.textContent = render(value * eased);
        if (t < 1) frame = requestAnimationFrame(tick);
        else el.textContent = render(value);
      };
      el.textContent = render(0);
      frame = requestAnimationFrame(tick);
    }, { threshold: 0.6 });

    observer.observe(el);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [value, format, duration]);

  return <span className="count-up" ref={ref}>{FORMATS[format](value)}</span>;
}
