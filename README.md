# Hushpot

**A no-loss prize pool. Nobody learns who won, the contract included.**

Deposit a confidential token and keep your principal, withdrawable in full. Each week the yield the pool generates goes
to one depositor, picked at random. Your odds depend on how much you deposited and how long you left it there. Balances,
odds and winnings stay encrypted from end to end, and anyone can still check that the draw was fair.

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

Every figure below comes from a public getter on the live contract. You can read them yourself on Etherscan. They are a
reading taken on **4 September 2026**, not constants: the pool is open, so anyone can deposit or answer a claim and move
them. `npx hardhat run scripts/audit-state.ts --network sepolia` prints the current set.

|                  |                                                             |
| ---------------- | ----------------------------------------------------------- |
| Depositors       | **22**, holding encrypted balances                          |
| Pooled principal | **~285,000 cUSDT** at the last draw                         |
| Draws settled    | **3** - #0 **505.00**, #1 **264.66**, #2 **1,273.75** cUSDT |
| Claims answered  | 20/20, 5/20, 2/21 - all three still claimable to 3 Oct      |
| Prize reserve    | 9,197.45 cUSDT                                              |
| Currently        | period #3, accruing toward draw #3                          |

All three cycles ran end to end. Deposits accrued, each draw opened and settled against an encrypted die, depositors
were checked, and the period rolled in between. Each prize now sits in one of those balances, and nobody knows which
one, the contract included. A depositor can open their own receipt with a signature and no gas. Nobody can open anyone
else's.

**Draws #1 and #2 are deliberately left part-swept.** Draw #1 settled in period 1 and the pool has since rolled twice,
to period 3, but it is still claimable. That is the thirty-day window working on the live deployment rather than being
described in a paragraph. Press _Did I win?_ on it and the contract answers from period 1's weights, two rolls later. An
earlier version of the code would have refused.

Nobody picks the prize. It falls out of `prize = total × 5% ÷ 52`, computed on ticket-minutes. Draw #1 shows this with
nothing added: 276,000 pooled produced **264.657534**, matching the formula to the last decimal. Draws #0 and #2 were
topped up through `sponsorPrize`, which is reserve-neutral across a single draw and the supported way to raise a prize
without changing how it is derived. Draw #2 paid 1,273.747431, made up of 273.747431 from the formula plus exactly
**1,000.00** sponsored. A large late deposit raises the pot by as much as it raises that depositor's own odds, so
arriving late dilutes nobody, and a small pool has to show a small prize or the yield figure would be a lie.

The pool is kept near 300,000 on purpose. At that size one press of the faucet, 10,000 cUSDT, is worth about **3.5%** of
the next draw, which is the number a visitor actually wants to know. Staying improves it a little: four weeks of loyalty
is 1.20×, so the same deposit held for a month is worth about **4.2%**. Both figures move with the pool, so read them as
current values rather than constants.

**This deployment exists to prove two fixes, and both run live rather than only in tests.**

A depositor used to be able to boost their loyalty streak after a draw had settled but before anyone checked it, which
widened their own band against a total that was already fixed. `boostStreak` now reverts with `PeriodEnded` in exactly
that window. That was confirmed with a bare `eth_call`, outside any tooling that might have papered over the result.

Separately, a deposit made after the owner opened a draw early, before the period had genuinely elapsed, used to land
with its full weight uncancelled. A 5,000 cUSDT deposit into an early-opened draw on the sandbox now decrypts to
**exactly zero** weight for that period, with `drawPending: true` and `periodEnded: false` at the moment it landed.

