/** Only what the keeper calls. The full ABIs live with the contracts. */

export const factoryAbi = [
  { type: "function", name: "indexCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "indexesPaged",
    stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "address[]" }],
  },
  { type: "function", name: "venue", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "weth", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "keeper", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * The errors are here for one reason: viem can only name a revert it can find in the ABI, and a
 * keeper that reports "execution reverted" cannot tell a contract refusing it from a node having a
 * bad minute. One of those is worth retrying forever and the other never is.
 */
const treasuryErrors = [
  "AlreadyInitialized", "NotOwner", "NotCreator", "NotKeeper", "Paused", "Reentrancy",
  "AlreadyBound", "NotFeeRecipient", "NotBound", "BadConfig", "NotInBasket", "BadSellToken",
  "RouterCallFailed", "NothingToDistribute", "NothingToClaim", "NoEligibleHolders",
  "UnsortedHolders", "RoundOverspent", "NotAContract", "ProtectedAsset", "TransferFailed",
  "AllocateInstead",
].map((name) => ({ type: "error" as const, name, inputs: [] }));

export const treasuryAbi = [
  ...treasuryErrors,
  // The ones that carry values, so the numbers survive into the log.
  { type: "error", name: "ExceedsAvailable", inputs: [{ name: "wanted", type: "uint256" }, { name: "available", type: "uint256" }] },
  { type: "error", name: "Overspent", inputs: [{ name: "spent", type: "uint256" }, { name: "declared", type: "uint256" }] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "got", type: "uint256" }, { name: "wanted", type: "uint256" }] },
  { type: "error", name: "TooSoon", inputs: [{ name: "readyAt", type: "uint256" }] },
  /**
   * An index quoted in something its launch will never pay. Named here so the bind is
   * marked permanently unbindable instead of retried every cycle: no amount of waiting fixes it —
   * the composition is immutable, so the creator has to build the basket again with the right quote.
   */
  {
    type: "error",
    name: "QuoteMismatch",
    inputs: [{ name: "pairedAsset", type: "address" }, { name: "quote", type: "address" }],
  },

  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "coin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "quote", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  /** 0 = buy the basket and pay it to holders · 1 = buy the coin back and destroy it. */
  { type: "function", name: "mode", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  /**
   * Destroys the coin the treasury holds. Permissionless — it has one destination and cannot be
   * pointed anywhere — so the keeper calls it, but so can anybody if the keeper is down.
   */
  { type: "function", name: "burn", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  /**
   * The custom errors, so a revert arrives with a name instead of "execution reverted".
   *
   * viem can only name what the ABI declares, and several of these are ordinary outcomes rather
   * than faults — `NothingToBurn` is what a buyback says on a cycle that bought nothing, and telling
   * it apart from a real failure is the difference between a quiet log and a wall of red.
   */
  { type: "error", name: "NothingToBurn", inputs: [] },
  { type: "error", name: "NothingToDistribute", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "NotKeeper", inputs: [] },
  { type: "error", name: "NotOwner", inputs: [] },
  { type: "error", name: "Paused", inputs: [] },
  { type: "error", name: "AlreadyBound", inputs: [] },
  { type: "error", name: "NotFeeRecipient", inputs: [] },
  { type: "error", name: "SplitNotWhole", inputs: [{ name: "recipients", type: "uint256" }] },
  { type: "error", name: "QuoteMismatch", inputs: [{ name: "pairedAsset", type: "address" }, { name: "quote", type: "address" }] },
  { type: "error", name: "TooSoon", inputs: [{ name: "readyAt", type: "uint256" }] },
  { type: "error", name: "NoEligibleHolders", inputs: [] },
  { type: "error", name: "UnsortedHolders", inputs: [] },
  { type: "error", name: "RoundOverspent", inputs: [] },
  { type: "error", name: "ExceedsAvailable", inputs: [{ name: "wanted", type: "uint256" }, { name: "available", type: "uint256" }] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "got", type: "uint256" }, { name: "wanted", type: "uint256" }] },
  { type: "error", name: "VenueNotAllowed", inputs: [{ name: "venue", type: "address" }] },
  { type: "error", name: "RouterCallFailed", inputs: [] },
  { type: "error", name: "AllocateInstead", inputs: [] },
  { type: "error", name: "NotInBasket", inputs: [] },
  { type: "error", name: "BadConfig", inputs: [] },
  { type: "function", name: "interval", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "batchWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "minHolderBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spendableQuote", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "excluded", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "basketAll",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }, { type: "uint16[]" }],
  },
  {
    type: "function",
    name: "pending",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "readyAt", type: "uint256" }],
  },
  { type: "function", name: "bind", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "swap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "venue", type: "address" },
      { name: "sellToken", type: "address" },
      { name: "sellAmount", type: "uint256" },
      { name: "buyToken", type: "address" },
      { name: "minBuyAmount", type: "uint256" },
      { name: "routerCalldata", type: "bytes" },
    ],
    outputs: [{ type: "uint256" }],
  },
  /**
   * Sets aside quote asset for the basket entry that IS the quote asset — no trade involved.
   * Only exists on implementations that allow a basket to hold what pays it.
   */
  {
    type: "function",
    name: "allocate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "basketIdx", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  /**
   * The same call sent to Uniswap's router. Only indexes cloned from the implementation that
   * introduced it have this: on an older clone the selector does not exist and the call reverts,
   * which is how the keeper tells the generations apart without asking anyone.
   */

  {
    type: "function",
    name: "distribute",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "address[]" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "distributeAmount",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address[]" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "setExcludedBatch",
    stateMutability: "nonpayable",
    inputs: [{ type: "address[]" }, { type: "bool" }],
    outputs: [],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * pons' fee escrow (V2FeeEscrow, verified on Blockscout).
 *
 * `Credited(recipient, source)` is what makes automatic binding possible: `source` is the launch's
 * bonding curve, so the launch itself states whose fees a treasury is receiving. Cross it with
 * `TokenLaunched(token, curve)` and the coin follows — no guessing, and nothing an outsider can forge
 * without actually pointing a real launch's fees at that treasury.
 */
/** StonkFeeLocker2 — only what the keeper reads. */
export const lockerAbi = [
  {
    type: "function",
    name: "tokenQuote",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "tokenCreator",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "splitsOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "to", type: "address" },
          { name: "bps", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/**
 * The event that says a coin's fee split changed.
 *
 * `recipients` is a COUNT, not a list — the locker does not index who was named — so this can only
 * narrow the search to a token. `splitsOf` then settles whether that token pays a given treasury.
 */
export const creatorSplitSetAbi = [
  {
    type: "event",
    name: "CreatorSplitSet",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "by", type: "address", indexed: true },
      { name: "recipients", type: "uint256", indexed: false },
    ],
  },
] as const;

export const v3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;
