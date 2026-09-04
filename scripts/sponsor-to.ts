import { ethers } from "hardhat";

/**
 * Sponsor the next draw up to a target prize.
 *
 * The prize is derived, not chosen: `pooled * rate / 52`. That is the property worth
 * keeping - a late depositor grows the pot exactly as much as they grow their own odds -
 * and it means a pool sized for decent newcomer odds necessarily shows a modest prize.
 *
 * `sponsorPrize` is the sanctioned way out of that, and it is reserve-neutral over one
 * draw: the money joins the reserve and the very next prize by the same amount, so the
 * tank is the same depth afterwards.
 */
async function main() {
  const pool = process.env.HUSHPOT_POOL;
  const target = BigInt(process.env.TARGET ?? "0");
  if (!pool || target === 0n) throw new Error("set HUSHPOT_POOL and TARGET (base units)");

  const [signer] = await ethers.getSigners();
  const p = await ethers.getContractAt(
    [
      "function prizeFor(uint64) view returns (uint64)",
      "function pendingTotalHandle() view returns (bytes32)",
      "function sponsorPrize(uint256) external",
      "function sponsoredThisDraw() view returns (uint64)",
      "function prizeReserve() view returns (uint64)",
      "function underlyingToken() view returns (address)",
    ],
    pool,
    signer,
  );

  const underlying = await p.underlyingToken();
  const erc20 = await ethers.getContractAt(
    ["function mint(address,uint256) external", "function approve(address,uint256) external"],
    underlying,
    signer,
  );

  // The pool total is only published at settlement, so size the gap from the draw the
  // caller passes in rather than guessing at it here.
  const derived = BigInt(process.env.DERIVED ?? "0");
  const already = await p.sponsoredThisDraw();
  const gap = target - derived - already;
  if (gap <= 0n) {
    console.log(`nothing to do: derived ${derived} + sponsored ${already} already >= ${target}`);
    return;
  }

  console.log(`derived ${derived} + sponsor ${gap} -> prize ${target}`);
  await (await erc20.mint(signer.address, gap)).wait();
  await (await erc20.approve(pool, gap)).wait();
  await (await p.sponsorPrize(gap)).wait();
  console.log(`sponsored ${await p.sponsoredThisDraw()} · reserve ${await p.prizeReserve()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
