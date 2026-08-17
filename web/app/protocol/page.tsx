import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockGrid } from "../components/stock-grid";

export const metadata: Metadata = { title: "Protocol — Stockify", description: "Architecture and initial parameters for Stockify on Base." };

const roles = [["STFY", "The 1B fixed-supply ERC-20 that maintains an on-chain registry of potential payout holders."], ["FEE HOOK", "A v4 hook that routes the 3% STFY trading fee, in ETH, to the dividend vault."], ["DIVIDEND VAULT", "The contract that accounts for each cycle and pushes acquired B20 stocks to eligible holders."], ["KEEPER", "The operational address that executes purchases and distribution batches."]];

export default function ProtocolPage() {
  return <div className="site-shell"><SiteHeader active="protocol" /><main>
    <section className="page-intro wrap"><p className="eyebrow">PROTOCOL NOTES / 01</p><h1>Built to send<br /><em>stocks, not points.</em></h1><p>Stockify connects a Uniswap v4 trading fee to a configurable Base B20 equity index, then sends acquired assets to eligible STFY holders.</p></section>
    <section className="section wrap"><div className="section-head"><p className="eyebrow">ARCHITECTURE</p><h2>One fee path.<br />Four roles.</h2><p>The contracts separate collection, stock acquisition and payout accounting so each completed distribution has a clear on-chain record.</p></div><div className="roles-grid">{roles.map(([title, copy], index) => <article key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
    <section className="parameters"><div className="parameters-inner"><div><p className="eyebrow">INITIAL PARAMETERS</p><h2>The numbers<br />at launch.</h2></div><dl><div><dt>Token supply</dt><dd>1,000,000,000 STFY</dd></div><div><dt>Pool fee</dt><dd>1.00% to LPs</dd></div><div><dt>Hook fee</dt><dd>3.00% in ETH</dd></div><div><dt>Stock allocation</dt><dd>90% of hook fee / 2.70% of volume</dd></div><div><dt>Protocol allocation</dt><dd>10% of hook fee / 0.30% of volume</dd></div><div><dt>Reward threshold</dt><dd>100K initially; adjustable from 10K–100K</dd></div></dl></div></section>
    <section className="section wrap" id="index"><div className="section-head"><p className="eyebrow">STFY POLICY</p><h2>The starting universe.</h2><p>The active acquisition index is owner-configurable between cycles. Assets already bought remain in the distribution universe so they can still be pushed to holders.</p></div><StockGrid /></section>
    <section className="operation-card"><div className="operation-inner"><div><p className="eyebrow eyebrow-light">OPERATING MODEL</p><h2>Explicit about<br /><em>what is operated.</em></h2></div><div><p>Acquired B20 assets are retained by the dividend vault and payouts are carried out on-chain. A keeper executes stock purchases and batches; protocol ownership can update selected parameters and the active index between cycles.</p><p>Those roles are an operational dependency, not a claim of trustless automation. Deployed addresses and operating policy belong here before a live market opens.</p><Link className="button button-lime" href="/distributions">Distribution model <span>→</span></Link></div></div></section>
  </main><SiteFooter /></div>;
}
