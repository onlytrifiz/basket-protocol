import { B20_DECIMALS } from "../decimals";
import { stocks } from "../stocks";

/**
 * What this shop lets people pay with.
 *
 * The list is short on purpose. What is being sold here is the idea that the
 * dividend you were paid in Apple stock buys an Apple gift card — a picker
 * padded out with memecoins says something blander, and every entry that cannot
 * actually fill is a promise the checkout has to break later.
 *
 * So it is the equities the vault actually buys and distributes, plus the
 * protocol's own token, plus the two cash legs. Everything else Base carries is
 * still reachable by selling it yourself first; the list is a shortcut, not a
 * gate.
 *
 * ONLY THE EQUITIES THAT ROUTE. This list is derived from the `inIndex` flag in
 * `lib/stocks`, which the swap panel already filters on for the same reason: an
 * index member has an Aerodrome Slipstream USDC pool with depth, because the
 * keeper could not buy it otherwise. Membership is the stronger test, not just
 * a longer one — several listed names now have supply and still have no pool,
 * and offering one would be offering a payment that cannot be made.
 *
 * Because it is derived, admitting an asset to the index adds it here too. That
 * is the intended coupling: what the vault pays you in is what this shop spends.
 *
 * Measured with live exact-output quotes for a $25 order, the day this was
 * written: NVDAc 0.11976811 for exactly 25.00 USDC (~0.1% over spot), AAPLc
 * 0.08038630 (~0.07%), ETH 0.010076 (~0.02%). These are aggregator quotes
 * against real pools and they will not hold six months from now — re-measure
 * with `/api/shop/pay` rather than trusting this paragraph.
 */

/** Velora's native-asset sentinel, matching `app/api/tokens.ts`. */
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const STFY_ADDRESS = process.env.NEXT_PUBLIC_STOCKIFY_TOKEN_ADDRESS ?? "";

/**
 * How a token reaches the USDC the order settles in.
 *
 * `direct` is USDC itself: nothing to convert, an ordinary transfer.
 *
 * `swap` is one exact-output aggregator transaction that delivers the precise
 * figure straight to the order's deposit address. This is every equity and ETH.
 *
 * `router` is STFY, and it is two transactions rather than one for a reason
 * worth stating. An aggregator will happily quote STFY against USDC — and route
 * it through a pool holding a few hundred dollars, at a price the real market
 * would not recognise. The pool that matters is STFY/ETH, which is also the one
 * carrying the protocol's hook: selling into it pays the 3% the vault collects
 * on every other sale, and that 3% buys stock for holders. So STFY is sold
 * through `StockifyRouter` into ETH first, and the ETH pays the order. Spending
 * STFY therefore feeds the vault exactly as trading it does.
 */
export type PayRail = "direct" | "swap" | "router";

export type PayToken = {
  symbol: string;
  /** Company or project name. Shown under the symbol. */
  name: string;
  address: string;
  decimals: number;
  rail: PayRail;
  /** Equities carry a transfer policy; selling one makes the wallet the sender. */
  isB20?: boolean;
  /** Favicon fallback for a mark, when the token names no icon of its own. */
  domain?: string;
};

export type PayGroup = {
  key: string;
  label: string;
  /**
   * Equities are read as tickers, everything else as brands. The two halves of
   * this list are genuinely different kinds of thing, so they are typeset
   * differently rather than flattened into one uniform grid.
   */
  kind: "equity" | "crypto";
  tokens: PayToken[];
};

/**
 * Two groups, and the equities lead.
 *
 * They are what a holder is actually paid in, they are the cheapest thing here
 * to spend, and they are the only reason this shop is interesting. Everything
 * that is not a share of a company is a token, whatever its rail — splitting
 * those three further only made the picker look longer than it is.
 */