The judge sandbox (see [Running the cycle as a judge](docs/OPERATING.md#running-the-cycle-as-a-judge-today)) was
redeployed alongside the main pool both times, for the same reason each time: it had fallen behind what the main pool's
code actually did, and a reviewer comparing the two would have found them disagreeing.

**Three of the four cycle steps are permissionless.** Once the week is up, any wallet can open the draw, settle it and
pay every depositor out. The operator is not in that path and cannot stall it. Only the roll belongs to the operator,
and only because the thirty-day claim window outlasts the seven-day period, so nobody else ever reaches the point where
the contract would let them close a claim early. That is the one place this design asks for trust, and
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner) treats it as a trust assumption rather than a feature.

---

## The idea in one paragraph

Everyone deposits into a shared pool, and the pool earns yield. Rather than paying that interest back to each depositor
in dribs, it is collected into a single weekly prize and awarded at random, with odds proportional to what you
contributed and how long it sat there. Nobody can lose, because a draw only ever touches the yield and never the
principal. What does not exist yet is a version where the amounts stay encrypted and the winner is never resolved
on-chain at all.

---

## How it works, briefly

PoolTogether-style selection walks a cumulative sum over ciphertext, one homomorphic operation per depositor, each
depending on the result of the one before it. FHEVM caps that dependency chain at 5M HCU per transaction, so the
approach never reaches mainnet scale.

Hushpot replaces the walk with an **encrypted segment tree**. A slot's odds are a band on a number line, and finding the
band that contains the draw point (itself encrypted, and never decrypted) is a walk from leaf to root: `log2(slots)`
levels instead of `n`. The other ceiling is who pays for `n` claims a draw. Hushpot's answer is that nobody has to.
`checkMyClaim` is a single flat-cost transaction, sent by the person it pays, and no sweep is load-bearing.

Odds are **ticket-minutes**, meaning balance multiplied by the minutes you held it this period. A fortune deposited
moments before the draw therefore buys almost nothing, and a small `boostStreak` bonus rewards staying past the period
you arrived in.

A claim evaluates your band and credits either the prize or an encrypted zero in the same transaction. The two are
indistinguishable on-chain, down to the gas, which is what lets the app say nothing at all when it needs to. Claims
survive a roll for thirty real days, because the tree keeps five generations of history, so nobody has to be swept in
time to keep what they won. Finding out afterwards costs a signature and no gas, for as long as you like.

Every balance, every odds figure, the draw point, and whether a given depositor won are all `euint64`/`ebool`
ciphertext. No other depositor can read them, nor the owner, nor the contract itself. Four things are public by design:
that an address deposited and when, which slot it holds, the pool total once per draw, and the prize each draw paid.
Yield currently comes from an admin-funded reserve, which the bounty explicitly permits, behind a one-function seam that
a real strategy would plug into.

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

The plaintext contracts are still doing a job. Encrypted arithmetic fails silently: no revert, no visibly wrong number,
just an opaque handle. So the structures were built and proven in the clear first, then ported. They stay as the
correctness oracle, and every property proven there is re-asserted against the encrypted version.

---

## Operating the protocol

There is no admin login. There is an address with two owner-gated functions (`fundPrizeReserve` and `setAnnualRateBps`),
plus automation that calls public functions on a schedule. Depositing, withdrawing, settling a draw, sweeping every
claim at once and opening the next draw are all open to any wallet, because a pool whose draw only its operator can
start is a pool its operator can stall.

The exception is rolling the period early, since a non-owner has to wait out the full thirty-day claim window first. On
a weekly cadence that makes the roll the operator's in practice, and
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#43-the-owner) documents it as the exception it is.

A **judge sandbox** at [`/judge?pool=sandbox`](https://hushpot-fhevm.vercel.app/judge?pool=sandbox) lets anyone run the
whole six-step cycle from their own wallet with no key to import. Its owner is
[`SandboxOperator`](contracts/SandboxOperator.sol), a small contract that forwards the two owner-gated cycle steps to
anybody who asks, plus a reserve top-up that only ever adds the caller's own money. Nothing that could take the pool:
there is no forwarder for `transferOwnership` or `setAnnualRateBps`, and no generic `call`. The pool contract is
immutable, with no proxy and no admin upgrade path. That matters for the claim that there is no winner field, since an
upgradeable contract could always add one later.

**The full detail - gating table, the sandbox mechanism, the weekly schedule, running a keeper, and what immutability
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

Sepolia needs no API key; it defaults to a public endpoint.

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

## Licence and provenance

BSD-3-Clause-Clear.

Scaffolded from [Zama's `fhevm-hardhat-template`](https://github.com/zama-ai/fhevm-hardhat-template), which supplies the
Hardhat setup, lint and CI configuration, and whose licence is retained in [`LICENSE`](LICENSE). Everything the project
is actually about is original: the contracts in `contracts/`, the app in `web/`, the tasks in `tasks/`, the tests in
`test/`, and the documentation in `docs/`.
