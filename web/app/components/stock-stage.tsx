"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { StockLogo } from "./stock-logo";

export type StageStock = {
  symbol: string;
  name: string;
  domain?: string;
  /** The company's own mark colour — see `lib/stocks`. */
  brand: string;
  /** Official Coinbase equity icon, read from the token's `contractURI()`. */
  logo?: string;
  /** Target weight in basis points when the vault buys this one, null when it does not. */
  weightBps: number | null;
  /** Shares in existence, multiplier applied. `null` when the read did not land — which is not
   *  zero, and is never rendered as a number. */
  shares: number | null;
  /** Cumulative shares of this equity pushed to holders, all time. Zero for one the vault has
   *  never bought — which includes names it holds today but has not yet paid out. */
  distributed: number;
  /** The same quantity in dollars, `null` when the equity has no quote to price it with. */
  distributedValue: number | null;
};

/** How far ahead of the centre a card is still POSED. Beyond this every card shares one parked
 *  position at zero opacity, which is what makes the wrap invisible: a card crossing from the end
 *  of the row to its start animates while it cannot be seen. */
const WINDOW = 3;

/**
 * How many neighbours either side are actually VISIBLE — and why it is not a constant.
 *
 * A card teleports when its signed distance flips sign the long way round, which for `n` cards
 * happens between `-(ceil(n/2) - 1)` and `floor(n/2)`. The jump is only invisible if the card is
 * already transparent at the offset it leaves from. With thirteen cards that boundary is ±6, far
 * outside the three drawn positions, so two visible neighbours each side is safe. With six it is
 * between -2 and +3 — and a card sitting at -2 is two thirds opaque, so it would vanish from the
 * left and reappear on the right in plain sight.
 *
 * Shrinking the visible window to one neighbour puts the boundary back inside the transparent
 * region. It is the count that decides, not the layout, so a sixth listing added to the fan
 * tomorrow cannot reintroduce the pop by accident.
 */
const visibleWindow = (count: number) => Math.min(2, Math.ceil(count / 2) - 2);

/**
 * The shortest ring that can show two neighbours a side without the wrap showing.
 *
 * From the same inequality: the teleport sits at `ceil(N/2) - 1`, and it has to land outside the
 * visible window, so `ceil(N/2) - 1 > 2` — seven cards. A six-name fan is one short, and the fix
 * is to render the list twice rather than to accept three cards or invent a seventh listing. With
 * the ring at twelve, a stock and its copy are six positions apart and the drawn window is five, so
 * no reader ever sees the same card twice on screen.
 *
 * `active` then indexes the RING; every label, count and link takes `active % count` so the
 * duplication stays where it belongs, in the geometry.
 */
const RING_MIN = 7;
const AUTOPLAY_MS = 4500;

/** Pointer travel that counts as a swipe rather than a tap. Below it the press selects the card. */
const SWIPE_PX = 40;

/** Scene rotation at the far edge of the stage, in degrees.
 *
 * Deliberately tiny. The reference this is modelled on moves ±4° of yaw and ±2° of pitch, and that
 * restraint is the whole effect: past roughly 7° the cards stop reading as objects sitting in a
 * space and start reading as a toy that tilts. */
const SCENE_YAW = 4;
const SCENE_PITCH = 2;
const SCENE_SHIFT = 5;

const formatShares = (shares: number) =>
  shares >= 1_000_000
    ? `${(shares / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`
    : shares.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Fractional, unlike the supply figure above: a holder's entitlement is measured in hundredths of
 *  a share, and rounding 0.68 to "1" would overstate every early cycle. */
const formatPaid = (shares: number) =>
  shares.toLocaleString("en-US", { maximumFractionDigits: shares >= 100 ? 2 : 4 });

