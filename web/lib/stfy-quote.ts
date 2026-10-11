import "server-only";

import { cached } from "./cache";
import { batchCall, pad } from "./rpc";

/**
 * The exact output of a direct ETH<->STFY swap, from Uniswap's own v4 quoter.
 *
 * The panel used to estimate from DexScreener's mid price less a flat 4% for the fees. That ignored
 * price impact, and the pool is thin: 0.1 ETH was quoted ~437k STFY and filled ~401k, so a 5%
 * slippage floor reverted. The quoter runs the real swap, hook included, and reverts it, so its
 * answer is what the router will deliver at this block.
 *
 * V4Quoter on Base, from https://developers.uniswap.org/docs/protocols/v4/deployments; checked
 * on-chain 2026-10-11 to return the same figure as simulating `StockifyRouter.buy`.
 */
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
const ROUTER = process.env.NEXT_PUBLIC_STOCKIFY_ROUTER_ADDRESS ?? "";
const SIG = {
  poolKey: "0x182148ef",
  // quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
  quoteExactInputSingle: "0xaa9d21cb",
} as const;

/** The pool the router trades, as five ABI words. It never changes, so it is read once an hour. */
function poolKeyWords(): Promise<string> {
  return cached("stfy:pool-key", 60 * 60_000, async () => {
    const [result] = await batchCall([{ to: ROUTER, data: SIG.poolKey }]);
    const words = (result.data ?? "").replace(/^0x/, "");
    if (result.state !== "ok" || words.length < 64 * 5) throw new Error("router poolKey unreadable");
    return words.slice(0, 64 * 5);
  });
}

/** STFY out for ETH in (`buy`), or ETH out for STFY in (`sell`), in base units. */
export async function quoteStfy(side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  const key = await poolKeyWords();
  // ETH is currency0, so a buy swaps zero-for-one.
  const zeroForOne = side === "buy" ? 1n : 0n;
  const data = SIG.quoteExactInputSingle
    + pad("20")
    + key
    + pad(zeroForOne.toString(16))
    + pad(amountIn.toString(16))
    + pad("100") // offset of hookData within the struct: eight head words
    + pad("0"); // empty hookData
  const [result] = await batchCall([{ to: V4_QUOTER, data }]);
  const words = (result.data ?? "").replace(/^0x/, "");
  if (result.state !== "ok" || words.length < 64) throw new Error("quoter did not answer");
  return BigInt(`0x${words.slice(0, 64)}`);
}