export const PAY_GROUPS: PayGroup[] = [
  {
    key: "stocks",
    label: "Stocks",
    kind: "equity",
    tokens: stocks
      .filter((s) => s.inIndex)
      .map((s) => ({
        symbol: s.symbol,
        name: s.name,
        address: s.address,
        // Safe here, and only here: this list is built from `lib/stocks`, which
        // is what makes eight a fact rather than an assumption. See `lib/decimals`.
        decimals: B20_DECIMALS,
        rail: "swap" as const,
        isB20: true,
        domain: s.domain,
      })),
  },
  {
    key: "tokens",
    label: "Tokens",
    kind: "crypto",
    tokens: [
      { symbol: "ETH", name: "Ether", address: NATIVE_ETH, decimals: 18, rail: "swap" },
      // Absent rather than broken when the token address is not configured on a
      // deployment: an entry that cannot be priced is a promise the checkout has
      // to break one screen later.
      ...(/^0x[a-fA-F0-9]{40}$/.test(STFY_ADDRESS)
        ? [
            {
              symbol: "STFY",
              name: "Stockify",
              address: STFY_ADDRESS,
              decimals: 18,
              rail: "router" as const,
            },
          ]
        : []),
      {
        /**
         * One transaction, unlike STFY, and the pools are why.
         *
         * STONKEX carries the same shape of hazard — a STONKEX/WETH v3 pool
         * holding ~$63k next to four STONKEX/USDC v4 pools holding $512, $28,
         * $20 and $2 — but the aggregator picks the deep one, and Velora's two
         * valuations of the trade agree with each other, where STFY's disagreed
         * by 6x. That agreement is what makes this rail safe: whatever the
         * route costs, it is being reported rather than hidden.
         *
         * WHAT IT COSTS MOVES, AND MOVES A LOT. Measured twice within an hour
         * on the same $25 order: 90,140 STONKEX at 0.1% over spot, then 94,941
         * at 5%. Neither is wrong — the pool turns over ten times its own depth
         * in a day. So the checkout says so: anything at or above 3% prints the
         * line about a thin pool, and this token will trip it often.
         *
         * Re-measure before quoting either figure. If a dust pool ever deepens
         * enough to win the route, the symptom is a quote asking for far more
         * STONKEX than the price implies, and the fix is this token moving to
         * the `router` rail the way STFY did.
         */
        symbol: "STONKEX",
        name: "The Stonks Exchange",
        /** Lowercase, like every equity in `lib/stocks.ts`. Not a style choice:
         *  the aggregator validates EIP-55, so a checksum typed by hand is
         *  rejected outright — "srcToken does not match any of the allowed
         *  types" — while an all-lowercase address is always accepted. */
        address: "0x5ab000ff9b9ffe0349ce5ffa5fd86f217c3680f5",
        decimals: 18,
        rail: "swap",
        // No `contractURI()` to read — it is not a B20 — so the mark comes from
        // the site's favicon, checked to answer with a real PNG rather than a
        // redirect to nothing.
        domain: "thestonks.exchange",
      },
      { symbol: "USDC", name: "USD Coin", address: USDC, decimals: 6, rail: "direct" },
    ],
  },
];

/** Flat view, for lookups by address. */
export const PAY_TOKENS: PayToken[] = PAY_GROUPS.flatMap((g) => g.tokens);

export function findPayToken(address: string): PayToken | undefined {
  return PAY_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/**
 * The checkout opens on NOTHING, deliberately, so there is no such constant.
 *
 * A preselected asset is a decision made on the buyer's behalf, and here that
 * decision spends their money: whichever entry sat first would be quietly
 * charged to anyone who pressed the button without reading the picker. Choosing
 * is one click, and it is the one click on this page that should be theirs.
 */

/** The mark for a token, with the icon its own contract names taking priority. */
export type PayTokenView = PayToken & { logo?: string };

/** One group of them, once the marks have been resolved. */
export type PayGroupView = {
  key: string;
  label: string;
  kind: "equity" | "crypto";
  tokens: PayTokenView[];
};
