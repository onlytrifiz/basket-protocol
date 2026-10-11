import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";

import { readAssets } from "../../../lib/b20";
import { coinArt } from "../../../lib/coin-art";
import { indexAsset } from "../../../lib/index-assets";
import { readDecimals, readDecimalsOf, toUnits } from "../../../lib/decimals";
import {
  MIN_HOLDER_COINS,
  MODE,
  readIndexDetail,
  readIndexHistory,
  readPlatformFeeBps,
  returnedUsd,
  splitOf,
} from "../../../lib/indices";
import { shares as fmtShares, since, usd, usdCompact } from "../../../lib/format";
import { CoinArtClient } from "../../components/coin-art-client";
import { IndexActions } from "../../components/index-actions";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";
import { StockLogo } from "../../components/stock-logo";

/**
 * Rendered per request, and forced rather than inferred.
 *
 * This is the same trap `app/page.tsx` documents. `lib/cache` wraps every chain read, so when its
 * in-process cache happens to be warm no `fetch` runs during render — Next's static analysis then
 * sees no dynamic API and prerenders the page. The moment a real read does run, it is a `no-store`
 * fetch on a page Next has decided is static, and it fails with "Page changed from static to dynamic
 * at runtime" and serves the build-time render instead.
 *
 * Which is how a bound index that had collected fees rendered as "nothing has pointed its fees here
 * yet": not a bad read, a page that was never allowed to make one.
 *
 * The reads are still cached for 60-120s each, so per-request rendering costs no extra traffic.
 */
export const dynamic = "force-dynamic";

const PER_PAGE = 10;

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const index = await readIndexDetail(address);
  const name = index?.coinSymbol ?? "Index";
  return {
    title: `${name} index — Stockify`,
    description: "What this index holds, what it has paid its holders, and whether it is still being paid.",
  };
}

const cadence = (seconds: number) => {
  if (seconds >= 604_800) return "1 week";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} day`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} hour`;
  return `${Math.round(seconds / 60)} min`;
};

const amount = (n: number) => (n === 0 ? "0" : n < 1 ? n.toFixed(4) : n.toFixed(2));

/**
 * The UTC day an event landed on, for the dividers in the feed.
 *
 * UTC rather than the reader's zone because every other timestamp on this page is UTC, and a feed
 * whose dividers disagree with its rows about which day it is would be worse than no dividers.
 */
