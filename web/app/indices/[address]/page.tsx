import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../../lib/b20";
import { MIN_HOLDER_COINS, MODE, readIndexDetail, readPlatformFeeBps, splitOf } from "../../../lib/indices";
import { shares as fmtShares } from "../../../lib/format";
import { IndexActions } from "../../components/index-actions";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";

export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const index = await readIndexDetail(address);
  const name = index?.coinSymbol ?? "Index";
  return {
    title: `${name} index — Stockify`,
    description: "What this index holds, what it pays, and whether the fee stream behind it is still pointed at it.",
  };
}

const cadence = (seconds: number) => {
  if (seconds >= 604_800) return "1 week";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} day`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} hour`;
  return `${Math.round(seconds / 60)} min`;
};

export default async function IndexPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const [index, platformBps, assets] = await Promise.all([
    readIndexDetail(address),
    readPlatformFeeBps(),
    readAssets(),
  ]);

  if (!index) {
    return (
      <div className="site-shell">
        <SiteHeader active="indices" />
        <main>
          <section className="section wrap">
            <p className="detail-empty">
              Nothing at this address answers as an index. It may belong to a different factory, or to
              none — no record of ours is consulted here, only the chain.
            </p>
            <p style={{ marginTop: "18px" }}>
              <Link className="detail-back" href="/indices">← The live set</Link>
            </p>
          </section>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const burns = index.mode === MODE.buyback;
  const split = splitOf(index.creatorShareBps, platformBps);
  const quoteLabel = index.quote === "0x0000000000000000000000000000000000000000"
    ? "ETH"
    : byAddress.get(index.quote.toLowerCase())?.symbol ?? "the quote";

  return (
    <div className="site-shell">
      <SiteHeader active="indices" />
      <main>
        <section className="section wrap">
          <Link className="detail-back" href="/indices">← The live set</Link>

          <header className="detail-head" style={{ marginTop: "14px" }}>
            <div>
              <p className="eyebrow">{burns ? "BUYBACK AND BURN" : "HOLDER REWARDS"}</p>
              <h1>{index.coinSymbol ?? `${index.coin.slice(0, 10)}…`}</h1>
              <p className="detail-id">{index.address}</p>
            </div>
            <div className="detail-badges">
              {index.paused && <span className="chip">Paused</span>}
              <span className="chip">{index.permanent ? "Irrevocable" : "Revocable by creator"}</span>
            </div>
          </header>

          {/* The one thing a snapshot cannot tell you, asked live. */}
          {!index.stillCollecting && (
            <p className="hub-note-degraded" style={{ marginTop: "18px" }}>
              This index is <strong>no longer being paid</strong>. The coin&apos;s creator has pointed
              the fee stream somewhere else, so nothing new will arrive — what it already bought and
              distributed stays with the holders who received it.
            </p>
          )}
        </section>

        <section className="stats-band" aria-label="Index state">
          <div className="stats-inner">
            <div>
              <span>What it does</span>
              <strong>{burns ? "Burns" : "Pays equity"}</strong>
              <small>{burns ? "buys the coin back" : `${index.basket.length} ${index.basket.length === 1 ? "name" : "names"}`}</small>
            </div>
            <div>
              <span>Fees arrive in</span>
              <strong>{quoteLabel}</strong>
              <small>sold to buy {burns ? "the coin" : "the basket"}</small>
            </div>
            <div>
              <span>Ready to spend</span>
              <strong>{fmtShares(Number(index.spendable) / 1e18)}</strong>
              <small>collected and already split</small>
            </div>
            <div>
              <span>{burns ? "Burn opens" : "Pays no sooner than"}</span>
              <strong>{burns ? "any time" : cadence(index.interval)}</strong>
              <small>{burns ? "open to anyone" : "and only when there is something to pay"}</small>
            </div>
          </div>
        </section>

        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">{burns ? "WHAT IT BUYS" : "THE BASKET"}</p>
            <h2>{burns ? "Its own coin, then destroys it." : `${index.basket.length} ${index.basket.length === 1 ? "name" : "names"}, fixed at creation.`}</h2>
            <p>
              {burns
                ? "Nothing is handed out and no holder list is ever read, which is why the burn below is open to anyone."
                : `Bought one name at a time, each only when its own slice is worth the gas. Holders under ${MIN_HOLDER_COINS.toLocaleString("en-US")} coins are skipped and their slice stays with everyone above the line.`}
            </p>
          </div>

          {!burns && index.basket.length > 0 && (
            <div className="hub-table" role="table" aria-label="Composition">
              <div className="hub-row hub-row-head" role="row">
                <span role="columnheader">Asset</span>
                <span role="columnheader">Target weight</span>
                <span aria-hidden="true" />
              </div>
              {index.basket.map((token, i) => {
                const asset = byAddress.get(token.toLowerCase());
                return (
                  <div className="hub-row" key={token} role="row">
                    <span className="hub-asset" role="cell">
                      {asset?.logo
                        ? <img alt="" className="cycle-mark" src={asset.logo} />
                        : <span className="cycle-mark cycle-mark-blank" />}
                      <span className="hub-asset-id">
                        <strong>{asset?.symbol ?? `${token.slice(0, 8)}…`}</strong>
                        <small>{asset?.name ?? token}</small>
                      </span>
                    </span>
                    <span className="hub-num" data-label="Target weight" role="cell">
                      <b>{((index.weights[i] ?? 0) / 100).toFixed(0)}%</b>
                      <small>of each spend</small>
                    </span>
                    <span aria-hidden="true" />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="eligibility wrap">
          <div>
            <p className="eyebrow">WHERE THE FEES GO</p>
            <h2>{(split.holders / 100).toFixed(0)}% to<br />{burns ? "the burn" : "holders"}.</h2>
            <p>
              The protocol&apos;s cut comes off the top, the creator&apos;s off what is left. What the
              creator keeps is fenced on-chain: a buy can never spend it, and a payout can never reach
              it.
            </p>
          </div>
          <dl>
            <div><dt>Protocol</dt><dd>{(split.platform / 100).toFixed(0)}%</dd></div>
            <div><dt>{burns ? "Burned" : "Holders"}</dt><dd>{(split.holders / 100).toFixed(0)}%</dd></div>
            <div><dt>Creator</dt><dd>{(split.creator / 100).toFixed(0)}%</dd></div>
            <div>
              <dt>Waiting for the creator</dt>
              <dd>{fmtShares(Number(index.creatorClaimable) / 1e18)} {quoteLabel}</dd>
            </div>
          </dl>
        </section>

        <section className="section wrap">
          <div className="section-head">
            <p className="eyebrow">ANYONE CAN RUN THESE</p>
            <h2>None of them can be pointed anywhere.</h2>
            <p>
              Collecting only moves money in. The burn has one destination. The creator payment goes to
              the creator whoever pays the gas. That is why they are open — and why an index does not
              stop working if our keeper does.
            </p>
          </div>
          <IndexActions address={index.address} buyback={burns} />
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
