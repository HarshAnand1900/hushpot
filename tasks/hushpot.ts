import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";

/** The slice of an ERC-20 these tasks touch, so the helpers need no `any`. */
interface ApprovableToken {
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<{ wait(): Promise<unknown> }>;
}

/**
 * Operator tasks for Hushpot.
 *
 * These are the documented keeper flow: a draw is two on-chain steps with an off-chain
 * decryption between them, and claims are swept for every participant so nobody has to
 * remember to check whether they won.
 */

const POOL = "HushpotPool";

/**
 * Deposit the way the product does - confidentially.
 *
 * These tasks used `depositUnderlying`, which is a plain ERC-20 transfer and publishes the
 * amount. That is a documented convenience route in the contract, but using it to seed a
 * demo filled the contract log with sixty deposits in the clear, on a site whose headline
 * claim is that amounts are encrypted. The log was telling the truth and the demo was
 * making the opposite argument.
 *
 * So the seeder does what a real depositor does: shield the tokens, grant the pool
 * operator rights once, then submit a ciphertext. Nothing about the amount reaches the
 * chain in the clear, and the log reads `••••••` like every other confidential deposit.
 */
async function depositConfidentially(
  hre: HardhatRuntimeEnvironment,
  pool: Awaited<ReturnType<typeof getPool>>,
  who: HardhatEthersSigner,
  amount: bigint,
) {
  const poolAddress = await pool.getAddress();
  const token = await hre.ethers.getContractAt("TestConfidentialWrapper", await pool.token());
  const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());

  // Shield first: wrapping is public either way, and keeping it a separate transaction is
  // what breaks the timing link between acquiring the token and depositing it.
  await ensureAllowance(underlying.connect(who), who.address, await token.getAddress(), amount);
  await (await (token.connect(who) as typeof token).wrap(who.address, amount)).wait();

  // ERC-7984's approval: time-bounded rather than amount-bounded, so it cannot leak a size.
  const until = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  if (!(await token.isOperator(who.address, poolAddress))) {
    await (await (token.connect(who) as typeof token).setOperator(poolAddress, until)).wait();
  }

  await hre.fhevm.initializeCLIApi();
  const enc = await hre.fhevm.createEncryptedInput(poolAddress, who.address).add64(amount).encrypt();

  return (await (pool.connect(who) as typeof pool).deposit(enc.handles[0], enc.inputProof)).wait();
}

/** Resolve the deployed pool. `hre.ethers.getContract` is a hardhat-deploy-ethers
 * extension we don't install, so go through the deployments registry.
 *
 * Also initialises the FHEVM plugin. On a real network anything that touches the
 * coprocessor - which is every write here - fails with "The Hardhat Fhevm plugin is not
 * initialized" without it. Cheap and idempotent, so it lives in the shared path. */
async function getPool(hre: HardhatRuntimeEnvironment) {
  await hre.fhevm.initializeCLIApi();
  // `HUSHPOT_POOL` points every task at a different deployment of the same contract -
  // the judge sandbox, mainly, which is deployed outside the registry precisely so it
  // cannot be confused with the real pool. Unset, this is the deployed one.
  const override = process.env.HUSHPOT_POOL;
  if (override) {
    if (!hre.ethers.isAddress(override)) throw new Error(`HUSHPOT_POOL is not an address: ${override}`);
    return hre.ethers.getContractAt(POOL, override);
  }
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
    console.log(`  winner        never resolved - the point of the whole thing`);
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
async function ensureAllowance(token: ApprovableToken, owner: string, spender: string, amount: bigint) {
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
      console.log(`the faucet caps a single mint at ${MINT_CHUNK / 1_000_000n} tokens - splitting`);
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

task("hushpot:deposit", "Deposit with the amount encrypted in the browser-equivalent flow")
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

    console.log(`depositing ${amount}, confidentially (the heaviest encrypted operation)...`);
    const [me] = await hre.ethers.getSigners();
    const receipt = await depositConfidentially(hre, pool, me, amount);

    console.log(`  tx       ${receipt?.hash}`);
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

    // Mint what is missing. The task approved without checking the balance, so on a fresh
    // deployment it reverted inside `transferFrom` with no reason string, which surfaces
    // as an opaque gas-estimation failure. The faucet is open to everyone anyway.
    const held: bigint = await underlying.balanceOf(deployer);
    if (held < amount) {
      console.log(`minting ${(amount - held) / 1_000_000n} tUSDT to cover the top-up...`);
      await (await underlying.mint(deployer, amount - held)).wait();
    }

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
      console.log(`a draw is already open - settling it`);
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
    console.log(`  winner       unknown - and it stays that way`);
  });

