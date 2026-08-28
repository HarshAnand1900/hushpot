import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  HushpotPool,
  HushpotPool__factory,
  SandboxOperator,
  SandboxOperator__factory,
  TestConfidentialWrapper,
  TestConfidentialWrapper__factory,
  TestERC20,
  TestERC20__factory,
} from "../types";

/**
 * The sandbox's owner is a contract that says yes to everyone, for two things only.
 *
 * What is being tested is mostly an absence: that handing the pool to this contract gives
 * a stranger the two calls a demonstration needs, and gives them nothing else — not the
 * yield rate, not ownership, not a generic call to reach whatever gets added later.
 */
describe("SandboxOperator", function () {
  let deployer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let usdt: TestERC20;
  let token: TestConfidentialWrapper;
  let pool: HushpotPool;
  let poolAddress: string;
  let operator: SandboxOperator;
  let operatorAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    stranger = signers[3];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This suite only runs against the FHEVM mock environment");
      this.skip();
    }

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const tokenFactory = (await ethers.getContractFactory(
      "TestConfidentialWrapper",
    )) as TestConfidentialWrapper__factory;
    token = (await tokenFactory.deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    const poolFactory = (await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory;
    pool = (await poolFactory.deploy(await token.getAddress())) as HushpotPool;
    poolAddress = await pool.getAddress();

    const operatorFactory = (await ethers.getContractFactory("SandboxOperator")) as SandboxOperator__factory;
    operator = (await operatorFactory.deploy(poolAddress)) as SandboxOperator;
    operatorAddress = await operator.getAddress();

    // One depositor, so a draw has something to seal. The pool auto-shields, so the
    // plain route is the shortest way to get a position in place — what is under test
    // here is who may run the cycle, not how the money got in.
    await (await usdt.mint(stranger.address, 1_000n)).wait();
    await (await usdt.connect(stranger).approve(poolAddress, 1_000n)).wait();
    await (await pool.connect(stranger).depositUnderlying(1_000n)).wait();

    await (await pool.transferOwnership(operatorAddress)).wait();
  });

  it("owns the pool once ownership is handed over", async function () {
    expect(await pool.owner()).to.equal(operatorAddress);
  });

  it("lets a stranger open a draw before the period has elapsed", async function () {
    // Directly, this is the call that fails — which is the whole reason the contract exists.
    await expect(pool.connect(stranger).openDraw()).to.be.revertedWithCustomError(pool, "PeriodNotElapsed");

    await expect(operator.connect(stranger).openDraw()).to.not.be.reverted;
    expect(await pool.drawPending()).to.equal(true);
  });

  it("lets a stranger roll the period early, once a draw has settled", async function () {
    await (await operator.connect(stranger).openDraw()).wait();

    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.connect(stranger).settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();

    const before = await pool.currentPeriod();
    await expect(operator.connect(stranger).startNextPeriod()).to.not.be.reverted;
    expect(await pool.currentPeriod()).to.equal(before + 1n);
  });

  it("keeps the owner's dangerous powers unreachable", async function () {
    // The rate and ownership are owner-only, the owner is this contract, and this contract
    // has no forwarder for either — so they are not merely gated, they are gone.
    await expect(pool.connect(stranger).setAnnualRateBps(0)).to.be.revertedWithCustomError(
      pool,
      "OwnableUnauthorizedAccount",
    );
    await expect(pool.connect(deployer).setAnnualRateBps(0)).to.be.revertedWithCustomError(
      pool,
      "OwnableUnauthorizedAccount",
    );
    await expect(pool.connect(deployer).transferOwnership(deployer.address)).to.be.revertedWithCustomError(
      pool,
      "OwnableUnauthorizedAccount",
    );

    const fns = SandboxOperator__factory.abi.filter((f) => f.type === "function").map((f) => ("name" in f ? f.name : ""));
    expect(fns).to.have.members(["pool", "openDraw", "startNextPeriod", "fundPrizeReserve"]);
  });

  it("lets anyone top the reserve up with their own tokens", async function () {
    await (await usdt.mint(stranger.address, 500_000n)).wait();
    await (await usdt.connect(stranger).approve(operatorAddress, 500_000n)).wait();

    const before = await pool.prizeReserve();
    await (await operator.connect(stranger).fundPrizeReserve(500_000n)).wait();
    expect(await pool.prizeReserve()).to.equal(before + 500_000n);
  });
});
