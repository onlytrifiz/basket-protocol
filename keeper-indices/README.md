# Baskets keeper

Runs the cycle for every basket [`BasketFactory`](../contracts/src/baskets/BasketFactory.sol) has
minted: pull the launch's creator fees, buy each name of the basket through an allowlisted venue on a 0x quote, and push
what was bought to the coin's holders.

Separate service from [`../keeper`](../keeper), which buys backing for the $BACKED vault. Different
contracts, different cadence, different failure modes — one falling over must not take the other with
it.

## What it can and cannot do

The treasury does not trust this process with funds, and that is not a formality:

- `swap()` only reaches a venue the factory has allowlisted, can only buy tokens already in the
  basket, can never sell a stock back out, and the quote actually spent is **measured** against what
  the keeper declared.
- `distribute()` reads every payout weight from `balanceOf(coin)` on-chain. The keeper chooses who is
  *included*, never how much anyone gets, and the list must be strictly ascending so no address can
  appear twice.
- The one thing a hostile keeper could still do is accept a bad fill inside its own slippage, which
  is the standing cost of having no price oracle.

## Running it

```bash
cp .env.example .env      # fill in RPC_URL, KEEPER_PRIVATE_KEY, INDEX_FACTORY
npm install
npm run status            # read-only: prints what a cycle would do, sends nothing
npm run once              # one cycle
npm start                 # loop
```

`npm run status` is the one to reach for when something looks wrong — it walks every basket and
prints the decisions without spending gas.

## Railway

A second service on the same repo, alongside the existing keeper:

1. **New Service → GitHub repo**, then set **Root Directory** to `keeper-baskets`.
2. `railway.json` here already sets Nixpacks, `npm start`, and restart-on-failure.
3. Add the variables from `.env.example`.
4. **Keep replicas at 1.** Two instances race on the same round: both open batches against the same
   cursor and one of them just burns gas on reverts.

### Before it will do anything

The keeper wallet must be authorised on-chain, or every swap and payout reverts one at a time while
the logs look perfectly healthy:

```bash
cast send $INDEX_FACTORY "setKeeper(address,bool)" $KEEPER_ADDRESS true --private-key $OWNER_KEY
```

The keeper refuses to start if it is not authorised, and prints the exact command. It also refuses to
start with a zero gas balance. Fund it with ETH for gas only — it never holds fees or stock.

## The decisions it makes

**When to buy.** A name is only bought once *its own slice* of the pending fees is worth
`MIN_ROUND_ETH` (0.01 ETH by default). The gate is per name, not per round, because a payout costs
gas per name per holder: one 500-holder payout runs about 0.001 ETH, which is what the platform fee
on 0.01 ETH covers. A four-name basket paying all four costs four times that against the same fee. A
small weight simply pays less often, which is the right answer.

**Who gets paid.** Holders from the explorer's index — no ERC20 can enumerate its own holders, so
this is the one part of a round that depends on a third party. If it is unavailable the round is
skipped and nothing is lost; the stock waits. The list is then filtered (the treasury, the coin, dead
and zero, plus whatever holds the coin without being a holder of it), dropped below the contract's
`minHolderBalance`, and sorted ascending.

That last part depends on the launchpad. A the launchpad coin's liquidity sits in the v4 PoolManager — one
address for every launch, excluded globally — alongside the coin's own bonding curve. A pools.fun
launch shares nothing: it gets a Uniswap v3 pool of its own, which has to be looked up per coin and
is always the largest holder of the coin, and the locker holds the position NFTs and any coin-side
fees not yet claimed. Miss either and the round goes back to the liquidity it came out of.

**Finding the coin.** A basket is created before it is bound, so the keeper has to work out which
coin an unbound treasury is collecting for. the launchpad answers three ways: a `Credited` on the fee escrow,
a `CreatorFeeRecipientUpdated` naming the treasury, or a walk of recent launches. pools.fun answers
one way that matters — `FeeRecipientChanged`, indexed on the new recipient — because it has no
launch-time field for a fee recipient at all: a creator launches, then repoints the fees. There is a
walk of its `Registered` events behind that for the case where a coin arrives already pointed here,
but the redirect is the signal in practice. A pools.fun basket is not woken by its money arriving the
way a the launchpad one is (the escrow is keyed by recipient; pools.fun's ledger is keyed by coin *and*
recipient, and the coin is the unknown), so it waits out `COIN_MISS_TTL` instead — once.

**How it is split.** One transaction when the list fits. When it doesn't, each batch is given its
share of the round's total computed off the same snapshot, and the last batch takes the remainder so
the batches add up to exactly the budget the contract fixed when the round opened.

## Env

See `.env.example`. The ones worth knowing:

| | |
|---|---|
| `MIN_ROUND_ETH` | per-name buy threshold, native-quoted baskets |
| `MIN_ROUND_QUOTE` | same, in quote units, for ERC20-quoted baskets |
| `MAX_HOLDERS_PER_TX` | batch size; 250 is ~17M gas |
| `RIALTO_API_KEY` | without it nothing can be bought — payouts of already-bought stock still run |
| `EXTRA_EXCLUDES` | extra **contracts** that must never be paid; the treasury rejects non-contracts here |
| `PARTY_LOCKER` | pools.fun's fee locker; must match `BasketTreasury.PARTY_LOCKER` or a coin binds and then cannot be found |
| `PARTY_LOOKBACK` | how far back to look for a coin being repointed at a basket on pools.fun |

Nothing new is required to run: both default to the live values. Narrowing `LOG_CHUNK` and the
lookbacks is worth knowing about for forks, though — a public node will not serve a 500k-block log
query through one, which is why `simulate-party.sh` passes small ones.
