import { apiError, hasUniswapApiKey, isPositiveInteger, isRateLimited, isSupportedOutput, nativeEth, readError, uniswapApiBase, uniswapHeaders } from "../shared";

type RouterQuote = {
  input?: { amount?: string; token?: string };
  output?: { token?: string };
};

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasUniswapApiKey()) return apiError("Swap service is not configured.", 503);
  if (isRateLimited(request)) return apiError("Too many requests. Please retry shortly.", 429);

  const body = await request.json().catch(() => null) as { quote?: RouterQuote } | null;
  const quote = body?.quote;
  if (!quote || quote.input?.token?.toLowerCase() !== nativeEth || !isPositiveInteger(quote.input.amount) || !isSupportedOutput(quote.output?.token)) {
    return apiError("This quote cannot be executed by Basket.", 400);
  }

  const response = await fetch(`${uniswapApiBase}/swap`, {
    body: JSON.stringify({ deadline: Math.floor(Date.now() / 1000) + 120, quote, safetyMode: "SAFE" }),
    headers: uniswapHeaders(),
    method: "POST",
    cache: "no-store",
  });

  if (!response.ok) return apiError(await readError(response), response.status);
  const payload = await response.json() as { gasFee?: unknown; swap?: { chainId?: unknown; data?: unknown; to?: unknown; value?: unknown } };
  const swap = payload.swap;
  if (!swap || swap.chainId !== 8453 || typeof swap.data !== "string" || !swap.data.startsWith("0x") || typeof swap.to !== "string" || !isPositiveInteger(swap.value ?? "1")) {
    return apiError("Router returned an invalid Base transaction.", 502);
  }

  return Response.json({ gasFee: payload.gasFee, swap }, { headers: { "Cache-Control": "no-store" } });
}
