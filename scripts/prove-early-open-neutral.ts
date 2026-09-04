import hre, { ethers } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

/**
 * Live proof: a deposit made after an early openDraw carries zero weight for this period.
 *
 * Deposits as a fresh signer into a pool with a draw already pending, then decrypts that
 * signer's own weight. If the fix holds, it reads zero - the deposit is fully neutral,
 * exactly as one made after the period has genuinely ended would be.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  if (!pool) throw new Error("set HUSHPOT_POOL");
  const which = Number(process.env.SIGNER ?? "10");
  const amount = BigInt(process.env.AMOUNT ?? "1000") * 1_000_000n;

  await hre.fhevm.initializeCLIApi();
  const signers = await ethers.getSigners();
  const who = signers[which];

  const known = (await import("../config/addresses")).addressesFor(
    Number(await hre.ethers.provider.getNetwork().then((n) => n.chainId)),
  );
  if (!known) throw new Error("no known token addresses for this chain");

  const usdt = await ethers.getContractAt(
    ["function mint(address,uint256) external", "function approve(address,uint256) external"],
    known.underlyingToken,
    who,
  );
  const p = await ethers.getContractAt(
    [
      "function depositUnderlying(uint256) external",
      "function drawPending() view returns (bool)",
      "function periodEnded() view returns (bool)",
      "function refreshMyWeight() external",
      "function weightHandle(uint16) view returns (bytes32)",
      "function slotOf(address) view returns (uint16)",
    ],
    pool,
    who,
  );

  console.log(`drawPending: ${await p.drawPending()} · periodEnded: ${await p.periodEnded()}`);

  await (await usdt.mint(who.address, amount)).wait();
  await (await usdt.approve(pool, amount)).wait();
  const r = await (await p.depositUnderlying(amount)).wait();
  console.log(`deposited ${amount / 1_000_000n} · gas ${r?.gasUsed}`);

  await (await p.refreshMyWeight()).wait();
  const slot = await p.slotOf(who.address);
  const handle = await p.weightHandle(slot);

  const res = await hre.fhevm.userDecryptEuint(FhevmType.euint64, handle, pool, who as never);
  console.log(`weight for this period (should be 0) = ${res}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
