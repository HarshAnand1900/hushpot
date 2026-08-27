# Hushpot — Threat Model

What is encrypted, what is public, what leaks, and what you have to trust.

This document is deliberately unflattering. A confidential system that only advertises its strengths is harder to
evaluate than one that names its edges, and every claim below can be checked against the deployed contract.

**Contract:** `HushpotPool` · Sepolia · `0xFc07aA77FCAEd9759a330d138eb6F942Ecb337b3`

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

**A self-check followed by a sweep credited twice — fixed.** `sweepRange` did not skip slots already settled by
`checkClaim`, so a winner could be paid the prize twice out of a reserve that had only set one aside. `sweepRange` now
skips already-checked slots — after advancing the running band edge, which matters: returning early without advancing
would shift every subsequent band and pick the wrong winner.

**The confidential deposit route was unreachable — fixed.** The contract has always had
`deposit(externalEuint64, proof)`, but the app only ever called `depositUnderlying`, whose amount is public. The faucet
handed out plain tokens only, so a newcomer could not use the private path at all. The faucet now shields on request,
and the confidential route is the default.

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

| Value                                           | Why                                                    |
| ----------------------------------------------- | ------------------------------------------------------ |
| That an address deposited or withdrew, and when | Inherent to a public chain. Transactions are visible.  |
| Which slot an address holds                     | A plain mapping. Reveals participation, never amount.  |
| The pool total, once per draw                   | Needed to reduce the draw point into the pool's range. |
| The prize each draw paid                        | Not anybody's balance.                                 |
| Number of depositors                            | Aggregate.                                             |
| That a slot was checked for a draw              | Reveals a check happened, never its outcome.           |
| Period schedule, yield rate, prize reserve      | Protocol parameters.                                   |
| All contract code                               | The selection rule should be readable.                 |

**Participation is public; position is not.** Anyone can see that you are in the pool. Nobody can see what you have in
it.

---

## 3. Known leaks

### 3.1 Depositing plain tokens publishes that deposit's size

`depositUnderlying()` accepts an ordinary ERC-20, which means the amount travels in a public `transferFrom`. **That
deposit's size is visible to anyone.** Everything afterwards — your position, your odds, your winnings — is encrypted,
but the entry itself is not.

- **Severity:** high for that single deposit, none thereafter.
- **Avoid it:** hold cUSDT and use `deposit()`, where the amount is encrypted before it leaves your wallet.
- **Or decouple it:** shield tokens at one time and deposit at another. The two are then unlinkable by size or timing.
- **Why we ship it anyway:** requiring users to wrap manually before depositing is a real barrier, and Zama's own
  Steakhouse vault makes the same trade. The interface says so plainly rather than burying it.

### 3.2 The pool total is published at each draw

The draw point must be reduced modulo the pool's total, and encrypted modulo requires a plain divisor — so the total is
decrypted once per draw and relayed back with a proof.

The difference between two consecutive totals equals the **sum of that period's net activity**. With many depositors
this reveals nothing about any individual. With few, it narrows sharply. **With a single depositor it is exact.**

- **Severity:** scales inversely with pool size. Genuinely weak on a small testnet pool.
- **Mitigation:** publish only at draw boundaries, never continuously. A live total would leak every deposit by
  subtraction.
- **Consequence honoured in the UI:** the odds display divides by the total published at the _last_ draw, never a live
  one. A live denominator would let anyone recover the running total by dividing their own odds into it.

### 3.3 The time factor applied to a deposit is public

Odds are weighted by amount × time held, and the minute a deposit landed is a public block timestamp. So the
_multiplier_ is known. The amount is not, so the product is not.

- **Severity:** low. Reveals when you acted, which the transaction already did.

### 3.4 Concentration in a small pool

A depositor holding most of a small pool has most of the odds. Over many draws, an observer who could correlate payouts
with balances might infer something — though since winners are never resolved on-chain, they would have no payouts to
correlate.

- **Severity:** low today, and largely theoretical while winners stay unresolved.
- **Possible mitigation, not implemented:** cap any single depositor's odds with `FHE.min`. This would clamp odds only,
  never principal, so the no-loss guarantee is untouched.

### 3.5 What does _not_ leak

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

## 9. Slot exhaustion

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
