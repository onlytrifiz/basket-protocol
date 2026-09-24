// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {MockERC20} from "./Indices.t.sol";
import {IndexFactory} from "../src/indices/IndexFactory.sol";
import {IndexTreasury} from "../src/indices/IndexTreasury.sol";

interface ILockerV2 {
    function transferFeeOwner(address token, address to) external;
    function setQuoteOnly(address token, bool on) external;
    function feeOwnerOf(address token) external view returns (address);
    function pendingCoin(address token) external view returns (uint256);
}

interface ICLPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 limit, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
}

interface IERC20Like {
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/**
 * A V2 index whose QUOTE is a B20 — Coinbase's tokenized equities on Base.
 *
 * NEEDS `base-forge`, and self-skips under plain Foundry rather than failing there:
 *
 *     base-forge test --match-path test/IndicesB20Quote.fork.t.sol
 *
 * A B20's on-chain code is the single byte 0xef and the node answers `balanceOf` natively; standard
 * Foundry fetches that byte and tries to EXECUTE it, so the first `decimals()` dies with
 * `OpcodeNotFound`. Nothing is wrong with the contracts under test — the EVM the test runs in simply
 * does not host the precompile. base-anvil's build does.
 *
 * Why this deserves its own file: `quote` is the asset the treasury measures its whole watermark
 * against, so every balance read in `harvest` goes through the precompile. The V2 launcher accepts
 * any whitelisted quote and coins are already launching against NVDAc, so this is a live shape, not
 * a hypothetical one. `deal()` cannot fabricate a B20 balance — those are not in any storage slot —
 * so the test earns its quote the only way anyone can: by trading for it.
 */
contract IndicesB20QuoteForkTest is Test {
    uint256 constant FORK_BLOCK = 51_706_541;

    address constant V2_LOCKER = 0x43555104f569D17026037E5637691b95c79fD03A;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    /// NVDAc — a B20, 8 decimals.
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    /// A live V2 launch quoted against it, tick spacing 80. The COIN is token0 in this pool.
    address constant COIN = 0x36416175bC7E4eEa1c7c02018a77472D8aA02022;
    address constant POOL = 0x7c271FBF4aC7561Ba33A0c8093bE230a758f98FF;

    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IndexFactory factory;
    IndexTreasury impl;
    MockERC20 stock;

    function setUp() public {
        vm.createSelectFork("base", FORK_BLOCK);

        // Asked rather than assumed: this is exactly the call that dies under standard Foundry.
        (bool hosted,) = NVDAC.staticcall(abi.encodeWithSignature("decimals()"));
        if (!hosted) {
            emit log("B20 precompiles are not hosted by this EVM - run with base-forge");
            vm.skip(true);
            return;
        }

        stock = new MockERC20("RBLX");
        impl = new IndexTreasury();
        factory = new IndexFactory(address(impl), WETH);
        factory.setKeeper(address(this), true);
        factory.setLaunchpad(1, V2_LOCKER, 1, true);
    }

    function test_bindsAndHarvestsAgainstAB20Quote() public {
        address[] memory b = new address[](1);
        b[0] = address(stock);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        IndexFactory.IndexConfig memory cfg = IndexFactory.IndexConfig({
            owner: address(this),
            creator: address(0),
            quote: NVDAC, // the equity itself is what this basket measures and spends
            basket: b,
            weights: w,
            mode: 0,
            interval: 900,
            creatorShareBps: 0,
            coin: address(0)
        });
        address predicted = factory.predictAddress(address(this), bytes32(uint256(1)));
        IndexTreasury t = IndexTreasury(payable(factory.createIndex(cfg, bytes32(uint256(1)), predicted)));

        address owner = ILockerV2(V2_LOCKER).feeOwnerOf(COIN);
        vm.startPrank(owner);
        ILockerV2(V2_LOCKER).setQuoteOnly(COIN, true);
        ILockerV2(V2_LOCKER).transferFeeOwner(COIN, predicted);
        vm.stopPrank();

        // The bind predicate reads the paired asset off the position record — and here that asset is
        // the precompile, so this is already more than a plain-ERC20 path.
        t.bind(COIN);
        assertEq(t.coin(), COIN, "the B20-quoted coin did not bind");
        assertEq(t.launchpad(), 1, "settled by the wrong launchpad");
        assertTrue(t.bindIsPermanent());

        _earnFeesInBothLegs();

        uint256 received = t.harvest();

        emit log_named_decimal_uint("harvest (NVDAc)", received, IERC20Like(NVDAC).decimals());
        assertGt(received, 0, "the quote leg never reached the treasury");
        assertGt(IERC20Like(NVDAC).balanceOf(address(t)), 0, "no B20 balance landed");
        // Native is not involved: a B20-quoted basket holds and pays the equity itself.
        assertEq(address(t).balance, 0, "a B20-quoted basket must not hold ether");

        // quoteOnly held the coin leg at the locker, so there was nothing here to burn.
        assertEq(IERC20Like(COIN).balanceOf(address(t)), 0, "a coin leg should never have arrived");
        assertGt(ILockerV2(V2_LOCKER).pendingCoin(COIN), 0, "the coin leg was not held for conversion");
    }

    /**
     * Sell the coin for the equity, then buy the coin back.
     *
     * The order matters and is not a stylistic choice: a pool charges its fee on the token going IN,
     * so only the second leg earns a fee denominated in the B20 — which is the leg this treasury
     * measures. The first leg exists to obtain the equity at all, since `deal()` cannot mint one.
     */
    function _earnFeesInBothLegs() internal {
        uint256 amount = 2_000_000e18; // the coin is an ordinary ERC20: deal works on it
        deal(COIN, address(this), amount);

        // coin is token0 here, so selling it is zeroForOne.
        (, int256 quoteDelta) = ICLPool(POOL).swap(address(this), true, int256(amount), MIN_SQRT_RATIO + 1, "");
        uint256 quoteOut = uint256(-quoteDelta);
        assertGt(quoteOut, 0, "the pool returned no equity to trade back");
        emit log_named_decimal_uint("bought (NVDAc)", quoteOut, IERC20Like(NVDAC).decimals());

        ICLPool(POOL).swap(address(this), false, int256(quoteOut), MAX_SQRT_RATIO - 1, "");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == POOL, "unexpected pool");
        if (amount0Delta > 0) IERC20Like(COIN).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20Like(NVDAC).transfer(msg.sender, uint256(amount1Delta));
    }
}
