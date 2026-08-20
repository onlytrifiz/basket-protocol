import type { Metadata } from "next";
import Link from "next/link";

import { stocks } from "../../../lib/stocks";
import { LAUNCHPAD, readPlatformFeeBps } from "../../../lib/indices";
import { IndexBuilder } from "../../components/index-builder";
import { SiteFooter, SiteHeader } from "../../components/site-chrome";

export const metadata: Metadata = {
  title: "Create an index — Stockify",
  description:
    "Build the treasury that turns your launch's creator fees into equity for your holders, or into a burn.",
};

export const revalidate = 300;

export default async function CreateIndexPage() {
  const platformBps = await readPlatformFeeBps();

  return (
    <div className="site-shell">
      <SiteHeader active="indices" />
      <main>
        <header className="section wrap builder-head">
          <p className="eyebrow">CREATE AN INDEX</p>
          <h1>Five questions.</h1>
          <p className="hub-lede">
            What the fees buy, who they pay, and how often. The address comes out at the end and is
            real before anything is deployed — so you can name it in a launch you have not made yet.
          </p>
          <p className="builder-agnostic">
            An index does not care which launchpad your coin came from. Today that is{" "}
            <a href={LAUNCHPAD.url} rel="noreferrer" target="_blank">{LAUNCHPAD.name}</a>; a second
            one is a registry entry, not a new contract and not a new page.
          </p>
        </header>

        <section className="section wrap">
          <IndexBuilder platformBps={platformBps} stocks={stocks} />
        </section>

        <section className="page-cta wrap">
          <div>
            <p className="eyebrow">ALREADY MADE ONE?</p>
            <h2>See what it holds.</h2>
          </div>
          <Link className="button button-ink" href="/indices">
            The live set <span>→</span>
          </Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
