# Hushpot — documentation

Four documents, each with one job. Start wherever your question sits.

| If you want to know…                                      | Read                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| What this is, how the draw works, how to run it           | [`../README.md`](../README.md)                                               |
| What is encrypted, what leaks, and what you have to trust | [`THREAT-MODEL.md`](THREAT-MODEL.md)                                         |
| Why the product is shaped this way, and who it is for     | [`BRIEF.md`](BRIEF.md)                                                       |
| What is deliberately not built yet, and why               | [`ROADMAP.md`](ROADMAP.md)                                                   |
| How the protocol is run, and by whom                      | [`../README.md#operating-the-protocol`](../README.md#operating-the-protocol) |

## The short version

Everyone deposits into a shared pool. The pool earns yield. Once a week the entire yield goes to one depositor at
random, weighted by how much they put in and how long they left it. Principal is never at stake — every deposit
withdraws in full, any time.

What is new is that the amounts are encrypted end to end. Balances, odds, the prize, and the die that decides it are all
`euint64` ciphertext under Zama's FHEVM. The contract adds and compares them without ever holding a key that could open
them.

## The three things worth understanding

**Odds are time-weighted, and the tree is why.** Your weight is balance × minutes held, so a large deposit made an hour
before the draw cannot beat a small one held all week. Those weights are summed in an encrypted segment tree, which is
what makes "find the one slot whose band contains the die" cost a walk rather than a scan of every depositor.

**Nothing branches on a ciphertext, ever.** FHE does not allow it, and a branch would leak which way it went through gas
and state. Settlement is a branchless `FHE.select` over every slot: a loser is credited an encrypted zero that is
indistinguishable on-chain from a winner's prize, down to the gas.

**There is no winner field.** Not hidden — absent. The contract never computes who won, so there is nothing in storage
to leak, subpoena, or accidentally log. The only way to find out is to open your own balance with your own key and see
whether it moved. The Draws tab proves this by searching the deployed bytecode for winner-getter selectors and finding
none.

## Known trust assumptions

Stated plainly rather than buried, and covered in full in [`THREAT-MODEL.md`](THREAT-MODEL.md):

- The **owner can end the 30-day claim window early**, because rolling the period is what closes a claim and the grace
  check exempts the owner.
- **A griefer's slots cannot be reclaimed.** A depositor can give their own slot back with `exitPool`, but nobody can
  take one from an attacker — that case is priced rather than prevented. See [§9](THREAT-MODEL.md#9-slot-exhaustion).
- **`depositUnderlying` publishes the deposit's size.** It is the convenience route; the confidential route is the
  default and leaves nothing in the clear.
- **Yield is funded from a reserve**, not a live strategy. On mainnet the same reserve would be fed by real yield.
- **Ownership is a single key**, not a multisig, and the contract is not upgradeable — see
  [Operating the protocol](../README.md#operating-the-protocol).
