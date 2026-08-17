# Stockify — engineering handoff

**Repository:** `onlytrifiz/stockify-protocol`  
**Branch:** `main`  
**Latest commit at handoff:** `e4328f1 Refine public protocol documentation`  
**Status:** pre-launch; do **not** deploy the current contracts as the final mainnet protocol.

Stockify is a Base protocol for routing an ETH/STFY Uniswap v4 hook fee into purchases of Base B20 tokenized stocks, then pushing those stock balances pro rata to eligible STFY holders.

---

## What is implemented

| Module | Source | Current behavior |
| --- | --- | --- |
| STFY token | `src/StockifyToken.sol` | Fixed supply of `1,000,000,000 STFY`; on-chain eligible-holder registry. |
| Fee hook | `src/StockifyFeeHook.sol` | Collects `300 bps` native ETH in the intended ETH/STFY v4 pool and forwards it to the vault. |
| Dividend vault | `src/DividendVault.sol` | Accounts for hook ETH, buys B20 assets, snapshots holders and sends batched push payouts. |
| Keeper | `keeper/src/keeper.ts` | Gets routes off-chain and executes vault buys / snapshots / payouts. It does not provide the holder list. |
| Deploy script | `script/Deploy.s.sol` | Deploys token, vault and CREATE2-mined hook on Base. It deliberately does not initialize a pool or add liquidity. |
| Web app | `web/` | Next.js public site with market, distributions, protocol and public documentation pages. |

The public documentation is at `/docs`; it describes protocol behavior only. Frontend service configuration is deliberately not shown there.

---

## Intended economics

| Item | Rate | Destination |
| --- | ---: | --- |
| v4 LP fee | 1.00% | Liquidity providers; pool configuration, separate from Stockify hook. |
| Stockify hook fee | 3.00% | Native ETH sent to `DividendVault`. |
| Stock purchase budget | 2.70% of volume | 90% of the hook-fee allocation. |
| Protocol revenue | 0.30% of volume | 10% of the hook-fee allocation, recorded as `platformClaimable`. |

The vault uses the active index weights to divide the stock-purchase budget. The owner can replace the active buy index only outside a pending snapshot or active distribution cycle. Assets that were ever admitted remain in the distribution set so balances already acquired are not automatically stranded after an index change.

---

## Token and payout model

- Supply: `1,000,000,000 STFY`.
- Initial dividend eligibility threshold: `100,000 STFY`.
- Owner-configurable threshold range: `10,000–100,000 STFY`.
- `StockifyToken` keeps its own enumerable holder registry using `holderCount()` and `holderAt(i)`.
- Payouts are **push**, not Merkle claims.
- The holder payout formula is:

```text
stock pot × min(snapshot balance, live balance) ÷ eligibleSupply
```

- The live-balance clamp means a holder who sells after capture receives no more than their remaining balance weight.
- A B20 transfer that fails receiver-policy checks is recorded as `unpaidDividend`; anyone may retry the exact entitlement via `flushUnpaidDividend(holder, stock)`.

### Distribution state flow

```text
hook ETH in DividendVault
        │
        ├── keeper: buyStocks(...)
        │       ├── 10% → platformClaimable
        │       └── 90% → active B20 index
        │
        ├── keeper: snapshotHolders(count) [optional pages]
        ├── keeper: startCycle()
        └── keeper: distributeBatch(count) [pages]
```

`startCycle()` sets `nextDistribution` to one hour after its start. Stock-buy execution is keeper-driven and is not independently rate-limited by that interval.

---

## Initial B20 universe

The deploy script contains thirteen Base B20 assets:

`NVDAc`, `AAPLc`, `GOOGLc`, `METAc`, `AMZNc`, `COINc`, `CRCLc`, `INTCc`, `MSFTc`, `MSTRc`, `SNDKc`, `SPCXc`, `TSLAc`.

Initial weights are effectively equal: the first twelve assets are `769 bps`; `TSLAc` receives the `772 bps` remainder, for a total of `10,000 bps`. Addresses and the exact initialization are in `script/Deploy.s.sol`.

The B20 assets are validated via ERC-20 reads rather than normal EVM bytecode checks because B20 assets are Base Rust precompiles. B20 sender/receiver transfer policies must be validated before a live launch.

---

## Deployment dependencies

