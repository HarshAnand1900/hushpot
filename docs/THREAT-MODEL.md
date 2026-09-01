# Hushpot — Threat Model

What is encrypted, what is public, what leaks, and what you have to trust.

This document is deliberately unflattering. A confidential system that only advertises its strengths is harder to
evaluate than one that names its edges, and every claim below can be checked against the deployed contract.

**Contract:** `HushpotPool` · Sepolia · `0x1EA0982e4Ed5DCD6F0329a92D01A0065F864a8a2`

> The live address always matches [`web/src/lib/contract.ts`](../web/src/lib/contract.ts). Earlier deployments
> referenced in git history are superseded.

## Findings from review, and what changed

**The live pool total was publishable on demand — fixed.** `refreshTotal()` was `external` and marked the running total
publicly decryptable. Read it, wait for a deposit, read it again, and the difference is that depositor's amount in the
clear. Two calls and the encryption was worth nothing.

It is now `internal` as `_refreshTotal`, and **nothing in the production contract calls it at all** — `openDraw`
publishes the total itself, inline, once per period. Only the test harness reaches it, with a comment saying why
exposing it would be a break. Verified by grep as part of the pre-submission audit rather than assumed.

**A forced draw does not stay settled.** `_checkWin` derives each band from the live tree rather than a snapshot taken
at settlement, which is safe only while the tree cannot move. That is what elapsing guarantees: once `minuteOfPeriod`
saturates, a deposit adds `amount × PERIOD_MINUTES` to the balance term and the same to `lateCredit`, so the weight
change is exactly zero.

Open the draw early with the owner's `--force` exemption and that protection is gone. Deposits between settlement and
the roll still move weights — 1,000 deposited at minute 6,809 of 10,080 adds 3,271,000 ticket-minutes — which shifts the
bands of every higher-indexed slot against a die that is already committed. It cannot be aimed, since the die is
encrypted and nobody can read it, but the outcome is no longer fixed at settlement.

**Mitigation:** the keeper refuses to force unless told to, so in normal operation the draw waits for the period to
elapse and the freeze holds. Forcing remains available for demonstrations, where compressing a week into minutes is the
point, and it now prints a warning saying what it gives up. This is the same owner exemption documented in §4.3.

**Odds were written to disk in plaintext — fixed.** The odds sparkline persisted its series to `localStorage`, keyed by
address. Odds are `yourWeight / publishedTotal` and the total is public at every draw, so the stored figure was a
plaintext derivative of an encrypted balance: read the file, divide, and the position falls out without any key. The
series now lives in memory for the life of the page, and any entry an earlier build wrote is deleted on load.

**A swept depositor could not find out what they had won — fixed.** Both claim paths computed
`FHE.select(won, prize, 0)`, credited it, and discarded the handle. Since a keeper sweeps everybody before the roll,
almost every depositor was checked while they were not looking, and the only evidence left was a balance that had moved.
Asking afterwards was impossible: `checkClaim` recomputes against the live tree and reverts once the period rolls. Both
paths now store the ciphertext as `awardOf(drawId, slot)` and grant it to the depositor, so the answer is a gas-free
decryption that survives the roll. The grant goes to the slot's holder, never to the caller, so a keeper cannot read
what it just handed out.

**A self-check followed by a sweep credited twice — fixed.** `sweepRange` did not skip slots already settled by
`checkClaim`, so a winner could be paid the prize twice out of a reserve that had only set one aside. `sweepRange` now
skips already-checked slots — after advancing the running band edge, which matters: returning early without advancing
would shift every subsequent band and pick the wrong winner.

**The confidential deposit route was unreachable — fixed.** The contract has always had
`deposit(externalEuint64, proof)`, but the app only ever called `depositUnderlying`, whose amount is public. The faucet
handed out plain tokens only, so a newcomer could not use the private path at all. The faucet now shields on request,
and the confidential route is the only one the app has — the public route was removed from the frontend rather than left
as an option, because an option to publish your own deposit is one somebody takes by accident.

**The seeding tasks were still publishing amounts — fixed.** Removing the public route from the frontend did not remove
it from `tasks/hushpot.ts`, which seeded demo depositors with `depositUnderlying` and put 58 amounts in the clear on a
pool advertised as confidential. Every task now uses the encrypted path. The lesson generalises: the leak was not in the
contract or the interface but in the tooling that filled them, which no amount of reading the app would have caught.

