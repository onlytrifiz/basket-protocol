import type { Address, Hex } from "viem";

/**
 * Velora (formerly ParaSwap) Market API — https://api.velora.xyz/swap
 *
 * Preferred over the self-built Slipstream path because it searches every venue on Base rather than
 * the one we happened to know about: on a live probe it routed a B20 leg through
 * `aerodromeslipstreamfactory3` AND `kipseli`, and beat the hand-built two-hop route.
 *
 * THE AMOUNT MUST MATCH EXACTLY. Augustus v6.2 `swapExactAmountIn` encodes `srcAmount` TWICE — once
 * in the outer struct and once inside the executor's own leg (observed at byte offsets 100 and 580).
 * The vault patches a single word, so patching an aggregator route would leave the inner leg on the
 * stale amount. The keeper therefore quotes for EXACTLY the amount the vault will forward, which
 * makes the vault's patch rewrite the value already there — a no-op — and keeps both copies in step.
 *
 * That is only knowable when `maxGrossSpendPerCycle` binds: once availableEth reaches the cap, gross
 * is pinned to the cap and the per-leg spend is fixed. Below the cap the spend moves with the
 * balance, so the keeper waits rather than sending a route whose amount it cannot predict. If the
 * balance somehow falls between quote and inclusion, the patch makes the calldata inconsistent and
 * the leg reverts — the safe direction.
 */

const ENDPOINT = "https://api.velora.xyz/swap";
export const AUGUSTUS: Address = "0x6a000f20005980200259b80c5102003040001068";

export type VeloraLeg = {
  target: Address;
  calldata: Hex;
  amountInOffset: bigint;
  minOut: bigint;
  venues: string[];
};

/** Byte offset of the 32-byte word holding `amount` in `data`, or null unless it is unambiguous. */
function findAmountOffset(data: Hex, amount: bigint): bigint | null {
  const body = data.slice(2);
  const needle = amount.toString(16).padStart(64, "0");
  const hits: number[] = [];
  for (let i = 0; i + 64 <= body.length; i += 2) {
    if (body.slice(i, i + 64) === needle) hits.push(i / 2);
  }
  // Two copies is the expected shape; the FIRST is the outer struct's srcAmount. Patching it with
  // the identical value is what keeps this safe, so any hit works — but zero hits means the encoding
  // changed under us and the leg must not be sent.
  return hits.length === 0 ? null : BigInt(hits[0]);
}

export async function buildVeloraLeg(args: {
  srcToken: Address;
  srcDecimals: number;
  destToken: Address;
  destDecimals: number;
  amountIn: bigint;
  vault: Address;
  slippageBps: number;
}): Promise<VeloraLeg | null> {
  const query = new URLSearchParams({
    srcToken: args.srcToken,
    srcDecimals: String(args.srcDecimals),
    destToken: args.destToken,
    destDecimals: String(args.destDecimals),
    amount: args.amountIn.toString(),
    side: "SELL",
    network: "8453",
    version: "6.2",
    userAddress: args.vault,
    receiver: args.vault,
    slippage: String(args.slippageBps),
    partner: "stockify",
  });

  let payload: any;
  try {
    const response = await fetch(`${ENDPOINT}?${query}`);
    if (!response.ok) {
      console.error(`  velora ${args.destToken}: HTTP ${response.status}`);
      return null;
    }
    payload = await response.json();
  } catch (error) {
    console.error(`  velora ${args.destToken}: ${(error as Error).message}`);
    return null;
  }
  if (payload.error || !payload.priceRoute || !payload.txParams) return null;

  const { priceRoute, txParams } = payload;

  // The route must be an allowance-based pull of exactly what we asked for, delivered to the vault.
  if (BigInt(priceRoute.srcAmount) !== args.amountIn) {
    console.error(`  velora ${args.destToken}: quoted a different srcAmount`);
    return null;
  }
  if (BigInt(txParams.value ?? "0") !== 0n) {
    console.error(`  velora ${args.destToken}: route wants native value, expected a WETH pull`);
    return null;
  }
  if ((txParams.to as string).toLowerCase() !== AUGUSTUS.toLowerCase()) {
    console.error(`  velora ${args.destToken}: unexpected router ${txParams.to}`);
    return null;
  }

  const offset = findAmountOffset(txParams.data as Hex, args.amountIn);
  if (offset === null) {
    console.error(`  velora ${args.destToken}: srcAmount not locatable in calldata`);
    return null;
  }

  const minOut = (BigInt(priceRoute.destAmount) * BigInt(10_000 - args.slippageBps)) / 10_000n;
  if (minOut === 0n) return null;

  const venues = new Set<string>();
  for (const hop of priceRoute.bestRoute ?? []) {
    for (const swap of hop.swaps ?? []) {
      for (const exchange of swap.swapExchanges ?? []) venues.add(exchange.exchange);
    }
  }

  return {
    target: AUGUSTUS,
    calldata: txParams.data as Hex,
    amountInOffset: offset,
    minOut,
    venues: [...venues],
  };
}
