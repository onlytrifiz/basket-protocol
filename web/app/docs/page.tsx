import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../components/site-chrome";

export const metadata: Metadata = {
  title: "Documentation — Basket",
  description: "A practical introduction to Basket, its markets and its stock dividend cycles.",
};

const sections = [
  { id: "markets", number: "01", title: "Markets", copy: "BASKET is intended to trade against ETH in a Uniswap v4 pool with a custom fee hook. Base B20 stocks are bought through compatible v4 routes." },
  { id: "cycle", number: "02", title: "Dividend cycle", copy: "Trading fees reach the dividend vault. The keeper acquires the active basket and distributes the resulting B20 balances to eligible holders." },
  { id: "eligibility", number: "03", title: "Eligibility", copy: "The minimum BASKET balance begins at 100,000 and can be configured by ownership between 10,000 and 100,000. Selected addresses can be excluded." },
  { id: "roles", number: "04", title: "Operational roles", copy: "The keeper performs purchases and payout batches. Ownership controls the basket and safety parameters; those operational dependencies are disclosed, not hidden." },
];

export default function DocsPage() {
  return (
    <div className="site-shell"><SiteHeader active="docs" /><main>
      <section className="page-intro wrap"><p className="eyebrow">DOCUMENTATION / 01</p><h1>The practical<br /><em>Basket primer.</em></h1><p>Read how markets, B20 stock acquisition and direct dividends fit together before a live BASKET market opens.</p></section>
      <section className="docs-layout wrap">
        <aside className="docs-nav" aria-label="Documentation sections"><span>ON THIS PAGE</span><a href="#markets">Markets</a><a href="#cycle">Dividend cycle</a><a href="#eligibility">Eligibility</a><a href="#roles">Operational roles</a></aside>
        <div className="docs-content">
          {sections.map((section) => <article id={section.id} key={section.id}><span>{section.number}</span><div><h2>{section.title}</h2><p>{section.copy}</p></div></article>)}
          <div className="docs-callout"><p className="eyebrow">STARTING POINT</p><h2>No invented yield.</h2><p>Pre-launch screens intentionally show no performance figures. Once trading starts, distribution data will be published as completed cycles and on-chain transactions.</p><Link className="button button-ink" href="/distributions">Distribution desk <span>→</span></Link></div>
        </div>
      </section>
    </main><SiteFooter /></div>
  );
}
