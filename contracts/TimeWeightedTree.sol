// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title TimeWeightedTree — plaintext prototype of Hushpot's odds accounting
/// @notice Still plain `uint64`, no FHE. Same reason as before: encrypted overflow and
/// encrypted arithmetic bugs are silent, so we prove the arithmetic where we can print it.
///
/// WHAT THIS ADDS OVER SegmentTree
/// -------------------------------
/// A leaf's weight is no longer just "how much you deposited". It is "how much, times how
/// long it sat there this period" — ticket-minutes. Deposit half way through the week and
/// you earn half the odds of someone who was there the whole week with the same amount.
///
/// THE PROBLEM THAT SHAPES EVERYTHING BELOW
/// ----------------------------------------
/// The obvious way to track that is, per user, `accrued += balance * (now - theirLastChange)`.
/// Correct for one user, unusable for a pool: every user has a *different* lastChange, so at
/// draw time everyone has a different uncredited stretch, and totalling the pool would mean
/// visiting all of them. That loop is what makes the naive design impossible on-chain.
///
/// The fix is algebra, not a different idea. Expand the pending term:
///
///     balance * (drawTime - lastChange)  =  balance * drawTime  -  balance * lastChange
///
/// The second half contains no drawTime, so it can be computed the instant someone deposits
/// and folded into a running total. The first half multiplies drawTime — the same number for
/// everybody — against the *sum* of balances. So the whole pool resolves to one expression
/// over three running totals, evaluated on demand, with no per-user sweep ever.
///
/// This contract stores those totals as a deficit from full credit, so that:
///   - a user who never moves has a deficit of zero, and
///   - when a period rolls over, stale deficits simply read as zero and everyone
///     automatically gets full credit, with nothing written anywhere.
///
/// Deficits are split into two non-negative halves because withdrawals push the net
/// negative and these are unsigned (and will be `euint64`, which has no negatives at all).
///
/// TIME UNITS
/// ----------
/// Minutes since the period started, never raw unix timestamps. `balance * unixTime` would
/// overflow `uint64` by ~100x, and under FHE that overflow is silent — wrong odds, no revert.
contract TimeWeightedTree {
    uint16 public constant LEAF_COUNT = 1024;
    uint16 public constant LEAF_OFFSET = 1024;

    /// @notice Length of one draw period, in minutes. One week.
    uint64 public constant PERIOD_MINUTES = 10080;

    /// @dev Sum of balances in each subtree. Survives period rollovers.
    uint64[2048] private _balance;

    /// @dev Sum of `amount * minutesIntoPeriod` for deposits made this period.
    uint64[2048] private _lateCredit;

    /// @dev Sum of `amount * minutesIntoPeriod` for withdrawals made this period.
    uint64[2048] private _earlyExit;

    /// @dev Which period `_lateCredit` / `_earlyExit` belong to. If this is behind the
    /// current period, no one under this node has moved yet, so both read as zero.
    uint32[2048] private _stamp;

    uint32 public currentPeriod;

    /// @notice Begin a new draw period. Costs nothing per user — stale corrections
    /// simply stop counting, which hands everyone full credit automatically.
    function advancePeriod() external {
        currentPeriod += 1;
    }

    // -------------------------------------------------------------------------
    // Corrections, read through the period stamp
    // -------------------------------------------------------------------------

    function _lateCreditOf(uint256 node) internal view returns (uint64) {
        return _stamp[node] == currentPeriod ? _lateCredit[node] : 0;
    }

    function _earlyExitOf(uint256 node) internal view returns (uint64) {
        return _stamp[node] == currentPeriod ? _earlyExit[node] : 0;
    }

    /// @dev Bring a node into the current period before writing to it.
    function _refresh(uint256 node) internal {
        if (_stamp[node] != currentPeriod) {
            _lateCredit[node] = 0;
            _earlyExit[node] = 0;
            _stamp[node] = currentPeriod;
        }
    }

    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------

    /// @notice Add to a participant's stake, crediting it only for the remainder of the period.
    /// @param minuteOfPeriod Minutes elapsed since this period began, in [0, PERIOD_MINUTES].
    function deposit(uint16 slot, uint64 amount, uint64 minuteOfPeriod) external {
        require(slot < LEAF_COUNT, "TWT: slot out of range");
        require(minuteOfPeriod <= PERIOD_MINUTES, "TWT: minute out of range");

        uint256 node = uint256(LEAF_OFFSET) + slot;
        _refresh(node);

        _balance[node] += amount;
        // Full credit would be amount * PERIOD_MINUTES. It only earns from `minuteOfPeriod`
        // onward, so it falls short by exactly this much.
        _lateCredit[node] += amount * minuteOfPeriod;

        _repairPath(node);
    }

    /// @notice Remove stake. It keeps the credit it already earned, and stops earning now.
    function withdraw(uint16 slot, uint64 amount, uint64 minuteOfPeriod) external {
        require(slot < LEAF_COUNT, "TWT: slot out of range");
        require(minuteOfPeriod <= PERIOD_MINUTES, "TWT: minute out of range");

        uint256 node = uint256(LEAF_OFFSET) + slot;
        _refresh(node);
        require(_balance[node] >= amount, "TWT: insufficient balance");

        _balance[node] -= amount;
        // Dropping the balance removes a full period of credit, but this stake genuinely
        // earned up to `minuteOfPeriod` — hand that portion back.
        _earlyExit[node] += amount * minuteOfPeriod;

        _repairPath(node);
    }

    /// @dev Restore the subtree sums along the 10 ancestors of a leaf.
    function _repairPath(uint256 node) internal {
        node /= 2;
        while (node >= 1) {
            uint256 l = 2 * node;
            uint256 r = l + 1;

            _refresh(node);
            _balance[node] = _balance[l] + _balance[r];
            _lateCredit[node] = _lateCreditOf(l) + _lateCreditOf(r);
            _earlyExit[node] = _earlyExitOf(l) + _earlyExitOf(r);

            node /= 2;
        }
    }

    // -------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------

    /// @dev Ticket-minutes held under a node this period.
    /// Grouped as (full credit + refunds) - shortfalls so no intermediate step goes negative.
    function _weightOf(uint256 node) internal view returns (uint64) {
        return _balance[node] * PERIOD_MINUTES + _earlyExitOf(node) - _lateCreditOf(node);
    }

    /// @notice Ticket-minutes for one participant this period.
    function weightOf(uint16 slot) external view returns (uint64) {
        require(slot < LEAF_COUNT, "TWT: slot out of range");
        return _weightOf(uint256(LEAF_OFFSET) + slot);
    }

    /// @notice Ticket-minutes across the whole pool. Read from the root — never summed.
    function totalWeight() external view returns (uint64) {
        return _weightOf(1);
    }

    /// @notice Plain deposited balance of a participant, ignoring time.
    function balanceOf(uint16 slot) external view returns (uint64) {
        require(slot < LEAF_COUNT, "TWT: slot out of range");
        return _balance[uint256(LEAF_OFFSET) + slot];
    }

    /// @notice Combined ticket-minutes of every slot ordered before `slot`.
    /// @dev The three components are accumulated separately and combined once at the end,
    /// so no partial sum can dip below zero along the way.
    function prefixWeight(uint16 slot) public view returns (uint64) {
        require(slot < LEAF_COUNT, "TWT: slot out of range");

        uint64 bal;
        uint64 late;
        uint64 early;

        uint256 node = uint256(LEAF_OFFSET) + slot;
        while (node > 1) {
            if (node % 2 == 1) {
                uint256 sib = node - 1;
                bal += _balance[sib];
                late += _lateCreditOf(sib);
                early += _earlyExitOf(sib);
            }
            node /= 2;
        }

        return bal * PERIOD_MINUTES + early - late;
    }

    /// @notice Whether `slot` holds the winning band for `drawPoint`.
    /// @dev The plaintext twin of the encrypted claim check. Each participant evaluates this
    /// for themselves, learning nothing about anyone else — which is why the draw needs no
    /// central walk and never reveals a winner.
    function winsWith(uint16 slot, uint64 drawPoint) external view returns (bool) {
        uint64 lower = prefixWeight(slot);
        uint64 upper = lower + _weightOf(uint256(LEAF_OFFSET) + slot);
        return drawPoint >= lower && drawPoint < upper;
    }

    /// @notice Reference walk, kept as a correctness oracle for the self-check above.
    function findLeaf(uint64 drawPoint) external view returns (uint16) {
        require(drawPoint < _weightOf(1), "TWT: draw point out of range");

        uint256 node = 1;
        while (node < LEAF_OFFSET) {
            uint256 left = 2 * node;
            uint64 leftWeight = _weightOf(left);

            if (drawPoint < leftWeight) {
                node = left;
            } else {
                drawPoint -= leftWeight;
                node = left + 1;
            }
        }

        return uint16(node - LEAF_OFFSET);
    }
}
