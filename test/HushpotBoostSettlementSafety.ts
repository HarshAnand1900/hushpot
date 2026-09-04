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
 * A boost must not be able to change a draw's numbers after they are fixed.
 *
 * Every other write to the tree is neutral once `minuteOfPeriod` saturates: a deposit or
 * withdrawal made in that window adds the same amount to `lateCredit`/`earlyExit` that it
 * adds to `balance`, so the two cancel and a settled draw's weights are untouched. That is
 * the property `HushpotClaimAcrossRoll.ts` relies on to say a claim is safe after the period
 * is over. `_creditBonus` (the loyalty boost) does not have it: it adds straight to
 * `earlyExit` with nothing offsetting it, because uncancelled weight is the entire point of
 * a boost.
 *
 * Without a guard, that gap meant a depositor could watch a draw settle, then call
 * `boostStreak()` before `checkClaim` had run for anyone, and widen their own band for a
 * total and drawPoint that were already fixed - silently capturing probability mass from
 * whoever's true, pre-boost band would otherwise have contained the draw point. Since
 * results stay encrypted, this would have been unfalsifiable after the fact: nobody would
 * ever know a win had been redirected.
 *
 * `boostStreak` now reverts once a draw already exists for the current period - open or
 * settled, not "the clock ran out": the owner may open a draw before the period has
 * elapsed, and the total is fixed the moment it opens regardless of `periodEnded()`.
 */
describe("HushpotPool - boost cannot move a settled draw's numbers", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  const AMOUNT = 1_000_000n;

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

  async function weight(who: HardhatEthersSigner) {
    await (await pool.connect(who).refreshMyWeight()).wait();
    const handle = await pool.weightHandle(await pool.slotOf(who.address));
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  async function draw() {
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
  }

  it("refuses a boost once this period already has a draw, even one the owner opened early", async function () {
    await join(alice);
    await join(bob);

    await draw(); // draw #0, period 0 - alice's join period, never credited
    await (await pool.startNextPeriod()).wait(); // period 1
    await draw(); // draw #1, period 1
    await (await pool.startNextPeriod()).wait(); // period 2 - alice has now held one full period (1)
    expect(await pool.streakOf(alice.address)).to.eq(1);

    // Draw #2, opened early by the owner: periodEnded() is still false, which is exactly
    // the case a naive fix on that flag would miss.
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();

    const draw2 = await pool.draws(2);
    expect(draw2.period).to.eq(2);

    const weightBefore = await weight(alice);

    // Draw #2 has settled and nobody has checked it yet. This is the exact window the
    // vulnerability lived in - alice has a real, eligible streak, not a zero one.
    await expect(pool.connect(alice).boostStreak()).to.be.revertedWithCustomError(pool, "PeriodEnded");

    const weightAfter = await weight(alice);
    expect(weightAfter).to.eq(weightBefore, "a rejected boost must leave the tree exactly as it was");
  });

  it("still works normally, mid-period, well before any draw exists", async function () {
    await join(alice);
    await draw();
    await (await pool.startNextPeriod()).wait(); // period 1 - alice's join period, not credited yet
    await draw();
    await (await pool.startNextPeriod()).wait(); // period 2 - one full period held, no draw yet this period
    expect(await pool.streakOf(alice.address)).to.eq(1);

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    const after = await weight(alice);

    expect(after).to.be.gt(before, "boosting is still the normal, working path before a draw exists");
  });
});
