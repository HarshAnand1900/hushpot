import { FhevmType } from "@fhevm/hardhat-plugin";
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

const DEPOSIT = 500_000n; // 0.5 token

describe("HushpotPool — sponsorship", function () {
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

    [, , minnow, stranger] = await ethers.getSigners();

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
