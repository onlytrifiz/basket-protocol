import { apiError, isAddress, isRateLimited, isSupportedOutput } from "../../shared";

/**
 * Does this wallet pass a B20 asset's transfer-receiver policy?
 *
 * Read straight from the chain rather than through an aggregator's permissions endpoint: the policy
 * lives on Base, the previous route needed an API key the site no longer holds, and a third party
 * cannot answer this more accurately than the registry that enforces it.
 *
 * Fails OPEN. A B20 that is not policy-gated returns policy 0, and an unreachable read must not
 * block a quote — the transfer itself is the real gate, and it reverts if this was wrong.
 */
const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002";

/**
 * keccak256("TRANSFER_RECEIVER_POLICY") and keccak256("TRANSFER_SENDER_POLICY").
 *
 * WHICH SCOPE APPLIES DEPENDS ON THE DIRECTION OF THE TRADE, and getting it backwards means
 * clearing a wallet that the transfer will then reject. Buying an equity makes the wallet the
 * RECEIVER; selling one makes it the SENDER. Both are checked against the same registry.
 */
const SCOPES = {
  receiver: "0x8a4b3fa2d8b921852bc0089c6ef0958aa6961897be36fd731330fe2cd23f8363",
  sender: "0xb81736c875ab819dd97f59f2a6542cfb731ad52b4ae15a6f24df2fb02b0327f5",
} as const;
const POLICY_ID_SELECTOR = "0xdb3de624";
const IS_AUTHORIZED_SELECTOR = "0x55a1179e";

const pad = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const response = await fetch(RPC, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "eth_call", params: [{ data, to }, "latest"] }),
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json() as { result?: string; error?: unknown };
    return payload.result ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (isRateLimited(request)) return apiError("Too many requests. Please retry shortly.", 429);

  const body = await request.json().catch(() => null) as
    | { walletAddress?: unknown; token?: unknown; scope?: unknown }
    | null;
  if (!body || !isAddress(body.walletAddress) || !isSupportedOutput(body.token)) {
    return apiError("Invalid permission check.", 400);
  }

  const scope = body.scope === "sender" ? SCOPES.sender : SCOPES.receiver;
  const policyRaw = await ethCall(body.token, POLICY_ID_SELECTOR + pad(scope));
  const policyId = policyRaw ? BigInt(policyRaw) : 0n;
  if (policyId === 0n) {
    return Response.json({ allowed: true, policyId: "0" }, { headers: { "Cache-Control": "no-store" } });
  }

  const authRaw = await ethCall(
    POLICY_REGISTRY,
    IS_AUTHORIZED_SELECTOR + pad(policyId.toString(16)) + pad(body.walletAddress),
  );
  const allowed = authRaw === null ? true : BigInt(authRaw) !== 0n;

  return Response.json(
    { allowed, policyId: policyId.toString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
