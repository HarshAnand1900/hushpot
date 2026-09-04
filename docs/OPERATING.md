# Hushpot — Operating the Protocol

Who can call what, how a judge runs a full cycle today without a key changing hands, the weekly schedule a keeper
follows, and why the contract cannot be upgraded. For the pitch and the live numbers, see
[`../README.md`](../README.md); for the draw mechanics themselves, see [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md).

---

There is no admin login, because there is no server holding state. "Admin" here is an address with on-chain permissions,
plus automation that calls public functions on a schedule. Almost everything is the second kind.

## What is gated, and what is not

| Owner only         | What it does                            |
| ------------------ | --------------------------------------- |
| `fundPrizeReserve` | tops up the pot with plain tokens       |
| `setAnnualRateBps` | sets the rate the prize is derived from |

Nothing else has an owner check on it. That is a design decision, not an oversight: a pool whose draw only its operator
can start is a pool its operator can stall.

"Callable by any address" covers three quite different things, though, and it is worth separating them.

| Call                              | Open to                          | Acting on behalf of     |
| --------------------------------- | -------------------------------- | ----------------------- |
| `deposit`, `withdraw`, `exitPool` | any address                      | itself, and only itself |
| `sponsorPrize`                    | any address, at its own expense  | every depositor         |
| `settleDraw`                      | any address                      | the pool                |
| `proveSolvency`                   | any address                      | any observer            |
| `checkClaim(drawId, account)`     | any address                      | **any other address**   |
| `sweepRange(drawId, count)`       | any address                      | **everybody at once**   |
| `openDraw`                        | any address once the week is up  | the pool                |
| `startNextPeriod`                 | the owner; anybody after 30 days | the pool                |

…and `startNextPeriod` carries one more condition that is not about who you are: it reverts while any slot the last draw
covered is still unchecked. That one applies to the owner as well.

The two in bold are the ones that matter. A stranger can pay out your prize, for a pool they have never deposited into,
without learning a thing in the process. Everything they touch stays encrypted, and a loser's claim costs the same gas
as a winner's, so the act of checking gives nothing away. That is what lets a keeper sweep everyone after every draw:
nobody has to remember to collect, and being checked says nothing about having won.