task("hushpot:sweep", "Check a draw for every depositor, paying whoever won")
  .addParam("draw", "Draw id", undefined, types.string)
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const drawId = BigInt(args.draw);

    const slots = Number(await pool.slotsUsed());
    const accounts: string[] = [];
    for (let slot = 0; slot < slots; slot++) {
      const owner = await pool.slotOwner(slot);
      // A slot given up with `exitPool` reads as the zero address until the roll releases
      // it, and `checkClaim(drawId, address(0))` reverts `NoSlotAssigned` - which used to
      // abort the whole sweep partway through. The contract already handles this case in
      // both `checkClaimBatch` and `_sweepSlot`; only this loop did not.
      if (owner === hre.ethers.ZeroAddress) continue;
      accounts.push(owner);
    }

    console.log(`sweeping draw #${drawId} across ${accounts.length} depositors...\n`);

    // One transaction per depositor, not one for all of them. A claim is ~60-80 encrypted
    // operations - the prefix walk, the range comparison, the select and the credit - so
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
    console.log(`Only its owner can decrypt it, so nobody here - including us - knows which.`);
  });

/**
 * Retry a transaction through a transient RPC failure.
 *
 * Public Sepolia endpoints lag behind their own mempool, so a burst of transactions from
 * one wallet gets rejected as "replacement transaction underpriced" even when the previous
 * one was mined - the node hands out a stale nonce. Backing off and retrying is enough.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /underpriced|nonce|already known|timeout|missing response|ETIMEDOUT/i.test(message);
      if (!transient || attempt >= attempts) throw error;

      const pause = 5000 * attempt;
      console.log(`  ${label} failed: ${message.slice(0, 70)} - retrying in ${pause / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/**
 * Fill the pool with several depositors of different sizes.
 *
 * A pool with one participant demonstrates nothing: odds read 100%, there is no second
 * balance for the privacy demo to fail on, and "the winner is one of everyone in this
 * pool" is a sentence about one person. This seeds a realistic spread from the accounts
 * the configured mnemonic already derives.
 */
