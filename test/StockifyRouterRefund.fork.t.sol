// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StockifyRouter} from "../src/StockifyRouter.sol";

/**
 * The refund, against the live pool — because the bug it fixes only exists against a real one.
 *
 * A mocked pool with unbounded liquidity absorbs whatever it is sent and never reaches the branch
 * under test. What makes this reachable is the shape of the actual position: one-sided, bounded at
 * both ends, so a large enough trade in either direction runs out of range and the swap stops with
 * part of the input untouched.
 *
 * Each test gets its own fork state from `setUp`, so the sizes below cannot contaminate each other.
 */
contract StockifyRouterRefundForkTest is Test {
    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address constant STFY = 0xC6405D7a226e1C18E559Be2F335F74C01Ad07bF5;
    address constant HOOK = 0x47Ec48C74f3069e9Ae69406197821996d80200cC;
    address constant VAULT = 0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98;

    StockifyRouter router;
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        router = new StockifyRouter(PM, STFY, 10_000, 200, HOOK);
        vm.deal(trader, 100_000 ether);
    }

    // ------------------------------------------------------------------ the invariant

    /// Whatever happens, the router keeps nothing. This is the whole fix, stated once.
    function _assertRouterIsEmpty() internal view {
        assertEq(address(router).balance, 0, "router kept ETH");
        assertEq(IERC20(STFY).balanceOf(address(router)), 0, "router kept STFY");
    }

    // ------------------------------------------------------------------ buys

    /// A size the pool absorbs whole: nothing to refund, and the fill is unchanged.
    function test_buy_withinCapacity_refundsNothing() public {
        uint256 before = trader.balance;
        vm.prank(trader);
        uint256 out = router.buy{value: 1 ether}(0);

        assertGt(out, 0);
        assertEq(before - trader.balance, 1 ether, "a full fill must cost the full input");
        _assertRouterIsEmpty();
    }

    /**
     * The case that used to lose money.
     *
     * At the block this was written against, the pool absorbed ~11.4 ETH and a 20 ETH buy left 8 ETH
     * in the router permanently. Asserted as a relationship rather than a number, because the
     * capacity moves with every trade and a hardcoded figure would be a test that expires.
     */
    function test_buy_beyondCapacity_refundsTheRemainder() public {
        uint256 before = trader.balance;
        uint256 vaultBefore = VAULT.balance;

        vm.prank(trader);
        uint256 out = router.buy{value: 2_000 ether}(0);

        uint256 paid = before - trader.balance;
        uint256 hookFee = VAULT.balance - vaultBefore;

        console2.log("sent      : 2000 ether");
        console2.log("kept      :", paid);
        console2.log("  of which hook fee:", hookFee);
        console2.log("refunded  :", 2_000 ether - paid);

        assertGt(out, 0, "no tokens out");
        assertEq(IERC20(STFY).balanceOf(trader), out);
        // The pool could not have taken anywhere near this much: the refund must be real.
        assertLt(paid, 2_000 ether, "nothing was refunded");
        _assertRouterIsEmpty();
    }

    /**
     * Once the range is drained, the next buy REVERTS rather than filling nothing.
     *
     * Worth pinning down, because it is the one case the refund does not have to cover and the
     * reason why is not obvious. A swap that starts with the price already at the limit is refused
     * by the manager itself (`PriceLimitAlreadyExceeded`) instead of returning a zero delta — so
     * there is no "bought nothing, kept everything" state to protect against. The caller keeps their
     * ETH because the whole transaction is undone.
     */
    function test_buy_againstAnEmptiedRange_reverts() public {
        vm.startPrank(trader);
        router.buy{value: 500 ether}(0); // takes what the range holds, refunds the rest
        _assertRouterIsEmpty();

        uint256 before = trader.balance;
        vm.expectRevert(); // PriceLimitAlreadyExceeded, from the manager
        router.buy{value: 500 ether}(0);
        vm.stopPrank();

        assertEq(trader.balance, before, "a reverted buy must cost nothing");
        _assertRouterIsEmpty();
    }

    /// `minOut` still bites first, and a revert leaves nothing behind either.
    function test_buy_slippageStillReverts() public {
        vm.prank(trader);
        vm.expectRevert();
        router.buy{value: 1 ether}(type(uint256).max);
        _assertRouterIsEmpty();
    }

    // ------------------------------------------------------------------ sells

    function test_sell_withinCapacity_refundsNothing() public {
        deal(STFY, trader, 10_000_000e18);
        vm.startPrank(trader);
        IERC20(STFY).approve(address(router), 10_000_000e18);
        uint256 out = router.sell(10_000_000e18, 0);
        vm.stopPrank();

        assertGt(out, 0);
        assertEq(IERC20(STFY).balanceOf(trader), 0, "a full fill must consume the whole input");
        _assertRouterIsEmpty();
    }

    /// The mirror of the buy case: beyond the range the unsold STFY goes back to the seller.
    function test_sell_beyondCapacity_refundsTheRemainder() public {
        uint256 amount = 900_000_000e18;
        deal(STFY, trader, amount);

        vm.startPrank(trader);
        IERC20(STFY).approve(address(router), amount);
        uint256 out = router.sell(amount, 0);
        vm.stopPrank();

        uint256 returned = IERC20(STFY).balanceOf(trader);
        console2.log("sold     :", amount);
        console2.log("returned :", returned);
        console2.log("ETH out  :", out);

        assertGt(out, 0, "no ETH out");
        assertGt(returned, 0, "nothing was returned");
        _assertRouterIsEmpty();
    }

    // ------------------------------------------------------------------ unchanged behaviour

    function test_buy_stillChargesTheHook() public {
        uint256 vaultBefore = VAULT.balance;
        vm.prank(trader);
        router.buy{value: 0.01 ether}(0);
        assertGt(VAULT.balance - vaultBefore, 0, "hook fee never reached the vault");
    }

    function test_onlyPoolManagerMayCallBack() public {
        vm.expectRevert(StockifyRouter.OnlyPoolManager.selector);
        router.unlockCallback("");
    }
}
