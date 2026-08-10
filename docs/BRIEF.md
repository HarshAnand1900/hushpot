# Hushpot — Product & Design Brief

**Zama Developer Program · Season 4 Bounty · due 5 September 2026**

> Save together, win the interest, never risk the principal — and no one ever sees
> how much you put in, or who walked away with the pot.

---

## The product in one paragraph

Everyone deposits into a shared pool. The pool earns yield. Instead of dribbling that
interest back to each depositor, it's bundled into a single prize and awarded to one
depositor at random — with odds proportional to what you put in and how long you left
it. You can withdraw your deposit at any time, in full. Nobody loses anything; the only
thing at stake is the interest.

That much already exists. What doesn't exist is a version where **the amounts are
encrypted end to end** — deposits, balances, each person's odds, and the prize itself —
while the draw remains something any stranger can verify was fair.

---

## How a depositor experiences it

1. **Deposit.** Move confidential tokens into the pool. The amount is encrypted the
   moment it leaves the wallet — the contract itself never learns it.

2. **Wait for the next draw to open.** Deposits start earning odds at the next draw
   boundary, not instantly. This is what makes it impossible to borrow a fortune, buy
   odds for one second, and give it back.

3. **Watch the pot grow.** Yield accumulates into a prize. The pot total is public —
   it's the one number everybody is allowed to see.

4. **The draw runs.** Public randomness picks a point somewhere along the pool's total.
   Whoever's share contains that point has won — but the contract doesn't compute who
   that is, and nobody announces it. The only value made public is the pool total, which
   we publish anyway.

5. **Find out privately.** The prize lands encrypted in someone's balance. There is no
   announcement. You check your own balance to find out whether it was you.

---

## The privacy model — read this before designing anything

Every number in this product sits in exactly one of three states. This is the single
most important constraint on the interface: it decides what can appear on a screen at
all, and for whom.

| State | Meaning |
| --- | --- |
| **Public** | On-chain and readable by anyone. Safe to show to a disconnected visitor. |
| **Yours only** | Encrypted. Only the owner can decrypt it — and only by signing. Costs a round trip. |
| **Nobody** | Encrypted with no one holding the key. Not hidden by policy — unknowable by construction. |

| Value | Visibility | Consequence for the UI |
| --- | --- | --- |
| Prize pot (per draw) | Public | The hero number. The only figure a logged-out visitor can be shown. |
| Total pool size **at last draw** | Public | Needed to compute odds. **Snapshot only — never live.** See below. |
| Draw schedule & randomness | Public | Countdown, and the raw material for the verification view. |
| Your deposit & balance | Yours only | Cannot render until the user signs. Needs a deliberate reveal control. |
| Your odds of winning | Yours only | Computed in the browser from one public number and one private one. |
| Your winnings | Yours only | Arrives silently. Discovered, never announced. |
| Anyone else's balance | Nobody | No participant list. No leaderboard. Not a missing feature — impossible. |
| Who won | Nobody | Not narrowed to a group. Not known to the contract, or to us. |
| Remaining unclaimed prize | Nobody | Must stay encrypted, or a ticking counter would expose the winner. |

### The total pool figure cannot tick

This one is easy to get wrong and expensive to fix later. Encrypting an amount does not
hide it if some *public* number moves by exactly that amount straight afterwards. We
publish the pool total at each draw, so if only one person deposits between two draws,
the difference between those two totals *is* their balance — exactly, in the clear.

The defence is that deposits activate together at draw boundaries, so they aggregate
into a single public change. That only works under one rule: **the total is published at
draw boundaries and at no other time.** A live-updating "total pooled" counter would leak
every individual deposit by subtraction and quietly defeat the entire design.

So: show *"pool at last draw"*, framed as a snapshot. Never a ticking number.

---

## Design constraints unique to this product

These are the things that will trip up a conventional DeFi layout. Worth solving
deliberately rather than discovering late.

### There is no leaderboard, and there never can be

Every genre convention — recent winners, top depositors, a participant feed, "23 people
joined today" — is cryptographically unavailable. A normal prize-savings UI is largely
built out of other people's numbers, and we have none of them. What fills that space
instead: the pot, the countdown, the user's own private position, and whatever past
winners chose to reveal about themselves. This is the central design problem, and
getting it right is most of what separates this from every other submission.

### Every private number costs a signature

Decrypting your own balance means signing a typed message and waiting on a round trip —
seconds, not milliseconds. Private values therefore cannot simply "be on screen." They
need a reveal affordance, an honest loading state, and a session cache so the user signs
once per visit rather than once per glance. Handled carelessly this feels broken;
handled well it feels like unlocking something.

### Nobody is told they won

Winning is a pull, not a push. There is no confetti moment we can trigger, because the
app genuinely does not know who to congratulate. The interface has to make "go check"
feel like anticipation rather than a chore — and make the reveal itself land. This is
the most novel interaction in the whole product and deserves the most attention.

