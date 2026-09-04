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
 * Two ways a generation of history can be read by the wrong person, or not at all.
 *
 * Keeping one generation per node is what lets a claim outlive its period. It also creates
 * two failure modes that only appear once a slot changes hands or a winner moves, and both
 * are silent: the numbers involved are ciphertext, so a wrong answer looks exactly like a
 * right one until somebody decrypts it.
 *
 *   1. A slot is retired, released at the roll, and handed to somebody new - while the
 *      weight the previous holder earned is still standing in the tree, because that is
 *      what the settled draw was measured against. The new holder inherits the band.
 *
 *   2. `_foldPending` writes the leaf and the credit or debit that called it writes again,
 *      both before `_persist` advances the stamp. A second archive therefore records a
 *      mid-transaction handle - one `_persist` never granted, since it grants the final
 *      handle - and every later claim whose band crosses that node reverts `ACLNotAllowed`.
 *
 * The draw point is random, so weights here are lopsided by a factor of ~10^9 to pin which
 * band it lands in rather than leaving it to chance.
 */
describe("HushpotPool - slots that change hands", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  /** Enough that a partial-period band dwarfs a full-period dust deposit. */
  const BIG = 1_000_000_000n;
  const DUST = 1n;
  const JOIN = 1_000_000n;

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

  async function award(drawId: number, who: HardhatEthersSigner) {
    const slot = await pool.slotOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, await pool.awardOf(drawId, slot), poolAddress, who);
  }

  it("does not pay a recycled slot's new holder for the band its last holder earned", async function () {
    await join(alice, BIG);
    await join(bob, DUST);
    const slot = await pool.slotOf(alice.address);

    // Alice holds most of the period, then leaves. Her balance goes to zero; the weight
    // earned over the days she held it does not, and her band can still take the point.
    await ethers.provider.send("evm_increaseTime", [6 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(alice).exitPool()).wait();

    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    await settle();

    // Precondition, asserted rather than assumed: the retired slot still carries its
    // weight. If exiting zeroed it, the published total would be the dust deposit's
    // ~10,080 ticket-minutes and this whole path would be unreachable.
    expect((await pool.draws(0)).total, "a retired slot keeps its earned weight").to.be.greaterThan(1_000_000_000n);

    // Nobody sweeps. Roll, and hand the slot to Carol.
    await (await pool.startNextPeriod()).wait();
    await join(carol, JOIN);
    expect(await pool.slotOf(carol.address), "Carol should inherit Alice's slot").to.eq(slot);

    await (await pool.connect(carol).checkMyClaim(0)).wait();
    expect(await award(0, carol), "Carol collects nothing on a band she never earned").to.eq(0n);
  });

  it("still counts a handed-on slot's band, so every later edge holds", async function () {
    await join(alice, BIG);
    await join(bob, DUST);

    await ethers.provider.send("evm_increaseTime", [6 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.connect(alice).exitPool()).wait();

    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    await settle();

    await (await pool.startNextPeriod()).wait();
    await join(carol, JOIN);

    // Skipping the award must not skip the band, or every slot after it shifts and the
    // partition stops covering the total the point was drawn from.
    const used = await pool.slotsUsed();
    await (await pool.sweepRange(0, used)).wait();
    expect(await pool.sweepCursor(0), "the sweep still covers every slot").to.eq(used);
  });

  it("keeps a claim answerable after the winner deposits again next period", async function () {
    await join(alice, BIG);
    await join(bob, DUST);

    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await fund(10_000_000n);
    await (await pool.openDraw()).wait();
    await settle();
    const prize = (await pool.draws(0)).prize;

    // Sweep Alice alone. She holds effectively all the weight, so she takes the prize and
    // parks it; Bob is left unchecked so his claim lands after the roll.
    await (await pool.sweepRange(0, 1)).wait();
    expect(await award(0, alice), "Alice's band covers the line").to.eq(prize);

    await (await pool.startNextPeriod()).wait();

    // The deposit that folds the parked award. This is the write that used to archive a
    // handle the pool was never granted, stranding every claim that reads Alice's leaf.
    await join(alice, JOIN);

    await (await pool.connect(owner).checkClaim(0, bob.address)).wait();
    expect(await award(0, bob), "Bob did not win, and must still be able to be told so").to.eq(0n);
  });
});
