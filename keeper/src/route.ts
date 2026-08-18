import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * Self-built WETH → USDC → equity routes for the dividend vault.
 *
 * Routing this ourselves rather than through an aggregator API is the same call the exchange made:
 * B20 equity depth on Base sits in exactly one place today — Aerodrome Slipstream USDC pools at
 * tick spacing 10 — and WETH/USDC is the deepest market on the chain. Two known hops through one
 * allowlisted router means no API key, no rate limit and no third-party outage between the hook fee
 * and the purchase, and the calldata is auditable by eye. The vault still judges the result by its
 * own balance delta, so a stale route fails the buy cleanly instead of filling badly.
 */

export const WETH: Address = "0x4200000000000000000000000000000000000006";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/// Slipstream router for the NEWER CLFactory, where the live equity/USDC pools sit. Each
/// generation's router only reaches its own factory's pools.
export const SLIPSTREAM_ROUTER: Address = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F";
/**
 * There is deliberately no quoter address here. Slipstream quoters are bound to one CLFactory
 * generation exactly like the routers are, and the published one points at the original factory
 * while the equity pools live on Gauges V3. Rather than hunt for a per-generation quoter that can
 * go stale again, the leg is priced by simulating the ROUTER ITSELF — the same call, the same
 * router, the same path that will be broadcast — with the caller's WETH balance and allowance
 * supplied as an eth_call state override. It cannot disagree with execution, and it keeps working
 * whenever a new generation appears.
 */
const WETH_BALANCE_SLOT = 3n;
const WETH_ALLOWANCE_SLOT = 4n;

const WETH_USDC_TICK_SPACING = 50; // the $3.8M pool on this factory
const EQUITY_USDC_TICK_SPACING = 10;

/**
 * Byte offset of `amountIn` inside the exactInput calldata:
 * selector(4) + tuple ptr(32) + path ptr(32) + recipient(32) + deadline(32) = 132.
 * The vault overwrites this word with the amount it actually forwards, so the value encoded
 * below is only a placeholder — the real spend is not knowable until inclusion, because hook
 * fees keep arriving.
 */
export const AMOUNT_IN_OFFSET = 132n;

const exactInputAbi = [
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** Canonical WETH9 layout: `balanceOf` is mapping slot 3, `allowance` mapping slot 4. */
function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
}

function allowanceSlot(owner: Address, spender: Address): Hex {
  const inner = mappingSlot(owner, WETH_ALLOWANCE_SLOT);
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
}

/** Price one leg by simulating the exact router call, with the caller funded and approved. */
async function simulateOut(
  client: PublicClient,
  path: Hex,
  amountIn: bigint,
  caller: Address,
  recipient: Address,
  deadline: bigint,
): Promise<bigint | null> {
  const data = encodeFunctionData({
    abi: exactInputAbi,
    functionName: "exactInput",
    args: [{ path, recipient, deadline, amountIn, amountOutMinimum: 0n }],
  });
  const funded = pad(toHex(amountIn * 2n), { size: 32 });
  try {
    const result = await client.call({
      account: caller,
      to: SLIPSTREAM_ROUTER,
      data,
      stateOverride: [
        {
          address: WETH,
          stateDiff: [
            { slot: mappingSlot(caller, WETH_BALANCE_SLOT), value: funded },
            { slot: allowanceSlot(caller, SLIPSTREAM_ROUTER), value: funded },
          ],
        },
      ],
    });
    if (!result.data || result.data === "0x") return null;
    return BigInt(result.data);
  } catch {
    return null;
  }
}

/** int24 tick spacing → the 3 packed bytes a Slipstream path expects. */
const spacing = (ts: number): Hex => `0x${(ts & 0xffffff).toString(16).padStart(6, "0")}`;

function wethToEquityPath(equity: Address): Hex {
  return encodePacked(
    ["address", "bytes3", "address", "bytes3", "address"],
    [WETH, spacing(WETH_USDC_TICK_SPACING), USDC, spacing(EQUITY_USDC_TICK_SPACING), equity],
  );
}

export type Leg = {
  target: Address;
  calldata: Hex;
  amountInOffset: bigint;
  minOut: bigint;
};

/**
 * Quote and encode one WETH → USDC → equity leg.
 *
 * `amountIn` is the vault's expected spend; `minOut` is sized against it. If the vault ends up
 * forwarding MORE (later hook fees) the leg returns more than `minOut` and passes; if it forwards
 * less, the leg reverts rather than filling badly. Failing is the correct direction.
 */
export async function buildLeg(args: {
  client: PublicClient;
  equity: Address;
  amountIn: bigint;
  recipient: Address;
  slippageBps: number;
  deadlineSeconds: number;
  nowSeconds: number;
}): Promise<Leg | null> {
  const path = wethToEquityPath(args.equity);
  const deadline = BigInt(args.nowSeconds + args.deadlineSeconds);

  const expectedOut = await simulateOut(args.client, path, args.amountIn, args.recipient, args.recipient, deadline);
  if (expectedOut === null || expectedOut === 0n) {
    console.error(`  no Slipstream route for ${args.equity}`);
    return null;
  }

  const minOut = (expectedOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
  if (minOut === 0n) return null;

  const calldata = encodeFunctionData({
    abi: exactInputAbi,
    functionName: "exactInput",
    args: [
      {
        path,
        recipient: args.recipient,
        deadline,
        amountIn: args.amountIn, // placeholder: the vault patches the real spend at AMOUNT_IN_OFFSET
        amountOutMinimum: minOut,
      },
    ],
  });

  return { target: SLIPSTREAM_ROUTER, calldata, amountInOffset: AMOUNT_IN_OFFSET, minOut };
}
