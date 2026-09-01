import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
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
 * Claim progress is counted, and counting it is all it does.
 *
 * There was briefly a gate here: the roll refused to run until every slot had been checked.
 * It read as safety and was not. Non-owners already wait out the thirty-day grace, by which
 * time a sweep has long since run, so the guard bound only the owner — and binding the owner
 * meant the cycle depended on an O(n) sweep somebody has to fund. A pool nobody swept
 * degraded from weekly to monthly and then forfeited the stragglers anyway, which is the
 * problem it was supposed to solve.
 *
 * The tree keeps a generation of history instead, so a claim outlives its period and the
 * roll costs nobody anything. See HushpotClaimAcrossRoll.ts. What survives here is the
 * bookkeeping: `covered` snapshots what a draw was responsible for, `checked` counts what
 * has answered, and both paths move the same counter so the console can report progress
 * without a gate behind it.
 */
describe("HushpotPool — claim progress bookkeeping", function () {
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

  /** Two depositors, a settled draw, and nobody checked yet. */
  async function settledDraw() {
    await join(alice);
    await join(bob);
    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
  }

  it("snapshots how many slots a draw covered", async function () {
    await settledDraw();
    expect((await pool.claims(0)).covered).to.eq(2);
    expect((await pool.claims(0)).checked).to.eq(0);
  });

  it("rolls with claims still outstanding, and leaves them answerable", async function () {
    await settledDraw();
    expect((await pool.claims(0)).checked).to.eq(0);

    // The roll is not gated on the sweep. Nobody has answered, and it proceeds anyway —
    // because the answer no longer expires with the period.
    await expect(pool.connect(owner).startNextPeriod()).to.not.be.reverted;
    await expect(pool.connect(alice).checkMyClaim(0)).to.not.be.reverted;
  });

  it("rolls once every slot has been checked", async function () {
    await settledDraw();
    const used = await pool.slotsUsed();
    for (let i = 0; i < Number(used); i++) await (await pool.sweepRange(0, 1)).wait();

    expect((await pool.claims(0)).checked).to.eq(2);
    await expect(pool.connect(owner).startNextPeriod()).to.not.be.reverted;
    expect(await pool.currentPeriod()).to.eq(1);
  });

  it("counts a depositor settling their own claim, not only a keeper's sweep", async function () {
    await settledDraw();

    // Alice answers for herself; Bob is swept. Both should move the same counter, or
    // self-service would leave the pool unable to roll.
    await (await pool.connect(alice).checkMyClaim(0)).wait();
    expect((await pool.claims(0)).checked).to.eq(1);

    await (await pool.connect(owner).checkClaim(0, bob.address)).wait();
    expect((await pool.claims(0)).checked).to.eq(2);

    await expect(pool.connect(owner).startNextPeriod()).to.not.be.reverted;
  });

  it("counts both paths toward the same figure", async function () {
    await settledDraw();
    await (await pool.connect(alice).checkMyClaim(0)).wait();
    await (await pool.connect(owner).checkClaim(0, bob.address)).wait();
    expect((await pool.claims(0)).checked, "self-service and a sweep count alike").to.eq(2);
  });

  it("does not require checks for slots that joined after the draw settled", async function () {
    await settledDraw();
    const used = await pool.slotsUsed();
    for (let i = 0; i < Number(used); i++) await (await pool.sweepRange(0, 1)).wait();

    // A latecomer has no claim on a draw that settled before they existed, so the snapshot
    // must not grow under them and wedge the roll shut.
    const [, , , late] = await ethers.getSigners();
    await join(late);
    expect(await pool.slotsUsed()).to.eq(3);
    expect((await pool.claims(0)).covered).to.eq(2);

    await expect(pool.connect(owner).startNextPeriod()).to.not.be.reverted;
  });
});
