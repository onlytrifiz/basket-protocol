// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {VaultGuardian} from "../src/VaultGuardian.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/**
 * Deploy the guardian for an already-live DividendVault.
 *
 *   VAULT=0x… GUARDIAN_OWNER=0x… forge script script/DeployGuardian.s.sol --rpc-url base --broadcast --verify
 *
 * IT DOES NOT INSTALL ITSELF, and that is deliberate. Installing means calling
 * `DividendVault.transferOwnership(guardian)` from the vault's CURRENT owner, which is a one-way
 * door: get the guardian address wrong and the vault is owned by nothing anyone controls. Deploy
 * here, read the address off the console, check `isInstalled()` says false and `vault()` says the
 * right vault, and then send that one transaction yourself.
 *
 * BEFORE YOU SEND IT, understand the one thing that changes: `emergencyWithdrawERC20` pays
 * `owner()`, so recovered tokens will land on the guardian and leave through `sweepERC20`. Same
 * capability, one more hop.
 *
 * The token is NOT in scope. `StockifyToken`'s owner powers — `setMinShareBalance`,
 * `setRewardsExcluded` — have no irreversible call to guard, so wrapping them would add a contract
 * between an operator and a routine setting for nothing.
 */
contract DeployGuardian is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.envUint("PRIVATE_KEY");

        address vault = vm.envAddress("VAULT");
        require(vault.code.length > 0, "DeployGuardian: VAULT holds no code");

        // Who may drive the vault through the guardian. Defaults to whoever owns it today, so the
        // install transaction does not also change who is in charge — one decision per transaction.
        address guardianOwner = vm.envOr("GUARDIAN_OWNER", IOwnable(vault).owner());
        require(guardianOwner != address(0), "DeployGuardian: GUARDIAN_OWNER is zero");

        vm.startBroadcast(pk);
        VaultGuardian guardian = new VaultGuardian(vault, guardianOwner);
        vm.stopBroadcast();

        console2.log("VaultGuardian :", address(guardian));
        console2.log("  vault       :", vault);
        console2.log("  owner       :", guardianOwner);
        console2.log("  current vault owner:", IOwnable(vault).owner());
        console2.log("");
        console2.log("Not installed yet. To install, from the vault's current owner:");
        console2.log("  cast send <VAULT> 'transferOwnership(address)' <GUARDIAN> --rpc-url base");
        console2.log("Then confirm with: cast call <GUARDIAN> 'isInstalled()(bool)' --rpc-url base");
        console2.log("");
        console2.log("After installing, emergencyWithdrawERC20 delivers to the GUARDIAN.");
        console2.log("Move it on with: sweepERC20(token, to, amount).");
    }
}
