# Hushpot

**A no-loss prize pool where nobody — including the contract — learns who won.**

Deposit a confidential token. Keep your principal, withdrawable in full at any time. The yield the pool generates is
awarded to one depositor each week, weighted by how much they deposited and how long they left it. Balances, odds and
winnings are encrypted end to end, and the draw is still something a stranger can verify.

Built for the Zama Developer Program, Mainnet Season 4.

- **Live app:** <https://hushpot-fhevm.vercel.app>
- **Contract:**
  [`0xCFe1Fb2F5f0f00e9f45b4E7316f333b7a7926330`](https://sepolia.etherscan.io/address/0xCFe1Fb2F5f0f00e9f45b4E7316f333b7a7926330)
  (Sepolia) — [verified source](https://sepolia.etherscan.io/address/0xCFe1Fb2F5f0f00e9f45b4E7316f333b7a7926330#code).
  The address in [`web/src/lib/contract.ts`](web/src/lib/contract.ts) is always the live one
- **Judge panel:** [`/judge`](https://hushpot-fhevm.vercel.app/judge) — run a whole draw cycle from the browser, no
  terminal
- **Token:** Zama's official `cUSDTMock` —
  [`0x4E7B…4491`](https://sepolia.etherscan.io/address/0x4E7B06D78965594eB5EF5414c357ca21E1554491)
- **Faucet:** the underlying
  [`USDTMock`](https://sepolia.etherscan.io/address/0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0) has an open `mint`, so
  anyone can self-serve
- **Threat model:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — what leaks, and when

---

## The idea in one paragraph

Everyone deposits into a shared pool. The pool earns yield. Rather than dribbling that interest back to each depositor,
it is bundled into a single weekly prize and awarded at random, with odds proportional to what you contributed and how
long it sat there. Nobody can lose: a draw never touches principal, only yield. What does not exist yet is a version
where the amounts stay encrypted — and where the winner is never resolved on-chain at all.

---

## How the draw works

The interesting problem is picking a winner with odds proportional to a **secret** balance, without decrypting anyone's
position, in a way that stays verifiable.

### Weighting

Odds come from **ticket-minutes**: your balance multiplied by the minutes you held it this period. Deposit halfway
through the week and you earn half the odds of someone who was there the whole week with the same amount. This closes
the obvious exploit — depositing a fortune moments before the draw buys almost nothing.

Tracking that naively is unusable on-chain: every user has their own last-changed timestamp, so totalling the pool would
mean visiting all of them. The fix is algebraic:

```
balance × (drawTime − lastChange)  =  balance × drawTime  −  balance × lastChange
```

The right-hand term carries no draw time, so it can be computed the moment someone deposits and folded into a running
total. The left multiplies a figure identical for everyone, so it factors out against the sum of balances. The whole
pool therefore resolves to running totals plus one multiplication — and **no end-of-period sweep ever runs**.

### Selection

Participants occupy contiguous bands of a number line from zero to the pool total. A draw picks a point; whoever's band
contains it wins.

1. `openDraw()` seals the pool total and publishes it for decryption.
2. Off-chain, the total is decrypted and relayed back with a KMS proof. `FHE.checkSignatures` reverts unless the
   cleartext matches the ciphertext, so the relayer **cannot lie** — only decline.
3. `settleDraw()` rolls `FHE.randEuint64` on-chain and reduces it into the pool's range. **The draw point is never
   decrypted by anyone.**

### Claiming

There is no announcement, because nothing knows who won. Anyone can call `checkClaim(drawId, account)` for anyone — the
result is encrypted either way, so the caller learns nothing. It adds `FHE.select(won, prize, 0)` to that depositor's
balance.

A loser's claim adds an encrypted zero. On-chain it is indistinguishable from a winner's, down to the gas. You find out
by opening your own balance and seeing whether it moved.

**Checking for yourself is the default**, and it costs you nothing until you want the answer.
`sweepRange(drawId, count)` is the operator's alternative: it walks slots in order, carrying the running band edge
rather than rederiving it per person, which makes it about 1.6× cheaper each. Either path credits the same encrypted
award, and a slot already checked is skipped rather than credited twice.

A sweep is worth running before the period rolls, because rolling ends every open claim. That is what stops a winner who
never came back from losing the prize.

Claims stay open for **30 days** after settlement (`CLAIM_GRACE`). The window costs nothing to provide: weights freeze
on their own when a period ends, so holding the roll back is the whole mechanism — no snapshots, no per-slot state.

> ⚠️ **With one exception, and it is a real one.** `startNextPeriod()` enforces the grace against everybody _except_ the
> owner, and rolling the period is what closes a claim. So the owner can end the window early and strand an unclaimed
> prize. The exemption exists so a testnet demo does not have to wait a month to show a second cycle; the Judge panel
> refuses to roll until every slot is swept, but that is frontend courtesy, not a contract rule. Treated as a trust
> assumption and documented in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner).

### Weights freeze on their own

A claim reads live tree state, so a draw settled against one set of numbers would break if they shifted mid-window. They
cannot. Once a period elapses, `minuteOfPeriod` saturates, and a deposit adds to both the balance and the shortfall by
exactly the same amount — they cancel. Withdrawals too. So deposits and withdrawals keep working during the claim window
without disturbing the draw, with no snapshots and no freezing of the contract.

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

- **Depositing plain tokens publishes that deposit's size.** `depositUnderlying()` accepts an ordinary ERC-20 for
  convenience, and that transfer is public. Everything after it is encrypted. Hold cUSDT and use `deposit()` if you want
  the amount sealed too.
- **The pool total is published once per draw.** It has to be — the draw point is reduced modulo it, and encrypted
  modulo needs a plain divisor. The week-over-week difference is the sum of everyone's activity, never one person's, and
  it narrows as the pool shrinks.

Full detail, including what we cannot prove, is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

### Proving it rather than saying it

The **Proof** tab points the same relayer and the same session key at two ciphertext handles read straight off the
chain: yours, and another depositor's. One opens. One does not.

It also runs an on-chain **solvency proof** — the contract compares what it holds against what it owes on ciphertext and
publishes the single bit that falls out, revealing neither figure. Anyone can trigger it, and anyone can read the result
without a wallet.

The **Draws** tab recomputes four things from public state with no wallet at all: the stored record, the committed die,
the prize formula, and a hash of the deployed bytecode.

---

## The yield source

Yield is currently an **admin-funded prize reserve**, which the bounty explicitly permits. `fundPrizeReserve()` takes
plain tokens — deliberately, so the pot's size is publicly verifiable — wraps them, and credits a public reserve
balance.

Each draw's prize is derived, never chosen:

```
prize = poolTicketMinutes × annualRateBps ÷ (10,000 × 525,600)
```

capped by whatever the reserve holds. That it scales with the pool is not cosmetic: it is what stops a large late
depositor extracting value. Because the pot grows in proportion to the odds they take, every existing depositor's
expected return is left **exactly unchanged**. A fixed pot would let latecomers dilute everyone else.

**Plugging in real yield** replaces one function and nothing else. `fundPrizeReserve` becomes a harvest step: route idle
deposits into a lending market or vault, and periodically credit realised yield to the same reserve. The draw, the
claim, the weighting and the accounting are untouched, because they only ever read `prizeReserve`. What changes is a
solvency question — deposits would then be lent out rather than held, so `proveSolvency` would need to account for the
strategy's position too.

---

## Repository

```
contracts/
  ConfidentialTimeWeightedTree.sol   encrypted odds accounting
  HushpotPool.sol                    deposits, draws, claims, solvency
  SegmentTree.sol                    plaintext oracle — proven, then encrypted
  TimeWeightedTree.sol               plaintext oracle for the time weighting
  mocks/                             local token pair + test-only tree harness
test/                                106 tests
tasks/hushpot.ts                     the operator + keeper flow
deploy/01_hushpot.ts                 deployment
web/                                 the app
docs/                                threat model, design brief, roadmap
```

The plaintext contracts are not dead code. Encrypted arithmetic fails silently — no revert, no wrong number, just an
opaque handle — so the structures were built and proven in the clear first, then ported. They remain as the correctness
oracle, and every property proven there is re-asserted against the encrypted version.

---

## Running it yourself

**Requirements:** Node 20+, a wallet with Sepolia ETH.

```bash
npm install
npx hardhat test                 # 106 tests, no network needed
```

Deploying:

```bash
npx hardhat vars set MNEMONIC    # stored locally, never in the repo
npx hardhat hushpot:whoami --network sepolia    # the address to fund
npx hardhat deploy --network sepolia
```

Sepolia needs no API key — it defaults to a public endpoint.

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

| Operation            | Gas                         | Note                            |
| -------------------- | --------------------------- | ------------------------------- |
| Deploy               | 3,422,388                   |                                 |
| Deposit              | 565k–2.7M                   | grows with pool size, see below |
| Claim, per depositor | **454,492**                 | was 2.4M                        |
| Sweep, per depositor | **283,697**                 | four slots per transaction      |
| Reveal your position | 1 signature + 1 transaction | signature cached for the visit  |

Two measured optimisations, both of which changed the numbers above by more than they look.

**Claims went from 2.4M to 454k — 5.3×.** Crediting a prize used to repair all ten ancestor sums in the tree, thirty
encrypted additions, for everyone — and for all but one person the amount being added was an encrypted zero. Awards are
now parked on the slot and folded into the tree on that slot's next deposit or withdrawal, which walks that path anyway.

**Deposits scale with the pool rather than the capacity.** The tree walks only as far as the highest node covering the
slots in use, so depth arrives with the crowd:

| Depositors | Deposit gas |
| ---------- | ----------- |
| 1st        | 565,154     |
| 5th        | 1,140,748   |
| 9th        | 1,335,821   |

Against the old fixed full-depth walk those same deposits cost 2.72M, 2.21M and 2.25M — a 41–79% saving, largest when a
pool is new.

FHE work is metered separately in HCU, capped at 20M global and 5M sequential per transaction. A page of four slots fits
comfortably; the old one-claim-per-transaction limit came from the pre-optimisation claim cost and no longer applies.

---

## Invariants under test

114 tests, run against the FHEVM mock. The ones worth naming:

- exactly one depositor is paid, and exactly the prize — verified by decrypting every participant's balance before and
  after a sweep
- a self-check followed by a sweep does **not** credit the same slot twice
- the pool total is published only at a draw boundary, never on demand
- bands tile the number line with no gaps and no overlaps, checked exhaustively against a plaintext oracle
- a withdrawal is clamped to the balance held, because a ciphertext cannot be branched on
- no second draw can settle in the same period
- a prize never touches principal
- weights freeze when a period ends, so deposits during a claim window cannot move a settled draw
- odds are proportional to amount _and_ time — a small deposit held all week beats a 5× larger one made at the deadline

---

## Licence

BSD-3-Clause-Clear.
