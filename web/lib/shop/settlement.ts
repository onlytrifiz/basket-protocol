/**
 * What an order is denominated in, and where it has to be paid.
 *
 * CryptoRefills settles in a fixed list of coins and networks, and one of them
 * is USDC on Base — which is the chain this whole protocol already lives on.
 * That single coincidence is why there is no bridge anywhere in this shop: the
 * buyer's stock, the swap that sells it, and the address the supplier watches
 * are all on the same chain, so a payment is one ordinary Base transaction.
 *
 * The reference implementation this was ported from had to bridge, because its
 * chain was not on the supplier's list. Everything that existed to make a
 * bridge safe — asking how much to send so a known amount arrives, checking a
 * guaranteed floor, widening slippage for a taxed token — is replaced here by
 * an exact-output swap, which delivers the precise figure or reverts.
 */

export type Settlement = {
  /** Coin and network spelled exactly as `/v3/payment_vias` returns them. */
  coin: string;
  network: string;
  /** Where the payment rail has to deliver, to satisfy that pair. */
  chainId: number;
  token: string;
  decimals: number;
};

/**
 * The one pair this shop can settle.
 *
 * Written as a list rather than a constant because the supplier rejects some
 * brands on a *network* rather than on a coin — a Rewarble voucher refuses USDC
 * on Base and prices happily on Arbitrum — and the quote route walks this list
 * to find out which. Today it finds one entry and the brands that refuse Base
 * are reported as unsellable, honestly, rather than sold as an order nothing
 * here could ever pay.
 *
 * Adding a second entry is not a one-line change: it would need a rail that can
 * deliver to that chain. Keeping the walk means the day such a rail exists, the
 * routes above it do not have to be rewritten to use it.
 */
export const SETTLEMENTS: Settlement[] = [
  {
    coin: "USDC",
    network: "Base",
    chainId: 8453,
    // Circle's canonical USDC on Base — the same address `app/api/tokens.ts`
    // routes against, so the shop and the swap panel cannot disagree.
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
  },
];

export const DEFAULT_SETTLEMENT = SETTLEMENTS[0];

/**
 * The settlement an order is denominated in.
 *
 * Matched on the supplier's own strings, so an upstream rename turns payment
 * off rather than pointing it at the wrong chain.
 */
export function findSettlement(
  coin: string | undefined,
  network: string | undefined,
): Settlement | undefined {
  if (!coin || !network) return undefined;
  return SETTLEMENTS.find(
    (s) =>
      s.coin.toLowerCase() === coin.toLowerCase() &&
      s.network.toLowerCase() === network.toLowerCase(),
  );
}

/**
 * Asked for on top of what the order needs.
 *
 * An exact-output swap delivers exactly what it was asked for, so in principle
 * this could be zero. It is not, because the failure it prevents is asymmetric:
 * an underpaid order is not refunded automatically — the supplier emails the
 * buyer and settles it by hand. A cent of margin is worth less than that
 * conversation, and it is the buyer's cent either way.
 */
export const PAYMENT_BUFFER_RATE = Number(
  process.env.NEXT_PUBLIC_PAYMENT_BUFFER_RATE ?? "0.002",
);

/** At least this much on top, so a sub-cent order still clears by something. */
export const PAYMENT_BUFFER_FLOOR = 0.01;

/** What to actually ask the swap to deliver, rounded up to a whole cent. */
export function payAmount(required: number): number {
  const buffered = Math.max(
    required * (1 + PAYMENT_BUFFER_RATE),
    required + PAYMENT_BUFFER_FLOOR,
  );
  return Math.ceil(buffered * 100 - 1e-9) / 100;
}

/**
 * What the order needs, as a number.
 *
 * Null when the order carries no usable figure, which callers must treat as
 * "this cannot be paid" rather than falling back to zero and offering a payment
 * that settles nothing.
 */
export function requiredAmount(
  coinAmount: string | number | null | undefined,
): number | null {
  const required = Number(coinAmount);
  return Number.isFinite(required) && required > 0 ? required : null;
}

export type PayTarget = {
  settlement: Settlement;
  /** The order's own deposit address, which the swap delivers straight into. */
  address: string;
  required: number;
};

/**
 * What to pay for an order, or null when it cannot be paid here.
 *
 * Everything the payment needs is decided in one place, so a caller cannot
 * half-check it: the asset must be one we recognise, there must be an address
 * to pay, and there must be an amount worth paying. Missing any of those, a
 * payment would send the wrong asset, or the right one somewhere nothing is
 * watching.
 */
export function payTarget(order: {
  coin?: string;
  network?: string;
  wallet_address?: string;
  coin_amount?: string;
}): PayTarget | null {
  const settlement = findSettlement(order.coin, order.network);
  const required = requiredAmount(order.coin_amount);
  if (!settlement || !order.wallet_address || required === null) return null;
  return { settlement, address: order.wallet_address, required };
}

/**
 * The address on a quote, before anyone has said who they are.
 *
 * The supplier wants an email on every price check. This one belongs to nobody
 * and receives nothing: a real address is collected at checkout, and only there.
 */
export const QUOTE_EMAIL = process.env.SHOP_QUOTE_EMAIL ?? "quote@stockify.finance";
