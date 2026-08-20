import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../lib/b20";
import {
  INDEX_FACTORY,
  LAUNCHPAD,
  MIN_BUY_ETH,
  MIN_HOLDER_COINS,
  MODE,
  indicesLive,
  readIndices,
  readPlatformFeeBps,
  splitOf,
} from "../../lib/indices";
import { BrandRender } from "../components/brand-render";
import { RingMarker } from "../components/segment-ring";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockLogo } from "../components/stock-logo";

export const metadata: Metadata = {
  title: "Indices — Stockify",
  description:
    "Point a launch's creator fees at an index: it buys tokenized equity and pushes it to the coin's holders, or buys the coin back and burns it.",
};

/** Live contract reads throughout; a minute is fresh for something that moves hourly. */
export const revalidate = 60;

/* The sequence closes when equity reaches holders — the one lime-lit step. */
const phases = [
  { number: "01", filled: 2, lit: false, title: "A launch points its fees", copy: "The coin's creator names an index as the recipient of its share of the trading fees." },
  { number: "02", filled: 4, lit: false, title: "The index collects", copy: "Anyone may crank it: the call only moves money in, so there is nothing to gate." },
  { number: "03", filled: 6, lit: false, title: "It buys", copy: "Each name is bought only when its own slice is worth the gas, at a venue the factory allows." },
  { number: "04", filled: 8, lit: true, title: "Holders are paid", copy: "Equity is pushed pro-rata on balance. Or, in buyback mode, the coin is destroyed instead." },
];

