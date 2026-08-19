// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice A throwaway fixed-supply ERC-20 for the ETH/TEST pool that exercises StockifyFeeHook in
/// production. It carries no registry, no owner and no dividend rights — it exists only so the hook
/// has a live pool with real liquidity that Uniswap can review, and so the fee path can be observed
/// end to end before the real ETH/STFY market is opened.
contract TestToken is ERC20 {
    constructor(address initialHolder, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _mint(initialHolder, 1_000_000_000e18);
    }
}
