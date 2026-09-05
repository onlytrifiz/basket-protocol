// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {DividendVault} from "../src/DividendVault.sol";

/**
 * Rotate the live vault's buy index.
 *
 *   VAULT=0x… STOCKS=0x…,0x… WEIGHTS=2000,2000,… base-forge script script/SetIndex.s.sol --rpc-url base
 *
 * `base-forge`, NOT `forge`, and the difference is not cosmetic. Admitting a name new to the
 * distribution set makes `_setIndex` staticcall its `totalSupply()`, and B20 assets are Rust
 * precompiles whose on-chain code is the single byte `0xef`. Standard Foundry fetches that byte and
 * tries to execute it, so the read dies with `OpcodeNotFound`, `_isErc20` reads false, and the
 * script reports `InvalidIndex()` — a simulation artifact that looks exactly like a rejected asset.
 * base-anvil's build hosts the precompiles in-process and simulates what the chain will actually do.
 *
 * It runs as a DRY RUN by default and prints the calldata. Add `--broadcast` to send it, or hand
 * the printed calldata to whoever holds the owner key. `setIndex` is owner-only, so a broadcast
 * from any other account reverts before it costs anything beyond gas estimation.
 *
 * TWO REFUSALS ARE THE VAULT'S, NOT THIS SCRIPT'S, and both are worth knowing before you queue it:
 * `setIndex` reverts with `ConfigDuringCycle` while a snapshot is pending or a cycle is active, and
 * with `InvalidIndex` unless the weights total exactly 10,000 bps. The pre-flight below reads both
 * so the failure arrives here rather than out of a broadcast.
 *
 * WHAT IT CANNOT STRAND. Assets dropped from the index stay in `_distributionStocks` forever, so
 * balances already bought keep being handed out. Rotation only changes what the NEXT `buyStocks`
 * acquires.
 *
 * THE ROUTE IS THE REAL PRECONDITION. The keeper skips the whole purchase when any active asset has
 * no complete route, so admitting a name with no Slipstream USDC pool stalls every buy rather than
 * just its own leg. Check the leg simulates before rotating, not after.
 *
 * Env is read explicitly and never defaulted: a repo `.env` is auto-loaded by Foundry, and an index
 * silently taken from a stale variable is exactly the mistake this script exists to avoid.
 */
contract SetIndex is Script {
    function run() external {
        address vault = vm.envAddress("VAULT");
        require(vault.code.length > 0, "SetIndex: VAULT holds no code");

        address[] memory stocks = vm.envAddress("STOCKS", ",");
        uint256[] memory rawWeights = vm.envUint("WEIGHTS", ",");
        require(stocks.length == rawWeights.length, "SetIndex: STOCKS and WEIGHTS differ in length");
        require(stocks.length != 0, "SetIndex: STOCKS is empty");

        uint16[] memory weights = new uint16[](rawWeights.length);
        uint256 total;
        for (uint256 i; i < rawWeights.length; ++i) {
            require(rawWeights[i] != 0 && rawWeights[i] <= type(uint16).max, "SetIndex: weight out of range");
            weights[i] = uint16(rawWeights[i]);
            total += rawWeights[i];
        }
        require(total == 10_000, "SetIndex: weights must total 10000 bps");

        DividendVault dividendVault = DividendVault(payable(vault));
        require(!dividendVault.cycleActive(), "SetIndex: a distribution cycle is active");
        require(!dividendVault.snapshotPending(), "SetIndex: a snapshot is pending");

        _printCurrent(dividendVault);
        _printProposed(dividendVault, stocks, weights);

        bytes memory calldata_ = abi.encodeCall(DividendVault.setIndex, (stocks, weights));
        console2.log("");
        console2.log("owner    :", dividendVault.owner());
        console2.log("calldata :");
        console2.logBytes(calldata_);

        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) {
            console2.log("");
            console2.log("No DEPLOYER_PRIVATE_KEY: dry run only. Send the calldata above from the owner.");
            return;
        }

        vm.startBroadcast(pk);
        dividendVault.setIndex(stocks, weights);
        vm.stopBroadcast();

        console2.log("");
        console2.log("Index replaced. Confirm with:");
        console2.log("  cast call <VAULT> 'stocksLength()(uint256)' --rpc-url base");
    }

    function _printCurrent(DividendVault vault) private view {
        uint256 n = vault.stocksLength();
        console2.log("current index (%s assets):", n);
        for (uint256 i; i < n; ++i) {
            (address token, uint16 weightBps) = vault.stockAt(i);
            console2.log("  %s  %s bps", token, weightBps);
        }
    }

    /// @dev Names that are NEW to the distribution set are flagged, because that set never shrinks:
    /// admitting an asset is the one part of a rotation that cannot be undone later.
    function _printProposed(DividendVault vault, address[] memory stocks, uint16[] memory weights) private view {
        console2.log("");
        console2.log("proposed index (%s assets):", stocks.length);
        for (uint256 i; i < stocks.length; ++i) {
            console2.log(
                "  %s  %s bps%s",
                stocks[i],
                weights[i],
                vault.isDistributionStock(stocks[i]) ? "" : "   [NEW to the distribution set]"
            );
        }
    }
}
