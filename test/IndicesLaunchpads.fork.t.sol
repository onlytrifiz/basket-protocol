// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {MockERC20} from "./Indices.t.sol";
import {IndexFactory} from "../src/indices/IndexFactory.sol";
import {IndexTreasury} from "../src/indices/IndexTreasury.sol";

interface IStonkFeeLocker2 {
    function setCreatorSplit(address token, address[] calldata recipients, uint256[] calldata bps) external;
    function tokenCreator(address token) external view returns (address);
}

interface IStonksFeeLockerV2Admin {
    function transferFeeOwner(address token, address to) external;
    function setQuoteOnly(address token, bool on) external;
    function feeOwnerOf(address token) external view returns (address);
    function pendingCoin(address token) external view returns (uint256);
}

interface ICLPool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
}

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/**
 * The new implementation against BOTH REAL lockers, on a fork of Base.
 *
 * The unit suite proves the logic against mocks, and a mock is written from the same reading of the
 * contract that the code under test is written from — so it cannot catch a misread. These are the
 * deployed registries, with their real storage, answering the real selectors.
 *
 * What this is really asking: with both launchpads registered, does `bind()` walk them and let the
 * RIGHT one settle each coin — without the V1 shape claiming a V2 coin or the other way round.
 */
contract IndicesLaunchpadsForkTest is Test {
    // Pinned so the fork cache is reusable and the fixtures below stay true.
    uint256 constant FORK_BLOCK = 51_706_541;
    /// The block the V2 launchpad was registered on the live factory in.
    uint256 constant DEPLOYED_AT = 51_707_895;

    address constant WETH = 0x4200000000000000000000000000000000000006;

    address constant V1_LOCKER = 0x71D1D363176723f85d98B8B430DF33cde89f0A7f;
    /// A live V1 launch, paired against WETH, one position.
    address constant V1_COIN = 0x00B364f222c6c4e849b502B8737F62717C8f8CBC;
    /// Its Uniswap V3 pool, derived the way the keeper derives it: the coin, its quote, the 1% tier
    /// StonkLauncher2 fixes. The coin is token0 here — the opposite of the V2 pool, which is why the
    /// helper below reads `token0()` rather than assuming a side.
    address constant V1_POOL = 0xfC3C709b8a366f486B0C35C83B04EbB2d90Cc2b8;

    address constant V2_LOCKER = 0x43555104f569D17026037E5637691b95c79fD03A;
    /// A live V2 launch on Aerodrome Slipstream, paired against WETH, tick spacing 80.
    address constant V2_COIN = 0xa866aE59D4cAf85F483154df329f7A52Cd5D28c5;
    /// Its Slipstream pool, as `launcher.tokenInfo(coin).pool` records it. WETH is token0 here.
    address constant V2_POOL = 0x8929959aB98C79E525de6BB0df5eC5BEAe537900;

    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    uint8 constant LAUNCHPAD_STONKS = 0;
    uint8 constant LAUNCHPAD_STONKS_V2 = 1;
    uint8 constant KIND_CREATOR_LOCKER = 0;
    uint8 constant KIND_FEE_OWNER_LOCKER = 1;

    IndexFactory factory;
    IndexTreasury impl;
    MockERC20 stock;

    function setUp() public {
        vm.createSelectFork("base", FORK_BLOCK);

        stock = new MockERC20("RBLX");
        impl = new IndexTreasury();
        factory = new IndexFactory(address(impl), WETH);
        factory.setKeeper(address(this), true);

        // BOTH, deliberately: a treasury that binds correctly with one registered proves much less.
        factory.setLaunchpad(LAUNCHPAD_STONKS, V1_LOCKER, KIND_CREATOR_LOCKER, true);
        factory.setLaunchpad(LAUNCHPAD_STONKS_V2, V2_LOCKER, KIND_FEE_OWNER_LOCKER, true);
    }

    function _treasury(bytes32 salt) internal returns (IndexTreasury t, address predicted) {
        address[] memory b = new address[](1);
        b[0] = address(stock);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        IndexFactory.IndexConfig memory cfg = IndexFactory.IndexConfig({
            owner: address(this),
            creator: address(0),
            quote: address(0), // native; the lockers pay WETH and harvest unwraps it
            basket: b,
            weights: w,
            mode: 0,
            interval: 900,
            creatorShareBps: 0,
            coin: address(0) // bound below, after the launch is pointed here
        });
        predicted = factory.predictAddress(address(this), salt);
        t = IndexTreasury(payable(factory.createIndex(cfg, salt, predicted)));
    }

    /// The V1 product path, on the deployed StonkFeeLocker2: the creator points the split here.
    function test_bindsARealV1CoinThroughLaunchpadZero() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(1)));

        address[] memory to = new address[](1);
        to[0] = predicted;
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.prank(IStonkFeeLocker2(V1_LOCKER).tokenCreator(V1_COIN));
        IStonkFeeLocker2(V1_LOCKER).setCreatorSplit(V1_COIN, to, bps);

        t.bind(V1_COIN);

        assertEq(t.coin(), V1_COIN, "the V1 coin did not bind");
        assertEq(t.launchpad(), LAUNCHPAD_STONKS, "settled by the wrong launchpad");
        assertFalse(t.bindIsPermanent(), "a split is revocable by its creator");
        (address recipient, bool permanent) = t.feeRecipientNow();
        assertEq(recipient, address(t));
        assertFalse(permanent);
    }

    /// The V2 product path, on the deployed StonksExchangeFeeLockerV2: the fee-owner role moves here,
    /// which is the strong tier — and `quoteOnly` is on, which is how every index launch will run.
    function test_bindsARealV2CoinThroughLaunchpadOne() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(2)));

        address owner = IStonksFeeLockerV2Admin(V2_LOCKER).feeOwnerOf(V2_COIN);
        vm.startPrank(owner);
        IStonksFeeLockerV2Admin(V2_LOCKER).setQuoteOnly(V2_COIN, true);
        IStonksFeeLockerV2Admin(V2_LOCKER).transferFeeOwner(V2_COIN, predicted);
        vm.stopPrank();

        t.bind(V2_COIN);

        assertEq(t.coin(), V2_COIN, "the V2 coin did not bind");
        assertEq(t.launchpad(), LAUNCHPAD_STONKS_V2, "settled by the wrong launchpad");
        assertTrue(t.bindIsPermanent(), "holding the fee-owner role is the strong tier");
        (address recipient, bool permanent) = t.feeRecipientNow();
        assertEq(recipient, address(t));
        assertTrue(permanent);
    }

    /**
     * Neither registry answers for the other's coin.
     *
     * This is the property the whole two-kind design rests on, and the one a mock cannot prove: the
     * V1 locker really does hold no record of a V2 coin and vice versa, so the loop in `bind` falls
     * through to the launchpad that does — rather than being settled by whichever was asked first.
     */
    function test_neitherLockerClaimsTheOthersCoin() public {
        (IndexTreasury a,) = _treasury(bytes32(uint256(3)));
        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        a.bind(V2_COIN); // nobody has pointed it here yet, on either registry

        (IndexTreasury b,) = _treasury(bytes32(uint256(4)));
        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        b.bind(V1_COIN);
    }

    /**
     * THE LIVE FACTORY, after the migration — not a copy of it deployed by this test.
     *
     * Everything above proves the code. This proves the production state: the implementation that
     * `setImplementation` actually installed, cloned through the real factory at 0x78b50d…, binding
     * a real V2 coin. A migration that applied its writes and still could not do the one thing it
     * was for is a class of failure no unit test reaches.
     */
    function test_theLiveFactoryClonesATreasuryThatBindsAV2Coin() public {
        vm.createSelectFork("base", DEPLOYED_AT);

        IndexFactory live = IndexFactory(0x78b50dFFE7250638D6F2A24f56B0849CefA69498);
        assertEq(live.launchpadList().length, 2, "the migration is not on this fork");

        MockERC20 basketToken = new MockERC20("RBLX");
        address[] memory b = new address[](1);
        b[0] = address(basketToken);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        IndexFactory.IndexConfig memory cfg = IndexFactory.IndexConfig({
            owner: address(this),
            creator: address(0),
            quote: address(0),
            basket: b,
            weights: w,
            mode: 0,
            interval: 900,
            creatorShareBps: 0,
            coin: address(0)
        });

        address predicted = live.predictAddress(address(this), bytes32(uint256(42)));
        IndexTreasury t = IndexTreasury(payable(live.createIndex(cfg, bytes32(uint256(42)), predicted)));
        assertEq(t.VERSION(), "stockify-indices-2", "the live factory is still cloning the old code");

        address owner = IStonksFeeLockerV2Admin(V2_LOCKER).feeOwnerOf(V2_COIN);
        vm.startPrank(owner);
        IStonksFeeLockerV2Admin(V2_LOCKER).setQuoteOnly(V2_COIN, true);
        IStonksFeeLockerV2Admin(V2_LOCKER).transferFeeOwner(V2_COIN, predicted);
        vm.stopPrank();

        // The live factory's keeper set is what gates this, so bind as one of them.
        vm.prank(0x2A201Ada10b55F1979C8f5e5C303C8a3cDE44C71);
        t.bind(V2_COIN);

        assertEq(t.coin(), V2_COIN);
        assertEq(t.launchpad(), LAUNCHPAD_STONKS_V2, "settled by the wrong launchpad");
        assertTrue(t.bindIsPermanent());
    }

    /**
     * A shape this implementation does not speak is SKIPPED, not fatal — which is the property that
     * lets launchpad 1 be registered while every treasury already deployed keeps working.
     *
     * Those clones hold the old code and will meet the V2 registry in `launchpadList()` without
     * knowing kind 1. They take the same branch an unknown kind takes here: answer nothing, let the
     * loop go on. So a V1 basket keeps binding and harvesting through launchpad 0, and the worst a
     * V2 coin can do to it is fail to bind.
     */
    function test_anUnknownShapeIsSkippedRatherThanFatal() public {
        factory.setLaunchpad(9, V2_LOCKER, 2, true); // kind 2: no implementation speaks it

        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(9)));
        address[] memory to = new address[](1);
        to[0] = predicted;
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.prank(IStonkFeeLocker2(V1_LOCKER).tokenCreator(V1_COIN));
        IStonkFeeLocker2(V1_LOCKER).setCreatorSplit(V1_COIN, to, bps);

        t.bind(V1_COIN);
        assertEq(t.launchpad(), LAUNCHPAD_STONKS, "an unspoken shape must not swallow the coin");
    }

    /**
     * The collect actually lands on the real locker.
     *
     * `_collect` uses a low-level call and ignores the result, by design — so "harvest did not
     * revert" proves nothing at all about whether the right entrypoint was reached. `expectCall` is
     * what proves it: the exact calldata, against the deployed contract.
     */
    function test_harvestCallsTheRightEntrypointOnEachLocker() public {
        (IndexTreasury v1, address p1) = _treasury(bytes32(uint256(5)));
        address[] memory to = new address[](1);
        to[0] = p1;
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.prank(IStonkFeeLocker2(V1_LOCKER).tokenCreator(V1_COIN));
        IStonkFeeLocker2(V1_LOCKER).setCreatorSplit(V1_COIN, to, bps);
        v1.bind(V1_COIN);

        vm.expectCall(V1_LOCKER, abi.encodeWithSignature("collectAll(address)", V1_COIN));
        v1.harvest();

        (IndexTreasury v2, address p2) = _treasury(bytes32(uint256(6)));
        address owner = IStonksFeeLockerV2Admin(V2_LOCKER).feeOwnerOf(V2_COIN);
        vm.prank(owner);
        IStonksFeeLockerV2Admin(V2_LOCKER).transferFeeOwner(V2_COIN, p2);
        v2.bind(V2_COIN);

        vm.expectCall(V2_LOCKER, abi.encodeWithSignature("collect(address)", V2_COIN));
        v2.harvest();
    }

    /**
     * End to end on real code, with fees this test CREATES rather than hopes to find.
     *
     * The first version of this asserted against whatever the pool happened to have accrued by the
     * pinned block, which was nothing — so it asserted 0 == 0 and would have passed against a
     * treasury that collected nothing at all. Trading against the pool makes the fee real, and then
     * every number below has something to be wrong about.
     */
    function test_realFeesFlowThroughTheV2LockerAndLandAsEther() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(7)));
        address owner = IStonksFeeLockerV2Admin(V2_LOCKER).feeOwnerOf(V2_COIN);
        vm.startPrank(owner);
        IStonksFeeLockerV2Admin(V2_LOCKER).setQuoteOnly(V2_COIN, true);
        IStonksFeeLockerV2Admin(V2_LOCKER).transferFeeOwner(V2_COIN, predicted);
        vm.stopPrank();
        t.bind(V2_COIN);

        // Buy the coin, then sell it back: both legs pay the 1% tier, so the position earns fees in
        // WETH and in the coin — which is exactly the two-legged shape `quoteOnly` splits apart.
        _tradeBothWays(V2_POOL, V2_COIN, 1 ether);

        uint256 received = t.harvest();

        assertGt(received, 0, "the fees the pool earned did not reach the treasury");
        assertEq(address(t).balance + t.creatorClaimable(), t.accountedQuote(), "books disagree with the balance");
        emit log_named_decimal_uint("v2 harvest (ETH)", received, 18);

        // The coin leg was HELD at the locker, not paid here — so there was nothing to burn, and the
        // treasury is not a holder of its own launch.
        assertEq(IERC20Balance(V2_COIN).balanceOf(address(t)), 0, "a coin leg should never have arrived");
        assertGt(
            IStonksFeeLockerV2Admin(V2_LOCKER).pendingCoin(V2_COIN), 0, "the coin leg was not held for conversion"
        );
    }

    /**
     * The same proof for the OLD locker, which is the half that could only regress.
     *
     * Kind 0 was not rewritten, but it was re-plumbed: the role view is now resolved through a
     * selector chosen per shape instead of being named inline. This spends real fees through the
     * deployed StonkFeeLocker2 to show the new implementation still collects them — and still burns
     * the coin leg, which V1 pays and V2 (under quoteOnly) does not.
     */
    function test_realFeesFlowThroughTheV1LockerAndTheCoinLegIsBurned() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(8)));
        address[] memory to = new address[](1);
        to[0] = predicted;
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.prank(IStonkFeeLocker2(V1_LOCKER).tokenCreator(V1_COIN));
        IStonkFeeLocker2(V1_LOCKER).setCreatorSplit(V1_COIN, to, bps);
        t.bind(V1_COIN);

        uint256 burnedBefore = IERC20Balance(V1_COIN).balanceOf(BURN);
        _tradeBothWays(V1_POOL, V1_COIN, 1 ether);

        uint256 received = t.harvest();

        assertGt(received, 0, "the fees the pool earned did not reach the treasury");
        assertEq(address(t).balance + t.creatorClaimable(), t.accountedQuote(), "books disagree with the balance");
        emit log_named_decimal_uint("v1 harvest (ETH)", received, 18);

        assertEq(IERC20Balance(V1_COIN).balanceOf(address(t)), 0, "the coin leg must not be kept");
        assertGt(IERC20Balance(V1_COIN).balanceOf(BURN) - burnedBefore, 0, "the coin leg was not burned");
    }

    /// Swap in and straight back out, paying the pool from this contract in the callback. Both legs
    /// pay the tier's fee, so the position earns in WETH and in the coin.
    function _tradeBothWays(address pool, address coin, uint256 wethIn) internal {
        _activePool = pool;
        _activeCoin = coin;

        vm.deal(address(this), address(this).balance + wethIn);
        IWETH9(WETH).deposit{value: wethIn}();

        bool wethIsToken0 = ICLPool(pool).token0() == WETH;
        // Selling WETH is zeroForOne only when WETH IS token0; the two pools disagree on that.
        (int256 a0, int256 a1) = _swap(pool, wethIsToken0, int256(wethIn));
        int256 coinOut = wethIsToken0 ? a1 : a0; // negative: it left the pool
        _swap(pool, !wethIsToken0, -coinOut);

        _activePool = address(0);
    }

    function _swap(address pool, bool zeroForOne, int256 amount) internal returns (int256, int256) {
        return ICLPool(pool).swap(
            address(this), zeroForOne, amount, zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, ""
        );
    }

    address private _activePool;
    address private _activeCoin;

    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// The pool asks for what it is owed; anything else is not ours to pay.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == _activePool, "unexpected pool");
        address token0 = ICLPool(_activePool).token0();
        address token1 = token0 == WETH ? _activeCoin : WETH;
        if (amount0Delta > 0) IERC20Balance(token0).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20Balance(token1).transfer(msg.sender, uint256(amount1Delta));
    }
}

interface IERC20Balance {
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
