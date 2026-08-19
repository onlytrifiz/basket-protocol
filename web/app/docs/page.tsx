import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../components/site-chrome";

export const metadata: Metadata = {
  title: "Protocol documentation — Stockify",
  description: "Public protocol reference for Stockify's token, v4 fee hook, dividend vault and dividend cycle on Base.",
};

const contents = [
  ["overview", "System overview"],
  ["contracts", "Contract reference"],
  ["cycle", "Distribution cycle"],
  ["eligibility", "Eligibility & accounting"],
  ["operations", "Roles & controls"],
  ["market", "Trading & liquidity"],
  ["launch", "Deployment status"],
] as const;

const contractRows = [
  {
    name: "StockifyToken",
    file: "src/StockifyToken.sol",
    description: "Fixed-supply STFY ERC-20. Maintains the enumerable holder registry used by the vault; it does not ask an indexer or explorer for recipients.",
    facts: ["1,000,000,000 STFY fixed supply", "10,000–100,000 STFY eligibility range", "O(1) holder removal with swap-and-pop"],
  },
  {
    name: "StockifyFeeHook",
    file: "src/StockifyFeeHook.sol",
    description: "The Uniswap v4 hook attached to the intended ETH/STFY pool. It takes 300 bps in native ETH and settles it directly to the vault.",
    facts: ["300 bps hook fee", "ETH must be currency0", "CREATE2 address mined for v4 flags"],
  },
  {
    name: "DividendVault",
    file: "src/DividendVault.sol",
    description: "Holds hook ETH and acquired B20 balances, tracks protocol revenue, snapshots eligible holders and pushes dividends in batches.",
    facts: ["1 hour minimum between cycle starts", "90% stock budget / 10% protocol revenue", "No native-ETH emergency withdrawal"],
  },
  {
    name: "Keeper",
    file: "keeper/src/keeper.ts",
    description: "Off-chain executor for quotes, buy transactions and payout batches. It reads the recipient set from contracts; it never uploads a holder list.",
    facts: ["Base chain ID 8453", "250 default snapshot batch", "25 default payout batch"],
  },
] as const;

const cycleSteps = [
  {
    number: "01",
    call: "buyStocks(minOuts, routerCalldatas)",
    actor: "Keeper",
    copy: "Uses available native ETH, retains 10% in platformClaimable and divides the other 90% over the current active index by weight. Every configured stock must have a complete route or the supplied keeper skips the buy.",
  },
  {
    number: "02",
    call: "snapshotHolders(count)",
    actor: "Keeper",
    copy: "Reads StockifyToken.holderAt(i) in pages, excludes infrastructure and reward-excluded accounts, records balance plus address in one word, and accumulates eligibleSupply.",
  },
  {
    number: "03",
    call: "startCycle()",
    actor: "Keeper",
    copy: "Requires a complete snapshot (or creates a one-transaction snapshot for a small registry), freezes each distributable B20 pot and sets nextDistribution to now + 1 hour.",
  },
  {
    number: "04",
    call: "distributeBatch(count)",
    actor: "Keeper",
    copy: "Pushes every frozen B20 asset to the next page of recipients. A failed B20 receiver-policy check records an unpaid entitlement instead of reverting the whole batch.",
  },
  {
    number: "05",
    call: "flushUnpaidDividend(holder, stock)",
    actor: "Anyone",
    copy: "Retries a recorded failed payment to its original holder. It cannot redirect that entitlement or redivide it across other accounts.",
  },
] as const;

const ownerControls = [
  ["Token eligibility", "setMinShareBalance(10k–100k) and setRewardsExcluded."],
  ["Index policy", "setIndex(stocks, weights) between cycles only; weights must total 10,000 bps."],
  ["Operators", "setKeeper, setPlatformRecipient and setMaxGrossSpendPerCycle."],
  ["Infrastructure", "setExcluded accepts contract addresses only, protecting ordinary wallet holders from this vault-level control."],
  ["Emergency path", "emergencyWithdrawERC20 can recover every ERC-20 in custody, including B20 stocks; it intentionally has no matching native-ETH path."],
] as const;

