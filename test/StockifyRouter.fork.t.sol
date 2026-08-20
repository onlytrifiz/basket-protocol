// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StockifyRouter} from "../src/StockifyRouter.sol";

/**
 * The router against the LIVE pool, because that is the only thing that answers the question it was
 * built for: an aggregator refuses this pair, so does calling the manager directly work?
 *
 * Forked rather than mocked. A local pool with a stub hook would prove the plumbing and none of the
 * facts that matter — that the hook takes its 300 bps in ETH, that the one-sided range is reachable
 * from both directions, and that the deltas settle against a real manager.
 */
contract StockifyRouterForkTest is Test {
    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    address constant TOKEN = 0xC6405D7a226e1C18E559Be2F335F74C01Ad07bF5;
    address constant HOOK = 0x47Ec48C74f3069e9Ae69406197821996d80200cC;
    uint24 constant FEE = 10_000;
    int24 constant TICK_SPACING = 200;

    StockifyRouter router;
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com")));
        router = new StockifyRouter(PM, TOKEN, FEE, TICK_SPACING, HOOK);
        vm.deal(trader, 10 ether);
    }

    function test_buy_deliversTokensAndChargesTheHook() public {
        uint256 vaultBefore = 0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98.balance;

        vm.prank(trader);
        uint256 out = router.buy{value: 0.01 ether}(0);

        assertGt(out, 0, "no tokens out");
        assertEq(IERC20(TOKEN).balanceOf(trader), out, "tokens did not reach the trader");
        // The hook forwards its 3% to the dividend vault in ETH, in the same transaction.
        assertGt(
            0x4Ee35c658b8032a7577096B60bd51Ae9909E4f98.balance - vaultBefore,
            0,
            "hook fee never reached the vault"
        );
    }

    function test_sell_returnsEth() public {
        vm.prank(trader);
        uint256 bought = router.buy{value: 0.01 ether}(0);

        uint256 ethBefore = trader.balance;
        vm.startPrank(trader);
        IERC20(TOKEN).approve(address(router), bought);
        uint256 out = router.sell(bought, 0);
        vm.stopPrank();

        assertGt(out, 0, "no ETH out");
        assertEq(trader.balance - ethBefore, out, "ETH did not reach the trader");
    }

    function test_minOut_revertsRatherThanFilling() public {
        vm.prank(trader);
        vm.expectRevert();
        router.buy{value: 0.01 ether}(type(uint256).max);
    }

    function test_onlyPoolManagerMayCallBack() public {
        vm.expectRevert(StockifyRouter.OnlyPoolManager.selector);
        router.unlockCallback("");
    }
}
