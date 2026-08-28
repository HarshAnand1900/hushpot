// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {HushpotPool} from "./HushpotPool.sol";

/// @title The owner of the judge sandbox, which is nobody in particular.
///
/// Two of the pool's six cycle steps — `openDraw` and `startNextPeriod` — are gated to the
/// owner *only for running them early*. Once a period genuinely elapses anyone may call
/// them. That gate is right for the real pool and wrong for a demonstration: a judge
/// arriving on a Tuesday should not have to wait until the following Monday to press two
/// of six buttons.
///
/// The obvious fix is to publish the sandbox owner's private key, and that was the first
/// attempt. It works, and it is bad: it asks a reviewer to import a stranger's key into
/// their wallet before they can look at anything, which is a thing nobody should be in the
/// habit of doing and which most reviewers will simply decline.
///
/// So ownership goes to this contract instead, and this contract will do those two things
/// for anybody who asks. The key is then not published because it no longer exists as a
/// thing worth having — after `transferOwnership` the deploying key owns nothing.
///
/// What it deliberately cannot do is as important as what it can. There is no forwarder
/// for `setAnnualRateBps`, so nobody can set the sandbox's yield to zero and make every
/// prize read `0.00`; no forwarder for `transferOwnership`, so nobody can take the pool;
/// and no generic `call`, which would have been all three of those and every future
/// owner-gated function besides. The pool's owner-only powers are not delegated. They are
/// destroyed, and two specific harmless ones are handed out in their place.
contract SandboxOperator {
    using SafeERC20 for IERC20;

    /// @notice The pool this contract owns.
    HushpotPool public immutable pool;

    constructor(HushpotPool pool_) {
        pool = pool_;
    }

    /// @notice Seal the pool total and publish it for decryption. Anyone, any time.
    function openDraw() external {
        pool.openDraw();
    }

    /// @notice Close the claim window and open the next period. Anyone, any time.
    function startNextPeriod() external {
        pool.startNextPeriod();
    }

    /// @notice Top up the prize reserve with your own plain tokens.
    ///
    /// @dev Forwarded because the alternative is a sandbox whose reserve can never be
    /// refilled once ownership is given away. It only ever adds money, and the money is
    /// the caller's, so there is nothing here to abuse: the worst a caller can do is make
    /// the prizes larger at their own expense.
    ///
    /// The pool pulls from *its* caller, which is this contract, so the tokens have to
    /// come here first and be approved onward.
    function fundPrizeReserve(uint256 amount) external {
        IERC20 token = pool.underlyingToken();
        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(address(pool), amount);
        pool.fundPrizeReserve(amount);
    }
}
