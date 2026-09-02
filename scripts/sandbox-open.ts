import { ethers } from "hardhat";

/**
 * Open a draw on the sandbox, through the contract that owns it.
 *
 * `hushpot:draw` calls `openDraw` on the pool directly, which is correct for a pool whose
 * owner is the deployer. The sandbox's owner is {SandboxOperator}, so the same call reverts
 * with `PeriodNotElapsed` until the week is up — the operator exists precisely so any wallet
 * can skip that wait, and this is the path a judge takes from the panel.
 */
async function main() {
  const operator = process.env.HUSHPOT_OPERATOR;
  if (!operator) throw new Error("set HUSHPOT_OPERATOR");

  const [caller] = await ethers.getSigners();
  const op = await ethers.getContractAt(["function openDraw() external"], operator, caller);

  console.log(`opening the sandbox draw through ${operator}...`);
  const tx = await op.openDraw();
  const receipt = await tx.wait();
  console.log(`  done · gas ${receipt?.gasUsed}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
