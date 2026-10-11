import { apiError, isRateLimited } from "../shared";
import { isWalletAddress, readWalletDividends } from "../../../lib/wallet-dividends";

/**
 * One wallet's dividend recap, for the checker on /dividends. Same data and the same ten-minute
 * per-wallet cache as the server render, so a repeat lookup costs nothing upstream.
 */
export async function GET(request: Request) {
  if (isRateLimited(request)) return apiError("Too many lookups. Try again in a minute.", 429);
  const address = new URL(request.url).searchParams.get("address") ?? "";
  if (!isWalletAddress(address)) return apiError("That is not a wallet address.", 400);
  try {
    return Response.json(await readWalletDividends(address), {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch {
    return apiError("The payouts could not be read just now. Try again in a minute.", 503);
  }
}
