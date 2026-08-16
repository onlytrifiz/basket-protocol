// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./vendor/utils/BaseHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title BasketFeeHook
/// @notice Takes a 3% native-ETH fee on both directions of the single ETH/BASKET Uniswap v4 pool.
/// @dev ETH must be currency0. The hook forwards the fee to DividendVault, which retains 10% of
/// each keeper-allocated buy as protocol revenue and deploys the other 90% into B20 stock tokens.
contract BasketFeeHook is BaseHook {
    using SafeCast for uint256;

    uint256 public constant FEE_BPS = 300;
    uint256 internal constant BPS = 10_000;

    address public immutable dividendVault;

    constructor(IPoolManager poolManager_, address dividendVault_) BaseHook(poolManager_) {
        dividendVault = dividendVault_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// ETH is specified on an exact-input buy and exact-output sell.
    function _ethSpecified(SwapParams calldata params) internal pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!key.currency0.isAddressZero() || !_ethSpecified(params)) {
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 amount = params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = (amount * FEE_BPS) / BPS;
        if (fee == 0) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        poolManager.take(key.currency0, dividendVault, fee);
        return (this.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        if (!key.currency0.isAddressZero() || _ethSpecified(params)) return (this.afterSwap.selector, 0);

        int128 amount0 = delta.amount0();
        uint256 amount = amount0 < 0 ? uint256(uint128(-amount0)) : uint256(uint128(amount0));
        uint256 fee = (amount * FEE_BPS) / BPS;
        if (fee == 0) return (this.afterSwap.selector, 0);

        poolManager.take(key.currency0, dividendVault, fee);
        return (this.afterSwap.selector, fee.toInt128());
    }
}
