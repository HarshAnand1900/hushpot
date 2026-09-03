/**
 * Regenerate the live figures in README.md's "What is running right now" table.
 *
 * Those numbers are the first thing a reviewer checks, and they go stale every time a
 * draw settles or somebody deposits — which during a submission week is constantly. A
 * pre-submission audit found the table claiming 20 depositors and 2 draws against a chain
 * holding 21 and 3, so this exists to make re-reading them a single command rather than
 * six calls assembled by hand.
 *
 * Reads both pools. Everything printed is a public getter; nothing here decrypts.
 *
 *   npx hardhat run scripts/audit-state.ts --network sepolia
 */
import { ethers } from "hardhat";

const POOLS = {
  main: "0x4ac487b46d687EB92078c8565FF0FEEa7690b830",
  sandbox: "0x08E5c466a8c5a5FCccEd833e1E9dC8D5B145D279",
};

/** The contract's own derivation, mirrored so a sponsored top-up is visible as the gap. */
const RATE_DIVISOR = 10_000n * 525_600n;

async function main() {
  for (const [name, addr] of Object.entries(POOLS)) {
    const pool = await ethers.getContractAt("HushpotPool", addr);
    const [period, slots, reserve, drawCount, pending, rate] = await Promise.all([
      pool.currentPeriod(),
      pool.slotsUsed(),
      pool.prizeReserve(),
      pool.drawCount(),
      pool.drawPending(),
      pool.annualRateBps(),
    ]);

    console.log(`\n===== ${name.toUpperCase()}  ${addr} =====`);
    console.log(
      `period #${period}  depositors ${slots}  reserve ${ethers.formatUnits(reserve, 6)}  ` +
        `rate ${rate}bps  drawPending ${pending}`,
    );

    for (let i = 0n; i < drawCount; i++) {
      const d = await pool.draws(i);
      const c = await pool.claims(i);
      const derived = (d.total * rate) / RATE_DIVISOR;
      const sponsored = d.prize - derived;
      const settledAt = Number(d.settledAt ?? 0);
      const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

      console.log(
        `  draw #${i}: prize ${ethers.formatUnits(d.prize, 6)} ` +
          `(${ethers.formatUnits(derived, 6)} derived + ${ethers.formatUnits(sponsored, 6)} sponsored)  ` +
          `principal ${ethers.formatUnits(d.total / 10080n, 6)}  period ${d.period}  ` +
          `checked ${c.checked}/${slots}  ` +
          `settled ${settledAt ? day(settledAt) : "?"}  claims close ${settledAt ? day(settledAt + 30 * 86400) : "?"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
