import type { Metadata } from "next";
import Link from "next/link";
import { BrandRender } from "../components/brand-render";
import { RingMarker, SegmentRing } from "../components/segment-ring";
import { SiteFooter, SiteHeader } from "../components/site-chrome";

export const metadata: Metadata = { title: "Distributions — Stockify", description: "Distribution history and payout mechanics for Stockify." };

/* The sequence closes when assets reach holders — the one lime-lit step. */
const phases = [
  { number: "01", filled: 2, lit: false, title: "Fees arrive", copy: "The v4 hook sends its ETH trading fee to the dividend vault." },
  { number: "02", filled: 4, lit: false, title: "Stocks are bought", copy: "The keeper carries out the index acquisition transactions." },
  { number: "03", filled: 6, lit: false, title: "Holders are counted", copy: "Eligible holders are enumerated from the on-chain STFY holder registry." },
  { number: "04", filled: 8, lit: true, title: "Assets are sent", copy: "The vault pushes each B20 entitlement to every eligible holder in batches." },
];

export default function DistributionsPage() {
  return <div className="site-shell"><SiteHeader active="distributions" /><main>
    <section className="page-intro wrap"><BrandRender className="page-intro-render" priority size={148} src="/logo.png" /><p className="eyebrow">DIVIDEND DESK</p><h1>See the assets<br /><em>leave the vault.</em></h1><p>When Stockify launches, this page will be the factual record of every stock purchase and direct holder payout — not a projection or yield counter.</p></section>
    <section className="desk-panel"><div className="desk-inner"><div className="desk-head"><div><p>SETTLED DISTRIBUTIONS</p><h2>No cycles yet.</h2></div><div className="desk-cycle"><SegmentRing filled={1} lit motion="sweep" size={46} stroke={9} /><div className="desk-cycle-meta"><span>Cycle</span><b>—</b></div><span className="waiting-chip"><i /> Awaiting launch</span></div></div><div className="desk-metrics"><div><span>Completed cycles</span><strong>0</strong><small>History begins at launch</small></div><div><span>Assets distributed</span><strong>—</strong><small>B20 routes pending</small></div><div><span>Current threshold</span><strong>100K</strong><small>STFY initially</small></div><div><span>Next cycle</span><strong>—</strong><small>No market yet</small></div></div><div className="distribution-table"><div className="table-head"><span>Cycle</span><span>Assets acquired</span><span>Eligible holders</span><span>Payout</span></div><div className="table-empty"><span>—</span><span>Distribution history appears after the first settlement.</span><span>—</span><span>—</span></div></div><p className="desk-note">All values above are intentionally pre-launch. Once live, cycle transactions and the assets distributed will be listed here.</p></div></section>
    <section className="section wrap"><div className="section-head"><p className="eyebrow">THE PAYOUT SEQUENCE</p><h2>Four steps. No claim button.</h2><p>Stockify uses a push distribution: the keeper executes settlement, while the dividend vault transfers stocks to qualifying holders directly.</p></div><div className="payout-list">{phases.map((phase) => <article className={phase.lit ? "is-payout" : undefined} key={phase.number}><RingMarker filled={phase.filled} label={phase.number} lit={phase.lit} /><div><h3>{phase.title}</h3><p>{phase.copy}</p></div><b>↗</b></article>)}</div></section>
    <section className="eligibility wrap"><div><p className="eyebrow">ELIGIBILITY</p><h2>Start with<br />100,000 STFY.</h2><p>The initial minimum balance for rewards is 100,000 STFY. Ownership can set it from 10,000 to 100,000 STFY and exclude selected addresses from rewards.</p></div><dl><div><dt>Allocation</dt><dd>90% of each hook fee</dd></div><div><dt>Asset type</dt><dd>Direct B20 token transfers</dd></div><div><dt>Cadence target</dt><dd>Approximately hourly</dd></div><div><dt>Settlement</dt><dd>Keeper-executed, on-chain</dd></div></dl></section>
    <section className="page-cta wrap"><div><p className="eyebrow">NEXT</p><h2>Read the operating model.</h2></div><Link className="button button-ink" href="/protocol">Protocol notes <span>→</span></Link></section>
  </main><SiteFooter /></div>;
}
