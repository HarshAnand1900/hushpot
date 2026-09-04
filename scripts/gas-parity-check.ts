import { ethers } from "hardhat";

/**
 * Empirical check: does an individual checkClaim cost the same gas regardless of whether
 * the slot won or lost? Calls it individually (not batched) for several slots on an
 * unswept draw and prints gas per call, so the numbers can be compared directly rather
 * than trusted from the design description alone.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  const drawId = process.env.DRAW ?? "1";
  const slots = (process.env.SLOTS ?? "0,1,2,3").split(",").map(Number);
  if (!pool) throw new Error("set HUSHPOT_POOL");

  const [caller] = await ethers.getSigners();
  const p = await ethers.getContractAt(
    [
      "function checkClaim(uint256,address) external",
      "function slotOwner(uint16) view returns (address)",
      "function claimChecked(uint256,uint16) view returns (bool)",
    ],
    pool,
    caller,
  );

  for (const slot of slots) {
    const owner = await p.slotOwner(slot);
    const already = await p.claimChecked(drawId, slot);
    if (already) {
      console.log(`slot ${slot} (${owner}) - already checked, skipping`);
      continue;
    }
    const r = await (await p.checkClaim(drawId, owner)).wait();
    console.log(`slot ${slot} (${owner}) - gas ${r?.gasUsed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
