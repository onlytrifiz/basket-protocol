// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IDividendVault {
    function abortCycle() external;
    function cursor() external view returns (uint256);
    function cycleActive() external view returns (bool);
    function owner() external view returns (address);
}

/// ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
/// │  VaultGuardian — owns DividendVault so one irreversible mistake cannot be made by reflex.    │
/// └─────────────────────────────────────────────────────────────────────────────────────────────┘
///
/// THE ONE THING IT STOPS. `DividendVault.abortCycle()` clears the snapshot, the cycle stocks and
/// the cursor without recording who has already been paid. Called after a `distributeBatch`, the
/// holders paid so far keep their share AND take a share of the next cycle, while the holders who
/// had not been reached yet divide only what is left. It is a silent transfer from the unpaid to the
/// paid, and nothing on-chain marks that it happened.
///
/// THE FIX IS NOT A NEW ABORT, IT IS KNOWING THAT ABORT IS NEVER THE ANSWER TO AN OPEN CYCLE. A
/// cycle can always be finished: `distributeBatch` cannot get permanently stuck, because a rejected
/// B20 transfer is recorded as unpaid rather than reverted, the STFY balance read cannot revert, and
/// the cursor advances regardless — so calling it until `cycleActive` goes false always terminates,
/// with `count = 1` if gas is tight. Abort exists for a stuck PENDING SNAPSHOT, where no payout has
/// happened and there is nothing to preserve. This contract is that sentence, enforced.
///
/// The vault is immutable and already deployed, so the check cannot live inside it. Ownership is the
/// only lever left: `Ownable.transferOwnership` moves the vault under this contract, and every owner
/// call then arrives through `execute`, which is where the guard sits.
///
/// A RAIL, NOT A PRISON — and it is worth being exact about which. The owner can still hand
/// ownership back to a wallet and call `abortCycle` directly; that is two deliberate transactions
/// against a revert that has just told them the cursor is not zero, rather than one reflex during an
/// incident. It is not claimed to be more than that. What it does make impossible is doing it by
/// accident, which is the only way it was ever going to happen.
///
/// `renounceOwnership` is refused outright, because that one has no deliberate version: a vault with
/// no owner can never rotate a keeper, replace the index or recover a stuck ERC-20 again.
///
/// WHAT MOVING OWNERSHIP CHANGES, and it must be understood before deploying this:
/// `emergencyWithdrawERC20` sends to `owner()`, which becomes THIS CONTRACT. The recovered tokens
/// land here and leave through `sweepERC20`. That is one extra hop, not a lost capability — but a
/// deployment that overlooked it would look like a vault whose emergency path had stopped working.
contract VaultGuardian {
    IDividendVault public immutable vault;

    /// Two-step, because a mistyped owner here is a vault nobody can configure again. The vault's
    /// own `Ownable` is single-step; this is the layer that can afford to be careful.
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previous, address indexed pending);
    event OwnershipTransferred(address indexed previous, address indexed current);
    event Executed(bytes4 indexed selector, bytes result);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    /// The cycle has already paid `cursor` holders. Finish it with `distributeBatch`; do not abort it.
    error CycleIsPartiallyPaid(uint256 cursor);
    /// An owner-less vault can never be reconfigured or recovered. There is no legitimate version.
    error RenounceRefused();
    error EmptyCall();
    error CallFailed(bytes reason);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address vault_, address owner_) {
        if (vault_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        vault = IDividendVault(vault_);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ------------------------------------------------------------------ forwarding

    /**
     * Make any owner call on the vault, subject to the two refusals above.
     *
     * Generic rather than one wrapper per function on purpose: the vault is deployed and its owner
     * surface is fixed, but a named wrapper for each of the nine would still have to be right about
     * nine signatures, and a missing one would be a capability silently lost behind this contract.
     * Forwarding raw calldata cannot lose a function that exists.
     *
     * The selector is read from the first four bytes and matched against the two calls that are not
     * allowed through. Everything else — `setKeeper`, `setIndex`, `setSwapTarget`, `setExcluded`,
     * `setPlatformRecipient`, `setMaxGrossSpendPerCycle`, `emergencyWithdrawERC20`,
     * `transferOwnership` — is passed straight down, and reverts from the vault bubble up with their
     * reason intact so an operator still sees the vault's own error rather than this one's.
     */
    function execute(bytes calldata data) external payable onlyOwner returns (bytes memory result) {
        if (data.length < 4) revert EmptyCall();
        bytes4 selector = bytes4(data[:4]);

        if (selector == IDividendVault.abortCycle.selector) {
            (bool allowed, uint256 paid) = _abortAllowed();
            if (!allowed) revert CycleIsPartiallyPaid(paid);
        }
        // keccak("renounceOwnership()") — OpenZeppelin Ownable, which DividendVault inherits.
        if (selector == 0x715018a6) revert RenounceRefused();

        bool ok;
        (ok, result) = address(vault).call{value: msg.value}(data);
        if (!ok) revert CallFailed(result);
        emit Executed(selector, result);
    }

    /**
     * What the vault's own recovery path now delivers here.
     *
     * `emergencyWithdrawERC20` pays `owner()`, so with this contract as owner the tokens arrive at
     * this address. Without a way out they would be recovered from one contract into another, which
     * is not recovery. Tolerant of tokens that return nothing, because B20 assets are precompiles
     * and this must work for exactly the balances the emergency path exists to move.
     */
    function sweepERC20(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok || !(ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) revert TransferFailed();
        emit Swept(token, to, amount);
    }

    /// Nothing routes ETH here in normal operation — the vault has no ETH recovery path and
    /// `claimPlatform` pays the platform recipient directly — but a balance that cannot move is a
    /// worse outcome than one nobody expected.
    function sweepETH(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Swept(address(0), to, amount);
    }

    // ------------------------------------------------------------------ ownership

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------------ views

    /// Is this contract actually in charge? Worth asking before relying on any of the above.
    function isInstalled() external view returns (bool) {
        return vault.owner() == address(this);
    }

    /// Would an abort be allowed right now, and if not, how many holders have already been paid.
    function abortAllowed() external view returns (bool allowed, uint256 paidSoFar) {
        return _abortAllowed();
    }

    /**
     * BOTH HALVES ARE LOAD-BEARING, and the second one was learned from a test.
     *
     * `cursor` is the number of snapshot entries paid in the open cycle — but the vault never clears
     * it on completion. It is reset by the NEXT `startCycle`, so between a finished cycle and the
     * next one it sits at the full snapshot length. Refusing on `cursor != 0` alone therefore refused
     * an abort in the state where abort is most obviously harmless: the cycle is closed, every holder
     * has been paid, and everything the call would clear is stale anyway.
     *
     * That is not a conservative failure. `abortCycle` is the tool for a wedged PENDING SNAPSHOT, and
     * a snapshot only ever goes pending while no cycle is active — precisely the window a
     * cursor-only rule would have blocked. A rail that refuses the one call it exists to permit is a
     * brick, and someone would have removed this contract to get past it.
     *
     * The dangerous state is exactly one: a cycle that is STILL OPEN and has ALREADY paid somebody.
     */
    function _abortAllowed() private view returns (bool allowed, uint256 paidSoFar) {
        paidSoFar = vault.cursor();
        allowed = !(vault.cycleActive() && paidSoFar != 0);
    }

    receive() external payable {}
}
