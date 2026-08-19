// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal Uniswap v4 swap router — settles the input and sends the output to `recipient`.
///
/// Vendored from onlytrifiz/backedfeehook. It exists because the Uniswap interface will not route a
/// pool whose hook is not yet allowlisted, which is precisely the state this hook is in while its
/// review is pending. Used here to put a real trade through ETH/TEST: that activates the one-sided
/// range and proves in production that the hook takes its 3% and forwards it to the vault.
contract SwapHelper is IUnlockCallback {
    IPoolManager public immutable pm;

    struct Data {
        address recipient;
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified;
    }

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    /// exact-input if amountSpecified < 0. Send native ETH as msg.value when selling ETH.
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, address recipient)
        external
        payable
        returns (int128 amount0, int128 amount1)
    {
        bytes memory res = pm.unlock(abi.encode(Data(recipient, key, zeroForOne, amountSpecified)));
        (amount0, amount1) = abi.decode(res, (int128, int128));
        if (address(this).balance > 0) {
            (bool ok,) = msg.sender.call{value: address(this).balance}(""); // refund unused ETH
            require(ok, "refund failed");
        }
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        Data memory d = abi.decode(raw, (Data));
        uint160 limit = d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        BalanceDelta delta = pm.swap(d.key, SwapParams(d.zeroForOne, d.amountSpecified, limit), "");
        _handle(d.key.currency0, delta.amount0(), d.recipient);
        _handle(d.key.currency1, delta.amount1(), d.recipient);
        return abi.encode(delta.amount0(), delta.amount1());
    }

    function _handle(Currency currency, int128 amt, address recipient) private {
        if (amt < 0) {
            uint256 owed = uint256(uint128(-amt));
            if (currency.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(currency);
                IERC20(Currency.unwrap(currency)).transfer(address(pm), owed);
                pm.settle();
            }
        } else if (amt > 0) {
            pm.take(currency, recipient, uint256(uint128(amt)));
        }
    }

    receive() external payable {}
}
