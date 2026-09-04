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
 * A pool wide enough to need another level of tree must still settle.
 *
 * `_treeRoot` keeps the tree only as deep as the slots in use, so the root *moves* as the
 * pool grows: at sixteen depositors it sits at node 1024, and the seventeenth pushes it up
 * to 512. Every pool this project had run until now peaked at fifteen, so that boundary had
 * never been crossed on-chain - and the first pool that crossed it published a total the
 * relayer then refused to decrypt, three times, with `execution reverted`.
 *
 * This is the reproduction. If the published total decrypts here, the tree is fine and the
 * failure belongs to the coprocessor; if it does not, the bug is ours and it has been
 * waiting behind a slot count nobody had reached.
 */
describe("HushpotPool - a pool wide enough to grow the tree", function () {
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    pool = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await cusdt.getAddress(),
    )) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  it("settles a draw with more depositors than one tree level holds", async function () {
    const signers = await ethers.getSigners();
    const owner = signers[0];

    // Every signer Hardhat offers, which is comfortably past the sixteen-slot boundary
    // where the root moves up a level.
    for (const who of signers) {
      const amount = 1_000_000n;
      await (await usdt.mint(who.address, amount)).wait();
      await (await usdt.connect(who).approve(poolAddress, amount)).wait();
      await (await pool.connect(who).depositUnderlying(amount)).wait();
    }

    const used = await pool.slotsUsed();
    expect(used, "the point of this test is to exceed one level").to.be.greaterThan(16);

    await (await usdt.mint(owner.address, 10_000_000n)).wait();
    await (await usdt.connect(owner).approve(poolAddress, 10_000_000n)).wait();
    await (await pool.connect(owner).fundPrizeReserve(10_000_000n)).wait();

    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await pool.openDraw()).wait();

    // The step Sepolia could not complete: decrypt the published total.
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();

    const draw = await pool.draws(0);
    expect(draw.settled).to.eq(true);
    // Every depositor put in the same amount, so the total should be close to
    // `amount * slots * PERIOD_MINUTES` - a little under, because deposits land in
    // different blocks and a slot credited from minute 1 earns 10,079 rather than 10,080.
    //
    // The number that matters is the floor. When the root moves up a level it gains a
    // sibling subtree, and a repair that failed to fold that sibling in would halve the
    // total rather than shave a minute off it.
    const ideal = 1_000_000n * BigInt(used) * 10080n;
    expect(draw.total, "no subtree may be lost when the root moves up").to.be.greaterThan((ideal * 99n) / 100n);
    expect(draw.total, "and none may be counted twice").to.be.lessThanOrEqual(ideal);
  });
});
