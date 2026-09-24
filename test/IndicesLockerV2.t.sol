// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";

import {MockERC20, MockWETH, MockRouter} from "./Indices.t.sol";
import {IndexFactory} from "../src/indices/IndexFactory.sol";
import {IndexTreasury} from "../src/indices/IndexTreasury.sol";

/**
 * Stands in for StonksExchangeFeeLockerV2 — the V2 launchpad's registry and paymaster, whose pools
 * live on Aerodrome Slipstream.
 *
 * Models only what the treasury reads, and models the DIFFERENCES faithfully, because they are the
 * whole reason kind 1 exists:
 *
 *   - `tokenCreator` still answers with the launching wallet and still holds no rights. A mock that
 *     omitted it would make the trap untestable: on the real locker the wrong view does not revert,
 *     it answers plausibly.
 *   - the paired asset lives in the position record, keyed on the NFT, not on the coin.
 *   - under `quoteOnly` the coin leg is HELD rather than paid, and reaches the fee owner later as
 *     quote, through `convert` — a payment nothing on the treasury is called for.
 */
contract MockStonksLockerV2 {
    struct Position {
        address feeOwner;
        address quote;
        address pool;
        uint16 platformBps;
        bool quoteOnly;
        bool active;
    }

    /// V2 stores bps as a uint16 where V1 uses a uint256. Declared as the locker declares it, so the
    /// treasury decoding it through the V1 shape is exercised rather than assumed.
    struct Split {
        address to;
        uint16 bps;
    }

    mapping(uint256 => Position) public positionsInfo;
    mapping(address => uint256) public positionOf;
    /// Informational only — the launching wallet, paid nothing.
    mapping(address => address) public tokenCreator;
    mapping(address => Split[]) internal _splits;
    mapping(address => mapping(address => uint256)) public claimable;

    /// what the next collect will pay out, per coin
    mapping(address => uint256) public pendingQuote;
    mapping(address => uint256) public pendingCoin;
    /// the fee owner's coin leg, held for conversion under quoteOnly
    mapping(address => uint256) public heldCoin;
    /// when true a direct payout fails and the amount is deferred to `claimable`
    bool public deferPayouts;

    uint256 private _nextId = 1;

    /// The launch path: the fee owner is named IN the launch and is whoever the creator chose.
    function register(address coin, address creator, address feeOwner, address quote, bool quoteOnly) external {
        uint256 id = _nextId++;
        positionOf[coin] = id;
        positionsInfo[id] =
            Position({feeOwner: feeOwner, quote: quote, pool: address(0xBEEF), platformBps: 3000, quoteOnly: quoteOnly, active: true});
        tokenCreator[coin] = creator;
    }

    function setFeeOwner(address coin, address to) external {
        positionsInfo[positionOf[coin]].feeOwner = to;
        delete _splits[coin];
    }

    function setQuoteOnly(address coin, bool on) external {
        positionsInfo[positionOf[coin]].quoteOnly = on;
    }

    function deactivate(address coin) external {
        positionsInfo[positionOf[coin]].active = false;
    }

    function setSplit(address coin, address to) external {
        delete _splits[coin];
        if (to != address(0)) _splits[coin].push(Split(to, 10_000));
    }

    function addSplit(address coin, address to, uint16 bps) external {
        if (_splits[coin].length == 1) _splits[coin][0].bps = 10_000 - bps;
        _splits[coin].push(Split(to, bps));
    }

    function splitsOf(address token) external view returns (Split[] memory) {
        return _splits[token];
    }

    function feeOwnerOf(address token) external view returns (address) {
        return positionsInfo[positionOf[token]].feeOwner;
    }

    function setDefer(bool on) external {
        deferPayouts = on;
    }

    function fund(address coin, uint256 quoteAmount, uint256 coinAmount) external {
        pendingQuote[coin] = quoteAmount;
        pendingCoin[coin] = coinAmount;
    }

    /// Pays the quote leg now; the coin leg is paid now or held, exactly as the real one does.
    function collect(address token) external {
        Position memory p = positionsInfo[positionOf[token]];
        require(p.active, "unknown token");
        address to = _splits[token].length != 0 ? _splits[token][0].to : p.feeOwner;

        uint256 q = pendingQuote[token];
        uint256 c = pendingCoin[token];
        pendingQuote[token] = 0;
        pendingCoin[token] = 0;

        if (q != 0) _payOrDefer(p.quote, to, q);
        if (c != 0) {
            if (p.quoteOnly) heldCoin[token] += c;
            else _payOrDefer(token, to, c);
        }
    }

    /// The platform keeper's conversion: held coin sold into the launch pool, proceeds paid to the
    /// fee owner as quote. Nothing on the treasury is called — the money simply arrives.
    function convert(address token, uint256 quoteOut) external {
        Position memory p = positionsInfo[positionOf[token]];
        heldCoin[token] = 0;
        address to = _splits[token].length != 0 ? _splits[token][0].to : p.feeOwner;
        _payOrDefer(p.quote, to, quoteOut);
    }

    function claim(address token) external {
        uint256 amount = claimable[msg.sender][token];
        require(amount > 0, "nothing to claim");
        claimable[msg.sender][token] = 0;
        MockERC20(token).transfer(msg.sender, amount);
    }

    function _payOrDefer(address token, address to, uint256 amount) internal {
        if (deferPayouts) claimable[to][token] += amount;
        else MockERC20(token).transfer(to, amount);
    }
}

