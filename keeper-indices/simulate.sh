#!/usr/bin/env bash
#
# Several consecutive rounds of a stock-quoted basket, against a fork of mainnet.
#
# The unit tests prove each step and the fork tests prove one round. What neither covers is time:
# fees arriving while a round is open, dust carried between rounds, a creator's accrual growing
# across many harvests and still being paid in full at the end. This runs the real keeper against
# real mainnet state for as many rounds as asked, and checks after every one that the treasury is
# still solvent — that what it holds covers what it has promised.
#
#   ROUNDS=5 ./simulate.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC:-http://127.0.0.1:8545}"
FORK="${FORK:-https://robinhood-mainnet.g.alchemy.com/v2/alch_2Ak8zaIngWQjVVbmUuHof}"
ROUNDS="${ROUNDS:-4}"

FACTORY=0xA67Ba8c6F2459BF9dfC9E6173c720Bd3bC2E89d6
AAPL=0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9      # the pair token: fees arrive in this
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC      # a second name, bought the ordinary way
POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951  # a deep AAPL holder to borrow from
COIN=0x1bEf1E4d1F98d91d99F1F2f384490F3999D7ccd9      # a real coin with real holders
DEPLOYER=0x9ca5B125C8369df97642C012bE2B356c3165DCC7  # factory owner and keeper
SALT=0x3333333333333333333333333333333333333333333333333333333333333333

PK=$(grep '^DEPLOYER_PRIVATE_KEY=' "$ROOT/contracts/.env" | cut -d= -f2-)

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

pkill -f "anvil --fork-url" 2>/dev/null || true
sleep 1
say "forking mainnet"
anvil --fork-url "$FORK" --port 8545 --silent >/tmp/anvil.log 2>&1 &
for _ in $(seq 1 40); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
cast rpc anvil_setBalance "$DEPLOYER" 0x21e19e0c9bab2400000 --rpc-url "$RPC" >/dev/null

say "pointing the factory at a fee manager that pays in AAPL"
FM=$(cd "$ROOT/contracts" && forge create test/ForkFeeManager.sol:ForkFeeManager \
  --private-key "$PK" --rpc-url "$RPC" --broadcast --constructor-args "$AAPL" 2>&1 |
  awk '/Deployed to:/{print $3}')
cast send "$FACTORY" 'setFeeManager(address)' "$FM" --private-key "$PK" --rpc-url "$RPC" >/dev/null

# the fee manager needs stock to pay out with; borrow it from the pool
cast rpc anvil_impersonateAccount "$POOL_MANAGER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$POOL_MANAGER" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
cast send "$AAPL" 'transfer(address,uint256)(bool)' "$FM" 200000000000000000000 \
  --from "$POOL_MANAGER" --unlocked --rpc-url "$RPC" >/dev/null

say "creating a basket quoted in AAPL that holds AAPL and NVDA"
cast send "$FACTORY" \
  'createIndex((address,address,address,address[],uint16[],uint32,uint16,address),bytes32,address)' \
  "($DEPLOYER,$DEPLOYER,$AAPL,[$AAPL,$NVDA],[5000,5000],900,2000,0x0000000000000000000000000000000000000000)" \
  "$SALT" 0x0000000000000000000000000000000000000000 \
  --private-key "$PK" --rpc-url "$RPC" >/dev/null
T=$(cast call "$FACTORY" 'predictAddress(address,bytes32)(address)' "$DEPLOYER" "$SALT" --rpc-url "$RPC")
# bind by hand: pons cannot be made to name a treasury that did not launch anything. Slot 3 is
# `coin`, which is all a round needs — minHolderBalance stays 0, so every holder qualifies.
cast rpc anvil_setStorageAt "$T" 0x3 "0x000000000000000000000000${COIN:2}" --rpc-url "$RPC" >/dev/null
echo "  treasury $T  coin $(cast call "$T" 'coin()(address)' --rpc-url "$RPC")"

check() {
  local bal alloc owed
  bal=$(cast call "$AAPL" 'balanceOf(address)(uint256)' "$T" --rpc-url "$RPC" | awk '{print $1}')
  alloc=$(cast call "$T" 'allocatedQuote()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
  owed=$(cast call "$T" 'creatorClaimable()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
  NVDA_BAL=$(cast call "$NVDA" 'balanceOf(address)(uint256)' "$T" --rpc-url "$RPC" | awk '{print $1}')
  python3 - "$bal" "$alloc" "$owed" "$NVDA_BAL" <<'PY'
import sys
bal, alloc, owed, nv = (int(x) for x in sys.argv[1:5])
e = 10**18
print(f"    AAPL held {bal/e:>10.6f} | promised {(alloc+owed)/e:>10.6f} "
      f"(holders {alloc/e:.6f} + creator {owed/e:.6f}) | NVDA {nv/e:.6f}")
assert bal >= alloc + owed, f"INSOLVENT: holds {bal} but promised {alloc + owed}"
PY
}

for i in $(seq 1 "$ROUNDS"); do
  say "round $i of $ROUNDS"
  cast send "$FM" 'set(uint256)' 20000000000000000000 --private-key "$PK" --rpc-url "$RPC" >/dev/null
  ( cd "$ROOT/keeper-baskets" && RPC_URL="$RPC" RUN_ONCE=1 npx tsx src/keeper.ts 2>&1 |
      grep -vE "ExperimentalWarning|trace-warnings|^Support for" | grep -A 6 "${T:0:8}" | head -8 ) || true
  check
  # Reopen the round rather than advancing the chain. The keeper compares a chain-derived readyAt
  # against its own wall clock, so warping forward puts every future round permanently out of reach
  # — an artefact of simulating, not of the design. lastDistribution is the mapping at slot 13.
  for idx in 0 1; do
    cast rpc anvil_setStorageAt "$T" \
      "$(cast keccak "$(cast abi-encode 'f(uint256,uint256)' "$idx" 13)")" \
      0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url "$RPC" >/dev/null
  done
done

say "the creator claims everything owed, after $ROUNDS rounds"
BEFORE=$(cast call "$AAPL" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
OWED=$(cast call "$T" 'creatorClaimable()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
cast send "$T" 'claimCreator()' --private-key "$PK" --rpc-url "$RPC" >/dev/null
AFTER=$(cast call "$AAPL" 'balanceOf(address)(uint256)' "$DEPLOYER" --rpc-url "$RPC" | awk '{print $1}')
python3 - "$BEFORE" "$AFTER" "$OWED" <<'PY'
import sys
before, after, owed = (int(x) for x in sys.argv[1:4])
got = after - before
print(f"    owed {owed/10**18:.6f}, paid {got/10**18:.6f}")
assert got == owed, "the creator's claim was short"
print("\n  every round stayed solvent and the creator was paid in full")
PY

pkill -f "anvil --fork-url" 2>/dev/null || true
