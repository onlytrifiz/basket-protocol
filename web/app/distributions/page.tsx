import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../lib/b20";
import { marketBoard } from "../../lib/market";
import { readCycles, readVault } from "../../lib/vault";
import { shares as fmtShares, since, usd, usdCompact } from "../../lib/format";
import { BrandRender } from "../components/brand-render";
import { RingMarker, SegmentRing } from "../components/segment-ring";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockLogo } from "../components/stock-logo";

export const metadata: Metadata = {
  title: "Distributions — Stockify",
  description: "The live dividend index, vault holdings and payout mechanics for Stockify on Base.",
};

/** Vault state moves on the cycle interval; a minute is fresh and a stale ledger is not a ledger. */
export const revalidate = 60;

/* The sequence closes when assets reach holders — the one lime-lit step. */
const phases = [
  { number: "01", filled: 2, lit: false, title: "Fees arrive", copy: "The v4 hook sends its ETH trading fee to the dividend vault." },
  { number: "02", filled: 4, lit: false, title: "Stocks are bought", copy: "The keeper carries out the index acquisition transactions." },
  { number: "03", filled: 6, lit: false, title: "Holders are counted", copy: "Eligible holders are enumerated from the on-chain STFY holder registry." },
  { number: "04", filled: 8, lit: true, title: "Assets are sent", copy: "The vault pushes each B20 entitlement to every eligible holder in batches." },
];

const toUnits = (raw: string | null, decimals: number) =>
  raw === null ? null : Number(BigInt(raw)) / 10 ** decimals;

