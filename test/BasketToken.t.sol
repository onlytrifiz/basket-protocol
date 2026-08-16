// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BasketToken} from "../src/BasketToken.sol";

contract BasketTokenTest is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    BasketToken internal basket;

    function setUp() public {
        basket = new BasketToken(ALICE, address(this));
    }

    function test_FixedOneBillionSupplyAndInitialHolderRegistryEntry() public view {
        assertEq(basket.totalSupply(), 1_000_000_000e18);
        assertEq(basket.minShareBalance(), 100_000e18);
        assertEq(basket.holderCount(), 1);
        assertEq(basket.holderAt(0), ALICE);
    }

    function test_RegistryAddsAndRemovesEligibleHolderOnTransfer() public {
        vm.prank(ALICE);
        basket.transfer(BOB, 100_000e18);
        assertEq(basket.holderCount(), 2);

        vm.prank(BOB);
        basket.transfer(ALICE, 1);
        assertEq(basket.holderCount(), 1);
        assertEq(basket.holderAt(0), ALICE);
    }

    function test_ThresholdCanOnlyBeSetBetweenTenAndOneHundredThousand() public {
        basket.setMinShareBalance(10_000e18);
        assertEq(basket.minShareBalance(), 10_000e18);

        vm.expectRevert(abi.encodeWithSelector(BasketToken.InvalidMinShareBalance.selector, 9_999e18));
        basket.setMinShareBalance(9_999e18);
        vm.expectRevert(abi.encodeWithSelector(BasketToken.InvalidMinShareBalance.selector, 100_001e18));
        basket.setMinShareBalance(100_001e18);
    }

    function test_RewardsExclusionRemovesAndRestoresHolder() public {
        basket.setRewardsExcluded(ALICE, true);
        assertEq(basket.holderCount(), 0);

        basket.setRewardsExcluded(ALICE, false);
        assertEq(basket.holderCount(), 1);
        assertEq(basket.holderAt(0), ALICE);
    }
}
