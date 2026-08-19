import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { readAssets } from "../../../lib/b20";
import { marketDetail } from "../../../lib/market";
import { poolsFor, MIN_LIQUIDITY_USD } from "../../../lib/pools";
import { stocks } from "../../../lib/stocks";
import { compactNumber, percent, premium, shares, since, usd, usdCompact } from "../../../lib/format";
import { PriceChart } from "../../components/price-chart";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";
import { StockLogo } from "../../components/stock-logo";
import { TradeCard } from "../../components/trade-card";

export const revalidate = 60;

/** Pre-render every listed equity: the set is small, known, and changes only when we add one. */
export function generateStaticParams() {
  return stocks.map((stock) => ({ symbol: stock.symbol.toLowerCase() }));
}

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  const stock = stocks.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase());
  if (!stock) return { title: "Not found — Stockify" };
  return {
    title: `${stock.symbol} · ${stock.name} on Base — Stockify`,
    description: `Live supply, pools and share-price premium for ${stock.name} (${stock.symbol}), Coinbase's tokenized ${stock.ticker ?? stock.name} on Base.`,
  };
}

const EXPLORER = "https://basescan.org/token/";

export default async function StockPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const assets = await readAssets();
  const asset = assets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
  if (!asset) notFound();

  const [pools, market] = await Promise.all([
    poolsFor(asset.address.toLowerCase(), MIN_LIQUIDITY_USD, true),
    asset.ticker ? marketDetail(asset.ticker) : Promise.resolve(null),
  ]);

  const onChain = pools.best?.priceUsd ?? null;

  /**
   * Which pools to actually show.
   *
   * NVDAc has twenty-six, and twenty of them hold under a thousand dollars — several hold zero.
   * Listing them all buries the two markets that matter under a page of dust and makes the asset
   * look far more fragmented than it trades. Every quotable pool is shown, plus the deepest few thin
   * ones so the tail is visible rather than hidden, and the rest are counted honestly below.
   */
  const allPools = pools.pools ?? [];
  const quotable = allPools.filter((p) => p.quotable);
  const thin = allPools.filter((p) => !p.quotable);
  const visible = [...quotable, ...thin.slice(0, 5)];
  const hidden = thin.length - Math.min(thin.length, 5);
  const spread = premium(onChain, market?.quote?.price);
  const quote = market?.quote;
  const profile = market?.profile;

  // Supply valued at the share price rather than at the pool price: the pool is where a handful of
  // these trade, the share price is what all of them are worth.
  const issuedValue = asset.shares !== null && quote?.price ? asset.shares * quote.price : null;

  return (
    <div className="site-shell">
      <SiteHeader active="stocks" />
      <main>
        <section className="section wrap detail-top">
          <Link className="detail-back" href="/stocks">← All tokenized stocks</Link>

          <header className="detail-head">
            <StockLogo stock={asset} logo={asset.logo} size="large" />
            <div className="detail-id">
              <h1>{asset.symbol}</h1>
              <p>{profile?.name ?? asset.name}{profile?.industry ? ` · ${profile.industry}` : ""}</p>
            </div>
            <div className="detail-badges">
              <span className="hub-tag">B20</span>
              {asset.inIndex && <span className="hub-tag">In index</span>}
              {asset.hasSplit && <span className="hub-tag hub-tag-warn">Split applied</span>}
            </div>
          </header>

          {/* The two prices, side by side, with the spread between them called out. This comparison
              is the reason a tokenized-stock hub is worth building at all. */}
          <div className="detail-prices">
            <div className="price-block">
              <span>On-chain</span>
              <strong>{usd(onChain)}</strong>
              <small>{pools.best ? `${pools.best.venue}${pools.best.label ? ` ${pools.best.label}` : ""} · ${pools.best.quoteSymbol} pair` : "no quotable pool"}</small>
            </div>
            <div className="price-block">
              <span>{profile?.exchange ? profile.exchange.split(" ")[0] : "Share price"}</span>
              <strong>{usd(quote?.price)}</strong>
              <small className={quote && quote.changePercent < 0 ? "is-down" : quote ? "is-up" : undefined}>
                {quote ? `${percent(quote.changePercent)} today` : asset.ticker ? "unavailable" : "private company"}
                {quote?.marketTime ? ` · ${since(quote.marketTime)}` : ""}
              </small>
            </div>
            <div className="price-block price-block-spread">
              <span>Premium</span>
              <strong className={spread === null ? undefined : spread >= 0 ? "is-up" : "is-down"}>
                {spread === null ? "—" : percent(spread)}
              </strong>
              <small>{spread === null ? "needs both prices" : spread >= 0 ? "token above the share" : "token below the share"}</small>
            </div>
          </div>

          <div className="detail-grid">
            <div className="detail-main">
              {asset.ticker
                ? <PriceChart initial={market?.series ?? null} ticker={asset.ticker} />
                : <p className="chart-empty">{asset.name} has no public listing, so there is no share price to chart against.</p>}

              <section className="detail-panel">
                <h2>On-chain</h2>
                <dl className="fact-grid">
                  <div><dt>Supply</dt><dd>{shares(asset.shares)}{asset.shares !== null && asset.shares > 0 ? " shares" : ""}</dd></div>
                  <div><dt>Issued value</dt><dd>{usdCompact(issuedValue)}</dd></div>
                  <div><dt>Decimals</dt><dd>{asset.decimals}</dd></div>
                  <div><dt>Multiplier</dt><dd>{asset.hasSplit ? `${(Number(asset.multiplier) / 1e18).toFixed(4)}×` : "1.0000× (no split)"}</dd></div>
                  <div><dt>Pools</dt><dd>{pools.poolCount || "none"}</dd></div>
                  <div><dt>Pool liquidity</dt><dd>{pools.liquidityUsd ? usdCompact(pools.liquidityUsd) : "—"}</dd></div>
                  <div><dt>24h volume</dt><dd>{pools.volume24Usd ? usdCompact(pools.volume24Usd) : "—"}</dd></div>
                  <div className="fact-wide">
                    <dt>Contract</dt>
                    <dd><a href={`${EXPLORER}${asset.address}`} rel="noreferrer" target="_blank">{asset.address} ↗</a></dd>
                  </div>
                </dl>
              </section>

              <section className="detail-panel">
                <h2>Pools on Base</h2>
                {visible.length > 0 ? (
                  <div className="pool-table">
                    <div className="pool-row pool-row-head">
                      <span>Venue</span><span>Pair</span><span>Price</span><span>Liquidity</span><span>24h vol</span><span>24h</span>
                    </div>
                    {visible.map((pool) => (
                      <a className={`pool-row${pool.quotable ? "" : " is-thin"}`} href={pool.url} key={pool.pairAddress} rel="noreferrer" target="_blank">
                        <span className="pool-venue">
                          {pool.venue}{pool.label ? <em>{pool.label}</em> : null}
                          {!pool.quotable && <em className="pool-thin-tag">thin</em>}
                        </span>
                        <span>{asset.symbol}/{pool.quoteSymbol}</span>
                        <span>{usd(pool.priceUsd)}</span>
                        <span>{usdCompact(pool.liquidityUsd)}</span>
                        <span>{usdCompact(pool.volume24Usd)}</span>
                        <span className={pool.priceChange24 < 0 ? "is-down" : "is-up"}>{percent(pool.priceChange24, 1)}</span>
                      </a>
                    ))}
                    <p className="pool-note">
                      Pools holding under {usdCompact(MIN_LIQUIDITY_USD)} are marked <b>thin</b> and never set the
                      price above: at that depth one retail-sized order moves the quote by more than the
                      spread it is meant to describe.
                      {hidden > 0 && ` ${hidden} further thin pool${hidden === 1 ? "" : "s"} ${hidden === 1 ? "is" : "are"} not listed.`}
                    </p>
                  </div>
                ) : (
                  <p className="detail-empty">
                    No pool holds {asset.symbol} yet. The token exists on Base, but nothing has been
                    paired against it, so there is no on-chain price and nothing to route a trade through.
                  </p>
                )}
              </section>

              {market && market.news.length > 0 && (
                <section className="detail-panel">
                  <h2>Recent news</h2>
                  <ul className="news-list">
                    {market.news.map((item) => (
                      <li key={item.url}>
                        <a href={item.url} rel="noreferrer" target="_blank">{item.headline}</a>
                        <small>{item.source}{item.datetime ? ` · ${since(item.datetime)}` : ""}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <div className="detail-side">
              <TradeCard
                asset={{ address: asset.address, symbol: asset.symbol, name: asset.name, decimals: asset.decimals, logo: asset.logo, domain: asset.domain }}
                referencePrice={quote?.price ?? null}
                tradable={Boolean(pools.best)}
              />

              {profile && (
                <section className="detail-panel">
                  <h2>Company</h2>
                  <dl className="fact-grid fact-grid-tight">
                    <div><dt>Market cap</dt><dd>{usdCompact(profile.marketCapUsd)}</dd></div>
                    <div><dt>P/E</dt><dd>{profile.peRatio ? profile.peRatio.toFixed(1) : "—"}</dd></div>
                    <div><dt>Shares out</dt><dd>{compactNumber(profile.sharesOutstanding)}</dd></div>
                    <div><dt>Beta</dt><dd>{profile.beta ? profile.beta.toFixed(2) : "—"}</dd></div>
                    <div><dt>Dividend</dt><dd>{profile.dividendYield ? `${profile.dividendYield.toFixed(2)}%` : "none"}</dd></div>
                    <div><dt>Listed</dt><dd>{profile.ipo ? profile.ipo.slice(0, 4) : "—"}</dd></div>
                    <div className="fact-wide">
                      <dt>52-week range</dt>
                      <dd>
                        {profile.fiftyTwoWeekLow && profile.fiftyTwoWeekHigh
                          ? `${usd(profile.fiftyTwoWeekLow)} — ${usd(profile.fiftyTwoWeekHigh)}`
                          : "—"}
                      </dd>
                    </div>
                    {profile.weburl && (
                      <div className="fact-wide">
                        <dt>Website</dt>
                        <dd><a href={profile.weburl} rel="noreferrer" target="_blank">{new URL(profile.weburl).hostname} ↗</a></dd>
                      </div>
                    )}
                  </dl>
                </section>
              )}

              {market && !market.hasFundamentals && (
                <p className="detail-hint">
                  Company fundamentals need a free Finnhub key in <code>FINNHUB_API_KEY</code>. Everything
                  else on this page works without one.
                </p>
              )}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
