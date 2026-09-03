import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  HushpotPool,
  HushpotPool__factory,
  TestConfidentialWrapper,
  TestConfidentialWrapper__factory,
  TestERC20,
  TestERC20__factory,
} from "../types";

/**
 * The loyalty boost: staying is worth more than arriving.
 *
 * Time-weighting already means a deposit made on the last day of a period carries almost
 * no weight for that period. What it did *not* mean was any advantage to staying past the
 * period you arrived in — week fifty looked exactly like week one, so the pool rewarded
 * showing up and never rewarded staying.
 *
 * The boost is opt-in and expires with the period, which is what keeps it O(1) per
 * depositor. These tests pin the properties that make it safe rather than merely generous:
 * it cannot be taken twice, it cannot be taken and then walked away from, the period you
 * arrive in is never one of the periods it credits, and the balance it multiplies is
 * anchored to what was actually held for that long — not whatever sits in the slot the
 * moment the button is pressed.
 */
describe("HushpotPool — loyalty boost", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  const AMOUNT = 1_000_000n;
  const PERIOD_MINUTES = 10_080n;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();

    [owner, alice, bob] = await ethers.getSigners();

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    pool = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await cusdt.getAddress(),
    )) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  async function join(who: HardhatEthersSigner, amount = AMOUNT) {
    await (await usdt.mint(who.address, amount)).wait();
    await (await usdt.connect(who).approve(poolAddress, amount)).wait();
    await (await pool.connect(who).depositUnderlying(amount)).wait();
  }

  async function fund(amount: bigint) {
    await (await usdt.mint(owner.address, amount)).wait();
    await (await usdt.connect(owner).approve(poolAddress, amount)).wait();
    await (await pool.connect(owner).fundPrizeReserve(amount)).wait();
  }

  /** Roll to the next period without letting any of the claim grace run down. */
  async function roll() {
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
    await (await pool.startNextPeriod()).wait();
  }

  /** A slot's own weight for this period, decrypted as its owner. */
  async function weight(who: HardhatEthersSigner) {
    await (await pool.connect(who).refreshMyWeight()).wait();
    const handle = await pool.weightHandle(await pool.slotOf(who.address));
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  /**
   * Roll with time passing, so draws age out of their claim grace. Needed past
   * MAX_HISTORY rolls, because {startNextPeriod} will not leave a live claim behind.
   */
  async function slowRoll() {
    await ethers.provider.send("evm_increaseTime", [31 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await roll();
  }

  it("offers nothing in the period you arrive in", async function () {
    await join(alice);
    expect(await pool.streakOf(alice.address)).to.eq(0);
    await expect(pool.connect(alice).boostStreak()).to.be.revertedWithCustomError(pool, "NoStreakYet");
  });

  it("still offers nothing after the first roll — that period was the join, not a held one", async function () {
    await join(alice);
    await roll();

    // currentPeriod has moved past the join, but alice has not yet lived through a full
    // period as a holder: she arrived partway through the period that just ended, however
    // late or early in it that happened to be. A minute-before-the-roll depositor and a
    // minute-after-the-open depositor must read identically here.
    expect(await pool.streakOf(alice.address)).to.eq(0);
    await expect(pool.connect(alice).boostStreak()).to.be.revertedWithCustomError(pool, "NoStreakYet");
  });

  it("credits one period only once a full period has elapsed since joining", async function () {
    await join(alice);
    await roll();
    await roll();

    expect(await pool.streakOf(alice.address)).to.eq(1);

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    const after = await weight(alice);

    // Five percent of a full period's ticket-minutes on this balance.
    expect(after - before).to.eq((AMOUNT * PERIOD_MINUTES * 5n) / 100n);
  });

  it("stops growing at the cap", async function () {
    await join(alice);
    for (let i = 0; i < 6; i++) await slowRoll();

    expect(await pool.streakOf(alice.address)).to.eq(await pool.MAX_BOOST_PERIODS());

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    expect((await weight(alice)) - before, "four periods' worth, not six").to.eq(
      (AMOUNT * PERIOD_MINUTES * 20n) / 100n,
    );
  });

  it("cannot be taken twice in one period", async function () {
    await join(alice);
    await roll();
    await roll();
    await (await pool.connect(alice).boostStreak()).wait();
    await expect(pool.connect(alice).boostStreak()).to.be.revertedWithCustomError(pool, "AlreadyBoosted");
  });

  it("commits the stake for the rest of the period", async function () {
    await join(alice);
    await roll();
    await roll();
    await (await pool.connect(alice).boostStreak()).wait();

    // Boost, then walk out with the principal, and the odds would have been free.
    await expect(pool.connect(alice).exitPool()).to.be.revertedWithCustomError(pool, "BoostLocked");

    const enc = await fhevm
      .createEncryptedInput(poolAddress, alice.address)
      .add64(AMOUNT / 2n)
      .encrypt();
    await expect(pool.connect(alice).withdraw(enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(
      pool,
      "BoostLocked",
    );
  });

  it("expires with the period, and frees the stake again", async function () {
    await join(alice);
    await roll();
    await roll();
    await (await pool.connect(alice).boostStreak()).wait();
    await roll();

    // The credit is period-scoped, so the new period starts from the plain stake again.
    expect(await weight(alice)).to.eq(AMOUNT * PERIOD_MINUTES);
    await expect(pool.connect(alice).exitPool()).to.not.be.reverted;
  });

  it("does not disturb anyone else's weight", async function () {
    await join(alice);
    await join(bob);
    await roll();
    await roll();

    const bobBefore = await weight(bob);
    await (await pool.connect(alice).boostStreak()).wait();
    expect(await weight(bob), "a boost is one slot's business").to.eq(bobBefore);
  });

  it("does not multiply a fresh top-up deposited right before boosting", async function () {
    // A tiny stake, held long enough to build the maximum streak.
    await join(alice, 1_000n);
    for (let i = 0; i < 5; i++) await slowRoll();
    expect(await pool.streakOf(alice.address)).to.eq(await pool.MAX_BOOST_PERIODS());

    // Immediately before boosting, dump in a large fresh deposit — the thing the streak
    // count alone cannot see, because slotAssignedAt only records when the slot opened.
    await join(alice, 500_000n);

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    const after = await weight(alice);

    // The boost applies to the balance as of the anchor period — 1,000, the amount that
    // was actually present for the whole credited window — not the 501,000 now sitting in
    // the slot. Twenty percent of the tiny original stake is a small, bounded number;
    // twenty percent of the fresh half-million would not be.
    expect(after - before).to.eq((1_000n * PERIOD_MINUTES * 20n) / 100n);
    expect(after - before).to.be.lt((500_000n * PERIOD_MINUTES * 20n) / 100n);
  });

  it("does not over-credit a balance that was partly withdrawn since the anchor", async function () {
    await join(alice, 100_000n);
    await roll();
    await roll();
    expect(await pool.streakOf(alice.address)).to.eq(1);

    // Withdraw most of it, but not all — the slot stays open, so the streak count is
    // untouched. Only exitPool resets slotAssignedAt.
    const enc = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(90_000n).encrypt();
    await (await pool.connect(alice).withdraw(enc.handles[0], enc.inputProof)).wait();

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    const after = await weight(alice);

    // min(current 10,000, anchor 100,000) = 10,000 — the boost cannot multiply money that
    // already left, even though the streak counter still says one period.
    expect(after - before).to.eq((10_000n * PERIOD_MINUTES * 5n) / 100n);
  });
});
