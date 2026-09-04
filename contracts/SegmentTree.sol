// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title SegmentTree - plaintext prototype of Hushpot's weighted-selection structure
/// @notice This contract deliberately uses plain `uint64` instead of `euint64`.
///
/// Why plaintext first? Inside FHE every value is an opaque handle. If the tree
/// math is wrong you get no revert and no wrong number - just a silently wrong
/// winner, with nothing to print. So we get the structure provably correct in the
/// clear, then swap `uint64` -> `euint64`. That swap is mostly mechanical; the
/// logic below is the actual thinking.
///
/// LAYOUT
/// ------
/// A 1-indexed implicit binary tree stored in a flat array:
///
///   - node 1 is the root
///   - node `n` has children `2n` (left) and `2n + 1` (right)
///   - the 1024 leaves occupy indices 1024 .. 2047
///   - user slot `s` therefore lives at leaf index `LEAF_OFFSET + s`
///
/// INVARIANT: every internal node holds the sum of its entire subtree.
/// So node 1 always holds the total weight of every participant.
contract SegmentTree {
    /// @notice Number of participant slots (must be a power of two).
    uint16 public constant LEAF_COUNT = 1024;

    /// @notice Index of the first leaf. Slot `s` lives at `LEAF_OFFSET + s`.
    uint16 public constant LEAF_OFFSET = 1024;

    /// @dev Index 0 is unused so that the `2n` / `2n+1` child arithmetic works.
    uint64[2048] private _tree;

    /// @notice Set a participant's weight and restore the subtree-sum invariant.
    /// @param slot The participant slot, in [0, LEAF_COUNT).
    /// @param newValue The participant's new weight.
    ///
    /// @dev Only this leaf's direct ancestors can be affected by the change, and a
    /// leaf has exactly log2(LEAF_COUNT) = 10 of them. So the repair is 10 additions,
    /// not a full re-sum of the tree. That bound is the whole reason this structure
    /// is viable under FHE, where every one of those additions is expensive.
    function updateLeaf(uint16 slot, uint64 newValue) external {
        require(slot < LEAF_COUNT, "SegmentTree: slot out of range");

        uint256 node = uint256(LEAF_OFFSET) + slot;
        _tree[node] = newValue;

        // Walk to the root. Integer division by 2 moves to the parent, because
        // children 2n and 2n+1 both floor-divide back to n.
        node /= 2;
        while (node >= 1) {
            _tree[node] = _tree[2 * node] + _tree[2 * node + 1];
            node /= 2;
        }
    }

    /// @notice Total weight of every participant.
    /// @dev Free by the invariant: the root already is the sum of everything.
    function totalWeight() external view returns (uint64) {
        return _tree[1];
    }

    /// @notice Map a draw point onto the participant whose weight range contains it.
    /// @param drawPoint A value in [0, totalWeight()).
    /// @return slot The selected participant slot.
    ///
    /// @dev Think of every participant as occupying a contiguous band of the number
    /// line [0, totalWeight): slot A owns [0, wA), slot B owns [wA, wA + wB), and so
    /// on. `drawPoint` lands in exactly one band, and this descent finds which -
    /// without ever materialising those bands.
    ///
    /// At each node we ask a single question: does the draw point fall inside the
    /// left subtree's share? If yes, descend left unchanged. If no, the left subtree
    /// is entirely behind us, so we subtract its total and descend right - which
    /// re-expresses `drawPoint` as an offset *within* the right subtree, keeping the
    /// exact same question valid at the next level down.
    ///
    /// That single question is the only thing we will need to decrypt once this runs
    /// on ciphertext: one bit per level, ten bits total, and never a balance.
    function findLeaf(uint64 drawPoint) external view returns (uint16 slot) {
        // Out of range would walk off the right edge and return a meaningless slot.
        require(drawPoint < _tree[1], "SegmentTree: point out of range");

        uint256 node = 1;
        while (node < LEAF_OFFSET) {
            uint256 left = 2 * node;
            uint64 leftWeight = _tree[left];

            if (drawPoint < leftWeight) {
                node = left;
            } else {
                drawPoint -= leftWeight;
                node = left + 1;
            }
        }

        return uint16(node - LEAF_OFFSET);
    }

    /// @notice Combined weight of every slot ordered strictly before `slot`.
    /// @dev This is the lower edge of the slot's band on the number line, and it is the
    /// value Hushpot actually selects on. Reading it costs one walk to the root rather
    /// than a scan of every preceding leaf: climbing from the leaf, whenever we are a
    /// right child, our left sibling's entire subtree sits before us, so we add it once
    /// and skip everything inside it.
    ///
    /// Crucially this needs no knowledge of any other participant's individual weight,
    /// which is what lets it run against ciphertext later.
    function prefixSum(uint16 slot) public view returns (uint64 total) {
        require(slot < LEAF_COUNT, "SegmentTree: slot out of range");

        uint256 node = uint256(LEAF_OFFSET) + slot;
        while (node > 1) {
            if (node % 2 == 1) {
                total += _tree[node - 1];
            }
            node /= 2;
        }
    }

    /// @notice Whether `slot` holds the winning band for `drawPoint`.
    /// @dev The plaintext twin of Hushpot's claim check. Each participant can evaluate
    /// this for themselves without learning anything about anyone else - which is the
    /// whole reason the draw needs no central walk and reveals no winner.
    ///
    /// Under FHE this becomes two encrypted comparisons and an AND, with the result fed
    /// straight into a select. It is never decrypted; it only ever gates whether the
    /// prize or zero gets added to the caller's balance.
    function winsWith(uint16 slot, uint64 drawPoint) external view returns (bool) {
        uint64 lower = prefixSum(slot);
        uint64 weight = _tree[LEAF_OFFSET + slot];
        return drawPoint >= lower && drawPoint < lower + weight;
    }

    /// @notice Raw node accessor. Useful for asserting the invariant in tests.
    function nodeValue(uint256 index) external view returns (uint64) {
        return _tree[index];
    }

    /// @notice Weight currently stored for a participant slot.
    function leafValue(uint16 slot) external view returns (uint64) {
        require(slot < LEAF_COUNT, "SegmentTree: slot out of range");
        return _tree[LEAF_OFFSET + slot];
    }
}