export default function DocsPage() {
  return (
    <div className="site-shell">
      <SiteHeader active="docs" />
      <main>
        <section className="page-intro wrap docs-intro">
          <p className="eyebrow">TECHNICAL REFERENCE / PRE-LAUNCH</p>
          <h1>Protocol<br /><em>documentation.</em></h1>
          <p>
            This is an implementation reference for the contracts and keeper in this repository—not a yield page.
            It distinguishes deployed behavior from pending launch work and names the operational trust assumptions.
          </p>
          <div className="docs-status-row" aria-label="Protocol status">
            <span>Base mainnet · 8453</span><span>Solidity · 0.8.26</span><span>Addresses · pending deployment</span>
          </div>
        </section>

        <section className="docs-layout wrap">
          <aside className="docs-nav" aria-label="Documentation sections">
            <span>ON THIS PAGE</span>
            {contents.map(([id, title], index) => <a href={`#${id}`} key={id}><b>{String(index + 1).padStart(2, "0")}</b>{title}</a>)}
            <a className="docs-source-link" href="https://github.com/onlytrifiz/stockify-protocol" target="_blank" rel="noreferrer">Repository ↗</a>
          </aside>

          <div className="docs-reference">
            <section className="docs-section docs-overview" id="overview">
              <div className="docs-section-label"><span>01</span><p>System overview</p></div>
              <div className="docs-section-body">
                <h2>Fees become stock balances, then direct payouts.</h2>
                <p>
                  Stockify has one intended ETH/STFY Uniswap v4 market. Its hook collects a 3% native-ETH fee on
                  both directions of trade and forwards it to <code>DividendVault</code>. The vault accounts for
                  10% of each allocation as protocol revenue and makes the remaining 90% available for B20 stock purchases.
                </p>
                <div className="docs-flow" aria-label="Stockify fee and dividend flow">
                  <div><b>ETH / STFY</b><span>Uniswap v4 pool</span></div>
                  <i aria-hidden="true">→</i>
                  <div><b>3.00% hook fee</b><span>Native ETH to vault</span></div>
                  <i aria-hidden="true">→</i>
                  <div><b>90 / 10 split</b><span>Stocks / protocol revenue</span></div>
                  <i aria-hidden="true">→</i>
                  <div><b>B20 push payout</b><span>On-chain holder registry</span></div>
                </div>
                <div className="docs-table-wrap">
                  <table>
                    <caption>Fee accounting per ETH/STFY trade volume</caption>
                    <thead><tr><th>Destination</th><th>Rate</th><th>How it is accounted for</th></tr></thead>
                    <tbody>
                      <tr><td>LP fee</td><td>1.00%</td><td>Pool configuration; separate from the hook.</td></tr>
                      <tr><td>Hook fee</td><td>3.00%</td><td>Collected in native ETH by <code>StockifyFeeHook</code>.</td></tr>
                      <tr><td>B20 purchase budget</td><td>2.70%</td><td>90% of the hook allocation, split by active index weights.</td></tr>
                      <tr><td>Protocol revenue</td><td>0.30%</td><td>10% of the hook allocation, tracked as <code>platformClaimable</code>.</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="docs-note"><strong>Important:</strong> the hook itself only collects the 3% fee. It does not initialize a pool, choose a price or provide liquidity.</p>
              </div>
            </section>

            <section className="docs-section" id="contracts">
              <div className="docs-section-label"><span>02</span><p>Contract reference</p></div>
              <div className="docs-section-body">
                <h2>The four implementation surfaces.</h2>
                <p>These are the source modules that define the protocol today. There are no production Stockify contract addresses yet.</p>
                <div className="docs-contracts">
                  {contractRows.map((contract) => <article key={contract.name}>
                    <div className="docs-contract-head"><h3>{contract.name}</h3><code>{contract.file}</code></div>
                    <p>{contract.description}</p>
                    <ul>{contract.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                  </article>)}
                </div>
                <details className="docs-details">
                  <summary>How the hook determines when to collect ETH</summary>
                  <p>
                    The pool must place native ETH in <code>currency0</code>. The hook collects before the swap when ETH is
                    specified, and after the swap when it is not. It uses Uniswap v4 return deltas to settle exactly 300 bps to the vault.
                  </p>
                </details>
              </div>
            </section>

            <section className="docs-section" id="cycle">
              <div className="docs-section-label"><span>03</span><p>Distribution cycle</p></div>
              <div className="docs-section-body">
                <h2>A keeper executes; contracts determine recipients.</h2>
                <p>
                  The keeper discovers B20 swap routes off-chain, but it does not build a Merkle tree or submit an address list.
                  Recipient enumeration, captured balances and payout accounting live in the token and vault contracts.
                </p>
                <ol className="docs-cycle">
                  {cycleSteps.map((step) => <li key={step.number}>
                    <span>{step.number}</span><div><div className="docs-cycle-head"><code>{step.call}</code><small>{step.actor}</small></div><p>{step.copy}</p></div>
                  </li>)}
                </ol>
                <div className="docs-formula"><span>Payout formula</span><code>stock pot × min(snapshot balance, live balance) ÷ eligibleSupply</code></div>
                <p className="docs-note">
                  <strong>Timing:</strong> <code>nextDistribution</code> is set when <code>startCycle()</code> begins, so a new cycle
                  cannot start for one hour. Stock purchases are keeper-driven and are not independently rate-limited by this interval.
                </p>
              </div>
            </section>

            <section className="docs-section" id="eligibility">
              <div className="docs-section-label"><span>04</span><p>Eligibility &amp; accounting</p></div>
              <div className="docs-section-body">
                <h2>Holder discovery is on-chain.</h2>
                <p>
                  <code>StockifyToken</code> maintains an array of eligible accounts every time a balance changes. Accounts qualify at
                  the current threshold, initially 100,000 STFY; governance can only set it between 10,000 and 100,000 STFY.
                </p>
                <div className="docs-split-grid">
                  <article><span>Registry</span><h3>No explorer dependency</h3><p>The vault calls <code>holderCount()</code> and <code>holderAt(i)</code>. Its keeper can therefore distribute without Blockscout, Etherscan or an off-chain holder database.</p></article>
                  <article><span>Balance clamp</span><h3>Sells reduce a captured weight</h3><p>At payment, the snapshot amount is capped to the holder&apos;s current balance. A balance returned after capture cannot receive the full historic weight.</p></article>
                  <article><span>Rejected B20 transfer</span><h3>Entitlement stays attached</h3><p>If a B20 receiver policy rejects a transfer, the amount is recorded as unpaid for that holder and can be retried with <code>flushUnpaidDividend</code>.</p></article>
                </div>
                <div className="docs-warning">
                  <strong>Snapshot semantics.</strong> Paginated snapshots are not a single-block atomic snapshot: transfers can mutate the swap-and-pop registry between keeper calls. The vault de-duplicates seen addresses and applies the live-balance clamp, but operators should treat multi-transaction capture as an operationally sensitive period.
                </div>
              </div>
            </section>

            <section className="docs-section" id="operations">
              <div className="docs-section-label"><span>05</span><p>Roles &amp; controls</p></div>
              <div className="docs-section-body">
                <h2>Explicit permissions, not implied automation.</h2>
                <div className="docs-role-grid">
                  <article><span>Owner multisig</span><h3>Configuration and emergency custody</h3><p>Can change policy and use the ERC-20 emergency path. This is a material trust role and should be a multisig at deployment.</p></article>
                  <article><span>Keeper</span><h3>Routes, buys and batches</h3><p>Can buy stocks and advance snapshots and payouts, but cannot change thresholds, index weights, recipients or ownership.</p></article>
                  <article><span>Platform recipient</span><h3>Claims only accrued revenue</h3><p>Can claim <code>platformClaimable</code>. The owner can rotate this recipient; it has no direct access to the stock budget.</p></article>
                  <article><span>Anyone</span><h3>Retries an unpaid dividend</h3><p>Can call <code>flushUnpaidDividend</code>, but tokens can only be sent to the recorded rightful holder.</p></article>
                </div>
                <div className="docs-table-wrap docs-controls-table">
                  <table><caption>Owner-controlled operations</caption><tbody>{ownerControls.map(([control, description]) => <tr key={control}><th>{control}</th><td>{description}</td></tr>)}</tbody></table>
                </div>
                <div className="docs-warning docs-warning-dark">
                  <strong>Execution trust and recovery risk.</strong> The router address is immutable, but <code>buyStocks</code> forwards keeper-supplied router calldata and keeper-supplied minimum outputs. The configured cap applies per <code>buyStocks</code> call, not to a calendar-hour total. Separately, <code>abortCycle()</code> clears a partial cycle without recording which holders were already paid; it should not be used after any payout batch. These are current implementation constraints, not guarantees removed by the UI.
                </div>
              </div>
            </section>

            <section className="docs-section" id="market">
              <div className="docs-section-label"><span>06</span><p>Trading &amp; liquidity</p></div>
              <div className="docs-section-body">
                <h2>How STFY and the dividend assets trade.</h2>
                <p>
                  Stockify is designed around one ETH/STFY Uniswap v4 pool. Liquidity providers set the initial
                  price and add liquidity in a separate pool-initialization transaction; the hook does neither.
                  Until that happens, STFY has no live market or price.
                </p>
                <div className="docs-split-grid docs-market-grid">
                  <article><span>STFY market</span><h3>ETH / STFY on Uniswap v4</h3><p>The intended pool uses a 1% LP fee plus Stockify&apos;s 3% native-ETH hook fee on buys and sells. The hook fee is forwarded to the dividend vault.</p></article>
                  <article><span>Stock assets</span><h3>Base B20 tokenized stocks</h3><p>Dividends are paid in the B20 assets acquired by the vault. B20 assets can apply their own sender and receiver transfer policies.</p></article>
                  <article><span>Route availability</span><h3>No route, no stock purchase</h3><p>The keeper buys the active index only when every configured stock has a complete route. If one is unavailable, hook ETH remains in the vault for a later attempt.</p></article>
                </div>
                <p className="docs-note"><strong>Pre-launch:</strong> the deployment script deliberately leaves the pool uninitialized. Pool price, liquidity and the first public STFY route are launch decisions, not protocol constants.</p>
              </div>
            </section>

            <section className="docs-section" id="launch">
              <div className="docs-section-label"><span>07</span><p>Deployment status</p></div>
              <div className="docs-section-body">
                <h2>Implementation present; launch addresses pending.</h2>
                <div className="docs-table-wrap">
                  <table><caption>Network configuration</caption><tbody>
                    <tr><th>Base chain</th><td>8453</td><td>Target network</td></tr>
                    <tr><th>v4 PoolManager</th><td><code>0x498581fF718922c3f8e6A244956aF099B2652b2b</code></td><td><a href="https://developers.uniswap.org/docs/protocols/v4/deployments#base-8453" target="_blank" rel="noreferrer">Uniswap deployment reference ↗</a></td></tr>
                    <tr><th>Universal Router</th><td><code>0x6fF5693b99212Da76ad316178A184AB56D299b43</code></td><td>Immutable vault dependency</td></tr>
                    <tr><th>STFY / vault / hook</th><td>Not deployed</td><td>Publish verified addresses here after deployment</td></tr>
                  </tbody></table>
                </div>
                <div className="docs-launch-grid">
                  <article><span>01</span><h3>Deploy and verify</h3><p>Deploy the token, vault and CREATE2-mined hook; set the multisig owner, platform recipient, keeper and a reviewed spend cap.</p></article>
                  <article><span>02</span><h3>Set market parameters</h3><p>Decide the initial ETH/STFY price and liquidity separately. The deployment script deliberately does not initialize a v4 pool.</p></article>
                  <article><span>03</span><h3>Validate routes and policies</h3><p>Confirm each active B20 route and receiver policy. The supplied keeper skips a full buy when any active stock has no complete route.</p></article>
                  <article><span>04</span><h3>Publish operations</h3><p>Publish verified addresses, multisig and keeper policy, monitoring, and the first distribution transaction data before calling the market live.</p></article>
                </div>
                <div className="docs-callout"><p className="eyebrow">RELATED</p><h2>See the empty distribution ledger.</h2><p>Until the protocol is live, the dashboard intentionally shows no estimated APY or simulated payout history.</p><Link className="button button-ink" href="/dividend">Distribution desk <span>→</span></Link></div>
              </div>
            </section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