/**
 * Kind 1 — a treasury bound to a V2 locker.
 *
 * The V1 suite covers everything downstream of `harvest`; what is new here is the bind predicate
 * reading a different registry and the shape of what arrives once `quoteOnly` is on.
 */
contract IndicesLockerV2Test is Test {
    IndexFactory factory;
    IndexTreasury impl;
    IndexTreasury tr;

    MockWETH weth;
    MockERC20 coin;
    MockERC20 stock;
    MockRouter router;
    MockStonksLockerV2 locker;

    uint8 internal constant LAUNCHPAD_STONKS_V2 = 1;
    uint8 internal constant KIND_FEE_OWNER_LOCKER = 1;

    address OWNER = address(0xA11CE);
    address KEEPER = address(0xBEEF);
    address CREATOR_WALLET = address(0xC0FFEE);
    address OUTSIDER = address(0xBAD);

    function setUp() public {
        weth = new MockWETH();
        coin = new MockERC20("COIN");
        stock = new MockERC20("NVDAc");
        router = new MockRouter(MockERC20(address(weth)), stock);
        locker = new MockStonksLockerV2();

        impl = new IndexTreasury();
        factory = new IndexFactory(address(impl), address(weth));
        factory.setKeeper(KEEPER, true);
        factory.setLaunchpad(LAUNCHPAD_STONKS_V2, address(locker), KIND_FEE_OWNER_LOCKER, true);
        factory.setVenue(address(router), true);
    }

    function _cfg(address coin_) internal view returns (IndexFactory.IndexConfig memory) {
        address[] memory b = new address[](1);
        b[0] = address(stock);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        return IndexFactory.IndexConfig({
            owner: OWNER,
            creator: address(0),
            quote: address(0),
            basket: b,
            weights: w,
            mode: 0,
            interval: 900,
            creatorShareBps: 0,
            coin: coin_
        });
    }

    /// An unbound treasury at a predictable address, the way the service creates one BEFORE the
    /// launch that will name it.
    function _treasury(bytes32 salt) internal returns (IndexTreasury t, address predicted) {
        predicted = factory.predictAddress(address(this), salt);
        t = IndexTreasury(payable(factory.createIndex(_cfg(address(0)), salt, address(0))));
        assertEq(address(t), predicted, "CREATE2 not deterministic");
    }

    /// Credit the locker with fees and the tokens to pay them with. WETH is wrapped for real: the
    /// treasury unwraps what a native-quoted basket collects, and unbacked WETH would revert there.
    function _fund(uint256 quoteAmount, uint256 coinAmount) internal {
        if (quoteAmount != 0) {
            vm.deal(address(this), address(this).balance + quoteAmount);
            weth.deposit{value: quoteAmount}();
            weth.transfer(address(locker), quoteAmount);
        }
        if (coinAmount != 0) coin.mint(address(locker), coinAmount);
        locker.fund(address(coin), quoteAmount, coinAmount);
    }

    // ── bind ────────────────────────────────────────────────────────────────────────────────

    /// The V2 launch path: `feeOwner` is chosen IN the launch, so an index can hold the whole stream
    /// from block one — no split, no ceremony.
    function test_bindsOnFeeOwnerNamedAtLaunch() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(1)));
        locker.register(address(coin), CREATOR_WALLET, predicted, address(weth), true);

        vm.prank(KEEPER);
        t.bind(address(coin));

        assertEq(t.coin(), address(coin), "coin not bound");
        assertTrue(t.bindIsPermanent(), "fee owner is the strong tier");
        (address recipient, bool permanent) = t.feeRecipientNow();
        assertEq(recipient, address(t));
        assertTrue(permanent);
    }

    /**
     * THE TRAP kind 1 exists for: on a V2 locker `tokenCreator` answers with the launching wallet,
     * which holds no rights and is paid nothing.
     *
     * Reading it the way kind 0 does would bind a treasury to a coin whose fees go somewhere else —
     * and it would not revert while doing it, because the view answers. Here the treasury is the
     * creator and somebody else is the fee owner, which is exactly the state that must NOT bind.
     */
    function test_refusesWhenOnlyTheCreatorRoleNamesUs() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(2)));
        locker.register(address(coin), predicted, OUTSIDER, address(weth), true);

        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        vm.prank(KEEPER);
        t.bind(address(coin));
    }

    /// The weaker tier, unchanged from V1: a split pointing the whole stream here binds, but the fee
    /// owner can repoint it, so the promise is not permanent.
    function test_bindsOnWholeSplitButNotPermanently() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(3)));
        locker.register(address(coin), CREATOR_WALLET, OUTSIDER, address(weth), true);
        locker.setSplit(address(coin), predicted);

        vm.prank(KEEPER);
        t.bind(address(coin));

        assertEq(t.coin(), address(coin));
        assertFalse(t.bindIsPermanent(), "a split is revocable by its fee owner");
    }

    /// A stream this treasury only gets a slice of is an accounting hole, not a smaller programme.
    function test_refusesSplitSpreadAcrossWallets() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(4)));
        locker.register(address(coin), CREATOR_WALLET, OUTSIDER, address(weth), true);
        locker.setSplit(address(coin), predicted);
        locker.addSplit(address(coin), OUTSIDER, 4_000);

        // Named apart from a plain refusal: the creator can see the split is the problem.
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.SplitNotWhole.selector, 2));
        vm.prank(KEEPER);
        t.bind(address(coin));
    }

    /// The paired asset comes from the POSITION record in V2. A basket quoted in anything else would
    /// see a delta of zero on every harvest, so it is refused at bind.
    function test_refusesWhenPositionQuoteIsNotOurs() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(5)));
        // native-quoted basket, but the launch was paired against an equity
        locker.register(address(coin), CREATOR_WALLET, predicted, address(stock), true);

        vm.expectRevert(
            abi.encodeWithSelector(IndexTreasury.QuoteMismatch.selector, address(stock), address(0))
        );
        vm.prank(KEEPER);
        t.bind(address(coin));
    }

    /// A coin the locker knows but holds no live position for would harvest nothing forever.
    function test_refusesInactivePosition() public {
        (IndexTreasury t, address predicted) = _treasury(bytes32(uint256(6)));
        locker.register(address(coin), CREATOR_WALLET, predicted, address(weth), true);
        locker.deactivate(address(coin));

        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        vm.prank(KEEPER);
        t.bind(address(coin));
    }

    /// A coin the locker never registered: `positionOf` answers zero, and zero is not a position.
    function test_refusesUnknownCoin() public {
        (IndexTreasury t,) = _treasury(bytes32(uint256(7)));
        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        vm.prank(KEEPER);
        t.bind(address(coin));
    }

    // ── harvest ─────────────────────────────────────────────────────────────────────────────

    function _bound(bytes32 salt, bool quoteOnly) internal returns (IndexTreasury t) {
        address predicted;
        (t, predicted) = _treasury(salt);
        locker.register(address(coin), CREATOR_WALLET, predicted, address(weth), quoteOnly);
        vm.prank(KEEPER);
        t.bind(address(coin));
    }

    /// `collect(coin)` — the renamed, singular counterpart of `collectAll`.
    function test_harvestCollectsThroughTheV2Entrypoint() public {
        IndexTreasury t = _bound(bytes32(uint256(8)), true);
        _fund(1 ether, 0);

        uint256 received = t.harvest();

        assertEq(received, 1 ether, "the quote leg did not land");
        assertEq(address(t).balance, 1 ether, "native-quoted basket must hold ether, not WETH");
    }

    /// The locker defers a payout it could not deliver; harvest sweeps it behind the collect.
    function test_harvestSweepsADeferredPayout() public {
        IndexTreasury t = _bound(bytes32(uint256(9)), true);
        _fund(1 ether, 0);
        locker.setDefer(true);

        uint256 received = t.harvest();

        assertEq(received, 1 ether, "a deferred payout must still be swept");
        assertEq(locker.claimable(address(t), address(weth)), 0, "nothing left stranded");
    }

    /**
     * What a V2 index actually looks like in production: `quoteOnly` on, so no coin leg is ever
     * paid, and the coin the locker holds reaches us later as QUOTE through the platform's
     * conversion — a payment nothing on this contract is called for.
     *
     * The burn path is left in place and simply has nothing to burn. That it stays correct when the
     * flag is switched off is the next test.
     */
    function test_quoteOnlyPaysNoCoinLegAndConversionLandsAtTheNextHarvest() public {
        IndexTreasury t = _bound(bytes32(uint256(10)), true);
        _fund(1 ether, 500e18);

        uint256 received = t.harvest();
        assertEq(received, 1 ether, "only the quote leg is paid under quoteOnly");
        assertEq(coin.balanceOf(address(t)), 0, "no coin leg should ever arrive");
        assertEq(locker.heldCoin(address(coin)), 500e18, "the coin leg is held for conversion");

        // The platform keeper converts the held coin. The treasury is not called: quote just shows up.
        vm.deal(address(this), address(this).balance + 0.4 ether);
        weth.deposit{value: 0.4 ether}();
        weth.transfer(address(locker), 0.4 ether);
        locker.convert(address(coin), 0.4 ether);

        // Picked up by the watermark rather than by the collect — `received` counts everything
        // unaccounted, not just what this call brought in.
        assertEq(t.harvest(), 0.4 ether, "the conversion proceeds were not counted");
    }

    /// Switching the flag off releases what was held, and the coin leg is burned exactly as in V1.
    function test_coinLegIsStillBurnedWhenQuoteOnlyGoesOff() public {
        IndexTreasury t = _bound(bytes32(uint256(11)), true);
        locker.setQuoteOnly(address(coin), false);
        _fund(1 ether, 500e18);

        uint256 supplyBefore = coin.totalSupply();
        t.harvest();

        assertEq(coin.balanceOf(address(t)), 0, "the coin leg must not be kept");
        assertEq(coin.totalSupply(), supplyBefore, "burned to dEaD, not from supply");
        assertEq(coin.balanceOf(address(0xdEaD)), 500e18, "the coin leg was not burned");
    }
}
