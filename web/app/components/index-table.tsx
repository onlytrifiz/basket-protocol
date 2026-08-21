import Link from "next/link";

import type { B20Asset } from "../../lib/b20";
import type { IndexRow } from "../../lib/indices";
import { MODE } from "../../lib/indices";
import { compactNumber, usdCompact } from "../../lib/format";
import { StockLogo } from "./stock-logo";

/**
 * The live set, as one table.
 *
 * Shared so the three on the overview and the full set on their own page cannot drift into two
 * different ideas of what a row says. Ordering is decided upstream, in `readIndexRows` — biggest
 * payer first, because a list of indices sorted by what has actually reached holders argues for the
 * mechanism better than any description of it.
 */

const shorten = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function IndexTable({
  rows,
  assets,
}: {
  rows: IndexRow[];
  assets: Map<string, B20Asset>;
}) {
  return (
    <div className="idx-table" role="table" aria-label="Live indices">
      <div className="idx-row idx-row-head" role="row">
        <span role="columnheader">Coin</span>
        <span role="columnheader">Holds</span>
        <span role="columnheader">Paid out / burned</span>
        <span role="columnheader">Fees in</span>
        <span role="columnheader">Rounds</span>
        <span aria-hidden="true" />
      </div>

      {rows.map((row) => {
        const burns = row.mode === MODE.buyback;
        const holds = burns ? [] : row.basket;
        return (
          <Link className="idx-row" href={`/indices/${row.address}`} key={row.address} role="row">
            <span className="idx-coin" role="cell">
              <b>{row.coinSymbol ?? shorten(row.coin)}</b>
              <small>{shorten(row.address)}</small>
            </span>

            {/* Marks, not a comma list of tickers: six near-identical rows of text cannot be
                scanned, and the mark carries the identity on its own. */}
            <span className="idx-holds" role="cell">
              {burns ? (
                <em>buys itself back</em>
              ) : (
                <>
                  {holds.slice(0, 6).map((token) => {
                    const asset = assets.get(token.toLowerCase());
                    return (
                      <StockLogo
                        key={token}
                        logo={asset?.logo}
                        stock={{ symbol: asset?.symbol ?? token.slice(0, 6), domain: asset?.domain }}
                      />
                    );
                  })}
                  {holds.length > 6 && <span className="idx-more">+{holds.length - 6}</span>}
                </>
              )}
            </span>

            {/* A buyback pays nobody — everything it does ends at the burn. Reporting it under
                "paid to holders" would show a dash forever on an index that is working. */}
            <span className="idx-num" data-label={burns ? "Burned" : "Paid to holders"} role="cell">
              {burns ? (
                <>
                  <b>{row.burnedUsd ? usdCompact(row.burnedUsd) : "—"}</b>
                  {row.burnedUnits ? <small>{compactNumber(row.burnedUnits)} {row.coinSymbol ?? "coins"} burned</small> : null}
                </>
              ) : (
                <>
                  <b>{row.paidUsd ? usdCompact(row.paidUsd) : "—"}</b>
                  {row.paidUnits.length > 0 && (
                    <small>
                      {row.paidUnits
                        .map((p) => `${p.units < 1 ? p.units.toFixed(4) : p.units.toFixed(2)} ${p.symbol}`)
                        .join(" · ")}
                    </small>
                  )}
                </>
              )}
            </span>

            <span className="idx-num" data-label="Fees in" role="cell">
              <b>{row.feesUsd === null ? "—" : row.feesUsd === 0 ? "—" : usdCompact(row.feesUsd)}</b>
            </span>

            <span className="idx-num" data-label="Rounds" role="cell">
              <b>{row.rounds}</b>
              {row.payments > 0 && (
                <small>{row.payments.toLocaleString("en-US")} payment{row.payments === 1 ? "" : "s"}</small>
              )}
            </span>

            <svg aria-hidden="true" className="hub-go" viewBox="0 0 6 10" focusable="false">
              <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
            </svg>
          </Link>
        );
      })}
    </div>
  );
}
