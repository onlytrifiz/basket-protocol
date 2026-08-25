"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { PayGroupView, PayTokenView } from "../../../lib/shop/pay-tokens";
import { CoinMark } from "../coin-mark";
import { StockifyMark } from "../site-chrome";

/**
 * Choosing what to pay with.
 *
 * The list is short and curated, so it is a grid of marks rather than a
 * scrolling menu — seven logos are read at a glance where seven lines of text
 * are not.
 *
 * The groups are typeset differently on purpose. Stocks are stocks: they have
 * tickers, and a ticker belongs in mono next to a balance. Everything else
 * leads with its mark. Flattening both into one uniform grid would lose the one
 * genuinely surprising thing on this screen — that the Apple stock a dividend
 * paid out buys an Apple gift card.
 *
 * What is shown beside each entry is the wallet's own BALANCE, not a price. A
 * price is a fact about the market; on this screen the only question is which
 * of these the buyer actually has enough of.
 *
 * NOTHING IS SELECTED UNTIL SOMEONE SELECTS IT. `value` is empty until then and
 * this renders a prompt rather than an asset — deliberately, because the
 * alternative is charging whoever pressed the button without reading this for
 * whatever happened to be listed first.
 */

/** Re-exported so the client half of the checkout never has to reach into the
 *  module that builds this list — that one reads the chain. */
export type { PayGroupView };

/** Raw units as a short human string. Precision moves with magnitude, because
 *  these span a 6-decimal dollar and an 18-decimal token priced in millionths. */
export function formatBalance(raw: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = Number(raw / scale);
  const value = Number(raw) / Number(scale);
  if (raw === BigInt(0)) return "0";
  if (whole >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (whole >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (value < 0.000001) return value.toLocaleString("en-US", { maximumSignificantDigits: 2 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/**
 * The asset's mark.
 *
 * Three sources, in the order they can be trusted: the cash legs are drawn
 * inline so nothing can fail to load next to an amount someone is about to
 * commit; an equity prefers the official icon its own `contractURI()` names,
 * falling back to a favicon; and STFY uses the site's own render. A ticker
 * badge covers anything with none of those.
 */
export function PayMark({ token, size = 26 }: { token: PayTokenView; size?: number }) {
  if (token.symbol === "ETH" || token.symbol === "USDC") {
    return <CoinMark symbol={token.symbol} size={size} />;
  }
  if (token.symbol === "STFY") return <StockifyMark small />;

  const src =
    token.logo ??
    (token.domain ? `https://www.google.com/s2/favicons?domain=${token.domain}&sz=128` : undefined);
  if (src) {
    return (
      <img
        className="sh-mark"
        src={src}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="sh-mark-txt"
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {token.symbol.slice(0, 2)}
    </span>
  );
}

export function TokenPicker({
  groups,
  value,
  balances,
  onChange,
  disabled,
}: {
  groups: PayGroupView[];
  value: string;
  /** Raw balance per lowercased address. Absent while the wallet is unread. */
  balances: Record<string, bigint>;
  onChange: (address: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const all = groups.flatMap((g) => g.tokens);
  // No `?? all[0]` fallback: showing the first entry when none is chosen is
  // exactly how a buyer ends up paying in something they never picked.
  const selected = value ? all.find((t) => t.address.toLowerCase() === value.toLowerCase()) : undefined;
  // A ticker stays in mono on the trigger too, so the row that produced it is
  // recognisable in what replaced it.
  const selectedIsEquity = groups.some(
    (g) => g.kind === "equity" && g.tokens.some((t) => t.address === selected?.address),
  );

  // Escape closes, and so does a click that lands anywhere else. Both are
  // reflexes; a popover that only closes by re-clicking its trigger feels stuck.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const held = (token: PayTokenView) => {
    const raw = balances[token.address.toLowerCase()];
    if (raw === undefined) return null;
    return formatBalance(raw, token.decimals);
  };

  return (
    <div className="sh-pick" ref={root}>
      <button
        type="button"
        className={`sh-pick-btn${selected ? "" : " empty"}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !all.length}
        aria-expanded={open}
        aria-controls={panelId}
      >
        {selected ? (
          <>
            <PayMark token={selected} size={28} />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className={`sym${selectedIsEquity ? " tick" : ""}`}>{selected.symbol}</span>
              <span className="nm">{selected.name}</span>
            </span>
          </>
        ) : (
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="sym">Choose an asset</span>
            <span className="nm">Your stock, or a token</span>
          </span>
        )}
        <svg
          className={`chev${open ? " up" : ""}`}
          width="13"
          height="8"
          viewBox="0 0 12 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden
        >
          <path d="M1 1l5 5 5-5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="sh-pick-pop" id={panelId}>
          {groups.map((group) => (
            <section className={`sh-pick-grp ${group.kind}`} key={group.key}>
              {/* The rule carries the label rather than sitting under it: it
                  separates two kinds of asset, which is a division worth
                  drawing. */}
              <p className="lab">
                <span>{group.label}</span>
                <span className="rule" />
              </p>
              <ul>
                {group.tokens.map((t) => {
                  const on = t.address.toLowerCase() === value.toLowerCase();
                  const balance = held(t);
                  const empty = balance === "0";
                  return (
                    <li key={t.address}>
                      <button
                        type="button"
                        className={`${on ? "on" : ""}${empty ? " empty" : ""}`}
                        onClick={() => {
                          onChange(t.address);
                          setOpen(false);
                        }}
                        aria-pressed={on}
                        title={t.name}
                      >
                        <PayMark token={t} size={group.kind === "equity" ? 26 : 22} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="s">{t.symbol}</span>
                          {/* The balance where a price would be. Before a wallet
                              is connected there is none to show, so the name
                              takes the line rather than leaving it blank. */}
                          <span className="p">{balance ?? t.name}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
