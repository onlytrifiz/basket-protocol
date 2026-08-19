// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";

import {TestToken} from "../src/test-launch/TestToken.sol";

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title Open a one-sided ETH/<token> Uniswap v4 pool behind the Stockify hook
/// @notice Deploys a throwaway TEST token when TOKEN is unset, or opens the pool for an existing
/// token when it is — the path the real launch takes. Mints the position through the v4
/// PositionManager as a real NFT.
///
/// @dev ONE-SIDED, ON PURPOSE. currency0 is native ETH and currency1 is the token, so a position
/// whose whole range sits at or below the opening tick holds nothing but the token — no ETH is
/// risked to open the market. Buying ETH->token walks the tick DOWN into the range, so the position
/// sells and accumulates ETH exactly like a launch curve.
///
/// @dev AND IT DEPOSITS EVERYTHING. With a one-sided position the deposit IS the float: whatever is
/// held back is not liquidity, not backing and not buyable — just a bag sitting outside the market
/// it is supposed to price. The default is therefore the deployer's entire balance, and DEPOSIT
/// exists to override it deliberately, not by forgetting. The opening tick prices the FULL supply at
/// the target market cap, so holding some back would also make that number a fiction.
///
/// @dev The fee tier is a plain 1% (10000). It must NEVER be LPFeeLibrary.DYNAMIC_FEE_FLAG: the hook
/// returns 0 as its override, which has no OVERRIDE_FEE_FLAG set, so a dynamic-fee pool would store
/// a 0% LP fee permanently and the hook has no path to update it.
contract LaunchPool is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint24 internal constant FEE = 10_000; // 1% to LPs, alongside the hook's 3% in ETH
    int24 internal constant TICK_SPACING = 200;

    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk == 0) pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address hook = vm.envAddress("HOOK");

        // Opening tick for the target market cap, aligned DOWN to the spacing. Passed in rather
        // than computed on-chain: it depends on the ETH price, which this script must not oracle.
        int24 tickUpper = int24(vm.envInt("OPEN_TICK"));
        require(tickUpper % TICK_SPACING == 0, "OPEN_TICK must align to 200");
        // How far the position stays quoted below the open. 46,000 ticks is about a 100x rise.
        int24 tickLower = tickUpper - int24(int256(vm.envOr("BAND_TICKS", uint256(46_000))));
        require(tickLower % TICK_SPACING == 0, "BAND must align to 200");


        vm.startBroadcast(pk);

        // An existing token for the real launch; a throwaway one when probing the hook.
        address tokenAddress = vm.envOr("TOKEN", address(0));
        if (tokenAddress == address(0)) tokenAddress = address(new TestToken(deployer));
        IERC20 token = IERC20(tokenAddress);

        // Everything, unless deliberately overridden.
        uint256 deposit = vm.envOr("DEPOSIT", token.balanceOf(deployer));
        require(deposit > 0, "nothing to deposit");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });

        // Open exactly at the top of the range so the position is pure TEST.
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tickUpper);
        IPoolManager(POOL_MANAGER).initialize(key, sqrtPriceX96);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(
            TickMath.getSqrtPriceAtTick(tickLower), sqrtPriceX96, deposit
        );

        token.approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(tokenAddress, POSITION_MANAGER, type(uint160).max, type(uint48).max);

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        // amount0Max is 0: a correctly placed one-sided range must never ask for ETH.
        params[0] = abi.encode(key, tickLower, tickUpper, liquidity, uint128(0), uint128(deposit), deployer, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        IPositionManager(POSITION_MANAGER).modifyLiquidities(abi.encode(actions, params), block.timestamp + 600);

        vm.stopBroadcast();

        console2.log("Token:      ", tokenAddress);
        console2.log("Hook:       ", hook);
        console2.log("tickLower:  ", tickLower);
        console2.log("tickUpper:  ", tickUpper);
        console2.log("liquidity:  ", liquidity);
        console2.log("posted:     ", deposit);
        console2.log("kept back:  ", token.balanceOf(deployer));
        console2.log("PoolId:");
        console2.logBytes32(PoolId.unwrap(key.toId()));
    }
}
