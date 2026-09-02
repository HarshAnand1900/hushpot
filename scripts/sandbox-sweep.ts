import { ethers } from "hardhat";

/** Page a sweep through `sweepRange`, which is the path the judge panel's step 04 uses. */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
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

  const [covered] = await p.claims(0);
  console.log(`sweeping draw 0 · ${covered} slots covered`);

  while (Number(await p.sweepCursor(0)) < Number(covered)) {
    const tx = await p.sweepRange(0, 4);
    const r = await tx.wait();
    console.log(`  cursor ${await p.sweepCursor(0)} / ${covered} · gas ${r?.gasUsed}`);
  }
  const [cov, chk] = await p.claims(0);
  console.log(`done · claims(0) covered ${cov} checked ${chk} · sweepCursor ${await p.sweepCursor(0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
