import { task, types } from "hardhat/config";

/**
 * Operator tasks for Hushpot.
 *
 * These are the documented keeper flow: a draw is two on-chain steps with an off-chain
 * decryption between them, and claims are swept for every participant so nobody has to
 * remember to check whether they won.
 */

const POOL = "HushpotPool";

/** Resolve the deployed pool. `hre.ethers.getContract` is a hardhat-deploy-ethers
 * extension we don't install, so go through the deployments registry.
 *
 * Also initialises the FHEVM plugin. On a real network anything that touches the
 * coprocessor — which is every write here — fails with "The Hardhat Fhevm plugin is not
 * initialized" without it. Cheap and idempotent, so it lives in the shared path. */
async function getPool(hre: any) {
  await hre.fhevm.initializeCLIApi();
  const deployment = await hre.deployments.get(POOL);
  return hre.ethers.getContractAt(POOL, deployment.address);
}

task("hushpot:whoami", "Show the deployer address and its balance").setAction(async (_args, hre) => {
  const { deployer } = await hre.getNamedAccounts();
  const balance = await hre.ethers.provider.getBalance(deployer);
  console.log(`deployer  ${deployer}`);
  console.log(`balance   ${hre.ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.log(`\nFund this address before deploying. Sepolia faucets: https://sepoliafaucet.com`);
  }
});

task("hushpot:status", "Show pool state").setAction(async (_args, hre) => {
  const pool = await getPool(hre);
  const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);

  const periodStart = await pool.periodStart();
  const periodSeconds = await pool.PERIOD_SECONDS();
  const ended = await pool.periodEnded();
  const remaining = ended ? 0n : periodStart + periodSeconds - now;

  console.log(`pool            ${await pool.getAddress()}`);
  console.log(`token           ${await pool.token()}`);
  console.log(`underlying      ${await pool.underlyingToken()}`);
  console.log(`auto-shield     ${await pool.supportsAutoShield()}`);
  console.log(`period          #${await pool.currentPeriod()}`);
  console.log(`minute          ${await pool.minuteOfPeriod()} / ${await pool.PERIOD_MINUTES()}`);
  console.log(`period ended    ${ended}${ended ? "" : `  (${remaining / 3600n}h remaining)`}`);
  console.log(`depositors      ${await pool.slotsUsed()}`);
  console.log(`prize reserve   ${await pool.prizeReserve()}`);
  console.log(`annual rate     ${await pool.annualRateBps()} bps`);
  const drawCount = await pool.drawCount();
  console.log(`draws settled   ${drawCount}`);
  console.log(`draw pending    ${await pool.drawPending()}`);

  if (drawCount > 0n) {
    const id = drawCount - 1n;
    const draw = await pool.draws(id);
    console.log(``);
    console.log(`last draw       #${id}`);
    console.log(`  pool total    ${draw.total} ticket-minutes`);
    console.log(`  prize         ${draw.prize}`);
    console.log(`  period        #${draw.period}`);
    console.log(`  claim window  ${draw.period === (await pool.currentPeriod()) ? "open" : "closed"}`);
    console.log(`  winner        never resolved — the point of the whole thing`);
  }
});

/** Zama's USDTMock reverts on a single mint above ~1,000,000 tokens. Chunk around it. */
const MINT_CHUNK = 1_000_000_000_000n; // 1,000,000 tokens at 6 decimals

/**
 * Approve, working around real-USDT semantics.
 *
 * USDTMock copies Tether's original behaviour: approving a non-zero amount while a
 * non-zero allowance already exists reverts. So any leftover allowance has to be zeroed
 * first. The frontend's deposit flow needs this same dance.
 */
async function ensureAllowance(token: any, owner: string, spender: string, amount: bigint) {
  const current: bigint = await token.allowance(owner, spender);
  if (current >= amount) return;

  if (current > 0n) {
    console.log(`clearing a stale allowance of ${current}...`);
    await (await token.approve(spender, 0n)).wait();
  }

  console.log(`approving ${amount}...`);
  await (await token.approve(spender, amount)).wait();
}

