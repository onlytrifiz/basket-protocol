import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { readAssets } from "../../lib/b20";
import { indexAsset } from "../../lib/index-assets";
import { readVault } from "../../lib/vault";
import { SiteFooter, SiteHeader } from "../components/site-chrome";
import { StockLogo } from "../components/stock-logo";

export const metadata: Metadata = {
  title: "Docs — Stockify",
  description: "How Stockify works: how STFY holders are paid in tokenized stocks, what they receive and when, how indices work, and the contracts behind it.",
};

/**
 * Per request, like every page that reads the vault: the eligibility line and the index list below
 * are the live values, so the docs cannot promise a threshold or a basket the chain no longer has.
 * The reads are cached for 30s, so this costs no extra traffic.
 */
export const dynamic = "force-dynamic";

const contents = [
  ["how", "How it works"],
  ["paid", "Getting paid"],
  ["receive", "What you receive"],
  ["indices", "Indices"],
  ["trading", "Buying & selling"],
  ["faq", "FAQ"],
  ["contracts", "Contracts"],
] as const;

/**
 * Read from the same variables the rest of the site is built against, never written out by hand, so
 * the docs cannot disagree with the panels that actually send transactions to these addresses.
 */
const deployed = [
  ["STFY token", process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS],
  ["Dividend vault", process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS],
  ["Fee hook", process.env.NEXT_PUBLIC_STOCKIFY_HOOK_ADDRESS],
  ["STFY router", process.env.NEXT_PUBLIC_STOCKIFY_ROUTER_ADDRESS],
  ["Index factory", process.env.NEXT_PUBLIC_INDEX_FACTORY],
] as const;

const isAddress = (value?: string) => /^0x[a-fA-F0-9]{40}$/.test(value ?? "");
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const steps = [
  { icon: "/icons/loop-trade.png", title: "Someone trades STFY", copy: "Every buy and sell on the ETH/STFY pool pays a 3% fee in ETH. It goes straight to the dividend vault." },
  { icon: "/icons/loop-acquire.png", title: "The fee buys stocks", copy: "90% of it buys the tokenized stocks in the dividend index, in equal parts. The other 10% is protocol revenue." },
  { icon: "/icons/loop-receive.png", title: "Holders get the stocks", copy: "The stocks are sent to every eligible STFY wallet, in proportion to its balance. Nothing to claim, nothing to stake." },
] as const;

const faq = [
  ["Do I need to claim anything?", "No. Payouts are sent straight to your wallet. You only need to hold enough STFY in a wallet you control."],
  ["When do payouts happen?", "At most once an hour, and only when there is at least $100 of stock to share. Small amounts roll into the next payout instead of being spread as dust."],
  ["Why didn't I receive anything?", "Check that your wallet held at least the minimum STFY when the payout started and still held it when it was sent. STFY held on an exchange or inside a liquidity pool is not counted. You can look up any wallet on the Dividends page."],
  ["Can I sell the stocks I receive?", "Yes. They are ordinary tokens in your wallet. Tokenized stocks can carry their own transfer rules set by their issuer, which the trade panel checks before it offers a trade."],
  ["Is there an APY?", "No. What you receive depends on how much STFY trades. The Dividends page shows everything that has actually been paid, cycle by cycle."],
  ["Can the index change?", "Yes, between payouts. Anything the vault has ever bought keeps being paid out, so a change never strands stock that was already acquired."],
] as const;

