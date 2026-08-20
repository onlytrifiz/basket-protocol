// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {IndexFactory} from "../src/indices/IndexFactory.sol";
import {IndexTreasury} from "../src/indices/IndexTreasury.sol";

contract MockERC20 {
    string public name;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n) {
        name = n;
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
        totalSupply += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("WETH") {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
    }

    function withdraw(uint256 a) external {
        balanceOf[msg.sender] -= a;
        totalSupply -= a;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok);
    }
}

/// Pays in native ETH like the pons fee manager — including its `NoBalance()` revert when the caller
/// has nothing pending, which is what the live one does on most cycles (see Baskets.fork.t.sol).
/**
 * pons paying an ERC20 pair token rather than ether, which is how most of its pairs settle.
 *
 * The escrow keeps two ledgers and the entrypoints are different: `claim()` releases ether and
 * `claimToken(token)` releases an ERC20. Only the second is implemented here, deliberately — calling
 * the wrong one against the real escrow is not an error, it simply pays nothing, and a mock that
 * answered both would hide exactly that.
 */
/**
 * Stands in for StonkFeeLocker2. Models the three things the treasury depends on and nothing else:
 * the creator role that `bind` proves itself against, a paired quote, and a payout that can DEFER
 * instead of landing — which is the locker's real behaviour when a transfer fails, and the reason
 * harvest sweeps `claim` behind every collect.
 */
import {Split} from "../src/indices/IndexTreasury.sol";

contract MockStonkLocker {
    mapping(address => address) public tokenCreator;
    mapping(address => address) public tokenQuote;
    mapping(address => uint256[]) internal _positions;
    /// What a launch's `feeRecipient` becomes: a split, NOT the creator role. Mirrors register().
    mapping(address => Split[]) internal _splits;
    mapping(address => mapping(address => uint256)) public claimable;

    /// what a collect will pay out, per coin: the paired leg and the coin leg
    mapping(address => uint256) public pendingQuote;
    mapping(address => uint256) public pendingCoin;
    /// when true the direct payout fails and the amount is deferred to `claimable`
    bool public deferPayouts;
    /// when true `collectAll` reverts, the way it does for a coin with no positions
    bool public collectReverts;

    /// The launch path: `creator` keeps the role, `feeRecipient` lands in the split. This is what
    /// StonkLauncher2 + register() actually produce, and the state a treasury really has to bind on.
    function launch(address coin, address creator, address quote_, address feeRecipient) external {
        tokenCreator[coin] = creator;
        tokenQuote[coin] = quote_;
        _positions[coin].push(1);
        if (feeRecipient != address(0) && feeRecipient != creator) {
            _splits[coin].push(Split(feeRecipient, 10000));
        }
    }

    /// The ceremony's end state: the role moved, and executeTokenCreator cleared the split.
    function set(address coin, address creator, address quote_) external {
        tokenCreator[coin] = creator;
        tokenQuote[coin] = quote_;
        if (_positions[coin].length == 0) _positions[coin].push(1);
        delete _splits[coin];
    }

    /// Creator-only in the real locker, and revocable at any time — the whole point of the flag.
    function setCreatorSplit(address coin, address to) external {
        delete _splits[coin];
        if (to != address(0)) _splits[coin].push(Split(to, 10000));
    }

    /// A second recipient, so a spread split can be exercised. Real locker: setCreatorSplit(20 max).
    function addSplit(address coin, address to, uint256 bps) external {
        if (_splits[coin].length == 1) _splits[coin][0].bps = 10_000 - bps;
        _splits[coin].push(Split(to, bps));
    }

    function splitsOf(address token) external view returns (Split[] memory) {
        return _splits[token];
    }

    function setNoPositions(address coin) external {
        delete _positions[coin];
    }

    function setDefer(bool on) external {
        deferPayouts = on;
    }

    function setCollectReverts(bool on) external {
        collectReverts = on;
    }

    function fund(address coin, uint256 quoteAmount, uint256 coinAmount) external {
        pendingQuote[coin] = quoteAmount;
        pendingCoin[coin] = coinAmount;
    }

    function positionsOf(address token) external view returns (uint256[] memory) {
        return _positions[token];
    }

    function collectAll(address token) external {
        require(!collectReverts, "no positions");
        // Mirrors _payCreator: a non-empty split wins over the creator role entirely.
        address to = _splits[token].length != 0 ? _splits[token][0].to : tokenCreator[token];
        uint256 q = pendingQuote[token];
        uint256 c = pendingCoin[token];
        pendingQuote[token] = 0;
        pendingCoin[token] = 0;
        if (q != 0) _payOrDefer(tokenQuote[token], to, q);
        if (c != 0) _payOrDefer(token, to, c);
    }

    function claim(address token) external {
        uint256 amount = claimable[msg.sender][token];
        require(amount > 0, "nothing to claim");
        claimable[msg.sender][token] = 0;
        MockERC20(token).transfer(msg.sender, amount);
    }

    function _payOrDefer(address token, address to, uint256 amount) internal {
        if (deferPayouts) {
            claimable[to][token] += amount;
        } else {
            MockERC20(token).transfer(to, amount);
        }
    }
}

contract MockRouter {
    MockERC20 public sell;
    MockERC20 public buy;
    uint256 public rateNum = 2; // 1 sell -> 2 buy
    uint256 public rateDen = 1;

    constructor(MockERC20 s, MockERC20 b) {
        sell = s;
        buy = b;
    }

    function setRate(uint256 n, uint256 d) external {
        rateNum = n;
        rateDen = d;
    }

    function settle(uint256 sellAmount) external {
        sell.transferFrom(msg.sender, address(this), sellAmount);
        buy.mint(msg.sender, (sellAmount * rateNum) / rateDen);
    }

    /// variant that delivers nothing: covers InsufficientOutput
    function settleBad(uint256 sellAmount) external {
        sell.transferFrom(msg.sender, address(this), sellAmount);
    }

    receive() external payable {}
}

/// Rialto's registry: ownerOf(featureId) -> live router
contract MockPool {
    receive() external payable {}
}

