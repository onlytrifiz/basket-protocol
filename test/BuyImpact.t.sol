// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISwapHelper {
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, address recipient) external payable;
}

/// @notice What a given amount of buying does to the price, measured on the live pool rather than
/// modelled. The ETH/TEST pool is the same one-sided shape a real launch would use — whole supply in
/// the range, no ETH posted — so its response is the answer for any token launched that way.
contract BuyImpactTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address constant HELPER = 0xA7063E41685BeC080b812D5C7D1C97e8096F6e3b;
    address constant TEST = 0x0ac61d67420f980B8a5324B0E52C8375736d36C9;
    address constant HOOK = 0x47Ec48C74f3069e9Ae69406197821996d80200cC;
    address constant VAULT = 0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98;

    PoolKey internal key;

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC"));
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(TEST),
            fee: 10_000,
            tickSpacing: 200,
            hooks: IHooks(HOOK)
        });
    }

    function test_BuyImpact() public {
        uint256 spend = vm.envOr("SPEND", uint256(2 ether));
        address buyer = address(0xB0B);
        vm.deal(buyer, spend + 1 ether);

        (, int24 tickBefore,,) = PM.getSlot0(key.toId());
        uint256 vaultBefore = VAULT.balance;

        vm.prank(buyer);
        ISwapHelper(HELPER).swap{value: spend}(key, true, -int256(spend), buyer);

        (, int24 tickAfter,,) = PM.getSlot0(key.toId());

        console2.log("spend wei      :", spend);
        console2.log("tick before    :", tickBefore);
        console2.log("tick after     :", tickAfter);
        console2.log("tokens bought  :", IERC20(TEST).balanceOf(buyer));
        console2.log("hook fee to vault:", VAULT.balance - vaultBefore);
    }
}
