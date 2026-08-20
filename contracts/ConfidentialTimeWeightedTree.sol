// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title ConfidentialTimeWeightedTree — encrypted odds accounting for Hushpot
/// @notice The encrypted twin of `TimeWeightedTree.sol`, which stays in the repo as the
/// correctness oracle: the two must agree on every input, and the plaintext one can be
/// printed and stepped through when they don't.
///
/// WHAT IT DOES
/// ------------
/// Tracks, for every participant, how much they hold *and how long they have held it* this
/// period — ticket-minutes — and keeps the subtree sums needed to locate a winner without
/// scanning anyone. Deposit halfway through the week and you earn half the odds of someone
/// who was there all week with the same amount.
///
/// THE PROBLEM IT SOLVES
/// ---------------------
/// The obvious approach — `accrued += balance * (now - theirLastChange)` — is correct for
/// one user and unusable for a pool, because every user has a different `lastChange`, so
/// totalling at draw time means visiting all of them. Expanding the pending term fixes it:
///
///     balance * (drawTime - lastChange) = balance * drawTime - balance * lastChange
///
/// The right-hand term carries no draw time, so it is computable the moment someone
/// deposits and can be summed. The left multiplies a figure that is identical for everyone,
/// so it factors out against the sum of balances. The pool therefore resolves to running
/// totals plus one multiplication, evaluated on demand, and **no end-of-period sweep ever
/// runs** — a draw does zero per-user work.
///
/// Corrections are stored as a shortfall from full credit, so a participant who never moves
/// has a shortfall of zero. When a period rolls over, stale shortfalls read as zero and
/// everyone silently returns to full credit with nothing written anywhere.
///
/// They are split into two non-negative halves because withdrawals push the net negative,
/// and encrypted integers are unsigned.
///
/// WHAT STAYS PUBLIC, AND WHY IT IS SAFE
/// -------------------------------------
///   - the period number and its start time — a schedule, not a balance
///   - which minute of the period a transaction landed in — already public as a block
///     timestamp, and it is what lets an encrypted amount be scaled by a plain number
///   - which slot a transaction touched — the sender is public regardless
///
/// Amounts, weights, odds and the draw point are never public.
///
/// TIME UNITS
/// ----------
/// Minutes since the period began, never raw unix timestamps: `balance * unixTime`
/// overflows `euint64` by roughly a hundredfold, and encrypted overflow is **silent** —
/// wrong odds, no revert, no trace.
abstract contract ConfidentialTimeWeightedTree is ZamaEthereumConfig {
    /// @dev Capacity, and the price of griefing it.
    ///
    /// A slot is claimed on first deposit and never released, and the deposit that claims
    /// it cannot be checked for size: ERC-7984 clamps rather than reverts, so a transfer
    /// of more than you hold moves zero and succeeds. There is no way to reject that —
    /// `moved` is a ciphertext, and branching on it is exactly what FHE forbids. Nor would
    /// rejecting zero help, because a one-wei deposit is just as cheap and is a legitimate
    /// deposit besides. Detection is not the lever here; capacity is.
    ///
    /// So the cap is set high enough that filling it costs real money. Each claimed slot
    /// needs its own address and its own ~500k-gas deposit, which at 16,384 slots is on
    /// the order of eight billion gas — roughly half a million dollars at mainnet prices.
    /// Legitimate depositors pay nothing for the headroom: {_treeRoot} keeps the tree only
    /// as deep as the slots actually in use, so a thirteen-person pool walks four levels
    /// here exactly as it did at 1024.
    ///
    /// This prices the attack rather than eliminating it. `docs/THREAT-MODEL.md` says so.
    uint16 public constant LEAF_COUNT = 16384;
    uint16 public constant LEAF_OFFSET = 16384;

    /// @notice One draw period, in minutes. One week.
    uint64 public constant PERIOD_MINUTES = 10080;

    uint256 public constant PERIOD_SECONDS = uint256(PERIOD_MINUTES) * 60;

    mapping(uint256 => euint64) internal _balance;
    mapping(uint256 => euint64) internal _lateCredit;
    mapping(uint256 => euint64) internal _earlyExit;

    /// @dev Which period the corrections belong to. Plain, not encrypted — it records
    /// *when*, never *how much*.
    mapping(uint256 => uint32) internal _stamp;

    uint32 public currentPeriod;
    uint256 public periodStart;

    /// @dev Slot assignment. `_slotOfPlusOne` is offset by one so that zero means unassigned.
    mapping(address => uint16) private _slotOfPlusOne;
    mapping(uint16 => address) public slotOwner;
    uint16 public slotsUsed;

    /// @dev Results of the last refresh, cached so they can be decrypted off-chain.
    mapping(uint16 => euint64) private _weightCache;
    euint64 private _totalCache;

    /// @dev Prize money won but not yet folded into the tree.
    ///
    /// Crediting a slot the usual way costs 30 encrypted additions, because every ancestor
    /// sum has to be repaired. That is the single most expensive thing in a claim, and in a
    /// whole-pool sweep it is almost entirely waste: the same ancestors get rebuilt once per
    /// participant, and for everyone but the winner the amount being added is an encrypted
    /// zero.
    ///
    /// So a sweep parks the award here instead — one addition, no walk. It is folded into
    /// the tree the next time the slot deposits or withdraws, which repairs the path anyway,
    /// making the fold cost one extra addition rather than thirty.
    ///
    /// A balance is therefore leaf + pending. Both are ciphertext; the split is an
    /// accounting detail and leaks nothing.
    mapping(uint16 => euint64) internal _pendingAward;

    /// @dev The sum of every parked award, kept as a running encrypted total.
    ///
    /// Solvency compares what the pool holds against what it owes, and what it owes is the
    /// tree root PLUS anything parked — a winner's prize is already theirs, it simply has
    /// not been folded into a leaf yet. Summing 1024 slots to discover that is impossible
    /// inside one transaction, so the total is maintained incrementally instead: one
    /// addition when an award is parked, one subtraction when it is folded. Both are
    /// operations those paths were performing anyway.
    euint64 internal _parkedTotal;

    /// @dev Parked awards in aggregate. Zero before the first sweep, which is a legitimate
    /// state rather than an uninitialised one.
    function _parkedTotalOf() internal view returns (euint64) {
        return euint64.unwrap(_parkedTotal) == bytes32(0) ? _zero() : _parkedTotal;
    }

    /// @dev Park an award against a slot and keep the aggregate in step. Every site that
    /// writes `_pendingAward` must go through here, or solvency silently understates.
    function _parkAward(uint16 slot, euint64 award) internal {
        _pendingAward[slot] = FHE.add(_pendingAward[slot], award);
        FHE.allowThis(_pendingAward[slot]);

        _parkedTotal = FHE.add(_parkedTotalOf(), award);
        FHE.allowThis(_parkedTotal);
    }

    event PeriodAdvanced(uint32 indexed period, uint256 startedAt);
    event SlotAssigned(address indexed account, uint16 indexed slot);

    error SlotOutOfRange();
    error NoSlotAssigned();
    error NotSlotOwner();
    error PoolFull();

    constructor() {
        periodStart = block.timestamp;
    }

    // -------------------------------------------------------------------------
    // Slots
    // -------------------------------------------------------------------------

    /// @notice The slot held by `account`, or reverts if they have never deposited.
    function slotOf(address account) public view returns (uint16) {
        uint16 plusOne = _slotOfPlusOne[account];
        if (plusOne == 0) revert NoSlotAssigned();
        return plusOne - 1;
    }

    function hasSlot(address account) public view returns (bool) {
        return _slotOfPlusOne[account] != 0;
    }

    /// @dev Assign a slot on first deposit. Slot numbers are public — only what sits in
    /// them is secret — so a plain counter is fine.
    function _ensureSlot(address account) internal returns (uint16) {
        uint16 plusOne = _slotOfPlusOne[account];
        if (plusOne != 0) return plusOne - 1;

        if (slotsUsed >= LEAF_COUNT) revert PoolFull();
        uint16 slot = slotsUsed;
        slotsUsed = slot + 1;

        _slotOfPlusOne[account] = slot + 1;
        slotOwner[slot] = account;
        emit SlotAssigned(account, slot);
        return slot;
    }

    // -------------------------------------------------------------------------
    // Periods
    // -------------------------------------------------------------------------

    /// @dev Close the current period and open the next. Costs nothing per participant:
    /// stale corrections simply stop counting, handing everyone full credit for the new
    /// period without a single write.
    function _advancePeriod() internal {
        currentPeriod += 1;
        periodStart = block.timestamp;
        emit PeriodAdvanced(currentPeriod, periodStart);
    }

    /// @notice Minutes elapsed in the current period, saturating at the period length.
    function minuteOfPeriod() public view returns (uint64) {
        uint256 elapsed = block.timestamp - periodStart;
        uint64 m = uint64(elapsed / 60);
        return m > PERIOD_MINUTES ? PERIOD_MINUTES : m;
    }

    // -------------------------------------------------------------------------
    // Corrections, read through the period stamp
    // -------------------------------------------------------------------------

    /// @dev An uninitialised handle behaves as encrypted zero, so this costs nothing.
    function _zero() internal pure returns (euint64) {
        return euint64.wrap(bytes32(0));
    }

    function _lateCreditOf(uint256 node) internal view returns (euint64) {
        return _stamp[node] == currentPeriod ? _lateCredit[node] : _zero();
    }

    function _earlyExitOf(uint256 node) internal view returns (euint64) {
        return _stamp[node] == currentPeriod ? _earlyExit[node] : _zero();
    }

    function _persist(uint256 node) internal {
        FHE.allowThis(_balance[node]);
        FHE.allowThis(_lateCredit[node]);
        FHE.allowThis(_earlyExit[node]);
        _stamp[node] = currentPeriod;
    }

    // -------------------------------------------------------------------------
    // Mutations
    // -------------------------------------------------------------------------

    /// @dev Move any parked winnings into the leaf. Free in practice: the callers below all
    /// repair the path immediately afterwards, so this adds one encrypted addition to a
    /// walk that was going to happen regardless.
    ///
    /// Winnings join the balance without earning back-credit for the period — they were not
    /// staked for the minutes before the draw, so `_lateCredit` is charged for the whole
    /// elapsed part of the period exactly as a fresh deposit would be.
    /// @dev Fold parked winnings in and repair the tree, so they start earning odds.
    ///
    /// Costs nothing at all when there is nothing pending, which is every slot except a
    /// winner's. So the thirty-addition repair is paid once, by the person who won, on a
    /// transaction they were making anyway — and never by anyone who lost.
    function _settlePending(uint16 slot) internal {
        if (euint64.unwrap(_pendingAward[slot]) == bytes32(0)) return;

        uint256 node = uint256(LEAF_OFFSET) + slot;
        _foldPending(slot, node);
        _persist(node);
        _repairPath(node);
    }

    function _foldPending(uint16 slot, uint256 node) private {
        euint64 pending = _pendingAward[slot];
        if (euint64.unwrap(pending) == bytes32(0)) return;

        _balance[node] = FHE.add(_balance[node], pending);
        _lateCredit[node] = FHE.add(_lateCreditOf(node), FHE.mul(pending, minuteOfPeriod()));
        _pendingAward[slot] = _zero();

        // The award has moved from parked to banked. Leaving it counted in both places
        // would make the pool look like it owed the prize twice.
        _parkedTotal = FHE.sub(_parkedTotalOf(), pending);
        FHE.allowThis(_parkedTotal);
    }

    /// @dev Add encrypted stake to a slot, credited only for the remainder of the period.
    function _creditSlot(uint16 slot, euint64 amount) internal {
        if (slot >= LEAF_COUNT) revert SlotOutOfRange();

        uint64 m = minuteOfPeriod();
        uint256 node = uint256(LEAF_OFFSET) + slot;

        _foldPending(slot, node);
        _balance[node] = FHE.add(_balance[node], amount);
        // Full credit would be amount * PERIOD_MINUTES. It only earns from minute `m`
        // onward, so it falls short by exactly `amount * m`.
        _lateCredit[node] = FHE.add(_lateCreditOf(node), FHE.mul(amount, m));
        _earlyExit[node] = _earlyExitOf(node);
        _persist(node);

        _repairPath(node);
    }

    /// @dev Remove encrypted stake, keeping the credit it already earned.
    /// @return actual The amount really removed — clamped to the balance held, because a
    /// ciphertext cannot be compared and branched on, so an over-withdrawal cannot revert.
    function _debitSlot(uint16 slot, euint64 requested) internal returns (euint64 actual) {
        if (slot >= LEAF_COUNT) revert SlotOutOfRange();

        uint256 node = uint256(LEAF_OFFSET) + slot;
        _foldPending(slot, node);

        actual = FHE.min(requested, _balance[node]);
        uint64 m = minuteOfPeriod();

        _balance[node] = FHE.sub(_balance[node], actual);
        // Dropping the balance strips a whole period of credit, but this stake genuinely
        // earned up to minute `m` — hand that portion back.
        _earlyExit[node] = FHE.add(_earlyExitOf(node), FHE.mul(actual, m));
        _lateCredit[node] = _lateCreditOf(node);
        _persist(node);

        _repairPath(node);

        FHE.allowThis(actual);
    }

    /// @dev The highest node that still covers every slot in use — the tree's real root.
    ///
    /// A full 1024-leaf tree is ten levels deep, and every credit used to repair all ten.
    /// With twenty depositors that is mostly ceremony: slots 0-19 sit under node 32, and
    /// everything to its right is zero, so node 32 already *equals* node 1. The five levels
    /// above it were being rebuilt on every deposit to copy a number that had not changed.
    ///
    /// So the walk stops here instead, and the depth grows with the pool rather than being
    /// paid for up front. Crossing a power of two moves the root up one level, and the
    /// first credit afterwards computes it — no migration, no re-indexing.
    ///
    /// Plain arithmetic, no ciphertext: `slotsUsed` is public, and how many people are in
    /// the pool was never a secret.
    function _treeRoot() internal view returns (uint256) {
        uint16 used = slotsUsed;
        if (used <= 1) return LEAF_OFFSET;

        uint256 span = 1;
        uint256 root = LEAF_OFFSET;
        while (span < used) {
            span <<= 1;
            root >>= 1;
        }
        return root;
    }

    /// @dev Restore the subtree sums along the ancestors of a leaf, up to {_treeRoot}. Only ancestors can
    /// be affected by a change, which keeps this at 30 encrypted additions rather than a
    /// full re-sum of the tree — and that bound is what makes the structure viable at all.
    function _repairPath(uint256 node) internal {
        uint256 root = _treeRoot();
        node /= 2;
        while (node >= root) {
            uint256 left = 2 * node;
            uint256 right = left + 1;

            _balance[node] = FHE.add(_balance[left], _balance[right]);
            _lateCredit[node] = FHE.add(_lateCreditOf(left), _lateCreditOf(right));
            _earlyExit[node] = FHE.add(_earlyExitOf(left), _earlyExitOf(right));
            _persist(node);

            node /= 2;
        }
    }

    // -------------------------------------------------------------------------
    // Weights
    // -------------------------------------------------------------------------

    /// @dev Ticket-minutes under a node. Grouped as (full credit + refunds) - shortfalls so
    /// no intermediate value dips below zero, which unsigned ciphertexts cannot represent.
    function _weightOf(uint256 node) internal returns (euint64) {
        euint64 full = FHE.mul(_balance[node], PERIOD_MINUTES);
        return FHE.sub(FHE.add(full, _earlyExitOf(node)), _lateCreditOf(node));
    }

    /// @notice Compute your own ticket-minutes and authorise yourself to decrypt them.
    /// @dev A transaction, not a view — FHE operations mutate coprocessor state. Read the
    /// handle afterwards with {weightHandle} and decrypt it off-chain via EIP-712.
    ///
    /// Restricted to the slot's owner. Without this check anyone could grant themselves
    /// decryption rights over another participant's position.
    function refreshMyWeight() external {
        uint16 slot = slotOf(msg.sender);
        // Winnings must be in the tree before the weight is read, or a winner would see a
        // balance and an odds figure that disagree with each other.
        _settlePending(slot);

        euint64 w = _weightOf(uint256(LEAF_OFFSET) + slot);
        _weightCache[slot] = w;
        FHE.allowThis(w);
        FHE.allow(w, msg.sender);
    }

    function weightHandle(uint16 slot) external view returns (euint64) {
        return _weightCache[slot];
    }

    /// @dev Lets a subclass publish a computed weight through the same handle a reader
    /// already knows to look at.
    function _cacheWeight(uint16 slot, euint64 weight) internal {
        _weightCache[slot] = weight;
    }

    /// @dev Compute the pool's total ticket-minutes and mark it publicly decryptable.
    ///
    /// Deliberately **internal**. The total is the one aggregate Hushpot publishes, and
    /// only at a draw boundary — {HushpotPool-openDraw} is the sole caller in production.
    ///
    /// This used to be `external`, which meant anyone could publish the live total on
    /// demand. That is not a small leak: read it, wait for a deposit to land, read it
    /// again, and the difference is that depositor's amount in the clear. Two calls and
    /// the encryption is worth nothing. A subclass exposes it for tests; the pool does
    /// not expose it at all.
    function _refreshTotal() internal {
        euint64 t = _weightOf(_treeRoot());
        _totalCache = t;
        FHE.allowThis(t);
        FHE.makePubliclyDecryptable(t);
    }

    function totalHandle() external view returns (euint64) {
        return _totalCache;
    }

    /// @dev For subclasses that need to grant rights over the cached total. Test harnesses
    /// only — the pool never hands this out.
    function _totalCacheHandle() internal view returns (euint64) {
        return _totalCache;
    }

    // -------------------------------------------------------------------------
    // Selection
    // -------------------------------------------------------------------------

    /// @dev Combined ticket-minutes of every slot ordered before this one — the lower edge
    /// of its band. Climbing from the leaf, a right child's left sibling covers everything
    /// before it, so one addition skips that entire subtree.
    ///
    /// The three components accumulate separately and combine once, so no partial sum can
    /// go negative along the way.
    function _prefixWeight(uint16 slot) internal returns (euint64) {
        euint64 bal = _zero();
        euint64 late = _zero();
        euint64 early = _zero();

        uint256 node = uint256(LEAF_OFFSET) + slot;
        uint256 root = _treeRoot();
        while (node > root) {
            if (node % 2 == 1) {
                uint256 sib = node - 1;
                bal = FHE.add(bal, _balance[sib]);
                late = FHE.add(late, _lateCreditOf(sib));
                early = FHE.add(early, _earlyExitOf(sib));
            }
            node /= 2;
        }

        return FHE.sub(FHE.add(FHE.mul(bal, PERIOD_MINUTES), early), late);
    }

    /// @dev Decide, without revealing anything, whether a slot holds the winning band.
    ///
    /// This is the whole reason Hushpot never learns a winner. The comparison runs on
    /// ciphertext and yields an encrypted boolean the contract cannot read. It is only ever
    /// fed into a `select`, choosing between the prize and zero — so a loser's claim
    /// silently adds nothing and is indistinguishable on-chain from a winner's.
    function _checkWin(uint16 slot, euint64 drawPoint) internal returns (ebool) {
        if (slot >= LEAF_COUNT) revert SlotOutOfRange();

        euint64 lower = _prefixWeight(slot);
        euint64 upper = FHE.add(lower, _weightOf(uint256(LEAF_OFFSET) + slot));

        return FHE.and(FHE.ge(drawPoint, lower), FHE.lt(drawPoint, upper));
    }
}
