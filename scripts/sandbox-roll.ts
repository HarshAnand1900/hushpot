import { ethers } from "hardhat";

/** Roll the sandbox period through its operator, permissionless. */
async function main() {
  const operator = process.env.HUSHPOT_OPERATOR;
  if (!operator) throw new Error("set HUSHPOT_OPERATOR");
  const [caller] = await ethers.getSigners();
  const op = await ethers.getContractAt(["function startNextPeriod() external"], operator, caller);
  const receipt = await (await op.startNextPeriod()).wait();
  console.log(`rolled · gas ${receipt?.gasUsed}`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
