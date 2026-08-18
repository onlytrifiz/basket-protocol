// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StockifyToken} from "../src/StockifyToken.sol";
import {DividendVault} from "../src/DividendVault.sol";
import {MockStock} from "./mocks/MockStock.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockVenue} from "./mocks/MockVenue.sol";

contract DividendVaultTest is Test {
    address internal constant ALICE = address(0x100);
    address internal constant BOB = address(0x200);

    StockifyToken internal stfy;
    MockStock internal stock;
    DividendVault internal vault;
    MockWETH internal weth;
    MockVenue internal venue;

    function setUp() public {
        stfy = new StockifyToken(address(this), address(this));
        stock = new MockStock("NVIDIAc", "NVDAc");
        weth = new MockWETH();
        venue = new MockVenue(weth);

        address[] memory stocks = new address[](1);
        stocks[0] = address(stock);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        // address(this) stands in for v4 PoolManager and is excluded from the dividend snapshot.
        vault = new DividendVault(
            address(stfy), address(weth), address(this), address(this), address(this), stocks, weights
        );
        vault.setKeeper(address(this), true);
        vault.setSwapTarget(address(venue), true);

        stfy.transfer(ALICE, 600_000_000e18);
        stfy.transfer(BOB, 300_000_000e18);
    }

    function test_DistributesProRataFromOnchainHolderRegistry() public {
        stock.mint(address(vault), 90e18);

        _startCycleInPages(10);
        vault.distributeBatch(10);

        assertEq(vault.eligibleSupply(), 900_000_000e18);
        assertEq(stock.balanceOf(ALICE), 60e18);
        assertEq(stock.balanceOf(BOB), 30e18);
        assertEq(stock.balanceOf(address(vault)), 0);
    }

    function test_SnapshotCanBePaginatedAndIncludesNoOffchainHolderInput() public {
        stock.mint(address(vault), 90e18);

        // Index 0 is the excluded pool-manager stand-in; Alice and Bob are captured in later pages.
        vault.snapshotHolders(1);
        vm.expectRevert(DividendVault.SnapshotIncomplete.selector);
        vault.startCycle();

        vault.snapshotHolders(1);
        vault.snapshotHolders(1);
        vault.startCycle();
        vault.distributeBatch(1);
        vault.distributeBatch(10);

        assertEq(stock.balanceOf(ALICE), 60e18);
        assertEq(stock.balanceOf(BOB), 30e18);
    }

    function test_LiveBalanceCapsSnapshotWeight() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);

        vm.prank(BOB);
        stfy.transfer(ALICE, 300_000_000e18);

        vault.startCycle();
        vault.distributeBatch(10);

        assertEq(stock.balanceOf(ALICE), 60e18, "Alice is capped at her snapshot balance");
        assertEq(stock.balanceOf(BOB), 0, "Bob sold before payout");
        assertEq(stock.balanceOf(address(vault)), 30e18, "unpaid snapshot share remains for a future cycle");
    }

    function test_OwnerCanReplaceIndexWithoutStrandingRemovedStock() public {
        MockStock secondStock = new MockStock("Applec", "AAPLc");
        stock.mint(address(vault), 90e18);

        address[] memory newIndex = new address[](1);
        newIndex[0] = address(secondStock);
        uint16[] memory newWeights = new uint16[](1);
        newWeights[0] = 10_000;
        vault.setIndex(newIndex, newWeights);

        assertEq(vault.stocksLength(), 1);
        (address activeStock,) = vault.stockAt(0);
        assertEq(activeStock, address(secondStock));
        assertEq(vault.distributionStocksLength(), 2, "removed stock remains distributable");

        _startCycleInPages(10);
        vault.distributeBatch(10);

        assertEq(stock.balanceOf(ALICE), 60e18);
        assertEq(stock.balanceOf(BOB), 30e18);
    }

    function test_IndexCannotChangeDuringPendingSnapshotOrCycle() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(1);

        address[] memory newIndex = new address[](1);
        newIndex[0] = address(stock);
        uint16[] memory newWeights = new uint16[](1);
        newWeights[0] = 10_000;
        vm.expectRevert(DividendVault.ConfigDuringCycle.selector);
        vault.setIndex(newIndex, newWeights);
    }

    function test_B20RejectedRecipientDoesNotBlockOtherHolders() public {
        stock.mint(address(vault), 90e18);
        stock.setBlocked(BOB, true);

        _startCycleInPages(10);
        vault.distributeBatch(10);

        assertEq(stock.balanceOf(ALICE), 60e18);
        assertEq(stock.balanceOf(BOB), 0);
        assertEq(stock.balanceOf(address(vault)), 30e18);
        assertEq(vault.unpaidDividend(address(stock), BOB), 30e18);
        assertEq(vault.unpaidTotal(address(stock)), 30e18);
    }

    function test_RetriesExactUnpaidB20DividendWithoutRedistributingIt() public {
        stock.mint(address(vault), 90e18);
        stock.setBlocked(BOB, true);
        _startCycleInPages(10);
        vault.distributeBatch(10);

        stock.setBlocked(BOB, false);
        vault.flushUnpaidDividend(BOB, address(stock));

        assertEq(stock.balanceOf(ALICE), 60e18, "Alice cannot receive Bob's deferred dividend");
        assertEq(stock.balanceOf(BOB), 30e18);
        assertEq(stock.balanceOf(address(vault)), 0);
        assertEq(vault.unpaidTotal(address(stock)), 0);
    }

    function test_BuyKeepsTenPercentForPlatformAndNinetyPercentForStocks() public {
        vm.deal(address(vault), 10 ether);
        address[] memory targets = new address[](1);
        targets[0] = address(venue);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(MockVenue.swapExactIn, (0, address(stock)));
        uint256[] memory offsets = new uint256[](1);
        offsets[0] = 4;
        uint256[] memory minOuts = new uint256[](1);
        minOuts[0] = 90 ether;

        vault.buyStocks(targets, calls, offsets, minOuts);

        assertEq(vault.platformClaimable(), 1 ether);
        assertEq(stock.balanceOf(address(vault)), 90 ether);
        assertEq(address(vault).balance, 1 ether, "only the accrued platform fee remains in the vault");
        assertEq(vault.availableEth(), 0);
    }

    function test_EnforcesHourlyDistributionCadence() public {
        stock.mint(address(vault), 90e18);
        _startCycleInPages(10);
        vault.distributeBatch(10);

        stock.mint(address(vault), 90e18);
        vm.expectRevert(abi.encodeWithSelector(DividendVault.TooSoon.selector, block.timestamp + 1 hours));
        vault.snapshotHolders(10);
    }

    function test_OwnerCanEmergencyWithdrawEntireERC20Balance() public {
        stock.mint(address(vault), 90e18);

        uint256 withdrawn = vault.emergencyWithdrawERC20(address(stock));

        assertEq(withdrawn, 90e18);
        assertEq(stock.balanceOf(address(this)), 90e18);
        assertEq(stock.balanceOf(address(vault)), 0);
    }

    function test_NonOwnerCannotEmergencyWithdrawERC20() public {
        stock.mint(address(vault), 90e18);

        vm.prank(ALICE);
        vm.expectRevert();
        vault.emergencyWithdrawERC20(address(stock));

        assertEq(stock.balanceOf(address(vault)), 90e18);
    }

    function _startCycleInPages(uint256 pageSize) internal {
        vault.snapshotHolders(pageSize);
        vault.startCycle();
    }
}
