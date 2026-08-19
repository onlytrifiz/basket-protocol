#!/usr/bin/env bash
# Aligned OPEN_TICK for a target market cap, from the ETH price on Aerodrome's WETH/USDC pool.
# Usage: ./script/open-tick.sh [MCAP_USD] [SUPPLY]
set -euo pipefail
MCAP=${1:-4000}; SUPPLY=${2:-1000000000}
RPC=${RPC_URL:-https://mainnet.base.org}
SLOT0=$(cast call 0x3FE04A59Ebd38cF06080a6F60a98D124eb59392A "slot0()(uint160,int24,uint16,uint16,uint16,bool)" --rpc-url "$RPC" | sed -n 2p | cut -d' ' -f1)
python3 - "$SLOT0" "$MCAP" "$SUPPLY" <<'PY'
import math, sys
tick_eth, mcap, supply = int(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
eth_usd = (1.0001 ** tick_eth) * 1e12          # WETH/USDC pool, 18 vs 6 decimals
tick = math.log(eth_usd / (mcap / supply)) / math.log(1.0001)
aligned = int(tick // 200) * 200
opened = (1 / 1.0001 ** aligned) * eth_usd * supply
print(f"ETH        ${eth_usd:,.0f}")
print(f"OPEN_TICK  {aligned}")
print(f"mcap       ${opened:,.0f}  (target ${mcap:,.0f})")
PY