const dayOf = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
const shorten = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default async function IndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { address } = await params;
  const [index, platformBps, assets, history] = await Promise.all([
    readIndexDetail(address),
    readPlatformFeeBps(),
    readAssets(),
    readIndexHistory(address),
  ]);

  if (!index) {
    return (
      <div className="site-shell">
        <SiteHeader active="indices" />
        <main>
          <section className="section wrap">
            <p className="detail-empty">
              Nothing at this address is an index. It may belong to a different factory, or to none.
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
  const bound = index.coin !== "0x0000000000000000000000000000000000000000";
  const quoteDecimals = await readDecimalsOf(index.quote);
  // The coin has its own scale, and the feed moves it on every burn and every buyback purchase.
  const coinDecimals = bound ? await readDecimalsOf(index.coin) : null;
  /**
   * And every holding has its own too — ASKED, not assumed to be eight.
   *
   * Eight is a fact about the equities this repo ships, not about a basket: `initialize` takes any
   * ERC-20 that holds code. A payout of anything else was scaled against a seed-list hit that did
   * not exist and rendered an em dash, on a row where real money had moved.
   */
  const basketDecimals = await readDecimals(index.basket);
  const quoteLabel =
    index.quote === "0x0000000000000000000000000000000000000000"
      ? "ETH"
      : byAddress.get(index.quote.toLowerCase())?.symbol ?? index.quoteSymbol ?? "the quote";

  const requested = Number((await searchParams).page);
  const events = history?.events ?? [];
  const pageCount = Math.max(1, Math.ceil(events.length / PER_PAGE));
  const page = Number.isSafeInteger(requested) && requested >= 1 ? Math.min(requested, pageCount) : 1;
  const visible = events.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const burnCount = events.filter((e) => e.kind === "burn").length;

  /**
   * The history was never read, which is NOT the same as a history of nothing.
   *
   * These two rendered identically until they had to be told apart: every treasury past the visible
   * page had no activity fetched for it at all, and the page reported them as indexes that had paid
   * nobody. The read is fixed in `lib/indices`; this is the half that makes the next such gap show
   * as a gap instead of quietly becoming a fact about the index.
   */
  const unread = history === null;

  /** What a holding calls itself: the seed list, then what the chain said, then nothing. */
  const symbolOfHolding = (token?: string) => {
    if (!token) return null;
    const i = index.basket.findIndex((t) => t.toLowerCase() === token.toLowerCase());
    return i === -1 ? null : index.basketSymbols[i] ?? null;
  };

  const waiting = toUnits(index.spendable.toString(), quoteDecimals);
  const creatorWaiting = toUnits(index.creatorClaimable.toString(), quoteDecimals);

  const returned = returnedUsd({
    mode: index.mode,
    paidUsd: history?.paidUsd ?? null,
    burnedUsd: history?.burnedUsd ?? null,
  });
  const symbol = index.coinSymbol ?? (bound ? shorten(index.coin) : "Unbound");
  // A coin the site already carries art for wins over the launchpad lookup, which can miss.
  const art = bound
    ? indexAsset(index.coin)?.logo ?? (await coinArt([index.coin])).get(index.coin.toLowerCase())
    : undefined;
  const tint = burns ? "var(--burn-fg)" : "var(--blue)";
  const pct = (bps: number) => `${(bps / 100).toFixed(0)}%`;

  const feed = events.length > 0 && (
    <section aria-labelledby="idx-activity" className="idx-panel idx-activity">
      <header className="idx-panel-head">
        <h2 id="idx-activity">Activity</h2>
        <span>{events.length.toLocaleString("en-US")} {events.length === 1 ? "entry" : "entries"}</span>
      </header>

      {/* An ordered list, not a stack of links: the order IS the record, and a screen
          reader that cannot tell one entry from the next loses the only structure here. */}
      <ol className="idx-feed">
        {visible.map((event, i) => {
          const asset = event.token ? byAddress.get(event.token.toLowerCase()) : undefined;
          /**
           * The scale of whatever this row moved, and it is three different tokens.
           *
           * Fees arrive in the quote. A payout is an equity, which is eight. A burn and a
           * buyback's purchase are the COIN — not a B20, so looking it up in the asset map
           * found nothing and every one of those rows rendered an em dash.
           */
          const isCoin = !!event.token && event.token.toLowerCase() === index.coin.toLowerCase();
          const scale = event.kind === "fees"
            ? quoteDecimals
            : isCoin
              ? coinDecimals
              : event.token
                ? basketDecimals.get(event.token.toLowerCase()) ?? null
                : null;
          const spent = event.spentRaw ? toUnits(event.spentRaw, quoteDecimals) : null;
          const value = toUnits(event.amountRaw, scale);
          const rowSymbol = event.kind === "fees"
            ? quoteLabel
            : isCoin
              ? index.coinSymbol ?? ""
              : asset?.symbol ?? symbolOfHolding(event.token) ?? "";
          const label = event.kind === "fees"
            ? "Fees in"
            : event.kind === "bought"
              ? "Bought"
              : event.kind === "burn"
                ? "Burned"
                : "Paid out";
          const day = dayOf(event.timestamp);
          const opensDay = i === 0 || dayOf(visible[i - 1].timestamp) !== day;

          return (
            <Fragment key={`${event.txHash}-${event.kind}-${event.logIndex}`}>
              {/* Only where the day actually turns. A divider on every row would be a
                  decoration; here it is the one thing "12m ago" cannot tell you. */}
              {opensDay && (
                <li aria-hidden="true" className="idx-feed-day"><span>{day}</span></li>
              )}
              <li className={`idx-feed-item is-${event.kind}`}>
                <a
                  className="idx-feed-row"
                  href={`https://basescan.org/tx/${event.txHash}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {/* The node carries the one thing four identical grey rows could not say:
                      which way value moved. Filled where it settled — in, or out for good —
                      and hollow for a buy, which is the only state where value is inside the
                      treasury and has not left yet. */}
                  <span aria-hidden="true" className="idx-feed-node" />
                  <span className="idx-kind">{label}</span>
                  <span className="idx-feed-what">
                    <b className="idx-feed-amount">{value === null ? "—" : amount(value)}</b>
                    {rowSymbol && <span className="idx-feed-sym">{rowSymbol}</span>}
                    {event.holders !== undefined && (
                      <small>to {event.holders.toLocaleString("en-US")} holder{event.holders === 1 ? "" : "s"}</small>
                    )}
                    {/* What the buy cost, so the feed reads as one motion: fee in, equity out. */}
                    {spent !== null && <small>for {amount(spent)} {quoteLabel}</small>}
                  </span>
                  <span className="idx-feed-when">{since(event.timestamp)}</span>
                </a>
              </li>
            </Fragment>
          );
        })}
      </ol>

      {pageCount > 1 && (
        <nav aria-label="Activity pages" className="idx-pager">
          {page > 1 ? (
            <Link className="idx-pager-step" href={`/indices/${index.address}?page=${page - 1}`} rel="prev" scroll={false}>
              ← Newer
            </Link>
          ) : (
            /* The end of the record is shown, not hidden: a missing control reads as a bug,
               a spent one reads as the edge of what there is. */
            <span aria-disabled="true" className="idx-pager-step is-spent">← Newer</span>
          )}
          <span className="idx-pager-count">
            Page <b>{page}</b> of <b>{pageCount.toLocaleString("en-US")}</b>
          </span>
          {page < pageCount ? (
            <Link className="idx-pager-step" href={`/indices/${index.address}?page=${page + 1}`} rel="next" scroll={false}>
              Older →
            </Link>
          ) : (
            <span aria-disabled="true" className="idx-pager-step is-spent">Older →</span>
          )}
        </nav>
      )}
    </section>
  );

  return (
    <div className="site-shell">
      <SiteHeader active="indices" />
      <main className="idx-page">
        <section className="wrap idx-top">
          <Link className="detail-back" href="/indices">← All indices</Link>

          <div className="detail-canvas idx-canvas" style={{ "--brand": tint } as React.CSSProperties}>
            <div className="idx-hero">
              <div className="idx-hero-id">
                {/* Filled here when the server got the artwork, and by the browser when it did not. */}
                <span
                  className={`idx-mark coin-mark${art ? " has-art" : ""}`}
                  data-coin={bound ? index.coin.toLowerCase() : undefined}
                  style={art ? ({ "--art": `url("${art}")` } as React.CSSProperties) : undefined}
                >
                  <i aria-hidden="true">{symbol.slice(0, 2)}</i>
                </span>
                <CoinArtClient />
                <div>
                  <p className="idx-tags">
                    <span className={`idx-tag${burns ? " is-burn" : ""}`}>{burns ? "Buyback and burn" : "Holder rewards"}</span>
                    {/* Paused changes what this index is doing right now, so it sits by the name. */}
                    {index.paused && <span className="idx-tag is-paused">Paused</span>}
                  </p>
                  <h1>{symbol}</h1>
                  <p className="idx-links">
                    <a className="idx-addr-pill" href={`https://basescan.org/address/${index.address}`} rel="noreferrer" target="_blank">
                      {shorten(index.address)} ↗
                    </a>
                    {bound && (
                      <a aria-label={`Trade ${index.coinSymbol ?? "the coin"} on The Stonks Exchange`} className="idx-addr-pill idx-stonks-link" href={`https://www.thestonks.exchange/token/${index.coin}`} rel="noreferrer" target="_blank">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img alt="" height={14} src="/partners/stonks-exchange.png" width={14} />
                        <span>Trade on <span className="idx-stonks-full">The Stonks Exchange</span><span className="idx-stonks-short">Stonks</span> ↗</span>
                      </a>
                    )}
                  </p>
                </div>
              </div>

              <div className="idx-hero-figure">
                <span>{burns ? "Burned" : "Paid to holders"}</span>
                {/* The list's own definition, fed from this page's figures, so the headline here
                    and the row over on /indices can never print two different numbers. */}
                <strong>{returned ? usdCompact(returned) : "—"}</strong>
                <small>
                  {unread
                    ? "could not be read"
                    : burns
                      ? history?.burnedUnits
                        ? `${fmtShares(history.burnedUnits)} ${index.coinSymbol ?? "coins"} destroyed`
                        : "nothing yet"
                      : history?.paidUnits.length
                        ? history.paidUnits.map((p) => `${amount(p.units)} ${p.symbol}`).join(" · ")
                        : "nothing yet"}
                </small>
              </div>
            </div>

            <dl className="idx-kpis">
              {/* "Rounds paid: 0" beside "$60 burned" reads as an index that has done nothing. A
                  buyback has no rounds — it has burns, and that is the count worth showing. */}
              <div>
                <dt>{burns ? "Burns run" : "Rounds paid"}</dt>
                <dd>{history ? (burns ? burnCount : history.rounds).toLocaleString("en-US") : "—"}</dd>
                <small>
                  {unread
                    ? "could not be read"
                    : burns
                      ? burnCount > 0 ? "supply destroyed each time" : "none yet"
                      : history && history.rounds > 0
                        ? `${history.payments.toLocaleString("en-US")} wallet payments`
                        : "none yet"}
                </small>
              </div>
              <div>
                <dt>Fees collected</dt>
                <dd>{history?.feesUsd ? usdCompact(history.feesUsd) : "—"}</dd>
                <small>
                  {unread ? "could not be read" : history?.feesUnits ? `${amount(history.feesUnits)} ${quoteLabel}` : "none yet"}
                </small>
              </div>
              <div>
                <dt>Creator earnings</dt>
                <dd>{history?.creatorUsd ? usd(history.creatorUsd) : "—"}</dd>
                <small>
                  {index.creatorShareBps > 0 ? `${pct(split.creator)} of net fees` : "all of it goes to holders"}
                </small>
              </div>
            </dl>
          </div>

          {bound && !index.stillCollecting && (
            <p className="hub-note-degraded">
              This index is <strong>no longer being paid</strong>. The coin&apos;s creator has pointed
              the fee stream somewhere else, so nothing new will arrive — what it already bought and
              paid out stays with the holders who received it.
            </p>
          )}
          {!bound && (
            <p className="hub-note-degraded">
              No coin is tied to this index yet, so its fees have nowhere to come from. It starts
              working the moment a launch points its creator fees at the address above.
            </p>
          )}
        </section>

        <div className="wrap idx-layout">
          <div className="idx-main">
            {!burns && index.basket.length > 0 && (
              <section aria-labelledby="idx-holds" className="idx-panel idx-holds-panel">
                <header className="idx-panel-head">
                  <h2 id="idx-holds">What it holds</h2>
                  <span>{index.basket.length} {index.basket.length === 1 ? "name" : "names"}, fixed at creation</span>
                </header>
                <ul className="idx-holdings">
                  {index.basket.map((token, i) => {
                    const asset = byAddress.get(token.toLowerCase());
                    // A basket entry is any ERC-20 the treasury was created with, so the seed list
                    // answers for the equities and the chain answers for everything else. Only a
                    // token that will not say either falls back to its address.
                    const name = asset?.symbol ?? index.basketSymbols[i] ?? shorten(token);
                    const paid = history?.paidUnits.find((p) => p.token.toLowerCase() === token.toLowerCase());
                    const weight = (index.weights[i] ?? 0) / 100;
                    return (
                      <li key={token}>
                        <StockLogo logo={asset?.logo} stock={{ symbol: name, domain: asset?.domain }} />
                        <span className="idx-holding-id">
                          <b>{name}</b>
                          <small>{paid ? `${amount(paid.units)} paid out` : "nothing paid yet"}</small>
                        </span>
                        <span className="idx-holding-weight">
                          <b>{weight.toFixed(0)}%</b>
                          <i aria-hidden="true"><span style={{ width: `${weight}%` }} /></i>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {feed}
          </div>

          <aside className="idx-side">
            <section aria-labelledby="idx-now" className="idx-panel idx-now">
              <header className="idx-panel-head"><h2 id="idx-now">Right now</h2></header>
              <dl className="idx-facts">
                <div>
                  <dt>Waiting to be invested</dt>
                  <dd>{waiting === null ? "—" : `${amount(waiting)} ${quoteLabel}`}</dd>
                </div>
                <div>
                  <dt>{burns ? "Next burn" : "Payout round"}</dt>
                  <dd>{burns ? "Any time" : `Every ${cadence(index.interval)}`}</dd>
                </div>
                <div>
                  <dt>Owed to the creator</dt>
                  <dd>{creatorWaiting === null ? "—" : `${amount(creatorWaiting)} ${quoteLabel}`}</dd>
                </div>
              </dl>
            </section>

            <section aria-labelledby="idx-split" className="idx-panel idx-split">
              <header className="idx-panel-head"><h2 id="idx-split">Where each fee goes</h2></header>
              <div aria-hidden="true" className="idx-split-bar">
                <span className="is-holders" style={{ flexGrow: split.holders }} />
                {split.platform > 0 && <span className="is-platform" style={{ flexGrow: split.platform }} />}
                {split.creator > 0 && <span className="is-creator" style={{ flexGrow: split.creator }} />}
              </div>
              <ul className="idx-split-legend">
                <li className="is-holders"><span>{burns ? "Buyback and burn" : "Holders"}</span><b>{pct(split.holders)}</b></li>
                <li className="is-platform"><span>Protocol</span><b>{pct(split.platform)}</b></li>
                <li className="is-creator"><span>Creator</span><b>{pct(split.creator)}</b></li>
              </ul>
              <p className="idx-panel-note">
                {burns
                  ? `Every fee buys ${index.coinSymbol ?? "the coin"} back and destroys it. No holder list is read, so the burn is open to anyone.`
                  : `Paid pro-rata on the coin balance held when a round runs; nothing to claim. Wallets under ${MIN_HOLDER_COINS.toLocaleString("en-US")} coins are skipped and their slice stays with everyone else.`}
              </p>
            </section>

            <section aria-labelledby="idx-run" className="idx-panel idx-run">
              <header className="idx-panel-head"><h2 id="idx-run">Run it yourself</h2></header>
              <p className="idx-panel-note">
                Collecting only moves money in, the burn has one destination, and the creator is paid
                whoever pays the gas. So anyone can press these.
              </p>
              <IndexActions address={index.address} buyback={burns} />
            </section>

            <section aria-labelledby="idx-contracts" className="idx-panel idx-contracts">
              <header className="idx-panel-head"><h2 id="idx-contracts">Contracts</h2></header>
              <dl className="idx-facts">
                {([["Coin", bound ? index.coin : null], ["Index treasury", index.address], ["Fees arrive in", index.quote === "0x0000000000000000000000000000000000000000" ? null : index.quote]] as Array<[string, string | null]>)
                  .filter(([, value]) => !!value)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>
                        <a href={`https://basescan.org/address/${value}`} rel="noreferrer" target="_blank" title={value!}>
                          {shorten(value!)} ↗
                        </a>
                      </dd>
                    </div>
                  ))}
              </dl>
            </section>
          </aside>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