---

## 1. What is encrypted

Every one of these is a `euint64` or `ebool` on-chain. No party — not other depositors, not the contract owner, not the
contract itself — can read them.

| Value                              | Notes                                              |
| ---------------------------------- | -------------------------------------------------- |
| Each depositor's balance           | Only its owner can decrypt, via EIP-712            |
| Each depositor's odds              | Derived from the encrypted balance and time held   |
| The draw point                     | `FHE.randEuint64`, never decrypted by anyone, ever |
| Whether a given depositor won      | Never computed as a plaintext anywhere             |
| A prize, until its winner opens it | Added as `FHE.select(won, prize, 0)`               |
| The pool's own token holdings      | Compared to liabilities without revealing either   |
| Prizes swept but not yet folded in | Counted as owed, so solvency is not understated    |

The winner is not _hidden_. There is nothing to hide, because no code path anywhere derives it. A claim adds either the
prize or an encrypted zero, and on-chain those two transactions are indistinguishable — including in gas.

---

## 2. What is public, by design

| Value                                           | Why                                                       |
| ----------------------------------------------- | --------------------------------------------------------- |
| That an address deposited or withdrew, and when | Inherent to a public chain. Transactions are visible.     |
| Which slot an address holds                     | A plain mapping. Reveals participation, never amount.     |
| The pool total, once per draw                   | Needed to reduce the draw point into the pool's range.    |
| The prize each draw paid                        | Not anybody's balance — but it inverts to the total. §3.5 |
| Number of depositors                            | Aggregate — and the size of the anonymity set. §3.6       |
| That a slot was checked for a draw              | Reveals a check happened, never its outcome.              |
| Period schedule, yield rate, prize reserve      | Protocol parameters.                                      |
| All contract code                               | The selection rule should be readable.                    |

**Participation is public; position is not.** Anyone can see that you are in the pool. Nobody can see what you have in
it.

That is the claim this protocol makes, and §3.5 is where it is weakest: the published total is an aggregate, but
subtracted across two draws and divided by a public timestamp it reconstructs a single depositor's amount exactly. The
guarantee holds against reading the chain; it does not hold against arithmetic on what the chain already publishes,
whenever a period is quiet enough. That section carries the worked example, and shows why the obvious fix does not close
it.

---

## 3. Known leaks

### 3.1 Acquiring cUSDT publishes that amount

cUSDT is minted by wrapping plain tUSDT, and a plain ERC-20 transfer cannot hide its amount. **Whatever you shield is
visible to anyone**, in the token's own `Transfer` event, before any deposit happens.

What it does _not_ reveal is a position. Shielding is a separate transaction against the token, not the pool: it says an
address now holds some cUSDT, not that it deposited, nor how much, nor when. Everything from the deposit onward — your
balance, your odds, your winnings — is encrypted.

- **Severity:** medium. It bounds your position from above, and only if you shield and deposit in one sitting.
- **Decouple it:** shield at one time and deposit at another, in a different amount. The two are then unlinkable by size
  or by timing, and the bound goes away.
- **Or skip it:** any cUSDT works. Tokens acquired elsewhere carry no wrapping event of yours at all.

`depositUnderlying()` — which takes plain tUSDT and wraps it inside the pool — collapses those two steps into one and so
publishes the deposit's size directly. **Nothing in the app calls it.** It remains on the contract because removing a
deployed function is not possible and because it is the honest baseline the confidential route is measured against; the
frontend offers no route to it, and the CLI tasks use the encrypted path.

### 3.2 The pool total is published at each draw

The draw point must be reduced modulo the pool's total, and encrypted modulo requires a plain divisor — so the total is
decrypted once per draw and relayed back with a proof.

The difference between two consecutive totals equals the **sum of that period's net activity**. With many depositors
this reveals nothing about any individual. With few, it narrows sharply. **With a single depositor it is exact.**

- **Severity:** scales inversely with pool size. Genuinely weak on a small testnet pool.
- **Mitigation:** publish only at draw boundaries, never continuously. A live total would leak every deposit by
  subtraction. This bounds the sampling rate; it does not close the leak. See §3.5, where the boundary version is
  carried through to an exact recovery against the live pool.
