// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Public buy/sell router for the ETH/STFY Uniswap v4 pool
 *
 * @notice WHY THIS EXISTS. Aggregators will not route a pool whose hook is not on their allowlist,
 *         and the Stockify pool's hook never will be while it is unreviewed. Measured against the
 *         live pool: DexScreener indexes it and reports real liquidity, and Velora still answers
 *         "No routes found with enough liquidity" for the same pair. So the site cannot buy its own
 *         token through an aggregator, and calls this instead.
 *
 * @dev    Adapted from onlytrifiz/backed's `BackedRouter`, which solves the identical problem for
 *         the same reason. Two differences worth naming:
 *
 *         `sell` pulls the token in and swaps it in one transaction, so the ERC-20 approval a user
 *         signs is to THIS contract — not to an aggregator's transfer proxy, which is the detail
 *         that silently breaks aggregator integrations.
 *
 *         `minOut` stays, even though Base has no public mempool and therefore no sandwich to
 *         defend against. It is a sanity floor, not MEV protection: the hook takes 300 bps in ETH
 *         on the way through and the pool is thin enough that a mispriced call should revert rather
 *         than fill. Callers who do not care may pass 0.
 *
 *         Stateless. It holds no funds between calls and has no owner.
 */
contract StockifyRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable pm;
    /// @notice STFY. Always currency1: currency0 is native ETH, which sorts first as address(0).
    address public immutable token;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;

    error Slippage(uint256 out, uint256 minOut);
    error OnlyPoolManager();
    error NothingIn();

    constructor(IPoolManager _pm, address _token, uint24 _fee, int24 _tickSpacing, address _hooks) {
        pm = _pm;
        token = _token;
        fee = _fee;
        tickSpacing = _tickSpacing;
        hooks = _hooks;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(hooks)
        });
    }

    /// @notice Buy STFY with native ETH, sent as `msg.value`. The tokens go to `msg.sender`.
    function buy(uint256 minOut) external payable returns (uint256 out) {
        if (msg.value == 0) revert NothingIn();
        out = abi.decode(pm.unlock(abi.encode(true, msg.sender, int256(msg.value), minOut)), (uint256));
    }

    /// @notice Sell `amountIn` STFY for native ETH. Approve this router first; the ETH goes to
    ///         `msg.sender`.
    function sell(uint256 amountIn, uint256 minOut) external returns (uint256 out) {
        if (amountIn == 0) revert NothingIn();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        out = abi.decode(pm.unlock(abi.encode(false, msg.sender, int256(amountIn), minOut)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert OnlyPoolManager();
        (bool isBuy, address user, int256 amountIn, uint256 minOut) = abi.decode(data, (bool, address, int256, uint256));
        PoolKey memory key = poolKey();

        // Buying moves ETH -> STFY, which is currency0 -> currency1, so the price walks DOWN toward
        // MIN_SQRT_PRICE; selling walks the other way. The limits are the extremes because the floor
        // that matters is `minOut`, checked on the output rather than on the price path.
        uint160 limit = isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;

        BalanceDelta delta =
            pm.swap(key, SwapParams({zeroForOne: isBuy, amountSpecified: -amountIn, sqrtPriceLimitX96: limit}), "");

        uint256 out;
        if (isBuy) {
            pm.settle{value: uint256(uint128(-delta.amount0()))}();
            out = uint256(uint128(delta.amount1()));
            if (out < minOut) revert Slippage(out, minOut);
            pm.take(key.currency1, user, out);
        } else {
            // `sync` before transferring is what tells the manager how much of currency1 arrived —
            // without it the settle credits nothing and the swap reverts on an unpaid delta.
            pm.sync(key.currency1);
            IERC20(token).safeTransfer(address(pm), uint256(uint128(-delta.amount1())));
            pm.settle();
            out = uint256(uint128(delta.amount0()));
            if (out < minOut) revert Slippage(out, minOut);
            pm.take(key.currency0, user, out);
        }
        return abi.encode(out);
    }

    /// @dev The manager returns native ETH here during `take`.
    receive() external payable {}
}
