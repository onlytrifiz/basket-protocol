// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Mock tokenized stock. `blocked[addr]` reverts transfers TO that address, to simulate a regulated
/// stock's allowlist/KYC gate — used to prove redeem() skips a blocked leg instead of bricking.
contract MockStock is ERC20 {
    mapping(address => bool) public blocked;
    bool public revertBal; // simulate a broken/upgraded token whose balanceOf reverts

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setBlocked(address a, bool on) external {
        blocked[a] = on;
    }

    function setRevertBalance(bool on) external {
        revertBal = on;
    }

    function balanceOf(address a) public view override returns (uint256) {
        require(!revertBal, "STOCK: balanceOf boom");
        return super.balanceOf(a);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "STOCK: recipient blocked");
        super._update(from, to, value);
    }
}
