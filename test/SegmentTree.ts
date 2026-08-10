import { expect } from "chai";
import { ethers } from "hardhat";

import { SegmentTree, SegmentTree__factory } from "../types";

const LEAF_OFFSET = 1024;

async function deployFixture(): Promise<SegmentTree> {
  const factory = (await ethers.getContractFactory("SegmentTree")) as SegmentTree__factory;
  return (await factory.deploy()) as SegmentTree;
}

/**
 * Walk every draw point in [0, total) and record which slot the tree selects.
 * Returns a map of slot -> number of draw points that landed on it.
 *
 * This is the heart of the suite: the count for each slot IS that slot's
 * selection probability numerator. If the structure is correct, the counts must
 * equal the weights exactly — not approximately.
 */
async function tallySelections(tree: SegmentTree, total: number): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (let drawPoint = 0; drawPoint < total; drawPoint++) {
    const slot = Number(await tree.findLeaf(drawPoint));
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  return counts;
}

/** Assert the subtree-sum invariant along every ancestor of a given slot. */
async function expectInvariantAlongPath(tree: SegmentTree, slot: number): Promise<void> {
  let node = Math.floor((LEAF_OFFSET + slot) / 2);
  while (node >= 1) {
    const parent = await tree.nodeValue(node);
    const left = await tree.nodeValue(2 * node);
    const right = await tree.nodeValue(2 * node + 1);
    expect(parent, `node ${node} must equal the sum of its children`).to.eq(left + right);
    node = Math.floor(node / 2);
  }
}

