// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";

import {ConfidentialTimeWeightedTree} from "../ConfidentialTimeWeightedTree.sol";

/// @title ConfidentialTreeHarness — test-only access to the accounting engine
/// @notice Exposes the tree's internals so its arithmetic can be tested against the
/// plaintext oracle in isolation, without a token, a draw, or slot assignment in the way.
///
/// @dev NOT FOR DEPLOYMENT. It credits slots without moving any tokens and reads any
/// slot's weight regardless of ownership — both of which would be critical holes in a real
/// pool. `HushpotPool` is the deployable contract.
contract ConfidentialTreeHarness is ConfidentialTimeWeightedTree {
    mapping(uint16 => ebool) private _winCache;
    mapping(uint16 => euint64) private _probeCache;

    /// @dev Publishes the live pool total on demand.
    ///
    /// Test-only, and this one especially: in a real pool it is a complete break of the
    /// encryption. Read the total, wait for a deposit, read it again, subtract. The
    /// deployable contract publishes the total only at a draw boundary for that reason.
    function refreshTotal() external {
        _refreshTotal();
        // Test-only convenience: hand the caller decrypt rights so a test can read the
        // figure directly. The production path publishes the total instead, and only at
        // a draw.
        FHE.allow(_totalCacheHandle(), msg.sender);
    }

    /// @dev Credits a slot out of thin air. Test-only, obviously.
    function depositTo(uint16 slot, externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        _reserve(slot);
        _creditSlot(slot, FHE.fromExternal(encryptedAmount, inputProof));
    }

    /// @dev Raise the slot high-water mark, which the pool gets for free from `_ensureSlot`.
    ///
    /// The tree only walks as far as the highest node covering `slotsUsed`, so writing to a
    /// slot without counting it leaves the walk stopping short and every sum reading zero.
    /// `HushpotPool` cannot hit this — it hands out slots sequentially — but this harness
    /// writes to arbitrary slots on purpose, so it has to declare them.
    function _reserve(uint16 slot) private {
        if (slot >= slotsUsed) slotsUsed = slot + 1;
    }

    function withdrawFrom(uint16 slot, externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        _reserve(slot);
        _debitSlot(slot, FHE.fromExternal(encryptedAmount, inputProof));
    }

    function advancePeriod() external {
        _advancePeriod();
    }

    /// @dev Reads any slot's weight, ignoring ownership. Test-only.
    function probeWeight(uint16 slot) external {
        euint64 w = _weightOf(uint256(LEAF_OFFSET) + slot);
        _probeCache[slot] = w;
        FHE.allowThis(w);
        FHE.allow(w, msg.sender);
    }

    function probeHandle(uint16 slot) external view returns (euint64) {
        return _probeCache[slot];
    }

    /// @dev Evaluates a slot against a caller-supplied draw point. In the real pool the
    /// point comes from `FHE.randEuint64` and nobody can supply it — this exists so the
    /// encrypted result can be checked against known band boundaries.
    function checkWinAgainst(uint16 slot, externalEuint64 encryptedPoint, bytes calldata inputProof) external {
        ebool won = _checkWin(slot, FHE.fromExternal(encryptedPoint, inputProof));
        _winCache[slot] = won;
        FHE.allowThis(won);
        FHE.allow(won, msg.sender);
    }

    function winHandle(uint16 slot) external view returns (ebool) {
        return _winCache[slot];
    }
}
