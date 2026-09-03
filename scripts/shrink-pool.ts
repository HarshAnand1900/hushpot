import { ethers } from "hardhat";

/**
 * Take some seeded depositors back out, so a newcomer's stake is not lost in the pool.
 *
 * Odds are your share, so a pool that dwarfs anything a visitor can deposit makes the
 * product look pointless: 100,000 into 1.17M is 7.9%, and the faucet does not hand out
 * more. Shrinking the pool raises a newcomer's share and lowers the prize by the same
 * proportion — the two move together, which is the design working, so the only question is
 * where to sit on that line.
 *
 * `exitPool` rather than a partial withdraw: no encrypted input to build, and it is the
 * path a real depositor leaving would take.
 */
async function main() {
  const indices = (process.env.EXIT_INDICES ?? "").split(",").filter(Boolean).map(Number);
  if (indices.length === 0) throw new Error("set EXIT_INDICES, e.g. 6,2,8");

  const pool = process.env.HUSHPOT_POOL;
  if (!pool) throw new Error("set HUSHPOT_POOL");

  const signers = await ethers.getSigners();
  const p = await ethers.getContractAt(
    [
      "function exitPool() external",
      "function hasSlot(address) view returns (bool)",
      "function slotsUsed() view returns (uint16)",
    ],
    pool,
  );

  for (const i of indices) {
    const who = signers[i];
    if (!who) {
      console.log(`  signer ${i} not available — skipped`);
      continue;
    }
    if (!(await p.hasSlot(who.address))) {
      console.log(`  ${who.address} holds no slot — skipped`);
      continue;
    }
    const tx = await p.connect(who).exitPool();
    const r = await tx.wait();
    console.log(`  exited ${who.address} · gas ${r?.gasUsed}`);
  }

  console.log(`slotsUsed now ${await p.slotsUsed()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
