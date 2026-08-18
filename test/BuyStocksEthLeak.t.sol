// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StockifyToken} from "../src/StockifyToken.sol";
import {DividendVault} from "../src/DividendVault.sol";
import {MockStock} from "./mocks/MockStock.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockVenue} from "./mocks/MockVenue.sol";

/// @notice Regression tests for the purchase leg.
///
/// Two defects are pinned here. The vault used to forward a spend recomputed from its own live
/// balance against calldata priced earlier, so hook fees landing before inclusion left ETH in the
/// router; and it charged the 10% platform fee on its balance rather than on ETH actually consumed,
/// so anything a route handed back was taxed again on the next call. The venue is now allowlisted,
/// the real amount is patched into the route, and the fee follows the measured spend.
contract BuyStocksTest is Test {
    StockifyToken internal stfy;
    MockStock internal stock;
    MockWETH internal weth;
    MockVenue internal venue;
    DividendVault internal vault;

    function setUp() public {
        stfy = new StockifyToken(address(this), address(this));
        stock = new MockStock("NVIDIAc", "NVDAc");
        weth = new MockWETH();
        venue = new MockVenue(weth);

        address[] memory stocks = new address[](1);
        stocks[0] = address(stock);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        vault = new DividendVault(
            address(stfy), address(weth), address(this), address(this), address(this), stocks, weights
        );
        vault.setKeeper(address(this), true);
        vault.setSwapTarget(address(venue), true);
        vault.setMaxGrossSpendPerCycle(0);
    }

    function _legs(bytes memory data, uint256 offset, uint256 minOut, address target)
        internal
        pure
        returns (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m)
    {
        t = new address[](1);
        d = new bytes[](1);
        o = new uint256[](1);
        m = new uint256[](1);
        (t[0], d[0], o[0], m[0]) = (target, data, offset, minOut);
    }

    function test_SpendIsPatchedSoLateHookFeesAreDeployedNotStranded() public {
        vm.deal(address(vault), 10 ether);

        // The route is built with a placeholder amount; the vault overwrites it at execution.
        bytes memory route = abi.encodeCall(MockVenue.swapExactIn, (1 wei, address(stock)));
        (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m) =
            _legs(route, 4, 1, address(venue));

        // Two more ETH of hook fees land before inclusion.
        vm.deal(address(vault), 12 ether);
        vault.buyStocks(t, d, o, m);

        // 90% of the full 12 ETH was deployed — the placeholder did not cap it, and nothing was
        // left in the venue beyond what it actually pulled.
        assertEq(stock.balanceOf(address(vault)), 108 ether, "10.8 ETH deployed at rate 10");
        assertEq(vault.platformClaimable(), 1.2 ether, "fee is one ninth of what was spent");
        assertEq(weth.balanceOf(address(vault)), 0, "no WETH left behind");
        assertEq(address(vault).balance, 1.2 ether);
    }

    function test_FeeFollowsRealSpendWhenAVenueConsumesLess() public {
        vm.deal(address(vault), 10 ether);
        // The venue is handed 9 ETH of allowance but pulls only 1.
        bytes memory route = abi.encodeCall(MockVenue.swapPartial, (0, address(stock), 1 ether));
        (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m) =
            _legs(route, 4, 1, address(venue));

        vault.buyStocks(t, d, o, m);

        assertEq(stock.balanceOf(address(vault)), 10 ether);
        assertEq(vault.platformClaimable(), (uint256(1 ether) * 1_000) / 9_000, "taxed on 1 ETH, not 10");
        // The 8 unspent ETH came back out of WETH and stays in the dividend budget.
        assertEq(weth.balanceOf(address(vault)), 0);
        assertGt(vault.availableEth(), 8.8 ether);
    }

    function test_RejectsAnUnlistedVenue() public {
        vm.deal(address(vault), 10 ether);
        MockVenue rogue = new MockVenue(weth);
        bytes memory route = abi.encodeCall(MockVenue.swapExactIn, (0, address(stock)));
        (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m) =
            _legs(route, 4, 1, address(rogue));

        vm.expectRevert(abi.encodeWithSelector(DividendVault.SwapTargetNotAllowed.selector, address(rogue)));
        vault.buyStocks(t, d, o, m);
    }

    function test_RejectsAnOffsetInsideTheSelector() public {
        vm.deal(address(vault), 10 ether);
        bytes memory route = abi.encodeCall(MockVenue.swapExactIn, (0, address(stock)));
        (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m) =
            _legs(route, 3, 1, address(venue));

        vm.expectRevert(DividendVault.BadAmountOffset.selector);
        vault.buyStocks(t, d, o, m);
    }

    function test_RejectsAnOffsetPastTheEnd() public {
        vm.deal(address(vault), 10 ether);
        bytes memory route = abi.encodeCall(MockVenue.swapExactIn, (0, address(stock)));
        (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m) =
            _legs(route, route.length - 4, 1, address(venue));

        vm.expectRevert(DividendVault.BadAmountOffset.selector);
        vault.buyStocks(t, d, o, m);
    }

    function test_AllowanceIsRevokedAfterEveryLeg() public {
        vm.deal(address(vault), 10 ether);
        bytes memory route = abi.encodeCall(MockVenue.swapExactIn, (0, address(stock)));
        (address[] memory t, bytes[] memory d, uint256[] memory o, uint256[] memory m) =
            _legs(route, 4, 1, address(venue));

        vault.buyStocks(t, d, o, m);
        assertEq(weth.allowance(address(vault), address(venue)), 0, "no standing allowance survives");
    }

    receive() external payable {}
}
