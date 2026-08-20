import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
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

const DEPOSIT = 500_000n; // 0.5 token
const PERIOD_SECONDS = 7 * 24 * 60 * 60;

describe("HushpotPool — sponsorship", function () {
  let owner: HardhatEthersSigner;
  let minnow: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This suite only runs against the FHEVM mock environment");
      this.skip();
    }

    // signers[0] deploys, so it is the owner — bind it rather than relying on the default.
    [owner, , minnow, stranger] = await ethers.getSigners();

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    pool = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await cusdt.getAddress(),
    )) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  async function depositPlain(who: HardhatEthersSigner, amount: bigint) {
    await (await usdt.mint(who.address, amount)).wait();
    await (await usdt.connect(who).approve(poolAddress, amount)).wait();
    await (await pool.connect(who).depositUnderlying(amount)).wait();
  }

  async function weightOf(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyWeight()).wait();
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      await pool.weightHandle(await pool.slotOf.staticCall(who.address)),
      poolAddress,
      who,
    );
  }

  it("lets anyone grow the prize, not just the owner", async function () {
    await (await usdt.mint(stranger.address, 500_000n)).wait();
    await (await usdt.connect(stranger).approve(poolAddress, 500_000n)).wait();

    await expect(pool.connect(stranger).fundPrizeReserve(500_000n)).to.be.reverted;
    await expect(pool.connect(stranger).sponsorPrize(500_000n)).to.not.be.reverted;

    expect(await pool.prizeReserve()).to.eq(500_000n);
  });

  it("takes no odds and creates no position for the sponsor", async function () {
    await (await usdt.mint(stranger.address, 500_000n)).wait();
    await (await usdt.connect(stranger).approve(poolAddress, 500_000n)).wait();
    await (await pool.connect(stranger).sponsorPrize(500_000n)).wait();

    // The distinguishing property: money in, no slot, no chance of winning it back.
    expect(await pool.hasSlot(stranger.address)).to.eq(false);
    expect(await pool.slotsUsed()).to.eq(0);
  });

  // The point of sponsoring: the money has to show up in a prize, not just deepen a tank
  // nobody can see the bottom of.
  it("adds the sponsorship to the very next prize", async function () {
    await depositPlain(minnow, DEPOSIT);

    await (await usdt.mint(owner.address, 50_000_000n)).wait();
    await (await usdt.connect(owner).approve(poolAddress, 50_000_000n)).wait();
    await (await pool.connect(owner).fundPrizeReserve(50_000_000n)).wait();

    await (await usdt.mint(stranger.address, 500_000n)).wait();
    await (await usdt.connect(stranger).approve(poolAddress, 500_000n)).wait();
    await (await pool.connect(stranger).sponsorPrize(500_000n)).wait();

    expect(await pool.sponsoredThisDraw()).to.eq(500_000n);

    await time.increase(PERIOD_SECONDS);
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();

    const draw = await pool.draws(0);
    const formula = await pool.prizeFor(draw.total);

    // Exactly the formula plus the gift, and the accumulator is spent rather than
    // carried into a second draw.
    expect(draw.prize).to.eq(formula + 500_000n);
    expect(await pool.sponsoredThisDraw()).to.eq(0n);
  });

  it("cannot touch anybody else's position", async function () {
    await depositPlain(minnow, DEPOSIT);
    const before = await weightOf(minnow);

    await (await usdt.mint(stranger.address, 500_000n)).wait();
    await (await usdt.connect(stranger).approve(poolAddress, 500_000n)).wait();
    await (await pool.connect(stranger).sponsorPrize(500_000n)).wait();

    // PoolTogether V5's sponsor() was found to let one account strip another's odds by
    // forcing a delegation. There is no delegation here to redirect.
    expect(await weightOf(minnow)).to.eq(before);
  });
});
