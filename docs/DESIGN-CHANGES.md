# Hushpot — Design Changes Since the First Mockup

Everything here is a change to make in the UI. Grouped by how much rework each one implies.

---

## 1. Must change — currently wrong on screen

### `WINNER HIDES AMONG 32 ADDRESSES` → delete

That number came from an architecture we abandoned. The winner is now hidden among
**every depositor in the pool**, not a group of 32.

**Replace with:** the live depositor count — `WINNER HIDES AMONG 1,284 DEPOSITORS`.
The count is public (we know how many slots are taken, just not what's in them), it's
honest, and it grows as the product succeeds. Strictly a better number than 32.

### `TOTAL POOLED` → keep, but label it as a snapshot

Stays on screen. But it must read as a figure captured at the last draw, **not** a live
ticking counter.

**Copy:** `POOLED AT DRAW #17` rather than `TOTAL POOLED`.

Why: the total is published once per draw. If it ticked live, subtracting one reading
from the next would expose individual deposits. Publishing it only at draw boundaries
means each change covers a whole week of activity at once.

Design opportunity: let this figure visibly **step** when a draw settles, rather than
drift. A number that jumps once a week tells the user something true about the system.

### The prize pot — keep it live and animating

The big hero number is fine ticking in real time. It's accrued yield, derived entirely
from public figures, so animating it exposes nothing. It's the best thing on the page.

---

## 2. Must change — the deposit story is now different (and better)

Previously the rule was "your deposit joins the next draw." **That's gone.**

**Deposits now start earning odds the minute they land**, proportional to how long they
sit there. Put money in on Wednesday and you earn roughly half the odds of someone who
was there since Sunday with the same amount.

This kills the old "you have to wait" copy everywhere, and replaces it with something far
better to sell:

> **Your deposit starts working the moment it arrives.**

### New UI element worth building: "how long your money has been working"

Since time now directly drives odds, show it. Something like:

```
YOUR DEPOSIT HAS BEEN EARNING FOR   3d 14h 22m
```

It makes an invisible mechanic visible, it rewards people for leaving money in, and it
gives a reason to come back and look. Nothing else in the field will have this.

### Odds now shift during the week

A design decision for you: someone who deposits mid-week starts with a small share that
grows relative to others as their money accrues time. So "your odds" is not a fixed
number for the week.

Two options — pick whichever reads better:
- **Live odds** — what your share is right now, rising as your deposit accrues time
- **Projected odds** — what your share will be at the draw, assuming nobody else moves

I'd lean live, with the projection as secondary, because a number that climbs while you
watch is a much better feeling than a static one.

---

## 3. Must change — where the randomness comes from

The draw no longer uses an external randomness oracle. It uses **the network's own
encrypted random number generator**, on-chain, in a single transaction.

This matters for copy and for the Draw Explorer, because the old "here's the oracle proof"
framing doesn't apply. What we can show instead:

- The block the encrypted dice was rolled in
- The fixed identifier of that dice value — committed on-chain, unreadable by anyone
- The committed state of everyone's deposits at that moment
- The contract code that combined them

The line to sell: **nobody could steer it, including us — and nobody can read it,
including the contract.**

The Draw Explorer is less of a step-by-step animation now and more of a receipt. Fewer
moving parts to visualise, but a stronger claim.

---

## 4. Unchanged — still true from the original brief

- No leaderboard, no participant list, no "recent depositors by size." Impossible.
- Every private number costs a signature to reveal. Needs a deliberate reveal control, an
  honest loading state, and a session cache so it's once per visit.
- Nobody is told they won. Winning is a pull, not a push.
- Most visits end in "not this time" — the losing state needs as much care as the win.
- Deposits accept plain USDT *or* confidential cUSDT; the app shields invisibly. The user
  never meets the word "wrap."
- Winners may **opt in** to revealing themselves, so draw history can show a mix of named
  and anonymous winners. That mix is itself proof the privacy is real.
- Withdraw anytime, in full, no penalty. The no-loss promise must feel unrestricted.

---

## 5. A hard UI requirement discovered while building

**The deposit screen must check the balance before submitting.**

A confidential token transfer that exceeds the sender's balance does not fail — it
silently moves nothing. So a user who tries to deposit more than they hold gets: gas
spent, no tokens moved, no error message, no explanation. The transaction *succeeds*.

There is no contract-level fix for this; refusing it would require comparing encrypted
values and reverting, which is impossible. So the interface has to catch it:

- Disable the deposit button when the amount exceeds the wallet balance
- Show the shortfall inline rather than after the fact
- A max button, so the common case never involves typing a number at all

This is the guidelines' named "insufficient balance" error case, and it's one of the four
they explicitly score. Cheap marks, and a genuinely confusing failure if skipped.

---

## 6. Copy corrections against the shipped contract

The v5 design bundle claims a few things the contract doesn't do. These are small edits,
but they sit under a **Correctness** judging criterion, and overclaiming is the single
easiest way to lose credibility with a technical reviewer. Corrected values below are
authoritative — build from these, not from the bundle.

| Design says | Contract actually does | Use instead |
|---|---|---|
| `TRANSACTIONS PER DRAW — 1` | `openDraw` then `settleDraw`, plus a claim sweep | `TRANSACTIONS PER DRAW — 2` |
| "One transaction closes the week" | One *round*, two transactions | "One round closes the week" |
| "No oracle" | True of the randomness. The total is decrypted off-chain and relayed back with a proof | "No randomness oracle — the network rolls the die itself" |
| `odds = balance ÷ pool` | Ticket-minutes ÷ pool ticket-minutes | Time-weighted, see below |
| `projected = (balance+add) ÷ (pool+add)` | A mid-week deposit earns only the time remaining | Scale `add` by remaining time |
| `CLAIM WINDOW — 4d` | Runs until the next period opens | `CLAIM WINDOW — 30 days` |
| `APY 4.10%` | `annualRateBps = 500` | `5.00%`, or set the contract to 410 |
| Faucet "once per hour" | The underlying's `mint` is unrestricted | Drop the rate-limit line |
| `Hushpot.sol` | `HushpotPool.sol` | Rename in the Proof tab |

### The draw engine's three cells are right — just relabel them

They map onto the real flow almost exactly:

| Cell | Real step |
|---|---|
| `COMMITMENT` | `openDraw` — seals the pool total and publishes it for decryption |
| `ENCRYPTED DIE` | `settleDraw` — `FHE.randEuint64` rolls on-chain, in that transaction |
| `SETTLEMENT` | the claim sweep — `FHE.select` moves the pot, branchlessly |

The honest footer is barely less impressive than the original:

> One round closes the week: the pool is sealed, the network rolls an encrypted die, and
> the pot moves without resolving a name.

### On "no oracle" — worth stating precisely rather than dropping

It's true where it counts: nobody supplies the randomness, and no off-chain party can
influence it. There *is* a decryption relay for the pool total, but that relay **cannot
lie** — `checkSignatures` reverts unless the cleartext matches the ciphertext, so a relayer
can only refuse to act, never forge. Said precisely, that's a stronger claim than "no
oracle", because it survives someone checking.

### Odds are time-weighted, which changes the simulator

The "odds after" projection can't be `(balance + add) ÷ (pool + add)` — a deposit made
mid-week earns only the minutes left in the period. The projection needs:

```
addedWeight     = add × minutesRemaining
projectedOdds   = (yourWeight + addedWeight) ÷ (poolWeight + addedWeight)
```

Which produces a genuinely nice UI truth: **the same deposit buys fewer odds later in the
week.** Worth surfacing rather than hiding — it rewards depositing early, which is exactly
the behaviour the mechanism is designed to encourage.

---

## 7. New mechanics that need a home in the UI

### The claim window
> **Superseded.** The claim window is now 30 days (`CLAIM_GRACE`), enforced by holding the
> period roll back rather than by any per-draw bookkeeping. Weights freeze on their own when
> a period ends, so the roll is the only thing that can end a claim — which makes a long
> window free. Unclaimed prizes are not rolled over; a sweep before the roll is what ensures
> they are delivered. The paragraph below records the original design.

A prize must be claimed within a week. Unclaimed, it rolls into the next draw and makes
that pot bigger. Needs a countdown on the "did I win?" surface, and a note in draw history
when a pot was a rollover.

### Auto-enrollment
Deposit once and you're in every draw until you withdraw. Worth stating once on the
deposit screen so nobody hunts for a "re-enter" button that doesn't exist.

### Rollover in draw history
Rows should distinguish a normal pot from one swollen by an unclaimed prize — a rollover
is a good story, not an apology.

---

## 6. Copy tweak on the hero

`Nobody ever finds out who` is now slightly untrue, since winners can choose to reveal.

Suggested:

> **One depositor takes all of it.**
> **Nobody finds out who — unless they say so.**

More intriguing, and it plants the disclosure mechanic on the landing page.

---

## Quick reference — what's public vs private

| Value | Who can see it |
|---|---|
| Prize pot for this draw | Everyone |
| Pool total at last draw | Everyone (snapshot, not live) |
| Number of depositors | Everyone |
| Draw schedule, countdown | Everyone |
| Your deposit and balance | Only you, after signing |
| Your odds | Only you |
| Your winnings | Only you |
| Anyone else's balance | Nobody |
| Who won | Nobody, unless they choose to reveal |
| The dice roll itself | Nobody, ever — not even the contract |
