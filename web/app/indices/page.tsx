import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../lib/b20";
import {
  LAUNCHPAD,
  MIN_BUY_ETH,
  MIN_HOLDER_COINS,
  indicesLive,
  readIndexRows,
  readPlatformFeeBps,
} from "../../lib/indices";
import { BrandRender } from "../components/brand-render";
import { RingMarker } from "../components/segment-ring";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { IndexStats } from "../components/index-stats";
import { IndexTable } from "../components/index-table";

export const metadata: Metadata = {
  title: "Indices — Stockify",
  description:
    "Point a launch's creator fees at an index: it buys tokenized equity and pushes it to the coin's holders, or buys the coin back and burns it.",
};

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

/** The overview leads with the three biggest payers; the rest live on their own page. */
const FEATURED = 3;

export default async function IndicesPage() {
  const [{ rows, totals }, platformBps, assets] = await Promise.all([
    readIndexRows(),
    readPlatformFeeBps(),
    readAssets(),
  ]);
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const featured = rows.slice(0, FEATURED);

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
            <div className="hub-head-cta">
              <Link className="button button-ink" href="/indices/create">
                Create an index <span>→</span>
              </Link>
              <a className="button button-ghost" href="#live">See the live ones</a>
            </div>
          </div>
          <BrandRender className="hub-render" priority size={340} src="/baskets.png" />
        </header>

        <IndexStats totals={totals} />

        <section className="section wrap hub-section" id="live">
          <div className="section-head">
            <p className="eyebrow">THE LIVE SET</p>
            <h2>
              {totals.count === 0
                ? "Nothing has pointed its fees here yet."
                : totals.count <= FEATURED
                  ? `${totals.count} ${totals.count === 1 ? "index" : "indices"} running.`
                  : `The ${FEATURED} biggest payers.`}
            </h2>
            <p>
              What each one holds, what it has handed to holders, and how often it has done it.
              Ordered by what has actually reached people. Made here, or inside a launch on{" "}
              <a href={LAUNCHPAD.url} rel="noreferrer" target="_blank">{LAUNCHPAD.name} ↗</a>; an index
              does not care which launchpad its coin came from.
            </p>
          </div>

          {featured.length > 0 ? (
            <>
              <IndexTable assets={byAddress} rows={featured} />
              {totals.count > FEATURED && (
                <div className="idx-more-row">
                  <Link className="button button-ghost" href="/indices/all">
                    All {totals.count} indices <span>→</span>
                  </Link>
                </div>
              )}
            </>
          ) : (
            <p className="detail-empty">
              {indicesLive
                ? "The first index appears here the moment a launch points its fees at one. Yours could be it."
                : "The index factory is not deployed on this network, so there is nothing to show."}
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
            <h2>Five questions, one transaction.</h2>
            <p className="page-cta-note">
              Then point your coin&apos;s creator fees at it — from{" "}
              <a href={LAUNCHPAD.url} rel="noreferrer" target="_blank">{LAUNCHPAD.name}</a>&apos;s launch
              form, or any launchpad this service supports.
            </p>
          </div>
          <Link className="button button-ink" href="/indices/create">
            Create an index <span>→</span>
          </Link>
        </section>

      </main>
      <SiteFooter />
    </div>
  );
}
