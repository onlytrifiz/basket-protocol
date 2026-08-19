// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

interface IPosm {
    function initializePool(PoolKey calldata key, uint160 sqrtPriceX96) external payable returns (int24);
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
}

/// @title Emit the one transaction that opens the market
/// @notice Prints the calldata for a single PositionManager.multicall that initializes the pool AND
/// mints the one-sided position, to be placed at the head of a private bundle.
///
/// @dev ATOMIC ON PURPOSE. A PoolKey is deterministic and public the moment the token exists, so
/// anyone can call initializePool first and fix an opening price of their choosing — at a tick below
/// ours the position would straddle the price, demand ETH we do not send, and revert. Bundling both
/// calls means either we open the market or nothing happens; there is no window to step into.
///
/// @dev Permit2 approvals are NOT part of this. They touch the token and Permit2, not the
/// PositionManager, so they cannot join this multicall and must be sent in advance.
contract LaunchCalldata is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 internal constant FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;

    function run() external {
        address token = vm.envAddress("TOKEN");
        address hook = vm.envAddress("HOOK");
        address owner = vm.envAddress("OWNER");
        int24 tickUpper = int24(vm.envInt("OPEN_TICK"));
        require(tickUpper % TICK_SPACING == 0, "OPEN_TICK must align to 200");
        int24 tickLower = tickUpper - int24(int256(vm.envOr("BAND_TICKS", uint256(46_000))));
        uint256 deposit = vm.envOr("DEPOSIT", IERC20(token).balanceOf(owner));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });

        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(tickLower), sqrtPriceX96, deposit
        );

        bytes memory mintActions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] =
            abi.encode(key, tickLower, tickUpper, liquidity, uint128(0), uint128(deposit), owner, bytes(""));
        mintParams[1] = abi.encode(key.currency0, key.currency1);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(IPosm.initializePool, (key, sqrtPriceX96));
        calls[1] = abi.encodeCall(
            IPosm.modifyLiquidities, (abi.encode(mintActions, mintParams), vm.envOr("DEADLINE", block.timestamp + 3600))
        );

        console2.log("to        :", POSITION_MANAGER);
        console2.log("value     : 0");
        console2.log("tickLower :", tickLower);
        console2.log("tickUpper :", tickUpper);
        console2.log("deposit   :", deposit);
        console2.log("liquidity :", liquidity);
        console2.log("poolId    :");
        console2.logBytes32(PoolId.unwrap(key.toId()));
        console2.log("--- prerequisiti, da inviare PRIMA ---");
        console2.log("1) token.approve(PERMIT2, max) ->", PERMIT2);
        console2.log("2) PERMIT2.approve(token, POSM, type(uint160).max, type(uint48).max)");
        console2.log("--- calldata multicall ---");
        console2.logBytes(abi.encodeCall(IPosm.multicall, (calls)));

        if (vm.envOr("SIMULATE", false)) {
            vm.startPrank(owner);
            IERC20(token).approve(PERMIT2, type(uint256).max);
            (bool ok,) = PERMIT2.call(
                abi.encodeWithSignature(
                    "approve(address,address,uint160,uint48)", token, POSITION_MANAGER, type(uint160).max, type(uint48).max
                )
            );
            require(ok, "permit2 approve failed");
            IPosm(POSITION_MANAGER).multicall(calls);
            vm.stopPrank();
            console2.log("--- SIMULAZIONE: multicall eseguito, token residui:", IERC20(token).balanceOf(owner));
        }
    }
}
