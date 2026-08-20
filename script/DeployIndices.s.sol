// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IndexFactory} from "../src/indices/IndexFactory.sol";
import {IndexTreasury} from "../src/indices/IndexTreasury.sol";

/**
 * Deploys Indices: one treasury implementation, one factory, and the configuration without which an
 * index collects fees and never pays anybody.
 *
 * The service is Stockify's; the launchpad it collects from is not. A coin launched on Stonks
 * Exchange points its creator fees at a treasury deployed here, which buys tokenized equity and
 * pushes it to that coin's holders. The launchpad is a registry entry, not a hard-coded dependency —
 * a second one costs a `setLaunchpad` call rather than a new implementation.
 *
 *   PRIVATE_KEY=0x… KEEPER=0x… FEE_RECIPIENT=0x… \
 *     forge script script/DeployIndices.s.sol:DeployIndices --rpc-url base --broadcast --slow --verify
 */
contract DeployIndices is Script {
    // ------------------------------------------------------------------ Base mainnet

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;

    /// StonkFeeLocker2 — the launch registry and paymaster these treasuries collect from.
    address internal constant STONK_FEE_LOCKER = 0x71D1D363176723f85d98B8B430DF33cde89f0A7f;

    /// Launchpad id 0 = Stonks Exchange. Ids are ours to assign; the shape is the contract's.
    uint8 internal constant LAUNCHPAD_STONKS = 0;
    uint8 internal constant KIND_CREATOR_LOCKER = 0;

    uint16 internal constant PLATFORM_FEE_BPS = 1_000; // 10%, hard cap on the factory is 20%

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address keeper = vm.envAddress("KEEPER");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        vm.startBroadcast(pk);

        IndexTreasury implementation = new IndexTreasury();
        IndexFactory factory = new IndexFactory(address(implementation), WETH);

        /**
         * Without this the treasuries harvest and never pay: `swap()` and `distribute*()` are
         * keeper-only, and an unset keeper mapping is a service that collects fees into contracts
         * nobody can crank.
         */
        factory.setKeeper(keeper, true);
        factory.setPlatformFee(PLATFORM_FEE_BPS, feeRecipient);
        factory.setLaunchpad(LAUNCHPAD_STONKS, STONK_FEE_LOCKER, KIND_CREATOR_LOCKER, true);

        /**
         * The venues a keeper may route a buy through. Velora leads because it is what the sibling
         * keeper already routes live buys through and it needs no API key; the Slipstream router that
         * reaches the newer CLFactory is next, because that is where the live equity/USDC depth sits.
         *
         * Listing grants no approval and no custody — only the right to receive one trade's input,
         * still gated by that trade's own measured fill. Revoking one takes it away from every
         * treasury at once, in a single write.
         */
        factory.setVenue(0x6A000F20005980200259B80c5102003040001068, true); // Velora Augustus v6.2
        factory.setVenue(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F, true); // Slipstream (Gauges V3)
        factory.setVenue(0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5, true); // Slipstream (original)
        factory.setVenue(SWAP_ROUTER_02, true); // Uniswap V3, allowance-based
        factory.setVenue(0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43, true); // Aerodrome v2 Router
        factory.setVenue(0x0000000000001fF3684f28c67538d4D072C22734, true); // 0x AllowanceHolder

        vm.stopBroadcast();

        console.log("IndexTreasury (implementation)", address(implementation));
        console.log("IndexFactory                  ", address(factory));
        console.log("version                       ", factory.VERSION());
        console.log("owner                         ", factory.owner());
        console.log("keeper                        ", keeper);
        console.log("platform fee recipient        ", feeRecipient);
    }
}