task("hushpot:faucet", "Mint yourself test tokens from the underlying's open faucet")
  .addParam("amount", "Amount in base units (6 decimals)", undefined, types.string)
  .setAction(async (args, hre) => {
    const { deployer } = await hre.getNamedAccounts();
    const pool = await getPool(hre);
    const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());

    let remaining = BigInt(args.amount);
    if (remaining > MINT_CHUNK) {
      console.log(`the faucet caps a single mint at ${MINT_CHUNK / 1_000_000n} tokens — splitting`);
    }

    while (remaining > 0n) {
      const chunk = remaining > MINT_CHUNK ? MINT_CHUNK : remaining;
      const tx = await underlying.mint(deployer, chunk);
      console.log(`minting ${chunk / 1_000_000n} tokens... ${tx.hash}`);
      await tx.wait();
      remaining -= chunk;
    }

    const balance: bigint = await underlying.balanceOf(deployer);
    console.log(`balance ${balance / 1_000_000n} tokens (${balance} base units)`);
  });

task("hushpot:deposit", "Deposit plain tokens, shielded automatically by the pool")
  .addParam("amount", "Amount in base units (6 decimals)", undefined, types.string)
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const amount = BigInt(args.amount);
    const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());
    const { deployer } = await hre.getNamedAccounts();

    // An ERC-20 transferFrom that exceeds the balance reverts with no reason string, which
    // surfaces as an opaque gas-estimation failure. Say what actually went wrong.
    const balance: bigint = await underlying.balanceOf(deployer);
    if (balance < amount) {
      console.log(`not enough tokens: you hold ${balance / 1_000_000n}, tried to deposit ${amount / 1_000_000n}`);
      console.log(`mint more:  npx hardhat hushpot:faucet --amount ${amount - balance} --network ${hre.network.name}`);
      return;
    }

    await ensureAllowance(underlying, deployer, await pool.getAddress(), amount);

    console.log(`depositing ${amount} (this is the heaviest encrypted operation)...`);
    const tx = await pool.depositUnderlying(amount);
    const receipt = await tx.wait();

    console.log(`  tx       ${tx.hash}`);
    console.log(`  gas used ${receipt?.gasUsed}`);
    console.log(`  slot     ${await pool.slotOf((await hre.getNamedAccounts()).deployer)}`);
  });

task("hushpot:fund", "Top up the prize reserve with plain tokens")
  .addParam("amount", "Amount in base units (6 decimals)", undefined, types.string)
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const amount = BigInt(args.amount);

    const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());
    const { deployer } = await hre.getNamedAccounts();

    await ensureAllowance(underlying, deployer, await pool.getAddress(), amount);

    console.log(`funding reserve...`);
    await (await pool.fundPrizeReserve(amount)).wait();

    console.log(`reserve is now ${await pool.prizeReserve()}`);
  });

task("hushpot:draw", "Run a full draw: open, decrypt the total off-chain, settle")
  .addFlag("force", "Open early as owner, without waiting for the period to end")
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);

    if (!(await pool.drawPending())) {
      if (!(await pool.periodEnded()) && !args.force) {
        console.log(`Period has not ended. Re-run with --force to open early as owner.`);
        return;
      }
      console.log(`opening draw...`);
      await (await pool.openDraw()).wait();
    } else {
      console.log(`a draw is already open — settling it`);
    }

    // The off-chain half. The relayer cannot lie about the total: settleDraw verifies the
    // proof on-chain and reverts on a mismatch. It can only decline to relay.
    const handle = await pool.pendingTotalHandle();
    console.log(`decrypting pool total off-chain...`);
    await hre.fhevm.initializeCLIApi();
    const decrypted = await hre.fhevm.publicDecrypt([handle]);

    console.log(`settling...`);
    await (await pool.settleDraw(decrypted.abiEncodedClearValues, decrypted.decryptionProof)).wait();

    const id = (await pool.drawCount()) - 1n;
    const draw = await pool.draws(id);
    console.log(`\ndraw #${id} settled`);
    console.log(`  pool total   ${draw.total} ticket-minutes`);
    console.log(`  prize        ${draw.prize}`);
    console.log(`  winner       unknown — and it stays that way`);
  });

