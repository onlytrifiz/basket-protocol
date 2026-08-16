import type { Address, Hex } from "viem";

const nativeEth = "0x0000000000000000000000000000000000000000";
const universalRouter = "0x6fF5693b99212Da76ad316178A184AB56D299b43";

export type SwapQuote = {
  calldata: Hex;
  minOut: bigint;
};

function headers(): HeadersInit {
  const key = process.env.UNISWAP_API_KEY;
  return {
    ...(key ? { "x-api-key": key } : {}),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Builds exact-input calldata for the Base Universal Router. The vault independently pins that
 * router and measures the B20 balance delta, so this API only discovers a route and proposes a
 * slippage floor; it is never trusted to custody or select an arbitrary call target.
 */
export async function quoteStock(args: {
  tokenOut: Address;
  amountIn: bigint;
  recipient: Address;
  slippageBps: number;
}): Promise<SwapQuote | null> {
  if (!process.env.UNISWAP_API_KEY) return null;
  const endpoint = process.env.UNISWAP_API ?? "https://trade-api.gateway.uniswap.org/v1";
  const quoteRequest = {
    tokenIn: nativeEth,
    tokenOut: args.tokenOut,
    tokenInChainId: "8453",
    tokenOutChainId: "8453",
    type: "EXACT_INPUT",
    amount: args.amountIn.toString(),
    swapper: args.recipient,
    slippageTolerance: args.slippageBps / 100,
  };

  try {
    const quoteResponse = await fetch(`${endpoint}/quote`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(quoteRequest),
    });
    if (!quoteResponse.ok) {
      if (quoteResponse.status !== 404) console.error(`  quote ${args.tokenOut}: HTTP ${quoteResponse.status}`);
      return null;
    }
    const quotePayload = (await quoteResponse.json()) as { quote?: Record<string, any> };
    const expectedOut = BigInt(quotePayload.quote?.output?.amount ?? "0");
    if (!quotePayload.quote || expectedOut === 0n) return null;

    const swapResponse = await fetch(`${endpoint}/swap`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ quote: quotePayload.quote }),
    });
    if (!swapResponse.ok) {
      console.error(`  swap build ${args.tokenOut}: HTTP ${swapResponse.status}`);
      return null;
    }
    const swapPayload = (await swapResponse.json()) as { swap?: { to?: string; data?: string; value?: string } };
    const swap = swapPayload.swap;
    if (!swap?.to || !swap.data || swap.data === "0x") return null;
    if (swap.to.toLowerCase() !== universalRouter.toLowerCase()) {
      console.error(`  unexpected router ${swap.to}`);
      return null;
    }
    if (BigInt(swap.value ?? "0") !== args.amountIn) {
      console.error(`  route for ${args.tokenOut} has an unexpected native value`);
      return null;
    }
    const minOut = (expectedOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
    if (minOut === 0n) return null;
    return { calldata: swap.data as Hex, minOut };
  } catch (error) {
    console.error(`  quote ${args.tokenOut}: ${(error as Error).message}`);
    return null;
  }
}
