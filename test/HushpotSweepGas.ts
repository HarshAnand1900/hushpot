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

/**
 * What a payout actually costs, measured rather than argued about.
 *
 * Two ways to pay a draw out across the whole pool:
 *
 *   - `checkClaim` per participant, which is what `hushpot:sweep` does today
 *   - `sweepRange`, which walks the slots in order
 *
 * They compute the same thing. The second is cheaper because a per-participant claim
 * repeats work every participant shares: it climbs the tree to rederive the prefix that
 * the slot before it already computed, and it repairs all ten ancestor sums to deposit
 * what is, for everyone but the winner, an encrypted zero.
 *
 * This suite reports the per-participant cost of each so the difference is a number.
 */
const DEPOSITORS = 8;

describe("HushpotPool - what a payout costs", function () {
  let owner: HardhatEthersSigner;
  let players: HardhatEthersSigner[];

  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("This suite only runs against the FHEVM mock environment");
      this.skip();
    }

    const signers = await ethers.getSigners();
    owner = signers[0];
    players = signers.slice(1, DEPOSITORS + 1);

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    pool = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await cusdt.getAddress(),
    )) as HushpotPool;
    poolAddress = await pool.getAddress();

    await (await usdt.mint(owner.address, 1_000_000_000n)).wait();
    await (await usdt.connect(owner).approve(poolAddress, 1_000_000_000n)).wait();
    await (await pool.connect(owner).fundPrizeReserve(10_000_000n)).wait();

    // Uneven, so the bands differ and the comparison has something to chew on.
    for (let i = 0; i < players.length; i++) {
      const amount = BigInt(1 + i) * 1_000_000n;
      await (await usdt.mint(players[i].address, amount)).wait();
      await (await usdt.connect(players[i]).approve(poolAddress, amount)).wait();
      await (await pool.connect(players[i]).depositUnderlying(amount)).wait();
    }

    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
  });

  it("costs less per participant swept in a range than claimed one by one", async function () {
    const drawId = (await pool.drawCount()) - 1n;
    const slots = Number(await pool.slotsUsed());

    // --- one at a time, the way the keeper does it today ---------------------
    let perClaim = 0n;
    for (const who of players) {
      const receipt = await (await pool.checkClaim(drawId, who.address)).wait();
      perClaim += receipt!.gasUsed;
    }
    // The owner holds slot 0 and never deposited, but the sweep will still cover them.
    const claimedSlots = players.length;

    // --- and again, as a range, on a fresh pool ------------------------------
    // Same setup rather than the same instance: claims are one-shot per slot.
    const fresh = await freshPoolWithDraw();
    let perSweep = 0n;
    let pages = 0;
    while (Number(await fresh.pool.sweepCursor(fresh.drawId)) < Number(await fresh.pool.slotsUsed())) {
      const receipt = await (await fresh.pool.sweepRange(fresh.drawId, 4)).wait();
      perSweep += receipt!.gasUsed;
      pages++;
    }
    const sweptSlots = Number(await fresh.pool.slotsUsed());

    const claimEach = perClaim / BigInt(claimedSlots);
    const sweepEach = perSweep / BigInt(sweptSlots);

    console.log(`\n    one-by-one   ${perClaim} gas over ${claimedSlots} slots - ${claimEach} each`);
    console.log(`    sweepRange   ${perSweep} gas over ${sweptSlots} slots in ${pages} pages - ${sweepEach} each`);
    console.log(`    ratio        ${(Number(claimEach) / Number(sweepEach)).toFixed(2)}x cheaper per participant\n`);

    expect(sweepEach).to.be.lessThan(claimEach);
    expect(slots).to.be.greaterThan(0);
  });

  it("pays the prize to exactly one depositor, and to nobody else", async function () {
    const fresh = await freshPoolWithDraw();
    const prize = (await fresh.pool.draws(fresh.drawId)).prize;

    const before: bigint[] = [];
    for (const who of fresh.players) before.push(await balanceOf(fresh.pool, who));

    while (Number(await fresh.pool.sweepCursor(fresh.drawId)) < Number(await fresh.pool.slotsUsed())) {
      await (await fresh.pool.sweepRange(fresh.drawId, 4)).wait();
    }

    // A pending award only reaches the tree on the next touch, so make everyone touch.
    let winners = 0;
    for (let i = 0; i < fresh.players.length; i++) {
      const who = fresh.players[i];
      await (await fresh.usdt.mint(who.address, 1n)).wait();
      await (await fresh.usdt.connect(who).approve(await fresh.pool.getAddress(), 1n)).wait();
      await (await fresh.pool.connect(who).depositUnderlying(1n)).wait();

      const after = await balanceOf(fresh.pool, who);
      const gained = after - before[i] - 1n;
      if (gained > 0n) {
        expect(gained).to.eq(prize);
        winners++;
      }
    }

    expect(winners).to.eq(1);
  });

  it("does not pay twice when a self-check and a sweep cover the same slot", async function () {
    const fresh = await freshPoolWithDraw();
    const prize = (await fresh.pool.draws(fresh.drawId)).prize;

    const before: bigint[] = [];
    for (const who of fresh.players) before.push(await balanceOf(fresh.pool, who));

    // Two people check for themselves, then a keeper sweeps the whole pool. Without a
    // guard the sweep credits their award a second time - a winner paid double out of a
    // reserve that only ever set one prize aside.
    await (await fresh.pool.checkClaim(fresh.drawId, fresh.players[0].address)).wait();
    await (await fresh.pool.checkClaim(fresh.drawId, fresh.players[3].address)).wait();

    while (Number(await fresh.pool.sweepCursor(fresh.drawId)) < Number(await fresh.pool.slotsUsed())) {
      await (await fresh.pool.sweepRange(fresh.drawId, 4)).wait();
    }

    let winners = 0;
    let paid = 0n;
    for (let i = 0; i < fresh.players.length; i++) {
      const who = fresh.players[i];
      await (await fresh.usdt.mint(who.address, 1n)).wait();
      await (await fresh.usdt.connect(who).approve(await fresh.pool.getAddress(), 1n)).wait();
      await (await fresh.pool.connect(who).depositUnderlying(1n)).wait();

      const gained = (await balanceOf(fresh.pool, who)) - before[i] - 1n;
      if (gained > 0n) {
        winners++;
        paid += gained;
      }
    }

    expect(winners).to.eq(1);
    expect(paid).to.eq(prize);
  });

  async function balanceOf(p: HushpotPool, who: HardhatEthersSigner): Promise<bigint> {
    await (await p.connect(who).refreshMyBalance()).wait();
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      await p.balanceHandle(await p.slotOf(who.address)),
      await p.getAddress(),
      who,
    );
  }

  async function freshPoolWithDraw() {
    const signers = await ethers.getSigners();
    const o = signers[0];
    const ps = signers.slice(1, DEPOSITORS + 1);

    const u = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const c = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await u.getAddress())) as TestConfidentialWrapper;
    const p = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await c.getAddress(),
    )) as HushpotPool;
    const addr = await p.getAddress();

    await (await u.mint(o.address, 1_000_000_000n)).wait();
    await (await u.connect(o).approve(addr, 1_000_000_000n)).wait();
    await (await p.connect(o).fundPrizeReserve(10_000_000n)).wait();

    for (let i = 0; i < ps.length; i++) {
      const amount = BigInt(1 + i) * 1_000_000n;
      await (await u.mint(ps[i].address, amount)).wait();
      await (await u.connect(ps[i]).approve(addr, amount)).wait();
      await (await p.connect(ps[i]).depositUnderlying(amount)).wait();
    }

    await (await p.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await p.pendingTotalHandle()]);
    await (await p.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();

    return { pool: p, usdt: u, players: ps, drawId: (await p.drawCount()) - 1n };
  }
});
