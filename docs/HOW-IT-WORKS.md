# Hushpot - How It Works

The mechanics: how a winner is picked without decrypting anyone's position, how a claim survives a roll, why staying is
worth more than arriving, what stays encrypted and what has to be public, and where the yield comes from. For the pitch
and the live numbers, see [`../README.md`](../README.md); for what leaks and what you have to trust, see
[`THREAT-MODEL.md`](THREAT-MODEL.md).

---

## Two walls, and where they are

A confidential prize pool is easy to describe and awkward to build, because the obvious implementation runs into two
separate ceilings. Only one of them gets discussed.

### The depth wall

PoolTogether picks a winner by walking a cumulative sum until it passes a random point:

```
r   = random(0, total)
acc = 0
for each depositor i:
    acc    += balance[i]
    hit     = acc > r
    winner  = select(hit, i, winner)
```

Over ciphertext every line of that loop is a homomorphic operation, and each pass depends on the result of the one
before it. FHEVM meters that dependency chain separately from gas and caps it at 5M HCU per transaction, 20M globally.
Batching is no escape: the chain itself is the cost, so splitting it across transactions means carrying an encrypted
accumulator between them and paying the same depth in pieces. The loop is bounded by a small constant of depositors, and
no amount of engineering moves it, because the ceiling is on the shape of the algorithm.

Hushpot replaces the walk with an **encrypted segment tree**. A slot's band is a prefix sum, a prefix sum is a walk from
leaf to root, and that is `log2(slots)` levels instead of `n` iterations. At the deployed 16,384-slot capacity the
deepest possible check is fourteen levels, and the tree only walks as far as the highest node covering the slots
actually in use - a pool of nine pays for a tree of four. Raising the cap from 1,024 to 16,384 moved none of the
measured costs for that reason. `HushpotDepthGas.ts` pins the ladder and prints it on every run.

### The incidence wall

This is the one that decides whether a design survives mainnet, and it is mostly left unsaid.

Whatever a claim costs, **somebody has to pay it `n` times per draw**. Making claims cheap, batchable and permissionless
does not change that. It changes who is inconvenienced. At the measured 649,774 gas a claim, a 10,000-depositor pool
costs about 6.5 billion gas to settle - every draw, forever - and there is no batch size that turns that into a
reasonable expense for whoever volunteered.

So the protocol does not depend on a sweep. `checkMyClaim` is one transaction, sent by the person it pays, and it is the
only settlement path Hushpot requires. Cost per depositor is flat, nobody funds anybody else's claim, and what the pool
costs to run does not grow with the number of people in it. The keeper sweep is a convenience - sensible on a small pool
or an L2, useful for depositors who have wandered off, and never load-bearing.

### A claim outlives its period

A claim recomputes your band from the tree, and the tree is period-scoped: roll it, and the corrections age out while
balances keep moving. The band moves with them. So the same call after a roll used to return a **different** answer
rather than a stale one, and was refused outright - which meant anyone not swept in time simply forfeited.

