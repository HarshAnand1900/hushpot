"use client";

import { useState } from "react";

import styles from "./LandingSections.module.css";

/**
 * Everything below the hero. Copy is taken verbatim from the v5 prototype — the handoff
 * says to reuse it rather than rewrite, and it is better than anything I'd substitute.
 */

// Lattice cells. One green cell per grid is the point of each thumbnail: the deposit that
// can't be picked out, the interest that becomes the pot, the address nobody learns.
const CELL = {
  dark: { bg: "transparent", border: "rgba(255,255,255,.16)" },
  mid: { bg: "rgba(255,255,255,.07)", border: "rgba(255,255,255,.26)" },
  gold: { bg: "rgba(255,210,8,.22)", border: "rgba(255,210,8,.55)" },
  green: { bg: "rgba(18,185,129,.85)", border: "#12B981" },
} as const;

type Cell = (typeof CELL)[keyof typeof CELL];

const FLOW: { tag: string; title: string; body: string; cols: number; gap: string; cells: Cell[] }[] = [
  {
    tag: "01",
    title: "Deposit, encrypted",
    body: "Your amount is encrypted in the browser. The contract receives a handle it can store and add to, never a number it can read.",
    cols: 5,
    gap: "10px",
    cells: Array.from({ length: 15 }, (_, i) => (i === 7 ? CELL.green : CELL.gold)),
  },
  {
    tag: "02",
    title: "Yield builds the pot",
    body: "Pooled principal earns yield, and all of that yield — only ever the yield — becomes the prize. On Sepolia it comes from a funded reserve rather than a live lending market; in production the same reserve would be fed by a strategy.",
    cols: 6,
    gap: "8px",
    cells: Array.from({ length: 18 }, (_, i) => (i % 5 === 0 ? CELL.gold : i % 3 === 0 ? CELL.mid : CELL.dark)),
  },
  {
    tag: "03",
    title: "One address wins",
    body: "The network rolls an encrypted die on-chain and moves the pot. The winner is never resolved on-chain, by anyone.",
    cols: 4,
    gap: "12px",
    cells: Array.from({ length: 16 }, (_, i) => (i === 9 ? CELL.green : CELL.dark)),
  },
];

const TERMS: { label: string; body: string; value: string; accent?: boolean }[] = [
  {
    label: "WITHDRAWABLE",
    body: "of principal, any second. No lockup, no exit fee, no queue.",
    value: "100%",
  },
  {
    label: "LEGIBLE ON—CHAIN",
    body: "balances, to anyone, at any block. Ciphertext all the way down.",
    value: "0",
  },
  {
    label: "WAITING PERIOD",
    body: "before you earn odds. Your deposit starts working the minute it arrives.",
    value: "0s",
    accent: true,
  },
];

const FAQ: [string, string][] = [
  [
    "Can I lose my deposit?",
    "No. Principal sits in the pool and is withdrawable in full at any time. Only the yield is ever put up as a prize, so a losing week costs you the interest you would have earned — nothing more.",
  ],
  [
    "If nobody can see the winner, how is it fair?",
    "The die is rolled by the network's own encrypted random number generator, on-chain, in a single transaction. Nobody can steer it — including us — and nobody can read it, including the contract. The commitment, the deposit state and the contract code are all public, so anyone can check the draw ran correctly without learning the outcome.",
  ],
  [
    "What can my wallet provider or a block explorer see?",
    "That you interacted with the contract, and a ciphertext handle. Not your balance, not your odds, not whether you won. Amounts never exist in plaintext outside your own browser.",
  ],
  [
    "When does my deposit start earning odds?",
    "The minute it lands. Odds are weighted by amount and by time held, so money that arrived on Sunday earns roughly twice the odds of the same amount arriving on Wednesday. Deposit once and you are entered in every draw until you withdraw.",
  ],
  [
    "What happens if a winner never claims?",
    "Thirty days. The window is the gap between a draw settling and the next period opening, and the contract holds that roll back for a month — so a claim is never a race. In practice a keeper sweeps every depositor before the roll, and the prize simply appears in the winner's balance without anyone having to remember.",
  ],
];

function SectionRule({ n, label }: { n: string; label: string }) {
  return (
    <div className={styles.rule}>
      <span className={styles.ruleNum}>{n}</span>
      <span className={styles.ruleLine} />
      <span className={styles.ruleLabel}>{label}</span>
    </div>
  );
}

