import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../../lib/b20";
import { readDecimalsOf, toUnits } from "../../../lib/decimals";
import {
  MIN_HOLDER_COINS,
  MODE,
  readIndexDetail,
  readIndexHistory,
  readPlatformFeeBps,
  splitOf,
} from "../../../lib/indices";
import { shares as fmtShares, since, usd, usdCompact } from "../../../lib/format";
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
  const quoteLabel =
    index.quote === "0x0000000000000000000000000000000000000000"
      ? "ETH"
      : byAddress.get(index.quote.toLowerCase())?.symbol ?? "the quote";

  const requested = Number((await searchParams).page);
  const events = history?.events ?? [];
  const pageCount = Math.max(1, Math.ceil(events.length / PER_PAGE));
  const page = Number.isSafeInteger(requested) && requested >= 1 ? Math.min(requested, pageCount) : 1;
  const visible = events.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const burnCount = events.filter((e) => e.kind === "burn").length;

  const waiting = toUnits(index.spendable.toString(), quoteDecimals);
  const creatorWaiting = toUnits(index.creatorClaimable.toString(), quoteDecimals);

  return (
    <div className="site-shell">
      <SiteHeader active="indices" />
      <main>
        <section className="section wrap idx-head">
          <Link className="detail-back" href="/indices">← The live set</Link>

          <header className="detail-head">
            <div className="idx-head-id">
              <p className="eyebrow">{burns ? "BUYBACK AND BURN" : "HOLDER REWARDS"}</p>
              <h1>{index.coinSymbol ?? (bound ? shorten(index.coin) : "Not bound yet")}</h1>
              <p className="detail-id">
                <a href={`https://basescan.org/address/${index.address}`} rel="noreferrer" target="_blank">
                  {index.address} ↗
                </a>
              </p>
            </div>
            {/* Paused is a state that changes what this index is doing right now. Whether the fee
                stream could in principle be taken back is not — and when it actually IS taken back,
                `stillCollecting` says so below, in the only terms a holder can act on. */}
            {index.paused && (
              <div className="detail-badges">
                <span className="chip">Paused</span>
              </div>
            )}
          </header>

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

        {/* What it has actually done. */}
        <section className="stats-band" aria-label="What this index has done">
          <div className="stats-inner">
            {/* What this index produces, which is not the same thing in both modes. */}
            <div>
              <span>{burns ? "Burned" : "Paid to holders"}</span>
              <strong>
                {burns
                  ? history?.burnedUsd ? usdCompact(history.burnedUsd) : "—"
                  : history?.paidUsd ? usdCompact(history.paidUsd) : "—"}
              </strong>
              <small>
                {burns
                  ? history?.burnedUnits
                    ? `${fmtShares(history.burnedUnits)} ${index.coinSymbol ?? "coins"} destroyed`
                    : "nothing yet"
                  : history?.paidUnits.length
                    ? history.paidUnits.map((p) => `${amount(p.units)} ${p.symbol}`).join(" · ")
                    : "nothing yet"}
              </small>
            </div>
            {/* "Rounds paid: 0" beside "$60 burned" reads as an index that has done nothing. A
                buyback has no rounds — it has burns, and that is the count worth showing. */}
            <div>
              <span>{burns ? "Burns run" : "Rounds paid"}</span>
              <strong>{history ? (burns ? burnCount : history.rounds) : "—"}</strong>
              <small>
                {burns
                  ? burnCount > 0 ? "supply destroyed each time" : "none yet"
                  : history && history.rounds > 0
                    ? `${history.payments.toLocaleString("en-US")} wallet payments`
                    : "none yet"}
              </small>
            </div>
            <div>
              <span>Fees collected</span>
              <strong>{history?.feesUsd ? usdCompact(history.feesUsd) : "—"}</strong>
              <small>{history?.feesUnits ? `${amount(history.feesUnits)} ${quoteLabel}` : "none yet"}</small>
            </div>
            <div>
              <span>Creator earnings</span>
              <strong>{history?.creatorUsd ? usd(history.creatorUsd) : "—"}</strong>
              <small>
                {index.creatorShareBps > 0
                  ? `${(split.creator / 100).toFixed(0)}% of net fees`
                  : "all of it goes to holders"}
              </small>
            </div>
          </div>
        </section>

        {/* Where it stands right now. */}
        <section className="stats-band" aria-label="Where this index stands">
          <div className="stats-inner">
            <div>
              <span>Waiting to be invested</span>
              <strong>{waiting === null ? "—" : `${amount(waiting)} ${quoteLabel}`}</strong>
              <small>collected, not yet spent</small>
            </div>
            <div>
              <span>Payout round</span>
              <strong>{burns ? "any time" : cadence(index.interval)}</strong>
              <small>{burns ? "the burn is open to anyone" : "at the earliest"}</small>
            </div>
            <div>
              <span>Waiting for the creator</span>
              <strong>{creatorWaiting === null ? "—" : `${amount(creatorWaiting)} ${quoteLabel}`}</strong>
              <small>claimable by them, not spendable</small>
            </div>
            <div>
              <span>To {burns ? "the burn" : "holders"}</span>
              <strong>{(split.holders / 100).toFixed(0)}%</strong>
              <small>{(split.platform / 100).toFixed(0)}% protocol · {(split.creator / 100).toFixed(0)}% creator</small>
            </div>
          </div>
        </section>

        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">{burns ? "WHAT IT BUYS" : "WHAT IT HOLDS"}</p>
            <h2>{burns ? "Its own coin, then destroys it." : `${index.basket.length} ${index.basket.length === 1 ? "name" : "names"}, fixed at creation.`}</h2>
            <p>
              {burns
                ? "Nothing is handed out and no holder list is ever read, which is why the burn below is open to anyone."
                : `Bought by weight, paid out per name. Holders under ${MIN_HOLDER_COINS.toLocaleString("en-US")} coins are skipped and their slice stays with everyone above the line.`}
            </p>
          </div>

          {!burns && index.basket.length > 0 && (
            <div className="idx-table" role="table" aria-label="Composition">
              <div className="idx-row idx-row-head idx-row-holds" role="row">
                <span role="columnheader">Stock</span>
                <span role="columnheader">Weight</span>
                <span role="columnheader">Paid out so far</span>
              </div>
              {index.basket.map((token, i) => {
                const asset = byAddress.get(token.toLowerCase());
                const paid = history?.paidUnits.find((p) => p.token.toLowerCase() === token.toLowerCase());
                return (
                  <div className="idx-row idx-row-holds" key={token} role="row">
                    <span className="idx-coin idx-coin-logo" role="cell">
                      <StockLogo logo={asset?.logo} stock={{ symbol: asset?.symbol ?? shorten(token), domain: asset?.domain }} />
                      <span>
                        <b>{asset?.symbol ?? shorten(token)}</b>
                        <small>{asset?.name ?? token}</small>
                      </span>
                    </span>
                    <span className="idx-num" data-label="Weight" role="cell">
                      <b>{((index.weights[i] ?? 0) / 100).toFixed(0)}%</b>
                    </span>
                    <span className="idx-num" data-label="Paid out so far" role="cell">
                      <b>{paid ? `${amount(paid.units)}` : "—"}</b>
                      {paid && <small>{asset?.symbol ?? ""}</small>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {events.length > 0 && (
          <section className="section wrap hub-section">
            <div className="section-head">
              <p className="eyebrow">EVERYTHING IT HAS DONE</p>
              <h2>{events.length} {events.length === 1 ? "entry" : "entries"}.</h2>
            </div>

            <div className="idx-feed">
              {visible.map((event) => {
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
                    : asset
                      ? 8
                      : null;
                const spent = event.spentRaw ? toUnits(event.spentRaw, quoteDecimals) : null;
                const value = toUnits(event.amountRaw, scale);
                return (
                  <a
                    className={`idx-feed-row${event.kind === "paid" ? " is-paid" : ""}`}
                    href={`https://basescan.org/tx/${event.txHash}`}
                    key={`${event.txHash}-${event.kind}-${event.blockNumber}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span className="idx-kind">
                      {event.kind === "fees"
                        ? "Fees in"
                        : event.kind === "bought"
                          ? "Bought"
                          : event.kind === "burn"
                            ? "Burned"
                            : "Paid out"}
                    </span>
                    <span className="idx-feed-what">
                      <b>
                        {value === null ? "—" : amount(value)}{" "}
                        {event.kind === "fees"
                          ? quoteLabel
                          : isCoin
                            ? index.coinSymbol ?? ""
                            : asset?.symbol ?? ""}
                      </b>
                      {event.holders !== undefined && (
                        <small>to {event.holders.toLocaleString("en-US")} holder{event.holders === 1 ? "" : "s"}</small>
                      )}
                      {/* What the buy cost, so the feed reads as one motion: fee in, equity out. */}
                      {spent !== null && <small>for {amount(spent)} {quoteLabel}</small>}
                    </span>
                    <span className="idx-feed-when">{since(event.timestamp)}</span>
                  </a>
                );
              })}
            </div>

            {pageCount > 1 && (
              <nav aria-label="Activity pages" className="ledger-pager">
                {page > 1 ? (
                  <Link href={`/indices/${index.address}?page=${page - 1}`} rel="prev">← Newer</Link>
                ) : (
                  <span aria-hidden="true">← Newer</span>
                )}
                <b>Page {page} of {pageCount}</b>
                {page < pageCount ? (
                  <Link href={`/indices/${index.address}?page=${page + 1}`} rel="next">Older →</Link>
                ) : (
                  <span aria-hidden="true">Older →</span>
                )}
              </nav>
            )}
          </section>
        )}

        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">CONTRACTS</p>
            <h2>Nothing here is off-chain.</h2>
          </div>
          <div className="idx-addrs">
            {([["Coin", bound ? index.coin : null], ["Index treasury", index.address], ["Fees arrive in", index.quote === "0x0000000000000000000000000000000000000000" ? null : index.quote]] as Array<[string, string | null]>)
              .filter(([, value]) => !!value)
              .map(([label, value]) => (
                <div className="idx-addr" key={label}>
                  <span>{label}</span>
                  <a href={`https://basescan.org/address/${value}`} rel="noreferrer" target="_blank">{value}</a>
                </div>
              ))}
          </div>
        </section>

        <section className="section wrap hub-section">
          <div className="section-head">
            <p className="eyebrow">ANYONE CAN RUN THESE</p>
            <h2>None of them can be pointed anywhere.</h2>
            <p>
              Collecting only moves money in. The burn has one destination. The creator payment goes to
              the creator whoever pays the gas. That is why they are open to everyone.
            </p>
          </div>
          <IndexActions address={index.address} buyback={burns} />
        </section>

        <p className="desk-note wrap" style={{ paddingBottom: "3rem" }}>
          Holders are paid pro-rata on the coin balance they hold when a round runs — there is nothing
          to claim. Wallets under {MIN_HOLDER_COINS.toLocaleString("en-US")} coins are skipped, and
          their slice stays with everyone else instead of going to gas. Stockify keeps{" "}
          {(split.platform / 100).toFixed(0)}% of the fees;{" "}
          {index.creatorShareBps > 0
            ? `the creator keeps ${(split.creator / 100).toFixed(0)}% of what is left.`
            : "the creator keeps nothing — all of the rest goes to holders."}
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
