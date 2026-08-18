"use client";

import styles from "./HardParts.module.css";

/**
 * What FHE actually forbids, and what this contract does instead.
 *
 * Every row is a constraint that shaped the design rather than a feature bolted on. They
 * are the reason the code looks the way it does, and none of them is obvious until you
 * hit it — which is why they are worth stating plainly.
 */
const CONSTRAINTS = [
  {
    title: "No ciphertext ÷ ciphertext",
    limit: "FHE multiplies by a plaintext scalar only, so odds = your weight ÷ pool total is not expressible on-chain.",
    fix: "Odds are never computed on-chain. The tree holds a time-weighted encrypted numerator; the ratio is derived in your browser after you decrypt. It exists nowhere else.",
  },
  {
    title: "You cannot branch on a ciphertext",
    limit: "`if (winner == you)` does not exist — and a branch would leak which way it went through gas and state.",
    fix: "Settlement is a branchless FHE.select over every depositor: each slot receives select(won, prize, 0). A loser's credit is an encrypted zero, identical on-chain to the winner's, down to the gas.",
  },
  {
    title: "Reveals are asynchronous",
    limit: "makePubliclyDecryptable → relayer → finalize spans multiple blocks, so a draw cannot be one transaction.",
    fix: "A draw is a two-phase state machine with a replay guard. The pot sits in an encrypted balance whether or not anyone ever looks, and FHE.checkSignatures rejects a forged total on the way back.",
  },
  {
    title: "ACL hygiene is load-bearing",
    limit:
      "A wrong grant means the next operation reverts, or the relayer refuses to decrypt at all — and the error looks like a permission bug when it is a propagation race.",
    fix: "Every stored handle gets allowThis plus allow(owner); the prize transfer uses allowTransient. You are the only address ever granted rights over your own balance, and decryption retries through the lag.",
  },
  {
    title: "A revert reason is a side channel",
    limit:
      "A withdrawal that reverts on insufficient balance lets anyone binary-search your position for the price of gas.",
    fix: "Withdrawals never revert on balance. An over-withdrawal is silently clamped to your encrypted maximum, so the failure path carries no information either.",
  },
];

export function HardParts() {
  return (
    <section className="panel">
      <div className="panelHead">
        <span>THE HARD PARTS · FHE-NATIVE ENGINEERING</span>
        <span>{CONSTRAINTS.length} CONSTRAINTS</span>
      </div>

      <div className={styles.headRow}>
        <span>THE CONSTRAINT</span>
        <span>HOW HUSHPOT SOLVES IT</span>
      </div>

      {CONSTRAINTS.map((c, i) => (
        <div key={c.title} className={styles.row}>
          <div className={styles.left}>
            <span className={styles.num}>{String(i + 1).padStart(2, "0")}</span>
            <div>
              <div className={styles.title}>{c.title}</div>
              <div className={styles.limit}>{c.limit}</div>
            </div>
          </div>
          <div className={styles.fix}>{c.fix}</div>
        </div>
      ))}
    </section>
  );
}
