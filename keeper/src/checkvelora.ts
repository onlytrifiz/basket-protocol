import { formatUnits } from "viem";
import { buildVeloraLeg } from "./velora.js";
import { WETH } from "./route.js";

const VAULT = "0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98" as const;
/**
 * A hand-written list of B20 addresses, which is what entitles this file to the literal 8 below —
 * the same rule `lib/decimals` states for the site's seed list. `keeper.ts` reads the scale instead,
 * because there the index comes from the vault and may hold anything `setIndex` was handed.
 */
const assets: [string, `0x${string}`][] = [
  ["NVDAc", "0xb20000000000000000000078ee7ce2fE4908108C"],
  ["AAPLc", "0xb200000000000000000000C2e324d24d7eEcd1fb"],
  ["GOOGLc","0xb2000000000000000000002D0BA3164cc74f58B7"],
  ["METAc", "0xb2000000000000000000008bC8786B856E61707C"],
];
// cap 0.025 ETH -> budget 0.0225 -> 25% per gamba
const amountIn = 25000000000000000n * 9000n / 10000n * 2500n / 10000n;

async function main() {
  console.log(`amountIn per gamba: ${Number(amountIn)/1e18} ETH\n`);
  for (const [sym, addr] of assets) {
    const leg = await buildVeloraLeg({ srcToken: WETH, srcDecimals: 18, destToken: addr,
      destDecimals: 8, amountIn, vault: VAULT, slippageBps: 300 });
    if (!leg) { console.log(`${sym.padEnd(7)} NESSUNA ROUTE`); continue; }
    console.log(`${sym.padEnd(7)} minOut ${formatUnits(leg.minOut,8).padStart(12)}  offset ${String(leg.amountInOffset).padStart(4)}  venue ${leg.venues.join("+")}`);
  }
}
main().catch((e) => { console.error(String(e).split("\n")[0]); process.exit(1); });
