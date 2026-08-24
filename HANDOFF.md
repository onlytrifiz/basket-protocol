# Stockify — engineering handoff

**Status:** deployed and live on Base mainnet. Unaudited.

Stockify is a Base protocol that routes an ETH/STFY Uniswap v4 hook fee into purchases of Base B20 tokenized stocks, then pushes those stock balances pro rata to eligible STFY holders. The same repository contains **Indices**, a second product that does the equivalent for another launch’s creator fees.

This document is for whoever operates or extends the system. It describes what is deployed, not what was planned.

---

## What is implemented

| Module | Source | Current behaviour |
| --- | --- | --- |
| STFY token | `src/StockifyToken.sol` | Fixed supply of `1,000,000,000 STFY`; on-chain eligible-holder registry. |
| Fee hook | `src/StockifyFeeHook.sol` | Collects `300 bps` native ETH on any v4 pool naming it with ETH as `currency0`, and forwards it to the vault. |
| Dividend vault | `src/DividendVault.sol` | Accounts for hook ETH, buys B20 assets through an owner-curated venue allowlist, snapshots holders and sends batched push payouts. |
| Pool router | `src/StockifyRouter.sol` | Stateless buy/sell for the ETH/STFY pool. No owner, holds no funds, refunds input the pool would not absorb. |
| Vault guardian | `src/VaultGuardian.sol` | Optional owner wrapper refusing `abortCycle()` on a partially paid cycle. **Not installed.** |
| Indices | `src/indices/` | `IndexFactory` mints one `IndexTreasury` clone per launch. Separate roles — see below. |
| Vault keeper | `keeper/` | Gets routes off-chain and executes vault buys / snapshots / payouts. It does not provide the holder list. |
| Indices keeper | `keeper-indices/` | Runs harvest / swap / distribute (or burn) for every treasury the factory has minted. |
| Deploy script | `script/Deploy.s.sol` | Deploys token, vault and CREATE2-mined hook. It deliberately does not initialize a pool. |
| Web app | `web/` | Next.js public site: market, distributions, indices, protocol and public documentation pages. |

Public documentation is at `/docs`. It reads deployed addresses from the same configuration the application is built against, so the two cannot disagree.

---

## Economics

| Item | Rate | Destination |
| --- | ---: | --- |
| v4 LP fee | 1.00% | Liquidity providers; pool configuration, separate from the hook. |
| Stockify hook fee | 3.00% | Native ETH to `DividendVault`. |
| Stock purchase budget | 2.70% of volume | 90% of the hook-fee allocation. |
| Protocol revenue | 0.30% of volume | 10% of the allocation, recorded as `platformClaimable`. |

Protocol revenue accrues on ETH **actually spent** on stock (`totalSpent / 9`), not on ETH merely made available. A `buyStocks` call whose routes fill nothing accrues nothing.

The vault uses the active index weights to divide the purchase budget. The owner can replace the active index only outside a pending snapshot or active cycle. Assets that were ever admitted remain in the distribution set, so balances already acquired are not stranded by a rotation.

---

## Token and payout model

- Supply: `1,000,000,000 STFY`.
- Initial dividend eligibility threshold: `100,000 STFY`; owner-configurable within `10,000–100,000`.
- `StockifyToken` keeps its own enumerable holder registry via `holderCount()` / `holderAt(i)`.
- Payouts are **push**, not Merkle claims.
- Formula: `stock pot × min(snapshot balance, live balance) ÷ eligibleSupply`.
- The live-balance clamp means a holder who sells after capture receives no more than their remaining weight.
- A B20 transfer that fails a receiver-policy check is recorded as `unpaidDividend`; anyone may retry the exact entitlement via `flushUnpaidDividend(holder, stock)`.

### Distribution state flow

```text
hook ETH in DividendVault
        │
        ├── keeper: buyStocks(targets, routeCalldatas, amountInOffsets, minOuts)
        │       ├── 10% of what is spent → platformClaimable
        │       └── 90% → active B20 index, one leg per entry
        │
        ├── keeper: snapshotHolders(count) [pages]
        ├── keeper: startCycle()
        └── keeper: distributeBatch(count) [pages]
```

`startCycle()` sets `nextDistribution` to one hour after its start. Stock-buy execution is keeper-driven and is not independently rate-limited by that interval.

---

## How a purchase reaches a venue

The vault stores **no router address**. This changed from the original design and is the single most important correction to any older notes: there is no pinned Universal Router.