task("hushpot:sweep", "Check a draw for every depositor, paying whoever won")
  .addParam("draw", "Draw id", undefined, types.string)
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const drawId = BigInt(args.draw);

    const slots = Number(await pool.slotsUsed());
    const accounts: string[] = [];
    for (let slot = 0; slot < slots; slot++) {
      accounts.push(await pool.slotOwner(slot));
    }

    console.log(`sweeping draw #${drawId} across ${accounts.length} depositors...\n`);

    // One transaction per depositor, not one for all of them. A claim is ~60-80 encrypted
    // operations — the prefix walk, the range comparison, the select and the credit — so
    // even a handful together exceed the per-transaction HCU ceiling. `checkClaimBatch`
    // exists for small batches; a real keeper should page through like this.
    for (const account of accounts) {
      const slot = await pool.slotOf(account);
      if (await pool.claimChecked(drawId, slot)) {
        console.log(`  ${account}  already checked`);
        continue;
      }

      const tx = await pool.checkClaim(drawId, account);
      const receipt = await tx.wait();
      console.log(`  ${account}  checked · gas ${receipt?.gasUsed}`);
    }

    console.log(`\nThe prize has landed in one of those balances.`);
    console.log(`Only its owner can decrypt it, so nobody here — including us — knows which.`);
  });

/**
 * Fill the pool with several depositors of different sizes.
 *
 * A pool with one participant demonstrates nothing: odds read 100%, there is no second
 * balance for the privacy demo to fail on, and "the winner is one of everyone in this
 * pool" is a sentence about one person. This seeds a realistic spread from the accounts
 * the configured mnemonic already derives.
 */
task("hushpot:seed", "Fill the pool with several depositors, so the demo means something")
  .addOptionalParam("count", "How many extra depositors (max 9)", "4", types.string)
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const poolAddress = await pool.getAddress();
    const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());

    const signers = await hre.ethers.getSigners();
    const funder = signers[0];
    const count = Math.min(Number(args.count), signers.length - 1);

    // Deliberately uneven, so odds are visibly different per depositor.
    const amounts = [420_000n, 180_000n, 640_000n, 95_000n, 310_000n, 55_000n, 720_000n, 240_000n, 130_000n];
    const GAS_TOPUP = hre.ethers.parseEther("0.03");

    console.log(`seeding ${count} depositors into ${poolAddress}\n`);

    for (let i = 1; i <= count; i++) {
      const who = signers[i];
      const amount = amounts[i - 1] * 1_000_000n;

      console.log(`--- depositor ${i}: ${who.address}`);

      // Gas, if they need it.
      const eth = await hre.ethers.provider.getBalance(who.address);
      if (eth < hre.ethers.parseEther("0.015")) {
        console.log(`  topping up gas...`);
        await (await funder.sendTransaction({ to: who.address, value: GAS_TOPUP })).wait();
      }

      // The faucet mints to any address, so the funder can do this on their behalf.
      const held: bigint = await underlying.balanceOf(who.address);
      if (held < amount) {
        console.log(`  minting ${amount / 1_000_000n} tokens...`);
        let remaining = amount - held;
        while (remaining > 0n) {
          const chunk = remaining > MINT_CHUNK ? MINT_CHUNK : remaining;
          await (await underlying.mint(who.address, chunk)).wait();
          remaining -= chunk;
        }
      }

      await ensureAllowance(underlying.connect(who), who.address, poolAddress, amount);

      console.log(`  depositing ${amount / 1_000_000n}...`);
      const tx = await (pool.connect(who) as typeof pool).depositUnderlying(amount);
      const receipt = await tx.wait();
      console.log(`  done · slot ${await pool.slotOf(who.address)} · gas ${receipt?.gasUsed}\n`);
    }

    console.log(`depositors now: ${await pool.slotsUsed()}`);
    console.log(`\nRun a draw next, so the new spread is reflected:`);
    console.log(`  npx hardhat hushpot:draw --force --network ${hre.network.name}`);
  });

task("hushpot:solvency", "Prove on-chain that every deposit is still backed").setAction(async (_args, hre) => {
  const pool = await getPool(hre);

  console.log(`comparing what the pool holds against what it owes, on ciphertext...`);
  await (await pool.proveSolvency()).wait();

  const handle = await pool.solvencyHandle();
  const backed = await hre.fhevm.publicDecryptEbool(handle);

  console.log(`\nfully backed   ${backed}`);
  console.log(`proven at      ${new Date(Number(await pool.solvencyProvenAt()) * 1000).toISOString()}`);
  console.log(`\nNeither the holdings nor the liabilities were revealed to establish that.`);
});

task("hushpot:next-period", "Close the claim window and start the next period").setAction(async (_args, hre) => {
  const pool = await getPool(hre);
  await (await pool.startNextPeriod()).wait();
  console.log(`now in period #${await pool.currentPeriod()}`);
});
