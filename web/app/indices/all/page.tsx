import type { Metadata } from "next";
import Link from "next/link";

import { readAssets } from "../../../lib/b20";
import { LAUNCHPAD, indicesLive, readIndexRows } from "../../../lib/indices";
import { IndexStats } from "../../components/index-stats";
import { IndexTable } from "../../components/index-table";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";

export const metadata: Metadata = {
  title: "Every index — Stockify",
  description:
    "Every coin paying its creator fees out to its holders as tokenized equity: what each index holds, what it has paid, and how often.",
};

export const revalidate = 60;

/**
 * The whole set, where the overview shows three.
 *
 * Same table, same order, no cut — the overview is a window onto this page rather than a different
 * view of the same thing, which is why both render `IndexTable` and neither owns a row's markup.
 */
export default async function AllIndicesPage() {
  const [{ rows, totals }, assets] = await Promise.all([readIndexRows(), readAssets()]);
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));

  return (
    <div className="site-shell">
      <SiteHeader active="indices" />
      <main>
        <section className="section wrap">
          <Link className="detail-back" href="/indices">← Indices</Link>
          <div className="section-head" style={{ marginTop: "14px" }}>
            <p className="eyebrow">EVERY INDEX</p>
            <h1>
              {totals.count === 0
                ? "No index is running yet."
                : `${totals.count} ${totals.count === 1 ? "coin pays" : "coins pay"} their holders.`}
            </h1>
            <p>
              Each one turns its launch&apos;s creator fees into tokenized equity and pushes it out, or
              buys the coin back and destroys it. Biggest payer first. Open one to see what it holds
              and when it next pays.
            </p>
          </div>
        </section>

        <IndexStats totals={totals} />

        <section className="section wrap hub-section">
          {rows.length > 0 ? (
            <IndexTable assets={byAddress} rows={rows} />
          ) : (
            <p className="detail-empty">
              {indicesLive ? (
                <>
                  Nobody has pointed a launch here yet.{" "}
                  <Link href="/indices/create">Yours would be the first.</Link>
                </>
              ) : (
                "The index factory is not deployed on this network, so there is nothing to show."
              )}
            </p>
          )}
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