describe("SegmentTree", function () {
  let tree: SegmentTree;

  beforeEach(async function () {
    tree = await deployFixture();
  });

  it("starts with zero total weight", async function () {
    expect(await tree.totalWeight()).to.eq(0);
  });

  it("stores a single leaf and propagates it to the root", async function () {
    await (await tree.updateLeaf(3, 50)).wait();

    expect(await tree.leafValue(3)).to.eq(50);
    expect(await tree.totalWeight()).to.eq(50);
    await expectInvariantAlongPath(tree, 3);
  });

  it("sums several leaves into the root", async function () {
    await (await tree.updateLeaf(3, 50)).wait();
    await (await tree.updateLeaf(7, 30)).wait();
    await (await tree.updateLeaf(9, 20)).wait();

    expect(await tree.totalWeight()).to.eq(100);
    await expectInvariantAlongPath(tree, 3);
    await expectInvariantAlongPath(tree, 7);
    await expectInvariantAlongPath(tree, 9);
  });

  it("selects each slot exactly as many times as its weight (exhaustive)", async function () {
    // slot -> weight
    const weights = new Map<number, number>([
      [3, 50],
      [7, 30],
      [9, 20],
    ]);
    for (const [slot, weight] of weights) {
      await (await tree.updateLeaf(slot, weight)).wait();
    }

    const total = Number(await tree.totalWeight());
    expect(total).to.eq(100);

    const counts = await tallySelections(tree, total);

    // Every draw point must land on a slot that actually has weight.
    for (const slot of counts.keys()) {
      expect(weights.has(slot), `slot ${slot} has zero weight but was selected`).to.eq(true);
    }

    // And each slot must be selected exactly `weight` times out of `total`.
    // This is an exhaustive proof of exact proportionality: no sampling, no
    // tolerance. It catches every off-by-one in the descent.
    for (const [slot, weight] of weights) {
      expect(counts.get(slot) ?? 0, `slot ${slot} selection count`).to.eq(weight);
    }
  });

  it("never selects a slot whose weight is zero", async function () {
    await (await tree.updateLeaf(3, 50)).wait();
    await (await tree.updateLeaf(7, 30)).wait();
    // slot 5 is deliberately left at zero
    const counts = await tallySelections(tree, Number(await tree.totalWeight()));
    expect(counts.get(5) ?? 0).to.eq(0);
  });

  it("re-weights correctly when a leaf changes", async function () {
    await (await tree.updateLeaf(3, 50)).wait();
    await (await tree.updateLeaf(7, 30)).wait();
    await (await tree.updateLeaf(9, 20)).wait();

    // Alice (slot 3) withdraws most of her stake: 50 -> 10.
    await (await tree.updateLeaf(3, 10)).wait();

    const total = Number(await tree.totalWeight());
    expect(total).to.eq(60);

    const counts = await tallySelections(tree, total);
    expect(counts.get(3) ?? 0).to.eq(10);
    expect(counts.get(7) ?? 0).to.eq(30);
    expect(counts.get(9) ?? 0).to.eq(20);
  });

  it("drops a participant entirely when their weight goes to zero", async function () {
    await (await tree.updateLeaf(3, 50)).wait();
    await (await tree.updateLeaf(7, 30)).wait();
    await (await tree.updateLeaf(3, 0)).wait();

    expect(await tree.totalWeight()).to.eq(30);
    const counts = await tallySelections(tree, 30);
    expect(counts.get(3) ?? 0).to.eq(0);
    expect(counts.get(7) ?? 0).to.eq(30);
  });

  it("handles a lone participant winning every draw point", async function () {
    await (await tree.updateLeaf(1000, 7)).wait();
    const counts = await tallySelections(tree, 7);
    expect(counts.get(1000) ?? 0).to.eq(7);
  });

  it("works for leaves at both edges of the tree", async function () {
    await (await tree.updateLeaf(0, 4)).wait();
    await (await tree.updateLeaf(1023, 6)).wait();

    expect(await tree.totalWeight()).to.eq(10);
    const counts = await tallySelections(tree, 10);
    expect(counts.get(0) ?? 0).to.eq(4);
    expect(counts.get(1023) ?? 0).to.eq(6);
  });

  it("rejects a draw point at or beyond the total weight", async function () {
    await (await tree.updateLeaf(3, 50)).wait();

    // Valid range is [0, 50). 50 itself is one past the end.
    await expect(tree.findLeaf(50)).to.be.reverted;
    await expect(tree.findLeaf(9999)).to.be.reverted;
  });

  it("rejects an out-of-range slot", async function () {
    await expect(tree.updateLeaf(1024, 1)).to.be.reverted;
  });

  // ---------------------------------------------------------------------------
  // Hushpot does not walk the tree to find a winner. Each participant checks
  // their own band independently, which is what keeps the winner unknown even to
  // the contract. These tests prove that self-check is exactly equivalent to the
  // centralised walk — same winner, every time — before we commit it to FHE.
  // ---------------------------------------------------------------------------
  describe("self-check selection (the mechanism Hushpot actually uses)", function () {
    const weights = new Map<number, number>([
      [3, 50],
      [7, 30],
      [9, 20],
    ]);

    beforeEach(async function () {
      for (const [slot, weight] of weights) {
        await (await tree.updateLeaf(slot, weight)).wait();
      }
    });

    it("places each slot's band immediately after the one before it", async function () {
      // Bands must tile [0, total) with no gap and no overlap: slot 3 owns [0,50),
      // slot 7 owns [50,80), slot 9 owns [80,100).
      expect(await tree.prefixSum(3)).to.eq(0);
      expect(await tree.prefixSum(7)).to.eq(50);
      expect(await tree.prefixSum(9)).to.eq(80);
    });

    it("gives an empty slot a zero-width band", async function () {
      // Slot 5 sits between 3 and 7, so it inherits slot 3's upper edge — and with
      // zero weight its band is empty, meaning no draw point can ever land in it.
      expect(await tree.prefixSum(5)).to.eq(50);
      expect(await tree.winsWith(5, 50)).to.eq(false);
    });

    it("agrees with the tree walk on every possible draw point", async function () {
      const total = Number(await tree.totalWeight());

      for (let drawPoint = 0; drawPoint < total; drawPoint++) {
        const walked = Number(await tree.findLeaf(drawPoint));

        // The winner found by walking must confirm itself when it self-checks...
        expect(await tree.winsWith(walked, drawPoint), `slot ${walked} should win at ${drawPoint}`).to.eq(true);

        // ...and every other participant must independently conclude they lost.
        for (const slot of weights.keys()) {
          if (slot === walked) continue;
          expect(await tree.winsWith(slot, drawPoint), `slot ${slot} should lose at ${drawPoint}`).to.eq(false);
        }
      }
    });

    it("never lets two participants both claim the same draw point", async function () {
      const total = Number(await tree.totalWeight());

      for (let drawPoint = 0; drawPoint < total; drawPoint++) {
        let winners = 0;
        for (const slot of weights.keys()) {
          if (await tree.winsWith(slot, drawPoint)) winners++;
        }
        expect(winners, `exactly one winner expected at draw point ${drawPoint}`).to.eq(1);
      }
    });
  });
});
