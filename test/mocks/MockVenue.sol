// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockStock} from "./MockStock.sol";
import {MockWETH} from "./MockWETH.sol";

/// An allowance-based venue in the shape the vault targets: it pulls exactly `amountIn` of WETH
/// from the caller and delivers the stock. `amountIn` is the first argument, so its byte offset
/// inside the calldata is 4 — the same offset Aerodrome's v2 router uses.
contract MockVenue {
    MockWETH public immutable weth;
    uint256 public rate = 10;

    constructor(MockWETH weth_) {
        weth = weth_;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    /// @dev amountIn sits at offset 4.
    function swapExactIn(uint256 amountIn, address tokenOut) external {
        IERC20(address(weth)).transferFrom(msg.sender, address(this), amountIn);
        MockStock(tokenOut).mint(msg.sender, amountIn * rate);
    }

    /// @dev A venue that consumes only part of the allowance, to prove the fee follows real spend.
    function swapPartial(uint256 amountIn, address tokenOut, uint256 useOnly) external {
        IERC20(address(weth)).transferFrom(msg.sender, address(this), useOnly);
        MockStock(tokenOut).mint(msg.sender, useOnly * rate);
        amountIn; // silence unused
    }
}
