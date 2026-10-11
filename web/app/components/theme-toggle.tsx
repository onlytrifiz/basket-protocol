"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The theme switch: a sun and a moon trading places inside a tiny sky.
 *
 * Ported from 21st.dev's "Sun Moon Dark Mode Theme Toggle" (@dhxwhy), which is written for Tailwind
 * and shadcn's `.dark` class. Here it drives the attribute this site already uses: the boot script
 * in layout.tsx sets `<html data-theme>` from `stfy-theme` before first paint, and this button reads
 * that attribute on mount and writes both back on click. The glyphs are Lucide's, inlined, since the
 * project carries no icon package. Styles live in v2.css under "Theme toggle".
 *
 * The bodies ride one arc centred below the button, like a sky dome: the outgoing one sets towards a
 * lower corner, the incoming one rises from the other with a small overshoot, and the night and day
 * skies cross-fade underneath. A second click mid-flight reverses the running swap.
 */
type Theme = "light" | "dark";
type Body = { side: -1 | 1; spin: number };

const STORAGE_KEY = "stfy-theme";
const DURATION = 1400;
const MOON: Body = { side: -1, spin: 25 };
const SUN: Body = { side: 1, spin: 120 };
const ARC_RADIUS = 115;
const QUARTER_TURN = Math.PI / 2;
const STEPS = 30;
const SKY_EASING = "cubic-bezier(0.65, 0, 0.35, 1)";
const STARS = [
  { x: 24, y: 22, r: 1.6, t: 2100 },
  { x: 66, y: 16, r: 1.2, t: 2600 },
  { x: 80, y: 42, r: 1.8, t: 1900 },
  { x: 38, y: 58, r: 1.1, t: 2900 },
  { x: 58, y: 74, r: 1.4, t: 2300 },
  { x: 14, y: 72, r: 1.2, t: 2500 },
];

const arcPoint = (side: number, angle: number) => ({
  x: side * ARC_RADIUS * Math.sin(angle),
  y: ARC_RADIUS * (1 - Math.cos(angle)),
});
const easeInCubic = (t: number) => t * t * t;
const easeOutBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

function setting({ side, spin }: Body): Keyframe[] {
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS;
    const travelled = easeInCubic(t);
    const { x, y } = arcPoint(side, travelled * QUARTER_TURN);
    return { offset: t, transform: `translate(${x}%, ${y}%) rotate(${side * spin * travelled}deg)`, opacity: t < 0.55 ? 1 : (1 - t) / 0.45 };
  });
}

function rising({ side, spin }: Body): Keyframe[] {
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = i / STEPS;
    const remaining = 1 - easeOutBack(t);
    const { x, y } = arcPoint(side, remaining * QUARTER_TURN);
    return {
      offset: t,
      transform: `translate(${x}%, ${y}%) rotate(${side * spin * remaining}deg) scale(${1 - 0.28 * remaining})`,
      opacity: Math.min(1, t / 0.3),
    };
  });
}

const FRAMES = { moonSets: setting(MOON), moonRises: rising(MOON), sunSets: setting(SUN), sunRises: rising(SUN) };
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const readTheme = (): Theme => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

