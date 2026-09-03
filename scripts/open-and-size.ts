import hre, { ethers } from "hardhat";

/**
 * Open the draw, publish the total, and report what the prize would be.
 *
 * Split out from `hushpot:draw`, which opens, decrypts and settles in one breath. A
 * sponsorship has to land between the second and third of those: `settleDraw` reads
 * `sponsoredThisDraw` as it sizes the prize, and the total it would be sponsoring against
 * is not known until the draw is open.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  if (!pool) throw new Error("set HUSHPOT_POOL");

  const [signer] = await ethers.getSigners();
  const p = await ethers.getContractAt(
    [
      "function openDraw() external",
      "function drawPending() view returns (bool)",
      "function pendingTotalHandle() view returns (bytes32)",
      "function prizeFor(uint64) view returns (uint64)",
      "function prizeReserve() view returns (uint64)",
    ],
    pool,
    signer,
  );

  if (!(await p.drawPending())) {
    console.log("opening the draw...");
    await (await p.openDraw()).wait();
  } else {
    console.log("a draw is already pending; reading its total");
  }

  const handle = await p.pendingTotalHandle();
  // A `run` script does not get the plugin bootstrapped the way a task does.
  await hre.fhevm.initializeCLIApi();
  const res = await hre.fhevm.publicDecrypt([handle]);
  const total = BigInt(Object.values(res.clearValues ?? {})[0] as string | bigint);

  const pooled = total / 10080n;
  const derived = await p.prizeFor(total);
  console.log(`ticket-minutes ${total}`);
  console.log(`pooled         ${(Number(pooled) / 1e6).toFixed(2)} cUSDT`);
  console.log(`derived prize  ${(Number(derived) / 1e6).toFixed(2)} cUSDT  (${derived} base units)`);
  console.log(`reserve        ${(Number(await p.prizeReserve()) / 1e6).toFixed(2)} cUSDT`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
