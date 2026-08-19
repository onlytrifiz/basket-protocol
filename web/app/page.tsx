import Image from "next/image";
import Link from "next/link";

import { readVault } from "../lib/vault";
import { IndexUniverse } from "./components/index-universe";
import { RingMarker } from "./components/segment-ring";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { StockGrid } from "./components/stock-grid";
import { SwapPanel } from "./components/swap-panel";

/* `filled` advances the ring across the loop; only the final step is a payout,
   so it is the only one allowed to light a segment lime. */
const mechanics = [
  { number: "01", filled: 3, lit: false, title: "Trade STFY", copy: "The ETH / STFY v4 market is designed to collect a 3% hook fee on trading." },
  { number: "02", filled: 6, lit: false, title: "Acquire the index", copy: "A keeper routes 90% of each collected hook fee into the active Base B20 equity index." },
  { number: "03", filled: 8, lit: true, title: "Receive the stocks", copy: "The dividend vault pushes each acquired asset pro-rata to eligible STFY holders." },
];

export default async function Home() {
  // The same read /distributions makes. A homepage claiming a different index from the page that
  // shows the vault would be two answers to one question.
  const vault = await readVault();
  const slices = vault.holdings.map((h) => ({ symbol: h.symbol, name: h.name, weightBps: h.weightBps }));

  return (
    <div className="site-shell">
      <SiteHeader active="overview" />
      <main>
        <header className="hero-card" id="overview">
          <div className="hero-inner">
            <div className="hero-copy">
              <p className="eyebrow">BASE · B20 EQUITY DIVIDENDS</p>
              <h1>Hold Stockify.<br /><span>Receive stocks.</span></h1>
              <p className="hero-lede">Stockify routes trading fees into Base-native tokenized equities, then distributes the acquired assets to qualifying STFY holders.</p>
              <div className="hero-actions"><Link className="button button-ink" href="/distributions">View distributions <span>→</span></Link><Link className="button button-ghost" href="/docs">Read the docs</Link></div>
              <p className="hero-note"><i /> 3% trading fee · 90% allocated to stocks · push payouts</p>
            </div>
            <div className="hero-swap"><SwapPanel /></div>
          </div>
          <div className="flow-strip">
            <Image alt="" fill priority sizes="100vw" src="/header-transparent.png" />
            <div className="flow-strip-labels">
              <div><span>Fees in</span><strong>3% hook fee</strong></div>
              <div className="flow-strip-out"><span>Stocks out</span><strong>B20 stocks to holders</strong></div>
            </div>
          </div>
        </header>

        <section className="stats-band" aria-label="Protocol economics"><div className="stats-inner">
          <div><span>Hook fee</span><strong>3%</strong><small>on STFY trades</small></div>
          <div><span>Stock allocation</span><strong>90%</strong><small>of hook fee</small></div>
          <div><span>LP fee</span><strong>1%</strong><small>to v4 liquidity providers</small></div>
          <div><span>Initial supply</span><strong>1B</strong><small>STFY fixed supply</small></div>
        </div></section>

        <section className="section wrap" id="how"><div className="section-head"><p className="eyebrow">THE DIVIDEND LOOP</p><h2>A stock dividend that starts with volume.</h2><p>Stockify does not reflect another token into your wallet. The vault acquires the B20 assets themselves and pushes the resulting entitlement to holders.</p></div><div className="steps-grid">{mechanics.map((step) => <article className="step-card" key={step.number}><RingMarker filled={step.filled} label={step.number} lit={step.lit} /><h3>{step.title}</h3><p>{step.copy}</p></article>)}</div></section>

        <section className="section wrap" id="index"><div className="index-showcase"><div className="section-head index-head"><div><p className="eyebrow">THE EQUITY UNIVERSE</p><h2>Thirteen listed. Four in the index.</h2></div><p>Every B20 equity Coinbase has issued on Base. The dividend vault buys a configurable subset of them, and the index can change between cycles.</p></div><IndexUniverse slices={slices} /></div><StockGrid compact /><div className="universe-cta">
            <p>Thirteen are listed on Base; the dividend vault currently buys four of them. Both sets are read from the chain, not from this page.</p>
            <div className="universe-cta-actions">
              <Link className="button button-ink" href="/stocks">Browse every stock <span>→</span></Link>
              <Link className="button button-ghost" href="/distributions">See what the vault buys <span>→</span></Link>
            </div>
          </div></section>
      </main>
      <SiteFooter />
    </div>
  );
}
