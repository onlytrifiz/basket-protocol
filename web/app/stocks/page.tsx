import Link from "next/link";
import type { Metadata } from "next";

import { readAssets } from "../../lib/b20";
import { marketBoard } from "../../lib/market";
import { marketPulse } from "../../lib/blockworks";
import { poolsForAll } from "../../lib/pools";
import { percent, premium, shares, usd, usdCompact } from "../../lib/format";
import { BrandRender } from "../components/brand-render";
import { HubExpander } from "../components/hub-expander";
import { MarketPulseSection, MarketPulseTeaser } from "../components/market-pulse";
import { Sparkline } from "../components/sparkline";
import { UpdatesPill } from "../components/updates-pill";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockLogo } from "../components/stock-logo";

export const metadata: Metadata = {
  title: "Tokenized stocks on Base — Stockify",
  description: "Every B20 tokenized equity on Base: live supply, on-chain markets, and how far each trades from its real share price.",
};

/** Supply and pools move on a minute scale. Rebuilt at that cadence, shared by every visitor. */
export const revalidate = 60;

export default async function StocksPage() {
  const assets = await readAssets();
  const [pools, market, pulse] = await Promise.all([
    poolsForAll(assets.map((a) => a.address)),
    marketBoard(assets.map((a) => a.ticker).filter(Boolean) as string[]),
    // The wider-market band is context, never load-bearing: when Blockworks is unreachable the
    // section simply is not there, and the hub above it renders exactly as before.
    marketPulse().catch(() => null),
  ]);

  const rows = assets.map((asset) => {
    const pool = pools[asset.address.toLowerCase()];
    const quote = asset.ticker ? market.quotes[asset.ticker] : undefined;
    const onChain = pool?.best?.priceUsd ?? null;
    return {
      asset,
      pool,
      quote,
      onChain,
      spread: premium(onChain, quote?.price),
      series: asset.ticker ? market.series[asset.ticker] : undefined,
    };
  });

  // Tradable first, then issued-but-illiquid, then the ones that are still only an address. Sorting
  // by liquidity alone would bury a freshly-listed equity below twelve empty ones.
  const ordered = [...rows].sort((a, b) => {
    const depth = (b.pool?.liquidityUsd ?? 0) - (a.pool?.liquidityUsd ?? 0);
    if (depth !== 0) return depth;
    return (b.asset.shares ?? 0) - (a.asset.shares ?? 0);
  });

  // The fold line for the table. A zero supply is a stock that exists only as an address; `null`
  // (the chain did not answer) stays ABOVE the fold — hiding a row because we failed to read it
  // would let an RPC hiccup quietly disappear a live asset.
  const minted = ordered.filter((r) => r.asset.shares !== 0);
  const unminted = ordered.filter((r) => r.asset.shares === 0);

  const withMarket = rows.filter((r) => r.pool?.best).length;
  const issued = rows.filter((r) => (r.asset.shares ?? 0) > 0).length;
  const liquidity = rows.reduce((sum, r) => sum + (r.pool?.liquidityUsd ?? 0), 0);
  const volume = rows.reduce((sum, r) => sum + (r.pool?.volume24Usd ?? 0), 0);
  const poolCount = rows.reduce((sum, r) => sum + (r.pool?.poolCount ?? 0), 0);

  // One renderer for both sides of the fold, so collapsing can never change what a row is.
  const hubRow = ({ asset, pool, quote, onChain, spread, series }: (typeof rows)[number]) => (
    <Link
      className="hub-row"
      href={`/stocks/${asset.symbol.toLowerCase()}`}
      key={asset.symbol}
      role="row"
    >
      <span className="hub-asset" role="cell">
        <StockLogo stock={{ ...asset, domain: asset.domain ?? "" }} logo={asset.logo} />
        <span className="hub-asset-id">
          <strong>{asset.symbol}</strong>
          <small>{asset.name}</small>
        </span>
        {asset.hasSplit && <em className="hub-tag hub-tag-warn">split</em>}
      </span>

      <span className="hub-num" data-label="On-chain" role="cell">
        <b>{usd(onChain)}</b>
        <small>{pool?.best ? `${pool.best.venue}${pool.best.label ? ` ${pool.best.label}` : ""}` : "no market"}</small>
      </span>

      <span className="hub-num" data-label="Nasdaq" role="cell">
        <b>{usd(quote?.price)}</b>
        <small className={quote && quote.changePercent < 0 ? "is-down" : quote ? "is-up" : undefined}>
          {quote ? percent(quote.changePercent) : asset.ticker ? "—" : "private"}
        </small>
      </span>

      <span className="hub-spark" role="cell"><Sparkline series={series} /></span>

      <span className="hub-num" data-label="Supply" role="cell">
        <b>{shares(asset.shares)}</b>
        <small>{asset.shares === null ? "unread" : asset.shares === 0 ? "not issued" : "shares"}</small>
      </span>

      <span className="hub-num" data-label="Liquidity" role="cell">
        <b>{pool?.liquidityUsd ? usdCompact(pool.liquidityUsd) : "—"}</b>
        <small>{pool?.poolCount ? `${pool.poolCount} pool${pool.poolCount === 1 ? "" : "s"}` : "no pools"}</small>
      </span>

      {/* The reason this page exists. GREEN IS THE DISCOUNT, not the rise: this column is
          not a price move, it is what the token costs against the share it represents, and
          below the share is the side a buyer wants. Neutral when either price is missing —
          a premium against a price we could not read would be an invented number. */}
      <span className="hub-num hub-premium" data-label="Premium vs share" role="cell">
        <b className={spread === null ? undefined : spread <= 0 ? "is-up" : "is-down"}>
          {spread === null ? "—" : percent(spread)}
        </b>
        <small>{spread === null ? "no pair" : spread >= 0 ? "over share" : "under share"}</small>
      </span>

      {/* The whole row is a link to the asset's page, which nothing about a table of
          figures suggests. Decorative: the row's own text is the accessible label. */}
      <svg aria-hidden="true" className="hub-go" viewBox="0 0 6 10" focusable="false">
        <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      </svg>
    </Link>
  );

  return (
    <div className="site-shell">
      <SiteHeader active="stocks" />
      <main>
        <div className="updates-row wrap"><UpdatesPill /></div>
        <header className="section wrap hub-head">
          <div className="hub-head-copy">
            <p className="eyebrow">BASE · B20 UNIVERSE</p>
            <h1>Every tokenized stock on Base.</h1>
            <p className="hub-lede">
              Coinbase issues these equities directly on Base as B20 tokens. The column worth reading
              is the last one — how far a token trades from the share it represents.
            </p>
            {/* The page's two halves, offered up front: the B20 table it exists for, and the
                whole-market overview below it. Anchors — both destinations are this page. */}
            <div className="hero-actions">
              <a className="button button-ink" href="#b20">B20 table <span>↓</span></a>
              {pulse && <a className="button button-ghost" href="#market">Market overview <span>↓</span></a>}
            </div>
          </div>
          {/* The same coins the table lists, which is the point: the render is the universe and the
              rows are its numbers. Decorative — everything it depicts is named below it in text. */}
          <BrandRender className="hub-render" priority size={340} src="/stocks.png" />
        </header>

        <section className="stats-band" aria-label="Universe at a glance">
          <div className="stats-inner">
            <div><span>Issued</span><strong>{assets.length}</strong><small>B20 equities on Base</small></div>
            <div><span>Minted</span><strong>{issued}</strong><small>with supply on-chain</small></div>
            {/* Volume earns the tile and liquidity keeps its own: one is how much trades, the other
                how much is standing there to trade against, and neither substitutes for the other.
                The market and pool counts ride along as sub-labels rather than costing two more
                tiles for two small integers. */}
            <div><span>24h volume</span><strong>{usdCompact(volume)}</strong><small>across {withMarket} live market{withMarket === 1 ? "" : "s"}</small></div>
            <div><span>Pool liquidity</span><strong>{usdCompact(liquidity)}</strong><small>in {poolCount} pool{poolCount === 1 ? "" : "s"}</small></div>
          </div>
        </section>

        {pulse && <MarketPulseTeaser kpis={pulse.kpis} />}

        <section className="section wrap hub-section" id="b20">
          <div className="hub-table" role="table" aria-label="Tokenized equities on Base">
            <div className="hub-row hub-row-head" role="row">
              <span role="columnheader">Asset</span>
              <span role="columnheader">On-chain</span>
              <span role="columnheader">Nasdaq</span>
              <span role="columnheader">30d</span>
              <span role="columnheader">Supply</span>
              <span role="columnheader">Liquidity</span>
              <span role="columnheader">Premium</span>
              <span aria-hidden="true" />
            </div>

            {minted.map(hubRow)}
            {unminted.length > 0 && (
              /* Rows pass through the expander exactly as the server rendered them — it is only
                 the hinge — and collapsed rows are still in the payload for crawlers. */
              <HubExpander count={unminted.length}>{unminted.map(hubRow)}</HubExpander>
            )}
          </div>

          {market.degraded && (
            <p className="hub-note-degraded">
              Share prices are unavailable right now, so the premium column is blank. Everything else
              is unaffected.
            </p>
          )}
        </section>

        {/* FAQ rows, closed by default: the three explanations matter the first time and are
            furniture every visit after. Native <details> so the fold costs no JS and keyboard/
            screen-reader behaviour comes from the platform, not from us. */}
        <section className="section wrap hub-faq" aria-label="About this table">
          <details>
            <summary><h2>Why most of these have no supply</h2><i aria-hidden="true">+</i></summary>
            <p>
              Base&apos;s equities are new and most have not been issued yet: for the majority, no
              shares exist at all. A token whose supply we could not check shows <b>—</b>, never a
              zero. Those are very different claims and only one of them is ours to make.
            </p>
          </details>
          <details>
            <summary><h2>What the premium means</h2><i aria-hidden="true">+</i></summary>
            <p>
              A B20 equity is a claim on a real share, so its on-chain price should track the Nasdaq
              print. It often does not: thin pools drift, and the spread is what a trader is actually
              paying or collecting. Only pools holding at least $5,000 are allowed to set the on-chain
              price — below that a single retail-sized order <em>is</em> the price.
            </p>
          </details>
          <details>
            <summary><h2>Dividends do not move pools</h2><i aria-hidden="true">+</i></summary>
            <p>
              A B20 represents a split through a <b>multiplier</b>. Under ERC-8056 that rescales the
              balance you are <em>shown</em> without rewriting any raw balance, so a split changes the
              share count on this page and moves no pool&apos;s reserves, price or liquidity.
            </p>
          </details>
        </section>

        {pulse && <MarketPulseSection pulse={pulse} />}
      </main>
      <SiteFooter />
    </div>
  );
}