const formatUsd = (value: number) =>
  value >= 1000
    ? `$${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`
    : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/**
 * The listed universe as a fan of cards in depth.
 *
 * WHY A CAROUSEL AND NOT THE GRID IT REPLACES. Thirteen tiles answered "which assets exist" in one
 * glance and nothing else; a reader who wanted the list went to /stocks anyway. What the grid could
 * not say is that these are *objects the vault buys* — so the fan gives each one a face, and the
 * strip underneath answers the one question the tile left open: is this one in the index, and at
 * what weight.
 *
 * THE MOTION IS CSS, NOT JAVASCRIPT. Every card position lives in a `[data-offset]` rule; this
 * component only decides which offset each card carries. That keeps the animation on the compositor,
 * survives a re-render mid-transition, and means the whole fan is inspectable in devtools by
 * changing one attribute. The pointer parallax writes two custom properties on the stage and lets
 * the same CSS transition do the easing.
 *
 * OFFSETS WRAP. `d` is the signed distance to the active card measured the short way round, so with
 * thirteen cards it runs -6..6 and the row has no ends: the card leaving on the right re-enters on
 * the left. Clamping the drawn range to ±3 is what hides the seam, because a card travelling from
 * +3 to -3 does it at zero opacity.
 */
export function StockStage({ stocks, variant = "panel" }: { stocks: StageStock[]; variant?: "panel" | "band" }) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; id: number } | null>(null);

  const count = stocks.length;
  const repeats = Math.max(1, Math.ceil(RING_MIN / count));
  const ring = count * repeats;
  const step = useCallback(
    (delta: number) => setActive((current) => (((current + delta) % ring) + ring) % ring),
    [ring],
  );

  /* Autoplay stops while a pointer or the keyboard is inside the stage, and never starts for a
     reader who asked for less motion. A carousel that keeps moving under the cursor takes the card
     away from the person reaching for it. */
  useEffect(() => {
    if (paused || ring < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => step(1), AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [paused, ring, step]);

  /* Parallax, on fine pointers only. A touch device has no hover to read it with, and wiring it to
     touch would fight the swipe. */
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage || event.pointerType !== "mouse") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = stage.getBoundingClientRect();
    // -1..1 from the centre of the stage, on both axes.
    const x = (event.clientX - box.left) / box.width * 2 - 1;
    const y = (event.clientY - box.top) / box.height * 2 - 1;
    stage.style.setProperty("--scene-ry", `${(-x * SCENE_YAW).toFixed(2)}deg`);
    stage.style.setProperty("--scene-rx", `${(y * SCENE_PITCH).toFixed(2)}deg`);
    stage.style.setProperty("--scene-x", `${(-x * SCENE_SHIFT).toFixed(1)}px`);
    stage.style.setProperty("--scene-y", `${(-y * SCENE_SHIFT * 0.7).toFixed(1)}px`);
  };

  const restScene = () => {
    const stage = stageRef.current;
    if (!stage) return;
    for (const property of ["--scene-ry", "--scene-rx", "--scene-x", "--scene-y"]) {
      stage.style.removeProperty(property);
    }
  };

  /* Swipe. Tracked on the stage rather than per card so a drag that starts on a gap still counts,
     and measured on release so a press that never travelled stays a selection. */
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pressRef.current = { x: event.clientX, id: event.pointerId };
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press || press.id !== event.pointerId) return;
    const travel = event.clientX - press.x;
    if (Math.abs(travel) >= SWIPE_PX) step(travel < 0 ? 1 : -1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
  };

  /** Which listing is centred, as opposed to which ring position. */
  const activeIndex = active % count;
  const current = stocks[activeIndex];
  const half = Math.floor(ring / 2);

  const band = variant === "band";
  const paid = current.distributed > 0;

  return (
    <div
      className={`stock-stage${band ? " is-band" : ""}`}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
      onFocus={() => setPaused(true)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => { setPaused(false); restScene(); }}
    >
      {/* THE TWO GUTTERS. The band is 1200px of rail with a ~900px fan in the middle, so the
          flanks were empty space either side of the cards — and the one question a reader has
          about a card they just centred is what it has actually paid out.

          Not a live region: `.stage-jump` below already announces the change, and two of them
          firing on one keypress reads the same event twice. The figures stay reachable by
          ordinary navigation. */}
      {band && (
        <div className="stage-flanks">
          <div className={`stage-flank${paid ? " is-paid" : ""}`}>
            <span>Stocks distributed</span>
            <strong>{paid ? formatPaid(current.distributed) : "—"}</strong>
            <small>{paid ? current.symbol : "not paid out yet"}</small>
          </div>
          <div className="stage-flank is-right">
            <span>Distribution value</span>
            <strong>{current.distributedValue === null ? "—" : formatUsd(current.distributedValue)}</strong>
            <small>
              {current.distributedValue !== null
                ? "at current prices"
                : paid ? "no quote for this one" : "nothing distributed"}
            </small>
          </div>
        </div>
      )}

      <div
        className="stage-floor"
        onKeyDown={onKeyDown}
        onPointerCancel={() => { pressRef.current = null; }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={stageRef}
      >
        <div aria-hidden="true" className="stage-backdrop">
          <span className="stage-horizon" />
          <span className="stage-wordmark">STOCKIFY</span>
          <span className="stage-shadow" />
        </div>

        <div
          aria-label="Listed B20 equities"
          aria-roledescription="carousel"
          className="stage-depth"
          data-window={visibleWindow(ring)}
          role="group"
        >
          {Array.from({ length: ring }, (_, position) => {
            const index = position % count;
            const stock = stocks[index];
            // Signed distance the short way round, then clamped to the drawn window.
            const raw = ((position - active) % ring + ring) % ring;
            const distance = raw > half ? raw - ring : raw;
            const offset = Math.max(-WINDOW, Math.min(WINDOW, distance));
            const hidden = Math.abs(distance) >= WINDOW;
            return (
              <button
                aria-hidden={hidden}
                aria-label={`Show ${stock.name}`}
                aria-pressed={position === active}
                className="stage-card"
                data-offset={offset}
                key={position}
                onClick={() => setActive(position)}
                style={{ "--brand": stock.brand } as React.CSSProperties}
                tabIndex={hidden ? -1 : 0}
                type="button"
              >
                <span aria-hidden="true" className="stage-card-body">
                  <span className="stage-card-face">
                    <span className="stage-card-top">
                      <span>B20 / BASE</span>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </span>
                    {/* The ticker in outline, behind the mark. It is the card's texture rather than
                        its label — the readable one is in the strip below and in aria-label. */}
                    <span className="stage-card-ghost">{stock.symbol.replace(/c$/, "")}</span>
                    <span className="stage-card-emblem">
                      <StockLogo logo={stock.logo} size="large" stock={stock} />
                    </span>
                    <span className="stage-card-foot">
                      <strong>{stock.name}</strong>
                      <span>{stock.weightBps === null ? "Tokenized stock" : "In the dividends"}</span>
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="stage-controls">
          <p className="stage-counter">
            <b>{String(activeIndex + 1).padStart(2, "0")}</b>
            <span>/ {count}</span>
          </p>
          <div className="stage-arrows">
            <button aria-label="Previous stock" onClick={() => step(-1)} type="button">
              <svg aria-hidden="true" focusable="false" viewBox="0 0 6 10">
                <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
              </svg>
            </button>
            <button aria-label="Next stock" onClick={() => step(1)} type="button">
              <svg aria-hidden="true" focusable="false" viewBox="0 0 6 10">
                <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
              </svg>
            </button>
          </div>
        </div>
        {band
          ? (
            <Link aria-live="polite" className="stage-jump" href={`/stocks/${current.symbol.toLowerCase()}`}>
              <b>{current.name}</b>
              <span>{current.symbol}</span>
              <i aria-hidden="true">→</i>
            </Link>
          )
          : <p className="stage-hint">Drag, or use the arrow keys</p>}
      </div>

      {/* The readable half. `aria-live` because the cards above are decorative to a screen reader:
          pressing one has to say what changed somewhere. */}
      {!band && (
      <div aria-live="polite" className="stage-summary">
        <div className="stage-identity">
          <strong>{current.name}</strong>
          <span>{current.symbol}</span>
        </div>
        <div className="stage-figure">
          <span>{current.weightBps === null ? "Shares outstanding" : "Target weight"}</span>
          <strong>
            {current.weightBps === null
              ? (current.shares === null ? "Unread" : formatShares(current.shares))
              : `${(current.weightBps / 100).toFixed(2)}%`}
          </strong>
          <small>{current.weightBps === null ? "not bought by the vault" : "of each stock budget"}</small>
        </div>
        <Link className="button button-ink stage-open" href={`/stocks/${current.symbol.toLowerCase()}`}>
          Open {current.symbol} <span aria-hidden="true">→</span>
        </Link>
      </div>
      )}
    </div>
  );
}
