// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {StockifyToken} from "../src/StockifyToken.sol";
import {DividendVault} from "../src/DividendVault.sol";
import {MockStock} from "./mocks/MockStock.sol";

/// Plain fixed-supply ERC-20 with no holder registry, used as the gas baseline.
contract PlainToken is ERC20 {
    constructor() ERC20("Plain", "PLAIN") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice Measures what the on-chain enumerable holder registry actually costs:
/// (a) marginal gas added to a STFY transfer, (b) snapshot gas per holder,
/// (c) payout gas per holder for a 1-asset and a 13-asset index.
contract GasBenchTest is Test {
    uint256 internal constant HOLDERS = 1_000;
    uint256 internal constant STAKE = 100_000e18; // exactly the eligibility threshold

    StockifyToken internal stfy;
    PlainToken internal plain;
    DividendVault internal vault;
    MockStock[] internal stocks;

    function setUp() public {
        stfy = new StockifyToken(address(this), address(this));
        plain = new PlainToken();
    }

    // --------------------------------------------------------------------
    // (a) transfer overhead
    // --------------------------------------------------------------------

    function test_GasTransferOverhead() public {
        address cold = address(0xC01D);
        address warm = address(0xBEEF);

        // Baseline: plain ERC-20, fresh recipient.
        uint256 g = gasleft();
        plain.transfer(cold, STAKE);
        uint256 plainCold = g - gasleft();

        // STFY, fresh recipient that crosses the threshold => registry insert.
        g = gasleft();
        stfy.transfer(cold, STAKE);
        uint256 stfyInsert = g - gasleft();

        // Baseline: plain ERC-20, recipient that already holds.
        plain.transfer(warm, STAKE);
        g = gasleft();
        plain.transfer(warm, STAKE);
        uint256 plainWarm = g - gasleft();

        // STFY, both sides already registered => registry no-op (the steady state).
        stfy.transfer(warm, STAKE * 2);
        g = gasleft();
        stfy.transfer(warm, STAKE);
        uint256 stfyNoop = g - gasleft();

        // STFY, sender falls below the threshold => swap-and-pop removal.
        vm.prank(cold);
        g = gasleft();
        stfy.transfer(warm, STAKE);
        uint256 stfyRemove = g - gasleft();

        console2.log("plain transfer   (cold recipient) ", plainCold);
        console2.log("STFY transfer  (registry insert)", stfyInsert);
        console2.log("  -> insert overhead              ", stfyInsert - plainCold);
        console2.log("plain transfer   (warm recipient) ", plainWarm);
        console2.log("STFY transfer  (registry no-op) ", stfyNoop);
        console2.log("  -> steady-state overhead        ", stfyNoop - plainWarm);
        console2.log("STFY transfer  (registry remove)", stfyRemove);
    }

    // --------------------------------------------------------------------
    // (b) + (c) snapshot and payout, 1 asset vs 13 assets
    // --------------------------------------------------------------------

    function test_GasCycleOneStock() public {
        _run(1, HOLDERS, STAKE);
    }

    function test_GasCycleThirteenStocks() public {
        _run(13, HOLDERS, STAKE);
    }

    /// @notice The Index on Robinhood Chain: ~13,000 holders, ~17 stocks, hourly.
    /// @dev 13,000 x 100,000 STFY exceeds the 1B supply, so this runs at the 10,000 STFY
    /// floor — which is also the threshold the reference token actually uses.
    function test_GasCycleIndexScale() public {
        stfy.setMinShareBalance(10_000e18);
        _run(17, 13_000, 10_000e18);
    }

    function _run(uint256 stockCount, uint256 holderCount, uint256 stake) internal {
        _deployVault(stockCount);
        _seedHolders(holderCount, stake);
        for (uint256 i; i < stockCount; ++i) {
            stocks[i].mint(address(vault), 1_000e18);
        }

        uint256 g = gasleft();
        vault.snapshotHolders(holderCount);
        uint256 snapshotGas = g - gasleft();

        g = gasleft();
        vault.startCycle();
        uint256 startGas = g - gasleft();

        // Pay in pages of 100 and take the second page: the first one warms shared state.
        vault.distributeBatch(100);
        g = gasleft();
        vault.distributeBatch(100);
        uint256 pageGas = g - gasleft();

        console2.log("=== stocks in index            ", stockCount);
        console2.log("=== registered holders          ", holderCount);
        console2.log("--- cycle 1 (cold storage) ---");
        console2.log("snapshotHolders(1000)           ", snapshotGas);
        console2.log("  -> per holder                 ", snapshotGas / holderCount);
        console2.log("startCycle()                    ", startGas);
        console2.log("distributeBatch(100)            ", pageGas);
        console2.log("  -> per holder                 ", pageGas / 100);
        console2.log("full cycle, all holders         ", snapshotGas + startGas + (pageGas * holderCount) / 100);

        // Finish cycle 1, then measure the steady state: cycle 2 must `delete _snapshot`
        // (1000 non-zero slots) before re-pushing it, and re-pay every B20 recipient.
        while (vault.distributionRemaining() != 0) {
            vault.distributeBatch(200);
        }
        vm.warp(block.timestamp + 1 hours + 1);
        for (uint256 i; i < stockCount; ++i) {
            stocks[i].mint(address(vault), 1_000e18);
        }

        g = gasleft();
        vault.snapshotHolders(holderCount);
        uint256 snapshot2 = g - gasleft();

        g = gasleft();
        vault.startCycle();
        uint256 start2 = g - gasleft();

        vault.distributeBatch(100);
        g = gasleft();
        vault.distributeBatch(100);
        uint256 page2 = g - gasleft();

        console2.log("--- cycle 2 (steady state) ---");
        console2.log("snapshotHolders(1000)           ", snapshot2);
        console2.log("  -> per holder                 ", snapshot2 / holderCount);
        console2.log("startCycle()                    ", start2);
        console2.log("distributeBatch(100)            ", page2);
        console2.log("  -> per holder                 ", page2 / 100);
        console2.log("full cycle, all holders         ", snapshot2 + start2 + (page2 * holderCount) / 100);
    }

    function _deployVault(uint256 stockCount) internal {
        address[] memory tokens = new address[](stockCount);
        uint16[] memory weights = new uint16[](stockCount);
        uint16 each = uint16(10_000 / stockCount);
        for (uint256 i; i < stockCount; ++i) {
            stocks.push(new MockStock("Stock", "STKc"));
            tokens[i] = address(stocks[i]);
            weights[i] = each;
        }
        weights[stockCount - 1] = uint16(10_000 - each * (stockCount - 1));

        vault = new DividendVault(
            address(stfy), address(this), address(this), address(this), address(this), tokens, weights
        );
        vault.setKeeper(address(this), true);
    }

    function _seedHolders(uint256 count, uint256 stake) internal {
        for (uint256 i; i < count; ++i) {
            stfy.transfer(address(uint160(0x10000 + i)), stake);
        }
        // The deployer keeps the rest of the supply; exclude it so the pots go to the 1000 holders.
        stfy.setRewardsExcluded(address(this), true);
    }
}
