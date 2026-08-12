// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

import {ConfidentialTimeWeightedTree} from "./ConfidentialTimeWeightedTree.sol";

/// @dev The slice of ERC-7984's ERC-20 wrapper extension the pool needs in order to
/// shield plain tokens on a depositor's behalf. Declared locally so the pool can also be
/// pointed at a non-wrapping confidential token, in which case auto-shielding is simply
/// unavailable and everything else still works.
interface IConfidentialWrapper {
    function underlying() external view returns (address);

    function rate() external view returns (uint256);

    function wrap(address to, uint256 amount) external returns (euint64);
}

/// @title HushpotPool — confidential no-loss prize savings
/// @notice Deposit a confidential token, keep your principal, and win the pool's yield.
/// Amounts, balances, odds and the winner all stay encrypted; the draw stays verifiable.
///
/// NO LOSS, STRUCTURALLY
/// ---------------------
/// Deposits and prizes live in separate accounting. A draw never touches principal — it
/// only ever distributes yield — so "withdraw your full deposit whenever you like" is a
/// property of the design rather than a promise we make.
///
/// GETTING IN
/// ----------
/// The pool moves tokens on your behalf, so it must first be authorised as an operator on
/// the token contract:
///
///     token.setOperator(pool, deadline);
///     pool.deposit(encryptedAmount, proof);
///
/// The amount is encrypted before it leaves the wallet, and the pool learns only a
/// ciphertext handle.
///
/// WHAT LEAKS
/// ----------
/// That a given address deposited, and when — both are inherent to a public chain, since
/// the transaction itself is visible. Never how much. See `docs/THREAT-MODEL.md`.
contract HushpotPool is ConfidentialTimeWeightedTree, Ownable {
    using SafeERC20 for IERC20;

    /// @dev Converts ticket-minutes into a prize at a given annual rate:
    /// `prize = ticketMinutes * annualRateBps / (10_000 * minutesPerYear)`.
    uint256 private constant RATE_DIVISOR = 10_000 * 525_600;

    struct Draw {
        /// @notice Pool-wide ticket-minutes, published at settlement. The one aggregate
        /// Hushpot ever reveals — and only here, once a period, never continuously.
        uint64 total;
        /// @notice Prize for this draw. Public, and nobody's balance.
        uint64 prize;
        /// @notice Where the dice landed. Encrypted, and never decrypted by anyone.
        euint64 drawPoint;
        /// @notice The period whose weights this draw was settled against.
        uint32 period;
        bool settled;
    }

    mapping(uint256 => Draw) public draws;
    uint256 public drawCount;

    /// @dev Set to true between {openDraw} and {settleDraw}, while the total is out for
    /// decryption.
    bool public drawPending;
    euint64 private _pendingTotal;

    /// @notice Tokens set aside to pay prizes. Public — prizes are not anybody's balance.
    uint64 public prizeReserve;

    /// @notice Annual yield rate in basis points. 500 = 5%.
    /// @dev The prize scales with the pool: a large late depositor grows the pot in
    /// proportion to the odds they take, so nobody can dilute anyone else's expected
    /// return by arriving. See `docs/THREAT-MODEL.md`.
    uint256 public annualRateBps = 500;

    /// @dev Which slots have already had a given draw evaluated. Public, and it reveals
    /// only that someone was checked — never whether they won.
    mapping(uint256 => mapping(uint16 => bool)) public claimChecked;

    event DrawOpened(uint256 indexed drawId, bytes32 totalHandle);
    event DrawSettled(uint256 indexed drawId, uint64 total, uint64 prize);
    event PeriodStarted(uint32 indexed period);
    event ClaimChecked(uint256 indexed drawId, uint16 indexed slot, address indexed checkedBy);
    event ReserveFunded(uint64 amount, uint64 newReserve);
    event SolvencyProven(uint256 at);
    event RateUpdated(uint256 annualRateBps);

    error DrawAlreadyPending();
    error DrawAlreadySettledThisPeriod();
    error NoDrawPending();
    error PeriodNotElapsed();
    error DrawNotSettled();
    error AlreadyChecked();
    error EmptyPool();
    error PeriodStillOpen();

    /// @notice The confidential token this pool accepts.
    IERC7984 public immutable token;

    /// @notice The plain ERC-20 behind {token}, when it is a wrapper. Zero otherwise.
    /// @dev When set, depositors may hand over plain tokens and have the pool shield them,
    /// so nobody has to learn the word "wrap".
    IERC20 public immutable underlyingToken;

    /// @dev Cached principal balances, for the owner to decrypt off-chain.
    mapping(uint16 => euint64) private _balanceCache;

    event Deposited(address indexed account, uint16 indexed slot);
    event Withdrawn(address indexed account, uint16 indexed slot);

    /// @dev `amount` is deliberately in the clear — see {depositUnderlying}.
    event DepositedFromUnderlying(address indexed account, uint16 indexed slot, uint256 amount);

    error NotAnOperator();
    error NoUnderlyingToken();
    error ZeroAmount();

    constructor(IERC7984 token_) Ownable(msg.sender) {
        token = token_;

        // Detect whether this token wraps a plain ERC-20. A confidential token that isn't
        // a wrapper simply reverts here, and auto-shielding stays switched off.
        address found;
        try IConfidentialWrapper(address(token_)).underlying() returns (address u) {
            found = u;
        } catch {
            found = address(0);
        }
        underlyingToken = IERC20(found);
    }

    /// @notice Whether depositors can hand over plain tokens and be shielded automatically.
    function supportsAutoShield() public view returns (bool) {
        return address(underlyingToken) != address(0);
    }

    // -------------------------------------------------------------------------
    // Deposit and withdraw
    // -------------------------------------------------------------------------

    /// @notice Move an encrypted amount into the pool and start earning odds immediately.
    /// @dev Odds accrue from this minute onward, pro-rata for the rest of the period —
    /// there is no waiting period and no lock.
    ///
    /// The tree is credited with the amount the token reports as *actually* transferred,
    /// not the amount requested. ERC-7984 clamps a transfer to the sender's balance rather
    /// than reverting, so crediting the request would let anyone inflate their odds by
    /// asking to deposit more than they hold.
    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        if (!token.isOperator(msg.sender, address(this))) revert NotAnOperator();

        euint64 requested = FHE.fromExternal(encryptedAmount, inputProof);
        FHE.allowTransient(requested, address(token));

        euint64 moved = token.confidentialTransferFrom(msg.sender, address(this), requested);
        FHE.allowThis(moved);

        uint16 slot = _ensureSlot(msg.sender);
        _creditSlot(slot, moved);

        emit Deposited(msg.sender, slot);
    }

    /// @notice Deposit plain tokens and let the pool shield them for you.
    /// @dev The convenience path, for anyone holding ordinary tokens rather than
    /// confidential ones. One approval, one call — no separate wrapping step.
    ///
    /// ⚠️ PRIVACY TRADEOFF, AND IT IS REAL. `amount` is a plain number in a plain ERC-20
    /// transfer, so **this deposit's size is public**. Everything afterwards is encrypted —
    /// the position, the odds, the winnings — but the entry itself is visible.
    ///
    /// Someone who already holds the confidential token should use {deposit} instead,
    /// where the amount never appears in the clear. Anyone wanting both convenience and
    /// privacy can shield at one time and deposit at another, so the two are not linkable
    /// by size or timing. This mirrors the tradeoff in Zama's own confidential vault and
    /// is documented in `docs/THREAT-MODEL.md`.
    function depositUnderlying(uint256 amount) external {
        if (!supportsAutoShield()) revert NoUnderlyingToken();
        if (amount == 0) revert ZeroAmount();

        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
        underlyingToken.forceApprove(address(token), amount);

        // The wrapper mints to us and grants transient access to the caller — us.
        euint64 minted = IConfidentialWrapper(address(token)).wrap(address(this), amount);
        FHE.allowThis(minted);

        uint16 slot = _ensureSlot(msg.sender);
        // Credit the amount the wrapper actually minted, not the amount handed over: at a
        // rate above 1 those differ, and any remainder below the rate is not wrapped.
        _creditSlot(slot, minted);

        emit DepositedFromUnderlying(msg.sender, slot, amount);
    }

    /// @notice Take principal back out. Any amount, any time, no penalty.
    /// @dev Asking for more than you hold is clamped to your balance rather than reverted,
    /// because a ciphertext cannot be compared and branched on. Either way the caller
    /// receives exactly what they own and never less.
    ///
    /// Odds for the current period keep the credit already earned — leaving early costs
    /// you the remaining time, not the time you already served.
    function withdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        uint16 slot = slotOf(msg.sender);

        euint64 requested = FHE.fromExternal(encryptedAmount, inputProof);
        euint64 actual = _debitSlot(slot, requested);

        FHE.allowTransient(actual, address(token));
        token.confidentialTransfer(msg.sender, actual);

        emit Withdrawn(msg.sender, slot);
    }

    // -------------------------------------------------------------------------
    // Reading your own position
    // -------------------------------------------------------------------------

    /// @notice Compute your principal and authorise yourself to decrypt it.
    /// @dev A transaction, not a view — FHE operations mutate coprocessor state. Read the
    /// handle with {balanceHandle} afterwards and decrypt off-chain via EIP-712.
    ///
    /// Only the slot's owner can do this. Without that restriction anyone could grant
    /// themselves decryption rights over someone else's position.
    function refreshMyBalance() external {
        uint16 slot = slotOf(msg.sender);
        _settlePending(slot);

        euint64 b = _heldBy(slot);
        _balanceCache[slot] = b;
        FHE.allowThis(b);
        FHE.allow(b, msg.sender);
    }

    function balanceHandle(uint16 slot) external view returns (euint64) {
        return _balanceCache[slot];
    }

    /// @dev What a slot actually owns: what the tree holds plus anything won and not yet
    /// folded in. The split between the two is an implementation detail of when the
    /// ancestor sums get repaired — it must never be visible in a balance, or a winner
    /// would check straight after a draw and be told they had lost.
    function _heldBy(uint16 slot) private returns (euint64) {
        euint64 held = _balance[uint256(LEAF_OFFSET) + slot];
        euint64 pending = _pendingAward[slot];

        return euint64.unwrap(pending) == bytes32(0) ? held : FHE.add(held, pending);
    }

    /// @notice Recompute your balance and your odds together, in one transaction.
    /// @dev Purely a UX affordance, and a load-bearing one. Reading your own position
    /// needs an on-chain recompute because FHE operations mutate coprocessor state and so
    /// cannot be a free `view` call. Doing balance and weight as separate calls meant three
    /// wallet prompts to answer "what do I have?" — a signature and two transactions.
    /// This collapses it to a signature and one transaction.
    function refreshMyPosition() external {
        uint16 slot = slotOf(msg.sender);
        _settlePending(slot);
        uint256 node = uint256(LEAF_OFFSET) + slot;

        euint64 b = _heldBy(slot);
        _balanceCache[slot] = b;
        FHE.allowThis(b);
        FHE.allow(b, msg.sender);

        euint64 w = _weightOf(node);
        _cacheWeight(slot, w);
        FHE.allowThis(w);
        FHE.allow(w, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Prize reserve
    // -------------------------------------------------------------------------

    /// @notice Top up the pot. On testnet this stands in for a yield strategy; in
    /// production the same reserve would be fed by real yield. See the README.
    /// @dev Funded with plain tokens on purpose: the amount must be publicly verifiable,
    /// since prizes are public and nobody should have to take our word for the pot size.
    function fundPrizeReserve(uint256 amount) external onlyOwner {
        if (!supportsAutoShield()) revert NoUnderlyingToken();
        if (amount == 0) revert ZeroAmount();

        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
        underlyingToken.forceApprove(address(token), amount);
        IConfidentialWrapper(address(token)).wrap(address(this), amount);

        uint64 credited = uint64(amount / IConfidentialWrapper(address(token)).rate());
        prizeReserve += credited;

        emit ReserveFunded(credited, prizeReserve);
    }

    /// @notice Set the annual yield rate used to size each prize.
    function setAnnualRateBps(uint256 bps) external onlyOwner {
        require(bps <= 10_000, "Hushpot: rate above 100%");
        annualRateBps = bps;
        emit RateUpdated(bps);
    }

    /// @notice Prize a draw would pay at the given pool size, before the reserve cap.
    /// @dev Deliberately proportional to the pool. Because the pot grows with the deposits
    /// that fund it, a large depositor arriving takes more odds *and* contributes more
    /// prize — leaving everyone else's expected return exactly unchanged. A fixed pot
    /// would let latecomers extract value from existing depositors.
    function prizeFor(uint64 total) public view returns (uint64) {
        return uint64((uint256(total) * annualRateBps) / RATE_DIVISOR);
    }

    // -------------------------------------------------------------------------
    // Solvency
    // -------------------------------------------------------------------------

    /// @notice Encrypted answer to "is every deposit still backed?".
    ebool private _fullyBacked;

    /// @notice When solvency was last proven. Zero if never.
    uint256 public solvencyProvenAt;

    /// @notice Prove the pool holds at least as much as depositors are owed.
    ///
    /// @dev The obvious objection to a pool whose balances are encrypted is that nobody
    /// can check the money is still there. This answers it without giving anything up:
    /// the comparison runs on ciphertext, and the only thing made public is the single
    /// bit that comes out of it — backed, or not.
    ///
    /// Neither figure is revealed. Not what the pool holds, not what it owes, and
    /// certainly not any individual position.
    ///
    /// Callable by anyone, deliberately. A solvency proof nobody but the operator can
    /// trigger is not worth much.
    function proveSolvency() external {
        euint64 held = token.confidentialBalanceOf(address(this));
        euint64 owed = _balance[1]; // the tree root is total principal

        ebool backed = FHE.ge(held, owed);

        _fullyBacked = backed;
        FHE.allowThis(backed);
        FHE.makePubliclyDecryptable(backed);
        FHE.allow(backed, msg.sender);

        solvencyProvenAt = block.timestamp;
        emit SolvencyProven(block.timestamp);
    }

    /// @notice Handle for the last solvency proof. Publicly decryptable — that is the point.
    function solvencyHandle() external view returns (ebool) {
        return _fullyBacked;
    }

    // -------------------------------------------------------------------------
    // Draws
    // -------------------------------------------------------------------------

    /// @notice Whether the current period has run its course.
    function periodEnded() public view returns (bool) {
        return block.timestamp >= periodStart + PERIOD_SECONDS;
    }

    /// @notice Begin a draw by publishing the pool total for decryption.
    /// @dev Two steps are unavoidable: the draw point must be reduced modulo the pool
    /// total, and encrypted modulo requires a plain divisor. So the total — the one
    /// aggregate we publish anyway — is decrypted off-chain and returned with a proof.
    /// The randomness itself never leaves the chain and is never decrypted.
    ///
    /// Anyone may call this once the period has elapsed. The owner may call it early, so
    /// that a draw can be demonstrated without waiting a week.
    function openDraw() external {
        if (drawPending) revert DrawAlreadyPending();
        // One draw per period. Without this, anyone could re-open and re-settle after the
        // period ends and drain the prize reserve a draw at a time.
        if (drawCount > 0 && draws[drawCount - 1].period == currentPeriod) revert DrawAlreadySettledThisPeriod();
        if (!periodEnded() && msg.sender != owner()) revert PeriodNotElapsed();

        euint64 total = _weightOf(1);
        _pendingTotal = total;
        FHE.allowThis(total);
        FHE.makePubliclyDecryptable(total);
        drawPending = true;

        emit DrawOpened(drawCount, euint64.unwrap(total));
    }

    function pendingTotalHandle() external view returns (euint64) {
        return _pendingTotal;
    }

    /// @notice Finish the draw with the decrypted total and its proof.
    /// @dev {FHE.checkSignatures} reverts unless the cleartext genuinely matches the
    /// ciphertext, so whoever relays this cannot lie about the total — they can only
    /// decline to relay it at all. That is what keeps an off-chain step trustless.
    ///
    /// The draw point is then produced on-chain by the protocol's own generator and
    /// reduced into the pool's range. It stays encrypted forever: no one — not the caller,
    /// not the owner, not this contract — ever learns where it landed.
    function settleDraw(bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
        if (!drawPending) revert NoDrawPending();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(_pendingTotal);
        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);

        uint64 total = abi.decode(abiEncodedCleartexts, (uint64));
        if (total == 0) revert EmptyPool();

        uint64 prize = prizeFor(total);
        if (prize > prizeReserve) prize = prizeReserve;
        prizeReserve -= prize;

        // Uniform over the whole 64-bit range, then folded into [0, total). The residual
        // modulo bias is on the order of total / 2^64 — far below any observable effect.
        euint64 point = FHE.rem(FHE.randEuint64(), total);
        FHE.allowThis(point);

        uint256 id = drawCount;
        draws[id] = Draw({total: total, prize: prize, drawPoint: point, period: currentPeriod, settled: true});
        drawCount = id + 1;
        drawPending = false;

        emit DrawSettled(id, total, prize);
    }

    /// @notice Open the next period, closing the claim window on the last draw.
    function startNextPeriod() external {
        if (drawPending) revert DrawAlreadyPending();
        if (drawCount == 0 || draws[drawCount - 1].period != currentPeriod) revert DrawNotSettled();
        if (!periodEnded() && msg.sender != owner()) revert PeriodNotElapsed();

        _advancePeriod();
        emit PeriodStarted(currentPeriod);
    }

    // -------------------------------------------------------------------------
    // Claims
    // -------------------------------------------------------------------------

    /// @notice Evaluate a draw for one participant and pay them if they won.
    ///
    /// @dev Deliberately callable by anyone, for anyone. The result is encrypted either
    /// way, so the caller learns nothing — which means a keeper can sweep every
    /// participant after each draw and the prize simply *appears* in the winner's balance.
    /// Nobody has to remember to check, and because everyone gets checked, the fact that
    /// someone was checked says nothing about whether they won.
    ///
    /// A loser's claim adds an encrypted zero. On-chain it is indistinguishable from the
    /// winner's, down to the gas.
    ///
    /// Safe to run while the period is over but not yet rolled: once `minuteOfPeriod`
    /// saturates, deposits and withdrawals cancel out of the weight arithmetic exactly, so
    /// the numbers this draw was settled against cannot move underneath it.
    function checkClaim(uint256 drawId, address account) public {
        Draw storage d = draws[drawId];
        if (!d.settled) revert DrawNotSettled();
        if (d.period != currentPeriod) revert AlreadyChecked();

        uint16 slot = slotOf(account);
        if (claimChecked[drawId][slot]) revert AlreadyChecked();
        claimChecked[drawId][slot] = true;

        ebool won = _checkWin(slot, d.drawPoint);
        euint64 award = FHE.select(won, FHE.asEuint64(d.prize), FHE.asEuint64(0));

        // Parked, not credited. Crediting repairs all ten ancestor sums — thirty encrypted
        // additions — to deposit what is, for all but one checker, an encrypted zero. The
        // award joins the tree on this slot's next deposit or withdrawal, which walks that
        // path anyway. Winnings still join the principal, just one transaction later.
        _pendingAward[slot] = FHE.add(_pendingAward[slot], award);
        FHE.allowThis(_pendingAward[slot]);

        emit ClaimChecked(drawId, slot, msg.sender);
    }

    /// @notice Check a draw for a handful of participants in one transaction.
    ///
    /// @dev ⚠️ Not a whole-pool sweep, despite the shape. A single claim is roughly 60–80
    /// encrypted operations — the prefix walk, the range comparison, the select and the
    /// credit — so only about one or two fit inside the per-transaction HCU ceiling.
    /// Measured on Sepolia: ~2.4M gas each, and five together revert.
    ///
    /// A keeper should therefore page through participants with one transaction each
    /// rather than calling this with a long list. `hushpot:sweep` does exactly that.
    /// This exists for the small-batch case and to keep the loop skip-safe.
    ///
    /// Skips anyone already checked, so it is safe to re-run.
    function checkClaimBatch(uint256 drawId, address[] calldata accounts) external {
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            if (!hasSlot(account)) continue;
            if (claimChecked[drawId][slotOf(account)]) continue;
            checkClaim(drawId, account);
        }
    }

    /// @dev Running lower edge of the band, carried between pages of a sweep.
    mapping(uint256 => euint64) private _sweepEdge;

    /// @notice Next slot a sweep of this draw will process. Equal to `slotsUsed` when done.
    mapping(uint256 => uint16) public sweepCursor;

    error SweepOutOfOrder();

    /// @notice Pay out a draw across a range of slots in one transaction.
    ///
    /// @dev This is the cheap way to settle a draw, and the reason is structural rather than
    /// clever: a per-participant claim repeats work that is identical for everybody.
    ///
    /// Two costs disappear here.
    ///
    /// The prefix walk goes first. A lone claim climbs the tree to rederive the combined
    /// weight of everyone ordered before it — three additions per set bit of the slot index.
    /// Sweeping in slot order makes that a running total instead: `edge += weight`, one
    /// addition, and the weight was needed anyway.
    ///
    /// The credit walk goes second, and it is the larger of the two. `_creditSlot` repairs
    /// all ten ancestors, thirty encrypted additions, once per participant — rebuilding the
    /// same interior sums over and over to add an encrypted zero to everyone who lost. This
    /// parks the award on the slot instead and lets the next deposit or withdrawal fold it
    /// in, on a path walk that transaction was paying for regardless.
    ///
    /// What survives is about ten operations a slot: the weight, the two range comparisons,
    /// the select, and two additions.
    ///
    /// Pages are forced to run in order because the running edge only makes sense read
    /// left to right. Callers page until `sweepCursor` reaches `slotsUsed`; how many slots
    /// fit in one transaction is an HCU question, not a correctness one.
    ///
    /// Reveals nothing. Every slot in the range is treated identically, the award is
    /// `select(won, prize, 0)` for all of them, and the losers' encrypted zeros are
    /// indistinguishable from the winner's prize.
    function sweepRange(uint256 drawId, uint16 count) external {
        Draw storage d = draws[drawId];
        if (!d.settled) revert DrawNotSettled();
        if (d.period != currentPeriod) revert AlreadyChecked();

        uint16 from = sweepCursor[drawId];
        if (from >= slotsUsed) revert SweepOutOfOrder();

        uint16 to = from + count;
        if (to > slotsUsed) to = slotsUsed;

        euint64 edge = from == 0 ? _zero() : _sweepEdge[drawId];

        for (uint16 slot = from; slot < to; slot++) {
            edge = _sweepSlot(drawId, slot, edge);
        }

        _sweepEdge[drawId] = edge;
        FHE.allowThis(edge);
        sweepCursor[drawId] = to;
    }

    /// @dev One slot of a sweep. Split out only because the loop ran the stack out of depth.
    /// @return upper The band's upper edge, which is the next slot's lower edge.
    function _sweepSlot(uint256 drawId, uint16 slot, euint64 edge) private returns (euint64 upper) {
        Draw storage d = draws[drawId];

        upper = FHE.add(edge, _weightOf(uint256(LEAF_OFFSET) + slot));

        euint64 award = FHE.select(
            FHE.and(FHE.ge(d.drawPoint, edge), FHE.lt(d.drawPoint, upper)),
            FHE.asEuint64(d.prize),
            FHE.asEuint64(0)
        );

        _pendingAward[slot] = FHE.add(_pendingAward[slot], award);
        FHE.allowThis(_pendingAward[slot]);

        claimChecked[drawId][slot] = true;
        emit ClaimChecked(drawId, slot, msg.sender);
    }
}
