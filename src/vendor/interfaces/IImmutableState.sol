// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @title IImmutableState
/// @notice Interface for the ImmutableState contract
/// @dev Vendored verbatim from v4-periphery @ the commit The Index deployed against, because
///      utils/BaseHook.sol was relocated in later v4-periphery releases. Keeping it local pins the
///      exact hook base The Index's verified IndexFeeHook compiled with.
interface IImmutableState {
    /// @notice The Uniswap v4 PoolManager contract
    function poolManager() external view returns (IPoolManager);
}
