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
 * depositor. These tests pin the two properties that make it safe rather than merely
 * generous: it cannot be taken twice, and it cannot be taken and then walked away from.
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

  it("adds ten percent of a full stake for each period held", async function () {
    await join(alice);
    await roll();

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    const after = await weight(alice);

    // One period held, so ten percent of a full period's ticket-minutes on this balance.
    expect(after - before).to.eq((AMOUNT * PERIOD_MINUTES * 10n) / 100n);
  });

  it("stops growing at the cap", async function () {
    await join(alice);
    for (let i = 0; i < 6; i++) await slowRoll();

    expect(await pool.streakOf(alice.address)).to.eq(await pool.MAX_BOOST_PERIODS());

    const before = await weight(alice);
    await (await pool.connect(alice).boostStreak()).wait();
    expect((await weight(alice)) - before, "four periods' worth, not six").to.eq(
      (AMOUNT * PERIOD_MINUTES * 40n) / 100n,
    );
  });

  it("cannot be taken twice in one period", async function () {
    await join(alice);
    await roll();
    await (await pool.connect(alice).boostStreak()).wait();
    await expect(pool.connect(alice).boostStreak()).to.be.revertedWithCustomError(pool, "AlreadyBoosted");
  });

  it("commits the stake for the rest of the period", async function () {
    await join(alice);
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

    const bobBefore = await weight(bob);
    await (await pool.connect(alice).boostStreak()).wait();
    expect(await weight(bob), "a boost is one slot's business").to.eq(bobBefore);
  });
});
