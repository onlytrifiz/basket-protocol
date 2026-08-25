import { poolsFor } from "../../../../lib/pools";
import { ROUTER, hasRouter } from "../../../../lib/stfyRoute";
import { findPayToken, NATIVE_ETH, STFY_ADDRESS, type PayToken } from "../../../../lib/shop/pay-tokens";
import { DEFAULT_SETTLEMENT, payAmount } from "../../../../lib/shop/settlement";
import { jsonError } from "../../../../lib/shop/request";
import { clientKey, rateLimit, tooMany } from "../../../../lib/shop/rate-limit";

export const runtime = "nodejs";

/**
 * What to send, so that a known amount arrives.
 *
 * The order needs a precise quantity of USDC at a precise address on Base, and
 * an EXACT-OUTPUT swap is the one primitive that promises exactly that: name
 * the output, and the transaction either delivers it or reverts. There is no
 * floor to check afterwards and no shortfall to reconcile, which is the whole
 * reason this file is a fraction of the bridging machinery it replaces.
 *
 * Velora rather than a single venue because B20 depth is split across pools —
 * a live NVDAc quote filled across Uniswap v4 and v3 in one trade — and because
 * `/api/velora/swap` already proves the integration on this exact set of
 * tokens. It needs no API key, so nothing here is a secret to leak.
 *
 * WHAT THIS ROUTE ENFORCES that a browser call could not:
 *
 *   - the source must be on the pay-with allowlist, and its decimals come from
 *     there rather than from the request: the equities are 8-decimal tokens and
 *     a client-supplied 18 would quote a payment a hundred million times too
 *     large;
 *   - the destination is pinned to the settlement asset. This endpoint names an
 *     address AND an amount, so leaving the target free would let a caller aim
 *     a quote — and a buyer's money — at any token on any chain;
 *   - the receiver must be given, and is checked again against the calldata
 *     that comes back. A quote with no receiver pays the sender: the
 *     transaction succeeds, the buyer is told it worked, and the order is never
 *     paid. That is the one failure that looks exactly like success.
 */

const ENDPOINT = "https://api.velora.xyz/swap";

/** Every settlement asset here is USDC, so this holds for all of them. */
const USDC_DECIMALS = DEFAULT_SETTLEMENT.decimals;

/**
 * How far the input may drift before the swap reverts.
 *
 * Bounds the INPUT only: on an exact-output trade the delivered amount is
 * fixed, so widening this can make a payment cost the buyer a little more and
 * can never make it settle short. The equities trade in thinner books than the
 * cash legs and get more room accordingly — the same reasoning the swap panel
 * uses for its 5% floor, at a quarter of the size because a payment is priced
 * seconds before it is signed.
 */
const SLIPPAGE_BPS = Number(process.env.SHOP_PAY_SLIPPAGE_BPS ?? 300);
const SLIPPAGE_BPS_EQUITY = Number(process.env.SHOP_PAY_SLIPPAGE_BPS_EQUITY ?? 500);

/**
 * Headroom on the STFY leg, on top of what the ETH leg says it needs.
 *
 * The two transactions are a block or two apart, and the second is re-priced
 * fresh before it is signed. If ETH has moved against the buyer in that window
 * the re-quote asks for slightly more than the first sale produced, and without
 * this the payment stops between its own steps holding ETH it cannot spend.
 * 1.5% is roughly a minute of ordinary movement on this pair.
 */
const ROUTER_HEADROOM_BPS = Number(process.env.SHOP_PAY_ROUTER_HEADROOM_BPS ?? 150);

/**
 * Identical previews are asked for once.
 *
 * The amount to send does not depend on who sends it — gas is paid on top, not
 * out of it — so a preview is priced against a placeholder and shared. Only
 * previews are cached, and only briefly: the quote that gets signed always goes
 * upstream fresh, because it carries the buyer's own address in its calldata
 * and must be current, which is exactly what a cache cannot promise.
 *
 * In memory, so the window is per server instance. That is enough to stop one
 * client hammering the aggregator, which is the realistic waste.
 */