export default async function DistributionsPage() {
  const [vault, assets, ledger] = await Promise.all([readVault(), readAssets(), readCycles()]);

  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const tickers = vault.holdings
    .map((h) => byAddress.get(h.address.toLowerCase())?.ticker)
    .filter(Boolean) as string[];
  const market = tickers.length ? await marketBoard(tickers) : { quotes: {}, series: {}, degraded: true };

  const rows = vault.holdings.map((holding) => {
    const asset = byAddress.get(holding.address.toLowerCase());
    const quote = asset?.ticker ? market.quotes[asset.ticker] : undefined;
    const held = toUnits(holding.heldRaw, holding.decimals);
    const unpaid = toUnits(holding.unpaidRaw, holding.decimals);
    return {
      holding, asset, quote, held, unpaid,
      value: held !== null && quote?.price ? held * quote.price : null,
    };
  });

  const acquired = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  // What has actually left for holders, summed across the cycles in the window.
  const distributedShares = ledger.cycles.reduce(
    (sum, cycle) => sum + cycle.bought.reduce((inner, b) => inner + Number(BigInt(b.receivedRaw)) / 1e8, 0),
    0,
  );
  const anyHeld = rows.some((r) => (r.held ?? 0) > 0);
  const eth = vault.availableEthWei === null ? null : Number(BigInt(vault.availableEthWei)) / 1e18;
  const threshold = vault.minShareBalanceRaw === null ? null : Number(BigInt(vault.minShareBalanceRaw)) / 1e18;

  return (
    <div className="site-shell">
      <SiteHeader active="distributions" />
      <main>
        <header className="section wrap hub-head">
          <div className="hub-head-copy">
            <p className="eyebrow">DIVIDEND DESK</p>
            <h1>See the assets leave the vault.</h1>
            <p className="hub-lede">
              The index below is read from the dividend vault itself — which equities it buys, in what
              proportion, what it is holding right now and what it already owes. Nothing on this page
              is a projection, and there is no yield counter.
            </p>
          </div>
          <BrandRender className="hub-render" priority size={340} src="/distributions.png" />
        </header>

        <section className="stats-band" aria-label="Vault state">
          <div className="stats-inner">
            <div>
              <span>Cycle</span>
              <strong>{vault.cycleActive ? "Active" : "Idle"}</strong>
              <small>
                {vault.nextDistribution > 0
                  ? `next from ${since(vault.nextDistribution)}`
                  : "no cycle has run yet"}
              </small>
            </div>
            <div>
              <span>Awaiting deployment</span>
              <strong>{eth === null ? "—" : `${eth.toFixed(4)} ETH`}</strong>
              <small>hook fees held for the next buy</small>
            </div>
            <div>
              <span>Stocks acquired</span>
              <strong>{anyHeld ? usdCompact(acquired) : "—"}</strong>
              <small>{anyHeld ? "at current share prices" : "nothing bought yet"}</small>
            </div>
            <div>
              <span>Eligible holders</span>
              <strong>{vault.holderCount === null ? "—" : vault.holderCount}</strong>
              <small>
                {threshold === null ? "threshold unread" : `holding ${fmtShares(threshold)}+ STFY`}
              </small>
            </div>
          </div>
        </section>


        {/* THE LEDGER. Empty today and deliberately kept: it is the record this page exists to show,
            and it has to be wired to the real events before the first cycle rather than after it.
            Rebuilt from `DistributionCycleCompleted` and the `StockBought` logs preceding it. */}
        <section className="desk-panel">
          <div className="desk-inner">
            <div className="desk-head">
              <div>
                <p>SETTLED DISTRIBUTIONS</p>
                <h2>{ledger.cycles.length === 0 ? "No cycles yet." : `${ledger.cycles.length} recent ${ledger.cycles.length === 1 ? "cycle" : "cycles"}.`}</h2>
              </div>
              <div className="desk-cycle">
                <SegmentRing filled={vault.cycleActive ? 8 : 1} lit motion={vault.cycleActive ? "spin" : "sweep"} size={46} stroke={9} />
                <div className="desk-cycle-meta">
                  <span>Cycle</span>
                  <b>{vault.cycleActive ? "Running" : ledger.cycles.length || "—"}</b>
                </div>
                <span className="waiting-chip">
                  <i /> {vault.cycleActive ? "Distributing" : ledger.cycles.length ? "Idle" : "Awaiting first cycle"}
                </span>
              </div>
            </div>

            <div className="desk-metrics">
              <div>
                <span>Cycles in window</span>
                <strong>{ledger.available ? ledger.cycles.length : "—"}</strong>
                <small>{ledger.available ? `last ${(ledger.windowBlocks / 1000).toFixed(0)}k blocks` : "ledger unavailable"}</small>
              </div>
              <div>
                <span>Assets distributed</span>
                <strong>{distributedShares > 0 ? fmtShares(distributedShares) : "—"}</strong>
                <small>{distributedShares > 0 ? "shares pushed to holders" : "no payouts yet"}</small>
              </div>
              <div>
                <span>Current threshold</span>
                <strong>{threshold === null ? "—" : fmtShares(threshold)}</strong>
                <small>STFY to qualify</small>
              </div>
              <div>
                <span>Next cycle</span>
                <strong>{vault.nextDistribution > 0 ? since(vault.nextDistribution) : "—"}</strong>
                <small>{vault.nextDistribution > 0 ? "earliest start" : "no cycle has run"}</small>
              </div>
            </div>

            <div className="distribution-table">
              <div className="table-head">
                <span>Cycle</span><span>Assets acquired</span><span>Holders paid</span><span>Stock budget</span>
              </div>
              {ledger.cycles.length === 0 ? (
                <div className="table-empty">
                  <span>—</span>
                  <span>
                    {ledger.available
                      ? "No cycle has settled in the scanned window. Rows appear here as soon as one does."
                      : "No endpoint would serve the log window, so the ledger cannot be read right now."}
                  </span>
                  <span>—</span><span>—</span>
                </div>
              ) : (
                ledger.cycles.map((cycle, i) => (
                  <a
                    className="table-row"
                    href={`https://basescan.org/tx/${cycle.txHash}`}
                    key={cycle.txHash}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span>#{ledger.cycles.length - i}</span>
                    <span>
                      {cycle.bought.length
                        ? cycle.bought
                            .map((b) => byAddress.get(b.address.toLowerCase())?.symbol ?? "asset")
                            .join(", ")
                        : "—"}
                    </span>
                    <span>{cycle.holderCount.toLocaleString("en-US")}</span>
                    <span>
                      {cycle.stockEthWei
                        ? `${(Number(BigInt(cycle.stockEthWei)) / 1e18).toFixed(4)} ETH`
                        : "—"}
                    </span>
                  </a>
                ))
              )}
            </div>

            <p className="desk-note">
              Cycles are rebuilt from the vault&apos;s own events. Public Base endpoints cap a log
              query at roughly {(ledger.windowBlocks / 1000).toFixed(0)}k blocks — about{" "}
              {Math.round((ledger.windowBlocks * 2) / 3600)} hours — so this is the recent record
              rather than all history; each row links to its settlement transaction.
            </p>
          </div>
        </section>

        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">THE ACTIVE INDEX</p>
            <h2>{vault.holdings.length || "No"} stocks, straight from the vault.</h2>
            <p>
              Ownership can change this set and its weights between cycles, so it is read from{" "}
              <code>stockAt()</code> rather than listed here — the page cannot drift from what the
              contract will actually buy.
            </p>
          </div>

          {vault.live && rows.length > 0 ? (
            <div className="hub-table" role="table" aria-label="Dividend index holdings">
              <div className="hub-row dist-row hub-row-head" role="row">
                <span role="columnheader">Asset</span>
                <span role="columnheader">Target weight</span>
                <span role="columnheader">Share price</span>
                <span role="columnheader">Vault holds</span>
                <span role="columnheader">Owed to holders</span>
                <span aria-hidden="true" />
              </div>

              {rows.map(({ holding, asset, quote, held, unpaid, value }) => (
                <Link
                  className="hub-row dist-row"
                  href={asset ? `/stocks/${asset.symbol.toLowerCase()}` : `/stocks`}
                  key={holding.address}
                  role="row"
                >
                  <span className="hub-asset" role="cell">
                    <StockLogo stock={{ symbol: holding.symbol, domain: asset?.domain }} logo={asset?.logo} />
                    <span className="hub-asset-id">
                      <strong>{holding.symbol}</strong>
                      <small>{holding.name}</small>
                    </span>
                  </span>

                  <span className="hub-num" data-label="Target weight" role="cell">
                    <b>{(holding.weightBps / 100).toFixed(0)}%</b>
                    <small>of each stock budget</small>
                  </span>

                  <span className="hub-num" data-label="Share price" role="cell">
                    <b>{usd(quote?.price)}</b>
                    <small>{quote ? "Nasdaq" : "unavailable"}</small>
                  </span>

                  {/* Held and owed are different claims on the same balance: the first is what the
                      vault has bought, the second what it has already credited and not yet pushed. */}
                  <span className="hub-num" data-label="Vault holds" role="cell">
                    <b>{fmtShares(held)}</b>
                    <small>{held === null ? "unread" : value !== null && held > 0 ? usdCompact(value) : "none acquired"}</small>
                  </span>

                  <span className="hub-num" data-label="Owed to holders" role="cell">
                    <b>{fmtShares(unpaid)}</b>
                    <small>{unpaid === null ? "unread" : unpaid > 0 ? "queued for transfer" : "nothing queued"}</small>
                  </span>

                  <svg aria-hidden="true" className="hub-go" viewBox="0 0 6 10" focusable="false">
                    <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
                  </svg>
                </Link>
              ))}
            </div>
          ) : (
            <p className="detail-empty">
              The dividend vault did not answer, so its index cannot be shown. On-chain figures are
              never substituted with an assumed set here.
            </p>
          )}

          {!anyHeld && vault.live && (
            <p className="hub-note-degraded">
              The vault holds none of these yet. It is accruing hook fees
              {eth !== null && eth > 0 ? ` — ${eth.toFixed(4)} ETH so far` : ""}, and the first
              acquisition happens when a cycle runs.
            </p>
          )}
        </section>

        <section className="section wrap">
          <div className="section-head">
            <p className="eyebrow">THE PAYOUT SEQUENCE</p>
            <h2>Four steps. No claim button.</h2>
            <p>
              Stockify uses a push distribution: the keeper executes settlement, while the dividend
              vault transfers stocks to qualifying holders directly.
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
            <p className="eyebrow">ELIGIBILITY</p>
            <h2>Start with<br />{threshold === null ? "100,000" : fmtShares(threshold)} STFY.</h2>
            <p>
              The minimum balance is read from the token contract, not published here: ownership can
              set it anywhere from 10,000 to 100,000 STFY, and can exclude selected addresses from
              rewards.
            </p>
          </div>
          <dl>
            <div><dt>Allocation</dt><dd>90% of each hook fee</dd></div>
            <div><dt>Asset type</dt><dd>Direct B20 token transfers</dd></div>
            <div><dt>Cadence target</dt><dd>Approximately hourly</dd></div>
            <div>
              <dt>Eligible supply</dt>
              <dd>
                {vault.eligibleSupplyRaw === null
                  ? "—"
                  : `${fmtShares(Number(BigInt(vault.eligibleSupplyRaw)) / 1e18)} STFY`}
              </dd>
            </div>
          </dl>
        </section>

        <section className="page-cta wrap">
          <div><p className="eyebrow">NEXT</p><h2>Read the operating model.</h2></div>
          <Link className="button button-ink" href="/docs">Documentation <span>→</span></Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
