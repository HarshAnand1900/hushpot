import hre, { ethers } from "hardhat";

/**
 * Withdraw part of a few large positions, to bring the pool back to a size where a
 * newcomer's odds are worth looking at.
 *
 * Partial rather than `exitPool`, which is what `shrink-pool.ts` does: exiting removes the
 * depositor along with the money, and a pool of twenty is part of what makes the demo mean
 * anything. This also flattens the spread, which is the shape a real pool has — a few
 * larger depositors and a long tail, rather than three whales and eighteen minnows.
 *
 * TRIM is "address:amount" pairs, amounts in whole cUSDT.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  const trim = process.env.TRIM;
  if (!pool || !trim) throw new Error("set HUSHPOT_POOL and TRIM=addr:amount,addr:amount");

  await hre.fhevm.initializeCLIApi();
  const signers = await ethers.getSigners();

  for (const pair of trim.split(",")) {
    const [addr, whole] = pair.split(":");
    const who = signers.find((s) => s.address.toLowerCase() === addr.toLowerCase());
    if (!who) {
      console.log(`no signer for ${addr} — skipping`);
      continue;
    }

    const p = await ethers.getContractAt(
      [
        "function withdraw(bytes32,bytes) external",
        "function slotOf(address) view returns (uint16)",
        "function boostedThisPeriod(uint16) view returns (bool)",
      ],
      pool,
      who,
    );

    const slot = await p.slotOf(who.address);
    if (await p.boostedThisPeriod(slot)) {
      console.log(`slot ${slot} took its boost this period — committed, skipping`);
      continue;
    }

    const amount = BigInt(whole) * 1_000_000n;
    const enc = await hre.fhevm.createEncryptedInput(pool, who.address).add64(amount).encrypt();
    const r = await (await p.withdraw(enc.handles[0], enc.inputProof)).wait();
    console.log(`slot ${slot} · withdrew ${whole} · gas ${r?.gasUsed}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