export default async function DocsPage() {
  const [vault, assets] = await Promise.all([readVault(), readAssets().catch(() => [])]);
  const byAddress = new Map(assets.map((a) => [a.address.toLowerCase(), a]));
  const minStfy = vault.minShareBalanceRaw ? Number(BigInt(vault.minShareBalanceRaw) / 10n ** 18n) : null;
  const live = deployed.filter(([, address]) => isAddress(address)) as Array<readonly [string, string]>;
  const holdings = vault.holdings.map((h) => {
    const asset = byAddress.get(h.address.toLowerCase());
    const extra = indexAsset(h.address);
    return { ...h, logo: asset?.logo ?? extra?.logo, domain: asset?.domain, symbol: asset?.symbol ?? h.symbol, name: h.name };
  });

  return (
    <div className="site-shell">
      <SiteHeader active="docs" />
      <main>
        <section className="page-intro wrap docs-intro">
          <p className="eyebrow">DOCS</p>
          <h1>How Stockify<br /><em>pays you.</em></h1>
          <p>
            Hold STFY and receive tokenized stocks, sent straight to your wallet. This page explains where they come
            from, who gets them and when.
          </p>
          <div className="docs-status-row" aria-label="At a glance">
            <span>3% trading fee</span><span>90% buys stocks</span><span>No claiming</span><span>On Base</span>
          </div>
        </section>

        <section className="docs-layout wrap">
          <aside className="docs-nav" aria-label="Documentation sections">
            <span>ON THIS PAGE</span>
            {contents.map(([id, title], index) => <a href={`#${id}`} key={id}><b>{String(index + 1).padStart(2, "0")}</b>{title}</a>)}
          </aside>

          <div className="docs-reference">
            <section className="docs-section" id="how">
              <div className="docs-section-label"><span>01</span><p>How it works</p></div>
              <div className="docs-section-body">
                <h2>Trading fees become stocks in your wallet.</h2>
                <ol className="docs-steps">
                  {steps.map((step, i) => (
                    <li key={step.title}>
                      <Image alt="" height={72} src={step.icon} width={72} />
                      <span className="docs-step-n">{String(i + 1).padStart(2, "0")}</span>
                      <h3>{step.title}</h3>
                      <p>{step.copy}</p>
                    </li>
                  ))}
                </ol>
                <div className="docs-table-wrap">
                  <table>
                    <caption>Where the 3% fee on every STFY trade goes</caption>
                    <thead><tr><th>Fee</th><th>Rate</th><th>Goes to</th></tr></thead>
                    <tbody>
                      <tr><td>Stocks for holders</td><td>2.70%</td><td>Buys the dividend index, paid out to STFY holders.</td></tr>
                      <tr><td>Protocol</td><td>0.30%</td><td>Protocol revenue.</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="docs-section" id="paid">
              <div className="docs-section-label"><span>02</span><p>Getting paid</p></div>
              <div className="docs-section-body">
                <h2>Hold the minimum, and the rest is automatic.</h2>
                <div className="docs-split-grid">
                  <article>
                    <span>Who</span>
                    <h3>{minStfy ? `${minStfy.toLocaleString("en-US")} STFY or more` : "Wallets over the minimum"}</h3>
                    <p>Any wallet holding at least the minimum is counted. The minimum can only ever be set between 10,000 and 100,000 STFY.</p>
                  </article>
                  <article>
                    <span>How much</span>
                    <h3>Your share of eligible STFY</h3>
                    <p>Each payout is split pro-rata: hold 1% of the eligible STFY and you receive 1% of every stock in that payout.</p>
                  </article>
                  <article>
                    <span>When</span>
                    <h3>Up to once an hour</h3>
                    <p>A payout runs when at least $100 of stock is waiting. Anything less waits for the next one, so it is never lost.</p>
                  </article>
                </div>
                <div className="docs-formula"><span>Your payout</span><code>stocks in the payout × your STFY ÷ all eligible STFY</code></div>
                <p className="docs-note">
                  <strong>Selling during a payout lowers it.</strong> Your share is counted from your balance when the payout
                  starts, but never more than what you still hold when it reaches your wallet.
                </p>
                <p className="docs-note">
                  <strong>Exchanges and pools are left out.</strong> STFY sitting in a liquidity pool, a router or other
                  infrastructure contract is not counted, so its share goes to real holders.
                </p>
              </div>
            </section>

            <section className="docs-section" id="receive">
              <div className="docs-section-label"><span>03</span><p>What you receive</p></div>
              <div className="docs-section-body">
                <h2>The dividend index.</h2>
                <p>
                  Payouts are made in the assets the vault buys. Today that is {holdings.length > 0 ? `${holdings.length} assets` : "the assets below"},
                  bought in the weights shown. Most are B20 tokenized stocks on Base: real-world shares issued as tokens.
                </p>
                {holdings.length > 0 && (
                  <ul className="docs-holdings">
                    {holdings.map((h) => (
                      <li key={h.address}>
                        <StockLogo logo={h.logo} stock={{ symbol: h.symbol, domain: h.domain }} />
                        <span><b>{h.symbol}</b><small>{h.name}</small></span>
                        <em>{(h.weightBps / 100).toFixed(0)}%</em>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="docs-note">
                  <strong>The index can change.</strong> The weights and assets can be updated between payouts. Anything the
                  vault has ever bought keeps being paid out, so a change never leaves stock behind.
                </p>
              </div>
            </section>

            <section className="docs-section" id="indices">
              <div className="docs-section-label"><span>04</span><p>Indices</p></div>
              <div className="docs-section-body">
                <h2>Launches that pay their holders.</h2>
                <p>
                  A coin launched on The Stonks Exchange can send its creator fees to an index instead of a wallet; it is set
                  up there, at launch. The index then does one of two things with every fee, for good.
                </p>
                <div className="docs-split-grid docs-split-2">
                  <article><span>Holder rewards</span><h3>Buy stocks, pay holders</h3><p>Fees buy the chosen stocks and send them to the coin&apos;s holders, pro-rata. Wallets under 10,000 coins are skipped.</p></article>
                  <article><span>Buyback and burn</span><h3>Buy the coin, burn it</h3><p>Fees buy the coin back and destroy it, shrinking the supply.</p></article>
                </div>
                <div className="docs-formula"><span>Split of every fee</span><code>10% protocol → creator&apos;s share → the rest to holders or the burn</code></div>
                <Link className="docs-inline-cta" href="/indices">Browse indices <span>→</span></Link>
              </div>
            </section>

            <section className="docs-section" id="trading">
              <div className="docs-section-label"><span>05</span><p>Buying &amp; selling</p></div>
              <div className="docs-section-body">
                <h2>Trade STFY right here.</h2>
                <div className="docs-split-grid">
                  <article><span>STFY</span><h3>One pool, on Uniswap</h3><p>STFY trades in a single ETH/STFY pool on Uniswap v4. The swap panel on the home page trades it directly. Every trade pays the 3% fee that funds the payouts.</p></article>
                  <article><span>Slippage</span><h3>Set a bit higher than usual</h3><p>The 3% fee is taken on the way through, which is why the panel&apos;s slippage presets start higher than a normal swap.</p></article>
                  <article><span>Stocks</span><h3>Trade them on Stocks</h3><p>The tokenized stocks you receive can be bought and sold from the Stocks page, routed through an aggregator for the best price.</p></article>
                </div>
              </div>
            </section>

            <section className="docs-section" id="faq">
              <div className="docs-section-label"><span>06</span><p>FAQ</p></div>
              <div className="docs-section-body">
                <h2>Common questions.</h2>
                <div className="docs-faq">
                  {faq.map(([q, a]) => (
                    <details key={q}>
                      <summary>{q}</summary>
                      <p>{a}</p>
                    </details>
                  ))}
                </div>
              </div>
            </section>

            <section className="docs-section" id="contracts">
              <div className="docs-section-label"><span>07</span><p>Contracts</p></div>
              <div className="docs-section-body">
                <h2>The contracts, on Base.</h2>
                <ul className="docs-addresses">
                  {live.map(([label, address]) => (
                    <li key={label}>
                      <span>{label}</span>
                      <a href={`https://basescan.org/address/${address}`} rel="noreferrer" target="_blank" title={address}>
                        <code className="docs-addr-full">{address}</code>
                        <code className="docs-addr-short">{short(address)}</code> ↗
                      </a>
                    </li>
                  ))}
                </ul>
                <div className="docs-callout">
                  <p className="eyebrow">SEE IT FOR YOURSELF</p>
                  <h2>Every payout, cycle by cycle.</h2>
                  <p>The Dividends page lists every payout the vault has made, and can show what any wallet has received.</p>
                  <Link className="button button-ink" href="/dividends">Open Dividends <span>→</span></Link>
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
