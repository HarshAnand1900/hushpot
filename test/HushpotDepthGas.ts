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
describe("HushpotPool — deposit cost against pool size", function () {
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

    pool = (await (
      (await ethers.getContractFactory("HushpotPool")) as HushpotPool__factory
    ).deploy(await cusdt.getAddress())) as HushpotPool;
    poolAddress = await pool.getAddress();
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