The obvious repair is to block the roll until everyone has been checked. That was tried here and removed, because it
reads as safety and is not: it makes the cycle depend on the same O(n) sweep [the incidence wall](#the-incidence-wall)
argues against. A pool nobody sweeps degrades from weekly to monthly and then forfeits the stragglers anyway.

What ships instead is **five generations of history per node**, written copy-on-write:

```solidity
function _archive(uint256 node) internal {
  uint32 was = _stamp[node];
  if (was == currentPeriod) return; // already current
  if (euint64.unwrap(_balance[node]) == bytes32(0)) return; // never written
  if (euint64.unwrap(_hist[node][currentPeriod].balance) != bytes32(0)) return; // already taken
  _hist[node][currentPeriod] = Archive({ balance: _balance[node], /* … */ was: was });
}
```

`checkClaim` then evaluates against `_checkWinAt(draw.period, …)`, so a draw settled in period 4 is still judged by
period 4's weights once period 5, 6, 7 and 8 have begun. Snapshotting every slot at settlement would be O(n) encrypted
storage per draw; this is O(1) amortised, because a node pays once on its first touch in a period and nothing after.

**Measured**, in `HushpotDepthGas.ts` so it cannot drift: deposits inside a period cost **+0.4%**, and the first deposit
after a roll costs **208,387 gas more** - once per node per period, never per depositor.

Archives are keyed by the period they were **taken** in, not the period whose values they hold. That is what bounds the
lookup: the values a node held in period P are in the earliest archive taken after P, so a reader walks forward from P +
1 and stops at the first hit, five steps at worst. Keying them by the period they belonged to would mean walking
backwards an unbounded distance, because a node left untouched for a year has history a year old and nothing between.

### The window is thirty days, not a number of rolls

`CLAIM_GRACE` has always said thirty days. The check did not: it was `currentPeriod > draw.period + 1`, one roll of
grace, so a claim expired after a **fortnight** - and the owner, who may roll early, could bring even that forward. The
contract contradicted its own constant by more than half the window.

It is now wall-clock time, from a `settledAt` the draw records for itself:

```solidity
if (block.timestamp > d.settledAt + CLAIM_GRACE) revert ClaimWindowClosed();
if (currentPeriod > d.period + MAX_HISTORY) revert ClaimWindowClosed();
```

The second line is the tree's reach rather than a second policy, and `startNextPeriod` will not roll past a draw still
inside its grace - five periods is thirty-five days, so at the seven-day cadence the time test always binds first. That
roll guard is **not** the sweep gate described above: it costs nobody an O(n) pass, it asks the owner to wait rather
than asking somebody to pay, and it clears itself as the grace expires. At the natural cadence it never fires at all.

One detail worth keeping from the single-generation version: the stamp stored `period + 1`, because storing the raw
period collides with period 0 being real - its history was written and instantly unreachable, the bands stopped covering
the total, and a draw point could land in the gap so that **nobody won at all**. It returned a plausible number on
encrypted values, with no revert. The test that caught it asserts `alice + bob == prize` against a figure captured while
the period was still current. The struct now carries `was` explicitly, which removes the sentinel and the class of bug
with it.

Finding out **whether** you won is a separate matter and has no deadline at all: the result is stored as a ciphertext
only you can open, so it survives the sweep, the roll and the years after. See
[Finding out, afterwards](#finding-out-afterwards).

---

## How the draw works

The interesting problem is picking a winner with odds proportional to a **secret** balance, without decrypting anyone's
position, in a way that stays verifiable.

### Weighting

Odds come from **ticket-minutes**: your balance multiplied by the minutes you held it this period. Deposit halfway
through the week and you earn half the odds of someone who was there the whole week with the same amount. That closes
the obvious exploit: depositing a fortune moments before the draw buys almost nothing.

Tracking that naively is unusable on-chain: every user has their own last-changed timestamp, so totalling the pool would
mean visiting all of them. The fix is algebraic:

```
balance × (drawTime − lastChange)  =  balance × drawTime  −  balance × lastChange
```

The right-hand term carries no draw time, so it can be computed the moment someone deposits and folded into a running
total. The left multiplies a figure identical for everyone, so it factors out against the sum of balances. The whole
pool therefore resolves to running totals plus one multiplication, and **no end-of-period sweep ever runs**.

### Staying is worth more than arriving

Time-weighting rewards depositing **early in the week**. It said nothing about staying past the week you arrived in, so
week fifty looked exactly like week one: the pool rewarded showing up and never rewarded loyalty.

`boostStreak` adds five percent of a full stake's ticket-minutes for each period held, four periods deep - so money left
alone for a month carries **1.20×** the weight of the same amount deposited this morning. Deliberately modest: base
weight already scales linearly with balance and holding time within a period, and the boost is a nudge on top of that,
not a second axis competing with it for what actually decides odds.

The period a slot is _assigned in_ is never one of the periods it credits, whatever minute the deposit landed in.
`streakOf` counts full periods held _after_ joining - `currentPeriod - since - 1`, not `currentPeriod - since` - so
depositing a minute before a roll gives the same zero streak as depositing a minute after one. Counting from `since`
alone credited a full period the instant the clock ticked over: a last-minute joiner would read identically to someone
who held the whole week, one minute after they arrived.

The balance the boost multiplies is anchored to what was actually held for as long as the streak claims, not to whatever
the slot holds the moment the button is pressed. `streakOf` and the slot's live balance are otherwise unrelated - a slot
exists as long as it isn't fully exited, so a tiny stake could sit open for a month building the full streak, then take
on a large fresh deposit moments before boosting and have the _whole_ deposit inherit a month's multiplier it was never
staked for. `_creditBonus` applies the boost to `min(current balance, balance as of the anchor period)` instead, using
the same generational history the claim window relies on - so fresh capital added after the streak's anchor point is
excluded, and a balance that shrank since the anchor (a partial withdrawal that keeps the slot open) is not inflated
back up either.

Two things make it affordable. It is **opt-in and self-funded**: the obvious design applies the boost to everyone at the
roll, which is an O(n) encrypted pass somebody has to pay for every period - [the incidence wall](#the-incidence-wall)
again. Here each depositor pays for their own, once, and a pool nobody boosts costs nobody anything. And it **expires
with the period**, which is what makes "held four periods" mean four periods of continuous holding rather than a number
that keeps climbing after the money has gone.

Taking the boost commits the stake until the period ends:

```solidity
if (boostedThisPeriod(slot)) revert BoostLocked();
```

Without that, boost-then-withdraw buys a full period of odds and hands the capital straight back - strictly better than
staying, and therefore the only thing anyone would do. The check is plaintext and costs no FHE operations.

It discloses nothing new. The streak comes from `slotAssignedAt`, which was already public because taking a slot is a
transaction anyone can watch; the boost multiplies a balance that stays a ciphertext throughout. An observer learns that
a slot has been here four weeks and still nothing about how much is in it.

**A second guard closes a window `BoostLocked` does not.** Every other write to the tree is neutral once
`minuteOfPeriod` saturates - a deposit or withdrawal made after that point adds the same amount to
`lateCredit`/`earlyExit` that it adds to `balance`, so the two cancel and a settled draw's weights are untouched. The
boost has no such cancellation; it adds straight to `earlyExit`, which is the entire point of it. That meant a depositor
could watch a draw settle, boost before anyone had run `checkClaim`, and widen their own band for a total and drawPoint
that were already fixed - capturing probability mass from whoever's pre-boost band would otherwise have contained the
draw point, undetectably, since results stay encrypted. `boostStreak` now reverts once a draw already exists for the
current period, open or settled:

```solidity
if (drawPending || (drawCount > 0 && draws[drawCount - 1].period == currentPeriod)) revert PeriodEnded();
```

Not `periodEnded()` - the owner may open a draw before the period has elapsed, and the total is fixed the moment it
opens regardless of the clock. `HushpotBoostSettlementSafety.ts` pins both cases: the exploit window closed, and
boosting mid-period with no draw yet still works exactly as before.

**The same gap existed in the ordinary deposit path, reachable without touching the boost at all.** The
"deposit-after-saturation is neutral" property that guard's own reasoning leans on is not automatic - it holds under
ordinary operation only because `openDraw` will not let a non-owner in before `periodEnded()`, so by the time a draw can
open at all without the owner's help, the clock has already saturated for everyone. The owner's early-open exemption is
exactly the case that breaks it: opening before `periodEnded()` snapshots the total while `minuteOfPeriod` has not yet
saturated, and any deposit or withdrawal made before the roll was a live, uncancelled change to weight the snapshot
never accounted for. Measured directly, not assumed - `HushpotEarlyOpenNeutrality.ts` shows a deposit made entirely
after an early `openDraw` landing with its full weight, and a decrypted total that included it.

`minuteOfPeriod` now saturates the moment a draw is pending, not only once real time has elapsed:

```solidity
function minuteOfPeriod() public view override returns (uint64) {
  return drawPending ? PERIOD_MINUTES : super.minuteOfPeriod();
}
```

A no-op under ordinary operation, where the clock has already saturated by the time a draw exists - it only changes
anything in exactly the window the owner's exemption opens. Six tests cover both directions: deposits, top-ups and
withdrawals all land at zero net weight while a draw is pending, early-open or not, and ordinary accrual with no draw
pending is untouched.

### Odds are measured against the last published total - and that is not what decides the draw

Your odds are `yourWeight ÷ poolTotal`, where `poolTotal` is the figure published at the **last settled draw**, never a
live reading. The UI labels every odds figure `· ESTIMATE` for exactly this reason: it is a snapshot, not a promise.

That is not a convenience, it is the whole point. Given a live denominator, you could divide your own odds into it,
recover the running pool total, then watch it move by a single deposit and recover that deposit's size by subtraction.
Freezing the denominator at a draw boundary means the only total anybody learns is the one the draw already made
public - the running total stays exactly as sealed as everyone's individual balance.

The cost is that the shown figure drifts out of date the moment anyone deposits. Your weight can only grow between draws
(ticket-minutes accrue with time), while the published `poolTotal` sits still until the next draw - so the ratio the app
shows you only ever drifts **upward**, and can climb past 100%. The app does not paper over that with a capped
percentage: past 100% it switches to a `×` multiple of the last total, still marked `· ESTIMATE`. It is not a guarantee
of winning at any multiple - it is a readout of how stale the denominator has become, nothing more.

**What actually decides the draw is never this figure.** `openDraw()` computes `total = _weightOf(_treeRoot())` fresh,
on-chain, from the live confidential tree, at the moment the draw opens - not the total from last time. If the pool grew
between when you checked your odds and when the draw ran, everyone's real share shrank together, yours included, by
exactly the same dilution a straightforward reading of "money in, chance of winning" would predict. A 96% estimate
checked days before settlement can lose, honestly, if enough capital arrived in between - the estimate was accurate for
the pool as it stood when you read it, not a forecast of the pool as it will stand when the dice actually roll.

There is no way to see the real number before it is used: the live total is ciphertext until the instant `openDraw()`
seals and publishes it for that draw, and the draw point that gets compared against it is
[never decrypted by anyone](#selection). Whether you won is knowable only after settlement, from your own claim - never
by inference from what the app showed you beforehand, and never by watching the chain (see
[confidentiality under observation](#nothing-leaks-to-a-live-observer) below).

### Selection

Participants occupy contiguous bands of a number line from zero to the pool total. A draw picks a point; whoever's band
contains it wins.

1. `openDraw()` seals the pool total and publishes it for decryption.
2. Off-chain, the total is decrypted and relayed back with a KMS proof. `FHE.checkSignatures` reverts unless the
   cleartext matches the ciphertext, so the relayer **cannot lie**. It can only decline.
3. `settleDraw()` rolls `FHE.randEuint64` on-chain and reduces it into the pool's range. **The draw point is never
   decrypted by anyone.**

### Proportionality is proved exhaustively, not sampled

A weighted lottery is only fair if the chance of winning equals the share of the pool, and the usual way to argue that
is a Monte Carlo run - a few hundred thousand random draws, and a distribution that comes out close enough.

`SegmentTree.ts` does something stronger. It builds a pool whose weights sum to 100, then walks **every** draw point in
`[0, 100)` - not a sample of them, all of them - and asserts that each slot is selected exactly as many times as its
weight:

```
for (let drawPoint = 0; drawPoint < total; drawPoint++) counts[findLeaf(drawPoint)]++;
// then, for every slot:  counts[slot] === weight[slot]
```

There is no tolerance and no statistical error, because nothing is sampled. Every reachable input is enumerated and
every output checked, which makes it a proof of exact proportionality over the whole domain rather than evidence of
approximate proportionality over part of it. It also catches the off-by-one at a band boundary that a distribution test
is least likely to notice and most likely to be broken by.

Two companion cases pin the edges: a slot with zero weight is never selected, and re-weighting a leaf moves the bands
correspondingly.

### Claiming

There is no announcement, because nothing knows who won. The settlement path the protocol relies on is
`checkMyClaim(drawId)`: one transaction, sent by the depositor it pays, which evaluates the draw against their band and
adds `FHE.select(won, prize, 0)` to their balance. Cost per depositor is flat, and nobody funds anybody else's claim.

A loser's claim adds an encrypted zero. On-chain it is indistinguishable from a winner's, down to the gas.

`checkClaim(drawId, account)` is the same thing callable by any address, for any address - safe to expose, because the
result is encrypted either way and the caller learns nothing from making the call. That is what lets a keeper sweep a
pool so nobody has to remember to collect. It is a convenience and not a dependency: see
[the incidence wall](#the-incidence-wall) for why a design that needs the sweep does not reach mainnet.

### Finding out, afterwards

Every check also writes a **receipt**: `awardOf(drawId, slot)` holds what that draw paid that slot, the prize or an
encrypted zero, decryptable only by the depositor it belongs to. Opening it is a decryption, so it costs a signature and
no gas, and it keeps working for good.

That matters more than it sounds, because a claim can be made by anybody. Whenever a keeper gets there first, the award
went into a balance while its owner was not looking, and the only evidence was a balance that had moved. Anybody asking
afterwards got nothing, and a rolled period made it permanent, since a check recomputes against the live tree and
reverts once those numbers move on.

So the two questions are answered by different machinery on purpose. **Am I owed anything** is a payment: it costs gas,
and it has the thirty-day deadline. **Did I win** is information: it costs a signature, and it has no deadline at all.
The app splits them the same way, which is why an old draw still opens long after nothing can be claimed from it.

The receipt is what stops a convenience for depositors from costing them the answer. It leaks nothing further: the
handle's existence is already public through `claimChecked`, only the depositor is granted the right to open it, and a
loser's zero is the same shape as a winner's prize. A test asserts that the keeper which ran the sweep cannot read what
it handed out.

### Why there is no "you won" notification

Telling somebody they won is the disclosure this whole design exists to prevent. Any channel carrying the result knows
the result, and so does anyone watching the channel - and even with an encrypted payload, winners would be identifiable
from the traffic alone, because losers would receive none.

What the app does instead is ring a doorbell that sounds the same for everybody. `ClaimChecked` fires for every
depositor in a sweep, winner and loser, at the same gas, so the pool can tell every depositor at once that a result is
ready without distinguishing between them. Counting those notifications tells an observer nothing they could not already
count on-chain.

The result itself never travels. It stays in `awardOf` as ciphertext, and the only thing that opens it is a signature
from the one address it was granted to.

**Checking for yourself is still the default**, and it costs you nothing until you want the answer.
`sweepRange(drawId, count)` is the operator's alternative: it walks slots in order and carries the running band edge
forward instead of rederiving it per person, which makes it about 1.6× cheaper each. Either path credits the same
encrypted award, and a slot already checked is skipped, never credited twice.

A sweep is a convenience rather than a deadline. Rolling used to end every open claim, which made sweeping before the
roll the only thing standing between an absent winner and a forfeited prize - the tree now keeps five generations of
history, so a claim outlives its own period and nobody has to be swept in time.

Claims stay open for **30 days** after settlement (`CLAIM_GRACE`), and - the part that matters - **no number of rolls
ends them**. Each tree node keeps five generations of history and the window is measured in wall-clock time from the
draw's own `settledAt`, so a draw settled in period 4 is still evaluated against period 4's weights through periods 5,
6, 7 and 8. A depositor nobody swept in time has lost nothing.

> ⚠️ **What that changed.** The grace used to be a claim on paper only. A claim was answerable while its own period was
> current, then for one roll after; `CLAIM_GRACE` said thirty days while the code allowed about fourteen, and an owner
> rolling early could cut it shorter still. The only thing in the way was the Judge panel declining to offer the button
>
> - a frontend courtesy, not a contract rule. The window is now thirty real days, `startNextPeriod` will not roll past a
>   draw still inside it, and both are tested. See [`docs/THREAT-MODEL.md`](THREAT-MODEL.md#43-the-owner).

### Weights freeze on their own

A claim reads live tree state, so a draw settled against one set of numbers would break if they shifted mid-window. They
cannot. Once a period elapses, `minuteOfPeriod` saturates, and a deposit adds to both the balance and the shortfall by
the same amount, so the two cancel. Withdrawals behave the same way. Deposits and withdrawals therefore keep working
right through the claim window without disturbing the draw, with no snapshots and nothing frozen.

---

## Confidentiality

| Encrypted                          | Public                              |
| ---------------------------------- | ----------------------------------- |
| Every balance                      | That an address deposited, and when |
| Every depositor's odds             | The pool total, once per draw       |
| The draw point                     | The prize each draw paid            |
| Whether a given person won         | Number of depositors                |
| A prize, until its winner opens it | All contract code                   |

Two things worth stating plainly:

- **Acquiring cUSDT publishes that amount.** cUSDT is minted by wrapping plain tUSDT, and a plain ERC-20 transfer cannot
  hide what it moves. That happens at the faucet, against the token and not the pool, so all it says is that an address
  holds some cUSDT. It says nothing about a deposit, or its size. Shield at one time and deposit at another, and even
  that bound goes away. No route in the app publishes a deposit itself.
- **The pool total is published once per draw.** It has to be: the draw point is reduced modulo the total, and encrypted
  modulo needs a plain divisor. The week-over-week difference is the sum of everyone's activity, never one person's,
  though it does narrow as the pool shrinks.

Full detail, including what we cannot prove, is in [`docs/THREAT-MODEL.md`](THREAT-MODEL.md).

### Nothing leaks to a live observer

Everything above holds for someone reading the chain after the fact. It is worth checking separately for someone
watching **live** - every transaction, every gas number, every storage slot, as it happens - because that is a strictly
stronger position and a weighting scheme built on plaintext branches could still leak through it even while the state
itself stays encrypted.

`checkClaim` has exactly one plaintext-visible branch, and it has nothing to do with winning:

```solidity
euint64 award =
    slotAssignedAt[slot] <= d.period
        ? FHE.select(_checkWinAt(d.period, slot, d.drawPoint), FHE.asEuint64(d.prize), FHE.asEuint64(0))
        : FHE.asEuint64(0);
```

The `if` here (`contracts/HushpotPool.sol`, `checkClaim`) tests **eligibility** - was this slot even assigned before the
draw it's being checked against - which is already public from that slot's own `SlotAssigned` event. The win/loss bit
itself, `_checkWinAt(...)`, never reaches a branch: it is the condition argument to `FHE.select`, evaluated entirely
inside the coprocessor, and both arms of the select cost the same regardless of which one is chosen. Solidity has no way
to spend more gas on one ciphertext value than another it never inspects.

Two more paths that could plausibly leak, checked directly rather than assumed:

- **Storage.** `_awardOf[drawId][slot] = award` and `_parkAward(slot, award)` both run unconditionally, once per check,
  writing an `euint64` handle either way. A loss writes an encrypted zero; a win writes an encrypted prize. Both are one
  ciphertext handle in one storage slot - indistinguishable on-chain, and nothing about the write itself (its slot, its
  size, whether it happens at all) depends on the outcome.
- **Gas.** The one real signal is that individually checking different slots costs slightly different gas - but it
  tracks the slot's own index, not its outcome. `_checkWinAt` walks the segment tree from the slot's leaf to the root,
  and that walk touches one tree level per **set bit** in the slot index (already public, from `SlotAssigned`), so more
  set bits means more encrypted comparisons. Measured directly by calling `checkClaim` on slots one at a time
  (`scripts/gas-parity-check.ts`) rather than batched: a 0-bit slot costs ~526,849 gas, a 1-bit slot ~603,714–718
  regardless of _which_ bit is set, a 2-bit slot ~680,586 - a constant ~76,866 gas per set bit, matching the tree walk
  exactly and explained in full by a value that was never secret. Win or loss never enters the estimate.

So the four things a live observer actually gets - that a check happened, when, which slot, and (with individual calls)
that slot's Hamming weight - are the same four things a _later_ reader of the chain gets from the same transaction.
Watching in real time buys nothing extra.

### Showing it, not claiming it

The **Proof** tab points the same relayer and the same session key at two ciphertext handles read straight off the
chain: yours, and another depositor's. One opens. One does not.

It also runs an on-chain **solvency proof**. The contract compares what it holds against what it owes on ciphertext,
then publishes the single bit that falls out, revealing neither figure. What it owes is the tree root **plus any prize
already swept but not yet folded into a leaf**: a winner's award is theirs from the moment it is parked, so leaving it
out would answer a narrower question than the proof appears to answer. Any address can trigger it, and reading the
result needs no wallet at all.

The **Draws** tab recomputes five things from public state with no wallet at all: the stored record, the committed die,
the prize formula, a hash of the deployed bytecode, and the negative this whole design rests on, that the bytecode
contains no winner-getter selector. There is no function to call that would answer the question.

---

## The yield source

Yield is currently an **admin-funded prize reserve**, which the bounty explicitly permits. `fundPrizeReserve()` takes
plain tokens (on purpose, so the pot's size stays publicly verifiable), wraps them, and credits a public reserve
balance. `sponsorPrize()` is the same path with no owner check on it, covered below.

Each draw's prize is derived, never chosen:

```
prize = poolTicketMinutes × annualRateBps ÷ (10,000 × 525,600)  +  sponsoredSinceLastDraw
```

capped by whatever the reserve holds. That it scales with the pool is not cosmetic: it is what stops a large late
depositor extracting value. Because the pot grows in proportion to the odds they take, every existing depositor's
expected return is left **exactly unchanged**. A fixed pot would let latecomers dilute everyone else.

### How a real yield source would plug in

One function changes and nothing else does. `fundPrizeReserve` becomes a harvest step behind a seam:

```solidity
interface IYieldSource {
  function deposit(uint64 amount) external; // idle principal out
  function withdraw(uint64 amount) external; // principal back, on demand
  function harvest() external returns (uint64); // realised yield, to the reserve
}
```

The draw, the claim, the weighting and the per-slot accounting are untouched, because none of them read a strategy -
they read `prizeReserve`, and a harvest credits the same counter the admin currently tops up. `annualRateBps` stops
being a parameter and becomes a measurement: the prize is whatever was actually harvested since the last draw, rather
than a rate applied to ticket-minutes.

Two things genuinely change, and neither is cosmetic:

- **Solvency gets harder to prove.** `proveSolvency` compares tokens held against tokens owed. Lend the principal out
  and the pool no longer holds it, so the proof has to include the strategy's position - which means trusting the
  strategy's own accounting for the part that is no longer in hand.
- **Withdrawal stops being instant in the worst case.** Principal is withdrawable in every phase today because it is
  sitting in the contract. A strategy with a redemption delay would break that, so any real source has to be one that
  redeems on demand, or keep a liquidity buffer sized to normal outflow.

That is why it is a mock here rather than an integration: the interface is a morning's work, and the solvency and
liquidity questions behind it are the actual product.

### Sponsorship

`sponsorPrize()` is callable by anyone and adds the full amount to the **very next** prize, on top of the formula. The
money never becomes a slot, never earns odds, and can never win itself back, so no depositor's chances move. There is
simply more to hand out. It is not withdrawable: a gift, not a stake.

PoolTogether has two shapes of this. `PrizeVault.sponsor` delegates a deposit's odds away, so the sponsor keeps
withdrawable principal and donates only the yield stream; `PrizePool.contributePrizeTokens` donates prize tokens
outright. Hushpot does the second. Adding the gift in full beats letting it earn for a week and donating that instead:
at 5%, a week of yield on a sponsorship comes to about a thousandth of the sponsorship, which does not justify a second
accumulator or a second thing to explain.

---

## Measured costs

On Sepolia, against the live coprocessor:

| Operation              | Gas                         | Note                                        |
| ---------------------- | --------------------------- | ------------------------------------------- |
| Deploy                 | 3,938,775                   |                                             |
| Deposit                | 570k–1.34M                  | grows with pool size, see below             |
| First deposit a period | 785,401                     | archives the path; 576,428 for the next one |
| Claim, per depositor   | **533,159**                 | was 2.4M; includes the receipt              |
| Sweep, per depositor   | **368,025**                 | paged, 1.45× cheaper than a claim           |
| Read a receipt         | 1 signature, no transaction | works after the period rolls                |
| Reveal your position   | 1 signature + 1 transaction | signature cached for the visit              |

Every figure above is printed by `HushpotDepthGas.ts` and `HushpotSweepGas.ts` on each run, so a stale number here is
one `npx hardhat test` away from being caught.

Deploy, deposit and claim figures are read back off a live Sepolia deployment, measured when it held fourteen seeded
depositors with one settled draw and one full sweep, averaged over all fourteen claim transactions. They are the
conditions those measurements were taken under rather than a description of the pool today, which is larger - a claim
scales with tree depth, and the ladder in `HushpotDepthGas.ts` is what tracks that. The paged-sweep and depth figures
come from `HushpotSweepGas.ts` and `HushpotDepthGas.ts`, which print them on every run so they cannot drift silently.

**Claims went from 2.4M to 650k, a factor of 3.7.** Crediting a prize used to repair every ancestor sum between the slot
and the root, three encrypted additions per level, for everyone. For all but one person the amount being added was an
encrypted zero. Awards are now parked on the slot and folded into the tree on that slot's next deposit or withdrawal,
which walks that path anyway.

About 200k of that 650k is the receipt: storing the award ciphertext and granting the depositor the right to open it. It
was 451k before, so the figure got worse on purpose, and it is worth saying why rather than quietly reporting the old
number. Without it, a depositor swept by a keeper - which is nearly all of them - had no way to learn what the draw paid
them, and no way at all once the period rolled. The cheaper claim was cheaper because it answered a question and then
destroyed the answer.

**Deposits scale with the pool, not with the capacity.** The tree walks only as far as the highest node covering the
slots in use, so depth arrives with the crowd:

| Depositors | Deposit gas |
| ---------- | ----------- |
| 1st        | 565,176     |
| 5th        | 1,140,869   |
| 9th        | 1,335,975   |

The ninth joiner pays 136% more than the first, and that is the whole point: the cost tracks the crowd, not the
capacity. Raising the slot cap from 1,024 to 16,384 did not move any of these numbers, because the tree is still only as
deep as the slots in use.

FHE work is metered separately in HCU, capped at 20M global and 5M sequential per transaction. A page of four slots fits
comfortably; the old one-claim-per-transaction limit came from the pre-optimisation claim cost and no longer applies.

---

## Invariants under test

173 tests, run against the FHEVM mock. The ones worth naming:

- exactly one depositor is paid, and exactly the prize, verified by decrypting every participant's balance before and
  after a sweep
- a self-check followed by a sweep does **not** credit the same slot twice
- the pool total is published only at a draw boundary, never on demand
- every slot is selected exactly as often as its weight, checked by enumerating every draw point rather than sampling
- bands tile the number line with no gaps and no overlaps, checked exhaustively against a plaintext oracle
- a prize parked on a slot whose owner has left is never handed to whoever inherits that slot, and dropping it leaves
  the pool over-collateralised rather than under - the direction of that error is asserted, not assumed
- a period cannot roll past a draw still inside its thirty-day grace, if doing so would push it beyond what the tree's
  history can still answer - deliberately not a sweep gate, which was tried, removed, and is why this one is shaped the
  way it is
- a loyalty boost cannot change a draw's numbers once that draw exists for the period, open or settled - not gated on
  the clock, since the owner may open a draw before it has genuinely elapsed
- a deposit or withdrawal carries zero net weight for a draw the owner opened early, the same as one made after the
  period has genuinely ended - checked directly against a decrypted total, not inferred
- a withdrawal is clamped to the balance held, because a ciphertext cannot be branched on
- no second draw can settle in the same period
- a prize never touches principal
- leaving with `exitPool` returns the principal in full and gives the slot back at the next roll
- a recycled slot starts clean, with none of the previous holder's time credit
- a sponsorship lands in full in the very next prize, and the accumulator is spent, not carried
- solvency counts prizes that are parked but not yet folded in, and never counts one twice
- weights freeze when a period ends, so deposits during a claim window cannot move a settled draw
- odds are proportional to amount _and_ time, so a small deposit held all week beats a 5× larger one made at the
  deadline
- the sandbox's owner contract forwards a draw and a roll to a stranger, and exposes no third function that could reach
  the yield rate or ownership
- a depositor swept by somebody else can still open their own result for that draw, after the period has rolled and
  `checkClaim` has stopped being callable - and the keeper that ran the sweep cannot open it
