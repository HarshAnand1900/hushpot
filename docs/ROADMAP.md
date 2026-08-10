# Hushpot — Roadmap to Submission

**Today:** 8 August 2026 · **Deadline:** 5 September 2026, 23:59 AOE · **28 days**

---

## Where we are

**Done — the hard part is behind us.**

The weighted-selection engine is built and proven in plaintext, 34/34 tests green:

- `SegmentTree.sol` — proportional selection, with an exhaustive test sweeping every
  possible draw point and confirming each participant is picked exactly in proportion to
  their share. Plus a proof that the per-user self-check is equivalent to a central walk
  and never produces two winners.
- `TimeWeightedTree.sol` — odds weighted by amount *and* time held, with no end-of-period
  settlement loop. Includes a direct test that a last-minute deposit five times larger
  loses badly to a small one held all week.

Also settled: the full architecture, the confidentiality model, the gas budget (measured
against published costs — both heavy transactions fit with room), and the two design docs.

**What that means:** the novel, risky, could-have-failed part is finished and tested.
Everything remaining is assembly, integration, and polish. Substantial work, but the
kind where you can see the end from the start.

---

## Phase 1 — Encrypt the engine
**Aug 8 – Aug 14 · ~5 days**

Port the proven plaintext contracts to encrypted integers. The plaintext versions stay in
the repo as a correctness oracle — that's what makes this safe rather than a rewrite.

- [ ] `euint64` port of the time-weighted tree
- [ ] Encrypted win-check that is never decrypted, only fed into a select
- [ ] ACL grants on every stored handle (a missed grant makes a value unusable next tx)
- [ ] Confidential token integration — deposit and withdraw against ERC-7984
- [ ] Auto-shielding: accept plain ERC-20, wrap behind the scenes
- [ ] Port the full test suite to the FHE mock environment
- [ ] Real gas measurement against the 20M / 5M HCU ceilings

**Risk:** if encrypted gas overruns the limits, fall back to simpler weighting. That's a
small, contained change, and it's why the fallback was kept viable.

---

## Phase 2 — The rest of the protocol
**Aug 15 – Aug 21 · ~6 days**

- [ ] Draw: on-chain encrypted randomness, period management
- [ ] Claim: encrypted win check, prize into the winner's balance
- [ ] Prize reserve and mock yield source (plus documenting how real yield would plug in)
- [ ] Claim window and rollover of unclaimed prizes
- [ ] Opt-in winner disclosure
- [ ] Faucet for the test token
- [ ] Admin draw trigger and keeper flow
- [ ] Deploy to Sepolia and verify on Etherscan

**Milestone:** the entire cycle — deposit, draw, claim, withdraw — working end to end
on Sepolia, driven from scripts. No UI yet.

---

## Phase 3 — Frontend
**Aug 22 – Aug 29 · ~8 days**

The largest single block, and where the bounty is won or lost.

- [ ] Next.js scaffold, wallet connection, Zama SDK and relayer wiring
- [ ] Landing page (your design)
- [ ] Pool screen — pot, countdown, depositor count, your position
- [ ] Deposit flow with auto-shielding and honest multi-step progress
- [ ] Withdraw flow
- [ ] Balance decryption via EIP-712, with a session cache so it's one signature per visit
- [ ] Odds display, and the "your money has been earning for…" element
- [ ] "Did I win?" reveal — including a losing state that doesn't deflate
- [ ] Draw history and Draw Explorer
- [ ] Faucet screen
- [ ] Error handling for the four named cases: missing approval, insufficient balance,
      network mismatch, unsupported token
- [ ] Responsive and dark mode
- [ ] Deploy to Vercel

**Risk:** the Zama relayer and SDK wiring has historically eaten more time than expected.
Budget for it; start it on day one of this phase rather than last.

---

## Phase 4 — Documentation, submission, buffer
**Aug 30 – Sep 4 · ~6 days**

- [ ] `README.md` — live URL, how the pool and draws work, the confidentiality design,
      the yield mock and how real yield plugs in, deployment scripts
- [ ] `THREAT-MODEL.md` — what's encrypted, what leaks, under what conditions.
      **Not optional:** the guidelines require documenting leakage, and it's a scored
      judging criterion. Also the single best defence against being marked down for
      overclaiming.
- [ ] Public GitHub repo, cleaned history, no leaked keys
- [ ] Demo video — max 3 minutes, real person, normal speed, no AI voice. Must show
      deposit, balance decryption, a draw, a claim, and a withdrawal.
- [ ] X thread tagging @zama with #ZamaDeveloperProgram
- [ ] Submit the form

**Buffer: Sep 4–5.** Do not plan work here. Something always slips.

---

## Where extra effort pays off most

If you have spare capacity, in priority order:

1. **The "did I win?" reveal.** The most novel interaction in the product and the one
   judges will remember. Most visits end in a loss — make that state good.
2. **The Draw Explorer.** Verifiability is a scored criterion and almost every submission
   will merely claim it rather than show it.
3. **Session-cached decryption.** The difference between "clunky crypto app" and
   "product." Cheap to build, disproportionately noticeable.
4. **Sponsored prizes.** Anyone can top up the pot without taking odds. Roughly twenty
   lines, and it signals that we studied the real protocol.
5. **Error states.** The guidelines name four specific cases. Free marks, frequently
   skipped.

Deliberately *not* on this list: real yield integration, multiple prize tiers, multiple
pools. All three add risk and dilute what's already working.

---

## Known risks

| Risk | Mitigation |
|---|---|
| Encrypted gas exceeds HCU limits | Fallback to simpler weighting; contained change |
| Zama SDK / relayer integration slippage | Start it first in Phase 3, not last |
| Sepolia deploy or verification issues | Deploy in Phase 2, not the final week |
| Video and thread underestimated | Both scheduled in Phase 4 with buffer after |
| Scope creep from new feature ideas | Anything new goes below the priority list above |

---

## The honest summary

Four weeks is enough, comfortably, **provided the frontend starts on schedule.** The
contract work is de-risked because the difficult algorithm is already proven. The main
threat now isn't technical failure — it's spending week three still refining design
decisions instead of building screens.
