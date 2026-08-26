"use client";

import { useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { DrawTimeline } from "@/components/DrawTimeline";
import { TreeWalk } from "@/components/TreeWalk";
import { Pot3D } from "@/components/Pot3D";
import { useDraws } from "@/hooks/useDraws";
import { useLastDraw, usePoolState } from "@/hooks/usePoolState";
import { useVerifyDraw } from "@/hooks/useVerifyDraw";
import { formatUnits } from "@/lib/format";
import styles from "./draws.module.css";

export default function DrawsTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { draws, totalPaid } = useDraws(state.drawCount);
  const { verify, results, step, error, verifying, done } = useVerifyDraw();

  const [selected, setSelected] = useState(0);

  const draw = draws[selected];
  const pot = lastDraw ? lastDraw.prize : 0n;
  const allPassed = done && results.every((r) => r.ok);

  return (
    <>
      <Pot3D variant="exhibit" dim />
      <AppHeader pot={pot} sponsored={state.sponsoredThisDraw} />

      <main className={`${styles.page} rise`}>
        {/* summary band --------------------------------------------------- */}
        <section className={styles.summary}>
          <div className={`${styles.paid} yellowBand`}>
            <div className={styles.paidKicker}>PAID OUT · {draws.length} SETTLED DRAWS</div>
            <div className={`num ${styles.paidValue}`}>{formatUnits(totalPaid)} cUSDT</div>
            <div className={styles.paidNote}>EVERY DRAW BELOW IS REPLAYABLE FROM PUBLIC STATE</div>
          </div>

          <div className={styles.facts}>
            <Fact label="WINNERS RESOLVED ON-CHAIN" value="0" accent />
            <Fact label="TRANSACTIONS PER DRAW" value="2" />
            <Fact label="CLAIM WINDOW" value="30 days" />
          </div>
        </section>

        {draws.length === 0 ? (
          <section className="panel">
            <div className="panelHead">
              <span>DRAWS</span>
              <span>0 SETTLED</span>
            </div>
            {/* Even with no history there is a draw underway, and saying so is more useful
                than an empty panel. */}
            <div className={styles.live}>
              <span className={styles.liveId}>
                <span className="liveDot" /> #0
              </span>
              <span className={styles.liveState}>
                {state.drawPending ? "IN FLIGHT" : state.periodEnded ? "READY TO OPEN" : "OPEN FOR DEPOSITS"}
              </span>
            </div>
            <div className={styles.empty}>
              No draw has settled yet. The first one closes at the end of this period, and its receipt appears here the
              moment it does.
            </div>
          </section>
        ) : (
          <section className={styles.body}>
            {/* sidebar --------------------------------------------------- */}
            <aside className={`panel ${styles.sidebar}`}>
              <div className="panelHead">
                <span>DRAWS</span>
                <span>{draws.length} SETTLED</span>
              </div>

              {/* The draw currently underway has no record to show — `draws[id]` is not
                  written until settlement — so it was invisible here, and the page read as
                  history with no present tense. This is that missing row. */}
              <div className={styles.live}>
                <span className={styles.liveId}>
                  <span className="liveDot" /> #{Number(state.drawCount)}
                </span>
                <span className={styles.liveState}>
                  {state.drawPending ? "IN FLIGHT" : state.periodEnded ? "READY TO OPEN" : "OPEN FOR DEPOSITS"}
                </span>
              </div>

              {draws.map((d, i) => (
                <button
                  key={String(d.id)}
                  className={i === selected ? `${styles.row} ${styles.rowActive}` : styles.row}
                  onClick={() => setSelected(i)}
                >
                  <span className={styles.rowId}>#{String(d.id)}</span>
                  <span className={styles.rowPot}>{formatUnits(d.prize)}</span>
                </button>
              ))}
              <div className={styles.sidebarNote}>
                No winner column. The draw never resolves a name on-chain — the missing data is the product working.
              </div>
            </aside>

            {/* receipt --------------------------------------------------- */}
            <div className={`panel ${styles.receipt}`}>
              <div className={styles.receiptHead}>
                <div>
                  <div className={styles.receiptKicker}>PUBLIC · ANYONE CAN REPLAY THIS</div>
                  <h1 className={`editorial ${styles.receiptTitle}`}>Draw #{String(draw.id)}, as a receipt</h1>
                </div>
                <div className={styles.awarded}>
                  <div className={styles.receiptKicker}>Pot awarded</div>
                  <div className={`num ${styles.awardedValue}`}>{formatUnits(draw.prize)}</div>
                </div>
              </div>

              <p className={styles.intro}>
                No randomness oracle. The network rolled an encrypted die on-chain, in the settling transaction, and
                combined it with the committed state of every depositor. The pool total below is the only figure this
                draw made public — and it is an aggregate, not anybody&apos;s balance.
              </p>

              <DrawTimeline drawId={draw.id} isLatest={selected === 0} />

              {/* local verification — real read-only calls, no wallet involved */}
              <div className={styles.verify}>
                <div className={styles.verifyStatus}>
                  {error
                    ? error
                    : done
                      ? allPassed
                        ? "Five of five recomputed against the chain. The stored record, the committed die, the prize formula and the deployed code all agree — and the code holds no winner to ask for."
                        : "One or more checks disagreed with the chain. Details below."
                      : verifying
                        ? `Reading the chain… ${step + 1} of 4`
                        : "Nothing here is taken on trust. These are plain read-only calls to a public node — run them yourself with cast if you prefer."}
                </div>
                <button
                  className="btnOutlineYellow"
                  onClick={() => verify(draw.id, { total: draw.total, prize: draw.prize, drawPoint: draw.drawPoint })}
                  disabled={verifying}
                >
                  {verifying ? `Checking ${step + 1} of 5…` : done ? "Verify again" : "Verify this draw locally"}
                </button>
                <div className={styles.verifyRail}>
                  <span className={styles.verifyFill} style={{ width: `${Math.max(0, step) * 20}%` }} />
                </div>
              </div>

              {/* what was actually checked */}
              <div className={styles.rows}>
                {results.length === 0 ? (
                  <div className={styles.pending}>
                    Five checks are available: the stored record, the committed die, the prize formula, the deployed
                    bytecode, and whether the code exposes any way at all to ask who won. None has been run yet.
                  </div>
                ) : (
                  results.map((r) => (
                    <div
                      key={r.label}
                      className={styles.receiptRow}
                      style={{ borderColor: r.ok ? "var(--yellow)" : "#ff8a7a" }}
                    >
                      <div>
                        <div className={styles.rowLabel}>{r.label}</div>
                        <div className={styles.rowNote}>{r.question}</div>
                        <div className={styles.stamp} style={{ color: r.ok ? "var(--yellow)" : "#ff8a7a" }}>
                          {r.ok ? "RECOMPUTED · AGREES" : "DISAGREES"}
                        </div>
                      </div>
                      <div className={styles.rowValue}>
                        {r.value}
                        {r.detail && <span className={styles.rowDetail}>{r.detail}</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* The prefix walk is how bands work in general, not a fact about this draw —
                it was making one panel carry two jobs. */}
            <div className={`panel ${styles.wide}`}>
              <div className="panelHead">
                <span>HOW A BAND IS LOCATED · THE PREFIX WALK</span>
                <span>{state.depositors} SLOTS</span>
              </div>
              <div className={styles.walkBody}>
                <TreeWalk slotsUsed={state.depositors} />
              </div>
            </div>

            {/* What the receipt cannot answer, kept apart from what it can. */}
            <div className={`panel ${styles.wide}`}>
              <div className="panelHead">
                <span>WHAT THESE CHECKS CANNOT TELL YOU</span>
                <span>2</span>
              </div>
              <div className={styles.limits}>
                <strong>Who won</strong> — not hidden, but never computed by anything, so there is nothing to recompute.
                <br />
                <strong>Whether the die was unbiased</strong> — that rests on the network&apos;s own generator and the
                published source, not on any figure in this receipt.
              </div>

              <div className={`${styles.anon} yellowBand`}>
                <div className={styles.anonKicker}>THE ANONYMITY SET</div>
                <div className={`editorial ${styles.anonBody}`}>
                  The winner is one of everyone in this pool. Not narrowed to a group, not known to the contract, not
                  known to us.
                </div>
              </div>

              <div className={styles.footTrio}>
                <Fact label="TRANSACTIONS" value="2" />
                <Fact label="NAMES RESOLVED" value="0" accent />
                <Fact label="PAID TO DATE" value={formatUnits(totalPaid)} />
              </div>
            </div>
          </section>
        )}
      </main>
    </>
  );
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue} style={{ color: accent ? "var(--yellow)" : undefined }}>
        {value}
      </span>
    </div>
  );
}
