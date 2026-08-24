import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../components/site-chrome";

export const metadata: Metadata = {
  title: "Protocol documentation — Stockify",
  description: "Public protocol reference for Stockify's token, v4 fee hook, dividend vault, index treasuries and distribution cycle on Base.",
};

const contents = [
  ["overview", "System overview"],
  ["contracts", "Contract reference"],
  ["cycle", "Distribution cycle"],
  ["eligibility", "Eligibility & accounting"],
  ["indices", "Indices"],
  ["operations", "Roles & controls"],
  ["market", "Trading & liquidity"],
  ["addresses", "Deployed addresses"],
] as const;

/**
 * Read from the same variables the rest of the site is built against, never written out by hand.
 *
 * A documentation page that hardcodes an address is a page that can disagree with the application
 * printed beside it, and it will — quietly, and in the direction of whichever one was edited last.
 * These are the values the trade panels and chain readers actually use, so the two cannot drift.
 */
const deployed = [
  ["STFY token", "StockifyToken", process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS],
  ["Dividend vault", "DividendVault", process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS],
  ["Fee hook", "StockifyFeeHook", process.env.NEXT_PUBLIC_STOCKIFY_HOOK_ADDRESS],
  ["Pool router", "StockifyRouter", process.env.NEXT_PUBLIC_STOCKIFY_ROUTER_ADDRESS],
  ["Index factory", "IndexFactory", process.env.NEXT_PUBLIC_INDEX_FACTORY],
] as const;

const isAddress = (value?: string) => /^0x[a-fA-F0-9]{40}$/.test(value ?? "");

const contractRows = [
  {
    name: "StockifyToken",
    file: "src/StockifyToken.sol",
    description: "Fixed-supply STFY ERC-20. Maintains the enumerable holder registry the vault reads; it does not ask an indexer or explorer for recipients.",
    facts: ["1,000,000,000 STFY fixed supply", "10,000–100,000 STFY eligibility range", "O(1) holder removal with swap-and-pop"],
  },
  {
    name: "StockifyFeeHook",
    file: "src/StockifyFeeHook.sol",
    description: "The Uniswap v4 hook on the ETH/STFY pool. It takes 300 bps in native ETH and settles it directly to the vault.",
    facts: ["300 bps hook fee", "ETH must be currency0", "CREATE2 address mined for v4 flags"],
  },
  {
    name: "DividendVault",
    file: "src/DividendVault.sol",
    description: "Holds hook ETH and acquired B20 balances, tracks protocol revenue, snapshots eligible holders and pushes dividends in batches.",
    facts: ["1 hour minimum between cycle starts", "90% stock budget / 10% protocol revenue", "Owner-curated venue allowlist", "No native-ETH emergency withdrawal"],
  },
  {
    name: "StockifyRouter",
    file: "src/StockifyRouter.sol",
    description: "Stateless buy/sell router for the ETH/STFY pool, because aggregators will not route a pool whose hook is not on their allowlist. It holds no funds and has no owner.",
    facts: ["buy(minOut) payable · sell(amountIn, minOut)", "Refunds input the pool would not take", "Approvals are made to this contract, not a proxy"],
  },
  {
    name: "IndexFactory / IndexTreasury",
    file: "src/indices/",
    description: "A separate product: one EIP-1167 treasury per launch that points its creator fees here. See the Indices section below — its roles are not the vault's.",
    facts: ["CREATE2 address known before deployment", "Composition immutable after creation", "Clones are never upgraded"],
  },
  {
    name: "Keepers",
    file: "keeper/ · keeper-indices/",
    description: "Two off-chain executors, one per product. Both discover routes and submit transactions; neither supplies a recipient list.",
    facts: ["Base chain ID 8453", "250 default snapshot batch", "25 default payout batch"],
  },
] as const;

