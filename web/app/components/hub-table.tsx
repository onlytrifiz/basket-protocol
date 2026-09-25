"use client";

import { Fragment, useId, useMemo, useState, type ReactNode } from "react";

export type HubSortKey = "asset" | "onChain" | "nasdaq" | "month" | "supply" | "liquidity" | "premium";

export type HubItem = {
  key: string;
  /** The row exactly as the server rendered it. This component orders and hides rows; it never
   *  draws one, so a row cannot look different here from anywhere else it is rendered. */
  node: ReactNode;
  /** Symbol, company, ticker and contract address, lowercased — what the search box matches
   *  against. The address is in there because a pasted contract is how people arrive from a wallet. */
  text: string;
  /** Supply is not zero. An UNREAD supply counts as minted, for the reason the hub has always
   *  given: hiding a row because the chain did not answer would let an RPC hiccup delete it. */
  minted: boolean;
  /** Has an on-chain price to trade against. */
  trading: boolean;
  values: Record<HubSortKey, number | string | null>;
};

type View = "all" | "minted" | "trading";

const inView = (item: HubItem, view: View) => view === "all" || (view === "minted" ? item.minted : item.trading);
const matches = (item: HubItem, needle: string) => !needle || item.text.includes(needle);

const COLUMNS: Array<{ key: HubSortKey | null; label: string }> = [
  { key: "asset", label: "Asset" },
  { key: "onChain", label: "On-chain" },
  { key: "nasdaq", label: "Nasdaq" },
  { key: "month", label: "30d" },
  { key: "supply", label: "Supply" },
  { key: "liquidity", label: "Liquidity" },
  { key: "premium", label: "Premium" },
  { key: null, label: "" },
];

/**
 * The direction a column opens in. Numbers open big-first and text A-first, as in the market
 * table — except the premium, which opens on the deepest DISCOUNT: below the share is the side a
 * buyer wants, and it is the reading this page exists to offer.
 */
const firstDir = (key: HubSortKey): 1 | -1 => (key === "asset" || key === "premium" ? 1 : -1);

const SORT_OPTIONS: Array<{ key: HubSortKey | null; label: string }> = [
  { key: null, label: "Deepest market first" },
  { key: "premium", label: "Premium, discount first" },
  { key: "month", label: "30-day move" },
  { key: "nasdaq", label: "Share price" },
  { key: "onChain", label: "On-chain price" },
  { key: "liquidity", label: "Liquidity" },
  { key: "supply", label: "Supply" },
  { key: "asset", label: "Ticker, A–Z" },
];

/**
 * The hub table's header, search, views and order — over rows the server already rendered.
 *
 * At forty-three listings the table stopped being something a reader scans and became something
 * they look things up in, so it gains the three tools that job needs. None of them costs a
 * request: every row is in the payload, and filtering and sorting are view state over it.
 *
 * THE RESTING ORDER IS THE SERVER'S: deepest market first, then largest supply. No column claims
 * it, so no header shows an arrow until someone asks for one. A null never wins a sort in either
 * direction — "we don't have this number" sorted above real numbers would read as a superlative.
 *
 * The view opens on MINTED, which is what the fold under the table used to do: most listings are
 * an address and nothing else, and leading with them buries the ones that trade. The bar at the
 * foot still says how many are behind it, now as a switch to the "All" view.
 */