const PREVIEW_TTL_MS = 15_000;
const previews = new Map<string, { at: number; body: unknown }>();
/** Requests already in flight, so simultaneous buyers make one call, not five. */
const inflight = new Map<string, Promise<Record<string, unknown>>>();

function sweepPreviews(now: number) {
  for (const [key, entry] of previews) {
    if (now - entry.at > PREVIEW_TTL_MS) previews.delete(key);
  }
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Velora rejects a placeholder-looking address, so the vault stands in — a real
 *  address we control, whose preview calldata is never sent. Same stand-in the
 *  swap panel uses for exactly this reason. */
const PREVIEW_ADDRESS =
  process.env.NEXT_PUBLIC_DIVIDEND_VAULT_ADDRESS ?? "0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98";

const word = (value: bigint | string) =>
  (typeof value === "bigint" ? value.toString(16) : value.replace(/^0x/, ""))
    .toLowerCase()
    .padStart(64, "0");

/** `transfer(address,uint256)` — the whole of a USDC payment. */
const TRANSFER = "0xa9059cbb";
/** `sell(uint256,uint256)` on StockifyRouter. */
const SELL = "0xd79875eb";

/** Base units of the settlement asset for a dollar figure. */
function toUsdcUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

/**
 * Raw units as something a person can read off their wallet.
 *
 * Precision has to move with magnitude: an 18-decimal token gives
 * 0.003165894075806013 for a fraction of an ETH, and 63624.934211004142 for a
 * token priced in millionths, where the trailing digits are worth nothing and
 * only serve to wrap the line. Always rounds UP — sending marginally more can
 * only deliver more, which is the one direction that is safe here.
 */
function readable(raw: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = raw / scale;
  const wanted = String(whole).length > 4 ? 2 : String(whole).length > 3 ? 4 : whole > BigInt(0) ? 6 : 8;
  if (decimals <= wanted) return format(raw, decimals);
  const factor = BigInt(10) ** BigInt(decimals - wanted);
  return format(((raw + factor - BigInt(1)) / factor) * factor, decimals);
}

function format(raw: bigint, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

type PriceRoute = {
  srcAmount: string;
  destAmount: string;
  srcUSD?: string;
  destUSD?: string;
  gasCostUSD?: string;
  tokenTransferProxy?: string;
  bestRoute?: Array<{ swaps?: Array<{ swapExchanges?: Array<{ exchange?: string }> }> }>;
};

type VeloraAnswer = {
  error?: string;
  priceRoute?: PriceRoute;
  txParams?: { to: string; data: string; value: string };
};

/**
 * One exact-output quote: spend `token`, deliver `deliver` USDC to `receiver`.
 *
 * `side=BUY` is what makes the delivered figure exact. `receiver` is what makes
 * it land on the order rather than back in the buyer's wallet, and it is a
 * separate parameter from `userAddress` precisely so the two can differ.
 */
async function quoteExactOut(args: {
  token: PayToken;
  deliver: bigint;
  receiver: string;
  payer: string;
  slippageBps: number;
}): Promise<VeloraAnswer> {
  const query = new URLSearchParams({
    amount: args.deliver.toString(),
    srcToken: args.token.address,
    srcDecimals: String(args.token.decimals),
    destToken: DEFAULT_SETTLEMENT.token,
    destDecimals: String(USDC_DECIMALS),
    network: String(DEFAULT_SETTLEMENT.chainId),
    partner: "stockify",
    receiver: args.receiver,
    // BUY means "deliver exactly this much destToken". The order needs a
    // quantity, not a best effort, and SELL cannot promise one.
    side: "BUY",
    slippage: String(args.slippageBps),
    userAddress: args.payer,
    version: "6.2",
  });

  const response = await fetch(`${ENDPOINT}?${query}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  return (await response.json().catch(() => null)) as VeloraAnswer;
}

function venuesOf(route: PriceRoute): string[] {
  const names = new Set<string>();
  for (const hop of route.bestRoute ?? []) {
    for (const swap of hop.swaps ?? []) {
      for (const exchange of swap.swapExchanges ?? []) {
        if (exchange.exchange) names.add(exchange.exchange);
      }
    }
  }
  return [...names];
}

/**
 * What converting costs, both sides valued by the aggregator.
 *
 * Null whenever the two valuations cannot be trusted to be about the same
 * thing. That is not a theoretical caution: the aggregator's own price feed for
 * STFY sits far below what its pool actually trades at, so the arithmetic
 * returns a number that reads as free money. A figure that is silently wrong is
 * worse on this screen than no figure, because the buyer is about to sign.
 */
function costOf(route: PriceRoute): number | null {
  const from = Number(route.srcUSD);
  const to = Number(route.destUSD);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  const pct = ((from - to) / to) * 100;
  // Beyond this the two sides are not describing the same trade. Say nothing.
  if (Math.abs(pct) > 40) return null;
  return Number(pct.toFixed(1));
}

/** The most the swap may pull, which is what an approval has to cover. */
function maxSpend(srcAmount: string, slippageBps: number): bigint {
  return (BigInt(srcAmount) * BigInt(10_000 + slippageBps)) / BigInt(10_000);
}

export async function GET(req: Request) {
  const limit = rateLimit(`pay:${clientKey(req)}`, 60, 60_000);
  if (!limit.ok) return tooMany(limit, "Too many price checks. Try again in a moment.");

  const params = new URL(req.url).searchParams;

  const token = findPayToken(params.get("token") ?? "");
  if (!token) return jsonError("That token cannot be used to pay here.");

  const required = Number(params.get("required"));
  if (!Number.isFinite(required) || required <= 0) {
    return jsonError("required must be a positive number.");
  }

  // The order's own deposit address. No default and no fallback — see the note
  // at the top of this file about the failure that looks like success.
  const receiver = (params.get("to") ?? "").trim();
  if (!EVM_ADDRESS.test(receiver)) return jsonError("Missing payment destination.");

  /**
   * `fresh` marks the quote that is about to be signed. Everything else is a
   * preview: shown, never executed, and therefore shareable between buyers.
   */
  const fresh = params.get("fresh") === "1";
  const payerParam = (params.get("payer") ?? "").trim();
  const payer = fresh && EVM_ADDRESS.test(payerParam) ? payerParam : PREVIEW_ADDRESS;

  const cacheKey = [token.address, required, receiver].join("|");
  if (!fresh) {
    const now = Date.now();
    sweepPreviews(now);
    const hit = previews.get(cacheKey);
    if (hit) return Response.json(hit.body);
    const running = inflight.get(cacheKey);
    // Someone already asked for this. Wait for their answer rather than buying
    // a second one.
    if (running) return Response.json(await running);
  }

  const work = build({ token, required, receiver, payer });
  if (!fresh) inflight.set(cacheKey, work);

  try {
    const body = await work;
    // Only a usable answer is worth remembering: caching a failure would keep
    // serving it after the route had recovered.
    if (!fresh && body.ok) previews.set(cacheKey, { at: Date.now(), body });
    return Response.json(body);
  } catch (error) {
    console.error("[shop/pay] quote failed", error);
    return jsonError("Could not price that payment right now.", 502);
  } finally {
    inflight.delete(cacheKey);
  }
}

async function build(args: {
  token: PayToken;
  required: number;
  receiver: string;
  payer: string;
}): Promise<Record<string, unknown>> {
  const { token, required, receiver, payer } = args;
  // What the swap is actually asked to deliver: the order's figure plus the
  // buffer, rounded up to a whole cent. Exact output means this is what lands.
  const deliver = payAmount(required);
  const deliverRaw = toUsdcUnits(deliver);

  /**
   * USDC needs no aggregator. It is already the settlement asset, so the
   * payment is one ERC-20 transfer — no route to price, no approval, nothing to
   * go stale. Routing it anyway would charge a buyer a swap fee to convert a
   * dollar into the same dollar.
   */
  if (token.rail === "direct") {
    return {
      ok: true,
      rail: "direct",
      symbol: token.symbol,
      decimals: token.decimals,
      sendAmount: format(deliverRaw, token.decimals),
      spendMaxRaw: deliverRaw.toString(),
      delivers: deliver,
      required,
      costPct: 0,
      venues: [],
      steps: [
        {
          kind: "pay",
          label: `Send ${format(deliverRaw, token.decimals)} USDC`,
          to: token.address,
          data: `${TRANSFER}${word(receiver)}${word(deliverRaw)}`,
          value: "0",
          spender: null,
          spendToken: token.address,
          spendRaw: deliverRaw.toString(),
        },
      ],
    };
  }

  const slippageBps = token.isB20 ? SLIPPAGE_BPS_EQUITY : SLIPPAGE_BPS;

  /**
   * STFY does not go through the aggregator, and the reason is a price rather
   * than a policy.
   *
   * An aggregator will quote STFY against USDC — through a pool holding a few
   * hundred dollars, next to the STFY/ETH pool holding tens of thousands. It is
   * the same hazard as any dust pool: the route exists, the quote returns, and
   * the fill is nothing a buyer would agree to if it were named.
   *
   * The pool that matters is STFY/ETH, and it is also the one carrying the
   * protocol's hook — so selling into it pays the same 3% every other sale
   * pays, and that 3% buys stock for holders. `StockifyRouter` reaches it
   * directly. The ETH then pays the order through the ordinary rail below,
   * priced as its own exact-output quote so the second leg still delivers a
   * precise figure.
   */
  if (token.rail === "router") {
    if (!hasRouter || !/^0x[a-fA-F0-9]{40}$/.test(STFY_ADDRESS)) {
      return { ok: false, reason: "Paying in STFY is not configured on this deployment." };
    }

    const ethLeg = await quoteExactOut({
      token: { symbol: "ETH", name: "Ether", address: NATIVE_ETH, decimals: 18, rail: "swap" },
      deliver: deliverRaw,
      receiver,
      payer,
      slippageBps: SLIPPAGE_BPS,
    });
    if (!ethLeg?.priceRoute || !ethLeg.txParams) {
      return { ok: false, reason: ethLeg?.error || "No route for this payment right now." };
    }
    // The value on the ETH leg is its maximum spend, not its estimate: that is
    // the figure the STFY sale has to produce for the second step to be payable.
    const ethNeeded = BigInt(ethLeg.txParams.value);
    const ethFloor = (ethNeeded * BigInt(10_000 + ROUTER_HEADROOM_BPS)) / BigInt(10_000);

    /**
     * How much STFY that is, read from the pool rather than from a quote.
     *
     * `priceNative` on the ETH pair is STFY's price in ETH, which is exactly the
     * rate this sale settles at, less the fees the sale itself pays: 300 bps to
     * the hook and the pool's own 100 bps to LPs. `lib/stfyRoute` states that
     * haircut once and both the swap panel and this file read it from there.
     */
    // Lowercased on the way in: `poolsFor` compares against a lowercased
    // address and answers a checksummed one with an empty list rather than an
    // error — which reads as "this token has no pools" and is not true.
    // `poolsForAll` normalises for its callers; this one is direct.
    const stfyPools = await poolsFor(STFY_ADDRESS.toLowerCase(), 0, true).catch(() => null);
    const ethPool = (stfyPools?.pools ?? (stfyPools?.best ? [stfyPools.best] : [])).find((p) =>
      ["ETH", "WETH"].includes(p.quoteSymbol?.toUpperCase()),
    );
    if (!ethPool?.priceNative) {
      return { ok: false, reason: "The STFY pool has no readable price right now." };
    }

    // Fees come off the ETH the sale produces, so the STFY input has to be
    // grossed up by them rather than reduced.
    const FEE_HAIRCUT = 0.96;
    const stfyRaw = BigInt(
      Math.ceil((Number(ethFloor) / ethPool.priceNative) * (1 / FEE_HAIRCUT)),
    );

    return {
      ok: true,
      rail: "router",
      symbol: token.symbol,
      decimals: token.decimals,
      sendAmount: readable(stfyRaw, token.decimals),
      spendMaxRaw: stfyRaw.toString(),
      delivers: deliver,
      required,
      /**
       * Not priced as a percentage, deliberately. The cost of spending STFY is
       * structural — the 3% hook and the 1% LP fee, the same as any sale — and
       * a figure that moves with the pool would read as an unreliable shop
       * rather than an honest one. The checkout states the reason instead.
       */
      costPct: null,
      venues: ["Stockify router", ...venuesOf(ethLeg.priceRoute)],
      ethNeeded: ethFloor.toString(),
      steps: [
        {
          kind: "sell",
          label: `Sell ${readable(stfyRaw, token.decimals)} STFY for ETH`,
          to: ROUTER,
          data: `${SELL}${word(stfyRaw)}${word(ethFloor)}`,
          value: "0",
          // The spender is this router, not an aggregator's proxy. Approving
          // the wrong address fails silently and looks like a broken payment.
          spender: ROUTER,
          /** What the approval goes ON — never the step's `to`, which is the
           *  router itself. Named here so the browser never has to work it out. */
          spendToken: STFY_ADDRESS,
          spendRaw: stfyRaw.toString(),
        },
        {
          kind: "pay",
          label: "Pay the order",
          to: ethLeg.txParams.to,
          data: ethLeg.txParams.data,
          value: ethLeg.txParams.value,
          spender: null,
          spendToken: NATIVE_ETH,
          spendRaw: ethLeg.txParams.value,
          /**
           * Re-priced immediately before it is signed. It is built here so the
           * first step can be sized against a real second step — and so a buyer
           * who stops between the two is left holding ETH, never a half-payment.
           */
          repriceWith: NATIVE_ETH,
        },
      ],
    };
  }

  const answer = await quoteExactOut({ token, deliver: deliverRaw, receiver, payer, slippageBps });
  if (!answer?.priceRoute || !answer.txParams) {
    return { ok: false, reason: answer?.error || "No route for that token right now." };
  }

  /**
   * The step may be signed next, so verify it pays who we asked. The receiver
   * is encoded in the calldata, so this catches the whole family of "quote built
   * wrong" faults at the last moment before money moves rather than after.
   */
  if (!answer.txParams.data.toLowerCase().includes(receiver.slice(2).toLowerCase())) {
    console.error("[shop/pay] refusing a quote that does not name", receiver);
    return { ok: false, reason: "Could not price that payment right now." };
  }

  const route = answer.priceRoute;
  const spendMax = maxSpend(route.srcAmount, slippageBps);
  const native = token.address.toLowerCase() === NATIVE_ETH.toLowerCase();

  return {
    ok: true,
    rail: "swap",
    symbol: token.symbol,
    decimals: token.decimals,
    sendAmount: readable(BigInt(route.srcAmount), token.decimals),
    /** What the swap may pull at worst — what an approval has to cover, and
     *  what a balance has to hold. The estimate above is what it expects to. */
    spendMaxRaw: spendMax.toString(),
    delivers: deliver,
    required,
    costPct: costOf(route),
    venues: venuesOf(route),
    steps: [
      {
        kind: "pay",
        label: `Pay with ${token.symbol}`,
        to: answer.txParams.to,
        data: answer.txParams.data,
        value: answer.txParams.value,
        // Absent for a native-ETH payment, where there is nothing to approve.
        spender: native ? null : route.tokenTransferProxy ?? null,
        spendToken: token.address,
        spendRaw: spendMax.toString(),
      },
    ],
  };
}
