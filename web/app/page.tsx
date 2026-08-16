import Link from "next/link";
import { BasketUniverse } from "./components/basket-universe";
import { SiteFooter, SiteHeader } from "./components/site-chrome";
import { StockGrid } from "./components/stock-grid";

const mechanics = [
  ["01", "Trade BASKET", "The ETH / BASKET v4 market is designed to collect a 3% hook fee on trading."],
  ["02", "Acquire the basket", "A keeper routes 90% of each collected hook fee into the active Base B20 equity basket."],
  ["03", "Receive the stocks", "The dividend vault pushes each acquired asset pro-rata to eligible BASKET holders."],
];

export default function Home() {
  return (
    <div className="site-shell">
      <SiteHeader active="overview" />
      <main>
        <header className="hero-card" id="overview">
          <div className="hero-inner">
            <div className="hero-copy">
              <p className="eyebrow">BASE · B20 EQUITY DIVIDENDS</p>
              <h1>Hold Basket.<br /><span>Receive stocks.</span></h1>
              <p className="hero-lede">Basket routes trading fees into Base-native tokenized equities, then distributes the acquired assets to qualifying BASKET holders.</p>
              <div className="hero-actions"><Link className="button button-ink" href="/distributions">View distributions <span>→</span></Link><Link className="button button-ghost" href="/protocol">Read the protocol</Link></div>
              <p className="hero-note"><i /> 3% trading fee · 90% allocated to stocks · push payouts</p>
            </div>
            <BasketUniverse />
          </div>
        </header>

        <section className="stats-band" aria-label="Protocol economics"><div className="stats-inner">
          <div><span>Hook fee</span><strong>3%</strong><small>on BASKET trades</small></div>
          <div><span>Stock allocation</span><strong>90%</strong><small>of hook fee</small></div>
          <div><span>LP fee</span><strong>1%</strong><small>to v4 liquidity providers</small></div>
          <div><span>Initial supply</span><strong>1B</strong><small>BASKET fixed supply</small></div>
        </div></section>

        <section className="section wrap" id="how"><div className="section-head"><p className="eyebrow">THE DIVIDEND LOOP</p><h2>A stock dividend that starts with volume.</h2><p>Basket does not reflect another token into your wallet. The vault acquires the B20 assets themselves and pushes the resulting entitlement to holders.</p></div><div className="steps-grid">{mechanics.map(([number, title, copy]) => <article className="step-card" key={number}><span>{number}</span><h3>{title}</h3><p>{copy}</p></article>)}</div></section>

        <section className="thesis-card"><div className="thesis-inner"><div><p className="eyebrow eyebrow-light">DESIGNED FOR DIRECT OWNERSHIP</p><h2>The fee buys assets.<br /><em>The assets leave the vault.</em></h2><p>Each completed cycle is intended to be readable on-chain: fee proceeds arrive, the keeper executes acquisitions, then the dividend vault transfers the B20 assets to eligible holders.</p><Link className="button button-lime" href="/protocol">How operations work <span>→</span></Link></div><div className="thesis-viz"><div className="viz-top"><span>DISTRIBUTION PATH</span><b>PRE-LAUNCH</b></div><svg viewBox="0 0 420 206" role="img" aria-label="Illustration of trading fees becoming a stock distribution"><path d="M19 160 C77 114 93 165 137 129 S212 114 248 91 S318 119 398 48" fill="none" stroke="rgba(255,255,255,.8)" strokeWidth="2" strokeLinecap="round"/><path d="M19 172 L92 172 L92 150 L174 150 L174 125 L250 125 L250 98 L332 98 L332 67 L401 67" fill="none" stroke="#91d4ff" strokeWidth="3"/><circle cx="92" cy="150" r="5" fill="#91d4ff"/><circle cx="174" cy="125" r="5" fill="#91d4ff"/><circle cx="250" cy="98" r="5" fill="#91d4ff"/><circle cx="332" cy="67" r="5" fill="#91d4ff"/></svg><div className="viz-caption"><span>Trade fee</span><span>Stock acquisition</span><span>Holder payout</span></div></div></div></section>

        <section className="section wrap" id="basket"><div className="section-head basket-head"><div><p className="eyebrow">INITIAL EQUITY UNIVERSE</p><h2>Thirteen stocks, native to Base.</h2></div><p>The initial active basket can be updated between cycles. Assets already purchased stay available for their subsequent distribution.</p></div><StockGrid compact /><div className="section-end"><p>Each asset is a Base B20 token. Prices are reference data, not live market quotes.</p><Link href="/protocol#basket">Basket policy <span>→</span></Link></div></section>

        <section className="section wrap launch-note"><div><p className="eyebrow">PRE-LAUNCH STATUS</p><h2>Ready for a market,<br />not pretending to have one.</h2></div><div className="launch-rows"><div><span>01</span><p><strong>Contracts</strong>Token, hook and dividend-vault addresses are pending final deployment setup.</p><small>Pending</small></div><div><span>02</span><p><strong>Liquidity</strong>The v4 pool is intentionally not initialized before its price and liquidity parameters are decided.</p><small>Pending</small></div><div><span>03</span><p><strong>Distributions</strong>Completed cycles will become an auditable history on the distribution desk.</p><Link href="/distributions">Preview →</Link></div></div></section>
      </main>
      <SiteFooter />
    </div>
  );
}
