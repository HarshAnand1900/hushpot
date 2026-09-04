# Hushpot — documentation

Six documents, each with one job. Start wherever your question sits.

| If you want to know…                                             | Read                                 |
| ---------------------------------------------------------------- | ------------------------------------ |
| The pitch, the live numbers, how to run it                       | [`../README.md`](../README.md)       |
| The draw mechanics — selection, claiming, confidentiality, yield | [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md) |
| What is encrypted, what leaks, and what you have to trust        | [`THREAT-MODEL.md`](THREAT-MODEL.md) |
| Why the product is shaped this way, and who it is for            | [`BRIEF.md`](BRIEF.md)               |
| What is deliberately not built yet, and why                      | [`ROADMAP.md`](ROADMAP.md)           |
| How the protocol is run, and by whom                             | [`OPERATING.md`](OPERATING.md)       |

## The short version

Everyone deposits into a shared pool. The pool earns yield. Once a week the entire yield goes to one depositor at
random, weighted by how much they put in and how long they left it. Principal is never at stake — every deposit
withdraws in full.

What is new is that the amounts are encrypted end to end. Balances, odds, the prize, and the die that decides it are all
`euint64` ciphertext under Zama's FHEVM. The contract adds and compares them without ever holding a key that could open
them.

## The three things worth understanding

**Odds are time-weighted, and the tree is why.** Your weight is balance × minutes held, so a large deposit made an hour
before the draw cannot beat a small one held all week. Those weights are summed in an encrypted segment tree, which is
what makes "find the one slot whose band contains the die" cost a walk rather than a scan of every depositor.

That rewards depositing early in the week and, on its own, said nothing about staying past the week you arrived in —
week fifty looked exactly like week one. `boostStreak` adds five percent of a full stake's ticket-minutes per period
held, four deep, so money left alone for a month carries 1.20× the weight of the same amount deposited this morning —
deliberately modest, a nudge on top of balance and timing rather than a second axis competing with them. It is opt-in
and self-funded, so it stays O(1) per depositor instead of becoming another pass over everybody at the roll, and it
expires with the period, so a streak means continuous holding rather than a number that keeps climbing after the money
has gone. Taking it commits the stake until the period ends; without that, boost-then-withdraw would buy a full period
of odds and hand the capital straight back.

The period a slot is assigned in never counts toward the streak, and the boost multiplies only the balance that was
actually present for as long as the streak claims — not whatever the slot holds right now. Both close real gaps:
counting from the join period alone would credit a last-minute depositor identically to a full-week holder one minute
later; multiplying the live balance would let a slot held open with a trivial stake for a month take on a large fresh
deposit moments before boosting and hand the whole thing an unearned multiplier. See
[Staying is worth more than arriving](HOW-IT-WORKS.md#staying-is-worth-more-than-arriving) for the mechanism.

**Nothing branches on a ciphertext, ever.** FHE does not allow it, and a branch would leak which way it went through gas
and state. Settlement is a branchless `FHE.select` over every slot: a loser is credited an encrypted zero that is
indistinguishable on-chain from a winner's prize, down to the gas.

**There is no winner field.** Not hidden — absent. The contract never computes who won, so there is nothing in storage
to leak, subpoena, or accidentally log. The only way to find out is to open your own balance with your own key and see
whether it moved. The Draws tab proves this by searching the deployed bytecode for winner-getter selectors and finding
none.

## Known trust assumptions

Stated plainly rather than buried, and covered in full in [`THREAT-MODEL.md`](THREAT-MODEL.md):

- The **owner can roll a period early**, because the grace check exempts them. It used to be the sharpest assumption
  here, since a claim died with its period — the tree now keeps five generations of history and the window is thirty
  days of wall-clock time, so rolling early strands nothing. `startNextPeriod` will not roll past a draw still inside
  its grace, so what is left is only the clock.
- **A griefer's slots cannot be reclaimed.** A depositor can give their own slot back with `exitPool`, but nobody can
  take one from an attacker — that case is priced rather than prevented. See [§7](THREAT-MODEL.md#7-slot-exhaustion).
- **Acquiring cUSDT publishes that amount**, because wrapping plain tUSDT is an ordinary ERC-20 transfer. It happens at
  the faucet, decoupled from any deposit. The contract's public `depositUnderlying` route is not wired to anything in
  the app — see [§3.1](THREAT-MODEL.md#31-acquiring-cusdt-publishes-that-amount).
- **Yield is funded from a reserve**, not a live strategy. On mainnet the same reserve would be fed by real yield.
- **Ownership is a single key**, not a multisig, and the contract is not upgradeable — see
  [Operating the protocol](OPERATING.md).
