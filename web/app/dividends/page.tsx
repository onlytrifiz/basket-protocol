import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../lib/b20";
import { marketBoard } from "../../lib/market";
import { readCycles, readVault } from "../../lib/vault";
import { shares as fmtShares, since, until, usd, usdCompact } from "../../lib/format";
import { BrandRender } from "../components/brand-render";
import { RingMarker, SegmentRing } from "../components/segment-ring";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockLogo } from "../components/stock-logo";

export const metadata: Metadata = {
  title: "Dividends — Stockify",
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

export default async function DividendPage() {
  const [vault, assets, ledger] = await Promise.all([readVault(), readAssets(), readCycles()]);

  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const tickers = vault.holdings
    .map((h) => byAddress.get(h.address.toLowerCase())?.ticker)
    .filter(Boolean) as string[];
  const market = tickers.length ? await marketBoard(tickers) : { quotes: {}, series: {}, degraded: true };

  /**
   * What has actually LEFT the vault, per asset.
   *
   * The vault is emptied every cycle, so "what it holds" is near zero almost all the time and says
   * nothing about whether the protocol is working — the number that does is what reached holders.
   * Summed from the `StockBought` logs of every settled cycle in the window; each cycle buys and
   * then pushes, so acquired and distributed are one quantity seen at two moments.
   */
  const distributedByAsset = new Map<string, number>();
  for (const cycle of ledger.cycles) {
    for (const bought of cycle.bought) {
      const key = bought.address.toLowerCase();
      distributedByAsset.set(key, (distributedByAsset.get(key) ?? 0) + Number(BigInt(bought.receivedRaw)) / 1e8);
    }
  }

  const rows = vault.holdings.map((holding) => {
    const asset = byAddress.get(holding.address.toLowerCase());
    const quote = asset?.ticker ? market.quotes[asset.ticker] : undefined;
    const held = toUnits(holding.heldRaw, holding.decimals);
    const unpaid = toUnits(holding.unpaidRaw, holding.decimals);
    const distributed = distributedByAsset.get(holding.address.toLowerCase()) ?? 0;
    return {
      holding, asset, quote, held, unpaid, distributed,
      distributedValue: quote?.price ? distributed * quote.price : null,
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
  const distributedValue = rows.reduce((sum, r) => sum + (r.distributedValue ?? 0), 0);
  const anyDistributed = rows.some((r) => r.distributed > 0);
  const windowHours = Math.round((ledger.windowBlocks * 2) / 3600);
  const eth = vault.availableEthWei === null ? null : Number(BigInt(vault.availableEthWei)) / 1e18;
  const threshold = vault.minShareBalanceRaw === null ? null : Number(BigInt(vault.minShareBalanceRaw)) / 1e18;

  return (
    <div className="site-shell">
      <SiteHeader active="dividends" />
      <main>
        <header className="section wrap hub-head">
          <div className="hub-head-copy">
            <p className="eyebrow">DIVIDEND DESK</p>
            <h1>See the assets leave the vault.</h1>
            <p className="hub-lede">
              What has actually reached holders, read from the vault&apos;s own events — which equities
              it bought, in what proportion, and how much of each has been pushed out. The vault is
              drained every cycle, so its balance is not the story; what left it is. Nothing here is a
              projection, and there is no yield counter.
            </p>
          </div>
          <BrandRender className="hub-render" priority size={340} src="/distributions.png" />
        </header>

        <section className="stats-band" aria-label="Vault state">
          <div className="stats-inner">
            {/* What the vault is sitting on right now. "Idle" was true but empty: the cycle state
                is a label, while the stock waiting to be pushed is the thing a holder is owed. The
                cadence moves into the caption, where it explains WHEN this clears rather than
                occupying the number. */}
            <div>
              <span>In the vault</span>
              <strong>{anyHeld ? usdCompact(acquired) : "—"}</strong>
              <small>
                {vault.cycleActive
                  ? "distributing now"
                  : anyHeld
                    ? vault.nextDistribution > 0
                      ? `pushes out ${until(vault.nextDistribution)}`
                      : "awaiting the first cycle"
                    : "nothing acquired yet"}
              </small>
            </div>
            {/* Distributed first. The vault is drained every cycle, so its balance is a number that
                spends most of its life at zero — what reached holders is the one that accumulates. */}
            <div>
              <span>Distributed</span>
              <strong>{anyDistributed ? usdCompact(distributedValue) : "—"}</strong>
              <small>{anyDistributed ? `to holders, last ${windowHours}h` : "no cycle has settled yet"}</small>
            </div>
            <div>
              <span>Awaiting the next buy</span>
              <strong>{eth === null ? "—" : `${eth.toFixed(4)} ETH`}</strong>
              <small>{anyHeld ? `plus ${usdCompact(acquired)} in stock` : "hook fees, not yet deployed"}</small>
            </div>
            <div>
              <span>Eligible holders</span>
              <strong>{vault.holderCount === null ? "—" : vault.holderCount}</strong>
              <small>
                {vault.holderCount === null
                  ? "registry unreadable"
                  : threshold === null ? "threshold unread" : `holding ${fmtShares(threshold)}+ STFY`}
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
                <p>SETTLED DIVIDENDS</p>
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
                <strong>{vault.nextDistribution > 0 ? until(vault.nextDistribution) : "—"}</strong>
                <small>{vault.nextDistribution > 0 ? "earliest start" : "no cycle has run"}</small>
              </div>
            </div>

            <div className="distribution-table">
              <div className="table-head">
                <span>Cycle</span><span>Assets acquired</span><span>Holders paid</span><span>Stock budget</span><span aria-hidden="true" />
              </div>
              {ledger.cycles.length === 0 ? (
                <div className="table-empty">
                  <span>—</span>
                  <span>
                    {ledger.available
                      ? "No cycle has settled in the scanned window. Rows appear here as soon as one does."
                      : "No endpoint would serve the log window, so the ledger cannot be read right now."}
                  </span>
                  <span>—</span><span>—</span><span aria-hidden="true" />
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
                    {/* A comma list of tickers made four near-identical rows impossible to scan.
                        The mark carries the identity and the figure carries the size. */}
                    <span className="cycle-assets">
                      {cycle.bought.length ? cycle.bought.map((b) => {
                        const asset = byAddress.get(b.address.toLowerCase());
                        return (
                          // A bare <img>, not <StockLogo>: nested in two flex containers the shared
                          // component's percentage sizing collapsed the mark to zero width, and its
                          // white chip is wrong on this dark panel anyway.
                          <span className="cycle-asset" key={b.address} title={asset?.symbol ?? b.address}>
                            {asset?.logo
                              ? <img alt="" className="cycle-mark" loading="lazy" src={asset.logo} />
                              : <span className="cycle-mark cycle-mark-blank" />}
                            {fmtShares(Number(BigInt(b.receivedRaw)) / 1e8)}
                          </span>
                        );
                      }) : "—"}
                    </span>
                    <span>{cycle.holderCount.toLocaleString("en-US")}</span>
                    <span>
                      {cycle.stockEthWei
                        ? `${(Number(BigInt(cycle.stockEthWei)) / 1e18).toFixed(4)} ETH`
                        : "—"}
                    </span>
                    {/* Every row opens its settlement transaction, which nothing else here says. */}
                    <svg aria-hidden="true" className="cycle-go" viewBox="0 0 6 10" focusable="false">
                      <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
                    </svg>
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
                <span role="columnheader">Distributed</span>
                <span role="columnheader">Owed to holders</span>
                <span aria-hidden="true" />
              </div>

              {rows.map(({ holding, asset, quote, held, unpaid, distributed, distributedValue }) => (
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

                  {/* Distributed is the cumulative figure; what the vault currently holds rides
                      along underneath it, because between cycles that is almost always nothing. */}
                  <span className="hub-num" data-label="Distributed" role="cell">
                    <b>{distributed > 0 ? fmtShares(distributed) : "—"}</b>
                    <small>
                      {distributed > 0
                        ? distributedValue !== null ? usdCompact(distributedValue) : "shares"
                        : held !== null && held > 0 ? `${fmtShares(held)} held` : "none yet"}
                    </small>
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

          {!anyDistributed && vault.live && (
            <p className="hub-note-degraded">
              Nothing has been distributed in the last {windowHours} hours. The vault is accruing hook
              fees{eth !== null && eth > 0 ? ` — ${eth.toFixed(4)} ETH so far` : ""}, and the first
              push happens when a cycle runs.
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
