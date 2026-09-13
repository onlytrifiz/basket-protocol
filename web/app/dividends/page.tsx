import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../lib/b20";
import { readDecimals, toUnits } from "../../lib/decimals";
import { readLedger } from "../../lib/ledger";
import { stockByAddress, washColor } from "../../lib/stocks";
import { marketBoard } from "../../lib/market";
import { readVault } from "../../lib/vault";
import { shares as fmtShares, stamp, until, usd, usdCompact } from "../../lib/format";
import { AssetCard, type AssetCardRow } from "../components/asset-card";
import { BrandRender } from "../components/brand-render";
import { CycleProgress } from "../components/cycle-progress";
import { RingMarker } from "../components/segment-ring";
import { SiteFooter, SiteHeader } from "../components/site-chrome";

export const metadata: Metadata = {
  title: "Dividends — Stockify",
  description: "The live dividend index, vault holdings and payout mechanics for Stockify on Base.",
};

/**
 * Rendered per request, because the ledger is paginated and `?page` is part of what to render.
 *
 * That costs nothing upstream: the vault multicall, the quote board and the stored ledger each sit
 * behind `cached()`, so a burst of readers on any page still makes one call apiece. What used to be
 * revalidated here was a log scan, and that no longer happens at render time at all.
 */
const PER_PAGE = 5;

/* Points in an asset's staircase. Enough to show whether payouts kept coming, few enough that a
   540-cycle history stays a 260px graphic rather than a wall of risers. */
const SPARK_POINTS = 56;

/* The sequence closes when assets reach holders — the one lime-lit step. */
const phases = [
  { number: "01", filled: 2, lit: false, title: "Fees arrive", copy: "The v4 hook sends its ETH trading fee to the dividend vault." },
  { number: "02", filled: 4, lit: false, title: "Stocks are bought", copy: "The keeper carries out the index acquisition transactions." },
  { number: "03", filled: 6, lit: false, title: "Holders are counted", copy: "Eligible holders are enumerated from the on-chain STFY holder registry." },
  { number: "04", filled: 8, lit: true, title: "Assets are sent", copy: "The vault pushes each B20 entitlement to every eligible holder in batches." },
];