- **Consequence honoured in the UI:** the odds display divides by the total published at the _last_ draw, never a live
  one. A live denominator would let anyone recover the running total by dividing their own odds into it.

### 3.3 The time factor applied to a deposit is public

Odds are weighted by amount × time held, and the minute a deposit landed is a public block timestamp. So the
_multiplier_ is known. The amount is not, so the product is not.

- **Severity:** low alone, and the qualifier matters: this is half of §3.5. The multiplier is harmless only while the
  product is unknown, and §3.2 supplies the product.

### 3.4 Concentration in a small pool

A depositor holding most of a small pool has most of the odds. Over many draws, an observer who could correlate payouts
with balances might infer something — though since winners are never resolved on-chain, they would have no payouts to
correlate.

- **Severity:** low today, and largely theoretical while winners stay unresolved.
- **Possible mitigation, not implemented:** cap any single depositor's odds with `FHE.min`. This would clamp odds only,
  never principal, so the no-loss guarantee is untouched.

### 3.5 §3.2 and §3.3 compose, and together they are exact

The two leaks above are individually modest and were documented that way. Composed, they recover a deposit in full. §3.3
argues that knowing the multiplier is harmless because the amount is unknown, so the product is unknown. That reasoning
runs the other way as well: **knowing the product and the multiplier gives the amount by division.**

- §3.2 gives the product. The difference between two published totals is that period's net weight.
- §3.3 gives the multiplier. `Deposited` names the address, and the block timestamp fixes the minute.
- Divide, and the deposit falls out in the clear.

This is not theoretical. It works on the live deployment, and the arithmetic can be re-run by anybody:

| Reading                           | Value                                  | Where from                |
| --------------------------------- | -------------------------------------- | ------------------------- |
| `draws(1).total`                  | 9,499,068,241,296,480                  | public getter             |
| `draws(2).total`                  | 9,700,628,241,296,480                  | public getter             |
| difference                        | 201,560,000,000,000                    | subtraction               |
| the only `Deposited` between them | slot 14, block timestamp 1788136428    | public event              |
| `periodStart` for period 2        | 1788136272                             | public getter             |
| minute of period                  | (1788136428 − 1788136272) / 60 = **2** | arithmetic                |
| multiplier                        | 10080 − 2 = **10078**                  | `PERIOD_MINUTES − minute` |
| **201,560,000,000,000 ÷ 10078**   | **20,000,000,000 = 20,000 cUSDT**      | exact, no remainder       |

The divisor is unique, so there is no ambiguity to hide in: 10077 leaves remainder 6791, 10079 leaves 1596, 10080
leaves 320. Only the true multiplier divides evenly.

- **Severity:** high whenever a period contains few deposits, and exact when it contains one. The ciphertext was never
  broken — a published aggregate and two public timestamps reconstructed the plaintext beside it.
- **Scope:** it recovers deposits made in a period, not balances held across many. A depositor who joined before the
  first draw, or who moves in a busy period, is not separable this way.

**The obvious fix does not work, and it is worth showing why.** The instinct is to publish a _blurred_ total: round up
to some granularity `G`, or add bounded noise, and draw modulo that. Deposits smaller than the blur would vanish, since
two consecutive published figures would no longer differ by exactly one person's weight.

It closes nothing, because the total is published twice. `prizeFor` is a deterministic function of it:

```solidity
prizeFor(total) = total * annualRateBps / RATE_DIVISOR
```

`annualRateBps` and `RATE_DIVISOR` are both public, so the equation inverts. Against the live pool, reading only the
prize and never `draws[].total`:

| Draw | Real total            | Recovered from the prize alone | Error         |
| ---- | --------------------- | ------------------------------ | ------------- |
| 0    | 5,443,965,930,000,000 | 5,443,965,923,472,000          | 0.00065 cUSDT |
| 1    | 9,499,068,241,296,480 | 9,499,068,231,696,000          | 0.00095 cUSDT |
| 2    | 9,700,628,241,296,480 | 9,700,628,231,520,000          | 0.00097 cUSDT |

