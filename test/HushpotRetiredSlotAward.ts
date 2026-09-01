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
 * A prize parked on a slot nobody owns must not follow the slot to its next occupant.
 *
 * The path: a depositor holds for part of a period and leaves. `exitPool` clears
 * `slotOwner`, but the slot keeps its place until the period rolls and its weight for the
 * period is real — the stake was held for part of it, so the band is not empty and the
 * draw point can land inside it. A sweep then evaluates that band and parks the award.
 *
 * `_pendingAward` carries no period stamp, unlike `_lateCredit` and `_earlyExit`, so
 * retiring a slot and recycling it does not clear it, and `_ensureSlot` reuses the slot
 * believing there is nothing left on it.
 *
 * The draw point is random, so a test that merely runs the scenario catches this about
 * half the time. Weights here are lopsided by a factor of ~10^9 so the retired band covers
 * effectively the whole number line, which pins the outcome.
 */
describe("HushpotPool — awards on retired slots", function () {
  let owner: HardhatEthersSigner;
  let leaver: HardhatEthersSigner;
  let joiner: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  /** Enough that the leaver's partial-period weight dwarfs a full-period dust deposit. */
  const BIG = 1_000_000_000n;
  const DUST = 1n;
  const JOIN = 1_000_000n;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();

    [owner, leaver, joiner] = await ethers.getSigners();

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    pool = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await cusdt.getAddress(),
    )) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  async function join(who: HardhatEthersSigner, amount: bigint) {
    await (await usdt.mint(who.address, amount)).wait();
    await (await usdt.connect(who).approve(poolAddress, amount)).wait();
    await (await pool.connect(who).depositUnderlying(amount)).wait();
  }

  async function fund(amount: bigint) {
    await (await usdt.mint(owner.address, amount)).wait();
    await (await usdt.connect(owner).approve(poolAddress, amount)).wait();
    await (await pool.connect(owner).fundPrizeReserve(amount)).wait();
  }

  async function settle() {
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
  }

  it("does not hand a departed slot's award to whoever inherits the slot", async function () {
    await join(leaver, BIG);
    await join(owner, DUST);
    const slot = await pool.slotOf(leaver.address);

    // Hold most of the period, then leave. The balance goes to zero; the weight earned
    // over the days it was held does not.
    await ethers.provider.send("evm_increaseTime", [6 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(leaver).exitPool()).wait();
    expect(await pool.slotOwner(slot)).to.eq(ethers.ZeroAddress);

    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();

    await settle();

    // Precondition, asserted rather than assumed: the retired slot still carries the
    // weight it earned. If exiting zeroed it, the published total would be the dust
    // deposit's ~10,080 ticket-minutes and this whole path would be unreachable.
    const published = (await pool.draws(0)).total;
    expect(published, "a retired slot should still carry its earned weight").to.be.greaterThan(1_000_000_000n);
    const used = await pool.slotsUsed();
    for (let i = 0; i < Number(used); i++) await (await pool.sweepRange(0, 1)).wait();

    // Roll, which releases the retired slot for reuse, then hand it to somebody new.
    await (await pool.startNextPeriod()).wait();
    await join(joiner, JOIN);
    expect(await pool.slotOf(joiner.address), "the joiner should inherit the retired slot").to.eq(slot);

    // A second deposit walks the tree, which is what folds anything parked on the slot.
    await join(joiner, JOIN);

    await (await pool.connect(joiner).refreshMyBalance()).wait();
    const balance = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.balanceHandle(slot),
      poolAddress,
      joiner,
    );
    expect(balance, "the joiner's balance should be their own deposits and nothing else").to.eq(JOIN * 2n);
  });

  it("stays solvent when a retired slot's award is dropped", async function () {
    // Skipping the award raises a fair question about the books. The prize leaves
    // `prizeReserve` at settlement, and with nobody to park it on it is never added to
    // `_parkedTotal` either — so the tokens stay in the contract while the liability does
    // not grow. That has to leave the pool over-collateralised rather than under, and the
    // direction of the error is the whole point of asserting it.
    await join(leaver, BIG);
    await join(owner, JOIN);

    await ethers.provider.send("evm_increaseTime", [6 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(leaver).exitPool()).wait();

    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    await settle();

    const used = await pool.slotsUsed();
    for (let i = 0; i < Number(used); i++) await (await pool.sweepRange(0, 1)).wait();

    await (await pool.connect(owner).proveSolvency()).wait();
    expect(await fhevm.publicDecryptEbool(await pool.solvencyHandle()), "pool must remain fully backed").to.eq(true);
  });

  it("leaves every other band where it was when a retired slot is swept", async function () {
    await join(leaver, BIG);
    await join(owner, JOIN);

    await ethers.provider.send("evm_increaseTime", [3 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(leaver).exitPool()).wait();

    await ethers.provider.send("evm_increaseTime", [5 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    await settle();

    // Skipping a retired slot's award must not skip its band, or every slot after it
    // shifts and the partition stops summing to the total.
    const used = await pool.slotsUsed();
    for (let i = 0; i < Number(used); i++) await (await pool.sweepRange(0, 1)).wait();
    expect(await pool.sweepCursor(0)).to.eq(used);
    expect(await pool.claimChecked(0, await pool.slotOf(owner.address))).to.eq(true);
  });
});