- The owner curates an allowlist with `setSwapTarget(target, allowed)`.
- The keeper names one allowlisted venue per leg, plus the byte offset of the input-amount word inside that venue’s own calldata.
- The vault sizes the input itself, overwrites that word with the real spend, approves exactly that amount, calls the venue, and revokes the approval in the same transaction.
- The result is judged purely by balance deltas: `received ≥ minOut`, and `spent` is measured, never asserted.

A listed venue can therefore make a leg fail; it cannot take custody of more than that leg’s input. **The owner’s allowlist, not the keeper, is the real bound on execution quality** — `minOut` is a keeper-chosen number.

---

## The B20 index

The active index is read from the chain — `stocksLength()` and `stockAt(i)`. `script/Deploy.s.sol` seeds thirteen assets at effectively equal weight (twelve at `769 bps`, `TSLAc` at `772 bps`), but the deployed vault has been reconfigured since and the deploy list is not the live one. Never read the index from a document.

B20 assets are validated via ERC-20 reads rather than bytecode checks, because they are Base Rust precompiles: `eth_getCode` returns a single `0xef` byte for a token and nothing for the factory. Note that `IndexTreasury.initialize` does gate basket entries on `code.length != 0`, which passes only because of that one-byte stub — an undocumented dependency worth remembering if B20 representation ever changes.

---

## Indices — a different trust model

Do not carry the vault’s role assignment over. On an `IndexTreasury`:

| | DividendVault | IndexTreasury |
| --- | --- | --- |
| Configuration, pause, rescue | Owner | **Keeper** |
| Exclusions, dust floor | Owner | **Keeper** |
| Buys and payouts | Keeper | Keeper |
| Creator / coin owner | — | **No powers at all** |

`owner` on a treasury is a label recording who it was created for. It gates nothing. That is deliberate: `coin` is what the payout denominator is read over, so an owner able to configure the treasury could shape or freeze its holders’ payouts.

What the keeper cannot do is take custody: it may only buy basket names (or, in buyback mode, the coin), only sell the quote asset, never sell equity back, and never set payout weights — those are read from coin balances over a strictly ascending list, so no address can appear twice in a round.

**Binding is self-verifying but the promise has two tiers.** A launchpad pays whoever a coin’s creator *split* names, falling back to the creator *role* only when no split is set. An ordinary launch produces the first, which the launching wallet can point back at itself at any time. `bindIsPermanent` snapshots which applied at bind; `feeRecipientNow()` re-derives it live.

Clones are never upgraded. `setImplementation()` affects future clones only, so a treasury keeps the logic it was created with forever.

---

## Deployment dependencies

