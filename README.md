# Hushpot

**A no-loss prize pool. Nobody learns who won, the contract included.**

Deposit a confidential token. Keep your principal, withdrawable in full. The yield the pool generates is awarded to one
depositor each week, weighted by how much they deposited and how long they left it. Balances, odds and winnings are
encrypted end to end, and the draw is still something a stranger can verify.

Built for the Zama Developer Program, Mainnet Season 4.

- **Live app:** <https://hushpot-fhevm.vercel.app>
- **Contract:**
  [`0x4ac487b46d687EB92078c8565FF0FEEa7690b830`](https://sepolia.etherscan.io/address/0x4ac487b46d687EB92078c8565FF0FEEa7690b830)
  (Sepolia). [Verified source](https://sepolia.etherscan.io/address/0x4ac487b46d687EB92078c8565FF0FEEa7690b830#code).
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
  ([`0x08E5…D279`](https://sepolia.etherscan.io/address/0x08E5c466a8c5a5FCccEd833e1E9dC8D5B145D279#code)) whose owner is
  a contract, so all six cycle steps are open to any wallet. No key to import, no week to wait. See
  [Running the cycle as a judge](docs/OPERATING.md#running-the-cycle-as-a-judge-today)
- **Threat model:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), covering what leaks and when

### What is running right now

Not a description of what it would do. These are reads off the live contract, and every one of them is a public getter
anybody can call from Etherscan:

|                  |                                                              |
| ---------------- | ------------------------------------------------------------ |
| Depositors       | **21**, holding encrypted balances                           |
| Pooled principal | **~285,000 cUSDT**                                           |
| Draws settled    | **3** — #0 **505.00**, #1 **264.66**, #2 **1,273.75** cUSDT  |
| Claims answered  | 20/21, 5/21, 1/21 — all three still claimable to 3 Oct       |
| Prize reserve    | 9,197.45 cUSDT                                               |
| Currently        | period #2, draw #2 settled, waiting on the roll to period #3 |

All three cycles have run end to end: deposits accrued, draws opened and settled against an encrypted die, depositors
were checked, and the period rolled between them. Each prize is in one of those balances and **nobody — including the
contract — knows which**. Each depositor can open their own receipt with a signature and no gas; nobody can open anyone
else's.

**Draws #1 and #2 are deliberately left part-swept.** Draw #1 settled in period 1, the pool has since rolled to period
2, and it is still claimable — the thirty-day window feature, live rather than described. Press _Did I win?_ on it and
the contract answers from period 1's weights, a roll later. Under the old rule it would have been refused.

The prize is derived, not chosen: `prize = total × 5% ÷ 52`, computed on ticket-minutes. Draw #1 shows that undisguised
— 276,000 pooled derived **264.657534** with no sponsorship at all, which is the formula to the last decimal. Draws #0
and #2 were topped up by `sponsorPrize`, reserve-neutral over one draw and the sanctioned way to lift a prize without
touching the derivation: draw #2's 1,273.747431 is 273.747431 derived plus exactly **1,000.00 sponsored**. A large late
depositor grows the pot exactly as much as they grow their own odds, so arriving late dilutes nobody, and a small pool
must show a small prize or the yield figure would be a lie.

The pool is deliberately kept near 300,000, where one press of the faucet — 10,000 cUSDT — is worth about **3.5%** of
the next draw, the number a visitor actually cares about. Staying pushes it further, modestly: four weeks of loyalty is
1.20×, so the same deposit held a month is worth about **4.2%**. Both move with the pool, so treat them as the current
reading rather than a constant.

**Two fixes this deployment exists to prove — both run live, not just in tests.** A depositor could previously boost
their loyalty streak between a draw settling and anyone checking it, widening their own band for a total already fixed;
`boostStreak` now reverts with `PeriodEnded` in exactly that window, confirmed with a bare `eth_call` outside any
tooling that could paper over the result. Separately, a deposit made after the owner opened a draw early — before the
period had genuinely elapsed — used to land with its full, uncancelled weight; a 5,000 cUSDT deposit made into a draw
opened early on the sandbox now decrypts to **exactly zero** weight for that period, `drawPending: true` and
`periodEnded: false` at the moment it landed.

The judge sandbox — see [Running the cycle as a judge](docs/OPERATING.md#running-the-cycle-as-a-judge-today) — was
redeployed alongside the main pool for the same reason both times: it had drifted behind whatever the main pool's code
actually did, and a reviewer comparing the two would have found them disagreeing.

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

## How it works, briefly

PoolTogether-style selection walks a cumulative sum on ciphertext, one homomorphic operation per depositor with each
depending on the last — FHEVM caps that dependency chain at 5M HCU per transaction, so it never reaches mainnet scale.
Hushpot replaces the walk with an **encrypted segment tree**: a slot's odds are a band on a number line, finding the
band that contains the (encrypted, never-decrypted) draw point is a walk from leaf to root, `log2(slots)` levels instead
of `n`. The other ceiling is who pays for `n` claims a draw — Hushpot's answer is that nobody has to: `checkMyClaim` is
one flat-cost transaction, sent by the person it pays, and no sweep is load-bearing.

Odds are **ticket-minutes** — balance × minutes held this period — so a fortune deposited moments before the draw buys
almost nothing, and a small `boostStreak` bonus rewards staying past the period you arrived in. A claim evaluates your
band and credits the prize or an encrypted zero in the same transaction; the two are indistinguishable on-chain, down to
the gas, which is what makes the app able to say nothing at all when it doesn't want to. Claims survive a roll for
thirty real days — the tree keeps five generations of history — so nobody has to be swept in time to keep what they won,
and finding out afterwards costs a signature and no gas, forever.

Every balance, every odds figure, the draw point, and whether a given depositor won are `euint64`/`ebool` ciphertext
nobody — not other depositors, not the owner, not the contract itself — can read. What's public by design: that an
address deposited and when, which slot it holds, the pool total once per draw, and the prize each draw paid. Yield is
currently an admin-funded reserve (the bounty explicitly permits this) behind a one-function seam a real strategy would
plug into.

**The full mechanics, proofs and measured costs:** [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md). **What leaks and what
you have to trust:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

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
test/                                173 tests
tasks/hushpot.ts                     the operator + keeper flow
deploy/01_hushpot.ts                 deployment
web/                                 the app
docs/                                how it works, operating it, threat model, design brief, roadmap
```

The plaintext contracts are not dead code. Encrypted arithmetic fails silently: no revert, no wrong number, just an
opaque handle. So the structures were built and proven in the clear first, then ported. They remain as the correctness
oracle, and every property proven there is re-asserted against the encrypted version.

---

## Operating the protocol

There is no admin login, only an address with two owner-gated functions (`fundPrizeReserve`, `setAnnualRateBps`) and
automation that calls public functions on a schedule. Depositing, withdrawing, settling a draw, sweeping every claim at
once, and opening the next draw are all open to any wallet — a pool whose draw only its operator can start is a pool its
operator can stall. The one place this design asks for trust: rolling the period early, since a non-owner has to wait
out the full thirty-day claim window first. On a weekly cadence that makes the roll the operator's in practice,
documented as the exception it is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner).

A **judge sandbox** — [`/judge?pool=sandbox`](https://hushpot-fhevm.vercel.app/judge?pool=sandbox) — exists so anyone
can run the whole six-step cycle from their own wallet with no key to import: its owner is
[`SandboxOperator`](contracts/SandboxOperator.sol), a twenty-line contract that forwards exactly two calls to anybody
who asks and nothing else. The contract itself is immutable — no proxy, no admin upgrade path — which is load-bearing
for "there is no winner field," not merely tidy.

**The full detail — gating table, the sandbox mechanism, the weekly schedule, running a keeper, and what immutability
has cost here in practice:** [`docs/OPERATING.md`](docs/OPERATING.md).

---

## Running it yourself

**Requirements:** Node 20+, a wallet with Sepolia ETH.

```bash
npm install
npx hardhat test                 # 173 tests, no network needed
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

## Licence

BSD-3-Clause-Clear.
