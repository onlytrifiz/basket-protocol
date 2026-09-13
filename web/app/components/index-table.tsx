import Link from "next/link";

import type { B20Asset } from "../../lib/b20";
import type { IndexRow } from "../../lib/indices";
import { MODE, returnedUsd } from "../../lib/indices";
import { compactNumber, usdCompact } from "../../lib/format";
import { stockByAddress, washColor } from "../../lib/stocks";
import { LogoSprite } from "./logo-sprite";
import { StockLogo } from "./stock-logo";

/**
 * The live set, as one table.
 *
 * Shared so the three on the overview and the full set on their own page cannot drift into two
 * different ideas of what a row says. Ordering is decided upstream, in `readIndexRows` — biggest
 * first by `returnedUsd`, because a list of indices sorted by what each has actually given back
 * argues for the mechanism better than any description of it. This column prints that same figure,
 * so the order and the number a reader compares it against can never disagree.
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
      {/* Emitted HERE rather than by the page, so the stylesheet and the classes that depend on it
          cannot drift apart: a surface that renders a row always renders the rules for its marks. */}
      <LogoSprite marks={[...assets.values()]} />
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

        /* ONLY WHERE IT SAYS SOMETHING. 123 of the 168 baskets hold a single asset and 29 are
           buybacks — a bar drawn for those is a solid block meaning "100% of one thing", which the
           row already tells you. Rendered for the sixteen that are actually mixed, it costs about a
           kilobyte across the page instead of thirty. */
        const weightTotal = row.weights.reduce((sum, w) => sum + w, 0) || 1;
        let cursor = 0;
        const stops = holds.length > 1
          ? holds.map((token, i) => {
              const from = cursor * 100;
              cursor += (row.weights[i] ?? 0) / weightTotal;
              return `${washColor(stockByAddress(token))} ${from.toFixed(1)}% ${(cursor * 100).toFixed(1)}%`;
            })
          : null;
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
                  {stops && (
                    <span
                      aria-hidden="true"
                      className="idx-bar"
                      style={{ backgroundImage: `linear-gradient(90deg, ${stops.join(",")})` }}
                    />
                  )}
                  {holds.slice(0, 6).map((token, i) => {
                    const asset = assets.get(token.toLowerCase());
                    // The seed list names the equities; the chain named everything else when the
                    // row was read. An address is the mark of last resort, not the first one.
                    const symbol = asset?.symbol ?? row.basketSymbols[i] ?? token.slice(0, 6);
                    return (
                      <StockLogo key={token} logo={asset?.logo} sprite stock={{ symbol, domain: asset?.domain }} />
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
                  <b>{returnedUsd(row) ? usdCompact(returnedUsd(row) as number) : "—"}</b>
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
