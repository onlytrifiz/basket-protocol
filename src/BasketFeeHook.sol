// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THIS PATH IS A MIRROR. The canonical file is `src/StockifyFeeHook.sol`.
//
// It is kept here because this path was the source-code URL submitted to Uniswap's hook review,
// under the repository's former name. The contract below is the exact source of the hook deployed
// on Base at 0x47Ec48C74f3069e9Ae69406197821996d80200cC — verified on Basescan and on Sourcify with
// an `exact_match`, which compares the metadata hash and not merely the runtime code.
//
// Reproduce the build from the CANONICAL path, not from this one. Solidity embeds source paths in
// the metadata it hashes into the deployed bytecode, so recompiling this copy yields the same
// runtime code but a different trailing metadata hash, and byte-for-byte verification would fail.
//
// If you are reviewing this hook: read `src/StockifyFeeHook.sol`. The two are identical below the
// header, and the code is reproduced here only so this URL resolves.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import {BaseHook} from "./vendor/utils/BaseHook.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title StockifyFeeHook
/// @notice Takes a 3% native-ETH fee on both directions of the single ETH/STFY Uniswap v4 pool.
/// @dev ETH must be currency0. The hook forwards the fee to DividendVault, which retains 10% of
/// each keeper-allocated buy as protocol revenue and deploys the other 90% into B20 stock tokens.
contract StockifyFeeHook is BaseHook {
    using SafeCast for uint256;

    uint256 public constant FEE_BPS = 300;
    uint256 internal constant BPS = 10_000;

    address public immutable dividendVault;

    error ZeroAddress();

    /// @dev The recipient is immutable and baked into the CREATE2 initcode, so a wrong value here
    /// cannot be corrected: address(0) would burn 3% of every trade for the life of the pool.
    constructor(IPoolManager poolManager_, address dividendVault_) BaseHook(poolManager_) {
        if (dividendVault_ == address(0)) revert ZeroAddress();
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
