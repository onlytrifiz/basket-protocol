// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {BasketToken} from "../src/BasketToken.sol";
import {BasketFeeHook} from "../src/BasketFeeHook.sol";
import {DividendVault} from "../src/DividendVault.sol";

/// @title Deploy Basket on Base Mainnet
/// @notice Deploys the 1B BASKET token, its configurable B20 stock dividend vault, and the 3%
/// ETH hook. It intentionally DOES NOT initialize or seed a v4 pool.
/// @dev Every initial address below was supplied from the Base B20 catalogue; public pools and the
/// BASKET initial price will be decided independently before a later pool-initialization transaction.
contract Deploy is Script {
    // Official Uniswap v4 Base deployments: https://developers.uniswap.org/docs/protocols/v4/deployments#base-8453
    address internal constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant BASE_UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address protocolOwner = vm.envOr("PROTOCOL_OWNER", deployer);
        address platformRecipient = vm.envOr("PLATFORM_RECIPIENT", deployer);
        address poolManager = vm.envOr("POOL_MANAGER", BASE_POOL_MANAGER);
        address universalRouter = vm.envOr("UNIVERSAL_ROUTER", BASE_UNIVERSAL_ROUTER);
        (address[] memory stocks, uint16[] memory weights) = _initialBasket();

        vm.startBroadcast(privateKey);

        // Deploy under the broadcaster long enough to complete the one-time cross-contract
        // configuration, then hand both contracts to the protocol multisig.
        BasketToken token = new BasketToken(deployer, deployer);
        DividendVault vault = new DividendVault(
            address(token), universalRouter, deployer, platformRecipient, poolManager, stocks, weights
        );

        // Keep infrastructure balances out of the token's on-chain reward registry. The token's
        // owner-controlled exclusion setting intentionally follows the reference Index model.
        token.setRewardsExcluded(poolManager, true);
        token.setRewardsExcluded(address(vault), true);
        token.setRewardsExcluded(0x000000000000000000000000000000000000dEaD, true);

        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        bytes memory constructorArgs = abi.encode(IPoolManager(poolManager), address(vault));
        (address expectedHook, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(BasketFeeHook).creationCode, constructorArgs);
        BasketFeeHook hook = new BasketFeeHook{salt: salt}(IPoolManager(poolManager), address(vault));
        require(address(hook) == expectedHook, "hook address mismatch");

        // The configured keeper is the only account that can submit Trading API routes and
        // advance on-chain snapshots/payout batches. A capped default limits hot-key exposure.
        vault.setKeeper(deployer, true);
        vault.setMaxGrossSpendPerCycle(vm.envOr("MAX_GROSS_SPEND_PER_CYCLE", uint256(0.25 ether)));

        if (protocolOwner != deployer) {
            token.transferOwnership(protocolOwner);
            vault.transferOwnership(protocolOwner);
        }

        vm.stopBroadcast();

        console2.log("BasketToken:     ", address(token));
        console2.log("DividendVault:   ", address(vault));
        console2.log("BasketFeeHook:   ", address(hook));
        console2.log("PoolManager:     ", poolManager);
        console2.log("UniversalRouter: ", universalRouter);
        console2.log("Pool deliberately uninitialized. Next: decide price/LP, then initialize and seed ETH/BASKET.");
    }

    function _initialBasket() private pure returns (address[] memory stocks, uint16[] memory weights) {
        stocks = new address[](13);
        weights = new uint16[](13);

        stocks[0] = 0xb20000000000000000000078ee7ce2fE4908108C; // NVDAc
        stocks[1] = 0xb200000000000000000000C2e324d24d7eEcd1fb; // AAPLc
        stocks[2] = 0xb2000000000000000000002D0BA3164cc74f58B7; // GOOGLc
        stocks[3] = 0xb2000000000000000000008bC8786B856E61707C; // METAc
        stocks[4] = 0xb200000000000000000000d9192b6B456483C2E8; // AMZNc
        stocks[5] = 0xb200000000000000000000c85a31389D71F3ecfb; // COINc
        stocks[6] = 0xB20000000000000000000019f6E7C675b73C2e4D; // CRCLc
        stocks[7] = 0xB2000000000000000000004AFF16039bA04bdFBc; // INTCc
        stocks[8] = 0xB200000000000000000000Ab99cFa739E253872B; // MSFTc
        stocks[9] = 0xb2000000000000000000004884b426556b92883d; // MSTRc
        stocks[10] = 0xb200000000000000000000397293Cb8cda9a10c5; // SNDKc
        stocks[11] = 0xb2000000000000000000007b9fcbd005511aCBd5; // SPCXc
        stocks[12] = 0xb2000000000000000000001e800a7f5189430cD0; // TSLAc

        // 13 equal-weight names cannot divide exactly into 10,000 bps. The final name receives the
        // two-basis-point remainder; the difference is economically immaterial and deterministic.
        for (uint256 i; i < 12; ++i) {
            weights[i] = 769;
        }
        weights[12] = 772;
    }
}
