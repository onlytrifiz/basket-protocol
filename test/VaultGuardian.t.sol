// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {DividendVault} from "../src/DividendVault.sol";
import {StockifyToken} from "../src/StockifyToken.sol";
import {VaultGuardian} from "../src/VaultGuardian.sol";
import {MockStock} from "./mocks/MockStock.sol";
import {MockVenue} from "./mocks/MockVenue.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

/// The guardian is a claim about one call, so the tests are mostly about that call — plus the two
/// things installing it changes underneath everything else: the emergency path's destination, and
/// which owner functions still reach the vault at all.
contract VaultGuardianTest is Test {
    address internal constant ALICE = address(0x100);
    address internal constant BOB = address(0x200);
    address internal constant CAROL = address(0x300);
    address internal constant MULTISIG = address(0x515);

    StockifyToken internal stfy;
    MockStock internal stock;
    MockWETH internal weth;
    MockVenue internal venue;
    DividendVault internal vault;
    VaultGuardian internal guardian;

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

        stfy.transfer(ALICE, 500_000_000e18);
        stfy.transfer(BOB, 300_000_000e18);
        stfy.transfer(CAROL, 100_000_000e18);

        guardian = new VaultGuardian(address(vault), address(this));
        vault.transferOwnership(address(guardian));
    }

    // ------------------------------------------------------------------ installation

    function test_InstallationMovesOwnershipAndReportsIt() public view {
        assertEq(vault.owner(), address(guardian));
        assertTrue(guardian.isInstalled());
    }

    // ------------------------------------------------------------------ the guard

    function test_AbortIsAllowedWhileNoHolderHasBeenPaid() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10); // a pending snapshot, nothing paid — the case abort is FOR

        (bool allowed, uint256 paid) = guardian.abortAllowed();
        assertTrue(allowed);
        assertEq(paid, 0);

        guardian.execute(abi.encodeCall(DividendVault.abortCycle, ()));
        assertEq(vault.snapshotLength(), 0);
        assertFalse(vault.snapshotPending());
    }

    function test_AbortIsRefusedOnceAPayoutHasStarted() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);
        vault.startCycle();
        vault.distributeBatch(1); // one holder paid — the cycle is now partly settled

        uint256 cursor = vault.cursor();
        assertEq(cursor, 1);

        (bool allowed, uint256 paid) = guardian.abortAllowed();
        assertFalse(allowed);
        assertEq(paid, 1);

        vm.expectRevert(abi.encodeWithSelector(VaultGuardian.CycleIsPartiallyPaid.selector, cursor));
        guardian.execute(abi.encodeCall(DividendVault.abortCycle, ()));

        // And the cycle is untouched: still active, still holding the rest.
        assertTrue(vault.cycleActive());
        assertEq(vault.cursor(), 1);
    }

    /// The reason the refusal is safe: there is always another way out, and it is the correct one.
    function test_APartlyPaidCycleCanAlwaysBeFinishedInstead() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);
        vault.startCycle();

        vault.distributeBatch(1);
        vm.expectRevert(abi.encodeWithSelector(VaultGuardian.CycleIsPartiallyPaid.selector, uint256(1)));
        guardian.execute(abi.encodeCall(DividendVault.abortCycle, ()));

        // One holder at a time, which is what an operator does when gas is the problem.
        while (vault.cycleActive()) {
            vault.distributeBatch(1);
        }

        assertFalse(vault.cycleActive());
        assertEq(stock.balanceOf(ALICE), 50e18);
        assertEq(stock.balanceOf(BOB), 30e18);
        assertEq(stock.balanceOf(CAROL), 10e18);
        assertEq(stock.balanceOf(address(vault)), 0);
    }

    /**
     * The vault does not clear `cursor` when a cycle finishes — the next `startCycle` does — so it
     * sits at the full snapshot length in between. A guard keyed on `cursor != 0` alone refused an
     * abort here, which is the one state where abort is unambiguously harmless AND the state a
     * wedged snapshot is recovered from. This is that regression.
     */
    function test_AbortIsAllowedAgainOnceTheCycleHasClosed() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);
        vault.startCycle();
        vault.distributeBatch(10); // the whole snapshot, in one batch

        assertFalse(vault.cycleActive());
        assertEq(vault.cursor(), 3); // non-zero, and stale

        (bool allowed, uint256 paid) = guardian.abortAllowed();
        assertTrue(allowed);
        assertEq(paid, 3);

        guardian.execute(abi.encodeCall(DividendVault.abortCycle, ()));
        assertEq(vault.cursor(), 0);
    }

    /// A cycle opened but not yet paid out is also safe to abort: nothing has moved.
    function test_AbortIsAllowedOnAnOpenCycleThatHasPaidNobody() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);
        vault.startCycle();

        assertTrue(vault.cycleActive());
        assertEq(vault.cursor(), 0);

        guardian.execute(abi.encodeCall(DividendVault.abortCycle, ()));
        assertFalse(vault.cycleActive());
        assertEq(stock.balanceOf(address(vault)), 90e18); // still all there
    }

    /// What the guardian is actually worth, stated as the loss it prevents.
    function test_TheAbortItRefusesWouldHaveOverpaidThePaidAndUnderpaidTheRest() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);
        vault.startCycle();
        vault.distributeBatch(1); // Alice paid 50

        uint256 aliceAfterFirstBatch = stock.balanceOf(ALICE);
        assertEq(aliceAfterFirstBatch, 50e18);

        // Hand ownership back and abort anyway — the escape hatch, exercised deliberately.
        guardian.execute(abi.encodeCall(Ownable.transferOwnership, (address(this))));
        vault.abortCycle();

        // `startCycle` set nextDistribution an hour out; the next cycle waits for it either way.
        vm.warp(block.timestamp + 1 hours + 1);

        // The 40 left is now re-divided across ALL of them, Alice included.
        vault.snapshotHolders(10);
        vault.startCycle();
        vault.distributeBatch(10);

        // Alice took 50 + her share of the remainder; Bob and Carol got only a share of what was left.
        assertGt(stock.balanceOf(ALICE), 50e18);
        assertLt(stock.balanceOf(BOB), 30e18);
        assertLt(stock.balanceOf(CAROL), 10e18);
    }

    function test_RenounceIsRefusedOutright() public {
        vm.expectRevert(VaultGuardian.RenounceRefused.selector);
        guardian.execute(abi.encodeWithSignature("renounceOwnership()"));
        assertEq(vault.owner(), address(guardian));
    }

    // ------------------------------------------------------------- ordinary forwarding

    function test_EveryOtherOwnerCallStillReachesTheVault() public {
        guardian.execute(abi.encodeCall(DividendVault.setKeeper, (BOB, true)));
        assertTrue(vault.keeper(BOB));

        guardian.execute(abi.encodeCall(DividendVault.setMaxGrossSpendPerCycle, (7 ether)));
        assertEq(vault.maxGrossSpendPerCycle(), 7 ether);

        guardian.execute(abi.encodeCall(DividendVault.setPlatformRecipient, (CAROL)));
        assertEq(vault.platformRecipient(), CAROL);

        guardian.execute(abi.encodeCall(DividendVault.setSwapTarget, (address(venue), true)));
        assertTrue(vault.swapTargets(address(venue)));

        address[] memory stocks = new address[](1);
        stocks[0] = address(stock);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;
        guardian.execute(abi.encodeCall(DividendVault.setIndex, (stocks, weights)));
        assertEq(vault.stocksLength(), 1);
    }

    /// A revert from the vault must arrive as the VAULT's error, or an operator debugs the wrong
    /// contract. `setIndex` during a cycle is the vault's own refusal, not the guardian's.
    function test_AVaultRevertBubblesUpWithItsOwnReason() public {
        stock.mint(address(vault), 90e18);
        vault.snapshotHolders(10);

        address[] memory stocks = new address[](1);
        stocks[0] = address(stock);
        uint16[] memory weights = new uint16[](1);
        weights[0] = 10_000;

        vm.expectRevert(
            abi.encodeWithSelector(
                VaultGuardian.CallFailed.selector, abi.encodeWithSelector(DividendVault.ConfigDuringCycle.selector)
            )
        );
        guardian.execute(abi.encodeCall(DividendVault.setIndex, (stocks, weights)));
    }

    function test_OnlyTheGuardiansOwnerMayForward() public {
        vm.prank(BOB);
        vm.expectRevert(VaultGuardian.NotOwner.selector);
        guardian.execute(abi.encodeCall(DividendVault.setKeeper, (BOB, true)));
    }

    // ------------------------------------------------------------------ the extra hop

    /// The consequence of moving ownership: recovery now lands here, and has to be able to leave.
    function test_EmergencyRecoveryLandsOnTheGuardianAndSweepsOut() public {
        stock.mint(address(vault), 42e18);

        guardian.execute(abi.encodeCall(DividendVault.emergencyWithdrawERC20, (address(stock))));
        assertEq(stock.balanceOf(address(guardian)), 42e18);
        assertEq(stock.balanceOf(address(vault)), 0);

        guardian.sweepERC20(address(stock), MULTISIG, 42e18);
        assertEq(stock.balanceOf(MULTISIG), 42e18);
        assertEq(stock.balanceOf(address(guardian)), 0);
    }

    function test_OnlyTheOwnerMaySweep() public {
        stock.mint(address(guardian), 1e18);
        vm.prank(BOB);
        vm.expectRevert(VaultGuardian.NotOwner.selector);
        guardian.sweepERC20(address(stock), BOB, 1e18);
    }

    function test_SweepsEthOut() public {
        vm.deal(address(guardian), 3 ether);
        guardian.sweepETH(MULTISIG, 3 ether);
        assertEq(MULTISIG.balance, 3 ether);
    }

    // ------------------------------------------------------------------ ownership

    function test_OwnershipIsTwoStep() public {
        guardian.transferOwnership(MULTISIG);
        assertEq(guardian.owner(), address(this)); // not yet
        assertEq(guardian.pendingOwner(), MULTISIG);

        vm.prank(BOB);
        vm.expectRevert(VaultGuardian.NotPendingOwner.selector);
        guardian.acceptOwnership();

        vm.prank(MULTISIG);
        guardian.acceptOwnership();
        assertEq(guardian.owner(), MULTISIG);
        assertEq(guardian.pendingOwner(), address(0));

        // And the old owner is out.
        vm.expectRevert(VaultGuardian.NotOwner.selector);
        guardian.execute(abi.encodeCall(DividendVault.setKeeper, (BOB, true)));
    }

    function test_RejectsZeroAddresses() public {
        vm.expectRevert(VaultGuardian.ZeroAddress.selector);
        new VaultGuardian(address(0), address(this));

        vm.expectRevert(VaultGuardian.ZeroAddress.selector);
        new VaultGuardian(address(vault), address(0));

        vm.expectRevert(VaultGuardian.ZeroAddress.selector);
        guardian.transferOwnership(address(0));
    }

    function test_RejectsCalldataTooShortToCarryASelector() public {
        vm.expectRevert(VaultGuardian.EmptyCall.selector);
        guardian.execute(hex"1234");
    }
}