| Dependency | Base mainnet value |
| --- | --- |
| Chain ID | `8453` |
| Uniswap v4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` |
| Swap venues | Owner allowlist on the deployed vault and factory. No pinned router. |
| Pool initialization | Intentionally not in the deploy script. |

`script/Deploy.s.sol` requires `PRIVATE_KEY`; it optionally accepts `PROTOCOL_OWNER`, `KEEPER`, `PLATFORM_RECIPIENT`, `POOL_MANAGER` and `MAX_GROSS_SPEND_PER_CYCLE`. It refuses to run unless `PROTOCOL_OWNER` is a contract and `KEEPER` differs from the deployer, unless `ALLOW_HOT_KEY_OWNER=1` is set.

Never commit or paste private keys or API secrets into this repository or into a handoff document.

---

## Open constraints

Numbered as in earlier revisions of this document so older notes still resolve. Items 1 and 6 are resolved; the rest stand.

### 1. Raw router calldata — RESOLVED, with a residual

The original design forwarded keeper calldata to an immutable Universal Router, which constrained neither the router commands nor the recipient. That is gone: purchases now go through an owner-curated venue allowlist, the vault writes the spend into the calldata itself, approves exactly one leg’s input and revokes it in the same call, and judges the outcome by measured balance deltas.

**Residual:** `minOut` is still keeper-supplied, so a compromised keeper can accept a poor fill at a listed venue. Bounding that is the allowlist’s job. Treat venue listing as a security decision, not a convenience one.

### 2. Spend cap is per call, not per cycle — high

`maxGrossSpendPerCycle` is applied in each call to `buyStocks()`. A keeper can call it repeatedly, so it is not a calendar-hour or distribution-cycle limit.

**Fix:** track a spend epoch or rolling window on-chain and enforce the cumulative cap, or make buying callable once per distribution epoch.

### 3. Partial-cycle abort changes payout economics — high

`abortCycle()` can clear state after one or more `distributeBatch()` calls. Recipients already paid are not recorded as completed, so remaining stock can enter a later cycle and be shared again — a silent transfer from the unpaid to the paid.

`src/VaultGuardian.sol` exists to refuse exactly that call and is **deliberately not installed**; `isInstalled()` currently returns false. Note that installing it makes the guardian the vault’s `owner()`, so `emergencyWithdrawERC20` would deliver to the guardian and leave via `sweepERC20` — one extra hop, not a lost capability.

**Fix:** install the guardian, or allow abort only when `cursor == 0`, or persist remaining liabilities.

### 4. Paginated snapshot is not atomic — high fairness risk

`snapshotHolders(count)` reads the token’s mutable swap-and-pop registry across several transactions. Transfers during capture change indices. The vault deduplicates seen addresses and applies the live-balance clamp, but this is not an atomic snapshot.

**Fix:** while the holder count is safely bounded, prefer a single-transaction snapshot. Before scaling, implement a real checkpoint design.

### 5. Hook scope is not pinned to the intended STFY pool — permanent

`StockifyFeeHook` checks only that `currency0` is native ETH. It does not enforce `currency1 == STFY`, the pool fee or the tick spacing, so any v4 pool naming this hook forwards 3% of its ETH volume to the vault.

This is not loss-of-funds — the fee reaches the vault either way — but it means the hook cannot be presented as scoped to one market. **The hook is deployed and immutable, so this cannot be narrowed.** A future generation would need a new hook, a new CREATE2 mine and a new pool.

### 6. Deployment role assignment — RESOLVED

The script now accepts a dedicated `KEEPER`, sets it before transferring ownership, and refuses a deployer-owned or deployer-keyed deployment unless `ALLOW_HOT_KEY_OWNER=1` is passed explicitly.

### 7. One key may be both keeper and index administrator — verify

`keeper-indices` assumes the vault keeper runs on the same account. If that is still true, one key is simultaneously the vault’s execution role and the index treasuries’ **administrative** role (exclusions, dust floor, pause, rescue, ownership).

**Fix:** confirm the current assignment on-chain and separate the two if they are shared.

---

## Operational constraints that are not bugs

- Both keepers skip work rather than guess. The vault keeper skips a full purchase if any active B20 asset has no complete route, or if any entry’s decimals cannot be read; hook ETH stays in the vault for a later attempt.
- The owner has no direct withdrawal path for non-fee ETH. It **does** have `emergencyWithdrawERC20`.
- A threshold change is reflected for an account when it next transfers or its exclusion is changed.
- Index rounds and buys are gated on dollar value, so a quiet treasury will correctly appear to do nothing for long stretches.

---

## Verification

```text
forge test --no-match-path 'test/*fork*'
139 passed, 0 failed

web:  npx tsc --noEmit && npx next build     passes, 28 routes
      npx tsx scripts/check-index-calldata.ts  passes
keeper, keeper-indices:  npx tsc --noEmit    passes
```

`test/BuyImpact.t.sol` is a fork test and additionally requires `BASE_RPC`; without it the suite reports one failure in `setUp`.

Passing tests are not a replacement for the open constraints above or an independent audit.

---

## Relevant files

```text
src/StockifyToken.sol            Token and holder registry
src/StockifyFeeHook.sol          Uniswap v4 hook
src/DividendVault.sol            Fee custody, B20 acquisition and payout state machine
src/StockifyRouter.sol           Public buy/sell router for the ETH/STFY pool
src/VaultGuardian.sol            Optional abort rail (not installed)
src/indices/IndexFactory.sol     Mints one treasury per launch; venue/keeper/fee config
src/indices/IndexTreasury.sol    Harvest, swap, distribute or buyback-and-burn
script/Deploy.s.sol              Base deployment script
test/                            Contract tests, including gas benchmarks
keeper/src/keeper.ts             Vault execution loop
keeper/src/route.ts              Self-built Slipstream route
keeper/src/velora.ts             Aggregator route construction
keeper-indices/src/keeper.ts     Indices execution loop
web/lib/                         Chain readers: rpc, vault, indices, ledger, decimals
web/app/docs/page.tsx            Public protocol docs
README.md                        Repository overview
```
