// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title Rebuild an existing position so the whole supply sits one-sided
/// @notice Burns the current position, then mints a new one holding EVERY token the deployer has.
///
/// @dev Why not just add to the existing position: its range still reaches above the current tick,
/// so topping it up would demand ETH alongside the token. A one-sided deposit needs the whole range
/// at or below the current tick, which means a new range — hence burn and re-mint rather than
/// increase. The pool itself is untouched, so the pool id already submitted for review still holds.
///
/// @dev The opening tick is NOT the original one. Trading moved the price, and a one-sided position
/// cannot be placed above the market: `tickUpper` is the live tick aligned down. Re-opening higher
/// would mean quoting a price the pool does not have.
contract ReworkPosition is Script {
    address internal constant POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint24 internal constant FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address tokenAddress = vm.envAddress("TOKEN");
        address hook = vm.envAddress("HOOK");
        uint256 tokenId = vm.envUint("TOKEN_ID");
        int24 tickUpper = int24(vm.envInt("OPEN_TICK"));
        require(tickUpper % TICK_SPACING == 0, "OPEN_TICK must align to 200");
        int24 tickLower = tickUpper - int24(int256(vm.envOr("BAND_TICKS", uint256(46_000))));

        IERC20 token = IERC20(tokenAddress);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });

        vm.startBroadcast(pk);

        // 1. Burn: returns both legs of the old position to the deployer.
        bytes memory burnActions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
        bytes[] memory burnParams = new bytes[](2);
        burnParams[0] = abi.encode(tokenId, uint128(0), uint128(0), bytes(""));
        burnParams[1] = abi.encode(key.currency0, key.currency1, deployer);
        IPositionManager(POSITION_MANAGER).modifyLiquidities(
            abi.encode(burnActions, burnParams), block.timestamp + 600
        );

        // 2. Mint: everything the deployer now holds, one-sided.
        uint256 deposit = token.balanceOf(deployer);
        require(deposit > 0, "nothing to deposit");
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity =
            LiquidityAmounts.getLiquidityForAmount1(TickMath.getSqrtPriceAtTick(tickLower), sqrtUpper, deposit);

        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(tokenAddress, POSITION_MANAGER, type(uint160).max, type(uint48).max);

        bytes memory mintActions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory mintParams = new bytes[](2);
        mintParams[0] =
            abi.encode(key, tickLower, tickUpper, liquidity, uint128(0), uint128(deposit), deployer, bytes(""));
        mintParams[1] = abi.encode(key.currency0, key.currency1);
        IPositionManager(POSITION_MANAGER).modifyLiquidities(
            abi.encode(mintActions, mintParams), block.timestamp + 600
        );

        vm.stopBroadcast();

        console2.log("burned tokenId :", tokenId);
        console2.log("tickLower      :", tickLower);
        console2.log("tickUpper      :", tickUpper);
        console2.log("deposited      :", deposit);
        console2.log("kept back      :", token.balanceOf(deployer));
        console2.log("liquidity      :", liquidity);
    }
}
