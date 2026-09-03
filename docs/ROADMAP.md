# Hushpot — Roadmap

What is not built, why each thing is harder than it looks, and what it would cost.

This is deliberately specific. A roadmap of feature names is a wish list; the useful version names the constraint each
feature runs into, because in a confidential system the constraint is usually the design. Almost everything below is
measured against the two walls in [`HOW-IT-WORKS.md`](HOW-IT-WORKS.md#two-walls-and-where-they-are) — encrypted
**depth** per transaction, and who pays the **incidence** cost of `n` claims a draw. Most of these ideas are cheap on
one and expensive on the other.

> This file used to be the build schedule for the 5 September submission. That schedule has been run and the phases are
> shipped, so what it recorded — dated checkboxes and week-by-week risk — is in git history rather than here. What
> survives is the part that was always forward-looking: the features held back, and the reasoning for holding them.

---

## Prize tiers — several winners in one draw

The single biggest UX gap. Winner-take-all means almost nobody ever wins, and a pool where nothing visibly happens is a
dull pool. PoolTogether V5 pays `4^t` prizes per tier — one grand prize down to many small ones — plus two canary tiers
that raise or lower the tier count according to whether they get claimed, which tunes prize size to live gas costs.

**The blocker is cost, not design.** Each tier adds another range comparison and `FHE.select` to every claim, and a
single-tier claim already measures ~2.4M gas on Sepolia, with five batched together reverting on the HCU ceiling. So
tiers need the per-claim HCU measured before any of it is committed to: if one tier is 2.4M, four tiers is not obviously
affordable.

The draw side is the easy half — `FHE.randEuint64` rolled per prize, each point reduced into the same published total.
The claim side is where the ceiling sits, and the claim is the transaction that has to stay flat, because it is the one
every depositor pays for themselves.

**What still needs deciding:** whether one slot may win twice in a draw. Preventing it means comparing a winning slot
against the other winners on ciphertext and re-rolling — an unbounded loop over encrypted values, which is exactly the
shape FHE will not give you. Allowing it is cheap and honest, and on any pool past a handful of depositors it is rare.

---

## A loyalty boost that does not lock the stake

The boost works and its arithmetic is right — `streakOf` is `currentPeriod − slotAssignedAt − 1`, capped at four — but
two things about it are worse than they need to be.

It **commits the stake until the roll**, because boost-then-withdraw would otherwise buy a full period of odds and hand
the capital straight back. That is a real constraint rather than laziness, but it makes the most rewarding action also
the most restrictive one, which is backwards. A partial lock, holding only the boosted portion rather than the whole
balance, would keep the exploit closed and leave the rest liquid.

It is also **opt-in and expires every period**, so it must be claimed again each week or it is silently lost. Applying
it to everyone at the roll is an O(n) encrypted pass — the incidence wall again — so "just do it automatically" is not
available. The plausible version folds the boost in lazily on the depositor's next interaction, the same trick
`_parkAward` already uses to avoid repairing ten ancestor sums for an encrypted zero.

---

## More than one pool

Every pool is already a standalone contract with its own depositors, reserve and schedule — the judge sandbox is the
existence proof, running the same bytecode under a different owner. What is missing is a factory and a registry, so
pools can be listed and joined without an address hardcoded in the frontend.

The interesting variants are not technical:

- **A monthly pot** — same code, longer period, larger and rarer prizes. `PERIOD_SECONDS` is a `constant` today, so it
  would have to become an immutable constructor argument. That is a small change which then invalidates every fixed
  `10080` in the weighting math, so it is not a one-liner.
- **Irregular draws** — a pot that settles on an unannounced day. Time-weighting already makes late deposits nearly
  worthless, so an unpredictable close creates no new exploit. It does complicate the claim window, which is measured in
  wall-clock time from the draw's own `settledAt`.
- **A high-variance pool beside a low-variance one**, so a depositor can choose between frequent small wins and rare
  large ones without leaving the protocol.

---

## Ownership to a multisig behind a timelock

One key can set the yield rate to zero and roll the period. This is the sharpest remaining trust assumption and the
cheapest to retire: `Ownable.transferOwnership` makes the move a single transaction, and the work is standing up the
Safe and the delay rather than changing the contract. See [§4.3](THREAT-MODEL.md#43-the-owner), which treats the owner
as a trust assumption rather than a feature.

---

## Real yield, replacing the funded reserve

`fundPrizeReserve` becomes a harvest step: route idle deposits into a lending market and credit realised yield to the
same reserve. The draw, the claim, the weighting and the accounting are untouched, because they only ever read
`prizeReserve`.

What changes is the two properties this pool actually sells. `proveSolvency` compares tokens held against tokens owed,
and principal lent out is not held — so the proof has to count the strategy's position and start trusting its accounting
for the part no longer in hand. And withdrawal is instant today only because the money is sitting in the contract; any
real source has to redeem on demand or carry a liquidity buffer sized to normal outflow. That is why it is a mock here
rather than an integration: the interface is a morning's work and these two questions are the actual product. See
[the yield section](HOW-IT-WORKS.md#how-a-real-yield-source-would-plug-in).

---

## Closing §3.5

The composed leak in [`THREAT-MODEL.md`](THREAT-MODEL.md#35-32-and-33-compose-and-together-they-are-exact) — published
draw totals differenced against a public deposit timestamp — is open, and documented as open. The design that closes it
is known: stop publishing the total and reduce the draw point with an encrypted modulo instead. FHEVM does not offer a
cheap one, which is why the total is published in the first place. This is the largest outstanding item in the protocol,
and it is a protocol change rather than a feature.

---

## Prize history that survives the browser

The odds sparkline lives in memory for the life of the page, because writing it to disk would store a plaintext
derivative of an encrypted balance — read the file, divide by the published total, and the position falls out without
any key. That is the right call, and it makes the feature nearly useless, since a reload loses it. The honest fix is an
encrypted client-side store keyed by the same session key that decrypts balances, so the series is as protected as the
thing it derives from.

---

## Encryption in a dedicated worker

FHE encryption currently runs on threads unlocked by cross-origin isolation, which costs the Coinbase / Base Account
connector — its popup flow needs the `window.opener` channel that isolation severs. Moving the encryption into a worker
we own would free the headers and restore that wallet.

---

## Considered and rejected

**Confidential delegation.** PoolTogether lets you delegate your odds to another address while keeping your principal,
and encrypting the delegated weight looked like a genuinely new primitive. It is not safe here: delegating means a
transaction from your address touching someone else's slot, so even with the amount encrypted the transaction itself is
a public edge between two people. That ships a social graph inside a product whose entire claim is that it leaks
nothing. Hiding the target as well is possible and costs more than the feature is worth.

**A leaderboard, or any "top depositors" view.** Not a missing feature — an impossible one, and the product is better
for it.

**Naming winners, even opt-in.** A winner can already prove it themselves from their own receipt. A path for the
_contract_ to publish it would rebuild exactly the surface this design exists to remove.

**Enforcing a sweep on-chain before the period may roll.** Built, then removed. It reads as safety and is the incidence
wall wearing a hat: it makes the cycle depend on an O(n) sweep somebody has to fund, so a pool nobody sweeps degrades to
monthly and forfeits the stragglers anyway. What shipped instead is five generations of tree history, so a claim
outlives its period and the roll costs nobody anything. See
[A claim outlives its period](HOW-IT-WORKS.md#a-claim-outlives-its-period).

**Snapshotting the bands at settlement.** Shipped as something better. `_checkWin` derives each band from the live tree,
which is safe only while weights cannot move — and an owner opening a draw early with `--force` broke that, since
deposits made afterwards still shifted bands against a committed die. Rather than store the root and every prefix per
draw, `minuteOfPeriod` now saturates the moment a draw is pending, so the cancellation is tied to whether a draw exists
rather than to whether the clock happened to run out. Same guarantee, no per-draw storage.
