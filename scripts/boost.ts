import { ethers } from "hardhat";

/**
 * Exercise the loyalty boost on the live pool.
 *
 * The mock does not enforce HCU limits, so seven passing tests say the arithmetic is right
 * and say nothing about whether the transaction fits. This runs it where it counts.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  if (!pool) throw new Error("set HUSHPOT_POOL");
  const which = Number(process.env.SIGNER ?? "1");

  const signers = await ethers.getSigners();
  const who = signers[which];
  const p = await ethers.getContractAt(
    [
      "function boostStreak() external",
      "function streakOf(address) view returns (uint32)",
      "function boostedThisPeriod(uint16) view returns (bool)",
      "function slotOf(address) view returns (uint16)",
      "function refreshMyWeight() external",
      "function weightHandle(uint16) view returns (bytes32)",
    ],
    pool,
    who,
  );

  const slot = await p.slotOf(who.address);
  const streak = await p.streakOf(who.address);
  console.log(`${who.address} · slot ${slot} · streak ${streak} period(s)`);

  if (await p.boostedThisPeriod(slot)) {
    console.log("already boosted this period");
    return;
  }

  const r = await (await p.boostStreak()).wait();
  console.log(`boosted · gas ${r?.gasUsed} · multiplier ${(1 + Number(streak) * 0.1).toFixed(1)}x`);
  console.log(`boostedThisPeriod -> ${await p.boostedThisPeriod(slot)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
