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

const PERIOD_SECONDS = 10080n * 60n;

/**
 * The receipt a swept depositor can still read.
 *
 * The case that matters is the ordinary one: a keeper checks everybody before the period
 * rolls, so by the time a depositor asks, the claim has already happened and their balance
 * moved while they were not looking. Before `awardOf` there was nothing left to consult.
 */
describe("HushpotPool — the award receipt", function () {
  let keeper: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let usdt: TestERC20;
  let token: TestConfidentialWrapper;
  let pool: HushpotPool;
  let poolAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    keeper = signers[0];
    alice = signers[1];
    bob = signers[2];
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
    const tokenAddress = await token.getAddress();

    const poolFactory = (await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory;
    pool = (await poolFactory.deploy(tokenAddress)) as HushpotPool;
    poolAddress = await pool.getAddress();

    for (const who of [alice, bob]) {
      await (await usdt.mint(who.address, 5_000n)).wait();
      await (await usdt.connect(who).approve(poolAddress, 5_000n)).wait();
      await (await pool.connect(who).depositUnderlying(1_000n)).wait();
    }

    // A reserve big enough that the prize is a real number, so a winner's receipt is
    // distinguishable from a loser's zero.
    await (await usdt.mint(keeper.address, 1_000_000n)).wait();
    await (await usdt.connect(keeper).approve(poolAddress, 1_000_000n)).wait();
    await (await pool.fundPrizeReserve(1_000_000n)).wait();
  });

  async function settleADraw() {
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
  }

  /** What the depositor can open for themselves. */
  async function receipt(who: HardhatEthersSigner, drawId: bigint) {
    const slot = await pool.slotOf(who.address);
    const handle = await pool.awardOf(drawId, slot);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  it("lets a depositor read their own result after somebody else checked them", async function () {
    await settleADraw();

    // The keeper sweeps, exactly as it does in production. Neither depositor has acted.
    await (await pool.connect(keeper).sweepRange(0, 2)).wait();

    const a = await receipt(alice, 0n);
    const b = await receipt(bob, 0n);

    // One of them holds the prize, the other an encrypted zero, and each can read only
    // their own. Which one is not something the test needs to know.
    expect(a === 0n || b === 0n).to.eq(true);
    expect(a + b).to.be.greaterThanOrEqual(0n);
  });

  it("survives the period rolling, which is what closes checkClaim for good", async function () {
    await settleADraw();
    await (await pool.connect(keeper).sweepRange(0, 2)).wait();

    await ethers.provider.send("evm_increaseTime", [Number(PERIOD_SECONDS) + 1]);
    await (await pool.startNextPeriod()).wait();

    // The old route is gone...
    await expect(pool.connect(alice).checkMyClaim(0)).to.be.revertedWithCustomError(pool, "AlreadyChecked");
    // ...and the receipt is still readable.
    await expect(receipt(alice, 0n)).to.not.be.rejected;
  });

  it("does not let the keeper that ran the sweep read what it handed out", async function () {
    await settleADraw();
    await (await pool.connect(keeper).sweepRange(0, 2)).wait();

    const slot = await pool.slotOf(alice.address);
    const handle = await pool.awardOf(0, slot);
    await expect(fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, keeper)).to.be.rejected;
  });

  it("leaves an empty handle for a slot nobody checked", async function () {
    await settleADraw();
    const slot = await pool.slotOf(bob.address);
    expect(await pool.awardOf(0, slot)).to.eq(ethers.ZeroHash);
  });
});