export function HubTable({ items, label }: { items: HubItem[]; label: string }) {
  const [view, setView] = useState<View>("minted");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: HubSortKey; dir: 1 | -1 } | null>(null);
  const searchId = useId();

  const counts = useMemo(() => ({
    all: items.length,
    minted: items.filter((i) => i.minted).length,
    trading: items.filter((i) => i.trading).length,
  }), [items]);

  const needle = query.trim().toLowerCase();

  const visible = useMemo(() => {
    const rows = items.filter((i) => inView(i, view) && matches(i, needle));
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const av = a.values[sort.key];
      const bv = b.values[sort.key];
      const tie = String(a.values.asset).localeCompare(String(b.values.asset));
      if (av === null && bv === null) return tie;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return cmp * sort.dir || tie;
    });
  }, [items, view, needle, sort]);

  // Matches the current view is hiding — offered rather than silently withheld, so a search for a
  // listing that is not minted yet finds it instead of reporting that it does not exist.
  const hiddenMatches = needle ? items.filter((i) => !inView(i, view) && matches(i, needle)).length : 0;
  const unminted = counts.all - counts.minted;

  function onSort(key: HubSortKey) {
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: firstDir(key) }));
  }

  const views: Array<{ key: View; label: string }> = [
    { key: "all", label: "All" },
    { key: "minted", label: "Minted" },
    { key: "trading", label: "Trading" },
  ];

  return (
    <>
      <div className="hub-tools">
        <div className="hub-search">
          <label className="sr-only" htmlFor={searchId}>Search the listed stocks</label>
          <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
          </svg>
          <input
            autoComplete="off"
            id={searchId}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
            placeholder="Ticker, name or address"
            spellCheck={false}
            type="search"
            value={query}
          />
        </div>

        <div className="hub-views" role="group" aria-label="Which stocks to show">
          {views.map((v) => (
            <button aria-pressed={view === v.key} key={v.key} onClick={() => setView(v.key)} type="button">
              {v.label} <b>{counts[v.key]}</b>
            </button>
          ))}
        </div>

        {/* The header row is the sort control on a wide screen; below 860px the rows become cards
            and the header goes with them, so the same choice is offered here instead. */}
        <label className="hub-sort">
          <span>Sort</span>
          <select
            onChange={(e) => {
              const key = (e.target.value || null) as HubSortKey | null;
              setSort(key ? { key, dir: firstDir(key) } : null);
            }}
            value={sort?.key ?? ""}
          >
            {SORT_OPTIONS.map((o) => <option key={o.key ?? "default"} value={o.key ?? ""}>{o.label}</option>)}
          </select>
        </label>
      </div>

      <div className="hub-table" role="table" aria-label={label}>
        <div className="hub-row hub-row-head" role="row">
          {COLUMNS.map((column, i) => {
            if (!column.key) return <span aria-hidden="true" key={i} />;
            const key = column.key;
            const active = sort?.key === key;
            const glyph = <i aria-hidden="true">{active ? (sort.dir === 1 ? "↑" : "↓") : ""}</i>;
            return (
              <span aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : undefined} key={key} role="columnheader">
                <button onClick={() => onSort(key)} type="button">
                  {/* Right-aligned columns carry the arrow on the left, so the label stays flush with
                      the figures under it instead of stepping in to make room. */}
                  {key !== "asset" && glyph}
                  {column.label}
                  {key === "asset" && glyph}
                </button>
              </span>
            );
          })}
        </div>

        {visible.map((i) => <Fragment key={i.key}>{i.node}</Fragment>)}

        {visible.length === 0 && (
          <p className="hub-empty" role="status">
            {needle
              ? <>Nothing {view === "all" ? "listed" : view === "minted" ? "minted" : "trading"} matches <b>“{query.trim()}”</b>.</>
              : view === "trading"
                ? <>No listed stock has an on-chain market right now.</>
                : <>Nothing to show in this view.</>}
          </p>
        )}

        {hiddenMatches > 0 ? (
          <button className="hub-more" onClick={() => setView("all")} type="button">
            {hiddenMatches} more match{hiddenMatches === 1 ? "" : "es"} outside {view === "minted" ? "minted" : "trading"}
            <i aria-hidden="true">↓</i>
          </button>
        ) : !needle && view === "minted" && unminted > 0 ? (
          <button className="hub-more" onClick={() => setView("all")} type="button">
            Show {unminted} not-yet-minted stock{unminted === 1 ? "" : "s"}
            <i aria-hidden="true">↓</i>
          </button>
        ) : !needle && view === "all" && unminted > 0 ? (
          <button className="hub-more" onClick={() => setView("minted")} type="button">
            Hide the {unminted} not yet minted
            <i aria-hidden="true">↑</i>
          </button>
        ) : null}
      </div>
    </>
  );
}