const cycleSteps = [
  {
    number: "01",
    call: "buyStocks(targets, routeCalldatas, amountInOffsets, minOuts)",
    actor: "Keeper",
    copy: "Sizes the spend from available native ETH, wraps the 90% stock budget into WETH and divides it over the active index by weight. Each leg names an allowlisted venue and the byte offset of the amount inside its own calldata, which the vault overwrites with the real spend before calling. Protocol revenue accrues on what was actually spent, not on what was offered.",
  },
  {
    number: "02",
    call: "snapshotHolders(count)",
    actor: "Keeper",
    copy: "Reads StockifyToken.holderAt(i) in pages, skips infrastructure and reward-excluded accounts, records balance plus address in one word, and accumulates eligibleSupply.",
  },
  {
    number: "03",
    call: "startCycle()",
    actor: "Keeper",
    copy: "Requires a complete snapshot (or captures a small registry in one transaction), freezes each distributable B20 pot and sets nextDistribution to now + 1 hour.",
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
  ["Venue allowlist", "setSwapTarget(target, allowed) decides where a purchase may route. This is the control that bounds keeper execution — see the trust note below."],
  ["Token eligibility", "setMinShareBalance(10k–100k) and setRewardsExcluded."],
  ["Index policy", "setIndex(stocks, weights) between cycles only; weights must total 10,000 bps."],
  ["Operators", "setKeeper, setPlatformRecipient and setMaxGrossSpendPerCycle."],
  ["Infrastructure", "setExcluded accepts contract addresses only, protecting ordinary wallet holders from this vault-level control."],
  ["Emergency path", "emergencyWithdrawERC20 can recover every ERC-20 in custody, including B20 stocks; it intentionally has no matching native-ETH path."],
] as const;

export default function DocsPage() {
  const live = deployed.filter(([, , address]) => isAddress(address));

  return (
    <div className="site-shell">
      <SiteHeader active="docs" />
      <main>
        <section className="page-intro wrap docs-intro">
          <p className="eyebrow">TECHNICAL REFERENCE / LIVE ON BASE</p>
          <h1>Protocol<br /><em>documentation.</em></h1>
          <p>
            This is an implementation reference for the contracts and keepers behind Stockify—not a yield page.
            It describes what the deployed code does, and names the operational trust assumptions rather than
            leaving them implied.
          </p>
          <div className="docs-status-row" aria-label="Protocol status">
            <span>Base mainnet · 8453</span><span>Solidity · 0.8.26</span><span>Unaudited</span>
          </div>
        </section>

        <section className="docs-layout wrap">
          <aside className="docs-nav" aria-label="Documentation sections">
            <span>ON THIS PAGE</span>
            {contents.map(([id, title], index) => <a href={`#${id}`} key={id}><b>{String(index + 1).padStart(2, "0")}</b>{title}</a>)}
          </aside>

          <div className="docs-reference">
            <section className="docs-section docs-overview" id="overview">
              <div className="docs-section-label"><span>01</span><p>System overview</p></div>
              <div className="docs-section-body">
                <h2>Fees become stock balances, then direct payouts.</h2>
                <p>
                  Stockify has one ETH/STFY Uniswap v4 market. Its hook collects a 3% native-ETH fee on
                  both directions of trade and forwards it to <code>DividendVault</code>. The vault accounts for
                  10% of each allocation as protocol revenue and deploys the remaining 90% into B20 stock purchases,
                  which are then pushed to STFY holders.
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
                <p className="docs-note"><strong>Important:</strong> the hook only collects the 3% fee. It does not initialize a pool, choose a price or provide liquidity, and it does not verify which token sits opposite ETH — it collects on any v4 pool that names it with native ETH as <code>currency0</code>.</p>
              </div>
            </section>

            <section className="docs-section" id="contracts">
              <div className="docs-section-label"><span>02</span><p>Contract reference</p></div>
              <div className="docs-section-body">
                <h2>The implementation surfaces.</h2>
                <p>These are the modules that define the protocol. Deployed addresses are in the last section.</p>
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
                <details className="docs-details">
                  <summary>How a purchase reaches a venue without the vault holding a router</summary>
                  <p>
                    The vault does not parse routes and does not store a router address. Each leg names a venue the owner has
                    allowlisted with <code>setSwapTarget</code>; the vault sizes the input itself, writes that amount into the
                    route&apos;s own calldata at the offset the keeper supplies, approves exactly that amount and revokes the
                    approval in the same call. The result is judged purely by balance deltas, so a listed venue can make a leg
                    fail but cannot take custody of more than one leg&apos;s input.
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
                <p className="docs-note">
                  <strong>The active index is not a constant.</strong> The owner can replace the buy index and its weights between
                  cycles, so what the vault holds is whatever <code>stocksLength()</code> and <code>stockAt(i)</code> report right now.
                  Any asset ever admitted stays in the distribution set, so a rotation cannot strand stock already acquired.
                </p>
              </div>
            </section>

            <section className="docs-section" id="indices">
              <div className="docs-section-label"><span>05</span><p>Indices</p></div>
              <div className="docs-section-body">
                <h2>A second product, with different roles.</h2>
                <p>
                  A coin launched elsewhere can point its creator fee stream at a treasury minted by <code>IndexFactory</code>.
                  From then on those fees either buy tokenized equity that is pushed to the coin&apos;s holders, or buy the coin
                  back and burn it. One EIP-1167 clone per coin; what it buys is fixed at creation and clones are never upgraded.
                </p>
                <div className="docs-split-grid">
                  <article><span>Mode 0</span><h3>Buy the basket, pay holders</h3><p>Fees buy each basket name by weight and the balance is pushed pro-rata on coin balance. Wallets under 10,000 whole coins are skipped and their slice stays with the holders above the line.</p></article>
                  <article><span>Mode 1</span><h3>Buy the coin back, burn it</h3><p>No basket, no holder list, no rounds. <code>burn()</code> is permissionless because it has one destination and cannot change any holder&apos;s share relative to another&apos;s.</p></article>
                  <article><span>Cadence</span><h3>15 minutes to 1 week</h3><p>Chosen at creation. A round opens no sooner than the interval and only when there is something to pay; it can be continued across transactions inside a shorter batch window.</p></article>
                </div>
                <div className="docs-formula"><span>Split of every harvest</span><code>platform fee off the top → creatorShareBps of the remainder → the rest to holders</code></div>
                <p>
                  The platform fee is read from the factory rather than fixed in a clone, and is capped at 20% in the factory&apos;s
                  own code. The creator&apos;s accrued share is fenced from the buy path in both directions: a purchase can never
                  spend it, and a payout can never reach it.
                </p>
                <div className="docs-warning">
                  <strong>Two tiers of promise, and the default is the weaker one.</strong> A launchpad pays whoever a coin&apos;s
                  creator split names, and falls back to the creator role only when no split is set. A launch that names a treasury
                  as its fee recipient produces the first: the launching wallet keeps the role and can point the split back at
                  itself at any time, with no delay and no signature from us. Only the role is beyond its reach, and a treasury can
                  hold it only through the launchpad owner&apos;s timelocked transfer. Each index page states which one is in force
                  and re-derives it live, so a stream that has been pointed away is reported as such rather than assumed.
                </div>
                <div className="docs-warning docs-warning-dark">
                  <strong>The roles here are not the vault&apos;s — do not carry that model over.</strong> On an index treasury the
                  KEEPER is the administrator: exclusions, the dust floor, pausing, stray-token rescue and ownership are all keeper
                  calls. The OWNER is a label recording who the treasury was created for and carries no power at all — a creator
                  points their launch&apos;s fees at a treasury and their involvement ends there, which is what stops a creator from
                  freezing their own holders&apos; payouts or shaping a distribution. What the keeper cannot do is take custody:
                  it may only buy basket names, only sell the quote asset, never sell equity back, and never set payout weights,
                  which are read from coin balances over a strictly ascending list so no address can appear twice.
                </div>
              </div>
            </section>

            <section className="docs-section" id="operations">
              <div className="docs-section-label"><span>06</span><p>Roles &amp; controls</p></div>
              <div className="docs-section-body">
                <h2>Explicit permissions, not implied automation.</h2>
                <p>This section is about the STFY vault. The index treasuries assign these roles differently — see above.</p>
                <div className="docs-role-grid">
                  <article><span>Owner</span><h3>Configuration and emergency custody</h3><p>Can change policy, curate swap venues and use the ERC-20 emergency path. This is a material trust role and should be held by a multisig.</p></article>
                  <article><span>Keeper</span><h3>Routes, buys and batches</h3><p>Can buy stocks and advance snapshots and payouts, but cannot change thresholds, index weights, venues, recipients or ownership.</p></article>
                  <article><span>Platform recipient</span><h3>Claims only accrued revenue</h3><p>Can claim <code>platformClaimable</code>. The owner can rotate this recipient; it has no direct access to the stock budget.</p></article>
                  <article><span>Anyone</span><h3>Retries an unpaid dividend</h3><p>Can call <code>flushUnpaidDividend</code>, but tokens can only be sent to the recorded rightful holder.</p></article>
                </div>
                <div className="docs-table-wrap docs-controls-table">
                  <table><caption>Owner-controlled operations</caption><tbody>{ownerControls.map(([control, description]) => <tr key={control}><th>{control}</th><td>{description}</td></tr>)}</tbody></table>
                </div>
                <div className="docs-warning docs-warning-dark">
                  <strong>Execution trust and recovery risk.</strong> <code>buyStocks</code> forwards keeper-supplied route calldata
                  and keeper-supplied minimum outputs. The vault measures the spend and the fill rather than trusting them, and a
                  venue receives only one leg&apos;s approval, revoked in the same call — so the keeper cannot move funds to itself.
                  What it can do is accept a poor fill at a listed venue, which makes the owner&apos;s allowlist, not the keeper, the
                  real bound on execution. Separately: <code>maxGrossSpendPerCycle</code> applies per <code>buyStocks</code> call and
                  not to a calendar-hour total, and <code>abortCycle()</code> clears a partial cycle without recording which holders
                  were already paid, so it must not be used after any payout batch. A guardian contract exists that would refuse
                  exactly that call; it is deliberately not installed. These are current implementation constraints.
                </div>
              </div>
            </section>

            <section className="docs-section" id="market">
              <div className="docs-section-label"><span>07</span><p>Trading &amp; liquidity</p></div>
              <div className="docs-section-body">
                <h2>How STFY and the dividend assets trade.</h2>
                <p>
                  STFY trades in one ETH/STFY Uniswap v4 pool. Aggregators will not route a pool whose hook is not on their
                  allowlist, so this site buys and sells through <code>StockifyRouter</code>, which calls the pool manager
                  directly. Everything else — the tokenized equities — is routed through an aggregator.
                </p>
                <div className="docs-split-grid docs-market-grid">
                  <article><span>STFY market</span><h3>ETH / STFY on Uniswap v4</h3><p>A 1% LP fee plus Stockify&apos;s 3% native-ETH hook fee on buys and sells. The hook fee is forwarded to the dividend vault.</p></article>
                  <article><span>Stock assets</span><h3>Base B20 tokenized stocks</h3><p>Dividends are paid in the B20 assets acquired by the vault. B20 assets can apply their own sender and receiver transfer policies, checked before a trade is offered.</p></article>
                  <article><span>Route availability</span><h3>No route, no stock purchase</h3><p>The keeper buys the active index only when every configured stock has a complete route at an allowlisted venue. If one is unavailable, hook ETH remains in the vault for a later attempt.</p></article>
                </div>
                <p className="docs-note"><strong>Slippage:</strong> Base has no public mempool, so the minimum-output floors here are a sanity check against a mispriced fill rather than sandwich protection. The 3% hook fee is charged in ETH on the way through, which is why the panel&apos;s presets start well above an ordinary AMM default.</p>
              </div>
            </section>

            <section className="docs-section" id="addresses">
              <div className="docs-section-label"><span>08</span><p>Deployed addresses</p></div>
              <div className="docs-section-body">
                <h2>Everything below is on Base mainnet.</h2>
                <div className="docs-table-wrap">
                  <table>
                    <caption>Stockify contracts</caption>
                    <thead><tr><th>Contract</th><th>Source</th><th>Address</th></tr></thead>
                    <tbody>
                      {live.map(([label, name, address]) => (
                        <tr key={name}>
                          <th>{label}</th>
                          <td><code>{name}</code></td>
                          <td><a href={`https://basescan.org/address/${address}`} target="_blank" rel="noreferrer">{address} ↗</a></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="docs-table-wrap">
                  <table>
                    <caption>Network dependencies</caption>
                    <tbody>
                      <tr><th>Base chain</th><td>8453</td><td>Target network</td></tr>
                      <tr><th>v4 PoolManager</th><td><code>0x498581fF718922c3f8e6A244956aF099B2652b2b</code></td><td><a href="https://developers.uniswap.org/docs/protocols/v4/deployments#base-8453" target="_blank" rel="noreferrer">Uniswap deployment reference ↗</a></td></tr>
                      <tr><th>Swap venues</th><td>Owner allowlist</td><td>Curated with <code>setSwapTarget</code>; there is no pinned router. Read the current state from the vault.</td></tr>
                    </tbody>
                  </table>
                </div>
                <div className="docs-warning">
                  <strong>Not audited.</strong> This code has unit tests and has been deployed, but it has not undergone an
                  independent security audit or a legal and compliance review. B20 transfer policy and jurisdictional eligibility
                  are the holder&apos;s to establish.
                </div>
                <div className="docs-callout"><p className="eyebrow">RELATED</p><h2>See what has actually been paid.</h2><p>The distribution desk shows every settled cycle, decoded from the vault&apos;s own events. There is no estimated APY and no simulated history.</p><Link className="button button-ink" href="/dividends">Distribution desk <span>→</span></Link></div>
              </div>
            </section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
