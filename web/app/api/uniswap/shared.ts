import { stocks } from "../../../lib/stocks";

const nativeEth = "0x0000000000000000000000000000000000000000";
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const integerPattern = /^\d+$/;
const rateWindowMs = 60_000;
const requestLimit = 15;
const requestBuckets = new Map<string, { count: number; startedAt: number }>();

export const uniswapApiBase = "https://trade-api.gateway.uniswap.org/v1";
export { nativeEth };

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && addressPattern.test(value);
}

export function isPositiveInteger(value: unknown): value is string {
  return typeof value === "string" && integerPattern.test(value) && BigInt(value) > 0n && value.length <= 80;
}

export function isSupportedOutput(value: unknown): value is string {
  if (!isAddress(value)) return false;

  const basketAddress = process.env.NEXT_PUBLIC_BASKET_TOKEN_ADDRESS ?? "";
  return [...stocks.map((stock) => stock.address), basketAddress]
    .filter(isAddress)
    .some((address) => address.toLowerCase() === value.toLowerCase());
}

export function hasUniswapApiKey() {
  return Boolean(process.env.UNISWAP_API_KEY);
}

export function uniswapHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": process.env.UNISWAP_API_KEY!,
    "x-erc20eth-enabled": "false",
    "x-permit2-disabled": "false",
    "x-universal-router-version": "2.2.0",
  };
}

/** Small in-process brake for a server-only API key. Use durable edge rate limiting in production. */
export function isRateLimited(request: Request) {
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const now = Date.now();
  const bucket = requestBuckets.get(client);

  if (!bucket || now - bucket.startedAt > rateWindowMs) {
    requestBuckets.set(client, { count: 1, startedAt: now });
    return false;
  }

  bucket.count += 1;
  return bucket.count > requestLimit;
}

export function apiError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function readError(response: Response) {
  const payload = await response.json().catch(() => null) as { detail?: string; error?: string; message?: string } | null;
  return payload?.detail || payload?.message || payload?.error || "Uniswap could not build this route.";
}
