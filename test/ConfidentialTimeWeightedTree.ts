import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { ConfidentialTreeHarness, ConfidentialTreeHarness__factory } from "../types";

const PERIOD_MINUTES = 10080n;
const PERIOD_SECONDS = PERIOD_MINUTES * 60n;

describe("ConfidentialTimeWeightedTree", function () {
  let alice: HardhatEthersSigner;
  let pool: ConfidentialTreeHarness;
  let poolAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    alice = signers[1];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This suite only runs against the FHEVM mock environment");
      this.skip();
    }

    const factory = (await ethers.getContractFactory("ConfidentialTreeHarness")) as ConfidentialTreeHarness__factory;
    pool = (await factory.deploy()) as ConfidentialTreeHarness;
    poolAddress = await pool.getAddress();
  });

  /** Encrypt a plain amount for this contract, as `who`. */
  async function encrypt(amount: bigint, who: HardhatEthersSigner) {
    return fhevm.createEncryptedInput(poolAddress, who.address).add64(amount).encrypt();
  }

  async function deposit(slot: number, amount: bigint, who: HardhatEthersSigner = alice) {
    const enc = await encrypt(amount, who);
    await (await pool.connect(who).depositTo(slot, enc.handles[0], enc.inputProof)).wait();
  }

  async function withdraw(slot: number, amount: bigint, who: HardhatEthersSigner = alice) {
    const enc = await encrypt(amount, who);
    await (await pool.connect(who).withdrawFrom(slot, enc.handles[0], enc.inputProof)).wait();
  }

  /** Compute a slot's ticket-minutes on-chain, then decrypt it as `who`. */
  async function readWeight(slot: number, who: HardhatEthersSigner = alice): Promise<bigint> {
    await (await pool.connect(who).probeWeight(slot)).wait();
    const handle = await pool.probeHandle(slot);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  async function readTotal(who: HardhatEthersSigner = alice): Promise<bigint> {
    await (await pool.connect(who).refreshTotal()).wait();
    const handle = await pool.totalHandle();
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  async function readWin(slot: number, point: bigint, who: HardhatEthersSigner = alice): Promise<boolean> {
    const enc = await encrypt(point, who);
    await (await pool.connect(who).checkWinAgainst(slot, enc.handles[0], enc.inputProof)).wait();
    const handle = await pool.winHandle(slot);
    return fhevm.userDecryptEbool(handle, poolAddress, who);
  }

  describe("credit is proportional to time held", function () {
    it("gives full credit to a deposit present from the start", async function () {
      await deposit(3, 100n);
      expect(await readWeight(3)).to.eq(100n * PERIOD_MINUTES);
    });

    it("gives half credit to a deposit made halfway through", async function () {
      await time.increase(PERIOD_SECONDS / 2n);
      await deposit(3, 100n);

      // Deposited at minute 5040, so it earns the remaining 5040 minutes.
      expect(await readWeight(3)).to.eq(100n * 5040n);
    });

    it("gives almost nothing to a deposit made in the final hour", async function () {
      await time.increase((PERIOD_MINUTES - 60n) * 60n);
      await deposit(3, 100n);

      expect(await readWeight(3)).to.eq(100n * 60n);
    });
  });

  describe("withdrawals keep the credit they earned", function () {
    it("credits a full exit for the time it was actually held", async function () {
      await deposit(3, 100n);
      await time.increase(PERIOD_SECONDS / 2n);
      await withdraw(3, 100n);

      expect(await readWeight(3)).to.eq(100n * 5040n);
    });

    it("handles a partial exit", async function () {
      await deposit(3, 100n);
      await time.increase(PERIOD_SECONDS / 2n);
      await withdraw(3, 40n);

      // 100 for the first half, then 60 for the second.
      expect(await readWeight(3)).to.eq(100n * 5040n + 60n * 5040n);
    });

    it("clamps an over-withdrawal instead of reverting", async function () {
      await deposit(3, 100n);
      await time.increase(PERIOD_SECONDS / 2n);

      // Asking for 999 against a balance of 100 must not revert - a ciphertext cannot be
      // compared and branched on, so the request is clamped to what is actually held.
      await withdraw(3, 999n);

      expect(await readWeight(3)).to.eq(100n * 5040n);

      // And the balance really is empty: next period they carry nothing.
      await (await pool.advancePeriod()).wait();
      expect(await readWeight(3)).to.eq(0n);
    });
  });

  describe("the late-deposit exploit is dead", function () {
    it("beats a 5x larger last-hour deposit with a small one held all week", async function () {
      await deposit(3, 100n); // Alice, in from the start
      await time.increase((PERIOD_MINUTES - 60n) * 60n);
      await deposit(7, 500n); // Bob, five times bigger, one hour to go

      const aliceWeight = await readWeight(3);
      const bobWeight = await readWeight(7);

      expect(aliceWeight).to.eq(100n * PERIOD_MINUTES); // 1,008,000
      expect(bobWeight).to.eq(500n * 60n); //                30,000
      expect(aliceWeight).to.be.greaterThan(bobWeight * 30n);
    });
  });

  describe("period rollover costs nothing and restores full credit", function () {
    it("promotes a late depositor to full credit next period, with no writes", async function () {
      await time.increase((PERIOD_MINUTES - 60n) * 60n);
      await deposit(3, 100n);
      expect(await readWeight(3)).to.eq(100n * 60n);

      // No per-user settlement. Just open the next period.
      await (await pool.advancePeriod()).wait();

      expect(await readWeight(3)).to.eq(100n * PERIOD_MINUTES);
    });

    it("keeps balances across rollovers while clearing time corrections", async function () {
      await deposit(3, 100n);
      await time.increase(PERIOD_SECONDS / 2n);
      await withdraw(3, 40n);
      await (await pool.advancePeriod()).wait();

      expect(await readWeight(3)).to.eq(60n * PERIOD_MINUTES);
    });
  });

  describe("the pool total is read from the root, never summed", function () {
    it("matches the sum of every participant's weight", async function () {
      await deposit(3, 100n);
      await deposit(7, 300n);
      await time.increase(PERIOD_SECONDS / 2n);
      await deposit(9, 250n);

      const parts = [3, 7, 9];
      let summed = 0n;
      for (const slot of parts) summed += await readWeight(slot);

      expect(await readTotal()).to.eq(summed);
    });
  });

  describe("the encrypted win check", function () {
    // Two participants, both in from the start, so the bands are easy to state exactly:
    //   slot 3 owns [0, 1_008_000)
    //   slot 7 owns [1_008_000, 4_032_000)
    const ALICE_BAND = 100n * PERIOD_MINUTES; // 1,008,000
    const BOB_BAND = 300n * PERIOD_MINUTES; //   3,024,000

    beforeEach(async function () {
      await deposit(3, 100n);
      await deposit(7, 300n);
    });

    it("puts the bands where the plaintext version does", async function () {
      expect(await readWeight(3)).to.eq(ALICE_BAND);
      expect(await readWeight(7)).to.eq(BOB_BAND);
      expect(await readTotal()).to.eq(ALICE_BAND + BOB_BAND);
    });

    it("awards the first band to the first slot", async function () {
      expect(await readWin(3, 0n)).to.eq(true);
      expect(await readWin(3, ALICE_BAND - 1n)).to.eq(true);
    });

    it("stops exactly at the band edge", async function () {
      expect(await readWin(3, ALICE_BAND)).to.eq(false);
      expect(await readWin(7, ALICE_BAND)).to.eq(true);
    });

    it("awards the far end of the range to the last slot", async function () {
      expect(await readWin(7, ALICE_BAND + BOB_BAND - 1n)).to.eq(true);
      expect(await readWin(3, ALICE_BAND + BOB_BAND - 1n)).to.eq(false);
    });

    it("never lets two participants win the same point", async function () {
      const probes = [0n, 1n, ALICE_BAND - 1n, ALICE_BAND, ALICE_BAND + 500n, ALICE_BAND + BOB_BAND - 1n];

      for (const point of probes) {
        const aliceWon = await readWin(3, point);
        const bobWon = await readWin(7, point);
        expect([aliceWon, bobWon].filter(Boolean).length, `exactly one winner at ${point}`).to.eq(1);
      }
    });

    it("gives an empty slot no winning point at all", async function () {
      expect(await readWin(5, 0n)).to.eq(false);
      expect(await readWin(5, ALICE_BAND)).to.eq(false);
      expect(await readWin(5, ALICE_BAND + BOB_BAND - 1n)).to.eq(false);
    });
  });

  describe("guards", function () {
    it("rejects an out-of-range slot", async function () {
      // Read the cap rather than hard-coding it, so raising capacity does not silently
      // turn this into a test of a valid slot.
      const cap = await pool.LEAF_COUNT();
      const enc = await encrypt(100n, alice);
      await expect(pool.connect(alice).depositTo(cap, enc.handles[0], enc.inputProof)).to.be.reverted;
    });
  });
});
