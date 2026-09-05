# Stockify — `$STFY`

**Stock dividend protocol for Coinbase L2’s tokenized stocks.**

Stockify is a fixed-supply ERC-20 on Base. Its `ETH/STFY` Uniswap v4 pool charges a **3% ETH hook fee** on each buy and sell. A keeper uses **90%** of each allocated fee to buy the owner-configurable active B20 stock index; the remaining **10% of the hook fee** is protocol revenue. Every stock balance is pushed directly to STFY holders, pro-rata, with at least one hour between distribution-cycle starts.

`1%` is the LP fee configured on the v4 pool. It is separate from the `3%` hook fee.

This repository also contains **Indices**, a second product that turns another launch’s creator fees into equity for that coin’s holders, or into a buyback and burn. Its roles are deliberately different from the vault’s — see [Indices](#indices).

> Deployed and live on Base. Not audited: this code has unit tests and has been in production use, but it has had no independent security review and no legal or compliance review.

## Economics

| Flow | Share of trading volume |
| --- | ---: |
| Uniswap v4 LP fee | 1.00% |
| Stockify hook fee | 3.00% |
| B20 stock purchases | 2.70% |
| Stockify protocol revenue | 0.30% |

The `0.30%` protocol revenue is 10% of the 3% hook fee, not an additional charge. It accrues on ETH actually spent on stock, not on ETH merely made available.

## Architecture

```text
trade ETH / STFY on Uniswap v4
                 │
                 │ 3% native ETH hook fee, both directions
                 ▼
          DividendVault
          ├─ 10% of allocated fee → platformClaimable
          └─ 90% → an owner-allowlisted venue → active B20 stock index
                                                 │
                                                 │ hourly keeper payout
                                                 ▼
                                  STFY holders, pro-rata in each stock
```

### Contracts

- `src/StockifyToken.sol` — fixed `1,000,000,000 STFY` ERC-20 supply with an on-chain eligible-holder registry. Its owner can set the registry threshold only from `10,000` to `100,000 STFY` and can manage reward exclusions.
- `src/StockifyFeeHook.sol` — Uniswap v4 hook that takes exactly 3% in native ETH and forwards it to the vault. Its CREATE2 address is mined for the necessary v4 permission flags.
- `src/DividendVault.sol` — owner-configurable B20 buy index, keeper-only buys through an owner-curated venue allowlist, 10% platform fee accounting, on-chain holder snapshots, and batched push payouts.
- `src/StockifyRouter.sol` — stateless buy/sell router for the ETH/STFY pool. It exists because aggregators will not route a pool whose hook is not on their allowlist. It holds no funds and has no owner.
- `src/VaultGuardian.sol` — an optional owner wrapper that refuses `abortCycle()` on a partially paid cycle. **Deliberately not installed**; see [Known constraints](#known-constraints).
- `src/indices/` — the Indices product. See below.

There is no owner or keeper withdrawal path for ETH reserved to buy stocks. The owner has an explicit emergency ERC-20 recovery path (including B20 stocks), while the platform recipient can claim only the accrued 10% fee.

### How a purchase reaches a venue

The vault stores **no router address**. B20 equity depth moves between venues, so instead of pinning one, the owner curates an allowlist with `setSwapTarget(target, allowed)` and the keeper names one of those per leg.

Listing a venue grants no custody. For each leg the vault sizes the input itself, writes that amount into the route’s own calldata at a supplied byte offset, approves exactly that amount, calls the venue, and revokes the approval in the same transaction. The result is judged purely by balance deltas. A listed venue can therefore make a leg fail; it cannot take more than that leg’s input.

## The B20 index

The active index is **read from the chain**, never from this file: `stocksLength()` and `stockAt(i)` are the source of truth, and the owner can replace the index and its weights atomically between cycles. Any asset ever admitted remains eligible for distribution, so removing it from future buys cannot strand stock already held by the vault.

`script/Deploy.s.sol` seeds **five** of them at equal weight — `NVDAc`, `AAPLc`, `GOOGLc`, `METAc` and `SPCXc`, `2,000 bps` each, totalling exactly `10,000 bps`. It seeds only those five because the keeper skips the *entire* purchase when any active asset lacks a complete route, so a name with no supply or no Aerodrome Slipstream USDC pool would stall every buy rather than just its own leg. The full catalogue Coinbase has listed on Base is:

| Symbol | Company | B20 address |
| --- | --- | --- |
| NVDAc | NVIDIA | `0xb20000000000000000000078ee7ce2fe4908108c` |
| AAPLc | Apple | `0xb200000000000000000000c2e324d24d7eecd1fb` |
| GOOGLc | Alphabet | `0xb2000000000000000000002d0ba3164cc74f58b7` |
| METAc | Meta Platforms | `0xb2000000000000000000008bc8786b856e61707c` |
| AMZNc | Amazon | `0xb200000000000000000000d9192b6b456483c2e8` |
| COINc | Coinbase Global | `0xb200000000000000000000c85a31389d71f3ecfb` |
| CRCLc | Circle Internet Group | `0xb20000000000000000000019f6e7c675b73c2e4d` |
| INTCc | Intel | `0xb2000000000000000000004aff16039ba04bdfbc` |
| MSFTc | Microsoft | `0xb200000000000000000000ab99cfa739e253872b` |
| MSTRc | Strategy | `0xb2000000000000000000004884b426556b92883d` |
| SNDKc | SanDisk | `0xb200000000000000000000397293cb8cda9a10c5` |
| SPCXc | SpaceX | `0xb2000000000000000000007b9fcbd005511acbd5` |
| TSLAc | Tesla | `0xb2000000000000000000001e800a7f5189430cd0` |

**This table is the catalogue, not the live index, and not the deploy seed either.** The website reads the vault directly for exactly this reason. Admitting one of the remaining names is `setIndex` plus a `inIndex: true` in `web/lib/stocks.ts` — see `script/SetIndex.s.sol`, which prints the calldata and dry-runs the rotation.

The vault validates ERC-20 read compatibility rather than `extcodesize`: B20 assets are Base Rust precompiles and are not assumed to expose normal EVM bytecode. B20 remains ERC-20-compatible, but can enforce sender/receiver transfer policies. The vault uses raw ERC-20 `balanceOf`/`transfer` units, never the separate B20 UI-scaled display methods. A rejected dividend transfer is skipped rather than blocking the round; its exact share stays attributed to that holder and is retried later, never redivided to other holders.

## Payout model

Payouts are deliberately **push**, as opposed to a Merkle claim system:

1. `StockifyToken` maintains its own holder array on every transfer; only balances at or above the configured threshold are registered.
2. The keeper calls `snapshotHolders(count)` until the entire registry is captured, then calls `startCycle()`.
3. The vault freezes the B20 pots and sends `pot × min(snapshotBalance, liveBalance) / eligibleSupply` in `distributeBatch(count)` calls.

This makes the recipient set fully on-chain: the keeper proposes prices and submits transactions but never supplies a holder list. Snapshotting is keeper-gated and payout clamps the snapshot weight to live balance, preventing a balance borrowed only for the snapshot from being paid after it has been returned. A paginated snapshot is not a single-block atomic snapshot: transfers can mutate the swap-and-pop holder registry between keeper calls, so that window is an operationally sensitive period even though the vault deduplicates addresses seen in the current epoch.

The token starts with a `100,000 STFY` eligibility threshold; the owner can change it only within `10,000–100,000 STFY`. It can also use `setRewardsExcluded`. Those controls are an explicit governance trust assumption: an excluded wallet is absent from subsequent snapshots. Infrastructure addresses are excluded during deployment. A threshold change is reflected when an account next transfers (or its exclusion status is changed), mirroring the reference token’s low-gas registry model.

B20 transfers that fail receiver policy checks do not brick a batch. The exact failed entitlement is stored for the holder and may be retried with `flushUnpaidDividend`.

## Indices

`src/indices/` is a separate product. A coin launched elsewhere points its creator fee stream at a treasury minted by `IndexFactory`; from then on those fees buy tokenized equity that is pushed to that coin’s holders (`mode 0`), or buy the coin back and burn it (`mode 1`). One EIP-1167 clone per coin, with a CREATE2 address that is known before anything is deployed — which is what lets a creator name it in a launch that has not happened yet.

Every harvest is split platform fee first, then `creatorShareBps` of the remainder, then the rest to holders. The platform fee is read from the factory on every use and is capped at 20% in the factory’s code. The creator’s accrual is fenced from the buy path in both directions.

**Its roles are not the vault’s, and the difference matters:**

| | DividendVault | IndexTreasury |
| --- | --- | --- |
| Configuration, pause, rescue | Owner | **Keeper** |
| Exclusions, dust floor | Owner | **Keeper** |
| Buys and payouts | Keeper | Keeper |
| Creator / coin owner | — | **No powers at all** |

A creator points their launch’s fees at a treasury and their involvement ends there. That is deliberate: `coin` is what the payout denominator is read over, so an owner able to configure the treasury could shape or freeze its holders’ payouts.

Two tiers of promise, and the default is the weaker one. A launchpad pays whoever a coin’s creator **split** names and falls back to the creator **role** only when no split is set. A launch that names a treasury as its fee recipient produces the first, which the launching wallet can point back at itself at any time. `bindIsPermanent` records which one was in force at bind, and `feeRecipientNow()` re-derives it live so the site can report a stream that has since been pointed away.

Clones are never upgraded. `setImplementation()` affects future clones only.

## Shop

A third product, and the only one with no contract of its own: a storefront at **`/shop`** for gift cards, eSIM data and mobile top-ups across 2,000+ brands, paid for with the tokenized stock this protocol distributes. Fulfilment is [CryptoRefills](https://www.cryptorefills.com); the payment is ours.

It exists because a dividend arrives as a fraction of a share of Apple, and a fraction of a share of Apple is not something anybody can spend. This is where it becomes an Apple gift card.

```text
web/lib/shop/          supplier client, pricing rules, settlement, order ledger
web/app/api/shop/      quote, order, order/[id], search, esim, pay
web/app/shop/         storefront, catalogue, product page, eSIM, top-ups, order tracker, admin ledger
web/app/components/shop/
```

**There is no bridge, and that is the whole design.** CryptoRefills settles in a fixed list of coins and networks, and USDC on Base is one of them — the chain this protocol already runs on. So an order is paid by one ordinary Base transaction: an **exact-output** swap through Velora that sells the buyer's stock and delivers the precise figure the order needs straight to the order's own deposit address. The site never takes custody, and there is no floor to check afterwards, because an exact-output trade delivers the amount or reverts.

`/api/shop/pay` is where that is enforced. The source must be on the pay-with allowlist and its decimals come from there rather than from the request — the equities are 8-decimal tokens, and a client-supplied 18 would quote a payment a hundred million times too large. The destination is pinned to the settlement asset. The receiver must be given and is checked again against the calldata that comes back: a quote built without one pays the sender, the transaction succeeds, the buyer is told it worked, and the order is never paid.

**What can be paid with is deliberately short**: the B20 equities the vault actually distributes, `STFY`, and the two cash legs. The list is derived from index membership rather than maintained separately, and membership is the stronger test — several catalogued equities now have supply and still have no pool to route through, so offering one would be offering a payment that cannot be made.

**`STFY` is two transactions, on purpose.** An aggregator will quote it against USDC and route through a pool holding a few hundred dollars, next to the STFY/ETH pool holding tens of thousands. That pool also cannot carry the hook, which only fires when `currency0` is native ETH — so selling there would pay the vault nothing. Instead `StockifyRouter` sells STFY into ETH at the real pool, paying the same 3% hook fee as any other sale, and the ETH pays the order. The sale's `minOut` is set to what the second step spends, so if the first transaction succeeds the second is provably payable; whatever ETH is left over stays in the buyer's wallet.

**Two upstream quirks cost the buyer money if handled naively**, and both are enforced in one place, `lib/shop/cryptorefills.ts`: range-priced products must be ordered as `denomination: "range"` plus `product_value` (sending the literal `"100 USD"` resolves to a different, dearer product), and everything else must quote the supplier's own denomination string verbatim. `selectPurchase()` snaps a request onto something actually on sale and reports whether it had to move; `POST /api/shop/order` refuses with a 409 rather than charging for something the buyer did not pick.

`CRYPTOREFILLS_PARTNER_ID` carries the commission and the supplier does not enforce it, which makes a missing one silent and expensive — so ordering refuses with a 503 rather than selling unattributed. `DATABASE_URL` is an optional ledger that stores no redeem codes, since those are bearer instruments. `ADMIN_TOKEN` guards `/shop/admin/orders`; unset, that page 404s rather than defaulting open. Every variable is documented in [`web/.env.example`](web/.env.example).

## Base dependencies

- Base mainnet: chain ID `8453`
- v4 PoolManager: `0x498581fF718922c3f8e6A244956aF099B2652b2b`

The PoolManager address is from [Uniswap’s Base v4 deployment reference](https://developers.uniswap.org/docs/protocols/v4/deployments#base-8453). B20 semantics and transfer policies are based on the [Base B20 specification](https://docs.base.org/base-chain/specs/upgrades/beryl/b20/specification).

Swap venues are not a dependency of this repository — they are an owner allowlist on the deployed vault and factory. Read the live state from the contracts.

Deployed addresses are published on the site’s `/docs` page, which reads them from the same configuration the application is built against so the two cannot disagree.

## Development

```bash
# contracts
forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts Uniswap/v4-core Uniswap/v4-periphery
forge test

# keeper (STFY dividend vault)
cd keeper && npm install && cp .env.example .env && npm run once

# keeper (indices)
cd keeper-indices && npm install && cp .env.example .env && npm run once

# web (protocol pages, and the shop at /shop)
cd web && npm install && cp .env.example .env.local && npm run dev
```

`forge test` runs 139 tests. `test/BuyImpact.t.sol` is a fork test and additionally requires `BASE_RPC`.

The Foundry deployment script uses Base defaults and embeds the B20 list:

```bash
export PRIVATE_KEY=0x...
export PROTOCOL_OWNER=0x...      # must be a contract, unless ALLOW_HOT_KEY_OWNER=1
export KEEPER=0x...              # dedicated key, not the deployer
export PLATFORM_RECIPIENT=0x...
forge script script/Deploy.s.sol:Deploy --rpc-url base --broadcast
```

The deploy script intentionally does **not** initialize a v4 pool. It configures both contracts, seeds the venue allowlist and sets the keeper first, then transfers ownership to `PROTOCOL_OWNER`. Initial price, LP allocation and route validation are separate, deliberate transactions.

## Known constraints

These are current properties of the deployed code, not oversights that have been fixed elsewhere.

- **The keeper is a material execution role.** `buyStocks` forwards keeper-supplied route calldata and keeper-supplied minimum outputs. The vault measures the spend and the fill rather than trusting them, and each venue receives only one leg’s approval, revoked in the same call — so the keeper cannot move funds to itself. What it can do is accept a poor fill at a listed venue, which makes the owner’s allowlist the real bound on execution.
- **`maxGrossSpendPerCycle` limits one `buyStocks` call**, not the total across a calendar cycle. The deployment default is `0.25 ETH`.
- **`abortCycle()` clears a snapshot and cycle state** without recording who has already been paid, so it must not be used for a partially paid cycle. `VaultGuardian` exists to refuse exactly that call and is deliberately not installed; check `isInstalled()` before assuming it is.
- **The hook is not pinned to one pool.** `StockifyFeeHook` checks only that `currency0` is native ETH, so any v4 pool naming it will forward 3% of its ETH volume to the vault. The hook is immutable, so this cannot be narrowed after deployment.
- **The owner is a material trust role.** It cannot withdraw non-fee hook ETH, but it can emergency-withdraw ERC-20 custody — including stock already bought for holders — to itself, and it controls the eligibility threshold, reward exclusions, the venue allowlist, the keeper, the platform recipient and the spend cap. The deploy script requires a contract owner unless `ALLOW_HOT_KEY_OWNER=1` is set.
- **Paginated snapshots are not atomic.** See [Payout model](#payout-model).
- **No audit.** No independent security review, no legal or compliance review. B20 transfer policy and jurisdictional eligibility need validation.