export function LandingSections() {
  const [open, setOpen] = useState(0);

  return (
    <>
      {/* 01 — the whole idea ------------------------------------------------ */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="01" label="THE WHOLE IDEA" />

          <div className={styles.ideaGrid}>
            <div>
              <h2 className={`editorial ${styles.h2}`}>
                Save your money. <em>Win the interest.</em> Tell nobody.
              </h2>

              <p className={styles.lede}>
                <span className={styles.dropcap}>D</span>
                eposits pool together and earn yield in a lending market. Every week the entire yield goes to one
                depositor at random, weighted by what they put in. Your principal is never at stake, and no amount is
                ever legible on&#8209;chain.
              </p>

              <div className={styles.chips}>
                <span className={`${styles.chip} ${styles.chipGold}`}>PRINCIPAL SAFE</span>
                <span className={styles.chip}>AMOUNTS ENCRYPTED</span>
                <span className={styles.chip}>WINNER UNNAMED</span>
                <span className={styles.chip}>ODDS FROM MINUTE ONE</span>
              </div>
            </div>

            <div className={styles.terms}>
              <div className={styles.termsHead}>
                <span>THE TERMS, PLAINLY</span>
                <span className={styles.termsSer}>SER. 0x4C1E</span>
              </div>
              {TERMS.map((t) => (
                <div key={t.label} className={styles.termRow}>
                  <div className={styles.termCopy}>
                    <div className={t.accent ? `${styles.termLabel} ${styles.termLabelGold}` : styles.termLabel}>
                      {t.label}
                    </div>
                    <div className={styles.termBody}>{t.body}</div>
                  </div>
                  <div className={`editorial ${styles.termValue} ${t.accent ? styles.termValueGold : ""}`}>
                    {t.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 02 — three moves ---------------------------------------------------- */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="02" label="THREE MOVES · NONE OF THEM LEAK" />

          <div className={styles.flowHead}>
            <h2 className={`editorial ${styles.h2Small}`}>
              Everything happens <em>inside</em> the contract.
            </h2>
            <p className={styles.flowNote}>
              No relayer, no off&#8209;chain matcher, no operator holding a spreadsheet of who deposited what.
            </p>
          </div>

          <div className={styles.flow}>
            {FLOW.map((s) => (
              <div key={s.tag} className={styles.flowRow}>
                <div className={`editorial ${styles.flowTag}`}>{s.tag}</div>
                <div>
                  <div className={`editorial ${styles.flowTitle}`}>{s.title}</div>
                  <div className={styles.flowBody}>{s.body}</div>
                </div>
                <div className={styles.latticeWrap}>
                  <div className={styles.lattice} style={{ gridTemplateColumns: `repeat(${s.cols},1fr)`, gap: s.gap }}>
                    {s.cells.map((c, i) => (
                      <span key={i} className={styles.cell} style={{ background: c.bg, borderColor: c.border }} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 03 — questions ------------------------------------------------------ */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="03" label="THE OBVIOUS QUESTIONS" />

          <div className={styles.faq}>
            {FAQ.map(([q, a], i) => (
              <div key={q} className={styles.faqRow}>
                <button
                  className={styles.faqQ}
                  onClick={() => setOpen(open === i ? -1 : i)}
                  aria-expanded={open === i}
                >
                  <span>{q}</span>
                  <span className={styles.faqSign}>{open === i ? "−" : "+"}</span>
                </button>
                {open === i && <div className={styles.faqA}>{a}</div>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* closing ------------------------------------------------------------- */}
      <section className={styles.closing}>
        <div className={styles.inner}>
          <h2 className={`editorial ${styles.closingH}`}>
            Nobody loses. <em>Somebody wins.</em>
          </h2>
          <p className={styles.closingP}>
            Deposit what you like, take it back whenever you like, and let the interest decide. On Sepolia, with test
            tokens, so it costs nothing to see it work.
          </p>
          <div className={styles.closingCtas}>
            <a className={styles.ctaPrimary} href="/pool">
              Enter the pool
            </a>
            <a className={styles.ctaGhost} href="/proof">
              See what leaks
            </a>
          </div>
          <div className={styles.closingSerial}>
            AMOUNTS ENCRYPTED · WINNER UNNAMED · ZAMA FHEVM · COMPUTED ON CIPHERTEXT
          </div>
        </div>
      </section>
    </>
  );
}
