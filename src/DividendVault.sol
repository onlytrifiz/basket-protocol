// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IBasketToken is IERC20 {
    function totalSupply() external view returns (uint256);
    function holderCount() external view returns (uint256);
    function holderAt(uint256 index) external view returns (address);
}

/// @title DividendVault
/// @notice Receives Basket v4 hook fees, buys the owner-configurable B20 basket, then directly pushes stocks to
/// the BasketToken on-chain holder registry once per hour.
/// @dev The snapshot and payout are batched, so the keeper never submits an off-chain recipient
/// list. Snapshot weight is limited to live balance on payout to prevent a flash-borrowed balance
/// from receiving a dividend after it has been returned.
contract DividendVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant PLATFORM_FEE_BPS = 1_000; // 10% of each hook-fee allocation.
    uint256 public constant HOOK_FEE_BPS = 300; // 3% of pool volume, for integrators.
    uint256 public constant DISTRIBUTION_INTERVAL = 1 hours;

    /// @dev Official Base v4 Universal Router at deployment time. See Deploy.s.sol for its source.
    address public immutable universalRouter;
    IBasketToken public immutable basketToken;

    struct Stock {
        address token;
        uint16 weightBps;
    }

    /// @dev Active buy basket, configured by the owner multisig.
    Stock[] private _stocks;
    /// @dev Every asset ever admitted to a basket. Removed assets stay in this set so already-bought
    /// balances and failed payouts remain distributable instead of becoming stranded.
    address[] private _distributionStocks;
    mapping(address => bool) public isStock;
    mapping(address => bool) public isDistributionStock;
    mapping(address => bool) public keeper;

    /// @dev These infrastructure addresses are defensively skipped if ever present in the token
    /// registry. BasketToken additionally excludes them through `rewardsExcluded` at deployment.
    mapping(address => bool) public excluded;
    address[] private _excludedAccounts;

    // A snapshot word is `(balance << 160) | uint160(holder)`. The 1B BASKET fixed supply fits in
    // 96 bits, so one storage word carries both holder and weight.
    uint256[] private _snapshot;
    address[] private _cycleStocks;
    uint256[] private _cyclePots;
    uint256 public eligibleSupply;
    uint256 public cursor;
    uint256 public snapshotCursor;
    uint256 public nextDistribution;
    bool public snapshotPending;
    bool public cycleActive;
    mapping(address => uint256) private _seenEpoch;
    uint256 private _snapshotEpoch;

    /// @notice Exact failed B20 transfers, retained for the rightful holder and never redivided.
    mapping(address => mapping(address => uint256)) public unpaidDividend;
    mapping(address => uint256) public unpaidTotal;

    /// ETH accrued to the protocol and excluded from stock purchases. It is the 10% share of hook
    /// fees allocated to each buy.
    uint256 public platformClaimable;
    address public platformRecipient;
    uint256 public maxGrossSpendPerCycle;

    event KeeperSet(address indexed account, bool allowed);
    event ExcludedSet(address indexed account, bool excluded);
    event PlatformRecipientSet(address indexed previous, address indexed current);
    event MaxGrossSpendPerCycleSet(uint256 amount);
    event StocksBought(uint256 grossEth, uint256 platformFee, uint256 stockEth);
    event StockBought(address indexed stock, uint256 ethSpent, uint256 received);
    event BasketConfigured(uint256 indexed stockCount);
    event DistributionStockRegistered(address indexed stock);
    event PlatformClaimed(address indexed recipient, uint256 amount);
    event EmergencyERC20Withdrawn(address indexed token, address indexed owner, uint256 amount);
    event HoldersSnapshotted(uint256 indexed captured, uint256 indexed registrySize, uint256 eligibleSupply);
    event DistributionCycleStarted(uint256 holderCount, uint256 eligibleSupply, uint256 stockCount);
    event DistributionBatchPaid(uint256 indexed from, uint256 indexed to);
    event DistributionCycleCompleted(uint256 holderCount);
    event PayoutSkipped(address indexed stock, address indexed holder, uint256 amount);
    event CycleAborted(uint256 cursor, uint256 holderCount);
    event UnpaidDividendFlushed(address indexed stock, address indexed holder, uint256 amount);

    error OnlyKeeper();
    error ZeroAddress();
    error InvalidBasket();
    error RouterCallFailed();
    error InsufficientOutput(address stock, uint256 got, uint256 minimum);
    error InsufficientEth(uint256 wanted, uint256 available);
    error TooSoon(uint256 readyAt);
    error CycleInProgress();
    error NoCycle();
    error SnapshotIncomplete();
    error NoDistributionWork();
    error NoEligibleSupply();
    error InvalidBatchSize();
    error ProtectedExclusion();
    error EthTransferFailed();
    error NothingToClaim();
    error NotPlatformRecipient();
    error NoEmergencyBalance(address token);
    error ConfigDuringCycle();

    modifier onlyKeeper() {
        if (!keeper[msg.sender]) revert OnlyKeeper();
        _;
    }

    constructor(
        address basketToken_,
        address universalRouter_,
        address owner_,
        address platformRecipient_,
        address poolManager_,
        address[] memory stocks_,
        uint16[] memory weights_
    ) Ownable(owner_) {
        if (
            basketToken_ == address(0) || universalRouter_ == address(0) || owner_ == address(0)
                || platformRecipient_ == address(0) || poolManager_ == address(0)
        ) revert ZeroAddress();
        if (basketToken_.code.length == 0 || universalRouter_.code.length == 0 || poolManager_.code.length == 0) {
            revert InvalidBasket();
        }
        basketToken = IBasketToken(basketToken_);
        universalRouter = universalRouter_;
        platformRecipient = platformRecipient_;
        _setBasket(stocks_, weights_);

        _setExcluded(poolManager_, true);
        _setExcluded(address(this), true);
        _setExcluded(address(0), true);
        _setExcluded(0x000000000000000000000000000000000000dEaD, true);
    }

    receive() external payable {}

    function stocksLength() external view returns (uint256) {
        return _stocks.length;
    }

    function stockAt(uint256 index) external view returns (address token, uint16 weightBps) {
        Stock memory stock = _stocks[index];
        return (stock.token, stock.weightBps);
    }

    function distributionStocksLength() external view returns (uint256) {
        return _distributionStocks.length;
    }

    function distributionStockAt(uint256 index) external view returns (address) {
        return _distributionStocks[index];
    }

    function snapshotLength() external view returns (uint256) {
        return _snapshot.length;
    }

    function snapshotRemaining() external view returns (uint256) {
        uint256 registrySize = basketToken.holderCount();
        uint256 captured = snapshotPending ? snapshotCursor : 0;
        return registrySize > captured ? registrySize - captured : 0;
    }

    function distributionRemaining() external view returns (uint256) {
        return cycleActive ? _snapshot.length - cursor : 0;
    }

    function availableEth() public view returns (uint256) {
        uint256 balance = address(this).balance;
        return balance > platformClaimable ? balance - platformClaimable : 0;
    }

    /// @notice Buys every configured stock through the immutable Base Universal Router.
    /// @param minOuts Minimum token units received, ordered as the configured stock basket.
    /// @param routerCalldatas Trading API calldata, ordered as the configured stock basket.
    function buyStocks(uint256[] calldata minOuts, bytes[] calldata routerCalldatas) external nonReentrant onlyKeeper {
        uint256 n = _stocks.length;
        if (minOuts.length != n || routerCalldatas.length != n) revert InvalidBasket();

        uint256 gross = availableEth();
        uint256 cap = maxGrossSpendPerCycle;
        if (cap != 0 && gross > cap) gross = cap;
        if (gross == 0) revert InsufficientEth(1, 0);

        uint256 protocolFee = (gross * PLATFORM_FEE_BPS) / BPS;
        uint256 stockBudget = gross - protocolFee;
        platformClaimable += protocolFee;

        uint256 totalSpent;
        for (uint256 i; i < n; ++i) {
            Stock memory stock = _stocks[i];
            uint256 spend = (stockBudget * stock.weightBps) / BPS;
            if (spend == 0) continue;
            if (minOuts[i] == 0) revert InvalidBasket();

            uint256 beforeBalance = IERC20(stock.token).balanceOf(address(this));
            (bool ok,) = universalRouter.call{value: spend}(routerCalldatas[i]);
            if (!ok) revert RouterCallFailed();

            uint256 received = IERC20(stock.token).balanceOf(address(this)) - beforeBalance;
            if (received < minOuts[i]) revert InsufficientOutput(stock.token, received, minOuts[i]);
            totalSpent += spend;
            emit StockBought(stock.token, spend, received);
        }

        emit StocksBought(gross, protocolFee, totalSpent);
    }

    /// @notice Capture up to `count` addresses from BasketToken's on-chain registry for this cycle.
    /// @dev The keeper is deliberately the only caller: it chooses a regular block for snapshotting,
    /// while payout additionally clamps the snapshot weight to the holder's live balance.
    function snapshotHolders(uint256 count) external nonReentrant onlyKeeper {
        if (cycleActive) revert CycleInProgress();
        if (block.timestamp < nextDistribution) revert TooSoon(nextDistribution);
        if (count == 0) revert InvalidBatchSize();

        if (!snapshotPending) {
            if (!_hasDistributionWork()) revert NoDistributionWork();
            delete _snapshot;
            delete _cycleStocks;
            delete _cyclePots;
            eligibleSupply = 0;
            snapshotCursor = 0;
            snapshotPending = true;
            unchecked {
                ++_snapshotEpoch;
            }
        }

        uint256 registrySize = basketToken.holderCount();
        uint256 end = snapshotCursor + count;
        if (end > registrySize) end = registrySize;
        uint256 eligible = eligibleSupply;
        uint256 epoch = _snapshotEpoch;

        for (uint256 i = snapshotCursor; i < end; ++i) {
            address holder = basketToken.holderAt(i);
            if (_seenEpoch[holder] == epoch) continue;
            _seenEpoch[holder] = epoch;
            if (excluded[holder]) continue;

            uint256 balance = basketToken.balanceOf(holder);
            if (balance == 0) continue;
            _snapshot.push((balance << 160) | uint256(uint160(holder)));
            eligible += balance;
        }

        eligibleSupply = eligible;
        if (end > snapshotCursor) snapshotCursor = end;
        emit HoldersSnapshotted(snapshotCursor, registrySize, eligible);
    }

    /// @notice Freeze the current stock pots and start a direct-payout cycle.
    /// @dev For a small registry the keeper may skip `snapshotHolders` and this function snapshots
    /// it in one transaction. Larger registries should always use the paginated method first.
    function startCycle() external nonReentrant onlyKeeper {
        if (cycleActive) revert CycleInProgress();
        if (block.timestamp < nextDistribution) revert TooSoon(nextDistribution);

        if (snapshotPending) {
            if (snapshotCursor < basketToken.holderCount()) revert SnapshotIncomplete();
            snapshotPending = false;
        } else {
            if (!_hasDistributionWork()) revert NoDistributionWork();
            delete _snapshot;
            delete _cycleStocks;
            delete _cyclePots;
            uint256 registrySize = basketToken.holderCount();
            uint256 eligible;
            for (uint256 i; i < registrySize; ++i) {
                address holder = basketToken.holderAt(i);
                if (excluded[holder]) continue;
                uint256 balance = basketToken.balanceOf(holder);
                if (balance == 0) continue;
                _snapshot.push((balance << 160) | uint256(uint160(holder)));
                eligible += balance;
            }
            eligibleSupply = eligible;
        }

        uint256 denominator = eligibleSupply;
        if (denominator == 0) revert NoEligibleSupply();

        uint256 n = _distributionStocks.length;
        for (uint256 i; i < n; ++i) {
            address stock = _distributionStocks[i];
            uint256 onHand = _safeBalanceOf(stock);
            uint256 owed = unpaidTotal[stock];
            uint256 pot = onHand > owed ? onHand - owed : 0;
            _cycleStocks.push(stock);
            _cyclePots.push(pot);
        }

        nextDistribution = block.timestamp + DISTRIBUTION_INTERVAL;
        cursor = 0;
        cycleActive = true;
        emit DistributionCycleStarted(_snapshot.length, denominator, n);
    }

    /// @notice Push dividends to the next `count` snapshotted holders.
    function distributeBatch(uint256 count) external nonReentrant onlyKeeper {
        if (!cycleActive) revert NoCycle();
        if (count == 0) revert InvalidBatchSize();

        uint256 from = cursor;
        uint256 end = from + count;
        uint256 snapshotSize = _snapshot.length;
        if (end > snapshotSize) end = snapshotSize;

        uint256 denominator = eligibleSupply;
        uint256 stockCount = _cycleStocks.length;
        address[] memory stocks = _cycleStocks;
        uint256[] memory pots = _cyclePots;

        for (uint256 i = from; i < end; ++i) {
            uint256 word = _snapshot[i];
            address holder = address(uint160(word));
            uint256 snapshotBalance = word >> 160;
            uint256 liveBalance = basketToken.balanceOf(holder);
            uint256 weight = liveBalance < snapshotBalance ? liveBalance : snapshotBalance;
            if (weight == 0) continue;

            for (uint256 j; j < stockCount; ++j) {
                address stock = stocks[j];
                uint256 newShare = (pots[j] * weight) / denominator;
                uint256 unpaid = unpaidDividend[stock][holder];
                uint256 due = unpaid + newShare;
                if (due == 0) continue;

                if (_tryTransfer(stock, holder, due)) {
                    if (unpaid != 0) {
                        unpaidDividend[stock][holder] = 0;
                        unpaidTotal[stock] -= unpaid;
                    }
                } else if (newShare != 0) {
                    unpaidDividend[stock][holder] = due;
                    unpaidTotal[stock] += newShare;
                    emit PayoutSkipped(stock, holder, due);
                }
            }
        }

        cursor = end;
        emit DistributionBatchPaid(from, end);
        if (end == snapshotSize) {
            cycleActive = false;
            emit DistributionCycleCompleted(snapshotSize);
        }
    }

    /// @notice Retry a rightful holder's failed B20 transfer, even if the holder is no longer in
    /// the registry. Anyone may call it; the funds can only go to that recorded holder.
    function flushUnpaidDividend(address holder, address stock) external nonReentrant {
        uint256 amount = unpaidDividend[stock][holder];
        if (amount == 0) return;
        if (_tryTransfer(stock, holder, amount)) {
            unpaidDividend[stock][holder] = 0;
            unpaidTotal[stock] -= amount;
            emit UnpaidDividendFlushed(stock, holder, amount);
        }
    }

    /// @notice Reset a stuck snapshot or cycle. No transfer occurs; unspent stock remains in the
    /// vault and is available for the next cycle.
    function abortCycle() external onlyOwner {
        uint256 previousCursor = cursor;
        uint256 previousHolders = _snapshot.length;
        delete _snapshot;
        delete _cycleStocks;
        delete _cyclePots;
        eligibleSupply = 0;
        cursor = 0;
        snapshotCursor = 0;
        snapshotPending = false;
        cycleActive = false;
        emit CycleAborted(previousCursor, previousHolders);
    }

    function setKeeper(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        keeper[account] = allowed;
        emit KeeperSet(account, allowed);
    }

    /// @notice Replace the buy basket and its weights atomically.
    /// @dev Removed assets remain in the distribution set forever: this function cannot make B20
    /// dividends already held by the vault withdrawable or otherwise stranded.
    function setBasket(address[] calldata stocks, uint16[] calldata weights) external onlyOwner {
        if (cycleActive || snapshotPending) revert ConfigDuringCycle();
        _setBasket(stocks, weights);
    }

    /// @dev Infrastructure-only backstop. Normal wallets are controlled through BasketToken's
    /// `rewardsExcluded`, which intentionally remains owner-configurable as requested.
    function setExcluded(address account, bool isExcluded) external onlyOwner {
        if (account == address(0) || account == 0x000000000000000000000000000000000000dEaD) {
            revert ProtectedExclusion();
        }
        if (account.code.length == 0) revert ProtectedExclusion();
        _setExcluded(account, isExcluded);
    }

    function setPlatformRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        emit PlatformRecipientSet(platformRecipient, recipient);
        platformRecipient = recipient;
    }

    function setMaxGrossSpendPerCycle(uint256 amount) external onlyOwner {
        maxGrossSpendPerCycle = amount;
        emit MaxGrossSpendPerCycleSet(amount);
    }

    function claimPlatform() external nonReentrant {
        if (msg.sender != platformRecipient) revert NotPlatformRecipient();
        uint256 amount = platformClaimable;
        if (amount == 0) revert NothingToClaim();
        platformClaimable = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit PlatformClaimed(msg.sender, amount);
    }

    /// @notice Emergency recovery for any ERC-20 custody, including B20 stock balances.
    /// @dev There is deliberately no corresponding ETH recovery. Funds always go to `owner()`,
    /// which must be a multisig at deployment. This is an explicit governance trust assumption.
    function emergencyWithdrawERC20(address token) external nonReentrant onlyOwner returns (uint256 amount) {
        if (token == address(0)) revert ZeroAddress();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NoEmergencyBalance(token);
        IERC20(token).safeTransfer(owner(), amount);
        emit EmergencyERC20Withdrawn(token, owner(), amount);
    }

    function _setExcluded(address account, bool isExcluded) private {
        if (excluded[account] == isExcluded) return;
        excluded[account] = isExcluded;
        if (isExcluded) _excludedAccounts.push(account);
        emit ExcludedSet(account, isExcluded);
    }

    function _hasDistributionWork() private view returns (bool) {
        uint256 n = _distributionStocks.length;
        for (uint256 i; i < n; ++i) {
            address stock = _distributionStocks[i];
            if (_safeBalanceOf(stock) > unpaidTotal[stock] || unpaidTotal[stock] != 0) return true;
        }
        return false;
    }

    function _isErc20(address token) private view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IERC20.totalSupply, ()));
        return ok && data.length >= 32;
    }

    function _setBasket(address[] memory stocks, uint16[] memory weights) private {
        if (stocks.length == 0 || stocks.length != weights.length) revert InvalidBasket();

        uint256 previousLength = _stocks.length;
        for (uint256 i; i < previousLength; ++i) {
            isStock[_stocks[i].token] = false;
        }
        delete _stocks;

        uint256 totalWeight;
        uint256 n = stocks.length;
        for (uint256 i; i < n; ++i) {
            address stock = stocks[i];
            if (stock == address(0) || stock == address(basketToken) || isStock[stock] || weights[i] == 0) {
                revert InvalidBasket();
            }
            // B20 assets are Base Rust precompiles. ERC-20 read compatibility is the required
            // capability; normal EVM bytecode is not assumed.
            if (!isDistributionStock[stock]) {
                if (!_isErc20(stock)) revert InvalidBasket();
                isDistributionStock[stock] = true;
                _distributionStocks.push(stock);
                emit DistributionStockRegistered(stock);
            }

            isStock[stock] = true;
            _stocks.push(Stock({token: stock, weightBps: weights[i]}));
            totalWeight += weights[i];
        }
        if (totalWeight != BPS) revert InvalidBasket();
        emit BasketConfigured(n);
    }

    function _safeBalanceOf(address token) private view returns (uint256 result) {
        bytes memory payload = abi.encodeCall(IERC20.balanceOf, (address(this)));
        assembly {
            let ok := staticcall(gas(), token, add(payload, 0x20), mload(payload), 0x00, 0x20)
            if and(ok, iszero(lt(returndatasize(), 32))) { result := mload(0x00) }
        }
    }

    /// @dev B20 receiver policies can reject an address. Treat a reverting, false, or malformed
    /// return as an individual failed payment so no one policy blocks the whole batch.
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool paid) {
        bytes memory payload = abi.encodeCall(IERC20.transfer, (to, amount));
        assembly {
            let ok := call(gas(), token, 0, add(payload, 0x20), mload(payload), 0x00, 0x20)
            let size := returndatasize()
            paid := and(ok, or(iszero(size), and(iszero(lt(size, 32)), iszero(iszero(mload(0x00))))))
        }
    }
}