### A deposit has two states

Deposited but not yet earning odds, versus active. Users will be confused if this isn't
obvious at a glance, and will assume something broke. Needs to read as a scheduled
activation, not a pending transaction.

### The draw is a slow, visible process

It takes several transactions over minutes, descending one level at a time. That's a
constraint, but also a gift — it's a live process worth watching rather than a spinner.
Design it as something unfolding.

---

## Screens to design

### Landing · *public*
For someone who has never heard of prize savings. Must land two ideas fast: you cannot
lose your deposit, and nobody can see your money.
- Live pot figure as the hook
- The no-loss promise, stated plainly
- Countdown to the next draw

### Pool · *public + yours only*
The home screen once connected. Everything public sits up top; the user's own encrypted
position sits below, behind a reveal.
- Prize pot, total pooled, countdown
- Your position: balance, odds, pending vs active
- Deposit / withdraw entry points

### Deposit
Accepts **either** plain USDT **or** confidential cUSDT — if the user brings plain
tokens, the app shields them invisibly rather than making them go and wrap first. This
is lifted straight from Steakhouse's vault and it's the single highest-leverage UX
decision here: it collapses a fiddly multi-step ritual into one action, which is exactly
what won 2nd place in Season 3.
- Amount, balance, max — with the token type handled for them, not asked about
- "Starts earning odds at the next draw" — stated up front, before confirming
- Honest multi-step transaction progress (shielding and depositing are separate steps)

### Withdraw
The no-loss promise made real. Should feel unrestricted — no penalties, no lockups, no
dark patterns discouraging it.
- Amount, max
- Clear note that odds drop immediately

### Your odds · *yours only*
The signature moment of the product. A number that is genuinely uncomputable by anyone
else alive — not by other players, not by us, not by the contract owner.
- Your share, as a percentage
- Framed so the privacy is felt, not just stated
- The reveal interaction carries this screen

### Draw history · *public*
Past draws, with prize sizes and dates — but no winner names, ever, unless a winner
chose to say so. The absence should read as intentional and confident.
- Pot awarded, date, whether the prize was claimed or rolled over
- Any winners who opted to reveal themselves
- Link through to verification

### Draw explorer · *public*
Lets a sceptic confirm a draw was fair. The strongest possible answer to "verifiable
on-chain," and the best shot in the demo video.
- The random seed and its proof — nobody, including us, could have steered it
- The pool total it was reduced against, and the resulting draw point
- The point being: every published value here is an aggregate. Not one is a person.

### Did I win? · *yours only*
The reveal. Most visits end in "not this time" — so the losing state has to be gracious
and pull the user back toward the next draw.
- A reveal worth performing
- A losing state that isn't deflating
- A winning state worth screenshotting

### Faucet · *public*
Test tokens, since this runs on a testnet. Minor screen, but judges will use it first —
it's their first impression of the build quality.

---

## Additions worth building

Beyond the brief's requirements — roughly in order of how much they'd move the needle.

**Highest value**

- **Deposits that shield themselves.** Accept plain USDT and wrap it invisibly. Users
  never learn the word "wrap." Steakhouse does this; almost no bounty submission will.
- **Verification anyone can follow.** The draw explorer, written for a sceptic rather
  than a cryptographer. Most submissions will claim verifiability; showing it is the
  differentiator.
- **Opt-in winner disclosure.** A winner can voluntarily publish proof that they won.
  Private by default, bragging by choice. This buys back the social proof that hidden
  winners would otherwise cost us — "someone really won this" is what makes people
  deposit — without exposing anyone against their will.

**Cheap, high signal**

- **Sponsored prizes.** Let anyone add to the pot while taking zero odds themselves.
  Roughly twenty lines, and it signals that we studied the real protocol.
- **Winnings compound.** A prize lands in your balance and quietly improves your odds
  next time. Reinforces the core loop at almost no cost.

**Polish**

- **Live draw view.** Watch the descent narrow in real time as each step lands on-chain.
  Turns an awkward multi-minute process into the best thing on the site.
- **Session-cached reveals.** Sign once, then private values stay readable for the
  visit. The difference between "clunky crypto app" and "product."

---

## Where it stands

The weighted-selection engine is built and proven — a segment tree with an exhaustive
test confirming that every participant is selected exactly in proportion to their share,
with no rounding and no off-by-one. It runs in plaintext today; encrypting it is the next
step, and the structure is designed so that only a single bit per level is ever revealed,
never an amount.

Which means the interface is genuinely on the critical path now, not downstream of it.
The mechanism is the part nobody else will get right; the interface is the part that
decides whether the judges notice.

---

*Hushpot · confidential no-loss prize savings · targeting Sepolia · brief prepared 5 August 2026*
