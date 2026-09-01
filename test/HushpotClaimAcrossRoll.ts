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
 * A claim must survive its own period rolling.
 *
 * A claim recomputes a band from the tree, and the tree is period-scoped: roll, and the
 * corrections age out while balances keep moving. The band moves with them, so the same
 * call after a roll used to return a *different* answer rather than a stale one — which is
 * why it was refused outright, and why anybody not swept in time simply forfeited.
 *
 * Each node now keeps one generation of history, written copy-on-write on its first touch
 * in a new period. These tests pin the property that buys: an answer given after the roll
 * is the same answer that would have been given before it.
 *
 * The failure modes this is aimed at are all silent — they return a plausible number on
 * encrypted values nobody can eyeball — so every assertion here compares against a figure
 * captured while the period was still current.
 */
describe("HushpotPool — claims across a roll", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  const AMOUNT = 1_000_000n;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();

    [owner, alice, bob, carol] = await ethers.getSigners();

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

  async function runDraw() {
    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
  }

  /** What a draw awarded a slot, read from the receipt only its owner can open. */
  async function award(drawId: number, who: HardhatEthersSigner) {
    const slot = await pool.slotOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, await pool.awardOf(drawId, slot), poolAddress, who);
  }

  it("answers a draw after its period has rolled", async function () {
    await join(alice);
    await join(bob);
    await runDraw();

    // Roll with nobody checked — which used to forfeit both of them outright.
    await (await pool.startNextPeriod()).wait();
    expect(await pool.currentPeriod()).to.eq(1);

    await expect(pool.connect(alice).checkMyClaim(0)).to.not.be.reverted;
    await expect(pool.connect(owner).checkClaim(0, bob.address)).to.not.be.reverted;
  });

  it("gives the same answer after the roll as it would have before", async function () {
    await join(alice);
    await join(bob);
    await runDraw();

    // Alice settles while her period is still current; Bob waits until after the roll.
    await (await pool.connect(alice).checkMyClaim(0)).wait();
    const aliceGot = await award(0, alice);

    await (await pool.startNextPeriod()).wait();
    await (await pool.connect(owner).checkClaim(0, bob.address)).wait();
    const bobGot = await award(0, bob);

    // Exactly one of them holds the prize, and the total handed out is exactly the prize.
    // If the post-roll band had shifted, this is where it shows: either both would win,
    // or neither would.
    const prize = (await pool.draws(0)).prize;
    expect(aliceGot + bobGot, "one prize, paid once, across the roll").to.eq(prize);
  });

  it("is not disturbed by deposits made after the draw settled", async function () {
    await join(alice);
    await join(bob);
    await runDraw();
    const prize = (await pool.draws(0)).prize;

    // A third depositor arrives and an existing one tops up, both after settlement. Their
    // writes are what force the copy-on-write, so this is the case where a missed archive
    // would corrupt the answer.
    await (await pool.startNextPeriod()).wait();
    await join(carol);
    await join(alice);

    await (await pool.connect(owner).checkClaim(0, alice.address)).wait();
    await (await pool.connect(owner).checkClaim(0, bob.address)).wait();
    const total = (await award(0, alice)) + (await award(0, bob));
    expect(total, "the draw's own weights, not the ones that replaced them").to.eq(prize);

    // Carol was not in the draw, so she has no claim on it.
    await expect(pool.connect(owner).checkClaim(0, carol.address)).to.not.be.reverted;
    expect(await award(0, carol), "a latecomer wins nothing from a draw they missed").to.eq(0n);
  });

  it("refuses a draw more than one period old, rather than answering it wrongly", async function () {
    await join(alice);
    await join(bob);
    await runDraw();
    await (await pool.startNextPeriod()).wait();
    await runDraw();
    await (await pool.startNextPeriod()).wait();

    // Two generations back is past what the tree keeps. Refusing is correct; returning a
    // number computed from weights that no longer exist would not be.
    await expect(pool.connect(owner).checkClaim(0, alice.address)).to.be.revertedWithCustomError(
      pool,
      "ClaimWindowClosed",
    );
  });

  it("never lets a recycled slot read the previous occupant's position", async function () {
    await join(alice);
    await join(bob);

    // Alice leaves mid-period; her slot is released at the roll and handed to Carol.
    await ethers.provider.send("evm_increaseTime", [3 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    const slot = await pool.slotOf(alice.address);
    await (await pool.connect(alice).exitPool()).wait();

    await runDraw();
    await (await pool.startNextPeriod()).wait();

    await join(carol);
    expect(await pool.slotOf(carol.address), "Carol should inherit Alice's slot").to.eq(slot);

    // Carol's balance must be her own deposit and nothing else. If the leaf's archived
    // generation were still reachable, she would be holding — and be able to decrypt —
    // whatever Alice had before she left.
    await (await pool.connect(carol).refreshMyBalance()).wait();
    const balance = await fhevm.userDecryptEuint(FhevmType.euint64, await pool.balanceHandle(slot), poolAddress, carol);
    expect(balance, "a recycled slot starts empty, with no history behind it").to.eq(AMOUNT);
  });

  it("keeps the pool solvent when claims land after the roll", async function () {
    await join(alice);
    await join(bob);
    await runDraw();
    await (await pool.startNextPeriod()).wait();

    await (await pool.connect(owner).checkClaim(0, alice.address)).wait();
    await (await pool.connect(owner).checkClaim(0, bob.address)).wait();

    await (await pool.connect(owner).proveSolvency()).wait();
    expect(await fhevm.publicDecryptEbool(await pool.solvencyHandle()), "still fully backed").to.eq(true);
  });
});