The last two rows are time-gated, not role-gated, and they are gated differently. `openDraw` opens to everybody the
moment the seven days are up. `startNextPeriod` also has to wait out the full thirty-day claim window, and thirty days
is longer than a week, so **a pool on a weekly cadence never reaches that point**. In normal operation the roll is the
operator's, run by a keeper on schedule. That is the one place this design asks for trust, and
[`docs/THREAT-MODEL.md`](THREAT-MODEL.md#43-the-owner) treats it as one.

The consequence worth stating: **the operator cannot run the pool on its own terms, and cannot stop anyone else running
it.** The one exception is the claim window, where the owner may roll a period early; that is a real trust assumption
and is documented in [`docs/THREAT-MODEL.md`](THREAT-MODEL.md#43-the-owner).

## Running the cycle as a judge, today

Two of the six steps are gated to the pool's owner, and not in the same way.

`openDraw` opens to everybody the moment the seven-day period elapses, so any wallet can seal a draw from that point.
The date moves with every roll, and naming one here would go stale the way an earlier draft of this line did — the
current period's end is `periodStart() + PERIOD_SECONDS`, both public getters, and the judge panel shows it read from
the chain rather than written down.

`startNextPeriod` is stricter: a non-owner also has to wait out the thirty-day claim window, so on a weekly cadence it
stays the operator's call, run by a keeper on schedule. The owner exemption exists so a demonstration does not have to
wait a month to show a second cycle.

Before then, use the **sandbox**: a second pool that exists for exactly this and is expendable by design.

|           |                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Open it   | [`/judge?pool=sandbox`](https://hushpot-fhevm.vercel.app/judge?pool=sandbox)                                                         |
| Pool      | [`0x08E5c466a8c5a5FCccEd833e1E9dC8D5B145D279`](https://sepolia.etherscan.io/address/0x08E5c466a8c5a5FCccEd833e1E9dC8D5B145D279#code) |
| Its owner | [`SandboxOperator`](https://sepolia.etherscan.io/address/0x4Cdc99F52Be94aD1A851119FEFc07557637E7Cdc#code), a contract, not a person  |

**There is no key to import.** All six steps run from whatever wallet you already have. One cycle has already been run
through it — proving the fixes this deployment exists to demonstrate live — but every step stays open to anyone: roll
the period yourself and the next cycle is yours to run end to end.

### How that works

The obvious way to open a sandbox is to publish its owner's private key, and that was the first attempt. It works, and
it is bad. It asks a reviewer to import a stranger's key into their wallet before they can look at anything, which
nobody should be in the habit of doing and most reviewers will simply decline.

So ownership went to [`contracts/SandboxOperator.sol`](../contracts/SandboxOperator.sol) instead. It is about twenty
lines of code under twice as much comment, and it forwards three calls to anybody who asks:

| Forwarded            | Why it is safe                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `openDraw()`         | Seals and publishes the pool total. One draw per period is enforced by the pool regardless. |
| `startNextPeriod()`  | Rolls the week. The pool already blocks it until every depositor is swept.                  |
| `fundPrizeReserve()` | Only ever adds money, and the money is the caller's.                                        |

What it deliberately **cannot** do matters more. There is no forwarder for `setAnnualRateBps`, so nobody can set the
sandbox's yield to zero and make every prize read `0.00`. None for `transferOwnership`, so nobody can take the pool. And
no generic `call`, which would have been both of those plus every owner-gated function added in future. The owner's
dangerous powers are not delegated. They are destroyed, and two harmless ones are handed out in their place. Five tests
in [`test/SandboxOperator.ts`](../test/SandboxOperator.ts) pin that down, including one asserting the ABI holds those
three functions and the `pool` getter, and nothing else.

The main pool's owner key is **not** shared, and that is not an oversight. It can set the yield rate to zero and close
claim windows early, the sharpest trust assumption in [`docs/THREAT-MODEL.md`](THREAT-MODEL.md#43-the-owner). Publishing
it would make that document a lie. The sandbox absorbs the experimentation instead.

### What you will find there

Six confidential deposits are seeded and **one draw has already settled**, run live to prove the fixes this deployment
exists to demonstrate — see [What is running right now](../README.md#what-is-running-right-now). The period has not
rolled since, so `startNextPeriod` is the next step waiting for a judge to press it, exactly where step 01 of a fresh
run through the six steps would be.

Running the remaining steps in order takes the pool from that state through a fresh period, a new draw, a swept claim,
and a solvency proof. At the end the button that said _Reset console_ says **Run the cycle again**, and it does: the
roll leaves the pool ready for another pass, so the whole thing can be run as many times as anyone likes.

Add `?pool=sandbox` to any page (`/pool`, `/draws`, `/proof`, `/judge`) and the whole site re-points at it. A yellow
banner across the top says so, because every figure on screen then belongs to a throwaway contract. Every link carries
the parameter onward, so a refresh or a copied link stays where you are. Drop it to return to the real pool.

### Is it the same money?

The same **tokens**, in separate **balances**. Both pools use Zama's official
[`cUSDTMock`](https://sepolia.etherscan.io/address/0x4E7B06D78965594eB5EF5414c357ca21E1554491) and the plain
[`USDTMock`](https://sepolia.etherscan.io/address/0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0) behind it, because there
is one of each on Sepolia and both are test tokens with an open faucet.

Everything else is separate. Each pool is its own contract with its own depositors, its own prize reserve, and its own
draws. Depositing into the sandbox does not put a coin into the live pool, cannot win the live pool's prize, and is
withdrawn from the sandbox. The two never touch. All they share is where the play money is minted.

That also means nothing in the sandbox is worth anything. `USDTMock.mint` is open to everyone, so the tokens cost a
Sepolia gas fee, which is why a pool anyone can freely open draws on is not a problem worth solving.

## Three ways to call anything

1. **The Judge panel.** [`/judge`](https://hushpot-fhevm.vercel.app/judge) runs the whole cycle from a browser. On the
   main pool the two owner-gated steps are labelled and enable only for the owner; on the sandbox all six are live for
   everyone.
2. **Etherscan.** Both contracts are verified, so the _Write Contract_ tab is a working admin UI with no code and no
   local setup. This is how most protocols are actually operated. For the sandbox's gated pair, call the **operator's**
   Write tab, not the pool's.
3. **The CLI.** `tasks/hushpot.ts` covers every operation. Run `npx hardhat hushpot:status --network sepolia` to see
   where things stand. Every task takes a `HUSHPOT_POOL` address override, so the sandbox is drivable from the CLI too:

   ```bash
   HUSHPOT_POOL=0x08E5c466a8c5a5FCccEd833e1E9dC8D5B145D279 npx hardhat hushpot:status --network sepolia
   ```

   Unset, the tasks use the deployed pool. `hushpot:sandbox` deploys a fresh one in a single command: pool, operator,
   reserve, seeded depositors and the ownership handover.

## The weekly schedule, in UTC

Periods are seven days long and start whenever the roll is called, so the schedule is set by _when you call it_, not by
anything in the contract. Held to this cadence it never drifts:

| UTC                         | What happens                                          |
| --------------------------- | ----------------------------------------------------- |
| **Monday 06:00**            | `startNextPeriod`, the week opens and deposits accrue |
| Monday 06:00 → Monday 00:00 | 162 hours of odds accruing                            |
| **Monday 00:00**            | `hushpot:draw --force`: seal, roll the die, settle    |
| Monday 00:00 → 06:00        | `hushpot:sweep --draw N`, and prizes land             |
| **Monday 06:00**            | roll again, and the next week starts exactly on time  |

The six-hour gap is a courtesy, not a safety margin: the draw is opened six hours before the nominal seven-day boundary
so that settling and a prompt sweep both finish before the next period is due to start, and prizes land in balances the
same day rather than sitting parked. Nothing here is time-pressured. The tree keeps five generations of history and the
claim window is thirty days of wall-clock time, independent of how many times the period has rolled since — and
`startNextPeriod` itself refuses to roll past a draw still inside its grace if doing so would push it beyond that
history depth, so there is no sequence of calls that can orphan a live claim. Rolling on schedule without sweeping first
is a legitimate way to run this; sweeping promptly is good practice, not insurance against a stranded prize.

## Keeping it running

```bash
npx hardhat hushpot:keeper --network sepolia
```

One tick of the cycle, and only what is due. Run it every few minutes from a scheduler and it works out for itself what
the pool needs, which most of the time is nothing at all:

1. **A draw left open** is finished first. The total is published and the prize is not yet assigned, so nothing else
   matters until it settles.
2. **The week's draw** opens on Monday at `--open-hour` (00:00 UTC by default), or any time after the period has
   genuinely elapsed.
3. **Sweeping** runs one slot per tick. Small transactions stay well inside the HCU ceiling, and a failure costs one
   slot instead of a batch.
4. **The roll** happens on Monday at `--roll-hour` (06:00 UTC), and _only once every slot is swept_.

That condition is now tidiness rather than necessity. It was the whole reason the keeper existed: `checkClaim` used to
revert once `draw.period != currentPeriod`, so a prize not swept before the roll was deducted from the reserve and
credited to nobody, permanently — and that happened once on a live pool, by hand. Claims survive a roll now, so the
keeper sweeps to save depositors the transaction, not to save them the prize.

Deposits need no attention at the boundary: balances live in the tree across periods, and the period-scoped corrections
read as zero once the stamp moves on, so everyone's principal carries into the new week at full credit without a single
write.

`--dry-run` prints what it would do and sends nothing.

**Scheduling it.** On Windows, one line registers it to run every ten minutes:

```powershell
schtasks /create /tn Hushpot /tr "cmd /c cd /d %USERPROFILE%\OneDrive\Desktop\hushpot && npx hardhat hushpot:keeper --network sepolia >> keeper.log 2>&1" /sc minute /mo 10
```

A VPS with cron, Gelato, Chainlink Automation or OpenZeppelin Defender all work the same way. **Do not put the mnemonic
in GitHub Actions secrets.** This repository is going public, and a workflow with signing rights is a standing
invitation. Keep the key on a machine you control.

The keeper wallet holds no power over deposits. The worst it can do is stop showing up, and then anyone else can run the
cycle by hand.

## Deliberately not upgradeable

There is no proxy. The period is a `constant`, the tree geometry is a `constant`, and the draw logic cannot be swapped.
Changing any of it means deploying a new pool and letting people move to it voluntarily.

That is the same choice PoolTogether makes, its Prize Pool being immutable with no admin controls at all, and here it is
load-bearing, not merely tidy. "There is no winner field" is a much weaker claim if someone can upgrade one in tomorrow.
The cost is real: parameters nobody thought to expose cannot be changed later, and the seven-day period is one of them.

**For a production deployment**, two things should change before real money is involved, and neither is built here:
ownership should move to a multisig behind a timelock (`Ownable.transferOwnership` makes that one transaction, no
redeploy), and the weekly cycle should be a funded keeper instead of a person.

## What immutability costs, and what it cost here

Immutable means a fix lands in a new contract or not at all. Three did, and all three were found the same way: by
writing the test that would catch the bug rather than the test that would pass.

**A prize parked on a slot whose owner had left.** `_sweepSlot` credited an award to a retired slot, and `_pendingAward`
carried no period stamp — so the next depositor handed that recycled slot folded a stranger's prize into their balance.
Reproduced in `HushpotRetiredSlotAward.ts`, where the joiner's balance came back 821,917 too high.

**The same bug again, through a different door.** Keeping a generation of tree history removed `checkClaim`'s period
gate, and nothing then checked that the account holding a slot _today_ was the account that earned its band _then_. The
`slotOwner != address(0)` guard from the first fix does not fire, because a recycled slot does have an owner — just a
different one. `slotAssignedAt` is what actually closes it: the band is still counted, so no later edge shifts, but the
award is an encrypted zero unless the holder was there when the draw settled.

**An archived handle with no ACL grant.** `_foldPending` archives a node, mutates the balance into a fresh handle, and
leaves the grant to `_persist` — but `_creditSlot` then archives _again_ before the stamp advances, storing that
intermediate handle. `_persist` grants only the final one, so the archived handle has no ACL entry and every later claim
whose band crosses that node reverts with `ACLNotAllowed()`. Unrecoverable: the prize becomes permanently unclaimable
for everyone whose prefix includes that leaf. An idempotence guard in `_archive` fixes it.

That third one is worth dwelling on, because it is the one that would have shipped. It needs no `exitPool` and no
unusual sequence — a winner making an ordinary second deposit is enough. The first two could be argued away on a pool
where nobody had ever left, and that argument was made here, once, honestly. It was not available for this one.

**Both pools now run this source.** There is no divergence to disclose: the addresses in
[`web/src/lib/contract.ts`](../web/src/lib/contract.ts) are the deployments these contracts compile to, and Etherscan
carries the verified source for each. What immutability cost was several redeployments across this build and a pool's
worth of history discarded each time — which is the real price of not being able to patch, paid rather than described.