A thousandth of a token. Blurring `draws[].total` would leave the subtraction intact through the prize, so the change
would cost a redeploy and buy nothing. Anything sponsored is public through `PrizeSponsored` and subtracts out, so that
does not obscure it either. The only case where the prize stops leaking the total is when the reserve is the binding
constraint rather than the formula, which is not normal operation.

**What would actually close it** is decoupling the prize from the total — quantising the prize to a coarse step, say the
nearest hundred tokens, _and_ blurring the total, so neither figure inverts to the other. That is a change to the
product's economics rather than a privacy tweak: it makes the prize no longer exactly the yield the pool earned, which
is the thing the pool exists to award. It is a real option and it is not a small one.

The leak is therefore **open and unmitigated**, not merely unshipped. Recording that plainly is better than recording a
fix that a reader could check in five minutes and find hollow.

### 3.6 The anonymity set is the pool

A winner is one of the depositors, and the number of depositors is public. At fifteen slots that is a one-in-fifteen
set, and the app says so on its face rather than implying better.

This is inherent rather than incidental: slots are public because public slots are what let anyone settle a draw for
anyone, which is what removes the operator from the payout path. The set grows with the pool and cannot be improved by
encryption, only by participation.

- **Severity:** structural, and honest. Confidentiality here protects _amounts and outcomes_, never _participation_.

### 3.7 Displayed odds can exceed 100%, and that is the frozen denominator

Odds are shown as your weight over the total published at the **last** draw, never a live total — §3.2 is why. Your
weight accrues through the period while that denominator does not, so the displayed figure climbs, and every depositor's
figure climbs at once. Summed across the pool they can exceed 100%.

Nothing is inconsistent underneath: at draw time the real shares are computed against the real total and sum to exactly
100%. The drift is an artifact of refusing to publish a live denominator, and the alternative leaks far more — anyone
could divide their own odds into a live total, recover it, and take §3.2 from once a week to once a block.

- **Severity:** none to confidentiality; a presentation cost paid deliberately. Past 100.5% the panel withholds the
  number and says why rather than capping it, since a capped 100% reads as certainty.

### 3.8 What does _not_ leak

Worth stating, because both are common assumptions:

- **Gas does not reveal amounts.** FHE operation cost depends on the _type_ of the ciphertext, not the value inside it.
  Depositing 1 token and 1,000,000 cost the same.
- **Claiming does not reveal winning.** The public prize reserve is decremented at settlement, not at claim, so a
  winner's claim moves no public number. Loser and winner claims are identical on-chain.

---

## 4. Trust assumptions

### 4.1 The Zama protocol

Confidentiality rests on Zama's coprocessor and KMS. If the threshold key-management network were compromised,
ciphertexts could be decrypted. This is the foundational assumption of any FHEVM application and Hushpot does not reduce
it.

### 4.2 The decryption relayer

Settling a draw needs the pool total decrypted off-chain and relayed back. The relayer **cannot lie**:
`FHE.checkSignatures` reverts unless the cleartext genuinely matches the ciphertext. It can only decline to relay, which
stalls a draw but corrupts nothing.

### 4.3 The owner

**Can:** fund the prize reserve, set the yield rate, trigger a draw or a period roll early. Note that funding the
reserve is not an owner power — `sponsorPrize` is open to anyone, and adds to the next prize in full.

**Cannot:** read any balance, influence the die, prevent a withdrawal, or move depositor funds. There is no
owner-withdraw path in the contract.

**Worth naming, and this is the sharpest one:** the owner can end the 30-day claim window early. `startNextPeriod()`
enforces `CLAIM_GRACE` against everybody _except_ the owner, and rolling the period is what closes a claim — a draw is
answerable only while its own period is current. So an owner who rolls early can strand an unclaimed prize.

The exemption exists because a testnet demonstration cannot wait a month to show a second cycle, and it is the same
exemption that lets the owner open a draw before the week is up. The Judge panel disables the roll until every slot has
been swept, but that is a frontend courtesy, not a contract rule — the contract does not check it.

Mitigating it in practice: a keeper sweeps every participant before the roll, so prizes land without anyone having to
remember to claim. Mitigating it properly: enforce "all slots swept" on-chain, or drop the owner exemption once the demo
period is over. **Until then this is a real trust assumption, and the 30-day window is a 30-day window for everyone
except the owner.**

