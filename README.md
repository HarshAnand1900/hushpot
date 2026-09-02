# Hushpot

**A no-loss prize pool. Nobody learns who won, the contract included.**

Deposit a confidential token. Keep your principal, withdrawable in full at any time. The yield the pool generates is
awarded to one depositor each week, weighted by how much they deposited and how long they left it. Balances, odds and
winnings are encrypted end to end, and the draw is still something a stranger can verify.

Built for the Zama Developer Program, Mainnet Season 4.

- **Live app:** <https://hushpot-fhevm.vercel.app>
- **Contract:**
  [`0x1EA0982e4Ed5DCD6F0329a92D01A0065F864a8a2`](https://sepolia.etherscan.io/address/0x1EA0982e4Ed5DCD6F0329a92D01A0065F864a8a2)
  (Sepolia). [Verified source](https://sepolia.etherscan.io/address/0x1EA0982e4Ed5DCD6F0329a92D01A0065F864a8a2#code).
  The address in [`web/src/lib/contract.ts`](web/src/lib/contract.ts) is always the live one
- **Judge panel:** [`/judge`](https://hushpot-fhevm.vercel.app/judge). Run a whole draw cycle from the browser, no
  terminal needed
- **Token:** Zama's official `cUSDTMock`,
  [`0x4E7B…4491`](https://sepolia.etherscan.io/address/0x4E7B06D78965594eB5EF5414c357ca21E1554491)
- **Faucet:** the underlying
  [`USDTMock`](https://sepolia.etherscan.io/address/0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0) has an open `mint`, so
  anyone can self-serve
- **Judge sandbox:** [`/judge?pool=sandbox`](https://hushpot-fhevm.vercel.app/judge?pool=sandbox). The same panel
  pointed at a second, expendable pool
  ([`0x4350…96DB`](https://sepolia.etherscan.io/address/0x4350b2a3957aE8a24f0cF264e818088b809096DB#code)) whose owner is
  a contract, so all six cycle steps are open to any wallet. No key to import, no week to wait. See
  [Running the cycle as a judge](#running-the-cycle-as-a-judge-today)
- **Threat model:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), covering what leaks and when

### What is running right now

Not a description of what it would do. These are reads off the live contract, and every one of them is a public getter
anybody can call from Etherscan:

|                  |                                       |
| ---------------- | ------------------------------------- |
| Depositors       | **30**, holding encrypted balances    |
| Pooled principal | **~842,134 cUSDT**                    |
| Draws settled    | **1** — draw #0 paid **807.53 cUSDT** |
| Claims answered  | **30 of 30**                          |
| Prize reserve    | 59,192.47 cUSDT                       |
| Currently        | period #0, accruing toward draw #1    |

A full cycle has run end to end: thirty deposits accrued, a draw opened and settled against an encrypted die, and every
depositor was checked. The prize is in one of those thirty balances and **nobody — including the contract — knows
which**. Each of them can open their own receipt with a signature and no gas; nobody can open anyone else's.

The prize is derived, not chosen: `pooled × 5% ÷ 52` on 842,134 gives 807.53. That proportionality is the point — a
large late depositor grows the pot exactly as much as they grow their own odds, so arriving late dilutes nobody. It also
means a small pool must show a small prize, or the yield figure would be a lie.

**Three of the four cycle steps are permissionless.** Once the week is up, any wallet can open the draw, settle it, and
pay every depositor out — the operator is not in that path and cannot stall it. Only the roll is the operator's, and
only because the thirty-day claim window outlasts the seven-day period, so nobody else reaches the point where the
contract would let them close a claim early. That single exception is the one place this design asks for trust, and
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner) treats it as one rather than as a feature.

---

## The idea in one paragraph

Everyone deposits into a shared pool. The pool earns yield. Instead of dribbling that interest back to each depositor,
it is bundled into a single weekly prize and awarded at random, with odds proportional to what you contributed and how
long it sat there. Nobody can lose, since a draw never touches principal, only yield. What does not exist yet is a
version where the amounts stay encrypted and the winner is never resolved on-chain at all.

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
actually in use — a pool of nine pays for a tree of four. Raising the cap from 1,024 to 16,384 moved none of the
measured costs for that reason. `HushpotDepthGas.ts` pins the ladder and prints it on every run.

### The incidence wall

This is the one that decides whether a design survives mainnet, and it is mostly left unsaid.

Whatever a claim costs, **somebody has to pay it `n` times per draw**. Making claims cheap, batchable and permissionless
does not change that. It changes who is inconvenienced. At the measured 649,774 gas a claim, a 10,000-depositor pool
costs about 6.5 billion gas to settle — every draw, forever — and there is no batch size that turns that into a
reasonable expense for whoever volunteered.

So the protocol does not depend on a sweep. `checkMyClaim` is one transaction, sent by the person it pays, and it is the
only settlement path Hushpot requires. Cost per depositor is flat, nobody funds anybody else's claim, and what the pool
costs to run does not grow with the number of people in it. The keeper sweep is a convenience — sensible on a small pool
or an L2, useful for depositors who have wandered off, and never load-bearing.

### A claim outlives its period

A claim recomputes your band from the tree, and the tree is period-scoped: roll it, and the corrections age out while
balances keep moving. The band moves with them. So the same call after a roll used to return a **different** answer
rather than a stale one, and was refused outright — which meant anyone not swept in time simply forfeited.

The obvious repair is to block the roll until everyone has been checked. That was tried here and removed, because it
reads as safety and is not: it makes the cycle depend on the same O(n) sweep [the incidence wall](#the-incidence-wall)
argues against. A pool nobody sweeps degrades from weekly to monthly and then forfeits the stragglers anyway.

What ships instead is **one generation of history per node**, written copy-on-write:

```solidity
function _archive(uint256 node) internal {
  uint32 was = _stamp[node];
  if (was == currentPeriod) return; // already current
  if (euint64.unwrap(_balance[node]) == bytes32(0)) return; // never written
  _prevBalance[node] = _balance[node]; /* … */
  _prevStamp[node] = was + 1;
}
```

`checkClaim` then evaluates against `_checkWinAt(draw.period, …)`, so a draw settled in period 4 is still judged by
period 4's weights once period 5 has begun. Snapshotting every slot at settlement would be O(n) encrypted storage per
draw; this is O(1) amortised, because a node pays once on its first touch in a period and nothing after.

**Measured**, in `HushpotDepthGas.ts` so it cannot drift: deposits inside a period cost **+0.4%**, and the first deposit
after a roll costs **208,387 gas more** — once per node per period, never per depositor.

The remaining limit is honest and bounded: one generation back. A draw two periods old reverts with `ClaimWindowClosed`
rather than answering from weights that no longer exist. Refusing is the correct behaviour there; guessing is not.

One detail worth keeping: `_prevStamp` stores `period + 1`. Storing the raw period collides with period 0 being real —
its history was written and instantly unreachable, the bands stopped covering the total, and a draw point could land in
the gap so that **nobody won at all**. It returned a plausible number on encrypted values, with no revert. The test that
caught it asserts `alice + bob == prize` against a figure captured while the period was still current.

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

### Odds are measured against the last published total

Your odds are `yourWeight ÷ poolTotal`, where `poolTotal` is the figure published at the **last settled draw**, never a
live reading.

That is not a convenience. Given a live denominator, you could divide your own odds into it, recover the running pool
total, then watch it move by a single deposit and recover that deposit by subtraction. Freezing it at a draw boundary
means the only total anybody learns is the one the draw already made public.

The cost is that odds go stale between draws. Deposit after a draw and your weight grows while the denominator does not,
so the ratio drifts upward and can exceed 100%. The app does not paper over that with a capped number: past 100% it
shows `—` and says the pool has outgrown the last published total. A fresh figure arrives with the next draw.

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
is a Monte Carlo run — a few hundred thousand random draws, and a distribution that comes out close enough.

`SegmentTree.ts` does something stronger. It builds a pool whose weights sum to 100, then walks **every** draw point in
`[0, 100)` — not a sample of them, all of them — and asserts that each slot is selected exactly as many times as its
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

`checkClaim(drawId, account)` is the same thing callable by any address, for any address — safe to expose, because the
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
the result, and so does anyone watching the channel — and even with an encrypted payload, winners would be identifiable
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

A sweep is worth running before the period rolls, because rolling ends every open claim. That is what stops a winner who
never came back from losing the prize.

Claims stay open for **30 days** after settlement (`CLAIM_GRACE`). The window costs nothing to provide: weights freeze
on their own when a period ends, so holding the roll back is the whole mechanism. No snapshots, no per-slot state.

> ⚠️ **With one exception, and it is a real one.** `startNextPeriod()` enforces the grace against everybody _except_ the
> owner, and rolling the period is what closes a claim. So the owner can end the window early and strand an unclaimed
> prize. The exemption exists so a testnet demo does not have to wait a month to show a second cycle; the Judge panel
> refuses to roll until every slot is swept, but that is frontend courtesy, not a contract rule. Treated as a trust
> assumption and documented in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner).

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

Full detail, including what we cannot prove, is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

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

The draw, the claim, the weighting and the per-slot accounting are untouched, because none of them read a strategy —
they read `prizeReserve`, and a harvest credits the same counter the admin currently tops up. `annualRateBps` stops
being a parameter and becomes a measurement: the prize is whatever was actually harvested since the last draw, rather
than a rate applied to ticket-minutes.

Two things genuinely change, and neither is cosmetic:

- **Solvency gets harder to prove.** `proveSolvency` compares tokens held against tokens owed. Lend the principal out
  and the pool no longer holds it, so the proof has to include the strategy's position — which means trusting the
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

## Repository

```
contracts/
  ConfidentialTimeWeightedTree.sol   encrypted odds accounting
  HushpotPool.sol                    deposits, draws, claims, solvency
  SandboxOperator.sol                owns the judge sandbox, forwards two calls to anyone
  SegmentTree.sol                    plaintext oracle, proven then encrypted
  TimeWeightedTree.sol               plaintext oracle for the time weighting
  mocks/                             local token pair + test-only tree harness
test/                                153 tests
tasks/hushpot.ts                     the operator + keeper flow
deploy/01_hushpot.ts                 deployment
web/                                 the app
docs/                                threat model, design brief, roadmap
```

The plaintext contracts are not dead code. Encrypted arithmetic fails silently: no revert, no wrong number, just an
opaque handle. So the structures were built and proven in the clear first, then ported. They remain as the correctness
oracle, and every property proven there is re-asserted against the encrypted version.

---

## Operating the protocol

There is no admin login, because there is no server holding state. "Admin" here is an address with on-chain permissions,
plus automation that calls public functions on a schedule. Almost everything is the second kind.

### What is gated, and what is not

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
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner) treats it as one.

The consequence worth stating: **the operator cannot run the pool on its own terms, and cannot stop anyone else running
it.** The one exception is the claim window, where the owner may roll a period early; that is a real trust assumption
and is documented in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner).

### Running the cycle as a judge, today

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
| Pool      | [`0x4350b2a3957aE8a24f0cF264e818088b809096DB`](https://sepolia.etherscan.io/address/0x4350b2a3957aE8a24f0cF264e818088b809096DB#code) |
| Its owner | [`SandboxOperator`](https://sepolia.etherscan.io/address/0xF7B8eAb79b83bEfe6DAacc4F5fc69817aD563ef2#code), a contract, not a person  |

**There is no key to import.** All six steps run from whatever wallet you already have, on a pool whose first cycle has
never been run.

#### How that works

The obvious way to open a sandbox is to publish its owner's private key, and that was the first attempt. It works, and
it is bad. It asks a reviewer to import a stranger's key into their wallet before they can look at anything, which
nobody should be in the habit of doing and most reviewers will simply decline.

So ownership went to [`contracts/SandboxOperator.sol`](contracts/SandboxOperator.sol) instead. It is about twenty lines
of code under twice as much comment, and it forwards three calls to anybody who asks:

| Forwarded            | Why it is safe                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `openDraw()`         | Seals and publishes the pool total. One draw per period is enforced by the pool regardless. |
| `startNextPeriod()`  | Rolls the week. The pool already blocks it until every depositor is swept.                  |
| `fundPrizeReserve()` | Only ever adds money, and the money is the caller's.                                        |

What it deliberately **cannot** do matters more. There is no forwarder for `setAnnualRateBps`, so nobody can set the
sandbox's yield to zero and make every prize read `0.00`. None for `transferOwnership`, so nobody can take the pool. And
no generic `call`, which would have been both of those plus every owner-gated function added in future. The owner's
dangerous powers are not delegated. They are destroyed, and two harmless ones are handed out in their place. Five tests
in [`test/SandboxOperator.ts`](test/SandboxOperator.ts) pin that down, including one asserting the ABI holds those three
functions and the `pool` getter, and nothing else.

The main pool's owner key is **not** shared, and that is not an oversight. It can set the yield rate to zero and close
claim windows early, the sharpest trust assumption in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner).
Publishing it would make that document a lie. The sandbox absorbs the experimentation instead.

#### What you will find there

Four confidential deposits are seeded and **no draw has settled**. The pot therefore reads `—` instead of a figure: with
nothing published to estimate from there is no pot yet, which is not the same as an empty one. Step 01, sponsoring, puts
a number on it immediately.

Running the six steps in order takes the pool from that state to a settled draw, a swept claim, a solvency proof, and a
fresh period. At the end the button that said _Reset console_ says **Run the cycle again**, and it does: the roll leaves
the pool back at step 01 with a new period open, so the whole thing can be run as many times as you like.

Add `?pool=sandbox` to any page (`/pool`, `/draws`, `/proof`, `/judge`) and the whole site re-points at it. A yellow
banner across the top says so, because every figure on screen then belongs to a throwaway contract. Every link carries
the parameter onward, so a refresh or a copied link stays where you are. Drop it to return to the real pool.

#### Is it the same money?

The same **tokens**, in separate **balances**. Both pools use Zama's official
[`cUSDTMock`](https://sepolia.etherscan.io/address/0x4E7B06D78965594eB5EF5414c357ca21E1554491) and the plain
[`USDTMock`](https://sepolia.etherscan.io/address/0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0) behind it, because there
is one of each on Sepolia and both are test tokens with an open faucet.

Everything else is separate. Each pool is its own contract with its own depositors, its own prize reserve, and its own
draws. Depositing into the sandbox does not put a coin into the live pool, cannot win the live pool's prize, and is
withdrawn from the sandbox. The two never touch. All they share is where the play money is minted.

That also means nothing in the sandbox is worth anything. `USDTMock.mint` is open to everyone, so the tokens cost a
Sepolia gas fee, which is why a pool anyone can freely open draws on is not a problem worth solving.

### Three ways to call anything

1. **The Judge panel.** [`/judge`](https://hushpot-fhevm.vercel.app/judge) runs the whole cycle from a browser. On the
   main pool the two owner-gated steps are labelled and enable only for the owner; on the sandbox all six are live for
   everyone.
2. **Etherscan.** Both contracts are verified, so the _Write Contract_ tab is a working admin UI with no code and no
   local setup. This is how most protocols are actually operated. For the sandbox's gated pair, call the **operator's**
   Write tab, not the pool's.
3. **The CLI.** `tasks/hushpot.ts` covers every operation. Run `npx hardhat hushpot:status --network sepolia` to see
   where things stand. Every task takes a `HUSHPOT_POOL` address override, so the sandbox is drivable from the CLI too:

   ```bash
   HUSHPOT_POOL=0x4350b2a3957aE8a24f0cF264e818088b809096DB npx hardhat hushpot:status --network sepolia
   ```

   Unset, the tasks use the deployed pool. `hushpot:sandbox` deploys a fresh one in a single command: pool, operator,
   reserve, seeded depositors and the ownership handover.

### The weekly schedule, in UTC

Periods are seven days long and start whenever the roll is called, so the schedule is set by _when you call it_, not by
anything in the contract. Held to this cadence it never drifts:

| UTC                         | What happens                                          |
| --------------------------- | ----------------------------------------------------- |
| **Monday 06:00**            | `startNextPeriod`, the week opens and deposits accrue |
| Monday 06:00 → Monday 00:00 | 162 hours of odds accruing                            |
| **Monday 00:00**            | `hushpot:draw --force`: seal, roll the die, settle    |
| Monday 00:00 → 06:00        | `hushpot:sweep --draw N`, and prizes land             |
| **Monday 06:00**            | roll again, and the next week starts exactly on time  |

The six-hour gap is the maintenance window: the draw is opened six hours before the nominal seven-day boundary, using
the owner's `--force` exemption, so that settling and sweeping finish before the next period is due to start. Without it
the roll would slip by however long the sweep took, and the schedule would walk forward every week.

**Sweep before you roll, every time.** Rolling closes the claim window permanently, since `checkClaim` reverts once
`draw.period != currentPeriod`. A prize that has not been checked by then is stranded: deducted from the reserve,
credited to nobody, unrecoverable by anyone including the owner. This has already happened once on the live pool, to
draw #0, which is why it is stated twice.

### Keeping it running

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

That last condition is the whole reason the keeper exists. Rolling ends the claim window for good, because `checkClaim`
reverts once `draw.period != currentPeriod`. A prize not swept by then is deducted from the reserve and credited to
nobody, for ever. It has already happened once on the live pool, done by hand. The keeper cannot make that mistake.

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

### Deliberately not upgradeable

There is no proxy. The period is a `constant`, the tree geometry is a `constant`, and the draw logic cannot be swapped.
Changing any of it means deploying a new pool and letting people move to it voluntarily.

That is the same choice PoolTogether makes, its Prize Pool being immutable with no admin controls at all, and here it is
load-bearing, not merely tidy. "There is no winner field" is a much weaker claim if someone can upgrade one in tomorrow.
The cost is real: parameters nobody thought to expose cannot be changed later, and the seven-day period is one of them.

**For a production deployment**, two things should change before real money is involved, and neither is built here:
ownership should move to a multisig behind a timelock (`Ownable.transferOwnership` makes that one transaction, no
redeploy), and the weekly cycle should be a funded keeper instead of a person.

### What immutability costs, and what it cost here

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
[`web/src/lib/contract.ts`](web/src/lib/contract.ts) are the deployments these contracts compile to, and Etherscan
carries the verified source for each. What immutability cost was four deployments in two days and a pool's worth of
history discarded each time — which is the real price of not being able to patch, paid rather than described.

---

## Running it yourself

**Requirements:** Node 20+, a wallet with Sepolia ETH.

```bash
npm install
npx hardhat test                 # 153 tests, no network needed
```

Deploying:

```bash
npx hardhat vars set MNEMONIC    # stored locally, never in the repo
npx hardhat hushpot:whoami --network sepolia    # the address to fund
npx hardhat deploy --network sepolia
```

Sepolia needs no API key, since it defaults to a public endpoint.

Operating it:

```bash
npx hardhat hushpot:status    --network sepolia   # pool state
npx hardhat hushpot:faucet    --amount 1400000000000 --network sepolia
npx hardhat hushpot:fund      --amount 5000000000   --network sepolia
npx hardhat hushpot:deposit   --amount 1340000000000 --network sepolia
npx hardhat hushpot:seed      --count 4  --network sepolia   # several depositors
npx hardhat hushpot:draw      --force    --network sepolia   # open, decrypt, settle
npx hardhat hushpot:sweep     --draw 1   --network sepolia   # claim for everyone
npx hardhat hushpot:solvency  --network sepolia
```

`--force` lets the owner run a draw without waiting a week, which is how to see a full cycle in a few minutes.

The app:

```bash
cd web && npm install && npm run dev
```

Point `POOL_ADDRESS` in `web/src/lib/contract.ts` at your deployment.

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
conditions those measurements were taken under rather than a description of the pool today, which is larger — a claim
scales with tree depth, and the ladder in `HushpotDepthGas.ts` is what tracks that. The paged-sweep and depth figures
come from `HushpotSweepGas.ts` and `HushpotDepthGas.ts`, which print them on every run so they cannot drift silently.

**Claims went from 2.4M to 650k, a factor of 3.7.** Crediting a prize used to repair every ancestor sum between the slot
and the root, three encrypted additions per level, for everyone. For all but one person the amount being added was an
encrypted zero. Awards are now parked on the slot and folded into the tree on that slot's next deposit or withdrawal,
which walks that path anyway.

About 200k of that 650k is the receipt: storing the award ciphertext and granting the depositor the right to open it. It
was 451k before, so the figure got worse on purpose, and it is worth saying why rather than quietly reporting the old
number. Without it, a depositor swept by a keeper — which is nearly all of them — had no way to learn what the draw paid
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

153 tests, run against the FHEVM mock. The ones worth naming:

- exactly one depositor is paid, and exactly the prize, verified by decrypting every participant's balance before and
  after a sweep
- a self-check followed by a sweep does **not** credit the same slot twice
- the pool total is published only at a draw boundary, never on demand
- every slot is selected exactly as often as its weight, checked by enumerating every draw point rather than sampling
- bands tile the number line with no gaps and no overlaps, checked exhaustively against a plaintext oracle
- a prize parked on a slot whose owner has left is never handed to whoever inherits that slot, and dropping it leaves
  the pool over-collateralised rather than under — the direction of that error is asserted, not assumed
- a period cannot roll while any slot the last draw covered is unanswered, and the guard binds the owner too, since only
  the owner can reach the roll early enough for it to matter
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
  `checkClaim` has stopped being callable — and the keeper that ran the sweep cannot open it

---

## Licence

BSD-3-Clause-Clear.
