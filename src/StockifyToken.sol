// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Stockify
/// @notice Fixed-supply STFY with an on-chain registry of dividend-eligible holders.
/// @dev This is the same holder-registry model used by the reference implementation this derives
/// from (theindex.finance, on Robinhood Chain): the dividend receiver can enumerate `holderAt(i)`
/// without relying on an off-chain explorer. The registry is updated after every mint, burn, or
/// transfer. It deliberately uses a minimum balance so dust does not turn every payout snapshot
/// into an unbounded-gas operation.
contract StockifyToken is ERC20, Ownable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant MIN_SHARE_BALANCE_FLOOR = 10_000e18;
    uint256 public constant MIN_SHARE_BALANCE_CEILING = 100_000e18;

    /// @notice Minimum STFY balance required to appear in the on-chain dividend registry.
    /// @dev Starts at 100,000 STFY and is configurable by owner only in the 10,000–100,000 range.
    uint256 public minShareBalance = MIN_SHARE_BALANCE_CEILING;

    /// @notice Owner-controlled exclusion from the dividend registry, as in the reference implementation.
    mapping(address => bool) public rewardsExcluded;

    address[] private _holders;
    /// @dev One-indexed so zero means "not registered" and removal is O(1) using swap-and-pop.
    mapping(address => uint256) private _holderIndexPlusOne;

    event MinShareBalanceSet(uint256 previous, uint256 current);
    event RewardsExcludedSet(address indexed account, bool excluded);
    event HolderAdded(address indexed account);
    event HolderRemoved(address indexed account);

    error ZeroAddress();
    error InvalidMinShareBalance(uint256 amount);

    constructor(address initialHolder, address owner_) ERC20("Stockify", "STFY") Ownable(owner_) {
        if (initialHolder == address(0) || owner_ == address(0)) revert ZeroAddress();
        _mint(initialHolder, TOTAL_SUPPLY);
    }

    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return _holders[index];
    }

    function setMinShareBalance(uint256 amount) external onlyOwner {
        if (amount < MIN_SHARE_BALANCE_FLOOR || amount > MIN_SHARE_BALANCE_CEILING) {
            revert InvalidMinShareBalance(amount);
        }
        emit MinShareBalanceSet(minShareBalance, amount);
        minShareBalance = amount;
    }

    function setRewardsExcluded(address account, bool excluded) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        rewardsExcluded[account] = excluded;
        _syncHolder(account);
        emit RewardsExcludedSet(account, excluded);
    }

    /// @dev A threshold change cannot enumerate every historic ERC-20 owner. It is therefore
    /// reflected for an account when that account transfers, or when the owner explicitly changes
    /// its reward-exclusion status — matching the operational model of the reference implementation.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        _syncHolder(from);
        if (to != from) _syncHolder(to);
    }

    function _syncHolder(address account) private {
        if (account == address(0)) return;

        bool shouldBeRegistered = !rewardsExcluded[account] && balanceOf(account) >= minShareBalance;
        bool registered = _holderIndexPlusOne[account] != 0;
        if (shouldBeRegistered == registered) return;

        if (shouldBeRegistered) {
            _holders.push(account);
            _holderIndexPlusOne[account] = _holders.length;
            emit HolderAdded(account);
            return;
        }

        uint256 index = _holderIndexPlusOne[account] - 1;
        uint256 lastIndex = _holders.length - 1;
        if (index != lastIndex) {
            address lastHolder = _holders[lastIndex];
            _holders[index] = lastHolder;
            _holderIndexPlusOne[lastHolder] = index + 1;
        }
        _holders.pop();
        delete _holderIndexPlusOne[account];
        emit HolderRemoved(account);
    }
}
