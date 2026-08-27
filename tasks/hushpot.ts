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

/** Resolve the deployed pool. `hre.ethers.getContract` is a hardhat-deploy-ethers
 * extension we don't install, so go through the deployments registry.
 *
 * Also initialises the FHEVM plugin. On a real network anything that touches the
 * coprocessor — which is every write here — fails with "The Hardhat Fhevm plugin is not
 * initialized" without it. Cheap and idempotent, so it lives in the shared path. */
async function getPool(hre: HardhatRuntimeEnvironment) {
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
 * Retry a transaction through a transient RPC failure.
 *
 * Public Sepolia endpoints lag behind their own mempool, so a burst of transactions from
 * one wallet gets rejected as "replacement transaction underpriced" even when the previous
 * one was mined — the node hands out a stale nonce. Backing off and retrying is enough.
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
      console.log(`  ${label} failed: ${message.slice(0, 70)} — retrying in ${pause / 1000}s`);
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
    // has no meaningful odds against them, and the prize — which scales with the pool —
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
      const amount = amounts[i - 1] * 1_000_000n;

      console.log(`--- depositor ${i}: ${who.address}`);

      // Resumable. Public RPCs drop transactions and lag on nonces, so this task will be
      // re-run; anyone already holding a slot is already a depositor and re-depositing
      // for them just burns gas and skews the spread we set up.
      if (await pool.hasSlot(who.address)) {
        console.log(`  already in the pool · slot ${await pool.slotOf(who.address)}\n`);
        continue;
      }

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

      await withRetry("approve", () => ensureAllowance(underlying.connect(who), who.address, poolAddress, amount));

      console.log(`  depositing ${amount / 1_000_000n}...`);
      const receipt = await withRetry("deposit", async () =>
        (await (pool.connect(who) as typeof pool).depositUnderlying(amount)).wait(),
      );
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
 * moves it — a few people join, a few add to what they hold, one or two take money out —
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

      const receipt = await withRetry("deposit", async () =>
        (await (pool.connect(who) as typeof pool).depositUnderlying(amount)).wait(),
      );
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
        const receipt = await withRetry("deposit", async () =>
          (await (pool.connect(who) as typeof pool).depositUnderlying(amount)).wait(),
        );
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
 * minutes from cron and it decides for itself what the pool needs — nothing at all, most
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
      if (args.dryRun) return console.log(`            (dry run — nothing sent)`);
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
      // a draw is only final while the tree cannot move. That is exactly what elapsing
      // guarantees: `minuteOfPeriod` saturates, and a deposit then adds `amount × PERIOD`
      // to the balance term and the same to `lateCredit`, cancelling to zero.
      //
      // Force the draw early and that protection is gone. Deposits between the forced
      // settlement and the roll still change weights — 1,000 deposited at minute 6,809
      // adds 3,271,000 ticket-minutes — which shifts the bands of every later slot
      // against a die that was already committed. Nobody can aim it, since the die is
      // encrypted, but the outcome is no longer settled at settlement.
      //
      // The cost of not forcing is that the roll waits for the sweep, so the weekly slot
      // drifts by however long that takes. Drift is cosmetic; a draw that can still move
      // is not.
      const elapsed = await pool.periodEnded();
      const due = elapsed || (args.force && isMonday && hour >= openHour && hour < rollHour);

      if (!elapsed && args.force) {
        console.log(`${stamp}  ⚠ forcing early — deposits before the roll can still shift bands for this draw`);
      }

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
