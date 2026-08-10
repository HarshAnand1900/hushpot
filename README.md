# Hushpot

**A no-loss prize pool where nobody — including the contract — learns who won.**

Deposit a confidential token. Keep your principal, withdrawable in full at any time. The
yield the pool generates is awarded to one depositor each week, weighted by how much they
deposited and how long they left it. Balances, odds and winnings are encrypted end to end,
and the draw is still something a stranger can verify.

Built for the Zama Developer Program, Mainnet Season 4.

- **Live app:** _pending deployment — see “Running it yourself” below_
- **Contract:** [`0x0B6c8A1f573215f25041616987Aa8f269ABDFa4e`](https://sepolia.etherscan.io/address/0x0B6c8A1f573215f25041616987Aa8f269ABDFa4e) (Sepolia)
- **Token:** Zama's official `cUSDTMock` — [`0x4E7B…4491`](https://sepolia.etherscan.io/address/0x4E7B06D78965594eB5EF5414c357ca21E1554491)
- **Faucet:** the underlying [`USDTMock`](https://sepolia.etherscan.io/address/0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0) has an open `mint`, so anyone can self-serve
- **Threat model:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — what leaks, and when

---

## The idea in one paragraph

Everyone deposits into a shared pool. The pool earns yield. Rather than dribbling that
interest back to each depositor, it is bundled into a single weekly prize and awarded at
random, with odds proportional to what you contributed and how long it sat there. Nobody can
lose: a draw never touches principal, only yield. What does not exist yet is a version where
the amounts stay encrypted — and where the winner is never resolved on-chain at all.

---

## How the draw works

The interesting problem is picking a winner with odds proportional to a **secret** balance,
without decrypting anyone's position, in a way that stays verifiable.

### Weighting

Odds come from **ticket-minutes**: your balance multiplied by the minutes you held it this
period. Deposit halfway through the week and you earn half the odds of someone who was there
the whole week with the same amount. This closes the obvious exploit — depositing a fortune
moments before the draw buys almost nothing.

Tracking that naively is unusable on-chain: every user has their own last-changed timestamp,
so totalling the pool would mean visiting all of them. The fix is algebraic:

```
balance × (drawTime − lastChange)  =  balance × drawTime  −  balance × lastChange
```

The right-hand term carries no draw time, so it can be computed the moment someone deposits
and folded into a running total. The left multiplies a figure identical for everyone, so it
factors out against the sum of balances. The whole pool therefore resolves to running totals
plus one multiplication — and **no end-of-period sweep ever runs**.

### Selection

Participants occupy contiguous bands of a number line from zero to the pool total. A draw
picks a point; whoever's band contains it wins.

1. `openDraw()` seals the pool total and publishes it for decryption.
2. Off-chain, the total is decrypted and relayed back with a KMS proof.
   `FHE.checkSignatures` reverts unless the cleartext matches the ciphertext, so the relayer
   **cannot lie** — only decline.
3. `settleDraw()` rolls `FHE.randEuint64` on-chain and reduces it into the pool's range.
   **The draw point is never decrypted by anyone.**

### Claiming

There is no announcement, because nothing knows who won. Anyone can call
`checkClaim(drawId, account)` for anyone — the result is encrypted either way, so the caller
learns nothing. It adds `FHE.select(won, prize, 0)` to that depositor's balance.

A loser's claim adds an encrypted zero. On-chain it is indistinguishable from a winner's,
down to the gas. You find out by opening your own balance and seeing whether it moved.

Because anyone can run it, a keeper sweeps every participant after each draw and the prize
simply *appears*. Nobody has to remember to check — and since everyone is checked, the fact
that someone was checked says nothing.

### Weights freeze on their own

A claim reads live tree state, so a draw settled against one set of numbers would break if
they shifted mid-window. They cannot. Once a period elapses, `minuteOfPeriod` saturates, and
a deposit adds to both the balance and the shortfall by exactly the same amount — they
cancel. Withdrawals too. So deposits and withdrawals keep working during the claim window
without disturbing the draw, with no snapshots and no freezing of the contract.

---

## Confidentiality

| Encrypted | Public |
|---|---|
| Every balance | That an address deposited, and when |
| Every depositor's odds | The pool total, once per draw |
| The draw point | The prize each draw paid |
| Whether a given person won | Number of depositors |
| A prize, until its winner opens it | All contract code |

Two things worth stating plainly:

- **Depositing plain tokens publishes that deposit's size.** `depositUnderlying()` accepts an
  ordinary ERC-20 for convenience, and that transfer is public. Everything after it is
  encrypted. Hold cUSDT and use `deposit()` if you want the amount sealed too.
- **The pool total is published once per draw.** It has to be — the draw point is reduced
  modulo it, and encrypted modulo needs a plain divisor. The week-over-week difference is the
  sum of everyone's activity, never one person's, and it narrows as the pool shrinks.

Full detail, including what we cannot prove, is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

### Proving it rather than saying it

The **Proof** tab points the same relayer and the same session key at two ciphertext handles
read straight off the chain: yours, and another depositor's. One opens. One does not.

It also runs an on-chain **solvency proof** — the contract compares what it holds against
what it owes on ciphertext and publishes the single bit that falls out, revealing neither
figure. Anyone can trigger it, and anyone can read the result without a wallet.

The **Draws** tab recomputes four things from public state with no wallet at all: the stored
record, the committed die, the prize formula, and a hash of the deployed bytecode.

---

## The yield source

Yield is currently an **admin-funded prize reserve**, which the bounty explicitly permits.
`fundPrizeReserve()` takes plain tokens — deliberately, so the pot's size is publicly
verifiable — wraps them, and credits a public reserve balance.

Each draw's prize is derived, never chosen:

```
prize = poolTicketMinutes × annualRateBps ÷ (10,000 × 525,600)
```

capped by whatever the reserve holds. That it scales with the pool is not cosmetic: it is
what stops a large late depositor extracting value. Because the pot grows in proportion to
the odds they take, every existing depositor's expected return is left **exactly unchanged**.
A fixed pot would let latecomers dilute everyone else.

**Plugging in real yield** replaces one function and nothing else. `fundPrizeReserve` becomes
a harvest step: route idle deposits into a lending market or vault, and periodically credit
realised yield to the same reserve. The draw, the claim, the weighting and the accounting are
untouched, because they only ever read `prizeReserve`. What changes is a solvency question —
deposits would then be lent out rather than held, so `proveSolvency` would need to account
for the strategy's position too.

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

The plaintext contracts are not dead code. Encrypted arithmetic fails silently — no revert,
no wrong number, just an opaque handle — so the structures were built and proven in the clear
first, then ported. They remain as the correctness oracle, and every property proven there is
re-asserted against the encrypted version.

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

`--force` lets the owner run a draw without waiting a week, which is how to see a full cycle
in a few minutes.

The app:

```bash
cd web && npm install && npm run dev
```

Point `POOL_ADDRESS` in `web/src/lib/contract.ts` at your deployment.

---

## Measured costs

On Sepolia, against the live coprocessor:

| Operation | Gas |
|---|---|
| Deploy | 3,132,784 |
| Deposit | ~2.4M warm, ~3.0M first touch |
| Claim, per depositor | ~2.4M |
| Reveal your position | ~1 signature + 1 transaction |

FHE work is metered separately in HCU, capped at 20M global and 5M sequential per
transaction. One claim is roughly 60–80 encrypted operations, so **claims must be sent one
per transaction** — batching even five exceeds the ceiling. `hushpot:sweep` pages through
accordingly, and the contract documentation says so rather than implying a whole-pool sweep.

---

## Licence

BSD-3-Clause-Clear.
