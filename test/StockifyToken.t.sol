// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StockifyToken} from "../src/StockifyToken.sol";

contract StockifyTokenTest is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    StockifyToken internal stfy;

    function setUp() public {
        stfy = new StockifyToken(ALICE, address(this));
    }

    function test_FixedOneBillionSupplyAndInitialHolderRegistryEntry() public view {
        assertEq(stfy.totalSupply(), 1_000_000_000e18);
        assertEq(stfy.minShareBalance(), 100_000e18);
        assertEq(stfy.holderCount(), 1);
        assertEq(stfy.holderAt(0), ALICE);
    }

    function test_RegistryAddsAndRemovesEligibleHolderOnTransfer() public {
        vm.prank(ALICE);
        stfy.transfer(BOB, 100_000e18);
        assertEq(stfy.holderCount(), 2);

        vm.prank(BOB);
        stfy.transfer(ALICE, 1);
        assertEq(stfy.holderCount(), 1);
        assertEq(stfy.holderAt(0), ALICE);
    }

    function test_ThresholdCanOnlyBeSetBetweenTenAndOneHundredThousand() public {
        stfy.setMinShareBalance(10_000e18);
        assertEq(stfy.minShareBalance(), 10_000e18);

        vm.expectRevert(abi.encodeWithSelector(StockifyToken.InvalidMinShareBalance.selector, 9_999e18));
        stfy.setMinShareBalance(9_999e18);
        vm.expectRevert(abi.encodeWithSelector(StockifyToken.InvalidMinShareBalance.selector, 100_001e18));
        stfy.setMinShareBalance(100_001e18);
    }

    function test_RewardsExclusionRemovesAndRestoresHolder() public {
        stfy.setRewardsExcluded(ALICE, true);
        assertEq(stfy.holderCount(), 0);

        stfy.setRewardsExcluded(ALICE, false);
        assertEq(stfy.holderCount(), 1);
        assertEq(stfy.holderAt(0), ALICE);
    }
}
