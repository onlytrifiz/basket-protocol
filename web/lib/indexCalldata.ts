/**
 * Calldata for `createIndex`, encoded by hand.
 *
 * This site talks to the chain through the injected EIP-1193 provider and ships no ABI encoder — a
 * deliberate choice documented in `components/wallet.tsx`. Every other call it makes is two or three
 * static words, which is why `stfyRoute.ts` gets away with a `pad32`. This one is not: it carries a
 * struct with two dynamic arrays, so the offsets have to be laid out properly.
 *
 *   createIndex(
 *     (address,address,address,address[],uint16[],uint32,uint16,uint8,address),
 *     bytes32,
 *     address
 *   )
 *
 * The encoding is checked against `cast calldata` in `scripts/check-index-calldata.mjs`; if this
 * file is edited, run it. Silently wrong calldata is the failure mode that costs a creator their
 * fee stream, and it is invisible until the transaction reverts or, worse, does not.
 */

export const CREATE_INDEX_SELECTOR = "0xebc5fe3c";

export type IndexConfig = {
  owner: string;
  creator: string;
  quote: string;
  basket: string[];
  /** bps, must sum to 10000. Empty in buyback mode. */
  weights: number[];
  interval: number;
  creatorShareBps: number;
  /** 0 = buy the basket and pay holders. 1 = buy the coin back and burn it. */
  mode: number;
  /** Already launched AND already pointing here? Bind atomically. Zero binds later. */
  coin: string;
};

const WORD = 32;
const pad32 = (value: string | number | bigint) =>
  (typeof value === "string" ? value.replace(/^0x/, "") : value.toString(16))
    .toLowerCase()
    .padStart(64, "0");

/** A dynamic array of 32-byte-encodable values: its length, then the values. */
const array = (values: (string | number)[]) =>
  pad32(values.length) + values.map((v) => pad32(v)).join("");

export function encodeCreateIndex(cfg: IndexConfig, salt: string, expected: string): string {
  /**
   * The struct is dynamic, so the outer call points at it rather than inlining it. Three head words
   * — the offset, then the two static arguments — and the struct's own encoding follows.
   */
  const headWords = 3;
  const cfgOffset = headWords * WORD;

  // Inside the struct: nine head words, then the two arrays, at offsets measured from the struct's
  // own start rather than from the start of the calldata. Getting that origin wrong is the classic
  // way to produce something that decodes to garbage instead of reverting.
  const structHeadWords = 9;
  const basketOffset = structHeadWords * WORD;
  const weightsOffset = basketOffset + (1 + cfg.basket.length) * WORD;

  const struct =
    pad32(cfg.owner) +
    pad32(cfg.creator) +
    pad32(cfg.quote) +
    pad32(basketOffset) +
    pad32(weightsOffset) +
    pad32(cfg.interval) +
    pad32(cfg.creatorShareBps) +
    pad32(cfg.mode) +
    pad32(cfg.coin) +
    array(cfg.basket) +
    array(cfg.weights);

  return CREATE_INDEX_SELECTOR + pad32(cfgOffset) + pad32(salt) + pad32(expected) + struct;
}

/**
 * The salt that ties a predicted address to the wallet that will deploy it.
 *
 * `predictAddress` hashes (deployer, salt), so a salt derived from the deployer means nobody else
 * can take the address a creator has already been shown — and the same wallet gets the same address
 * back if it walks away and returns.
 *
 * `nonce` IS WHAT MAKES A SECOND INDEX POSSIBLE, and its absence was a bug rather than a limit. The
 * salt used to be the wallet alone, which is one address per wallet FOREVER: `create2` at an
 * occupied address returns zero and the factory reverts `CloneFailed`. A creator who wanted a
 * second basket — or who had to replace one that was configured wrong, which is exactly how this
 * was found — could not, from that wallet, ever again.
 *
 * The caller passes the first nonce whose predicted address is still empty, so the stability the
 * original design wanted survives: walk away and come back to the same address, until you actually
 * use it.
 */
export async function saltFor(account: string, nonce = 0): Promise<string> {
  // Nonce 0 keeps the original preimage byte-for-byte, so an address already shown to a creator
  // under the previous version is still the one they get.
  const seed = nonce === 0
    ? `stockify-indices:${account.toLowerCase()}`
    : `stockify-indices:${account.toLowerCase()}:${nonce}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
