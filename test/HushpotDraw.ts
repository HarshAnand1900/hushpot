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

const PERIOD_MINUTES = 10080n;
const PERIOD_SECONDS = PERIOD_MINUTES * 60n;

// Base units, 6 decimals. Large enough that a 5% annual rate over one week rounds to a
// non-zero prize.
const ALICE_DEPOSIT = 1_000_000n; // 1.0 token
const BOB_DEPOSIT = 3_000_000n; //   3.0 tokens

describe("HushpotPool — draws and claims", function () {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let usdt: TestERC20;
  let cusdt: TestConfidentialWrapper;
  let cusdtAddress: string;
  let pool: HushpotPool;
  let poolAddress: string;

  before(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    alice = signers[1];
    bob = signers[2];
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This suite only runs against the FHEVM mock environment");
      this.skip();
    }

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const usdtAddress = await usdt.getAddress();

    cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(usdtAddress)) as TestConfidentialWrapper;
    cusdtAddress = await cusdt.getAddress();

    pool = (await (
      (await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory
    ).deploy(cusdtAddress)) as HushpotPool;
    poolAddress = await pool.getAddress();

    // Stock the pot.
    await (await usdt.mint(owner.address, 100_000_000n)).wait();
    await (await usdt.connect(owner).approve(poolAddress, 100_000_000n)).wait();
    await (await pool.connect(owner).fundPrizeReserve(1_000_000n)).wait();
  });

  async function depositPlain(who: HardhatEthersSigner, amount: bigint) {
    await (await usdt.mint(who.address, amount)).wait();
    await (await usdt.connect(who).approve(poolAddress, amount)).wait();
    await (await pool.connect(who).depositUnderlying(amount)).wait();
  }

  async function poolBalance(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyBalance()).wait();
    const slot = await pool.slotOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, await pool.balanceHandle(slot), poolAddress, who);
  }

  async function poolWeight(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyWeight()).wait();
    const slot = await pool.slotOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, await pool.weightHandle(slot), poolAddress, who);
  }

  /** The off-chain half of the draw: decrypt the published total and relay it back. */
  async function relaySettle() {
    const handle = await pool.pendingTotalHandle();
    const res = await fhevm.publicDecrypt([handle]);
    return pool.connect(alice).settleDraw(res.abiEncodedClearValues, res.decryptionProof);
  }

  async function runDraw() {
    await (await pool.openDraw()).wait();
    await (await relaySettle()).wait();
  }

  describe("the prize reserve", function () {
    it("credits plain tokens into a publicly visible pot", async function () {
      expect(await pool.prizeReserve()).to.eq(1_000_000n);
    });

    it("only lets the owner fund it or change the rate", async function () {
      await expect(pool.connect(alice).fundPrizeReserve(100n)).to.be.reverted;
      await expect(pool.connect(alice).setAnnualRateBps(1000)).to.be.reverted;
    });

    it("sizes the prize in proportion to the pool", async function () {
      const small = await pool.prizeFor(10_000_000_000n);
      const large = await pool.prizeFor(20_000_000_000n);

      // Twice the pool, twice the prize. This is what stops a latecomer diluting
      // anyone: they enlarge the pot exactly as much as they enlarge their own odds.
      expect(large).to.eq(small * 2n);
    });
  });

  describe("opening a draw", function () {
    beforeEach(async function () {
      await depositPlain(alice, ALICE_DEPOSIT);
      await depositPlain(bob, BOB_DEPOSIT);
    });

    it("refuses before the period has run its course", async function () {
      await expect(pool.connect(alice).openDraw()).to.be.revertedWithCustomError(pool, "PeriodNotElapsed");
    });

    it("lets the owner trigger one early, so a draw can be demonstrated", async function () {
      await expect(pool.connect(owner).openDraw()).to.not.be.reverted;
      expect(await pool.drawPending()).to.eq(true);
    });

    it("opens to anyone once the period has elapsed", async function () {
      await time.increase(PERIOD_SECONDS);
      await expect(pool.connect(alice).openDraw()).to.not.be.reverted;
    });

    it("will not open two draws at once", async function () {
      await time.increase(PERIOD_SECONDS);
      await (await pool.connect(alice).openDraw()).wait();
      await expect(pool.connect(alice).openDraw()).to.be.revertedWithCustomError(pool, "DrawAlreadyPending");
    });

    // Without this guard, anyone could re-open and re-settle once the period has ended,
    // paying out the prize again and again until the reserve was empty.
    it("refuses a second draw in the same period", async function () {
      await time.increase(PERIOD_SECONDS);
      await runDraw();

      await expect(pool.connect(alice).openDraw()).to.be.revertedWithCustomError(
        pool,
        "DrawAlreadySettledThisPeriod",
      );
    });

    it("allows the next draw once the period has rolled", async function () {
      await time.increase(PERIOD_SECONDS);
      await runDraw();
      await (await pool.connect(owner).startNextPeriod()).wait();

      await time.increase(PERIOD_SECONDS);
      await expect(pool.connect(alice).openDraw()).to.not.be.reverted;
    });
  });

  describe("settling", function () {
    beforeEach(async function () {
      await depositPlain(alice, ALICE_DEPOSIT);
      await depositPlain(bob, BOB_DEPOSIT);
      await time.increase(PERIOD_SECONDS);
    });

    it("publishes the pool total and a prize drawn from it", async function () {
      await runDraw();

      const draw = await pool.draws(0);
      const expectedTotal = (ALICE_DEPOSIT + BOB_DEPOSIT) * PERIOD_MINUTES;

      expect(draw.settled).to.eq(true);
      expect(draw.total).to.eq(expectedTotal);
      expect(draw.prize).to.eq(await pool.prizeFor(expectedTotal));
      expect(draw.prize).to.be.greaterThan(0n);
    });

    it("moves the prize out of the reserve", async function () {
      const before = await pool.prizeReserve();
      await runDraw();
      const draw = await pool.draws(0);

      expect(await pool.prizeReserve()).to.eq(before - draw.prize);
    });

    it("rejects a forged total", async function () {
      await (await pool.openDraw()).wait();

      const forged = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [999_999_999n]);
      await expect(pool.connect(alice).settleDraw(forged, "0x")).to.be.reverted;
    });

    it("will not settle without an open draw", async function () {
      await expect(pool.connect(alice).settleDraw("0x", "0x")).to.be.revertedWithCustomError(pool, "NoDrawPending");
    });
  });

  // The property the whole claim window rests on: once a period is over, deposits and
  // withdrawals cancel out of the weight arithmetic exactly, so the numbers a draw was
  // settled against cannot shift under it. No snapshots, no freezing of the contract.
  describe("weights freeze when the period ends", function () {
    it("ignores a deposit made after the period is over", async function () {
      await depositPlain(alice, ALICE_DEPOSIT);
      await time.increase(PERIOD_SECONDS);

      const before = await poolWeight(alice);
      await depositPlain(alice, ALICE_DEPOSIT); // doubles her balance
      const after = await poolWeight(alice);

      expect(after).to.eq(before);
      expect(await poolBalance(alice)).to.eq(ALICE_DEPOSIT * 2n); // but she does hold it
    });

    it("ignores a withdrawal made after the period is over", async function () {
      await depositPlain(alice, ALICE_DEPOSIT);
      await time.increase(PERIOD_SECONDS);

      const before = await poolWeight(alice);
      const enc = await fhevm.createEncryptedInput(poolAddress, alice.address).add64(ALICE_DEPOSIT).encrypt();
      await (await pool.connect(alice).withdraw(enc.handles[0], enc.inputProof)).wait();

      expect(await poolWeight(alice)).to.eq(before);
      expect(await poolBalance(alice)).to.eq(0n);
    });
  });

  describe("claiming", function () {
    beforeEach(async function () {
      await depositPlain(alice, ALICE_DEPOSIT);
      await depositPlain(bob, BOB_DEPOSIT);
      await time.increase(PERIOD_SECONDS);
      await runDraw();
    });

    it("pays the prize to exactly one participant", async function () {
      const draw = await pool.draws(0);

      await (await pool.connect(owner).checkClaim(0, alice.address)).wait();
      await (await pool.connect(owner).checkClaim(0, bob.address)).wait();

      const aliceBalance = await poolBalance(alice);
      const bobBalance = await poolBalance(bob);

      const aliceWon = aliceBalance - ALICE_DEPOSIT;
      const bobWon = bobBalance - BOB_DEPOSIT;

      // One of them gained exactly the prize, the other gained nothing at all.
      expect([aliceWon, bobWon].filter((v) => v === draw.prize).length, "exactly one winner").to.eq(1);
      expect(aliceWon + bobWon).to.eq(draw.prize);
    });

    it("lets anyone check on anyone else's behalf", async function () {
      // Bob checks Alice. He pays the gas and learns nothing — the result is encrypted.
      await expect(pool.connect(bob).checkClaim(0, alice.address)).to.not.be.reverted;
      expect(await pool.claimChecked(0, await pool.slotOf(alice.address))).to.eq(true);
    });

    it("sweeps every participant in one call", async function () {
      await (await pool.connect(owner).checkClaimBatch(0, [alice.address, bob.address])).wait();

      expect(await pool.claimChecked(0, await pool.slotOf(alice.address))).to.eq(true);
      expect(await pool.claimChecked(0, await pool.slotOf(bob.address))).to.eq(true);
    });

    it("is safe to re-run a sweep", async function () {
      await (await pool.connect(owner).checkClaimBatch(0, [alice.address, bob.address])).wait();
      await expect(pool.connect(owner).checkClaimBatch(0, [alice.address, bob.address])).to.not.be.reverted;
    });

    it("refuses to check the same participant twice", async function () {
      await (await pool.connect(owner).checkClaim(0, alice.address)).wait();
      await expect(pool.connect(owner).checkClaim(0, alice.address)).to.be.revertedWithCustomError(
        pool,
        "AlreadyChecked",
      );
    });

    it("closes the window once the next period starts", async function () {
      await (await pool.connect(owner).startNextPeriod()).wait();
      await expect(pool.connect(owner).checkClaim(0, alice.address)).to.be.revertedWithCustomError(
        pool,
        "AlreadyChecked",
      );
    });

    it("carries winnings into the next period's odds", async function () {
      await (await pool.connect(owner).checkClaimBatch(0, [alice.address, bob.address])).wait();
      await (await pool.connect(owner).startNextPeriod()).wait();

      // Whatever each of them now holds, principal plus any prize, earns a full period.
      expect(await poolWeight(alice)).to.eq((await poolBalance(alice)) * PERIOD_MINUTES);
      expect(await poolWeight(bob)).to.eq((await poolBalance(bob)) * PERIOD_MINUTES);
    });
  });

  describe("a second draw", function () {
    it("runs a full second cycle after the first", async function () {
      await depositPlain(alice, ALICE_DEPOSIT);
      await depositPlain(bob, BOB_DEPOSIT);

      await time.increase(PERIOD_SECONDS);
      await runDraw();
      await (await pool.connect(owner).checkClaimBatch(0, [alice.address, bob.address])).wait();
      await (await pool.connect(owner).startNextPeriod()).wait();

      // A claim parks the prize rather than folding it into the tree — that is what keeps
      // a claim off the thirty-addition ancestor repair. It joins the pool when the winner
      // next touches their position, which is the same visit on which they find out they
      // won. So the pot compounds on that refresh, not on the claim.
      await (await pool.connect(alice).refreshMyPosition()).wait();
      await (await pool.connect(bob).refreshMyPosition()).wait();

      await time.increase(PERIOD_SECONDS);
      await runDraw();

      expect(await pool.drawCount()).to.eq(2);

      const second = await pool.draws(1);
      // The pot grew, because the first prize compounded into the pool.
      expect(second.total).to.be.greaterThan((await pool.draws(0)).total);
    });
  });
});