task("hushpot:seed", "Fill the pool with several depositors, so the demo means something")
  .addOptionalParam("count", "How many extra depositors", "4", types.string)
  .addOptionalParam("scale", "Multiply every amount, to reach a realistic pool size", "1", types.string)
  .addFlag("topUp", "Deposit again for accounts that already hold a slot")
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const poolAddress = await pool.getAddress();
    const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());

    const signers = await hre.ethers.getSigners();
    const funder = signers[0];
    const count = Math.min(Number(args.count), signers.length - 1);

    // Deliberately uneven and long-tailed: a real pool is a few larger depositors and a
    // lot of small ones, which is the shape that makes the odds column worth looking at.
    //
    // Kept in the hundreds-to-thousands, not the hundreds of thousands. Seeded accounts
    // that dwarf the real wallets make the demo worse in two ways: whoever is presenting
    // has no meaningful odds against them, and the prize - which scales with the pool -
    // drains the reserve in a couple of draws. This spread totals around 76,000, so a
    // full week yields roughly 73 cUSDT and the reserve lasts hundreds of cycles.
    const amounts = [
      3_200n,
      850n,
      6_400n,
      420n,
      2_100n,
      1_350n,
      9_000n,
      640n,
      4_700n,
      380n,
      1_800n,
      2_950n,
      520n,
      7_300n,
      1_150n,
      460n,
      3_800n,
      980n,
      5_600n,
      1_600n,
      720n,
      2_400n,
      340n,
      4_100n,
      1_050n,
      880n,
      6_900n,
      1_450n,
      2_700n,
      590n,
    ];
    // Enough for an approve and a confidential deposit (~2.4M gas) with headroom for a
    // gas spike, without stranding ETH in wallets we only use to make the demo real.
    const GAS_TOPUP = hre.ethers.parseEther("0.008");

    console.log(`seeding ${count} depositors into ${poolAddress}\n`);

    for (let i = 1; i <= count; i++) {
      const who = signers[i];
      // Scaled because the prize is a *rate* on the pool, not a fixed figure: at 5% APY a
      // week pays roughly 0.096% of whatever is deposited, so a 1,000 weekly prize needs
      // about 1,040,000 in the pool. A small pool with a large prize would be a lie about
      // the yield; a larger pool with a proportional prize is simply what the arithmetic
      // says a real one looks like.
      // The table holds thirty spreads; past that it wraps rather than throwing. Asking
      // for more depositors than there are amounts used to fail with "Cannot mix BigInt
      // and other types" - an undefined array slot, thirty deposits into a run that had
      // already spent real gas.
      const amount = amounts[(i - 1) % amounts.length] * 1_000_000n * BigInt(args.scale);

      console.log(`--- depositor ${i}: ${who.address}`);

      // Resumable. Public RPCs drop transactions and lag on nonces, so this task will be
      // re-run; anyone already holding a slot is already a depositor and re-depositing
      // for them just burns gas and skews the spread we set up.
      // Unless `--top-up`, which is how an existing pool is grown rather than widened:
      // the prize is a rate on the pool, so raising the prize means raising the deposits,
      // not adding more addresses holding the same small amounts.
      const hasSlot = await pool.hasSlot(who.address);
      if (hasSlot && !args.topUp) {
        console.log(`  already in the pool · slot ${await pool.slotOf(who.address)}
`);
        continue;
      }
      if (hasSlot) console.log(`  topping up slot ${await pool.slotOf(who.address)}`);

      // Gas, if they need it.
      const eth = await hre.ethers.provider.getBalance(who.address);
      if (eth < hre.ethers.parseEther("0.006")) {
        console.log(`  topping up gas...`);
        await withRetry("top-up", async () =>
          (await funder.sendTransaction({ to: who.address, value: GAS_TOPUP })).wait(),
        );
      }

      // The faucet mints to any address, so the funder can do this on their behalf.
      const held: bigint = await underlying.balanceOf(who.address);
      if (held < amount) {
        console.log(`  minting ${amount / 1_000_000n} tokens...`);
        let remaining = amount - held;
        while (remaining > 0n) {
          const chunk = remaining > MINT_CHUNK ? MINT_CHUNK : remaining;
          await withRetry("mint", async () => (await underlying.mint(who.address, chunk)).wait());
          remaining -= chunk;
        }
      }

      console.log(`  depositing ${amount / 1_000_000n}, confidentially...`);
      const receipt = await withRetry("deposit", () => depositConfidentially(hre, pool, who, amount));
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

/**
 * A day in the life of the pool.
 *
 * Seeding once produces a snapshot: everyone joined in the same minute holding round
 * numbers, which is not what a pool looks like and not what exercises the code. This
 * moves it - a few people join, a few add to what they hold, one or two take money out -
 * so deposits land at different times and odds actually differ by more than size.
 *
 * Deliberately does not draw. Run it, look at the app, then run `hushpot:draw` yourself:
 * the interesting states are between the steps, not after them.
 */
task("hushpot:activity", "Simulate one day of deposits, top-ups and withdrawals")
  .addOptionalParam("join", "How many new depositors join", "3", types.string)
  .addOptionalParam("moves", "How many existing depositors act", "4", types.string)
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const poolAddress = await pool.getAddress();
    const underlying = await hre.ethers.getContractAt("TestERC20", await pool.underlyingToken());

    const signers = await hre.ethers.getSigners();
    const funder = signers[0];
    const GAS_TOPUP = hre.ethers.parseEther("0.008");

    const joiners: HardhatEthersSigner[] = [];
    const holders: HardhatEthersSigner[] = [];
    for (const s of signers) {
      ((await pool.hasSlot(s.address)) ? holders : joiners).push(s);
    }

    console.log(`pool has ${holders.length} depositors; ${joiners.length} accounts still outside\n`);

    // --- new blood ----------------------------------------------------------
    const joinCount = Math.min(Number(args.join), joiners.length);
    for (let i = 0; i < joinCount; i++) {
      const who = joiners[i];
      // Long-tailed on purpose: a pool of identical deposits makes the odds column dull
      // and hides any bug that only shows up at a lopsided weight.
      const amount = BigInt(15_000 + Math.floor(Math.random() * 900_000)) * 1_000_000n;

      console.log(`join  ${who.address}  ${amount / 1_000_000n}`);

      if ((await hre.ethers.provider.getBalance(who.address)) < hre.ethers.parseEther("0.006")) {
        await withRetry("top-up", async () =>
          (await funder.sendTransaction({ to: who.address, value: GAS_TOPUP })).wait(),
        );
      }
      if ((await underlying.balanceOf(who.address)) < amount) {
        await withRetry("mint", async () => (await underlying.mint(who.address, amount)).wait());
      }
      await withRetry("approve", () => ensureAllowance(underlying.connect(who), who.address, poolAddress, amount));

      const receipt = await withRetry("deposit", async () => depositConfidentially(hre, pool, who, amount));
      console.log(`      slot ${await pool.slotOf(who.address)} · gas ${receipt?.gasUsed}`);
    }

    // --- existing depositors move -------------------------------------------
    const movers = holders.filter((h) => h.address !== funder.address).slice(0, Number(args.moves));

    for (const who of movers) {
      // Roughly one in three takes money out. Withdrawals matter more than they look:
      // they are the only path that exercises the early-exit credit, and the only one
      // where the amount is encrypted on the way in as well as out.
      const withdrawing = Math.random() < 0.34;
      const amount = BigInt(10_000 + Math.floor(Math.random() * 200_000)) * 1_000_000n;

      if ((await hre.ethers.provider.getBalance(who.address)) < hre.ethers.parseEther("0.006")) {
        await withRetry("top-up", async () =>
          (await funder.sendTransaction({ to: who.address, value: GAS_TOPUP })).wait(),
        );
      }

      if (withdrawing) {
        console.log(`out   ${who.address}  ${amount / 1_000_000n} (clamped to what they hold)`);
        const enc = await hre.fhevm.createEncryptedInput(poolAddress, who.address).add64(amount).encrypt();
        const receipt = await withRetry("withdraw", async () =>
          (await (pool.connect(who) as typeof pool).withdraw(enc.handles[0], enc.inputProof)).wait(),
        );
        console.log(`      gas ${receipt?.gasUsed}`);
      } else {
        console.log(`add   ${who.address}  ${amount / 1_000_000n}`);
        if ((await underlying.balanceOf(who.address)) < amount) {
          await withRetry("mint", async () => (await underlying.mint(who.address, amount)).wait());
        }
        await withRetry("approve", () => ensureAllowance(underlying.connect(who), who.address, poolAddress, amount));
        const receipt = await withRetry("deposit", async () => depositConfidentially(hre, pool, who, amount));
        console.log(`      gas ${receipt?.gasUsed}`);
      }
    }

    console.log(`\ndepositors now: ${await pool.slotsUsed()}`);
    console.log(`\nNext, when you have looked around:`);
    console.log(`  npx hardhat hushpot:draw --force --network ${hre.network.name}`);
    console.log(`  npx hardhat hushpot:sweep --draw <id> --network ${hre.network.name}`);
  });

