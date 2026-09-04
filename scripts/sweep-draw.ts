import { ethers } from "hardhat";

/**
 * Page a sweep with `sweepRange`, which walks slot indices rather than accounts.
 *
 * `hushpot:sweep` calls `checkClaim(drawId, account)` per depositor, and `slotOf` reverts
 * for an account that has left - so one `exitPool` anywhere in the pool stops the whole
 * task. `sweepRange` iterates the slots the draw covered, ownerless ones included, which
 * is the case it was written for.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  const drawId = Number(process.env.DRAW ?? "0");
  if (!pool) throw new Error("set HUSHPOT_POOL");

  const [caller] = await ethers.getSigners();
  const p = await ethers.getContractAt(
    [
      "function sweepRange(uint256,uint16) external",
      "function sweepCursor(uint256) view returns (uint16)",
      "function claims(uint256) view returns (uint16,uint16)",
    ],
    pool,
    caller,
  );

  const [covered] = await p.claims(drawId);
  console.log(`draw ${drawId} · ${covered} slots covered`);

  while (Number(await p.sweepCursor(drawId)) < Number(covered)) {
    const r = await (await p.sweepRange(drawId, 3)).wait();
    console.log(`  cursor ${await p.sweepCursor(drawId)} / ${covered} · gas ${r?.gasUsed}`);
  }
  const [cov, chk] = await p.claims(drawId);
  console.log(`done · covered ${cov} checked ${chk}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
