import { apiError, hasUniswapApiKey, isAddress, isRateLimited, isSupportedOutput, readError, uniswapApiBase, uniswapHeaders } from "../shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasUniswapApiKey()) return apiError("Swap service is not configured.", 503);
  if (isRateLimited(request)) return apiError("Too many requests. Please retry shortly.", 429);

  const body = await request.json().catch(() => null) as { walletAddress?: unknown; token?: unknown } | null;
  if (!body || !isAddress(body.walletAddress) || !isSupportedOutput(body.token)) {
    return apiError("Invalid permission check.", 400);
  }

  const response = await fetch(`${uniswapApiBase}/permissions`, {
    body: JSON.stringify({ chainId: 8453, tokens: [body.token], walletAddress: body.walletAddress }),
    headers: uniswapHeaders(),
    method: "POST",
    cache: "no-store",
  });

  if (!response.ok) return apiError(await readError(response), response.status);
  return Response.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
}
