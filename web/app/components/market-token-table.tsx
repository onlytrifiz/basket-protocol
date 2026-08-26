"use client";

import { useMemo, useState } from "react";
import type { PulseToken } from "../../lib/blockworks";
import { ISSUER_COLORS } from "../../lib/blockworks";
import { compactNumber, usd, usdCompact } from "../../lib/format";

const PAGE = 12;

type SortKey = "symbol" | "issuer" | "underlying" | "price" | "supply" | "holders";

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "symbol", label: "Token", numeric: false },
  { key: "issuer", label: "Issuer", numeric: false },
  { key: "underlying", label: "Underlying", numeric: false },
  { key: "price", label: "Price", numeric: true },
  { key: "supply", label: "Supply", numeric: true },
  { key: "holders", label: "Holders", numeric: true },
];

const valueOf = (t: PulseToken, k: SortKey) =>
  k === "symbol" ? t.symbol
  : k === "issuer" ? t.issuer
  : k === "underlying" ? t.underlying
  : k === "price" ? t.priceUsd
  : k === "supply" ? t.supplyUsd
  : t.holders;

/**
 * Every tokenized equity on Base, twelve rows at a time, sortable from the header row.
 *
 * The full list (~100 tokens) is in the page already — sorting and paging are view state over
 * rows the server rendered into the payload, so both cost no request. Supply-descending is the
 * resting order: the tokens that ARE a market first, the directory of empty listings behind them.
 *
 * A null never wins a sort in either direction — "we don't have this number" sorted above real
 * numbers would read as a superlative — and ties fall back to the symbol so flipping a column of
 * equal values cannot shuffle rows at random.
 */
export function MarketTokenTable({ tokens }: { tokens: PulseToken[] }) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "supply", dir: -1 });

  const sorted = useMemo(() => {
    return [...tokens].sort((a, b) => {
      const av = valueOf(a, sort.key);
      const bv = valueOf(b, sort.key);
      if (av === null && bv === null) return a.symbol.localeCompare(b.symbol);
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return cmp * sort.dir || a.symbol.localeCompare(b.symbol);
    });
  }, [tokens, sort]);

  const pages = Math.ceil(sorted.length / PAGE);
  const slice = sorted.slice(page * PAGE, page * PAGE + PAGE);

  function onSort(column: (typeof COLUMNS)[number]) {
    setPage(0);
    setSort((prev) =>
      prev.key === column.key
        ? { key: column.key, dir: prev.dir === 1 ? -1 : 1 }
        // Numbers open big-first, text opens A-first: the direction someone asking for that
        // column almost always wants on the first click.
        : { key: column.key, dir: column.numeric ? -1 : 1 },
    );
  }

  return (
    <div className="mkt-table" role="table" aria-label="Tokenized equities on Base, all issuers">
      <div className="mkt-row mkt-row-head" role="row">
        {COLUMNS.map((column) => (
          <span
            aria-sort={sort.key === column.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
            key={column.key}
            role="columnheader"
          >
            <button onClick={() => onSort(column)} type="button">
              {column.label}
              <i aria-hidden="true">{sort.key === column.key ? (sort.dir === 1 ? "↑" : "↓") : ""}</i>
            </button>
          </span>
        ))}
      </div>
      {slice.map((token) => (
        <div className="mkt-row" key={`${token.issuer}:${token.symbol}`} role="row">
          <span className="mkt-sym" role="cell">{token.symbol}</span>
          <span className="mkt-issuer" role="cell">
            <i style={{ background: ISSUER_COLORS[token.issuer] ?? "var(--desk-fg-3)" }} />
            {token.issuer}
          </span>
          <span role="cell">{token.underlying ?? "—"}</span>
          <span className="mkt-cell-num" role="cell">{usd(token.priceUsd)}</span>
          <span className="mkt-cell-num" role="cell">{usdCompact(token.supplyUsd)}</span>
          <span className="mkt-cell-num" role="cell">{token.holders === null ? "—" : compactNumber(token.holders)}</span>
        </div>
      ))}
      {pages > 1 && (
        <div className="mkt-pager">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} type="button">← Prev</button>
          <b>{page * PAGE + 1}–{Math.min(sorted.length, (page + 1) * PAGE)} of {sorted.length}</b>
          <button disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} type="button">Next →</button>
        </div>
      )}
    </div>
  );
}