| Dependency | Base mainnet value |
| --- | --- |
| Chain ID | `8453` |
| Uniswap v4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` |
| Uniswap Universal Router | `0x6fF5693b99212Da76ad316178A184AB56D299b43` |
| Pool initialization | Intentionally not in the deploy script. |

The current script requires `PRIVATE_KEY`; it optionally accepts `PROTOCOL_OWNER`, `PLATFORM_RECIPIENT`, `POOL_MANAGER`, `UNIVERSAL_ROUTER` and `MAX_GROSS_SPEND_PER_CYCLE`.

**Do not use an EOA as the final `PROTOCOL_OWNER`.** Use a multisig. Never commit, paste into this repository or add private keys/API secrets to a handoff document.

---

## Mainnet blockers — must fix before final deployment

### 1. Raw Universal Router calldata is a custody risk — critical

`DividendVault.buyStocks()` forwards keeper-controlled raw calldata to the Universal Router. The router address is immutable, but that does not constrain the router commands or recipient contained in calldata. A compromised keeper can potentially use router commands to move vault ETH away while satisfying a keeper-selected minimal output.

**Required fix:** replace raw router forwarding with a restricted adapter or strict calldata decoding / allowlist. Enforce route targets, `recipient == vault`, ETH input amount, expected B20 output, deadline and permitted commands. The keeper should supply typed trade parameters, not arbitrary router bytes.

### 2. Spend cap is per call, not per cycle — high

`maxGrossSpendPerCycle` is applied in each call to `buyStocks()`. A keeper can call it repeatedly, so it is not a calendar-hour or distribution-cycle limit.

**Required fix:** track a spend epoch / rolling window on-chain and enforce the cumulative cap, or make buying callable only once for each distribution epoch.

### 3. Partial-cycle abort changes payout economics — high

`abortCycle()` can clear state after one or more `distributeBatch()` calls. Recipients already paid are not recorded as completed for the next cycle; remaining stock balances can enter a later cycle and be shared again.

**Required fix:** allow abort only when `cursor == 0`, or persist the remaining liabilities so abort cannot redivide assets already allocated in a partially executed cycle.

### 4. Paginated snapshot is not atomic — high fairness risk

`snapshotHolders(count)` reads the token’s mutable swap-and-pop holder registry across multiple transactions. Transfers during capture can change indices. The vault deduplicates seen addresses and uses a live-balance clamp, but this is not an atomic snapshot.

**Required fix:** for early launch, use a single-transaction snapshot only while the holder count is safely bounded. Before scaling, choose and implement a robust checkpoint/snapshot design; do not rely on the current paginated process as an atomic entitlement snapshot.

### 5. Hook scope is not pinned to the intended STFY pool — hardening required

`StockifyFeeHook` currently checks only that `currency0` is native ETH. It does not enforce `currency1 == STFY`, pool fee or tick spacing.

**Required fix:** make the intended STFY token and pool configuration immutable constructor values, then reject all other `PoolKey`s.

### 6. Production role assignment needs deployment-script support

The script initially enables the broadcaster as keeper and only afterward transfers ownership. It does not accept a dedicated `KEEPER` address.

**Required fix:** add an explicit `KEEPER` constructor/deployment environment value, set it before ownership transfer, and avoid leaving the deployer hot key active. Final owner and platform recipient should be deliberate multisig addresses.

---

## Operational constraints that are not loss-of-funds bugs

- The keeper supplied in this repository skips a full purchase if any active B20 asset has no complete route. Hook ETH remains in the vault for a later attempt; it is not converted or distributed as another asset.
- There are no public STFY pool parameters, liquidity or price in the deployment script. A separate, deliberate transaction must initialize and seed the pool.
- The owner has no direct withdrawal path for non-fee ETH. The owner **does** have `emergencyWithdrawERC20`, which can retrieve all ERC-20 custody including B20 dividend assets. This is an explicit governance trust assumption.
- The owner controls the eligibility threshold and `rewardsExcluded`; a threshold change is reflected for an account when it next transfers or its exclusion is changed.

---

## Suggested safe release sequence

1. Implement the six blocker fixes above and add focused regression tests for each one.
2. Run an independent Solidity security audit and remediate its findings.
3. Deploy and exercise the full system on a Base test environment or controlled fork:
   - hook fee on both trade directions;
   - B20 purchase adapter restrictions;
   - failed B20 receiver-policy payout;
   - holder snapshot under transfers;
   - partial payout recovery;
   - owner / keeper rotation.
4. Select final multisig owner, platform recipient and dedicated keeper addresses.
5. Deploy token, vault and hook together; verify source and publish addresses.
6. Configure the intended STFY pool, initial price and LP position in a separate transaction.
7. Validate every active B20 route and receiver policy with production-sized quotes before enabling the keeper.
8. Start with a conservative, **on-chain cumulative** spend cap and monitoring/alerting for keeper buys and payout failures.
9. Publish contract addresses, operator policy and the first completed distribution transaction on the website.

---

## Verification performed at handoff

```text
forge test
15 passed, 0 failed

cd web && npm run build
passed; /docs prerenders successfully
```

Passing tests are not a replacement for the blocker fixes or an independent audit.

---

## Relevant files

```text
src/StockifyToken.sol             Token and holder registry
src/StockifyFeeHook.sol           Uniswap v4 hook
src/DividendVault.sol           Fee custody, B20 acquisition and payout state machine
script/Deploy.s.sol             Base deployment script
test/StockifyToken.t.sol          Token tests
test/DividendVault.t.sol        Vault tests
keeper/src/keeper.ts            Off-chain execution loop
keeper/src/uniswap.ts           Quote / route construction
web/app/docs/page.tsx           Public protocol docs
web/app/protocol/page.tsx       Public protocol summary
README.md                       Developer and repository overview
```
