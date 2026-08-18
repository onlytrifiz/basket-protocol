// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {StockifyToken} from "../src/StockifyToken.sol";
import {StockifyFeeHook} from "../src/StockifyFeeHook.sol";
import {DividendVault} from "../src/DividendVault.sol";

/// @title Deploy Stockify on Base Mainnet
/// @notice Deploys the 1B STFY token, its configurable B20 stock dividend vault, and the 3%
/// ETH hook. It intentionally DOES NOT initialize or seed a v4 pool.
/// @dev Every initial address below was supplied from the Base B20 catalogue; public pools and the
/// STFY initial price will be decided independently before a later pool-initialization transaction.
contract Deploy is Script {
    // Official Uniswap v4 Base deployments: https://developers.uniswap.org/docs/protocols/v4/deployments#base-8453
    address internal constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        // Accept either name so the key can be labelled for what it is.
        uint256 privateKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (privateKey == 0) privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address protocolOwner = vm.envOr("PROTOCOL_OWNER", deployer);
        address platformRecipient = vm.envOr("PLATFORM_RECIPIENT", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        address poolManager = vm.envOr("POOL_MANAGER", BASE_POOL_MANAGER);
        address weth = vm.envOr("WETH", BASE_WETH);
        (address[] memory stocks, uint16[] memory weights) = _initialIndex();

        // The constants below are Base mainnet deployments. If they are in use, we must be on Base;
        // overriding POOL_MANAGER (fork, testnet) lifts the constraint on its own.
        require(
            poolManager != BASE_POOL_MANAGER || block.chainid == 8453,
            "Deploy: Base mainnet defaults used on another chain"
        );

        // Ownership transfer is a one-way door, so on mainnet the silent default to the deployer is
        // refused by default. ALLOW_HOT_KEY_OWNER=1 is the deliberate opt-in for launching with the
        // deploy key as owner and keeper, with the intent of handing over to a multisig later.
        bool allowHotKey = vm.envOr("ALLOW_HOT_KEY_OWNER", false);
        if (block.chainid == 8453 && !allowHotKey) {
            require(protocolOwner != deployer, "Deploy: set PROTOCOL_OWNER to a multisig, or ALLOW_HOT_KEY_OWNER=1");
            require(protocolOwner.code.length > 0, "Deploy: PROTOCOL_OWNER must be a contract");
            require(keeper != deployer, "Deploy: set KEEPER to a dedicated key, or ALLOW_HOT_KEY_OWNER=1");
        }

        vm.startBroadcast(privateKey);

        // Deploy under the broadcaster long enough to complete the one-time cross-contract
        // configuration, then hand both contracts to the protocol multisig.
        StockifyToken token = new StockifyToken(deployer, deployer);
        DividendVault vault = new DividendVault(
            address(token), weth, deployer, platformRecipient, poolManager, stocks, weights
        );

        // Keep infrastructure balances out of the token's on-chain reward registry. The token's
        // owner-controlled exclusion setting intentionally follows the reference implementation.
        token.setRewardsExcluded(poolManager, true);
        token.setRewardsExcluded(address(vault), true);
        token.setRewardsExcluded(0x000000000000000000000000000000000000dEaD, true);

        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory constructorArgs = abi.encode(IPoolManager(poolManager), address(vault));
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(StockifyFeeHook).creationCode, constructorArgs);
        StockifyFeeHook hook = new StockifyFeeHook{salt: salt}(IPoolManager(poolManager), address(vault));
        require(address(hook) == expectedHook, "hook address mismatch");

        // The configured keeper is the only account that can submit Trading API routes and
        // advance on-chain snapshots/payout batches. A capped default limits hot-key exposure.
        address[] memory targets = _swapTargets();
        for (uint256 i; i < targets.length; ++i) {
            vault.setSwapTarget(targets[i], true);
        }

        vault.setKeeper(keeper, true);
        vault.setMaxGrossSpendPerCycle(vm.envOr("MAX_GROSS_SPEND_PER_CYCLE", uint256(0.25 ether)));

        if (protocolOwner != deployer) {
            token.transferOwnership(protocolOwner);
            vault.transferOwnership(protocolOwner);
        }

        vm.stopBroadcast();

        console2.log("StockifyToken:     ", address(token));
        console2.log("DividendVault:   ", address(vault));
        console2.log("StockifyFeeHook:   ", address(hook));
        console2.log("PoolManager:     ", poolManager);
        console2.log("WETH:            ", weth);
        console2.log("Owner:           ", protocolOwner);
        console2.log("Keeper:          ", keeper);
        console2.log("PlatformRecipient:", platformRecipient);
        if (protocolOwner == deployer) {
            console2.log("");
            console2.log("WARNING: owner is the deploy key, not a multisig.");
            console2.log("It can call emergencyWithdrawERC20, setKeeper and setMinShareBalance.");
            console2.log("Hand both contracts to a multisig before the pool goes live.");
        }
        console2.log("Pool deliberately uninitialized. Next: decide price/LP, then initialize and seed ETH/STFY.");
    }

    /// @dev Only the B20 assets that are actually issued on Base today. The other nine names in
    /// the catalogue report `totalSupply() == 0`, and the keeper skips the entire purchase whenever
    /// any active asset lacks a complete route — so including them would stall every buy forever.
    /// Additional names can be admitted later with `setIndex` once they have supply and liquidity.
    /// @dev Venues the keeper may route purchases through, each verified on-chain before listing.
    /// Uniswap's Universal Router is deliberately absent: its pulls go through Permit2, which does
    /// not fit the approve-the-target pattern; SwapRouter02 covers Uniswap with plain allowances.
    /// The live B20 equity/USDC depth sits on the Gauges V3 Slipstream factory, and each
    /// generation's router only reaches its own factory's pools, so both Slipstream routers are here.
    function _swapTargets() private pure returns (address[] memory t) {
        t = new address[](5);
        t[0] = 0x0000000000001fF3684f28c67538d4D072C22734; // 0x AllowanceHolder
        t[1] = 0x2626664c2603336E57B271c5C0b26F421741e481; // Uniswap SwapRouter02
        t[2] = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5; // Aerodrome Slipstream SwapRouter
        t[3] = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43; // Aerodrome v2 Router
        t[4] = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F; // Aerodrome Slipstream (Gauges V3)
    }

    function _initialIndex() private pure returns (address[] memory stocks, uint16[] memory weights) {
        stocks = new address[](4);
        weights = new uint16[](4);

        stocks[0] = 0xb20000000000000000000078ee7ce2fE4908108C; // NVDAc
        stocks[1] = 0xb200000000000000000000C2e324d24d7eEcd1fb; // AAPLc
        stocks[2] = 0xb2000000000000000000002D0BA3164cc74f58B7; // GOOGLc
        stocks[3] = 0xb2000000000000000000008bC8786B856E61707C; // METAc

        // Four equal weights divide exactly into 10,000 bps.
        for (uint256 i; i < 4; ++i) {
            weights[i] = 2_500;
        }
    }
}