**Also worth naming:** the owner can set the yield rate to zero, which would make prizes zero. It would be visible
immediately — the rate is public — but it is an admin power that a production deployment should put behind a timelock or
governance.

### 4.4 Funds locked by design

Tokens added to the prize reserve can leave only by being won. There is no recovery function, deliberately, so nobody
can pull the pot — and that applies to sponsors too: a sponsorship is a gift, not a stake, and cannot be withdrawn. The
trade is that over-funding is irreversible.

---

## 5. What the in-app verifier proves, and what it cannot

The Draws tab recomputes five things from public state, with no wallet and no trust in our frontend:

1. The receipt matches what the contract actually stores.
2. The die is a real, non-zero ciphertext handle, committed on-chain.
3. The prize equals `total × annualRateBps ÷ (10,000 × 525,600)` plus anything sponsored since the last draw — the
   published formula applied to the published total, not a number anyone chose.
4. The deployed bytecode hashes to what it claims.
5. That bytecode contains none of five plausible winner-getter selectors. Solidity emits every external selector into
   the dispatch table, so a selector that is absent cannot be called: there is no function anyone could use to ask who
   won. This is the one negative claim the whole design rests on, so it is checked rather than asserted.

**It cannot prove who won.** Not because that is concealed, but because nothing computes it.

**It cannot prove the die was unbiased.** That rests on the protocol's generator and the published source, not on any
figure in a receipt.

The Proof tab goes further and _demonstrates_ the boundary: it points the same relayer and the same session key at your
balance and at another depositor's. One opens. One does not.

---

## 6. Not addressed

Honest omissions, with what each would take:

| Gap                                                   | What would close it                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| Yield is an admin-funded reserve, not a live strategy | Route deposits into a yield source and feed the same reserve         |
| Coinbase / Base Account cannot connect                | Drop cross-origin isolation, at the cost of a frozen tab per deposit |
| No timelock on owner functions                        | Governance or a delay on rate changes and draw triggers              |
| Owner can close the claim window early                | Enforce a full sweep on-chain, or drop the exemption                 |
| Slots are never released by a griefer                 | Priced, not prevented — see below                                    |
| Unclaimed prizes are not swept back automatically     | A rollover pass once the claim window closes                         |
| Pool capacity is finite — 16,384 slots                | Priced rather than removed; see §9                                   |
| No formal audit                                       | The reason this document exists                                      |

---

_Last updated 27 August 2026. If something here is wrong, that is a bug — please report it._

## 7. Slot exhaustion

A slot is claimed on the first deposit from an address. Since `exitPool`, a depositor can give theirs back — it is
released at the next period roll and handed to the next newcomer before the tree grows — so ordinary churn no longer
costs the pool anything permanently. That closes the case that actually degrades a live pool: a thousand lifetime
depositors with fifty active ones used to mean a thousand transactions per sweep, forever.

What it does not close is griefing, because an attacker will not volunteer to leave. The deposit that claims it cannot
be checked for size: ERC-7984 clamps a transfer to the sender's balance rather than reverting, so asking to move more
than you hold moves zero and still succeeds. `moved` comes back as a ciphertext, and branching on a ciphertext is
precisely what FHE does not allow — so the contract cannot refuse a deposit that moved nothing.

**Rejecting zero would not fix that either.** A one-wei deposit costs the attacker the same gas, occupies a slot just as
permanently, and is a perfectly legitimate deposit. Any rule that turns away the zero case turns away a real user in the
next breath. Detection is not the lever.

So for the adversarial case what is left is capacity. `LEAF_COUNT` is 16,384. Filling it requires 16,384 separate
addresses, each funded with gas and each sending its own ~500k-gas confidential deposit — on the order of eight billion
gas, roughly half a million dollars at mainnet prices, and that buys nothing except a full pool. Legitimate depositors
pay nothing for the headroom: `_treeRoot()` keeps the tree only as deep as the slots actually in use, so a
thirteen-person pool walks four levels at 16,384 exactly as it did at 1,024.

**This prices the attack rather than eliminating it, and the distinction matters.** A reclamation path would eliminate
it, but every version we could design requires proving a slot is empty, and proving that means publicly decrypting a
balance that might not be — which trades a capacity bug for a privacy one. We would rather have the capacity bug and say
so.