/// Stands in for PonsV2LaunchFactory at its real address (etched in), which is the authority `bind`
/// checks: only the treasury a launch actually pays may bind that launch's coin.
contract BasketsTest is Test {
    IndexFactory factory;
    IndexTreasury impl;
    IndexTreasury tr;

    MockWETH weth;
    MockERC20 coin;
    MockERC20 stock;
    MockERC20 stock2;
    MockRouter router;
    MockPool pool;
    MockStonkLocker locker;

    uint8 internal constant LAUNCHPAD_STONKS = 0;
    uint8 internal constant KIND_CREATOR_LOCKER = 0;

    address OWNER = address(0xA11CE);
    address KEEPER = address(0xBEEF);
    address OUTSIDER = address(0xBAD);
    address H1 = address(0x1001);
    address H2 = address(0x1002);
    address H3 = address(0x1003);
    address DUST = address(0x1004);
    address POOL;

    uint256 constant FEATURE_ID = 2;
    address constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;


    /// Credit the locker with fees this treasury may collect, and give it the tokens to pay them
    /// with. The real locker pays BOTH legs as ERC20s — WETH for an ETH-quoted launch, never ether —
    /// so a native-quoted basket only ever sees its fees after `harvest` unwraps them.
    function _fund(address coin_, address quote_, uint256 quoteAmount, uint256 coinAmount) internal {
        if (quoteAmount != 0) {
            if (quote_ == address(weth)) {
                // real WETH is always backed by the ether it wrapped, and `harvest` unwraps it —
                // minting an unbacked balance would revert the withdraw for a reason the contract
                // is not responsible for
                vm.deal(address(this), address(this).balance + quoteAmount);
                weth.deposit{value: quoteAmount}();
                weth.transfer(address(locker), quoteAmount);
            } else {
                MockERC20(quote_).mint(address(locker), quoteAmount);
            }
        }
        if (coinAmount != 0) MockERC20(coin_).mint(address(locker), coinAmount);
        locker.fund(coin_, quoteAmount, coinAmount);
    }

    function setUp() public {
        weth = new MockWETH();
        coin = new MockERC20("COIN");
        stock = new MockERC20("RBLX");
        stock2 = new MockERC20("AAPL");
        router = new MockRouter(MockERC20(address(weth)), stock);
        pool = new MockPool();
        POOL = address(pool);

        locker = new MockStonkLocker();

        impl = new IndexTreasury();
        factory = new IndexFactory(address(impl), address(weth));
        factory.setKeeper(KEEPER, true);
        factory.setLaunchpad(LAUNCHPAD_STONKS, address(locker), KIND_CREATOR_LOCKER, true);
        factory.setVenue(address(router), true);

        address predicted = factory.predictAddress(address(this), bytes32(uint256(1)));
        // the launch names this treasury as the creator the locker pays
        locker.set(address(coin), predicted, address(weth));
        tr = IndexTreasury(payable(factory.createIndex(_cfg(address(coin), 0), bytes32(uint256(1)), predicted)));
        assertEq(address(tr), predicted, "CREATE2 not deterministic");

        // holders 100k / 300k / 600k coins, a dust holder under the line, plus the pool
        coin.mint(H1, 100_000e18);
        coin.mint(H2, 300_000e18);
        coin.mint(H3, 600_000e18);
        coin.mint(DUST, 9_999e18);
        coin.mint(POOL, 5_000_000e18);
        vm.prank(KEEPER);
        tr.setExcluded(POOL, true);
    }

    /// single-stock, native-quote config; `coin_` zero means bind later
    function _cfg(address coin_, uint16 creatorShareBps) internal view returns (IndexFactory.IndexConfig memory) {
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
            creatorShareBps: creatorShareBps,
            coin: coin_
        });
    }

    /// Creates a basket the way the service does: the launch names it as its fee recipient first,
    /// which is what `bind` verifies. `creator` is who signs the create (it seeds the CREATE2 salt).
    function _create(IndexFactory.IndexConfig memory cfg, bytes32 salt, address creator)
        internal
        returns (address t)
    {
        address predicted = factory.predictAddress(creator, salt);
        // a native-quoted basket is paid in WETH: ether and wrapped are one asset here
        if (cfg.coin != address(0)) {
            locker.set(cfg.coin, predicted, cfg.quote == address(0) ? address(weth) : cfg.quote);
        }
        vm.prank(creator);
        return factory.createIndex(cfg, salt, address(0));
    }

    function _create(IndexFactory.IndexConfig memory cfg, bytes32 salt) internal returns (address) {
        return _create(cfg, salt, address(this));
    }

    function _holders() internal view returns (address[] memory hs) {
        hs = new address[](3);
        hs[0] = H1;
        hs[1] = H2;
        hs[2] = H3;
    }

    /// The contract requires a strictly ascending list, so any list containing a deployed address
    /// (the pool) has to be ordered rather than written in the order we happen to think of it.
    function _sorted(address[] memory a) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < a.length; ++i) {
            address k = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > k) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = k;
        }
        return a;
    }

    /**
     * Money a round may actually spend.
     *
     * It goes through the locker and a harvest, not `vm.deal`, because only quote that has been
     * through the split is spendable — unharvested money still owes the platform fee and the
     * creator's share. Dealing straight to the treasury modelled a state the keeper must never act
     * on, and every test built on it was asserting against a hazard.
     */
    function _fund(uint256 a) internal {
        _fund(address(coin), address(weth), a, 0);
        tr.harvest();
    }

    function _buy(uint256 ethIn) internal {
        _fund(ethIn);
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, ethIn);
        vm.prank(KEEPER);
        tr.swap(address(router), address(weth), ethIn, address(stock), 1, cd);
    }

    // ------------------------------------------------------------------ base

    function test_InitConfig() public view {
        assertEq(tr.owner(), OWNER);
        assertEq(tr.creator(), OWNER, "creator defaults to owner");
        assertEq(tr.quote(), address(0));
        assertEq(tr.interval(), 900);
        assertEq(tr.coin(), address(coin), "bound atomically at create");
        assertEq(tr.basketLength(), 1);
        assertTrue(tr.excluded(address(tr)));
        assertEq(tr.minHolderBalance(), 10_000e18, "10k coins at 18 decimals");
    }

    function test_ImplementationCannotBeInitialized() public {
        address[] memory b = new address[](1);
        b[0] = address(stock);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        vm.expectRevert(IndexTreasury.AlreadyInitialized.selector);
        impl.initialize(OWNER, OWNER, address(0), b, w, 900, 0, 0);
    }

    function test_InitializeCannotBeReplayed() public {
        address[] memory b = new address[](1);
        b[0] = address(stock);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        vm.expectRevert(IndexTreasury.AlreadyInitialized.selector);
        tr.initialize(address(this), address(0), address(0), b, w, 900, 0, 0);
    }

    function test_WeightsMustSumTo10000() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 0);
        cfg.basket = new address[](2);
        cfg.basket[0] = address(stock);
        cfg.basket[1] = address(stock2);
        cfg.weights = new uint16[](2);
        cfg.weights[0] = 5000;
        cfg.weights[1] = 4000;
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(77)), address(0));
    }

    function test_IntervalMustBeInServiceBounds() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 0);
        cfg.interval = 899;
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(78)), address(0));

        cfg.interval = 604_801;
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(79)), address(0));

        cfg.interval = 3600; // the service default
        address t = _create(cfg, bytes32(uint256(80)));
        assertEq(IndexTreasury(payable(t)).interval(), 3600);
    }

    /// the quote asset in the basket would let distribute() pay out the creator's accrued share
    /// A native quote is ether and WETH at once, so a WETH entry is the same collision with two
    /// balances to reconcile instead of one. That one stays refused.
    function test_BasketCannotHoldWethWhenTheQuoteIsNative() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 0);
        cfg.basket[0] = address(weth);
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(82)), address(0));
    }

    /**
     * A basket MAY hold the asset its fees arrive in, and that entry is filled without a trade.
     *
     * This is the ordinary case for a coin paired against a stock: the fees arrive as that stock, so
     * buying it would be selling it to itself across a spread. What has to hold is the accounting —
     * one balance carries unspent fees, the creator's accrual and the holders' share at once, and a
     * round may only ever reach the last of those.
     */
    function test_BasketCanHoldTheQuoteAssetAndAllocatesInsteadOfBuying() public {
        MockERC20 pair = new MockERC20("NVDA-pair");
        factory.setPlatformFee(1000, address(0xFEE));

        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 2000); // creator keeps 20%
        cfg.quote = address(pair);
        cfg.basket = new address[](1);
        cfg.basket[0] = address(pair); // the basket buys what pays it
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        cfg.weights = w;
        IndexTreasury t2 = IndexTreasury(payable(_create(cfg, bytes32(uint256(84)))));

        _fund(address(coin), address(pair), 100e18, 0);
        t2.harvest();
        assertEq(t2.creatorClaimable(), 18e18, "creator's share of what is left after the fee");
        assertEq(t2.spendableQuote(), 72e18, "and the rest is what a round may use");

        // there is nothing to buy: the router is refused for this entry
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.AllocateInstead.selector);
        t2.swap(address(router), address(pair), 72e18, address(pair), 1, "");

        // it is promised instead, and cannot be promised beyond what was spendable
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.ExceedsAvailable.selector, 73e18, 72e18));
        t2.allocate(0, 73e18);

        vm.prank(KEEPER);
        t2.allocate(0, 72e18);
        assertEq(t2.allocatedQuote(), 72e18);
        assertEq(t2.spendableQuote(), 0, "allocated value is no longer spendable");
        assertEq(t2.creatorClaimable(), 18e18, "and the creator's share is untouched");

        // a round pays out exactly what was promised, not the whole balance
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        assertEq(t2.distribute(0, _holders()), 72e18, "only the allocated part goes out");
        assertEq(t2.allocatedQuote(), 0, "the ledger falls by what left");
        assertEq(pair.balanceOf(address(t2)), 18e18, "the creator's share stayed behind");

        // and the creator can still take theirs in full
        t2.claimCreator();
        assertEq(pair.balanceOf(OWNER), 18e18, "the claim was never short");
        assertEq(pair.balanceOf(address(t2)), 0);
    }

    /// The keeper cannot promise the creator's accrual, however it asks.
    function test_AllocateCannotReachTheCreatorsShare() public {
        MockERC20 pair = new MockERC20("NVDA-pair");

        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 5000); // creator keeps half
        cfg.quote = address(pair);
        cfg.basket = new address[](1);
        cfg.basket[0] = address(pair);
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        cfg.weights = w;
        IndexTreasury t2 = IndexTreasury(payable(_create(cfg, bytes32(uint256(85)))));

        _fund(address(coin), address(pair), 100e18, 0);
        t2.harvest();

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.ExceedsAvailable.selector, 100e18, 50e18));
        t2.allocate(0, 100e18);

        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        t2.allocate(0, 1e18);
    }

    /// two slots for one token give it two independent round gates over one balance
    function test_BasketCannotRepeatAToken() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 0);
        cfg.basket = new address[](2);
        cfg.basket[0] = address(stock);
        cfg.basket[1] = address(stock);
        cfg.weights = new uint16[](2);
        cfg.weights[0] = 5000;
        cfg.weights[1] = 5000;
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(84)), address(0));
    }

    // ------------------------------------------------------------------- bind

    function test_BindOnlyOnce() public {
        vm.expectRevert(IndexTreasury.AlreadyBound.selector);
        vm.prank(KEEPER);
        tr.bind(address(stock));
    }

    function test_CreateWithoutCoinBindsLater() public {
        address t = factory.createIndex(_cfg(address(0), 0), bytes32(uint256(81)), address(0));
        assertEq(IndexTreasury(payable(t)).coin(), address(0));
        locker.set(address(coin), t, address(weth)); // the launch points its fees here
        vm.prank(KEEPER);
        IndexTreasury(payable(t)).bind(address(coin));
        assertEq(IndexTreasury(payable(t)).coin(), address(coin));
    }

    /// A basket can only ever bind the coin whose creator fees it actually receives. This is what
    /// stops someone squatting a popular coin and having the service airdrop their basket to that
    /// coin's holders — and, because pons keeps one recipient per token, it is also what stops the
    /// same coin ending up on two live baskets.
    function test_CannotBindACoinItDoesNotCollectFor() public {
        address t = factory.createIndex(_cfg(address(0), 0), bytes32(uint256(85)), address(0));
        MockERC20 popular = new MockERC20("POPULAR");
        locker.set(address(popular), address(0xDEAD), address(weth)); // its fees go elsewhere entirely

        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        vm.prank(KEEPER);
        IndexTreasury(payable(t)).bind(address(popular));

        // a coin nobody launched on pons is refused too
        MockERC20 nowhere = new MockERC20("NOWHERE");
        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        vm.prank(KEEPER);
        IndexTreasury(payable(t)).bind(address(nowhere));
    }

    /// The keeper repairs a basket whose creator pointed the fees and forgot — which is why `bind`
    /// stayed callable by somebody other than the factory. A stranger cannot, and neither can the
    /// owner: `coin` decides who the payouts are read over, so an owner able to pick it could
    /// substitute a coin it holds entirely and take every round.
    function test_OnlyTheKeeperCanRepairABasket() public {
        address t = factory.createIndex(_cfg(address(0), 0), bytes32(uint256(86)), address(0));
        locker.set(address(coin), t, address(weth));

        vm.prank(KEEPER);
        IndexTreasury(payable(t)).bind(address(coin));
        assertEq(IndexTreasury(payable(t)).coin(), address(coin));
        assertEq(IndexTreasury(payable(t)).minHolderBalance(), 10_000e18);
    }

    // --------------------------------------------------------------- harvest

    function test_HarvestPullsNativeFees() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        assertEq(tr.harvest(), 1 ether);
        assertEq(address(tr).balance, 1 ether);
    }

    function test_HarvestPlatformFee() public {
        factory.setPlatformFee(1000, address(0xFEE)); // the service's 10%
        _fund(address(coin), address(weth), 1 ether, 0);
        tr.harvest();
        assertEq(address(0xFEE).balance, 0.1 ether);
        assertEq(address(tr).balance, 0.9 ether);
    }

    function test_HarvestIsPermissionless() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        vm.prank(OUTSIDER);
        assertEq(tr.harvest(), 1 ether);
    }

    /// An empty claim is the ordinary case, not a fault: pons reverts NoBalance() when nothing is
    /// pending, and a keeper cycle that dies on that would never get to the swap or the payout.
    function test_HarvestSurvivesAnEmptyClaim() public {
        assertEq(locker.pendingQuote(address(coin)), 0);
        assertEq(tr.harvest(), 0, "returns zero instead of reverting"); // and the next real claim still works
        _fund(address(coin), address(weth), 1 ether, 0);
        assertEq(tr.harvest(), 1 ether);
    }

    // ---------------------------------------------------------- creator share

    /// platform fee off the top, creator share on the rest
    function test_CreatorShareAccruesAfterPlatformFee() public {
        factory.setPlatformFee(1000, address(0xFEE));
        IndexTreasury t =
            IndexTreasury(payable(_create(_cfg(address(coin), 5000), bytes32("c"))));
        _fund(address(coin), address(weth), 1 ether, 0);
        t.harvest();

        assertEq(address(0xFEE).balance, 0.1 ether, "10% platform");
        assertEq(t.creatorClaimable(), 0.45 ether, "50% of the remaining 0.9");
        assertEq(t.spendableQuote(), 0.45 ether, "the rest is the holders'");
    }

    function test_CreatorCanClaim() public {
        IndexTreasury t =
            IndexTreasury(payable(_create(_cfg(address(coin), 10_000), bytes32("c"))));
        _fund(address(coin), address(weth), 1 ether, 0);
        t.harvest();
        t.claimCreator();
        assertEq(OWNER.balance, 1 ether);
        assertEq(t.creatorClaimable(), 0);
    }

    /// the whole point of fencing it off: holder money cannot buy stock with the creator's money
    function test_SwapCannotSpendCreatorShare() public {
        IndexTreasury t =
            IndexTreasury(payable(_create(_cfg(address(coin), 5000), bytes32("c"))));
        _fund(address(coin), address(weth), 1 ether, 0);
        t.harvest(); // 0.5 to the creator, 0.5 to the holders

        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.ExceedsAvailable.selector, 1 ether, 0.5 ether));
        t.swap(address(router), address(weth), 1 ether, address(stock), 1, cd);

        bytes memory ok = abi.encodeWithSelector(MockRouter.settle.selector, uint256(0.5 ether));
        vm.prank(KEEPER);
        t.swap(address(router), address(weth), 0.5 ether, address(stock), 1, ok);
        assertEq(t.creatorClaimable(), 0.5 ether, "creator untouched");
        t.claimCreator();
        assertEq(OWNER.balance, 0.5 ether, "and still claimable in full");
    }

    /// declaring one amount and settling a larger one is what the exact approval stops: without it
    /// the creator's accrued share leaves with the swap and the claim is bricked for good
    function test_SwapCannotSettleMoreThanItDeclares() public {
        IndexTreasury t =
            IndexTreasury(payable(_create(_cfg(address(coin), 5000), bytes32("c"))));
        _fund(address(coin), address(weth), 1 ether, 0);
        t.harvest();

        // declares 0.5 (all the holders own) but the router calldata sells the whole balance
        bytes memory greedy = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.RouterCallFailed.selector);
        t.swap(address(router), address(weth), 0.5 ether, address(stock), 1, greedy);

        assertEq(t.creatorClaimable(), 0.5 ether);
        t.claimCreator(); // still whole
        assertEq(OWNER.balance, 0.5 ether);
    }

    function test_OnlyCreatorTransfersTheFeeStream() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NotCreator.selector);
        tr.transferCreator(OUTSIDER);

        vm.prank(OWNER);
        tr.transferCreator(address(0xC0FFEE));
        assertEq(tr.creator(), address(0xC0FFEE));
    }

    // ------------------------------------------------------------------ swap

    function test_SwapWrapsAndBuys() public {
        _fund(1 ether);
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        uint256 bought = tr.swap(address(router), address(weth), 1 ether, address(stock), 2 ether, cd);
        assertEq(bought, 2 ether);
        assertEq(stock.balanceOf(address(tr)), 2 ether);
        assertEq(weth.allowance(address(tr), address(router)), 0, "no standing approval is left behind");
    }

    function test_SwapIsKeeperOnly() public {
        _fund(1 ether);
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.swap(address(router), address(weth), 1 ether, address(stock), 1, cd);

        // not even the treasury owner: minBuyAmount is the only slippage floor there is
        vm.prank(OWNER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.swap(address(router), address(weth), 1 ether, address(stock), 1, cd);
    }

    function test_SwapRevertsOnInsufficientOutput() public {
        _fund(1 ether);
        bytes memory cd = abi.encodeWithSelector(MockRouter.settleBad.selector, uint256(1 ether));
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.InsufficientOutput.selector, 0, 2 ether));
        tr.swap(address(router), address(weth), 1 ether, address(stock), 2 ether, cd);
    }

    function test_SwapRejectsTokenOutsideBasket() public {
        _fund(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NotInBasket.selector);
        tr.swap(address(router), address(weth), 1 ether, address(stock2), 1, "");
    }

    /// the keeper must not be able to sell a stock it already bought
    function test_SwapRejectsSellingBasketToken() public {
        _fund(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.BadSellToken.selector);
        tr.swap(address(router), address(stock), 1 ether, address(stock), 1, "");
    }

    /// the router comes from Rialto's registry, never from stored config
    /// The keeper names the venue, and the swap lands there and nowhere else. On the old chain this
    /// was resolved from a registry; here the allowlist bounds the choice and the argument makes it.
    function test_SwapGoesToTheVenueTheKeeperNames() public {
        MockRouter other = new MockRouter(MockERC20(address(weth)), stock);
        factory.setVenue(address(other), true);
        _fund(address(coin), address(weth), 1 ether, 0);
        tr.harvest();
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        tr.swap(address(other), address(weth), 1 ether, address(stock), 2 ether, cd);
        assertEq(weth.balanceOf(address(other)), 1 ether, "settled on the named venue");
        assertEq(weth.balanceOf(address(router)), 0, "and not on any other allowlisted one");
    }

    // ----------------------------------------------------------- distribution

    function test_DistributeProRata() public {
        _buy(1 ether); // -> 2e18 of stock
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        uint256 sent = tr.distribute(0, _holders());

        // weights 100k/300k/600k out of 1M
        assertEq(stock.balanceOf(H1), 0.2e18);
        assertEq(stock.balanceOf(H2), 0.6e18);
        assertEq(stock.balanceOf(H3), 1.2e18);
        assertEq(sent, 2e18);
    }

    /// THE reason the entrypoint is gated: the denominator is the sum of the list passed in, so an
    /// open distribute() would let any holder pass [self] and take the whole round.
    function test_DistributeIsKeeperOnly() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);

        address[] memory greedy = new address[](1);
        greedy[0] = H1;
        vm.prank(H1);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.distribute(0, greedy);

        vm.prank(H1);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.distributeAmount(0, 1e18, greedy);

        assertEq(stock.balanceOf(H1), 0, "nothing extracted");
    }

    /// a repeated address is otherwise counted and paid once per occurrence, which lets the caller
    /// amplify its own weight while every individual balance read stays honest
    function test_DistributeRejectsDuplicateHolders() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);
        address[] memory dupes = new address[](3);
        dupes[0] = H1;
        dupes[1] = H1;
        dupes[2] = H2;
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.UnsortedHolders.selector);
        tr.distribute(0, dupes);
    }

    function test_DistributeRejectsUnsortedHolders() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);
        address[] memory hs = new address[](3);
        hs[0] = H3;
        hs[1] = H1;
        hs[2] = H2;
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.UnsortedHolders.selector);
        tr.distribute(0, hs);
    }

    function test_DistributeIgnoresExcluded() public {
        _buy(1 ether);
        address[] memory hs = new address[](4);
        hs[0] = H1;
        hs[1] = H2;
        hs[2] = H3;
        hs[3] = POOL;

        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        tr.distribute(0, _sorted(hs));
        assertEq(stock.balanceOf(POOL), 0, "the pool must not be paid");
        assertEq(stock.balanceOf(H3), 1.2e18, "weights ignore the excluded");
    }

    /// under 10k coins a holder is skipped and its slice goes to the rest
    function test_DistributeSkipsDustHolders() public {
        _buy(1 ether);
        address[] memory hs = new address[](4);
        hs[0] = H1;
        hs[1] = H2;
        hs[2] = H3;
        hs[3] = DUST;

        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        tr.distribute(0, hs);
        assertEq(stock.balanceOf(DUST), 0, "under the line");
        assertEq(stock.balanceOf(H1), 0.2e18, "denominator excludes the dust holder");
    }

    function test_DistributeRespectsInterval() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        tr.distribute(0, _holders());

        _buy(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert();
        tr.distribute(0, _holders());

        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        tr.distribute(0, _holders());
        assertEq(stock.balanceOf(H1), 0.4e18);
    }

    function test_DistributeRevertsWithNoHolders() public {
        _buy(1 ether);
        address[] memory hs = new address[](1);
        hs[0] = POOL;
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NoEligibleHolders.selector);
        tr.distribute(0, hs);
    }

    function test_DistributeAmountSplitsOverTwoRounds() public {
        _buy(1 ether); // 2e18
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        tr.distributeAmount(0, 1e18, _holders());
        assertEq(stock.balanceOf(H1), 0.1e18);
        assertEq(stock.balanceOf(address(tr)), 1e18, "the other half stays");
    }

    /// two batches in one round: global proportions survive
    function test_BatchedDistributionKeepsGlobalProportions() public {
        _buy(1 ether); // 2e18 of stock, holders 100k/300k/600k
        vm.warp(vm.getBlockTimestamp() + 901);

        address[] memory a = new address[](1);
        a[0] = H1; // weight 100k of 1M
        address[] memory b = new address[](2);
        b[0] = H2;
        b[1] = H3; // 300k + 600k

        // the keeper gives each batch its slice of the global total
        vm.startPrank(KEEPER);
        tr.distributeAmount(0, 0.2e18, a);
        tr.distributeAmount(0, 1.8e18, b);
        vm.stopPrank();

        assertEq(stock.balanceOf(H1), 0.2e18);
        assertEq(stock.balanceOf(H2), 0.6e18);
        assertEq(stock.balanceOf(H3), 1.2e18);
        assertEq(stock.balanceOf(address(tr)), 0, "all out");
    }

    /// a repeated page boundary would otherwise pay those holders twice out of the next batch's
    /// slice, and the round's totals would still look right
    function test_BatchesCannotRevisitAHolder() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);

        address[] memory a = new address[](2);
        a[0] = H1;
        a[1] = H2;
        address[] memory b = new address[](2);
        b[0] = H2; // overlaps the previous page
        b[1] = H3;

        vm.startPrank(KEEPER);
        tr.distributeAmount(0, 0.8e18, a);
        vm.expectRevert(IndexTreasury.UnsortedHolders.selector);
        tr.distributeAmount(0, 1.2e18, b);
        vm.stopPrank();
    }

    /// the round's budget is fixed when it opens, so stock bought *after* that belongs to the next
    /// round — otherwise a mid-round purchase silently enlarges the slice the remaining batches split
    function test_BatchesCannotSpendStockThatArrivedMidRound() public {
        _buy(1 ether); // 2e18 in the round
        vm.warp(vm.getBlockTimestamp() + 901);

        address[] memory a = new address[](1);
        a[0] = H1;
        vm.prank(KEEPER);
        tr.distributeAmount(0, 0.2e18, a); // opens the round with a 2e18 budget

        _buy(1 ether); // another 2e18 lands while the round is still open

        address[] memory b = new address[](2);
        b[0] = H2;
        b[1] = H3;
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.RoundOverspent.selector);
        tr.distributeAmount(0, 2.5e18, b); // balance covers it; the round's budget does not

        vm.prank(KEEPER);
        tr.distributeAmount(0, 1.8e18, b); // the rest of the round is fine
        assertEq(stock.balanceOf(H3), 1.2e18);
    }

    /// past the window the second batch waits for the next round
    function test_BatchWindowExpires() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);
        address[] memory a = new address[](1);
        a[0] = H1;
        vm.prank(KEEPER);
        tr.distributeAmount(0, 0.2e18, a);

        vm.warp(vm.getBlockTimestamp() + tr.batchWindow() + 1);
        address[] memory b = new address[](1);
        b[0] = H2;
        vm.prank(KEEPER);
        vm.expectRevert();
        tr.distributeAmount(0, 0.6e18, b);
    }

    /// distribute() over the full list cannot be replayed inside the window
    function test_FullDistributeAlwaysStartsNewRound() public {
        _buy(1 ether);
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        tr.distribute(0, _holders());

        _buy(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(); // inside batchWindow, but distribute() does not batch
        tr.distribute(0, _holders());
    }

    function test_BatchWindowMustBeUnderInterval() public {
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        tr.setBatchWindow(900);
    }

    // ------------------------------------------------------------- permissions

    function test_AdminIsKeeperOnly() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.setPaused(true);

        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.setBatchWindow(100);
    }

    /// whoever controls the exclusions controls the denominator — an owner able to exclude the cap
    /// table would take a whole round with one wallet, which is the rug the keeper gate exists to stop
    function test_OwnerCannotShapeThePayout() public {
        vm.prank(OWNER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.setExcluded(H1, true);

        vm.prank(OWNER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.setMinHolderBalance(1e30);
    }

    /// and not even the keeper can exclude an ordinary holder: only contracts, which is what the
    /// pons curve and the v4 pool are
    function test_ExclusionsAreContractsOnly() public {
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NotAContract.selector);
        tr.setExcluded(H1, true);

        address[] memory many = new address[](2);
        many[0] = POOL;
        many[1] = H2;
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NotAContract.selector);
        tr.setExcludedBatch(many, true);
    }

    function test_PauseStopsTheCycle() public {
        vm.prank(KEEPER);
        tr.setPaused(true);
        vm.expectRevert(IndexTreasury.Paused.selector);
        tr.harvest();
    }

    /// no owner path drains the reserve: that is the promise the payout rests on
    function test_NobodyCanRescueBasketStockOrQuote() public {
        _buy(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.ProtectedAsset.selector);
        tr.rescueERC20(address(stock), OWNER, 1e18);

        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.ProtectedAsset.selector);
        tr.rescueERC20(address(weth), OWNER, 1);

        _fund(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.ProtectedAsset.selector);
        tr.rescueETH(OWNER, 1 ether);
    }

    function test_RescueStrayToken() public {
        stock2.mint(address(tr), 5e18);
        vm.prank(KEEPER);
        tr.rescueERC20(address(stock2), OWNER, 5e18);
        assertEq(stock2.balanceOf(OWNER), 5e18);
    }

    // -------------------------------------------------------------- factory

    function test_FactoryTracksIndexes() public view {
        assertEq(factory.indexCount(), 1);
        assertTrue(factory.isIndex(address(tr)));
        assertEq(factory.indexCountOf(address(this)), 1);
        assertEq(factory.indexesPaged(0, 10).length, 1);
    }

    /// the address shown to a creator before deploying must be the address they get, or the fees
    /// their launch already routed to it are stranded at a contract that will never exist
    function test_CreateRevertsIfTheImplementationMovedUnderAPrediction() public {
        address shown = factory.predictAddress(address(this), bytes32(uint256(90)));
        locker.set(address(coin), shown, address(weth));
        factory.setImplementation(address(new IndexTreasury()));

        vm.expectRevert(
            abi.encodeWithSelector(
                IndexFactory.AddressMismatch.selector,
                factory.predictAddress(address(this), bytes32(uint256(90))),
                shown
            )
        );
        factory.createIndex(_cfg(address(coin), 0), bytes32(uint256(90)), shown);
    }

    function test_FactoryRejectsCodelessConfig() public {
        vm.expectRevert(IndexFactory.BadConfig.selector);
        new IndexFactory(address(0xdead), address(weth));

        vm.expectRevert(IndexFactory.BadConfig.selector);
        factory.setImplementation(address(0xdead));

        vm.expectRevert(IndexFactory.BadConfig.selector);
        factory.setWeth(address(0));

        // an enabled launchpad has to answer; a codeless one would refuse every bind silently
        vm.expectRevert(IndexFactory.BadConfig.selector);
        factory.setLaunchpad(3, address(0xdead), KIND_CREATOR_LOCKER, true);

        // a venue is only checked when it is being ALLOWED — revoking one that has lost its code
        // must always stay possible
        vm.expectRevert(IndexFactory.BadConfig.selector);
        factory.setVenue(address(0xdead), true);
        factory.setVenue(address(0xdead), false);
    }

    function test_KeeperRotates() public {
        address spare = address(0x5AFE);
        factory.setKeeper(spare, true);
        factory.setKeeper(KEEPER, false);

        _fund(1 ether);
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(spare);
        tr.swap(address(router), address(weth), 1 ether, address(stock), 1, cd);
        assertEq(stock.balanceOf(address(tr)), 2e18);

        _fund(1 ether);
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        tr.swap(address(router), address(weth), 1 ether, address(stock), 1, cd);
    }

    function test_OnlyFactoryOwnerSetsKeeperAndFee() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(IndexFactory.NotOwner.selector);
        factory.setKeeper(OUTSIDER, true);

        vm.prank(OUTSIDER);
        vm.expectRevert(IndexFactory.NotOwner.selector);
        factory.setPlatformFee(1000, OUTSIDER);
    }

    function test_PlatformFeeIsCapped() public {
        vm.expectRevert(IndexFactory.BadConfig.selector);
        factory.setPlatformFee(2001, address(0xFEE));
        factory.setPlatformFee(2000, address(0xFEE)); // the hard cap itself is fine
    }

    function test_SameSaltSameCreatorCollides() public {
        vm.expectRevert(IndexFactory.CloneFailed.selector);
        factory.createIndex(_cfg(address(coin), 0), bytes32(uint256(1)), address(0));
    }

    /// two creators may reuse the same salt without colliding
    function test_SameSaltDifferentCreatorOk() public {
        // a second creator, same salt: a different address, and its own launch record
        address t2 = _create(_cfg(address(coin), 0), bytes32(uint256(1)), OUTSIDER);
        assertTrue(t2 != address(tr));
    }

    function test_MultiTokenBasket() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 0);
        cfg.basket = new address[](2);
        cfg.basket[0] = address(stock);
        cfg.basket[1] = address(stock2);
        cfg.weights = new uint16[](2);
        cfg.weights[0] = 6000;
        cfg.weights[1] = 4000;
        address t2 = _create(cfg, bytes32(uint256(42)));
        (address[] memory tk, uint16[] memory bps) = IndexTreasury(payable(t2)).basketAll();
        assertEq(tk.length, 2);
        assertEq(bps[0], 6000);
        assertEq(bps[1], 4000);
    }

    /// non-native quote: fees arrive as ERC20 and that is what gets sold
    function test_Erc20QuoteSwapPath() public {
        MockERC20 usdg = new MockERC20("USDG");
        MockRouter r2 = new MockRouter(usdg, stock2);
        factory.setVenue(address(r2), true);

        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 0);
        cfg.quote = address(usdg);
        cfg.basket = new address[](1);
        cfg.basket[0] = address(stock2);
        IndexTreasury t2 =
            IndexTreasury(payable(_create(cfg, bytes32(uint256(7)))));
        // through the locker and a harvest: a straight mint is money that never paid its cuts, and
        // the contract now refuses to spend it
        _fund(address(coin), address(usdg), 100e18, 0);
        t2.harvest();

        // WETH is not sellable here: the quote is USDG
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.BadSellToken.selector);
        t2.swap(address(r2), address(weth), 1e18, address(stock2), 1, "");

        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(100e18));
        vm.prank(KEEPER);
        assertEq(t2.swap(address(r2), address(usdg), 100e18, address(stock2), 200e18, cd), 200e18);
        assertEq(usdg.allowance(address(t2), address(r2)), 0, "approval revoked after the swap");
    }

    /**
     * A basket paid in a stock rather than ether, all the way through.
     *
     * pons approves seventeen pair tokens beyond ether and USDG, and a launch paired against one of
     * them pays its creator fees in that token — so a fifth of launches arrive here as an ERC20.
     * Each half was covered on its own; this is the join, which is where a quote asset that is not
     * ether would actually go wrong: harvest measures a token balance instead of an ether one, the
     * platform fee is a transfer rather than a send, and only then does the stock get bought and
     * handed out.
     */
    function test_Erc20QuoteFullCycle() public {
        MockERC20 pair = new MockERC20("AAPL-pair");
        MockRouter r2 = new MockRouter(pair, stock2);
        factory.setVenue(address(r2), true);
        factory.setPlatformFee(1000, address(0xFEE)); // the service's 10%

        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 2000); // creator keeps 20%
        cfg.quote = address(pair);
        cfg.basket = new address[](1);
        cfg.basket[0] = address(stock2);
        IndexTreasury t2 = IndexTreasury(payable(_create(cfg, bytes32(uint256(77)))));

        // 1. harvest: the fee arrives as a token, and the split is measured on the token balance
        _fund(address(coin), address(pair), 100e18, 0);
        assertEq(t2.harvest(), 100e18, "harvest must measure the ERC20 delta");
        assertEq(pair.balanceOf(address(0xFEE)), 10e18, "platform fee paid in the quote token");
        assertEq(t2.creatorClaimable(), 18e18, "creator keeps 20% of what is left after the fee");
        assertEq(t2.spendableQuote(), 72e18, "the creator's share is not spendable");

        // 2. buy: only the spendable part may be sold, and only for a basket token
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(72e18));
        vm.prank(KEEPER);
        // the mock fills at 2x, so 72 in becomes 144 of stock
        assertEq(t2.swap(address(r2), address(pair), 72e18, address(stock2), 100e18, cd), 144e18);
        assertEq(pair.allowance(address(t2), address(r2)), 0, "approval revoked");

        // 3. distribute: unaffected by which asset paid for it
        vm.warp(vm.getBlockTimestamp() + 901);
        vm.prank(KEEPER);
        uint256 sent = t2.distribute(0, _holders());
        assertEq(sent, 144e18, "the whole buy went out");
        assertEq(
            stock2.balanceOf(H1) + stock2.balanceOf(H2) + stock2.balanceOf(H3),
            144e18,
            "and it reached the holders"
        );

        // 4. and the creator can still take theirs, in the token the fees arrived in
        uint256 before = pair.balanceOf(OWNER); // creator defaults to the owner
        t2.claimCreator();
        assertEq(pair.balanceOf(OWNER) - before, 18e18, "creator paid in the quote token");
    }

    // ------------------------------------------------------ the launchpad registry itself

    /// A second launchpad is a factory write, not a new implementation — the whole point of keeping
    /// the registries in config and only the collection SHAPES in code.
    function test_ASecondLaunchpadIsRegisteredNotShipped() public {
        MockStonkLocker second = new MockStonkLocker();
        factory.setLaunchpad(7, address(second), KIND_CREATOR_LOCKER, true);

        MockERC20 c2 = new MockERC20("TWO");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(77)));
        second.set(address(c2), predicted, address(weth));

        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(77)), predicted)));
        assertEq(t2.coin(), address(c2), "bound through the second launchpad");
        assertEq(t2.launchpad(), 7, "and it remembers WHICH one");
    }

    /// Disabling closes a launchpad to new baskets. It must not strand the ones already collecting.
    function test_DisablingALaunchpadStopsNewBindsAndNotOldOnes() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        factory.setLaunchpad(LAUNCHPAD_STONKS, address(locker), KIND_CREATOR_LOCKER, false);

        // the already-bound treasury keeps harvesting
        assertEq(tr.harvest(), 1 ether, "a bound treasury must survive its launchpad being closed");

        // a new one cannot bind
        MockERC20 c2 = new MockERC20("LATE");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(78)));
        locker.set(address(c2), predicted, address(weth));
        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(78)), predicted);
    }

    /// A registry that answers for nobody is skipped rather than blowing up the loop, so one dead
    /// launchpad cannot take binding down for every other.
    function test_ADeadRegistryDoesNotBreakBinding() public {
        factory.setLaunchpad(9, address(pool), KIND_CREATOR_LOCKER, true); // has code, answers nothing

        MockERC20 c2 = new MockERC20("STILL");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(79)));
        locker.set(address(c2), predicted, address(weth));
        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(79)), predicted)));
        assertEq(t2.launchpad(), LAUNCHPAD_STONKS, "the live launchpad still answered");
    }

    // ------------------------------------------------------ what the locker actually pays

    /// The coin leg is burned, not kept: a treasury that buys equity has no use for the coin it is
    /// paid in, and holding it would make the basket a holder of its own launch.
    function test_HarvestBurnsTheCoinSide() public {
        _fund(address(coin), address(weth), 1 ether, 40e18);
        uint256 burnedBefore = coin.balanceOf(0x000000000000000000000000000000000000dEaD);

        assertEq(tr.harvest(), 1 ether, "only the quote leg counts as received");
        assertEq(
            coin.balanceOf(0x000000000000000000000000000000000000dEaD) - burnedBefore, 40e18, "coin leg burned"
        );
        assertEq(coin.balanceOf(address(tr)), 0, "and none of it kept");
    }

    /// The locker defers a payout it cannot deliver instead of reverting the collect. Harvest has to
    /// sweep that, or the fees sit in the locker's ledger forever and every round looks empty.
    function test_HarvestSweepsADeferredPayout() public {
        locker.setDefer(true);
        _fund(address(coin), address(weth), 1 ether, 0);

        // collectAll credits `claimable` rather than paying; only the claim behind it gets the money
        assertEq(tr.harvest(), 1 ether, "a deferred payout must still reach the treasury");
        assertEq(locker.claimable(address(tr), address(weth)), 0, "and the ledger is emptied");
    }

    /// A collect that reverts must not take the harvest with it: anything already deferred stays
    /// reachable through the claims behind it.
    function test_HarvestStillSweepsWhenCollectingReverts() public {
        locker.setDefer(true);
        _fund(address(coin), address(weth), 1 ether, 0);
        locker.collectAll(address(coin)); // credits claimable
        locker.setCollectReverts(true); // now the collect leg fails

        assertEq(tr.harvest(), 1 ether, "the claim behind the failed collect must still run");
    }

    /// The locker pays WETH for an ETH-quoted launch and never sends ether. Left wrapped, the delta
    /// reads zero: no platform fee, no creator share, and a swap would hand the whole of it away.
    function test_WrappedFeesAreUnwrappedForANativeQuotedBasket() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        uint256 before = address(tr).balance;

        assertEq(tr.harvest(), 1 ether, "measured in ether, not in WETH");
        assertEq(address(tr).balance - before, 1 ether, "and actually unwrapped");
        assertEq(weth.balanceOf(address(tr)), 0, "nothing left wrapped");
    }

    /// A native-quoted basket ends every harvest holding ether and no WETH: the watermark counts the
    /// two as one balance, so leaving a tail wrapped would mean money the books had already split
    /// against sitting in a form the fee and the creator's claim cannot be paid from.
    function test_HarvestLeavesNothingWrappedOnANativeQuote() public {
        vm.deal(address(tr), 5 ether);
        vm.prank(address(tr));
        weth.deposit{value: 2 ether}();

        _fund(address(coin), address(weth), 1 ether, 0);
        assertEq(tr.harvest(), 6 ether, "everything unaccounted is harvested, however it arrived");
        assertEq(weth.balanceOf(address(tr)), 0, "nothing left wrapped");
        assertEq(address(tr).balance, 6 ether, "and all of it spendable as ether");
    }

    /**
     * The locker's `collectAll` is permissionless, so anyone can push a treasury's fees in outside a
     * harvest. Measuring a delta across our own collect meant those fees escaped the platform fee
     * and the creator's share entirely — for free, repeatably, by a stranger.
     */
    function test_FeesPushedInByAStrangerAreStillSplit() public {
        factory.setPlatformFee(1000, address(0xFEE));
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 2000); // creator keeps 20%
        IndexTreasury t2 = IndexTreasury(payable(_create(cfg, bytes32(uint256(95)))));
        _fund(t2.coin(), address(weth), 1 ether, 0);

        // a stranger cranks the locker directly; no harvest involved
        vm.prank(OUTSIDER);
        locker.collectAll(t2.coin());
        assertEq(weth.balanceOf(address(t2)), 1 ether, "the fees are already in the treasury");

        // the harvest that follows must still take both cuts off them
        assertEq(t2.harvest(), 1 ether, "unaccounted quote counts however it arrived");
        // native quote: harvest unwraps, so the fee leaves as ether, not as WETH
        assertEq(address(0xFEE).balance, 0.1 ether, "platform fee taken");
        assertEq(t2.creatorClaimable(), 0.18 ether, "creator's share accrued");
        assertEq(t2.spendableQuote(), 0.72 ether, "and only the rest is the holders'");
    }

    /// Harvesting twice must not split the same money twice.
    function test_WatermarkIsNotDoubleCounted() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        assertEq(tr.harvest(), 1 ether);
        assertEq(tr.harvest(), 0, "nothing new arrived");
    }

    // ------------------------------------------------------ bind, against the real locker shape

    /// A coin the locker knows but holds no position for would harvest nothing, forever, silently.
    function test_BindRefusesACoinWithNoPositions() public {
        MockERC20 c2 = new MockERC20("EMPTY");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(80)));
        locker.set(address(c2), predicted, address(weth));
        locker.setNoPositions(address(c2));

        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(80)), predicted);
    }

    /// A basket quoted in an asset the locker will not pay would see a zero delta on every harvest.
    function test_BindRefusesAQuoteTheLockerWillNotPay() public {
        MockERC20 pair = new MockERC20("PAIR");
        MockERC20 c2 = new MockERC20("MISMATCH");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(81)));
        locker.set(address(c2), predicted, address(pair)); // launched against PAIR

        IndexFactory.IndexConfig memory cfg = _cfg(address(c2), 0);
        cfg.quote = address(stock2); // but quoted in something else entirely
        vm.expectRevert(
            abi.encodeWithSelector(IndexTreasury.QuoteMismatch.selector, address(pair), address(stock2))
        );
        factory.createIndex(cfg, bytes32(uint256(81)), predicted);
    }

    /// Native and WETH are one asset here, so a WETH-paired launch may be quoted as either.
    function test_BindAcceptsEitherFaceOfWeth() public {
        MockERC20 c2 = new MockERC20("WETHPAIR");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(82)));
        locker.set(address(c2), predicted, address(weth));

        IndexFactory.IndexConfig memory cfg = _cfg(address(c2), 0);
        cfg.quote = address(weth); // the wrapped face, against a WETH-paired launch
        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(cfg, bytes32(uint256(82)), predicted)));
        assertEq(t2.coin(), address(c2), "WETH quote against a WETH pair must bind");
    }

    // ------------------------------------------------------ the venue allowlist

    /// The keeper picks the venue, but only from the set the factory allows — and revoking one takes
    /// it away from every treasury at once, without touching any of them.
    function test_SwapRefusesAVenueTheFactoryHasNotAllowed() public {
        MockRouter rogue = new MockRouter(MockERC20(address(weth)), stock);
        _fund(address(coin), address(weth), 1 ether, 0);
        tr.harvest();

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.VenueNotAllowed.selector, address(rogue)));
        tr.swap(address(rogue), address(0), 0.5 ether, address(stock), 1, abi.encodeWithSelector(MockRouter.settle.selector, 0.5 ether));
    }

    /// Revocation is immediate and needs no cooperation from the treasury.
    function test_RevokingAVenueStopsEveryTreasuryAtOnce() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        tr.harvest();
        factory.setVenue(address(router), false);

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.VenueNotAllowed.selector, address(router)));
        tr.swap(address(router), address(0), 0.5 ether, address(stock), 1, abi.encodeWithSelector(MockRouter.settle.selector, 0.5 ether));
    }

    // ------------------------------------------------------ buyback and burn

    /// A buyback treasury: no basket, no holder list, no rounds. Fees buy the coin and destroy it.
    function _buyback(bytes32 salt) internal returns (IndexTreasury t2, MockERC20 c2, MockRouter r2) {
        c2 = new MockERC20("BUYBACK");
        r2 = new MockRouter(MockERC20(address(weth)), c2); // sells WETH, delivers the coin
        factory.setVenue(address(r2), true);

        IndexFactory.IndexConfig memory cfg = _cfg(address(0), 0);
        cfg.mode = 1; // MODE_BUYBACK_BURN
        cfg.basket = new address[](0);
        cfg.weights = new uint16[](0);

        address predicted = factory.predictAddress(address(this), salt);
        locker.set(address(c2), predicted, address(weth));
        t2 = IndexTreasury(payable(factory.createIndex(cfg, salt, predicted)));
        vm.prank(KEEPER);
        t2.bind(address(c2));
    }

    function test_BuybackBuysTheCoinAndBurnsIt() public {
        (IndexTreasury t2, MockERC20 c2, MockRouter r2) = _buyback(bytes32(uint256(90)));
        _fund(address(c2), address(weth), 1 ether, 0);
        assertEq(t2.harvest(), 1 ether);

        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        assertEq(t2.swap(address(r2), address(weth), 1 ether, address(c2), 1, cd), 2 ether, "bought the coin");

        uint256 deadBefore = c2.balanceOf(0x000000000000000000000000000000000000dEaD);
        assertEq(t2.burn(), 2 ether, "and destroyed all of it");
        assertEq(c2.balanceOf(0x000000000000000000000000000000000000dEaD) - deadBefore, 2 ether);
        assertEq(c2.balanceOf(address(t2)), 0, "nothing kept");
    }

    /// The mode fixes what may be bought. A buyback treasury cannot be steered into buying equity.
    function test_BuybackCannotBuyAnythingButTheCoin() public {
        (IndexTreasury t2,, MockRouter r2) = _buyback(bytes32(uint256(91)));
        _fund(t2.coin(), address(weth), 1 ether, 0);
        t2.harvest();

        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NotInBasket.selector);
        t2.swap(address(r2), address(weth), 1 ether, address(stock), 1, "");
    }

    /// And a distributing treasury cannot be steered into buying its own coin.
    function test_DistributeModeCannotBuyTheCoin() public {
        _fund(address(coin), address(weth), 1 ether, 0);
        tr.harvest();
        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.NotInBasket.selector);
        tr.swap(address(router), address(weth), 1 ether, address(coin), 1, "");
    }

    /// Burning is permissionless: one destination, nothing to steer, and no holder's share moves
    /// relative to any other's — so there is nothing to gain by choosing the moment.
    function test_BurnIsPermissionless() public {
        (IndexTreasury t2, MockERC20 c2, MockRouter r2) = _buyback(bytes32(uint256(92)));
        _fund(address(c2), address(weth), 1 ether, 0);
        t2.harvest();
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        t2.swap(address(r2), address(weth), 1 ether, address(c2), 1, cd);

        vm.prank(OUTSIDER);
        assertEq(t2.burn(), 2 ether, "anyone may destroy what the treasury bought back");
    }

    /// A buyback treasury has no basket to configure, and a wizard that sends one is a wizard bug.
    function test_BuybackRefusesABasket() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(0), 0);
        cfg.mode = 1; // still carrying a basket from the distribute path
        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(93)), address(0));
    }

    /// The coin leg of the FEES is burned in every mode — that is harvest's job, not the mode's.
    function test_FeeCoinLegIsBurnedInBuybackModeToo() public {
        (IndexTreasury t2, MockERC20 c2,) = _buyback(bytes32(uint256(94)));
        _fund(address(c2), address(weth), 1 ether, 40e18);
        uint256 deadBefore = c2.balanceOf(0x000000000000000000000000000000000000dEaD);

        assertEq(t2.harvest(), 1 ether, "only the quote leg is received");
        assertEq(c2.balanceOf(0x000000000000000000000000000000000000dEaD) - deadBefore, 40e18, "coin leg burned");
    }

    // ------------------------------------------------------ the two ways a coin can be bound

    /**
     * The real launch path. `StonkLauncher2` passes the treasury as `register`'s `feeRecipient`, and
     * the locker files that as a SPLIT while the launching wallet keeps the creator role. Binding on
     * the role alone could therefore never succeed on a coin launched normally — which is exactly
     * what the first version of this contract got wrong.
     */
    function test_BindsOnTheSplitALaunchActuallyCreates() public {
        MockERC20 c2 = new MockERC20("LAUNCHED");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(200)));
        locker.launch(address(c2), OWNER, address(weth), predicted); // OWNER keeps the role

        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(200)), predicted)));
        assertEq(t2.coin(), address(c2), "a normally launched coin must bind");
        assertEq(locker.tokenCreator(address(c2)), OWNER, "and the wallet still holds the role");
        assertFalse(t2.bindIsPermanent(), "so the promise is revocable, and says so");
    }

    /// And the fees really do arrive, which is the point of binding on the payer rather than the role.
    function test_ASplitBoundTreasuryActuallyCollects() public {
        MockERC20 c2 = new MockERC20("LAUNCHED");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(201)));
        locker.launch(address(c2), OWNER, address(weth), predicted);
        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(201)), predicted)));

        _fund(address(c2), address(weth), 1 ether, 0);
        assertEq(t2.harvest(), 1 ether, "the split pays the treasury");
    }

    /// After the ceremony the role IS the treasury and the split is gone — the permanent case.
    function test_BindsOnTheRoleAndSaysItIsPermanent() public {
        MockERC20 c2 = new MockERC20("CEREMONY");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(202)));
        locker.set(address(c2), predicted, address(weth)); // role moved, split cleared

        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(202)), predicted)));
        assertTrue(t2.bindIsPermanent(), "nothing but the locker's owner can move this one");
    }

    /// A split naming somebody else is not this treasury's coin, whoever holds the role.
    function test_BindRefusesASplitPointedElsewhere() public {
        MockERC20 c2 = new MockERC20("OTHER");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(203)));
        locker.launch(address(c2), predicted, address(weth), address(0xBEEF11));

        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(203)), predicted);
    }

    /// Holding the ROLE while a split points away means the locker pays somebody else. Binding on
    /// the role alone would have called that a success and then harvested nothing, forever.
    function test_BindRefusesTheRoleWhenASplitOverridesIt() public {
        MockERC20 c2 = new MockERC20("OVERRIDDEN");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(204)));
        locker.set(address(c2), predicted, address(weth)); // treasury holds the role
        locker.setCreatorSplit(address(c2), address(0xBEEF22)); // but a split takes the money

        vm.expectRevert(IndexTreasury.NotFeeRecipient.selector);
        factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(204)), predicted);
    }

    // ------------------------------------------------------ what outsiders and owners cannot do

    /// The owner cannot take the buyback. It used to be fenced by nothing: a buyback has no basket,
    /// so `_inBasket(coin)` was false and the coin was rescuable out from under the burn.
    function test_NobodyCanRescueTheBuyback() public {
        (IndexTreasury t2, MockERC20 c2, MockRouter r2) = _buyback(bytes32(uint256(205)));
        _fund(address(c2), address(weth), 1 ether, 0);
        t2.harvest();
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, uint256(1 ether));
        vm.prank(KEEPER);
        t2.swap(address(r2), address(weth), 1 ether, address(c2), 1, cd);

        vm.prank(KEEPER);
        vm.expectRevert(IndexTreasury.ProtectedAsset.selector);
        t2.rescueERC20(address(c2), OWNER, 2 ether);
    }

    /// A distribute treasury normally holds no coin — `harvest` burned the fee leg — so there is
    /// nothing to destroy and the call says exactly that.
    function test_BurnInDistributeModeHasNothingToDo() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NothingToBurn.selector);
        tr.burn();
    }

    /// But when the fee leg's burn FAILED — a coin with a transfer restriction — the coin sits here
    /// with every other exit shut. Burning has to stay available in both modes, or it is frozen for
    /// good, including after the restriction is lifted.
    function test_BurnRecoversAFeeLegThatCouldNotBeBurned() public {
        coin.mint(address(tr), 40e18); // stands in for a fee leg harvest could not push to dEaD
        uint256 deadBefore = coin.balanceOf(0x000000000000000000000000000000000000dEaD);

        vm.prank(OUTSIDER);
        assertEq(tr.burn(), 40e18, "the retry path must exist in distribute mode too");
        assertEq(coin.balanceOf(0x000000000000000000000000000000000000dEaD) - deadBefore, 40e18);
    }

    /// The door behind that one: a distribute basket may not contain the coin at all.
    function test_BindRefusesABasketHoldingTheCoin() public {
        MockERC20 c2 = new MockERC20("SELFISH");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(206)));
        locker.launch(address(c2), OWNER, address(weth), predicted);

        IndexFactory.IndexConfig memory cfg = _cfg(address(c2), 0);
        cfg.basket = new address[](1);
        cfg.basket[0] = address(c2); // the coin, as its own basket entry
        uint16[] memory w = new uint16[](1);
        w[0] = 10_000;
        cfg.weights = w;

        vm.expectRevert(IndexTreasury.BadConfig.selector);
        factory.createIndex(cfg, bytes32(uint256(206)), predicted);
    }

    // ------------------------------------------------------ the brick attack the gate exists for

    /**
     * The predicate moved from a value nobody can point at a victim (`tokenCreator`) to one the
     * coin's own creator writes freely (the split). That turned an open `bind()` into a brick
     * button: launch a junk coin, point its split at a stranger's unbound treasury, bind it there.
     * `coin` is write-once and there is no unbind, so the treasury is dead — and the factory
     * publishes the target list itself.
     */
    function test_AStrangerCannotBrickAnUnboundTreasury() public {
        address victim = factory.createIndex(_cfg(address(0), 0), bytes32(uint256(300)), address(0));
        assertEq(IndexTreasury(payable(victim)).coin(), address(0), "unbound, and therefore a target");

        // Mallory launches a junk coin and points its creator split at the victim's treasury
        MockERC20 junk = new MockERC20("JUNK");
        vm.prank(OUTSIDER);
        locker.launch(address(junk), OUTSIDER, address(weth), victim);
        assertEq(locker.splitsOf(address(junk))[0].to, victim, "the predicate would have matched");

        vm.prank(OUTSIDER);
        vm.expectRevert(IndexTreasury.NotKeeper.selector);
        IndexTreasury(payable(victim)).bind(address(junk));

        assertEq(IndexTreasury(payable(victim)).coin(), address(0), "still bindable to its real coin");
    }

    /// A creator who split their fees across several wallets gets a refusal they can act on, not
    /// "this coin is not yours".
    function test_ASpreadSplitIsRefusedWithItsOwnError() public {
        MockERC20 c2 = new MockERC20("SPREAD");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(301)));
        locker.launch(address(c2), OWNER, address(weth), predicted);
        locker.addSplit(address(c2), address(0xC01D), 4000); // creator keeps a slice on a cold wallet

        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.SplitNotWhole.selector, 2));
        factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(301)), predicted);
    }

    /// `bindIsPermanent` is a snapshot. The keeper needs to know when a split has been pointed away,
    /// or it cranks a treasury that no longer receives anything while the site says it is running.
    function test_LiveRecipientRevealsARevokedSplit() public {
        MockERC20 c2 = new MockERC20("REVOKED");
        address predicted = factory.predictAddress(address(this), bytes32(uint256(302)));
        locker.launch(address(c2), OWNER, address(weth), predicted);
        IndexTreasury t2 =
            IndexTreasury(payable(factory.createIndex(_cfg(address(c2), 0), bytes32(uint256(302)), predicted)));

        (address paid,) = t2.feeRecipientNow();
        assertEq(paid, address(t2), "collecting");

        // the creator takes the stream back — nothing calls the treasury when this happens
        vm.prank(OWNER);
        locker.setCreatorSplit(address(c2), OWNER);

        (paid,) = t2.feeRecipientNow();
        assertEq(paid, OWNER, "and the treasury can be asked, rather than assumed");
        assertEq(t2.coin(), address(c2), "while still reporting the coin it is bound to");
    }

    // ------------------------------------------------------ the fence, after the watermark

    /// Quote that has not been harvested is not spendable. It still owes the platform fee and the
    /// creator's share, and spending it drove the watermark under the creator's accrual — which the
    /// next harvest then read as fresh income and charged for a second time.
    function test_UnharvestedQuoteIsNotSpendable() public {
        vm.deal(address(tr), 5 ether); // arrived without a harvest
        assertEq(tr.spendableQuote(), 0, "not ours to spend until it has paid its cuts");

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(IndexTreasury.ExceedsAvailable.selector, 1 ether, 0));
        tr.swap(address(router), address(weth), 1 ether, address(stock), 1, "");
    }

    /// The invariant the whole design rests on: a treasury always holds at least what it owes.
    function test_TheCreatorFenceSurvivesAMaxSpendWithADonation() public {
        factory.setPlatformFee(1000, address(0xFEE));
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 2000);
        IndexTreasury t2 = IndexTreasury(payable(_create(cfg, bytes32(uint256(400)))));

        _fund(t2.coin(), address(weth), 1 ether, 0);
        t2.harvest(); // 0.1 fee, 0.18 to the creator, 0.72 to holders
        vm.deal(address(t2), address(t2).balance + 1 ether); // a stranger donates, unharvested

        uint256 spendable = t2.spendableQuote();
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, spendable);
        vm.prank(KEEPER);
        t2.swap(address(router), address(weth), spendable, address(stock), 1, cd);

        assertGe(address(t2).balance, t2.creatorClaimable(), "the fence must hold after a max spend");

        // and the donation must not be re-split against what the creator is already owed
        uint256 owedBefore = t2.creatorClaimable();
        t2.harvest();
        assertGe(address(t2).balance, t2.creatorClaimable(), "still holds what it owes");
        assertGe(t2.creatorClaimable(), owedBefore, "the accrual only ever grows");
    }

    /// Ten wei from a stranger used to make `claimCreator` revert forever: the swap drove the
    /// watermark down, the next harvest inflated the accrual past the balance, and the payment
    /// could never settle again.
    function test_ADustDonationCannotBrickTheCreatorsClaim() public {
        IndexFactory.IndexConfig memory cfg = _cfg(address(coin), 2000);
        IndexTreasury t2 = IndexTreasury(payable(_create(cfg, bytes32(uint256(401)))));

        _fund(t2.coin(), address(weth), 1 ether, 0);
        t2.harvest();
        vm.deal(address(t2), address(t2).balance + 10); // the dust

        uint256 spendable = t2.spendableQuote();
        bytes memory cd = abi.encodeWithSelector(MockRouter.settle.selector, spendable);
        vm.prank(KEEPER);
        t2.swap(address(router), address(weth), spendable, address(stock), 1, cd);
        t2.harvest();

        uint256 owed = t2.creatorClaimable();
        assertGt(owed, 0, "the creator is owed something");
        assertEq(t2.claimCreator(), owed, "and can always be paid it");
    }
}
