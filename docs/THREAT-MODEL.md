# Hushpot — Threat Model

What is encrypted, what is public, what leaks, and what you have to trust.

This document is deliberately unflattering. A confidential system that only advertises its
strengths is harder to evaluate than one that names its edges, and every claim below can be
checked against the deployed contract.

**Contract:** `HushpotPool` · Sepolia · `0x0B6c8A1f573215f25041616987Aa8f269ABDFa4e`

---

## 1. What is encrypted

Every one of these is a `euint64` or `ebool` on-chain. No party — not other depositors, not
the contract owner, not the contract itself — can read them.

| Value | Notes |
|---|---|
| Each depositor's balance | Only its owner can decrypt, via EIP-712 |
| Each depositor's odds | Derived from the encrypted balance and time held |
| The draw point | `FHE.randEuint64`, never decrypted by anyone, ever |
| Whether a given depositor won | Never computed as a plaintext anywhere |
| A prize, until its winner opens it | Added as `FHE.select(won, prize, 0)` |
| The pool's own token holdings | Compared to liabilities without revealing either |

The winner is not *hidden*. There is nothing to hide, because no code path anywhere derives
it. A claim adds either the prize or an encrypted zero, and on-chain those two transactions
are indistinguishable — including in gas.

---

## 2. What is public, by design

| Value | Why |
|---|---|
| That an address deposited or withdrew, and when | Inherent to a public chain. Transactions are visible. |
| Which slot an address holds | A plain mapping. Reveals participation, never amount. |
| The pool total, once per draw | Needed to reduce the draw point into the pool's range. |
| The prize each draw paid | Not anybody's balance. |
| Number of depositors | Aggregate. |
| That a slot was checked for a draw | Reveals a check happened, never its outcome. |
| Period schedule, yield rate, prize reserve | Protocol parameters. |
| All contract code | The selection rule should be readable. |

**Participation is public; position is not.** Anyone can see that you are in the pool. Nobody
can see what you have in it.

---

## 3. Known leaks

### 3.1 Depositing plain tokens publishes that deposit's size

`depositUnderlying()` accepts an ordinary ERC-20, which means the amount travels in a public
`transferFrom`. **That deposit's size is visible to anyone.** Everything afterwards — your
position, your odds, your winnings — is encrypted, but the entry itself is not.

- **Severity:** high for that single deposit, none thereafter.
- **Avoid it:** hold cUSDT and use `deposit()`, where the amount is encrypted before it
  leaves your wallet.
- **Or decouple it:** shield tokens at one time and deposit at another. The two are then
  unlinkable by size or timing.
- **Why we ship it anyway:** requiring users to wrap manually before depositing is a real
  barrier, and Zama's own Steakhouse vault makes the same trade. The interface says so
  plainly rather than burying it.

### 3.2 The pool total is published at each draw

The draw point must be reduced modulo the pool's total, and encrypted modulo requires a
plain divisor — so the total is decrypted once per draw and relayed back with a proof.

The difference between two consecutive totals equals the **sum of that period's net
activity**. With many depositors this reveals nothing about any individual. With few, it
narrows sharply. **With a single depositor it is exact.**

- **Severity:** scales inversely with pool size. Genuinely weak on a small testnet pool.
- **Mitigation:** publish only at draw boundaries, never continuously. A live total would
  leak every deposit by subtraction.
- **Consequence honoured in the UI:** the odds display divides by the total published at the
  *last* draw, never a live one. A live denominator would let anyone recover the running
  total by dividing their own odds into it.

### 3.3 The time factor applied to a deposit is public

Odds are weighted by amount × time held, and the minute a deposit landed is a public block
timestamp. So the *multiplier* is known. The amount is not, so the product is not.

- **Severity:** low. Reveals when you acted, which the transaction already did.

### 3.4 Concentration in a small pool

A depositor holding most of a small pool has most of the odds. Over many draws, an observer
who could correlate payouts with balances might infer something — though since winners are
never resolved on-chain, they would have no payouts to correlate.

- **Severity:** low today, and largely theoretical while winners stay unresolved.
- **Possible mitigation, not implemented:** cap any single depositor's odds with `FHE.min`.
  This would clamp odds only, never principal, so the no-loss guarantee is untouched.

### 3.5 What does *not* leak

Worth stating, because both are common assumptions:

- **Gas does not reveal amounts.** FHE operation cost depends on the *type* of the
  ciphertext, not the value inside it. Depositing 1 token and 1,000,000 cost the same.
- **Claiming does not reveal winning.** The public prize reserve is decremented at
  settlement, not at claim, so a winner's claim moves no public number. Loser and winner
  claims are identical on-chain.

---

## 4. Trust assumptions

### 4.1 The Zama protocol

Confidentiality rests on Zama's coprocessor and KMS. If the threshold key-management
network were compromised, ciphertexts could be decrypted. This is the foundational
assumption of any FHEVM application and Hushpot does not reduce it.

### 4.2 The decryption relayer

Settling a draw needs the pool total decrypted off-chain and relayed back. The relayer
**cannot lie**: `FHE.checkSignatures` reverts unless the cleartext genuinely matches the
ciphertext. It can only decline to relay, which stalls a draw but corrupts nothing.

### 4.3 The owner

**Can:** fund the prize reserve, set the yield rate, trigger a draw or a period roll early.

**Cannot:** read any balance, influence the die, prevent a withdrawal, or move depositor
funds. There is no owner-withdraw path in the contract.

**Worth naming:** the owner can set the yield rate to zero, which would make prizes zero. It
would be visible immediately — the rate is public — but it is an admin power that a
production deployment should put behind a timelock or governance.

### 4.4 Funds locked by design

Tokens added to the prize reserve can leave only by being won. There is no recovery
function, deliberately, so nobody can pull the pot. The trade is that over-funding is
irreversible.

---

## 5. What the in-app verifier proves, and what it cannot

The Draws tab recomputes four things from public state, with no wallet and no trust in our
frontend:

1. The receipt matches what the contract actually stores.
2. The die is a real, non-zero ciphertext handle, committed on-chain.
3. The prize equals `total × annualRateBps ÷ (10,000 × 525,600)` — the published formula
   applied to the published total, not a number anyone chose.
4. The deployed bytecode hashes to what it claims.

**It cannot prove who won.** Not because that is concealed, but because nothing computes it.

**It cannot prove the die was unbiased.** That rests on the protocol's generator and the
published source, not on any figure in a receipt.

The Proof tab goes further and *demonstrates* the boundary: it points the same relayer and
the same session key at your balance and at another depositor's. One opens. One does not.

---

## 6. Not addressed

Honest omissions, with what each would take:

| Gap | What would close it |
|---|---|
| Yield is an admin-funded reserve, not a live strategy | Route deposits into a yield source and feed the same reserve |
| No timelock on owner functions | Governance or a delay on rate changes and draw triggers |
| Unclaimed prizes are not swept back automatically | A rollover pass once the claim window closes |
| Pool capacity is fixed at 1,024 slots | A deeper tree, at higher per-deposit cost |
| No formal audit | The reason this document exists |

---

*Last updated 10 August 2026. If something here is wrong, that is a bug — please report it.*