/**
 * The keeper: one tick of the weekly cycle, and only what is due.
 *
 * Deliberately a single idempotent pass rather than a long-running loop. Run it every few
 * minutes from cron and it decides for itself what the pool needs - nothing at all, most
 * of the time. A process that has to stay alive for a week is a process that will be dead
 * on the week that matters.
 *
 * The order is not negotiable, and it is the reason this exists. Rolling the period ends
 * the claim window permanently: `checkClaim` reverts once `draw.period != currentPeriod`,
 * so a prize not swept by then is deducted from the reserve and credited to nobody, for
 * ever. That has already happened once on the live pool by hand. Here the roll simply
 * cannot run until every slot is checked.
 *
 * Deposits need no attention at the boundary. Balances live in the tree across periods,
 * and the period-scoped corrections read as zero the moment the stamp moves on, so
 * everyone's principal rolls into the new week at full credit without a single write.
 */
task("hushpot:keeper", "Run whatever the cycle is due for, once. Safe to repeat.")
  .addOptionalParam("openHour", "UTC hour on Monday to open the draw", "0", types.string)
  .addOptionalParam("rollHour", "UTC hour on Monday to start the next period", "6", types.string)
  .addFlag("force", "Open the draw before the period has elapsed. Read the warning first.")
  .addFlag("dryRun", "Say what would happen without sending anything")
  .setAction(async (args, hre) => {
    const pool = await getPool(hre);
    const openHour = Number(args.openHour);
    const rollHour = Number(args.rollHour);

    const now = new Date();
    const isMonday = now.getUTCDay() === 1;
    const hour = now.getUTCHours();
    const stamp = now.toISOString().replace(".000", "");

    const act = async (what: string, fn: () => Promise<unknown>) => {
      console.log(`${stamp}  ${what}`);
      if (args.dryRun) return console.log(`            (dry run - nothing sent)`);
      await withRetry(what, fn);
    };

    // 1 ── A draw left half-open is the most urgent state there is: the total is published
    //      and the prize is not yet assigned. Finish it before considering anything else.
    if (await pool.drawPending()) {
      return act("settling the open draw", async () => {
        const handle = await pool.pendingTotalHandle();
        await hre.fhevm.initializeCLIApi();
        const d = await hre.fhevm.publicDecrypt([handle]);
        await (await pool.settleDraw(d.abiEncodedClearValues, d.decryptionProof)).wait();
      });
    }

    const drawCount = await pool.drawCount();
    const currentPeriod = await pool.currentPeriod();
    const settledThisPeriod = drawCount > 0n && (await pool.draws(drawCount - 1n)).period === currentPeriod;

    // 2 ── Open the week's draw. Forced six hours before the nominal seven-day boundary so
    //      that settling and sweeping finish inside the maintenance window, rather than
    //      pushing the next period later by however long they took.
    if (!settledThisPeriod) {
      // Only once the period has genuinely elapsed, unless explicitly forced.
      //
      // A draw settles against bands that {_checkWin} recomputes from the *live* tree, so
      // it is only final while the tree cannot move. That used to hold only because
      // elapsing saturates `minuteOfPeriod`, making a deposit add `amount × PERIOD` to the
      // balance term and the same to `lateCredit` - cancelling to zero, but only once the
      // clock had genuinely run out. Forcing the draw early skipped that, and a deposit
      // between the forced settlement and the roll shifted the bands of every later slot
      // against a die that was already committed.
      //
      // `minuteOfPeriod` now saturates the moment a draw is pending, not only once real
      // time has elapsed - see the note on the override in `HushpotPool.sol` - so forcing
      // early no longer opens that window at all. This is a contract-level fix, not an
      // operational one; the elapsed check below is simply the default cadence.
      const elapsed = await pool.periodEnded();
      const due = elapsed || (args.force && isMonday && hour >= openHour && hour < rollHour);

      if (!due) {
        const left =
          Number(await pool.periodStart()) + Number(await pool.PERIOD_SECONDS()) - Math.floor(Date.now() / 1000);
        return console.log(
          `${stamp}  nothing due · draw opens Monday ${openHour}:00 UTC (${Math.max(0, Math.floor(left / 3600))}h of period left)`,
        );
      }

      return act("opening and settling the draw", async () => {
        await (await pool.openDraw()).wait();
        const handle = await pool.pendingTotalHandle();
        await hre.fhevm.initializeCLIApi();
        const d = await hre.fhevm.publicDecrypt([handle]);
        await (await pool.settleDraw(d.abiEncodedClearValues, d.decryptionProof)).wait();
      });
    }

    // 3 ── Sweep. One slot per tick keeps every transaction well inside the HCU ceiling and
    //      means a failure costs one slot rather than the batch.
    const drawId = drawCount - 1n;
    const slots = Number(await pool.slotsUsed());

    for (let slot = 0; slot < slots; slot++) {
      if (await pool.claimChecked(drawId, slot)) continue;
      const owner = await pool.slotOwner(slot);
      // A retired slot reads as the zero address until the roll frees it, and
      // `checkClaim` on that reverts `NoSlotAssigned`. Returning here on every tick meant
      // the keeper never reached step 4 - and step 4 is the roll that would have released
      // the slot, so the keeper wedged itself permanently on the first depositor to leave.
      // Skipping is what the contract itself does; the claim is a no-op for an empty slot.
      if (owner === hre.ethers.ZeroAddress) continue;
      return act(`checking draw #${drawId} for slot ${slot}`, async () => {
        await (await pool.checkClaim(drawId, owner)).wait();
      });
    }

    // 4 ── Only now may the period roll, and only on the hour that keeps the schedule from
    //      drifting. Everyone has been paid; the window can close safely.
    if (!(isMonday && hour >= rollHour)) {
      return console.log(`${stamp}  draw #${drawId} settled and fully swept · rolls Monday ${rollHour}:00 UTC`);
    }

    await act("rolling into the next period", async () => {
      await (await pool.startNextPeriod()).wait();
    });
  });

