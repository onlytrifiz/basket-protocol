// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StockifyRouter} from "../src/StockifyRouter.sol";

/**
 * Deploy the public buy/sell router for the ETH/STFY pool.
 *
 *   forge script script/DeployRouter.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify
 *
 * Env: TOKEN (STFY), HOOK. FEE and TICK_SPACING match `LaunchPool.s.sol` and are not guesses — a
 * router built against a different pool key simply addresses a pool that does not exist, and every
 * call reverts with no clue as to why.
 */
contract DeployRouter is Script {
    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    uint24 internal constant FEE = 10_000; // 1% to LPs, alongside the hook's 3% in ETH
    int24 internal constant TICK_SPACING = 200;

    function run() external {
        address token = vm.envAddress("TOKEN");
        address hook = vm.envAddress("HOOK");

        vm.startBroadcast();
        StockifyRouter router = new StockifyRouter(IPoolManager(POOL_MANAGER), token, FEE, TICK_SPACING, hook);
        vm.stopBroadcast();

        console2.log("StockifyRouter:", address(router));
        console2.log("  token:       ", token);
        console2.log("  hook:        ", hook);
        console2.log("Set NEXT_PUBLIC_STOCKIFY_ROUTER_ADDRESS to the address above.");
    }
}
