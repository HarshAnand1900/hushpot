import { FhevmType } from "@fhevm/hardhat-plugin";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import {
  HushpotPool,
  HushpotPool__factory,
  TestConfidentialToken,
  TestConfidentialToken__factory,
} from "../types";

const PERIOD_MINUTES = 10080n;
const PERIOD_SECONDS = PERIOD_MINUTES * 60n;
const OPERATOR_UNTIL = 2_000_000_000; // far future, uint48

describe("HushpotPool", function () {
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let token: TestConfidentialToken;
  let tokenAddress: string;
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

    const tokenFactory = (await ethers.getContractFactory("TestConfidentialToken")) as TestConfidentialToken__factory;
    token = (await tokenFactory.deploy()) as TestConfidentialToken;
    tokenAddress = await token.getAddress();

    const poolFactory = (await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory;
    pool = (await poolFactory.deploy(tokenAddress)) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  async function fund(who: HardhatEthersSigner, amount: bigint) {
    await (await token.connect(who).faucet(amount)).wait();
    await (await token.connect(who).setOperator(poolAddress, OPERATOR_UNTIL)).wait();
  }

  async function encryptFor(target: string, amount: bigint, who: HardhatEthersSigner) {
    return fhevm.createEncryptedInput(target, who.address).add64(amount).encrypt();
  }

  async function deposit(who: HardhatEthersSigner, amount: bigint) {
    const enc = await encryptFor(poolAddress, amount, who);
    await (await pool.connect(who).deposit(enc.handles[0], enc.inputProof)).wait();
  }

  async function withdraw(who: HardhatEthersSigner, amount: bigint) {
    const enc = await encryptFor(poolAddress, amount, who);
    await (await pool.connect(who).withdraw(enc.handles[0], enc.inputProof)).wait();
  }

  /** The caller's own principal inside the pool. */
  async function poolBalance(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyBalance()).wait();
    const slot = await pool.slotOf(who.address);
    const handle = await pool.balanceHandle(slot);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  /** The caller's own ticket-minutes for the current period. */
  async function poolWeight(who: HardhatEthersSigner): Promise<bigint> {
    await (await pool.connect(who).refreshMyWeight()).wait();
    const slot = await pool.slotOf(who.address);
    const handle = await pool.weightHandle(slot);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddress, who);
  }

  /** The caller's wallet balance of the confidential token. */
  async function walletBalance(who: HardhatEthersSigner): Promise<bigint> {
    const handle = await token.confidentialBalanceOf(who.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, tokenAddress, who);
  }

  describe("faucet", function () {
    it("hands out test tokens", async function () {
      await (await token.connect(alice).faucet(1000n)).wait();
      expect(await walletBalance(alice)).to.eq(1000n);
    });

    it("refuses a zero or oversized request", async function () {
      await expect(token.connect(alice).faucet(0n)).to.be.reverted;
      await expect(token.connect(alice).faucet(100_000_000_001n)).to.be.reverted;
    });
  });

  describe("deposit", function () {
    it("requires the pool to be an approved operator first", async function () {
      await (await token.connect(alice).faucet(1000n)).wait();
      // Deliberately skipping setOperator.
      const enc = await encryptFor(poolAddress, 400n, alice);
      await expect(pool.connect(alice).deposit(enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(
        pool,
        "NotAnOperator",
      );
    });

    it("moves tokens into the pool and credits the depositor", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);

      expect(await poolBalance(alice)).to.eq(400n);
      expect(await walletBalance(alice)).to.eq(600n);
    });

    it("starts earning odds immediately, pro-rata for the rest of the period", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);

      // Deposited at minute 0, so it earns the whole period.
      expect(await poolWeight(alice)).to.eq(400n * PERIOD_MINUTES);
    });

    it("earns proportionally less when deposited later in the period", async function () {
      await fund(alice, 1000n);
      await time.increase(PERIOD_SECONDS / 2n);
      await deposit(alice, 400n);

      expect(await poolWeight(alice)).to.eq(400n * 5040n);
    });

    it("assigns each depositor their own slot", async function () {
      await fund(alice, 1000n);
      await fund(bob, 1000n);

      await deposit(alice, 100n);
      await deposit(bob, 200n);

      expect(await pool.slotOf(alice.address)).to.eq(0);
      expect(await pool.slotOf(bob.address)).to.eq(1);
      expect(await pool.slotsUsed()).to.eq(2);
    });

    it("reuses the same slot on a second deposit", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 100n);
      await deposit(alice, 250n);

      expect(await pool.slotsUsed()).to.eq(1);
      expect(await poolBalance(alice)).to.eq(350n);
    });

    // The important one. An ERC-7984 transfer that exceeds the sender's balance does not
    // revert — it silently moves nothing. So the pool must credit the amount the token
    // reports as actually transferred. Crediting the *requested* amount instead would let
    // anyone mint unlimited odds out of an empty wallet.
    it("credits only what actually moved, not what was asked for", async function () {
      await fund(alice, 100n);
      await deposit(alice, 999n); // asks for far more than she holds

      // Nothing moved, so nothing was credited — and critically, not 999.
      expect(await poolBalance(alice)).to.eq(0n);
      expect(await poolWeight(alice)).to.eq(0n);
      expect(await walletBalance(alice), "her tokens are untouched").to.eq(100n);
    });

    // Consequence of the above, and a UI requirement rather than a contract one: an
    // over-sized deposit burns gas and changes nothing, with no revert to explain why.
    // The frontend has to check the balance before submitting.
    it("succeeds silently rather than reverting on an oversized deposit", async function () {
      await fund(alice, 100n);
      const enc = await encryptFor(poolAddress, 999n, alice);
      await expect(pool.connect(alice).deposit(enc.handles[0], enc.inputProof)).to.not.be.reverted;
    });
  });

  describe("withdraw", function () {
    it("returns principal to the wallet", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);
      await withdraw(alice, 150n);

      expect(await poolBalance(alice)).to.eq(250n);
      expect(await walletBalance(alice)).to.eq(750n);
    });

    it("lets someone exit in full with no penalty", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);
      await withdraw(alice, 400n);

      expect(await poolBalance(alice)).to.eq(0n);
      expect(await walletBalance(alice)).to.eq(1000n);
    });

    it("clamps an over-withdrawal instead of reverting or overpaying", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);
      await withdraw(alice, 999n);

      expect(await poolBalance(alice)).to.eq(0n);
      expect(await walletBalance(alice)).to.eq(1000n); // never more than she put in
    });

    it("keeps the odds already earned when leaving early", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);
      await time.increase(PERIOD_SECONDS / 2n);
      await withdraw(alice, 400n);

      // Held for half the period, so keeps half a period of credit.
      expect(await poolWeight(alice)).to.eq(400n * 5040n);
    });

    it("rejects a withdrawal from someone who never deposited", async function () {
      const enc = await encryptFor(poolAddress, 100n, bob);
      await expect(pool.connect(bob).withdraw(enc.handles[0], enc.inputProof)).to.be.revertedWithCustomError(
        pool,
        "NoSlotAssigned",
      );
    });
  });

  describe("reading your own position", function () {
    // Three wallet prompts to answer "what do I have?" is too many. This collapses the
    // two recompute transactions into one, leaving a signature and a single transaction.
    it("refreshes balance and odds in a single transaction", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);

      await (await pool.connect(alice).refreshMyPosition()).wait();

      const slot = await pool.slotOf(alice.address);
      const balance = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await pool.balanceHandle(slot),
        poolAddress,
        alice,
      );
      const weight = await fhevm.userDecryptEuint(FhevmType.euint64, await pool.weightHandle(slot), poolAddress, alice);

      expect(balance).to.eq(400n);
      expect(weight).to.eq(400n * PERIOD_MINUTES);
    });

    it("still refuses anyone without a slot", async function () {
      await expect(pool.connect(bob).refreshMyPosition()).to.be.revertedWithCustomError(pool, "NoSlotAssigned");
    });
  });

  // The obvious objection to a pool with encrypted balances is that nobody can check the
  // money is still there. This proves it while revealing neither figure.
  describe("solvency", function () {
    it("proves the pool is fully backed, without revealing either amount", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);

      await (await pool.connect(bob).proveSolvency()).wait();

      const backed = await fhevm.publicDecryptEbool(await pool.solvencyHandle());
      expect(backed).to.eq(true);
      expect(await pool.solvencyProvenAt()).to.be.greaterThan(0n);
    });

    it("can be triggered by anyone, not just the operator", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);

      // A solvency proof only the operator can run is not worth much.
      await expect(pool.connect(bob).proveSolvency()).to.not.be.reverted;
    });

    it("holds after a withdrawal", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);
      await withdraw(alice, 150n);

      await (await pool.connect(alice).proveSolvency()).wait();
      expect(await fhevm.publicDecryptEbool(await pool.solvencyHandle())).to.eq(true);
    });
  });

  describe("positions stay private", function () {
    it("does not let one depositor decrypt another's balance", async function () {
      await fund(alice, 1000n);
      await fund(bob, 1000n);
      await deposit(alice, 400n);
      await deposit(bob, 700n);

      // Alice refreshes her own position, which is hers to read.
      await (await pool.connect(alice).refreshMyBalance()).wait();
      const aliceSlot = await pool.slotOf(alice.address);
      const aliceHandle = await pool.balanceHandle(aliceSlot);

      expect(await fhevm.userDecryptEuint(FhevmType.euint64, aliceHandle, poolAddress, alice)).to.eq(400n);

      // Bob can see the handle on-chain, but cannot open it.
      let bobOpenedIt = false;
      try {
        await fhevm.userDecryptEuint(FhevmType.euint64, aliceHandle, poolAddress, bob);
        bobOpenedIt = true;
      } catch {
        bobOpenedIt = false;
      }
      expect(bobOpenedIt, "Bob must not be able to decrypt Alice's balance").to.eq(false);
    });

    it("only ever refreshes the caller's own slot", async function () {
      await fund(alice, 1000n);
      await deposit(alice, 400n);

      // Bob has no slot, so there is nothing for him to refresh.
      await expect(pool.connect(bob).refreshMyBalance()).to.be.revertedWithCustomError(pool, "NoSlotAssigned");
    });
  });

  describe("the pool total", function () {
    it("sums every participant's ticket-minutes", async function () {
      await fund(alice, 1000n);
      await fund(bob, 1000n);
      await deposit(alice, 400n);
      await deposit(bob, 600n);

      // Through a draw, because that is the only way the total is ever published. There
      // is deliberately no on-demand reader: two readings either side of a deposit would
      // give away that deposit's size.
      await (await pool.openDraw()).wait();
      const published = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
      const total = BigInt(Object.values(published.clearValues ?? {})[0] as string);

      expect(total).to.eq(1000n * PERIOD_MINUTES);
    });
  });
});
