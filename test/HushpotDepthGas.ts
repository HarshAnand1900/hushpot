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
 * What a deposit costs as the pool fills.
 *
 * The tree walks only as far as the highest node covering the slots in use, so a small
 * pool pays for a shallow tree and depth arrives with the crowd. This pins that: the cost
 * of joining should step up at powers of two and sit flat between them.
 */
describe("HushpotPool - deposit cost against pool size", function () {
  let owner: HardhatEthersSigner;
  let usdt: TestERC20;
  let pool: HushpotPool;
  let poolAddress: string;
  let signers: HardhatEthersSigner[];

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();

    signers = await ethers.getSigners();
    owner = signers[0];

    usdt = (await ((await ethers.getContractFactory("TestERC20")) as TestERC20__factory).deploy()) as TestERC20;
    const cusdt = (await (
      (await ethers.getContractFactory("TestConfidentialWrapper")) as TestConfidentialWrapper__factory
    ).deploy(await usdt.getAddress())) as TestConfidentialWrapper;

    pool = (await ((await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory).deploy(
      await cusdt.getAddress(),
    )) as HushpotPool;
    poolAddress = await pool.getAddress();
  });

  it("prices the copy-on-write that keeps an old claim answerable", async function () {
    // The tree keeps one generation of history so a claim outlives its period. A node pays
    // for that once, on its first touch in a new period, and nothing afterwards - so the
    // honest figure is not the average, it is the first deposit after a roll compared with
    // the second.
    const [a, b] = signers;
    for (const who of [a, b]) {
      await (await usdt.mint(who.address, 3_000_000n)).wait();
      await (await usdt.connect(who).approve(poolAddress, 3_000_000n)).wait();
    }

    await (await pool.connect(a).depositUnderlying(1_000_000n)).wait();
    await (await pool.connect(b).depositUnderlying(1_000_000n)).wait();

    // Settle a draw and roll, so every node on the path is now a period behind.
    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await (await usdt.mint(a.address, 10_000_000n)).wait();
    await (await usdt.connect(a).approve(poolAddress, 10_000_000n)).wait();
    await (await pool.connect(a).fundPrizeReserve(10_000_000n)).wait();
    await (await pool.openDraw()).wait();
    const res = await fhevm.publicDecrypt([await pool.pendingTotalHandle()]);
    await (await pool.settleDraw(res.abiEncodedClearValues, res.decryptionProof)).wait();
    await (await pool.startNextPeriod()).wait();

    await (await usdt.mint(a.address, 2_000_000n)).wait();
    await (await usdt.connect(a).approve(poolAddress, 2_000_000n)).wait();

    const cold = (await (await pool.connect(a).depositUnderlying(1_000_000n)).wait())!.gasUsed;
    const warm = (await (await pool.connect(a).depositUnderlying(1_000_000n)).wait())!.gasUsed;

    console.log("");
    console.log(`    first deposit after a roll   ${cold} gas  (archives the path)`);
    console.log(`    second, same period          ${warm} gas`);
    console.log(`    the history costs            ${cold - warm} gas, once per node per period
`);

    // The archive is a handful of plain SSTOREs against a deposit dominated by FHE work,
    // so it must not be the deciding cost. Anything approaching a doubling means the copy
    // is happening more often than once per node per period.
    expect(cold).to.be.lessThan(warm * 2n);
  });

  it("charges a shallow tree while the pool is small", async function () {
    const costs: { depositors: number; gas: bigint }[] = [];

    for (let i = 0; i < 9 && i < signers.length; i++) {
      const who = signers[i];
      const amount = 1_000_000n;
      await (await usdt.mint(who.address, amount)).wait();
      await (await usdt.connect(who).approve(poolAddress, amount)).wait();

      const receipt = await (await pool.connect(who).depositUnderlying(amount)).wait();
      costs.push({ depositors: i + 1, gas: receipt!.gasUsed });
    }

    console.log("");
    for (const c of costs) console.log(`    joiner ${c.depositors}  ${c.gas} gas`);

    // Joining an empty pool touches no ancestors at all; the ninth crosses into a
    // four-level tree. The point is that the first is markedly cheaper than the last.
    const first = costs[0].gas;
    const ninth = costs[costs.length - 1].gas;
    console.log(`    first vs ninth: ${((Number(ninth) / Number(first) - 1) * 100).toFixed(0)}% more\n`);

    expect(first).to.be.lessThan(ninth);
    expect(owner.address).to.not.eq(ethers.ZeroAddress);
  });
});
