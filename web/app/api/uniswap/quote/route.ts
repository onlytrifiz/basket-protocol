import { apiError, hasUniswapApiKey, isAddress, isPositiveInteger, isRateLimited, isSupportedOutput, nativeEth, readError, uniswapApiBase, uniswapHeaders } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasUniswapApiKey()) return apiError("Swap service is not configured.", 503);
  if (isRateLimited(request)) return apiError("Too many requests. Please retry shortly.", 429);

  const body = await request.json().catch(() => null) as { amount?: unknown; swapper?: unknown; tokenOut?: unknown } | null;
  if (!body || !isPositiveInteger(body.amount) || !isAddress(body.swapper) || !isSupportedOutput(body.tokenOut)) {
    return apiError("Invalid quote request.", 400);
  }

  const response = await fetch(`${uniswapApiBase}/quote`, {
    body: JSON.stringify({
      amount: body.amount,
      hookOptions: "V4_HOOKS_INCLUSIVE",
      protocols: ["V4"],
      recipient: body.swapper,
      slippageTolerance: 0.5,
      swapper: body.swapper,
      tokenIn: nativeEth,
      tokenInChainId: 8453,
      tokenOut: body.tokenOut,
      tokenOutChainId: 8453,
      type: "EXACT_INPUT",
    }),
    headers: uniswapHeaders(),
    method: "POST",
    cache: "no-store",
  });

  if (!response.ok) return apiError(await readError(response), response.status);
  return Response.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
}