/**
 * A second pool, owned by a contract so that no key has to be published at all.
 *
 * Two of the six cycle steps - opening a draw and rolling the period - are owner-gated
 * *only for running them early*. Once a period genuinely elapses anyone may call them, but
 * that is a week away, and a judge should not have to wait a week to press a button.
 *
 * The obvious answer is to publish the real owner key, and it is the wrong one: that key
 * can set the yield rate to zero and close claim windows early, which is the sharpest
 * trust assumption in the threat model. Handing it out would make the documentation
 * dishonest.
 *
 * So this deploys a throwaway instead. The main pool keeps its integrity; this one absorbs
 * the experimentation, and it holds nothing that matters - test tokens, a little test ETH,
 * and a key generated for no other purpose.
 */
task("hushpot:sandbox", "Deploy a judge sandbox anyone can run the whole cycle on")
  .addOptionalParam("reserve", "Prize reserve in base units", "10000000000", types.string)
  .addOptionalParam("count", "How many depositors to seed", "4", types.string)
  .setAction(async (args, hre) => {
    await hre.fhevm.initializeCLIApi();
    const [deployer] = await hre.ethers.getSigners();
    const known = (await import("../config/addresses")).addressesFor(Number(await hre.getChainId()));
    if (!known) throw new Error("No known token addresses for this chain");

    console.log(`deploying a sandbox pool...`);
    const factory = await hre.ethers.getContractFactory(POOL);
    const pool = await factory.deploy(known.confidentialToken);
    await pool.waitForDeployment();
    const address = await pool.getAddress();
    console.log(`  at ${address}`);

    // Fund the reserve while we still own it - `fundPrizeReserve` is owner-gated, and
    // ownership is about to go somewhere that will not give it back.
    const underlying = await hre.ethers.getContractAt("TestERC20", known.underlyingToken);
    const reserve = BigInt(args.reserve);
    await (await underlying.mint(deployer.address, reserve)).wait();
    await ensureAllowance(underlying, deployer.address, address, reserve);
    console.log(`  funding reserve with ${reserve / 1_000_000n}...`);
    await (await pool.fundPrizeReserve(reserve)).wait();

    // The owner is a contract that says yes to everyone, for two calls and no others.
    // The earlier design published a private key instead; this one asks a reviewer to
    // import nothing, and leaves no key in existence worth stealing.
    console.log(`deploying the operator...`);
    const operatorFactory = await hre.ethers.getContractFactory("SandboxOperator");
    const operator = await operatorFactory.deploy(address);
    await operator.waitForDeployment();
    const operatorAddress = await operator.getAddress();
    console.log(`  at ${operatorAddress}`);

    console.log(`  transferring ownership to it...`);
    await (await pool.transferOwnership(operatorAddress)).wait();

    // Seed after the handover: depositing was never owner-gated.
    const count = Number(args.count);
    if (count > 0) {
      console.log(`
seeding ${count} depositors, confidentially...`);
      // Every task resolves its pool through `HUSHPOT_POOL`, so this is how one task
      // points another at a deployment that is not in the registry.
      process.env.HUSHPOT_POOL = address;
      await hre.run("hushpot:seed", { count: String(count), scale: "1", topUp: false });
    }

    console.log(`
sandbox ready`);
    console.log(`  pool      ${address}`);
    console.log(`  operator  ${operatorAddress}   (owns the pool; anyone may call it)`);
    console.log(`
verify both, then point the frontend at them:`);
    console.log(`  npx hardhat verify --network ${hre.network.name} ${address} ${known.confidentialToken}`);
    console.log(`  npx hardhat verify --network ${hre.network.name} ${operatorAddress} ${address}`);
  });