const cadence = (seconds: number) => {
  if (seconds >= 604_800) return "weekly";
  if (seconds >= 86_400) return "daily";
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 60)}m`;
};

export default async function IndicesPage() {
  const [indices, platformBps, assets] = await Promise.all([
    readIndices(),
    readPlatformFeeBps(),
    readAssets(),
  ]);
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));

  const distributing = indices.filter((i) => i.mode === MODE.distribute).length;
  const burning = indices.filter((i) => i.mode === MODE.buyback).length;

  return (
    <div className="site-shell">
      <SiteHeader active="indices" />
      <main>
        <header className="section wrap hub-head">
          <div className="hub-head-copy">
            <p className="eyebrow">INDICES</p>
            <h1>Make a launch pay its holders.</h1>
            <p className="hub-lede">
              A coin earns its creator a share of every trade. Left alone that is income to a wallet.
              Pointed at an index it becomes a mechanism anyone can audit on-chain: the fees buy real
              tokenized equity and it is pushed out to the coin&apos;s holders, or they buy the coin
              back and destroy it. Nothing is claimed, nothing is staked, and what an index buys is
              fixed the day it is created.
            </p>
          </div>
          <BrandRender className="hub-render" priority size={340} src="/baskets.png" />
        </header>

        <section className="stats-band" aria-label="Index service">
          <div className="stats-inner">
            <div>
              <span>Live indices</span>
              <strong>{indicesLive ? indices.length : "—"}</strong>
              <small>{indicesLive ? "created by launches" : "service not deployed yet"}</small>
            </div>
            <div>
              <span>Paying equity</span>
              <strong>{indicesLive ? distributing : "—"}</strong>
              <small>bought and pushed to holders</small>
            </div>
            <div>
              <span>Buying back</span>
              <strong>{indicesLive ? burning : "—"}</strong>
              <small>supply destroyed instead</small>
            </div>
            <div>
              <span>Protocol fee</span>
              <strong>{(platformBps / 100).toFixed(0)}%</strong>
              <small>off the top of every collection</small>
            </div>
          </div>
        </section>

        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">THE LIVE SET</p>
            <h2>{indices.length === 0 ? "Nothing has pointed its fees here yet." : `${indices.length} ${indices.length === 1 ? "index" : "indices"}, read from the chain.`}</h2>
            <p>
              Every row is a contract answering for itself — what it holds, what it pays, and whether
              the stream behind it can still be taken back. Created on{" "}
              <a href={LAUNCHPAD.url} rel="noreferrer" target="_blank">{LAUNCHPAD.name} ↗</a>, at the
              moment a coin is launched.
            </p>
          </div>

          {indices.length > 0 ? (
            <div className="hub-table" role="table" aria-label="Live indices">
              <div className="hub-row dist-row hub-row-head" role="row">
                <span role="columnheader">Coin</span>
                <span role="columnheader">What it does</span>
                <span role="columnheader">Holds</span>
                <span role="columnheader">Pays</span>
                <span role="columnheader">Creator keeps</span>
                <span aria-hidden="true" />
              </div>

              {indices.map((index) => {
                const split = splitOf(index.creatorShareBps, platformBps);
                const burns = index.mode === MODE.buyback;
                return (
                  <Link className="hub-row dist-row" href={`/indices/${index.address}`} key={index.address} role="row">
                    <span className="hub-asset" role="cell">
                      <span className="hub-asset-id">
                        <strong>{index.coinSymbol ?? `${index.coin.slice(0, 6)}…${index.coin.slice(-4)}`}</strong>
                        <small>{index.paused ? "paused" : index.permanent ? "irrevocable" : "revocable by creator"}</small>
                      </span>
                    </span>

                    <span className="hub-num" data-label="What it does" role="cell">
                      <b>{burns ? "Burns" : "Pays equity"}</b>
                      <small>{burns ? "buys the coin back" : `${index.basket.length} ${index.basket.length === 1 ? "name" : "names"}`}</small>
                    </span>

                    {/* The composition, as marks rather than a comma list — four near-identical rows
                        of tickers are impossible to scan. */}
                    <span className="hub-num" data-label="Holds" role="cell">
                      {burns ? (
                        <b>—</b>
                      ) : (
                        <span className="cycle-assets">
                          {index.basket.map((token) => {
                            const asset = byAddress.get(token.toLowerCase());
                            return (
                              <span className="cycle-asset" key={token} title={asset?.symbol ?? token}>
                                {asset?.logo
                                  ? <img alt="" className="cycle-mark" loading="lazy" src={asset.logo} />
                                  : <span className="cycle-mark cycle-mark-blank" />}
                              </span>
                            );
                          })}
                        </span>
                      )}
                    </span>

                    <span className="hub-num" data-label="Pays" role="cell">
                      <b>{burns ? "on demand" : cadence(index.interval)}</b>
                      <small>{burns ? "burn is open to anyone" : "at the earliest"}</small>
                    </span>

                    <span className="hub-num" data-label="Creator keeps" role="cell">
                      <b>{(split.creator / 100).toFixed(0)}%</b>
                      <small>{(split.holders / 100).toFixed(0)}% to holders</small>
                    </span>

                    <svg aria-hidden="true" className="hub-go" viewBox="0 0 6 10" focusable="false">
                      <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
                    </svg>
                  </Link>
                );
              })}
            </div>
          ) : (
            <p className="detail-empty">
              {indicesLive
                ? "The first index appears here the moment a launch creates one — this table is the factory's own register, not a list we keep."
                : "The index factory is not deployed on this network, so there is nothing to read. No address is invented here."}
            </p>
          )}
        </section>

        <section className="section wrap">
          <div className="section-head">
            <p className="eyebrow">HOW A CYCLE RUNS</p>
            <h2>Four steps. No claim button.</h2>
            <p>
              An index pushes. Holders are paid where they stand, in proportion to what they hold, and
              nobody has to come and collect.
            </p>
          </div>
          <div className="payout-list">
            {phases.map((phase) => (
              <article className={phase.lit ? "is-payout" : undefined} key={phase.number}>
                <RingMarker filled={phase.filled} label={phase.number} lit={phase.lit} />
                <div><h3>{phase.title}</h3><p>{phase.copy}</p></div>
                <b>↗</b>
              </article>
            ))}
          </div>
        </section>

        <section className="eligibility wrap">
          <div>
            <p className="eyebrow">WHAT TO KNOW</p>
            <h2>Read this<br />before you point fees.</h2>
            <p>
              An index is a promise made on-chain, and the honest version of it has edges. These are
              the ones that decide whether it suits a launch.
            </p>
          </div>
          <dl>
            <div>
              <dt>More names, rarer payouts</dt>
              <dd>
                Each name is bought only when its own slice clears about {MIN_BUY_ETH} ETH, so a
                basket of seven needs roughly seven times that before it moves at all.
              </dd>
            </div>
            <div>
              <dt>A minimum to be paid</dt>
              <dd>
                Holders under {MIN_HOLDER_COINS.toLocaleString("en-US")} coins are skipped; their
                slice stays with everyone above the line rather than being lost.
              </dd>
            </div>
            <div>
              <dt>No price oracle, deliberately</dt>
              <dd>
                Gating a buy on a feed would mean any equity without one could be configured and never
                bought. The fill is checked against the route&apos;s own quote instead.
              </dd>
            </div>
            <div>
              <dt>Composition is immutable</dt>
              <dd>
                What an index buys is fixed at creation. Changing it means a new index and pointing the
                fees again — there is no setter.
              </dd>
            </div>
          </dl>
        </section>

        <section className="page-cta wrap">
          <div>
            <p className="eyebrow">CREATE ONE</p>
            <h2>An index is made at launch.</h2>
          </div>
          <a className="button button-ink" href={LAUNCHPAD.url} rel="noreferrer" target="_blank">
            Launch on {LAUNCHPAD.name} <span>→</span>
          </a>
        </section>

        {indicesLive && (
          <p className="desk-note wrap" style={{ paddingBottom: "3rem" }}>
            Index factory <code>{INDEX_FACTORY}</code> — every figure on this page is read from it and
            from the treasuries it minted, at request time.
          </p>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