export function ThemeToggle() {
  // Dark is what the server renders, so it is also the first client render; the real value is read
  // on mount, and both bodies stay transparent until then so nothing flashes the wrong one.
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);
  const moon = useRef<HTMLSpanElement>(null);
  const sun = useRef<HTMLSpanElement>(null);
  const night = useRef<HTMLSpanElement>(null);
  const day = useRef<HTMLSpanElement>(null);
  const flight = useRef<Animation[]>([]);
  const committed = useRef({ theme, mounted });

  useEffect(() => {
    setTheme(readTheme());
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    const before = committed.current;
    committed.current = { theme, mounted };
    if (!before.mounted || before.theme === theme) return;

    if (flight.current.length > 0) {
      for (const animation of flight.current) animation.reverse();
      return;
    }
    if (!moon.current || !sun.current || typeof moon.current.animate !== "function" || reduced()) return;
    const toLight = theme === "light";
    const pair = [
      (toLight ? moon.current : sun.current).animate(toLight ? FRAMES.moonSets : FRAMES.sunSets, { duration: DURATION * 0.65, fill: "both" }),
      (toLight ? sun.current : moon.current).animate(toLight ? FRAMES.sunRises : FRAMES.moonRises, { duration: DURATION * 0.64, delay: DURATION * 0.36, fill: "both" }),
    ];
    if (night.current && day.current) {
      const options = { duration: DURATION, easing: SKY_EASING, fill: "both" as const };
      pair.push(
        night.current.animate([{ opacity: toLight ? 1 : 0 }, { opacity: toLight ? 0 : 1 }], options),
        day.current.animate([{ opacity: toLight ? 0 : 1 }, { opacity: toLight ? 1 : 0 }], options),
      );
    }
    flight.current = pair;
    Promise.all(pair.map((animation) => animation.finished)).then(
      () => {
        if (flight.current !== pair) return;
        flight.current = [];
        for (const animation of pair) animation.cancel();
      },
      () => { /* cancelled mid-flight: nothing to settle */ },
    );
  }, [theme, mounted]);

  /* The stars twinkle on their own clocks, and only for readers who did not ask for less motion. */
  useEffect(() => {
    const sky = night.current;
    if (!sky || reduced() || typeof sky.animate !== "function") return;
    const twinkles = [...sky.querySelectorAll<HTMLElement>("[data-star]")].map((star, index) =>
      star.animate([{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }], {
        duration: STARS[index]?.t ?? 2400, delay: -index * 530, iterations: Infinity, easing: "ease-in-out",
      }),
    );
    return () => twinkles.forEach((animation) => animation.cancel());
  }, []);

  useEffect(() => () => { for (const animation of flight.current) animation.cancel(); }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: the choice simply does not persist */
    }
  }

  const rest = (body: Body, visible: boolean): React.CSSProperties => ({
    opacity: mounted && visible ? 1 : 0,
    transform: visible ? "none" : `translate(${body.side * ARC_RADIUS}%, ${ARC_RADIUS}%)`,
  });

  return (
    <button
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="theme-toggle sky-toggle"
      data-state={theme}
      onClick={toggle}
      type="button"
    >
      <span aria-hidden="true" className="sky-layer is-night" ref={night} style={{ opacity: mounted ? (theme === "dark" ? 1 : 0) : 1 }}>
        {STARS.map((star, index) => (
          <span
            className="sky-star"
            data-star
            key={index}
            style={{ height: star.r * 2, left: `${star.x}%`, top: `${star.y}%`, width: star.r * 2 }}
          />
        ))}
      </span>
      {/* The day's answer to the stars: two small clouds drifting across, so the light state is a
          scene as much as the night is, not a flat gradient behind an outline. */}
      <span aria-hidden="true" className="sky-layer is-day" ref={day} style={{ opacity: mounted && theme === "light" ? 1 : 0 }}>
        <span className="sky-cloud is-a" />
        <span className="sky-cloud is-b" />
      </span>
      <span aria-hidden="true" className="sky-body is-moon" ref={moon} style={rest(MOON, theme === "dark")}>
        <svg fill="currentColor" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
      </span>
      <span aria-hidden="true" className="sky-body is-sun" ref={sun} style={rest(SUN, theme === "light")}>
        {/* Filled, like the moon: a warm disc with short rounded rays, where Lucide's outline sun read
            as a thin glyph next to a solid crescent. */}
        <svg viewBox="0 0 24 24">
          <defs>
            <radialGradient cx="40%" cy="35%" id="sky-sun-fill" r="70%">
              <stop offset="0" stopColor="#fff3b0" />
              <stop offset=".55" stopColor="#ffc93d" />
              <stop offset="1" stopColor="#ff9416" />
            </radialGradient>
          </defs>
          <path d="M12 1.8v2.6M12 19.6v2.6M4.8 4.8l1.8 1.8m10.8 10.8 1.8 1.8M1.8 12h2.6m15.2 0h2.6M4.8 19.2l1.8-1.8m10.8-10.8 1.8-1.8" stroke="#ffb22e" strokeLinecap="round" strokeWidth="2.2" />
          <circle cx="12" cy="12" fill="url(#sky-sun-fill)" r="5.6" />
        </svg>
      </span>
    </button>
  );
}
