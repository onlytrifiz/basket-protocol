import Link from "next/link";

import type { B20Asset } from "../../lib/b20";
import { MODE, returnedUsd, type IndexRow } from "../../lib/indices";
import { usdCompact } from "../../lib/format";
import { stockByAddress, washColor } from "../../lib/stocks";
import { LogoSprite } from "./logo-sprite";
import { StockLogo } from "./stock-logo";

/**
 * One index as a card, for the three the overview leads with.
 *
 * WHAT THE ROW COULD NOT SAY. The table shows a strip of marks and stops there — the WEIGHTS are
 * loaded on every one of these rows and have never been rendered anywhere. "Holds NVDA and AAPL"
 * and "holds 90% NVDA and 10% AAPL" are different indices, and until now the page called them the
 * same thing.
 *
 * DELIBERATELY NOT ON /indices/all. Three cards cost a few kilobytes; 168 would inflate the
 * heaviest page on the site, and Next serialises every row a second time into the RSC payload
 * beside the HTML, so the markup is paid for twice. The full set keeps the table.
 */

/** Bars and tints come from the holdings themselves — see `washColor` in `lib/stocks`. */
const colorOf = (address: string) => washColor(stockByAddress(address));

export function IndexCard({ row, assets, logo }: { row: IndexRow; assets: Map<string, B20Asset>; logo?: string }) {
  const burns = row.mode === MODE.buyback;
  const returned = returnedUsd(row);
  const symbol = row.coinSymbol ?? `${row.address.slice(2, 6).toUpperCase()}`;

  /* Weights are read alongside the basket and arrive in the same order. Normalised by their own
     sum rather than assumed to be 10,000 bps: a treasury may be configured with any scale, and a
     bar that assumes one silently mis-draws every index that does not use it. */
  const total = row.weights.reduce((sum, w) => sum + w, 0) || 1;

  const holdings = row.basket.map((address, i) => {
    const asset = assets.get(address.toLowerCase());
    return {
      address,
      asset,
      symbol: asset?.symbol ?? row.basketSymbols[i] ?? `${address.slice(0, 6)}…`,
      share: (row.weights[i] ?? 0) / total,
      color: colorOf(address),
    };
  });

  /* THE BAR IS ONE ELEMENT. A segment per holding would be a child each, and this markup is about
     to be repeated; a gradient with hard stops draws the same picture from a single attribute. */
  let cursor = 0;
  const stops = holdings.map((h) => {
    const from = cursor * 100;
    cursor += h.share;
    return `${h.color} ${from.toFixed(2)}% ${(cursor * 100).toFixed(2)}%`;
  });

  // The card wears what it mostly buys. A buyback buys nothing, so it takes the burn register.
  const lead = holdings.reduce((a, b) => (b.share > a.share ? b : a), holdings[0]);
  const tint = burns ? "var(--burn-fg)" : lead?.color ?? "var(--blue)";

  return (
    <Link
      className={`index-card${burns ? " is-burn" : ""}${logo ? " has-art" : ""}`}
      href={`/indices/${row.address}`}
      style={{ "--tint": tint } as React.CSSProperties}
    >
      <span className="index-card-cap">
        {/* The coin's own artwork behind its own name, blurred past recognition. It is not there to
            be read — it is there so the cap is the colour of the coin without anyone having to
            decode a pixel to find out what that colour is. */}
        {logo && <span aria-hidden="true" className="index-card-wash" style={{ backgroundImage: `url("${logo}")` }} />}
        <span aria-hidden="true" className="index-card-ghost">{symbol}</span>
        <span className="index-card-mark">
          {logo
            ? <img alt="" loading="lazy" src={logo} />
            : <i aria-hidden="true">{symbol.slice(0, 2)}</i>}
        </span>
        <strong>{symbol}</strong>
        <span className="index-card-kind">
          {burns ? "buys itself back" : `${row.basket.length} ${row.basket.length === 1 ? "stock" : "stocks"}`}
        </span>
      </span>

      <span className="index-card-body">
        <span className="index-card-line">
          {burns
            ? "Every fee buys the coin back and destroys it."
            : "Fees buy these assets by weight and push them to holders."}
        </span>

        {/* A BUYBACK HAS A COMPOSITION TOO — it is just all one name, its own. The bar and the chip
            were hidden here, which left the card saying less than the ones beside it about an index
            that is doing exactly what it was built to do. Full width, in the burn register, and the
            coin stands where a holding would. */}
        {burns ? (
          <>
            {/* THE BAR SAYS WHICH ASSET, NOT WHICH OUTCOME. On the other cards it is coloured by
                what the index holds; here the asset is the coin itself, so it takes the coin's own
                picture rather than the burn register — that register belongs to the figure in the
                footer, which is where the destruction is reported. Without artwork there is no
                colour to take, and it falls back to the burn brown. */}
            <span
              aria-hidden="true"
              className={`index-card-bar${logo ? " is-art-bar" : " is-burn-bar"}`}
              style={logo ? ({ "--art": `url("${logo}")` } as React.CSSProperties) : undefined}
            />
            <span className="index-card-holds">
              <span className="index-chip">
                <span className="stock-logo stock-logo-small" aria-hidden="true">
                  {logo ? <img alt="" loading="lazy" src={logo} /> : <i>{symbol.slice(0, 2)}</i>}
                </span>
                <b>{symbol}</b>
                <i>100%</i>
              </span>
            </span>
          </>
        ) : holdings.length > 0 && (
          <>
            <span aria-hidden="true" className="index-card-bar" style={{ backgroundImage: `linear-gradient(90deg, ${stops.join(",")})` }} />
            <span className="index-card-holds">
              {holdings.slice(0, 4).map((h) => (
                <span className="index-chip" key={h.address}>
                  <StockLogo logo={h.asset?.logo} size="small" sprite stock={{ symbol: h.symbol, domain: h.asset?.domain }} />
                  <b>{h.symbol}</b>
                  <i>{Math.round(h.share * 100)}%</i>
                </span>
              ))}
              {holdings.length > 4 && <span className="index-chip is-more">+{holdings.length - 4} more</span>}
            </span>
          </>
        )}
      </span>

      <span className="index-card-foot">
        <span>{burns ? "Burned" : "Paid to holders"}</span>
        <b>{returned ? usdCompact(returned) : "—"}</b>
      </span>
    </Link>
  );
}

export function IndexCards({
  rows,
  assets,
  logos,
}: {
  rows: IndexRow[];
  assets: Map<string, B20Asset>;
  /** Coin artwork by coin address, lowercased. Absent entries fall back to initials. */
  logos?: Map<string, string>;
}) {
  return (
    <div className="index-cards">
      <LogoSprite marks={[...assets.values()]} />
      {rows.map((row) => (
        <IndexCard assets={assets} key={row.address} logo={logos?.get(row.coin.toLowerCase())} row={row} />
      ))}
    </div>
  );
}
