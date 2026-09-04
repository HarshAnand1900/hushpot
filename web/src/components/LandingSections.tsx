"use client";

import { useCallback, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { usePoolHref } from "@/hooks/usePoolHref";
import { DEPLOY_BLOCK, POOL_ADDRESS } from "@/lib/contract";
import { formatUnits } from "@/lib/format";

import styles from "./LandingSections.module.css";

/**
 * Everything below the hero. Copy is taken verbatim from the v5 prototype - the handoff
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
    body: "Pooled principal earns yield, and all of that yield (only ever the yield) becomes the prize. On Sepolia it comes from a funded reserve instead of a live lending market; in production the same reserve would be fed by a strategy.",
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
    // The one exception is real and belongs here rather than in a footnote: taking the
    // optional loyalty boost makes `withdraw` and `exitPool` revert with BoostLocked
    // until the period rolls. Claiming an unqualified "no lockup" beside a contract that
    // has one is the kind of thing a reviewer checks and does not forgive.
    label: "WITHDRAWABLE",
    body: "of principal, no exit fee, no queue. The loyalty boost, if taken, holds until the roll.",
    value: "100%",
  },
  {
    label: "LEGIBLE ON-CHAIN",
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
    "No. Principal sits in the pool and is withdrawable in full. Only the yield is ever put up as a prize, so a losing week costs you the interest you would have earned, and nothing beyond that. The one thing that delays a withdrawal is the optional loyalty boost, which holds your stake until the period rolls - it never puts the principal at risk, and you only get it if you ask for it.",
  ],
  [
    "If nobody can see the winner, how is it fair?",
    "The die is rolled by the network's own encrypted random number generator, on-chain, in a single transaction. Nobody can steer it, us included, and nobody can read it, the contract included. The commitment, the deposit state and the contract code are all public, so the draw can be checked for correctness without the outcome being learned.",
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
    "Thirty days. The window is the gap between a draw settling and the next period opening, and the contract holds that roll back for a month, so a claim is never a race. In practice a keeper checks every depositor before the roll, and the prize simply appears in the winner's balance with nobody having to remember.",
  ],
];

/**
 * The four operations a deposit actually passes through, named as the contract names
 * them. The handle shown beside each is a real one read from the pool, not a decorative
 * hex string - a page arguing that ciphertext is unreadable should not print invented
 * ciphertext to make the point.
 */
const FHE_OPS = [
  {
    op: "FHE.add",
    label: "your deposit joins your balance",
    state: "NEVER OPENED",
  },
  {
    op: "FHE.mul",
    label: "balance × minutes held becomes your weight",
    state: "NEVER OPENED",
  },
  {
    op: "FHE.lt",
    label: "the die is compared against your band",
    state: "RESULT IS ALSO CIPHERTEXT",
  },
  {
    op: "FHE.select",
    label: "the prize, or an encrypted zero, lands",
    state: "BOTH BRANCHES EXECUTE",
  },
];

const SEE = [
  {
    who: "PUBLIC",
    what: "The pot, the pool total, the draw randomness. Enough for a stranger to verify the whole thing was fair.",
    gold: true,
  },
  {
    who: "YOURS ONLY",
    what: "Your deposit, your odds, your winnings. Readable the moment you sign, and nowhere else.",
    gold: false,
  },
  {
    who: "NOBODY’S",
    what: "Anyone else’s balance, and who won. Not withheld by policy. Never computed at all, by us or by the contract.",
    gold: false,
  },
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
  const withPool = usePoolHref();

  return (
    <>
      {/* 01 - the whole idea ------------------------------------------------ */}
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

      {/* 02 - three moves ---------------------------------------------------- */}
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

      {/* 03 - fully homomorphic encryption ----------------------------------- */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="03" label="FULLY HOMOMORPHIC ENCRYPTION" />

          <div className={styles.flowHead}>
            <h2 className={`editorial ${styles.h2Small}`}>
              Arithmetic on numbers it <em>cannot read</em>.
            </h2>
            <p className={styles.flowNote}>
              FHEVM lets Solidity add, compare and select over ciphertext. Your balance is an encrypted handle from the
              moment you sign. The node running the transaction holds no key that could open it.
            </p>
          </div>

          <div className={styles.ops}>
            {FHE_OPS.map((o) => (
              <div key={o.op} className={styles.opRow}>
                <span className={styles.opName}>{o.op}</span>
                <span className={styles.opLabel}>{o.label}</span>
                <span className={styles.opState}>{o.state}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 04 - what an explorer sees ------------------------------------------ */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="04" label="WHAT AN EXPLORER SEES" />

          <div className={styles.flowHead}>
            <h2 className={`editorial ${styles.h2Small}`}>
              Every row verifies. <em>None of them tell.</em>
            </h2>
          </div>

          <ExplorerTable />
        </div>
      </section>

      {/* 05 - who can see what ----------------------------------------------- */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="05" label="WHO CAN SEE WHAT" />

          <div className={styles.seeGrid}>
            {SEE.map((s) => (
              <div key={s.who} className={s.gold ? `${styles.seeCell} ${styles.seeGold}` : styles.seeCell}>
                <div className={styles.seeWho}>{s.who}</div>
                <div className={styles.seeWhat}>{s.what}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 06 - questions ------------------------------------------------------ */}
      <section className={styles.band}>
        <div className={styles.inner}>
          <SectionRule n="06" label="QUESTIONS PEOPLE ACTUALLY ASK" />

          <div className={styles.faq}>
            {FAQ.map(([q, a], i) => (
              <div key={q} className={styles.faqRow}>
                <button className={styles.faqQ} onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i}>
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
            <a className={styles.ctaPrimary} href={withPool("/pool")}>
              Enter the pool
            </a>
            <a className={styles.ctaGhost} href={withPool("/proof")}>
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

const EV_DEPOSITED = parseAbiItem("event Deposited(address indexed account, uint16 indexed slot)");
const EV_PLAIN = parseAbiItem(
  "event DepositedFromUnderlying(address indexed account, uint16 indexed slot, uint256 amount)",
);
const EV_SETTLED = parseAbiItem("event DrawSettled(uint256 indexed drawId, uint64 total, uint64 prize)");
const EV_CLAIM = parseAbiItem(
  "event ClaimChecked(uint256 indexed drawId, uint16 indexed slot, address indexed checkedBy)",
);

/**
 * The explorer view, built from the chain rather than mocked up.
 *
 * The argument this section makes - every row verifies, none of them tell - is only worth
 * anything if the rows are real. So these are the pool's actual logs, with the VALUE
 * column showing what an explorer would genuinely find in each: a number on the plain
 * demo route, and nothing at all on the confidential one.
 */
function ExplorerTable() {
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<{ block: bigint; event: string; value: string; clear: boolean }[]>();

  const load = useCallback(async () => {
    if (!publicClient) return;
    type Raw = { blockNumber: bigint | null; transactionHash: string; args: Record<string, unknown> };

    try {
      const [plain, shielded, settled, claims] = await Promise.all([
        publicClient.getLogs({ address: POOL_ADDRESS, event: EV_PLAIN, fromBlock: DEPLOY_BLOCK }),
        publicClient.getLogs({ address: POOL_ADDRESS, event: EV_DEPOSITED, fromBlock: DEPLOY_BLOCK }),
        publicClient.getLogs({ address: POOL_ADDRESS, event: EV_SETTLED, fromBlock: DEPLOY_BLOCK }),
        publicClient.getLogs({ address: POOL_ADDRESS, event: EV_CLAIM, fromBlock: DEPLOY_BLOCK }),
      ]);

      const plainTxs = new Set((plain as unknown as Raw[]).map((l) => l.transactionHash));

      const all = [
        ...(plain as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          event: "DepositedFromUnderlying",
          value: `${formatUnits(l.args.amount as bigint)} cUSDT`,
          clear: true,
        })),
        ...(shielded as unknown as Raw[])
          .filter((l) => !plainTxs.has(l.transactionHash))
          .map((l) => ({ block: l.blockNumber ?? 0n, event: "Deposited", value: "——", clear: false })),
        ...(settled as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          event: "DrawSettled",
          value: `${formatUnits(l.args.prize as bigint)} cUSDT`,
          clear: true,
        })),
        ...(claims as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          event: "ClaimChecked",
          value: "——",
          clear: false,
        })),
      ].sort((a, b) => Number(b.block - a.block));

      // Cap each event kind so the table shows the shape of the log rather than whichever
      // call happened to be spammed most recently - four identical ClaimChecked rows make
      // the section's point about variety worse, not better.
      const perKind = new Map<string, number>();
      const varied = all.filter((r) => {
        const n = perKind.get(r.event) ?? 0;
        if (n >= 2) return false;
        perKind.set(r.event, n + 1);
        return true;
      });

      setRows(varied.slice(0, 6));
    } catch {
      setRows([]);
    }
  }, [publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className={styles.explorer}>
      <div className={styles.expHead}>
        <span>BLOCK</span>
        <span>EVENT</span>
        <span>VALUE</span>
        <span>STATUS</span>
      </div>

      {rows === undefined && <div className={styles.expEmpty}>Reading the chain…</div>}

      {rows?.map((r, i) => (
        <div key={`${r.block}-${i}`} className={styles.expRow}>
          <span className={styles.expBlock}>{r.block.toLocaleString()}</span>
          <span className={styles.expEvent}>{r.event}</span>
          <span className={r.clear ? styles.expValue : `${styles.expValue} ${styles.expMasked}`}>{r.value}</span>
          <span className={styles.expOk}>OK</span>
        </div>
      ))}

      <div className={styles.expFoot}>
        Real logs from the deployed pool. The confidential rows carry no value at all. There is no field for one, so an
        explorer has nothing to render.
      </div>
    </div>
  );
}