export default async function DividendPage({ searchParams }: PageProps<"/dividends">) {
  const [vault, assets, ledger] = await Promise.all([readVault(), readAssets(), readLedger()]);

  /**
   * The scale for every asset this page names, including the ones only the ledger knows.
   *
   * The active index is not the whole set: `setIndex` rotates names out, and a cycle that bought one
   * before it left keeps its row in the ledger forever. Those addresses arrive from `StockBought`
   * logs with no metadata attached, which is exactly the case a hardcoded 8 could not survive.
   */
  const decimals = await readDecimals([
    ...vault.holdings.map((h) => h.address),
    ...ledger.cycles.flatMap((cycle) => cycle.bought.map((b) => b.address)),
  ]);
  const scaleOf = (address: string) => decimals.get(address.toLowerCase()) ?? null;

  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  /**
   * Priced for every asset this page NAMES, not just the ones still in the index.
   *
   * `setIndex` rotates names out, and a cycle that bought one before it left keeps its row in the
   * ledger forever. Quoting only `vault.holdings` meant the all-time total silently stopped
   * counting a rotated-out equity in dollars while the share count below it kept counting it — two
   * headline figures over two different sets of assets, disagreeing more with every rotation.
   */
  const tickers = [...new Set([
    ...vault.holdings.map((h) => h.address.toLowerCase()),
    ...ledger.cycles.flatMap((cycle) => cycle.bought.map((b) => b.address.toLowerCase())),
  ])]
    .map((address) => byAddress.get(address)?.ticker)
    .filter(Boolean) as string[];
  const market = tickers.length ? await marketBoard(tickers) : { quotes: {}, series: {}, degraded: true };

  /**
   * Which slice of the ledger this request is for.
   *
   * Clamped rather than 404ed: `?page=900` on a ledger of four is a stale link or a typo, and the
   * useful answer to both is the last page that exists, not an error page.
   */
  const pageCount = Math.max(1, Math.ceil(ledger.cycles.length / PER_PAGE));
  const requested = Number((await searchParams).page);
  const page = Number.isSafeInteger(requested) && requested >= 1 ? Math.min(requested, pageCount) : 1;
  const visible = ledger.cycles.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const latest = ledger.cycles[0];

  /**
   * What has actually LEFT the vault, per asset.
   *
   * The vault is emptied every cycle, so "what it holds" is near zero almost all the time and says
   * nothing about whether the protocol is working — the number that does is what reached holders.
   * Summed from the `StockBought` logs of every cycle ever settled; each cycle buys and then
   * pushes, so acquired and distributed are one quantity seen at two moments.
   *
   * An asset whose scale went unread contributes nothing rather than a number at the wrong scale:
   * its row shows "—" and the totals below simply do not count it, which is the same rule the rest
   * of this page follows for a balance it could not read.
   */
  const distributedByAsset = new Map<string, number>();
  for (const cycle of ledger.cycles) {
    for (const bought of cycle.bought) {
      const key = bought.address.toLowerCase();
      const units = toUnits(bought.receivedRaw, scaleOf(key));
      if (units === null) continue;
      distributedByAsset.set(key, (distributedByAsset.get(key) ?? 0) + units);
    }
  }

  /**
   * The same walk again, kept as a RUNNING total per asset instead of a final one.
   *
   * One point per settled cycle, oldest first, including the cycles that bought nothing of this
   * asset — those are the flat runs in the staircase, and dropping them would compress a month of
   * silence into the same width as a month of payouts. Sampled down to `SPARK_POINTS` at the end,
   * which a monotonic series survives without distortion: between two samples the total can only
   * have gone up, so no peak can hide between them.
   */
  const tracked = vault.holdings.map((h) => h.address.toLowerCase());
  const seriesByAsset = new Map<string, number[]>(tracked.map((address) => [address, []]));
  {
    const running = new Map<string, number>(tracked.map((address) => [address, 0]));
    // The ledger is stored newest first; a history is read the other way round.
    for (let i = ledger.cycles.length - 1; i >= 0; i -= 1) {
      for (const bought of ledger.cycles[i].bought) {
        const key = bought.address.toLowerCase();
        if (!running.has(key)) continue;
        const units = toUnits(bought.receivedRaw, scaleOf(key));
        if (units === null) continue;
        running.set(key, (running.get(key) ?? 0) + units);
      }
      for (const address of tracked) seriesByAsset.get(address)!.push(running.get(address) ?? 0);
    }
  }
  const sampled = (points: number[]) => {
    if (points.length <= SPARK_POINTS) return points;
    const stride = (points.length - 1) / (SPARK_POINTS - 1);
    return Array.from({ length: SPARK_POINTS }, (_, i) => points[Math.round(i * stride)]);
  };

  const rows = vault.holdings.map((holding) => {
    const asset = byAddress.get(holding.address.toLowerCase());
    const quote = asset?.ticker ? market.quotes[asset.ticker] : undefined;
    const held = toUnits(holding.heldRaw, holding.decimals);
    const distributed = distributedByAsset.get(holding.address.toLowerCase()) ?? 0;
    return {
      holding, asset, quote, held, distributed,
      distributedValue: quote?.price ? distributed * quote.price : null,
      value: held !== null && quote?.price ? held * quote.price : null,
    };
  });

  const acquired = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  // What has actually left for holders, summed across every cycle the vault ever settled — from the
  // per-asset totals above, so an unread scale is skipped in one place rather than two.
  const distributedShares = [...distributedByAsset.values()].reduce((sum, units) => sum + units, 0);
  const anyHeld = rows.some((r) => (r.held ?? 0) > 0);
  /**
   * Off the SAME map as the share count above, so the two describe one set of assets.
   *
   * This used to sum `rows`, which is the active index — an asset rotated out contributed its units
   * to the count beside this number and nothing to the number itself. A price we do not have still
   * contributes nothing, which is the same rule every other figure on this page follows.
   */
  const distributedValue = [...distributedByAsset].reduce((sum, [address, units]) => {
    const ticker = byAddress.get(address)?.ticker;
    const price = ticker ? market.quotes[ticker]?.price : undefined;
    return sum + (price ? units * price : 0);
  }, 0);
  const anyDistributed = distributedShares > 0;
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
              What has actually reached holders: which equities the vault bought, in what proportion,
              and how much of each has been pushed out. The vault is drained every cycle, so its
              balance is not the story — what left it is. Nothing here is a projection, and there is
              no yield counter.
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
              <small>{anyDistributed ? "to holders, all time" : "no cycle has settled yet"}</small>
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


        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">THE ACTIVE INDEX</p>
            <h2>{vault.holdings.length || "No"} stocks in the index.</h2>
            <p>Stockify dividends are currently distributing the following stocks:</p>
          </div>

          {vault.live && rows.length > 0 ? (
            <div className="asset-cards">
              {rows.map(({ holding, asset, quote, distributed, distributedValue }) => (
                <AssetCard
                  key={holding.address}
                  row={{
                    address: holding.address,
                    symbol: holding.symbol,
                    name: holding.name,
                    weightBps: holding.weightBps,
                    asset,
                    price: quote?.price,
                    distributed,
                    distributedValue,
                    brand: washColor(stockByAddress(holding.address)),
                    series: sampled(seriesByAsset.get(holding.address.toLowerCase()) ?? []),
                  } satisfies AssetCardRow}
                />
              ))}
            </div>
          ) : (
            <p className="detail-empty">
              The dividend vault did not answer, so its index cannot be shown. Nothing is filled in
              with an assumed set.
            </p>
          )}

          {!anyDistributed && vault.live && (
            <p className="hub-note-degraded">
              Nothing has been distributed yet. The vault is accruing hook
              fees{eth !== null && eth > 0 ? ` — ${eth.toFixed(4)} ETH so far` : ""}, and the first
              push happens when a cycle runs.
            </p>
          )}
        </section>

        {/* THE LEDGER. Every cycle the vault has ever settled, decoded once from
            `DistributionCycleCompleted` and the `StockBought` logs preceding it, then kept. */}
        <section className="desk-panel" id="ledger">
          <div className="desk-inner">
            <div className="desk-head">
              <div>
                <p>SETTLED DIVIDENDS</p>
                <h2>{ledger.cycles.length === 0 ? "No cycles yet." : `${ledger.cycles.length} settled ${ledger.cycles.length === 1 ? "cycle" : "cycles"}.`}</h2>
              </div>
              {/* A ring, a number and an "Idle" chip said three versions of one fact and none of
                  them said how far through the wait the vault is. The bar does: it runs from the
                  settlement that actually happened to the earliest start the vault reports, and it
                  ticks, because a frozen progress bar claims motion it does not have. */}
              <CycleProgress
                active={vault.cycleActive}
                from={latest?.timestamp ?? 0}
                label={vault.cycleActive ? "running" : latest ? `#${latest.n + 1}` : "one"}
                now={Date.now() / 1000}
                to={vault.nextDistribution}
              />
            </div>

            <div className="desk-metrics">
              <div>
                <span>Cycles settled</span>
                <strong>{ledger.available ? ledger.cycles.length : "—"}</strong>
                <small>{ledger.available ? "since the vault's first" : "ledger unavailable"}</small>
              </div>
              {/* In dollars, not shares. A share count sums four different equities into one
                  number that means nothing — 0.17 of what? Value is the only unit in which a slice
                  of NVDA and a slice of META can be added together. The share count moves to the
                  caption, where it reads as detail rather than as the headline figure. */}
              <div>
                <span>Assets distributed</span>
                <strong>{anyDistributed && distributedValue > 0 ? usd(distributedValue) : "—"}</strong>
                <small>
                  {anyDistributed && distributedValue > 0
                    ? `${fmtShares(distributedShares)} shares to holders`
                    : "no payouts yet"}
                </small>
              </div>
              <div>
                <span>Current threshold</span>
                <strong>{threshold === null ? "—" : fmtShares(threshold)}</strong>
                <small>STFY to qualify</small>
              </div>
              {/* WAS a second countdown to the next cycle, which the bar above now ticks live. Two
                  readings of one clock taken a second apart disagree by a minute and read as a bug.
                  This card takes the other end of the same interval instead — where the bar starts —
                  so the two describe the window together rather than competing over its right edge. */}
              <div>
                <span>Last settled</span>
                <strong>{latest ? stamp(latest.timestamp) : "—"}</strong>
                <small>{latest ? `cycle #${latest.n}` : "no cycle has run"}</small>
              </div>
            </div>

            <div className="distribution-table">
              <div className="table-head">
                <span>Cycle</span><span>Settled</span><span>Assets acquired</span><span>Holders paid</span><span>Stock budget</span><span aria-hidden="true" />
              </div>
              {visible.length === 0 ? (
                <div className="table-empty">
                  <span>—</span>
                  <span>
                    {ledger.available
                      ? "No cycle has settled yet. Rows appear here as soon as one does."
                      : "The stored ledger could not be read, so the record cannot be shown right now."}
                  </span>
                  <span>—</span><span>—</span><span>—</span><span aria-hidden="true" />
                </div>
              ) : (
                visible.map((cycle) => (
                  <a
                    className="table-row"
                    href={`https://basescan.org/tx/${cycle.txHash}`}
                    key={cycle.txHash}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {/* The number is absolute and permanent — cycle #3 is the third the vault ever
                        settled, on whichever page it happens to fall. Numbering from the top of the
                        visible slice would have renumbered every row each time a new one landed. */}
                    <span>#{cycle.n}</span>
                    <span className="cycle-when">{stamp(cycle.timestamp)}</span>
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
                            {fmtShares(toUnits(b.receivedRaw, scaleOf(b.address)))}
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

            {/* Plain links, not a control: each page of the ledger is a real URL someone can send,
                and it works before any JavaScript has loaded. */}
            {pageCount > 1 && (
              <nav className="ledger-pager" aria-label="Ledger pages">
                {page > 1
                  ? <Link href={`/dividends?page=${page - 1}#ledger`} rel="prev">← Newer</Link>
                  : <span aria-hidden="true">← Newer</span>}
                <b>
                  Page {page} of {pageCount}
                  <small>cycles #{visible[visible.length - 1]?.n}–#{visible[0]?.n}</small>
                </b>
                {page < pageCount
                  ? <Link href={`/dividends?page=${page + 1}#ledger`} rel="next">Older →</Link>
                  : <span aria-hidden="true">Older →</span>}
              </nav>
            )}

            <p className="desk-note">
              The complete record since the vault was deployed, not a recent window. Each row links
              to its settlement transaction.
            </p>
          </div>
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
              Ownership can set the minimum anywhere from 10,000 to 100,000 STFY, and can exclude
              selected addresses from rewards.
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
