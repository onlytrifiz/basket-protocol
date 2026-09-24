// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IndexFactory} from "../src/indices/IndexFactory.sol";
import {IndexTreasury} from "../src/indices/IndexTreasury.sol";

interface ILockerV2Identity {
    /// The launcher allowed to register positions. One-shot on the V2 locker, so it identifies it.
    function launcher() external view returns (address);
}

/**
 * Teach a LIVE factory the Stonks Exchange V2 launchpad.
 *
 * Two writes and one deploy. Neither write touches a treasury that already exists: clones are never
 * upgraded, `setImplementation` governs future ones only, and a basket bound to launchpad 0 keeps
 * resolving launchpad 0 on every harvest.
 *
 *     INDEX_FACTORY=0x… forge script script/AddStonksV2.s.sol:AddStonksV2 --rpc-url base
 *     # then, once the simulation reads right, add --broadcast --verify
 *
 * INDEX_FACTORY IS PASSED ON THE COMMAND LINE ON PURPOSE. Foundry auto-loads the repo's `.env`, so
 * an address read with a default would silently prefer whatever is in there; this reads it with no
 * default, and the run fails rather than pointing at the wrong factory.
 *
 * THE ONE THING TO KNOW BEFORE BROADCASTING: `predictAddress` hashes the CURRENT implementation, so
 * from the moment `setImplementation` lands, every address the builder handed out and nobody has
 * created yet becomes a different address. The builder re-reads it on load and `createIndex` is
 * called with `expected`, so a stale tab gets a clean revert rather than a treasury at the wrong
 * address — but a creator who has ALREADY pointed a launch's fees at the old address has to point
 * them again. Pick a quiet moment.
 */
contract AddStonksV2 is Script {
    /// StonksExchangeFeeLockerV2 (proxy) — Aerodrome Slipstream pools, a fee-owner role, one
    /// position per coin.
    address internal constant STONKS_FEE_LOCKER_V2 = 0x43555104f569D17026037E5637691b95c79fD03A;
    /// StonksExchangeLauncherV2 (proxy) — only used to prove the locker above is the right one.
    address internal constant STONKS_LAUNCHER_V2 = 0xD58a240995405941cdbA41cd35d7920F2B212B4a;

    uint8 internal constant LAUNCHPAD_STONKS_V2 = 1;
    uint8 internal constant KIND_FEE_OWNER_LOCKER = 1;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        IndexFactory factory = IndexFactory(vm.envAddress("INDEX_FACTORY"));

        require(vm.addr(pk) == factory.owner(), "signer is not the factory owner");

        /**
         * That the address really is the V2 locker, asked rather than trusted.
         *
         * `setLaunchpad` only checks the target has code, and a wrong address with code would
         * register happily and then answer nothing — every V2 bind failing for a reason no revert
         * names. One staticcall settles it.
         */
        require(
            ILockerV2Identity(STONKS_FEE_LOCKER_V2).launcher() == STONKS_LAUNCHER_V2,
            "that address is not the V2 fee locker"
        );

        /// Refuses to overwrite an id already used for something else. Repointing a launchpad moves
        /// every treasury bound to it at once, which is not what this script is for.
        (address registered,,) = factory.launchpads(LAUNCHPAD_STONKS_V2);
        require(
            registered == address(0) || registered == STONKS_FEE_LOCKER_V2, "launchpad 1 points somewhere else"
        );

        console.log("factory              ", address(factory));
        console.log("implementation (old) ", factory.implementation());

        vm.startBroadcast(pk);

        IndexTreasury implementation = new IndexTreasury();
        factory.setImplementation(address(implementation));
        factory.setLaunchpad(LAUNCHPAD_STONKS_V2, STONKS_FEE_LOCKER_V2, KIND_FEE_OWNER_LOCKER, true);

        vm.stopBroadcast();

        // Read back rather than assumed: a script that reports success without checking is how a
        // half-applied migration gets noticed a week later.
        (address reg, uint8 kind, bool enabled) = factory.launchpads(LAUNCHPAD_STONKS_V2);
        require(factory.implementation() == address(implementation), "implementation did not take");
        require(reg == STONKS_FEE_LOCKER_V2 && kind == KIND_FEE_OWNER_LOCKER && enabled, "launchpad did not take");

        console.log("implementation (new) ", address(implementation));
        console.log("version              ", implementation.VERSION());
        console.log("launchpad 1          ", reg);
        console.log("launchpads now       ", factory.launchpadList().length);
    }
}
