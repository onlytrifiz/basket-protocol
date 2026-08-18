// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StockifyFeeHook} from "../src/StockifyFeeHook.sol";

/// @notice Mines the CREATE2 salt for the hook's permission flags.
/// @dev Pure local computation: it never reads a B20 precompile, so unlike the full deploy script
/// this one runs inside a simulated EVM. Base B20 assets are native precompiles whose code is the
/// single byte 0xef, which revm rejects as an invalid opcode — that is why Deploy.s.sol cannot be
/// simulated and the contracts are created directly instead.
contract MineHook is Script {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external view {
        address poolManager = vm.envAddress("POOL_MANAGER");
        address vault = vm.envAddress("VAULT");
        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory args = abi.encode(IPoolManager(poolManager), vault);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(StockifyFeeHook).creationCode, args);
        console2.log("hook:", hookAddress);
        console2.log("salt:");
        console2.logBytes32(salt);
    }
}
