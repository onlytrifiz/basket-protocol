# Basket — `$BASKET`

**Stock dividend protocol for Coinbase L2’s tokenized stocks.**

Basket is a fixed-supply ERC-20 on Base. Its single `ETH/BASKET` Uniswap v4 pool charges a **3% ETH hook fee** on each buy and sell. A keeper uses **90%** of each allocated fee to buy the fixed B20 stock basket; the remaining **10% of the hook fee** is protocol revenue. Every stock balance is pushed directly to BASKET holders, pro-rata, no more frequently than once per hour.

`1%` is the LP fee configured on the v4 pool. It is separate from the `3%` hook fee.

> Pre-launch implementation. The B20 stock contracts exist, but their public liquidity routes are not available yet. The keeper will leave ETH untouched whenever it cannot obtain a complete Uniswap route for the entire fixed basket.

## Economics

| Flow | Share of trading volume |
| --- | ---: |
| Uniswap v4 LP fee | 1.00% |
| Basket hook fee | 3.00% |
| B20 stock purchases | 2.70% |
| Basket protocol revenue | 0.30% |

The `0.30%` protocol revenue is 10% of the 3% hook fee, not an additional charge.

## Architecture

```text
trade ETH / BASKET on Uniswap v4
                 │
                 │ 3% native ETH hook fee, both directions
                 ▼
          DividendVault
          ├─ 10% of allocated fee → platformClaimable
          └─ 90% → official Base Universal Router → B20 stock basket
                                                     │
                                                     │ hourly keeper payout
                                                     ▼
                                      BASKET holders, pro-rata in each stock
```

### Contracts

- `src/BasketToken.sol` — fixed `1,000,000,000 BASKET` ERC-20 supply with an on-chain eligible-holder registry. Its owner can set the registry threshold only from `10,000` to `100,000 BASKET` and can manage reward exclusions.
- `src/BasketFeeHook.sol` — Uniswap v4 hook that takes exactly 3% in native ETH and forwards it to the vault. Its CREATE2 address is mined for the necessary v4 permission flags.
- `src/DividendVault.sol` — fixed B20 basket, keeper-only buys through the **pinned** Base Universal Router, 10% platform fee accounting, on-chain holder snapshots, and batched hourly push payouts.

There is no owner or keeper withdrawal path for ETH reserved to buy stocks. The owner multisig has an explicit emergency ERC-20 recovery path (including B20 stocks), while the platform recipient can claim only the accrued 10% fee.

## Initial B20 basket

The deployment configures these thirteen Base B20 assets at effectively equal weight (twelve at `769 bps`, TSLA at `772 bps` to make the total exactly `10,000 bps`). The owner multisig can later replace the active buy basket and weights atomically. Any asset ever admitted remains eligible for distribution, so removing it from future buys cannot strand stock already held by the vault.

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

The vault validates ERC-20 read compatibility rather than `extcodesize`: B20 assets are Base Rust precompiles and are not assumed to expose normal EVM bytecode. B20 remains ERC-20-compatible, but can enforce sender/receiver transfer policies. The vault uses raw ERC-20 `balanceOf`/`transfer` units, never the separate B20 UI-scaled display methods. A rejected dividend transfer is skipped rather than blocking the round; its exact share stays attributed to that holder and is retried later, never redivided to other holders.

## Payout model

Payouts are deliberately **push**, as opposed to a Merkle claim system:

1. `BasketToken` maintains its own holder array on every transfer; only balances at or above the configured threshold are registered.
2. The keeper calls `snapshotHolders(count)` until the entire registry is captured, then calls `startCycle()`.
3. The vault freezes the B20 pots and sends `pot × min(snapshotBalance, liveBalance) / eligibleSupply` in `distributeBatch(count)` calls.

This makes the recipient set fully on-chain: the keeper proposes prices and submits transactions but never supplies, omits, or orders a holder list. Snapshotting is keeper-gated and payout clamps the snapshot weight to live balance, preventing a balance borrowed only for the snapshot from being paid after it has been returned.

The token starts with a `100,000 BASKET` eligibility threshold; the owner multisig can change it only within `10,000–100,000 BASKET`. It can also use `setRewardsExcluded`, as in the reference Index token. Those controls are an explicit governance trust assumption: an excluded wallet is absent from subsequent snapshots. Infrastructure addresses are excluded during deployment. A threshold change is reflected when an account next transfers (or its exclusion status is changed), mirroring the reference token’s low-gas registry model.

B20 transfers that fail receiver policy checks do not brick a batch. The exact failed entitlement is stored for the holder and may be retried with `flushUnpaidDividend`.

## Base dependencies

- Base mainnet: chain ID `8453`
- v4 PoolManager: `0x498581fF718922c3f8e6A244956aF099B2652b2b`
- v4 Universal Router: `0x6fF5693b99212Da76ad316178A184AB56D299b43`

Addresses are from [Uniswap’s Base v4 deployment reference](https://developers.uniswap.org/docs/protocols/v4/deployments#base-8453). B20 semantics and transfer policies are based on the [Base B20 specification](https://docs.base.org/base-chain/specs/upgrades/beryl/b20/specification).

## Development

```bash
# contracts
forge install --no-git foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts Uniswap/v4-core Uniswap/v4-periphery
forge test

# keeper
cd keeper
npm install
cp .env.example .env
npm run once       # set DRY_RUN=1 while public stock routes are unavailable

# web
cd ../web
npm install
npm run dev
```

The Foundry deployment script uses Base defaults and embeds the B20 list:

```bash
export PRIVATE_KEY=0x...
export PROTOCOL_OWNER=0x...      # required production multisig
export PLATFORM_RECIPIENT=0x...
forge script script/Deploy.s.sol:Deploy --rpc-url base --broadcast
```

The deploy script intentionally does **not** initialize a v4 pool. It configures both contracts first, then transfers ownership to `PROTOCOL_OWNER`. Decide initial price, LP allocation, keeper key, and public route validation separately before the later pool-initialization and liquidity transaction.

## Security notes

- The Universal Router address is immutable. The keeper supplies only the Trading API calldata and minimum output floors.
- The vault measures each stock balance delta and rejects an output below its `minOut`.
- `maxGrossSpendPerCycle` limits a compromised keeper’s native ETH exposure per cycle; the deployment default is `0.25 ETH` and should be reviewed before launch.
- The owner cannot withdraw hook ETH. It can emergency-withdraw ERC-20 custody — including stock dividends — to the owner multisig. It controls the dividend threshold and reward exclusions, and can rotate a keeper, platform recipient, spend cap, and contract-only exclusions.
- This code has unit tests, but has **not** undergone a professional security audit or legal/compliance review. B20 transfer policy and jurisdictional eligibility need validation before launch.
