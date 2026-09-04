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
 * A deposit or withdrawal must be neutral for the whole time a draw is pending - not just
 * once the clock has genuinely run out.
 *
 * The rest of this design leans on one property: once `minuteOfPeriod` saturates, a deposit
 * adds the same amount to `lateCredit` that it adds to `balance`, so the two cancel and a
 * sealed total is untouched (a withdrawal cancels the same way, through `earlyExit`). Under
 * ordinary operation that property holds automatically, because `openDraw` will not let a
 * non-owner in before `periodEnded()` - by the time a draw can open at all without the
 * owner's help, the clock has already saturated.
 *
 * The owner's early-open exemption breaks that. Opening before `periodEnded()` snapshots
 * `_pendingTotal` while the clock has not yet saturated, and any deposit or withdrawal made
 * before the roll was then a live, uncancelled change to weight the snapshot never
 * accounted for - the same shape of gap `boostStreak` had, reached here through the
 * ordinary deposit path instead of the loyalty boost. `minuteOfPeriod` now saturates the
 * moment a draw is pending, not only once real time has elapsed, closing it without
 * touching deposits or withdrawals directly at all.
 */
describe("HushpotPool - deposits and withdrawals stay neutral while a draw is open early", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  const AMOUNT = 1_000_000n;
  const PERIOD_MINUTES = 10_080n;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    [, alice, bob] = await ethers.getSigners();
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

  async function weight(who: HardhatEthersSigner) {
    await (await pool.connect(who).refreshMyWeight()).wait();
    const handle = await pool.weightHandle(await pool.slotOf(who.address));
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  it("a fresh deposit made entirely after an early openDraw carries zero weight", async function () {
    expect(await pool.periodEnded()).to.eq(false);
    await (await pool.openDraw()).wait(); // owner, early
    expect(await pool.drawPending()).to.eq(true);

    await join(bob);
    expect(await weight(bob)).to.eq(0n, "the deposit must cancel exactly, not just partially");
  });

  it("a top-up made after an early openDraw adds nothing beyond what was already there", async function () {
    await join(alice);
    const before = await weight(alice);

    await (await pool.openDraw()).wait();
    await join(alice, AMOUNT); // top up the same slot, mid-window

    expect(await weight(alice)).to.eq(before, "topping up must not change the sealed period's weight");
  });

  it("a withdrawal made after an early openDraw does not shrink the sealed period's weight", async function () {
    await join(alice, AMOUNT * 2n);
    await (await pool.openDraw()).wait();

    const before = await weight(alice);
    const enc = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(AMOUNT).encrypt();
    await (await pool.connect(alice).withdraw(enc.handles[0], enc.inputProof)).wait();

    expect(await weight(alice)).to.eq(before, "a withdrawal must cancel exactly, the same as a deposit");
  });

  it("still accrues normally before any draw has opened", async function () {
    // Same setup, minus the early open - confirms the fix is scoped to drawPending and
    // does not flatten ordinary mid-period accrual.
    await join(alice);
    const before = await weight(alice);
    await join(bob);

    expect(await weight(bob)).to.be.gt(0n, "an ordinary deposit, with no draw pending, must still accrue");
    expect(await weight(alice)).to.eq(before, "and must not retroactively change anyone already in the tree");
  });

  it("does not disturb the published total itself", async function () {
    await join(alice);
    await (await pool.openDraw()).wait();
    const publishedBefore = await pool.pendingTotalHandle();

    await join(bob);

    // The snapshot is a fixed handle taken at openDraw; nothing after it can move what it
    // points to. This is the ciphertext-handle half of the same guarantee the weight
    // assertions above check in cleartext.
    expect(await pool.pendingTotalHandle()).to.eq(publishedBefore);
  });

  it("published total decrypts to exactly what accrued before the early open, unpolluted by what came after", async function () {
    await join(alice); // full period's worth of ticket-minutes
    await (await pool.openDraw()).wait();
    await join(bob); // must not leak into the total about to be decrypted

    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    const total = BigInt(Object.values(res.clearValues ?? {})[0] as string | bigint);

    expect(total).to.eq(
      AMOUNT * PERIOD_MINUTES,
      "bob's deposit must not appear in the total this draw settles against",
    );
  });
});
