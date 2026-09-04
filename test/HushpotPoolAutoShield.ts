import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  HushpotPool,
  HushpotPool__factory,
  TestConfidentialToken,
  TestConfidentialToken__factory,
  TestConfidentialWrapper,
  TestConfidentialWrapper__factory,
  TestERC20,
  TestERC20__factory,
} from "../types";

const PERIOD_MINUTES = 10080n;
const OPERATOR_UNTIL = 2_000_000_000;

/**
 * Auto-shielding lets someone deposit ordinary tokens without ever meeting the word
 * "wrap". These tests run against OpenZeppelin's ERC7984ERC20Wrapper - the exact
 * implementation behind Zama's cUSDTMock on Sepolia (verified on-chain: rate 1,
 * 6 decimals, underlying USDTMock), so this is the real path rather than a stand-in.
 */
describe("HushpotPool - auto-shielding plain tokens", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let usdt: TestERC20;
  let usdtAddress: string;
  let cusdt: TestConfidentialWrapper;
  let cusdtAddress: string;
  let pool: HushpotPool;
  let poolAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    alice = signers[1];
    bob = signers[2];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This suite only runs against the FHEVM mock environment");
      this.skip();
    }

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    usdtAddress = await usdt.getAddress();

    const wrapperFactory = (await ethers.getContractFactory(
      "TestConfidentialWrapper",
    )) as TestConfidentialWrapper__factory;
    cusdt = (await wrapperFactory.deploy(usdtAddress)) as TestConfidentialWrapper;
    cusdtAddress = await cusdt.getAddress();

    const poolFactory = (await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory;
    pool = (await poolFactory.deploy(cusdtAddress)) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  async function poolBalance(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyBalance()).wait();
    const slot = await pool.slotOf(who.address);
    const handle = await pool.balanceHandle(slot);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  async function poolWeight(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyWeight()).wait();
    const slot = await pool.slotOf(who.address);
    const handle = await pool.weightHandle(slot);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  async function confidentialBalance(who: HardhatEthersSigner): Promise<bigint> {
    const handle = await cusdt.confidentialBalanceOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, cusdtAddress, who);
  }

  describe("detection", function () {
    it("recognises a wrapping token and exposes its underlying", async function () {
      expect(await pool.supportsAutoShield()).to.eq(true);
      expect(await pool.underlyingToken()).to.eq(usdtAddress);
    });

    it("switches auto-shielding off for a non-wrapping confidential token", async function () {
      const plain = (await (
        (await ethers.getContractFactory("TestConfidentialToken")) as TestConfidentialToken__factory
      ).deploy()) as TestConfidentialToken;

      const other = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
        await plain.getAddress(),
      )) as HushpotPool;

      expect(await other.supportsAutoShield()).to.eq(false);
      expect(await other.underlyingToken()).to.eq(ethers.ZeroAddress);
      await expect(other.connect(alice).depositUnderlying(100n)).to.be.revertedWithCustomError(
        other,
        "NoUnderlyingToken",
      );
    });
  });

  describe("depositing plain tokens", function () {
    it("shields and deposits in a single call", async function () {
      await (await usdt.mint(alice.address, 1000n)).wait();
      await (await usdt.connect(alice).approve(poolAddress, 1000n)).wait();

      await (await pool.connect(alice).depositUnderlying(400n)).wait();

      // Plain tokens left her wallet...
      expect(await usdt.balanceOf(alice.address)).to.eq(600n);
      // ...and her pool position is encrypted from here on.
      expect(await poolBalance(alice)).to.eq(400n);
      expect(await poolWeight(alice)).to.eq(400n * PERIOD_MINUTES);
    });

    it("leaves the pool holding confidential tokens, not plain ones", async function () {
      await (await usdt.mint(alice.address, 1000n)).wait();
      await (await usdt.connect(alice).approve(poolAddress, 1000n)).wait();
      await (await pool.connect(alice).depositUnderlying(400n)).wait();

      // The plain tokens went to the wrapper, which minted confidential ones to the pool.
      expect(await usdt.balanceOf(poolAddress)).to.eq(0n);
      expect(await usdt.balanceOf(cusdtAddress)).to.eq(400n);
    });

    it("adds to an existing position rather than opening a second one", async function () {
      await (await usdt.mint(alice.address, 1000n)).wait();
      await (await usdt.connect(alice).approve(poolAddress, 1000n)).wait();

      await (await pool.connect(alice).depositUnderlying(300n)).wait();
      await (await pool.connect(alice).depositUnderlying(250n)).wait();

      expect(await pool.slotsUsed()).to.eq(1);
      expect(await poolBalance(alice)).to.eq(550n);
    });

    it("rejects a zero deposit", async function () {
      await expect(pool.connect(alice).depositUnderlying(0n)).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("reverts without an approval, rather than failing silently", async function () {
      await (await usdt.mint(alice.address, 1000n)).wait();
      // No approve() - a plain ERC-20 does revert here, unlike the confidential path.
      await expect(pool.connect(alice).depositUnderlying(400n)).to.be.reverted;
    });
  });

  describe("both entry paths land in the same pool", function () {
    it("treats a shielded depositor and a confidential depositor identically", async function () {
      // Alice takes the convenient route: plain tokens, shielded by the pool.
      await (await usdt.mint(alice.address, 1000n)).wait();
      await (await usdt.connect(alice).approve(poolAddress, 1000n)).wait();
      await (await pool.connect(alice).depositUnderlying(400n)).wait();

      // Bob takes the private route: he shields separately, then deposits an encrypted
      // amount, so the size of his deposit never appears in the clear.
      await (await usdt.mint(bob.address, 1000n)).wait();
      await (await usdt.connect(bob).approve(cusdtAddress, 1000n)).wait();
      await (await cusdt.connect(bob).wrap(bob.address, 400n)).wait();
      await (await cusdt.connect(bob).setOperator(poolAddress, OPERATOR_UNTIL)).wait();

      const enc = await fhevm.createEncryptedInput(poolAddress, bob.address).add64(400n).encrypt();
      await (await pool.connect(bob).deposit(enc.handles[0], enc.inputProof)).wait();

      // Same deposit, same period, same odds - the entry route makes no difference.
      expect(await poolBalance(alice)).to.eq(400n);
      expect(await poolBalance(bob)).to.eq(400n);
      expect(await poolWeight(alice)).to.eq(await poolWeight(bob));

      // Only a draw publishes the total - there is no on-demand reader, by design.
      await (await pool.openDraw()).wait();
      const published = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
      expect(BigInt(Object.values(published.clearValues ?? {})[0] as string)).to.eq(800n * PERIOD_MINUTES);
    });
  });

  describe("getting back out", function () {
    it("returns confidential tokens the depositor can unwrap themselves", async function () {
      await (await usdt.mint(alice.address, 1000n)).wait();
      await (await usdt.connect(alice).approve(poolAddress, 1000n)).wait();
      await (await pool.connect(alice).depositUnderlying(400n)).wait();

      const enc = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(400n).encrypt();
      await (await pool.connect(alice).withdraw(enc.handles[0], enc.inputProof)).wait();

      expect(await poolBalance(alice)).to.eq(0n);
      expect(await confidentialBalance(alice)).to.eq(400n);
    });
  });
});
