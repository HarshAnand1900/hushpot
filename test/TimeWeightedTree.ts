import { expect } from "chai";
import { ethers } from "hardhat";

import { TimeWeightedTree, TimeWeightedTree__factory } from "../types";

const PERIOD = 10080n; // minutes in a week
const HALFWAY = PERIOD / 2n;

async function deployFixture(): Promise<TimeWeightedTree> {
  const factory = (await ethers.getContractFactory("TimeWeightedTree")) as TimeWeightedTree__factory;
  return (await factory.deploy()) as TimeWeightedTree;
}

describe("TimeWeightedTree", function () {
  let tree: TimeWeightedTree;

  beforeEach(async function () {
    tree = await deployFixture();
  });

  describe("credit is proportional to time held", function () {
    it("gives full credit to a deposit present for the whole period", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      expect(await tree.weightOf(3)).to.eq(100n * PERIOD);
    });

    it("gives half credit to a deposit made halfway through", async function () {
      await (await tree.deposit(3, 100, HALFWAY)).wait();
      expect(await tree.weightOf(3)).to.eq(100n * (PERIOD - HALFWAY));
    });

    it("gives almost nothing to a deposit made in the final minute", async function () {
      await (await tree.deposit(3, 100, PERIOD - 1n)).wait();
      expect(await tree.weightOf(3)).to.eq(100n * 1n);
    });

    it("gives nothing at all to a deposit made exactly at the deadline", async function () {
      await (await tree.deposit(3, 100, PERIOD)).wait();
      expect(await tree.weightOf(3)).to.eq(0n);
    });
  });

  describe("withdrawals keep the credit they earned", function () {
    it("credits a full exit for the time it was actually held", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await (await tree.withdraw(3, 100, HALFWAY)).wait();

      // Held 100 for half the week, nothing after.
      expect(await tree.weightOf(3)).to.eq(100n * HALFWAY);
      expect(await tree.balanceOf(3)).to.eq(0n);
    });

    it("handles a partial exit", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await (await tree.withdraw(3, 40, HALFWAY)).wait();

      // 100 for the first half, then 60 for the second half.
      const expected = 100n * HALFWAY + 60n * (PERIOD - HALFWAY);
      expect(await tree.weightOf(3)).to.eq(expected);
    });

    it("leaves nothing behind when someone deposits and exits immediately", async function () {
      await (await tree.deposit(3, 1_000_000, HALFWAY)).wait();
      await (await tree.withdraw(3, 1_000_000, HALFWAY)).wait();
      expect(await tree.weightOf(3)).to.eq(0n);
    });
  });

  describe("the late-deposit exploit is dead", function () {
    it("beats a 5x larger last-minute deposit with a small one held all week", async function () {
      // Alice: 100, in from the very start.
      await (await tree.deposit(3, 100, 0)).wait();
      // Bob: 500 — five times more — but only in for the final hour.
      await (await tree.deposit(7, 500, PERIOD - 60n)).wait();

      const alice = await tree.weightOf(3);
      const bob = await tree.weightOf(7);

      expect(alice).to.eq(100n * PERIOD); // 1,008,000
      expect(bob).to.eq(500n * 60n); //    30,000

      // Despite depositing five times as much, Bob's odds are a small fraction of Alice's.
      expect(alice).to.be.greaterThan(bob * 30n);
    });
  });

  describe("period rollover costs nothing and restores full credit", function () {
    it("promotes a late depositor to full credit next period, with no writes", async function () {
      await (await tree.deposit(3, 100, PERIOD - 60n)).wait();
      expect(await tree.weightOf(3)).to.eq(100n * 60n);

      // No per-user settlement — just move to the next period.
      await (await tree.advancePeriod()).wait();

      expect(await tree.weightOf(3)).to.eq(100n * PERIOD);
    });

    it("keeps balances across rollovers while resetting time corrections", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await (await tree.withdraw(3, 40, HALFWAY)).wait();
      await (await tree.advancePeriod()).wait();

      expect(await tree.balanceOf(3)).to.eq(60n);
      expect(await tree.weightOf(3)).to.eq(60n * PERIOD);
    });

    it("keeps the pool total correct across a rollover", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await (await tree.deposit(7, 300, HALFWAY)).wait();
      await (await tree.advancePeriod()).wait();

      expect(await tree.totalWeight()).to.eq(400n * PERIOD);
    });
  });

  describe("the pool total is read, never summed", function () {
    it("matches the sum of every participant's weight", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await (await tree.deposit(7, 300, HALFWAY)).wait();
      await (await tree.deposit(9, 250, 1234)).wait();
      await (await tree.withdraw(7, 100, 8000)).wait();

      const parts = [3, 7, 9];
      let summed = 0n;
      for (const slot of parts) summed += await tree.weightOf(slot);

      expect(await tree.totalWeight()).to.eq(summed);
    });
  });

  describe("bands still tile the number line exactly", function () {
    const slots = [3, 7, 9];

    beforeEach(async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await (await tree.deposit(7, 300, HALFWAY)).wait();
      await (await tree.deposit(9, 250, 1234)).wait();
    });

    it("starts the first band at zero and leaves no gaps", async function () {
      let cursor = 0n;
      for (const slot of slots) {
        expect(await tree.prefixWeight(slot), `band start for slot ${slot}`).to.eq(cursor);
        cursor += await tree.weightOf(slot);
      }
      // The last band ends exactly at the pool total — no gap, no overhang.
      expect(cursor).to.eq(await tree.totalWeight());
    });

    it("agrees with the reference walk at every band boundary", async function () {
      for (const slot of slots) {
        const lower = await tree.prefixWeight(slot);
        const upper = lower + (await tree.weightOf(slot));

        // First and last point of the band belong to this slot...
        expect(await tree.findLeaf(lower)).to.eq(slot);
        expect(await tree.findLeaf(upper - 1n)).to.eq(slot);
        expect(await tree.winsWith(slot, lower)).to.eq(true);
        expect(await tree.winsWith(slot, upper - 1n)).to.eq(true);

        // ...and the point just past it does not.
        expect(await tree.winsWith(slot, upper)).to.eq(false);
      }
    });

    it("never lets two participants claim the same draw point", async function () {
      const total = await tree.totalWeight();
      const probes = [0n, 1n, total / 7n, total / 3n, total / 2n, (total * 5n) / 6n, total - 1n];

      for (const point of probes) {
        let winners = 0;
        for (const slot of slots) {
          if (await tree.winsWith(slot, point)) winners++;
        }
        expect(winners, `exactly one winner expected at ${point}`).to.eq(1);
      }
    });

    it("gives a zero-weight slot an empty band", async function () {
      expect(await tree.winsWith(5, await tree.prefixWeight(5))).to.eq(false);
    });
  });

  describe("guards", function () {
    it("rejects a minute beyond the period", async function () {
      await expect(tree.deposit(3, 100, PERIOD + 1n)).to.be.reverted;
    });

    it("rejects withdrawing more than the balance", async function () {
      await (await tree.deposit(3, 100, 0)).wait();
      await expect(tree.withdraw(3, 101, HALFWAY)).to.be.reverted;
    });

    it("rejects an out-of-range slot", async function () {
      await expect(tree.deposit(1024, 100, 0)).to.be.reverted;
    });
  });
});
