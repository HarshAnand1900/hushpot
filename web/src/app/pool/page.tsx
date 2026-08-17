"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { AppHeader } from "@/components/AppHeader";
import { DepositSheet } from "@/components/DepositSheet";
import { DidIWin } from "@/components/DidIWin";
import { PositionPanel } from "@/components/PositionPanel";
import { Pot3D } from "@/components/Pot3D";
import { useMyPosition } from "@/hooks/useMyPosition";
import { useDraws } from "@/hooks/useDraws";
import { useLastDraw, useNow, usePoolState } from "@/hooks/usePoolState";
import { POOL_ADDRESS } from "@/lib/contract";
import { formatCountdown, formatUnits, shortenAddress, splitUnits } from "@/lib/format";
import styles from "./pool.module.css";

export default function PoolTab() {
  const now = useNow();
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { draws } = useDraws(state.drawCount);
  const { isConnected } = useAccount();
  const { stage, position, error, reveal, needsSignature, isUnlocked } = useMyPosition();
  // "join" is deposit with the withdraw tab hidden: it is the way in for someone who
  // has nothing in yet, and withdrawing would need a decrypted balance to mean anything.
  const [sheet, setSheet] = useState<"deposit" | "withdraw" | "join" | null>(null);

  const drawNumber = Number(state.drawCount);
  const mounted = now > 0;
  const closesIn = Number(state.periodStart + state.periodSeconds) - now;
  const weekPct = Math.min(100, (Number(state.minuteOfPeriod) / 10080) * 100);

  // "This week's pot" is what gets paid at close, projected from the last published pool
  // total — never a live reading, which would leak deposits by subtraction. The share
  // accrued so far is shown separately rather than standing in for the whole thing.
  const pot = lastDraw ? lastDraw.prize : 0n;
  const accrued = (pot * BigInt(Math.floor(weekPct * 100))) / 10_000n;
  const potParts = splitUnits(pot);

  // Odds are computed inside PositionPanel, against a FROZEN denominator — the total
  // published at the last draw, never a live one. With a live denominator anyone could
  // divide their own odds into it and recover the running pool total, and from that
  // every individual deposit.
  const busy = stage === "signing" || stage === "computing" || stage === "decrypting";

  return (
    <>
      <Pot3D variant="exhibit" dim="faint" />
      <AppHeader pot={pot} />

      <main className={`${styles.page} rise`}>
        {/* status strip -------------------------------------------------- */}
        <div className={styles.status}>
          <span className={styles.chip}>
            <span className="liveDot" /> SEPOLIA
          </span>
          <span className={styles.chip}>PERIOD #{state.currentPeriod}</span>
          <span className={styles.chip}>MINUTE {String(state.minuteOfPeriod)} / 10080</span>
          <span className={styles.chip}>FHEVM · EUINT64</span>
          <span className={styles.statusRule} />
          <span className={styles.chip}>HUSHPOT {shortenAddress(POOL_ADDRESS)}</span>
        </div>

        {/* hero band ------------------------------------------------------ */}
        <section className={`${styles.hero} brackets bracketsLower`}>
          <div className={`${styles.potCell} yellowBand`}>
            <div className={styles.potKicker}>THE POT · DRAW #{drawNumber} · PROJECTED AT CLOSE</div>
            <div className={`num ${styles.potNumber}`}>
              {potParts.whole}
              <span className={styles.potFrac}>.{potParts.frac}</span>
            </div>
            <div className={styles.potUnit}>cUSDT · YIELD LANDS EVERY BLOCK</div>

            <div className={styles.tagline}>
              <div className="editorial">
                Nobody loses.
                <br />
                Somebody wins.
              </div>
              <div className={styles.taglineNote}>
                YOU PLAY THE INTEREST — NEVER THE MONEY.
                <br />
                EVERY DEPOSIT WITHDRAWS IN FULL.
              </div>
            </div>

            <div className={styles.potFooter}>
              <div>
                <div className={styles.potFootLabel}>CLOSES IN</div>
                <div className={`num ${styles.potCountdown}`} suppressHydrationWarning>
                  {mounted ? formatCountdown(closesIn) : "—"}
                </div>
              </div>
              <div className={styles.week}>
                <div className={styles.weekTrack}>
                  <div className={styles.weekFill} style={{ width: `${weekPct}%` }} />
                </div>
                <div className={styles.potFootLabel}>{weekPct.toFixed(0)}% THROUGH THE WEEK</div>
              </div>
            </div>
          </div>

          <div className={styles.niche}>
            <span className={styles.seam} />
            <span className={styles.shimmer} aria-hidden="true" />

            <div className={styles.nicheKicker}>
              ALL OF IT · TO ONE OF {state.depositors || "—"}
            </div>

            <Pot3D size={158} quiet />

            <div className={`editorial ${styles.nicheLine}`}>
              All this
              <br />
              can be yours.
            </div>
            <div className={styles.nicheSub}>and nobody need ever know it was</div>

            <button className={styles.nicheCta} onClick={() => setSheet("join")}>
              Take your shot
            </button>

            <span className={`${styles.seam} ${styles.seamRight}`} />
          </div>

          <div className={styles.yieldCell}>
            <div className={styles.yieldTop}>
              <div className={styles.yieldLabel}>
                <span className="liveDot" /> ACCRUED SO FAR · THIS PERIOD
              </div>
              <div className={`num ${styles.yieldValue}`}>+{formatUnits(accrued, 2)}</div>
              {/* Named for what it is. There is no ERC-4626 strategy behind this on Sepolia —
                  the reserve is funded directly — and the rate is read from the contract
                  rather than written into the page. */}
              <div className={styles.yieldNote}>
                {state.annualRateBps ? `${Number(state.annualRateBps) / 100}% APY` : "—"} · FUNDED RESERVE
              </div>
            </div>

            {/* Real prizes from settled draws. This was a sine wave dressed up as data —
                fabricated history on a page that asks people to verify everything else.
                Empty slots stay empty rather than inventing a shape. */}
            <div className={styles.bars}>
              {Array.from({ length: 14 }, (_, i) => {
                const recent = draws.slice(0, 14).reverse();
                const offset = 14 - recent.length;
                const d = i >= offset ? recent[i - offset] : undefined;
                const peak = recent.reduce((m, x) => (x.prize > m ? x.prize : m), 1n);
                const h = d ? Math.max(8, (Number(d.prize) / Number(peak)) * 100) : 0;
                const newest = d !== undefined && i === 13;

                return (
                  <span
                    key={i}
                    className={styles.bar}
                    style={{
                      height: d ? `${h}%` : "3%",
                      background: !d
                        ? "rgba(255,255,255,.06)"
                        : newest
                          ? "var(--yellow)"
                          : `rgba(255,210,8,${0.3 + 0.03 * i})`,
                    }}
                    title={d ? `Draw #${d.id} · ${formatUnits(d.prize)} cUSDT` : "no draw yet"}
                  />
                );
              })}
            </div>
            <div className={styles.yieldFoot}>
              <span>PRIZE PER DRAW · {draws.length} SETTLED</span>
              <span>PERIOD #{state.currentPeriod}</span>
            </div>
          </div>
        </section>

        {/* stat rail ------------------------------------------------------ */}
        <section className={styles.rail}>
          <Rail label="POOLED PRINCIPAL" value={lastDraw ? formatUnits(lastDraw.total / 10080n) : "—"} />
          <Rail
            label="PRIZES PAID"
            value={formatUnits(draws.reduce((sum, d) => sum + d.prize, 0n))}
            accent
          />
          <Rail label="DRAWS SETTLED" value={String(draws.length)} />
          <Rail label="DEPOSITORS" value={String(state.depositors)} />
        </section>

        {/* your position -------------------------------------------------- */}
        <PositionPanel
          balance={position.balance}
          weight={position.weight}
          slot={position.slot}
          isUnlocked={isUnlocked}
          drawNumber={drawNumber}
          poolTotal={lastDraw?.total}
          minuteOfPeriod={state.minuteOfPeriod}
          onDeposit={() => setSheet("deposit")}
          onWithdraw={() => setSheet("withdraw")}
        >
          <div className={styles.revealFooter}>
            <button className="btnPrimary" style={{ width: "100%" }} onClick={reveal} disabled={!isConnected || busy}>
              {!isConnected
                ? "Connect a wallet to reveal"
                : stage === "signing"
                  ? "Waiting for your signature…"
                  : stage === "computing"
                    ? "Recomputing on-chain…"
                    : stage === "decrypting"
                      ? "Decrypting locally with your key…"
                      : "Reveal my position · 1 signature"}
            </button>
            {busy && (
              <div className={styles.sweepTrack}>
                <span className={styles.sweep} />
              </div>
            )}
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.revealNote}>
              One signature opens a session for this visit. Your balance is recomputed on-chain, then decrypted in this
              browser with a key that never leaves it.
            </div>
          </div>
        </PositionPanel>

        {/* did I win ------------------------------------------------------ */}
        {draws.length > 0 && (
          <DidIWin
            draws={draws.map((d) => ({ id: d.id, prize: d.prize, period: Number(d.period) }))}
            currentPeriod={state.currentPeriod}
            balanceBefore={position.balance}
            unlocked={isUnlocked}
            onClaimed={() => state.refetch()}
          />
        )}

        {/* draw engine ---------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>DRAW ENGINE · #{drawNumber}</span>
            <span style={{ color: state.drawPending ? "var(--yellow)" : undefined }}>
              {state.drawPending ? "IN FLIGHT" : state.periodEnded ? "ARMED" : "SEALED UNTIL CLOSE"}
            </span>
          </div>
          <div className={styles.engine}>
            <EngineCell
              label="COMMITMENT"
              note="the pool total is sealed and published for decryption"
              done={state.drawPending || drawNumber > 0}
              active={state.drawPending}
            />
            <EngineCell
              label="ENCRYPTED DIE"
              note="the network rolls it on-chain, in the settling tx"
              done={drawNumber > 0 && !state.drawPending}
              active={false}
            />
            <EngineCell
              label="SETTLEMENT"
              note="FHE.select moves the pot, branchlessly"
              done={drawNumber > 0 && !state.drawPending}
              active={false}
            />
          </div>
          <div className={styles.engineFoot}>
            One round closes the week: the pool is sealed, the network rolls an encrypted die, and the pot moves
            without ever resolving a name.
          </div>
        </section>
      </main>

      {sheet && (
        <DepositSheet
          mode={sheet === "join" ? "deposit" : sheet}
          lockMode={sheet === "join"}
          drawNumber={drawNumber}
          inPool={position.balance}
          onClose={() => setSheet(null)}
          onDone={() => {
            state.refetch();
            void reveal();
          }}
        />
      )}
    </>
  );
}

function Rail({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={styles.railCell}>
      <div className={styles.railLabel}>{label}</div>
      <div className={styles.railValue} style={{ color: accent ? "var(--yellow)" : undefined }}>
        {value}
      </div>
    </div>
  );
}

function EngineCell({ label, note, done, active }: { label: string; note: string; done: boolean; active: boolean }) {
  return (
    <div className={styles.engineCell} style={{ background: active ? "rgba(255,210,8,.07)" : undefined }}>
      <div className={styles.engineTop}>
        <span>{label}</span>
        <span style={{ color: done || active ? "var(--yellow)" : "var(--text-4)" }}>
          {done ? "OK" : active ? "···" : "—"}
        </span>
      </div>
      <div className={styles.engineRail}>
        <span className={styles.engineFill} style={{ width: done ? "100%" : active ? "58%" : "0%" }} />
      </div>
      <div className={styles.engineNote}>{note}</div>
    </div>
  );
}
