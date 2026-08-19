import type { Pool } from "./pools";

/**
 * The direct path to the STFY pool, for the one pair no aggregator will quote.
 *
 * Aggregators refuse a pool whose hook is not on their allowlist, and the Stockify hook will not be
 * on one while it is unreviewed. Measured against the live pool: DexScreener indexes it and reports
 * real liquidity, while Velora answers "No routes found with enough liquidity" for the same pair. So
 * ETH<->STFY is routed through `StockifyRouter` — `buy(minOut)` payable, `sell(amountIn, minOut)` —
 * and everything else keeps going through the aggregator.
 *
 * Calldata is assembled by hand for the same reason the rest of this app reads the chain by hand:
 * two selectors and three arguments do not justify an ABI encoder in the bundle.
 */

const SIG = {
  buy: "0xd96a094a", // buy(uint256)
  sell: "0xd79875eb", // sell(uint256,uint256)
  approve: "0x095ea7b3", // approve(address,uint256)
  allowance: "0xdd62ed3e", // allowance(address,address)
} as const;

export const ROUTER = process.env.NEXT_PUBLIC_STOCKIFY_ROUTER_ADDRESS ?? "";
export const hasRouter = /^0x[a-fA-F0-9]{40}$/.test(ROUTER);

const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, "")).toLowerCase().padStart(64, "0");

/**
 * The fees a quote has to survive before it is worth showing.
 *
 * 300 bps to the hook, in ETH, on the way through, plus the pool's own 1% to LPs. Subtracted from
 * the mid price rather than ignored, because a figure that pretends they are not charged is wrong by
 * exactly the amount the protocol exists to collect.
 */
const FEE_HAIRCUT = 0.96;

/** Expected output for a direct swap, from the pool's own mid price. Null when it is unknown. */
export function estimateOut(
  amountIn: bigint,
  side: "buy" | "sell",
  pool: Pool | null | undefined,
): bigint | null {
  const priceInEth = pool?.priceNative;
  if (!priceInEth || !Number.isFinite(priceInEth) || priceInEth <= 0) return null;

  // STFY carries 18 decimals like ETH, so the scale cancels and only the rate applies.
  const rate = side === "buy" ? 1 / priceInEth : priceInEth;
  const out = (Number(amountIn) / 1e18) * rate * FEE_HAIRCUT;
  if (!Number.isFinite(out) || out <= 0) return null;
  return BigInt(Math.floor(out * 1e18));
}

/** `buy(minOut)`, paid with `value`. */
export const buyCall = (minOut: bigint) => ({ to: ROUTER, data: `${SIG.buy}${word(minOut)}` });

/** `sell(amountIn, minOut)`. The router must be approved for `amountIn` first. */
export const sellCall = (amountIn: bigint, minOut: bigint) => ({
  to: ROUTER,
  data: `${SIG.sell}${word(amountIn)}${word(minOut)}`,
});

/** The approval a sale needs. Note the spender is THIS router, not an aggregator's proxy. */
export const approveCall = (token: string, amount: bigint) => ({
  to: token,
  data: `${SIG.approve}${word(ROUTER)}${word(amount)}`,
});

export const allowanceCall = (token: string, owner: string) => ({
  to: token,
  data: `${SIG.allowance}${word(owner)}${word(ROUTER)}`,
});
