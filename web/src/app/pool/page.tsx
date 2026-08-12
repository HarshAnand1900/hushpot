"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

import { AppHeader } from "@/components/AppHeader";
import { DepositSheet } from "@/components/DepositSheet";
import { DidIWin } from "@/components/DidIWin";
import { Pot3D } from "@/components/Pot3D";
import { useMyPosition } from "@/hooks/useMyPosition";
import { useLastDraw, useNow, usePoolState } from "@/hooks/usePoolState";
import { POOL_ADDRESS } from "@/lib/contract";
import { formatCountdown, formatUnits, shortenAddress, splitUnits } from "@/lib/format";
import styles from "./pool.module.css";

const MASK = "••••••";

export default function PoolTab() {
  const now = useNow();
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { isConnected } = useAccount();
  const { stage, position, error, reveal, isUnlocked } = useMyPosition();
  const [sheet, setSheet] = useState<"deposit" | "withdraw" | null>(null);

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

  // Odds use a FROZEN denominator — the total published at the last draw, never a live
  // one. With a live denominator anyone could divide their own odds into it and recover
  // the running pool total, and from that every individual deposit.
  const odds =
    isUnlocked && position.weight !== undefined && lastDraw && lastDraw.total > 0n
      ? (Number(position.weight) / Number(lastDraw.total)) * 100
      : undefined;

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
            <Pot3D size={172} />
            <span className={`${styles.seam} ${styles.seamRight}`} />
          </div>

          <div className={styles.yieldCell}>
            <div className={styles.yieldTop}>
              <div className={styles.yieldLabel}>
                <span className="liveDot" /> ACCRUED SO FAR · THIS PERIOD
              </div>
              <div className={`num ${styles.yieldValue}`}>+{formatUnits(accrued, 2)}</div>
              <div className={styles.yieldNote}>
                {state.annualRateBps ? `${Number(state.annualRateBps) / 100}% APY` : "—"} · SCALES WITH THE POOL
              </div>
            </div>

            <div className={styles.bars}>
              {Array.from({ length: 14 }, (_, i) => {
                const h = 42 + Math.abs(Math.sin(i * 1.7 + Number(state.currentPeriod))) * 58;
                const newest = i === 13;
                return (
                  <span
                    key={i}
                    className={styles.bar}
                    style={{
                      height: `${h}%`,
                      background: newest ? "var(--yellow)" : `rgba(255,210,8,${0.2 + 0.045 * i})`,
                    }}
                  />
                );
              })}
            </div>
            <div className={styles.yieldFoot}>
              <span>YIELD PER PERIOD · LAST 14</span>
              <span>PERIOD #{state.currentPeriod}</span>
            </div>
          </div>
        </section>

        {/* stat rail ------------------------------------------------------ */}
        <section className={styles.rail}>
          <Rail label="POOLED AT LAST DRAW" value={lastDraw ? formatUnits(lastDraw.total / 10080n) : "—"} />
          <Rail label="PRIZE LAST DRAW" value={lastDraw ? formatUnits(lastDraw.prize) : "—"} accent />
          <Rail label="DEPOSITORS" value={String(state.depositors)} />
        </section>

        {/* your position -------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>YOUR POSITION</span>
            <span style={{ color: isUnlocked ? "var(--yellow)" : undefined }}>
              {isUnlocked ? "DECRYPTED IN THIS TAB" : "ENCRYPTED ON-CHAIN"}
            </span>
          </div>

          <div className={styles.positionBody}>
            <div className={styles.posCell}>
              <div className={styles.posLabel}>BALANCE IN POOL</div>
              <div className={`num ${styles.posValue}`} style={{ color: isUnlocked ? "var(--white)" : "var(--masked)" }}>
                {isUnlocked && position.balance !== undefined ? formatUnits(position.balance) : MASK}
              </div>
              <div className={styles.posFoot}>
                {position.slot !== undefined ? `SLOT ${position.slot} · ` : ""}PRINCIPAL AT RISK{" "}
                <span style={{ color: "var(--yellow)" }}>NONE</span>
              </div>
            </div>

            <div className={styles.posCell}>
              <div className={styles.posLabel}>
                <span className="liveDot" /> ODDS · DRAW #{drawNumber}
              </div>
              <div className={`num ${styles.posValue}`} style={{ color: isUnlocked ? "var(--white)" : "var(--masked)" }}>
                {odds !== undefined ? `${odds.toFixed(2)}%` : MASK}
              </div>
              <div className={styles.posFoot}>
                {isUnlocked ? "measured against the pool at the last draw" : "computed here, never transmitted"}
              </div>
            </div>
          </div>

          {!isUnlocked && (
            <div className={styles.revealFooter}>
              <button className="btnPrimary" style={{ width: "100%" }} onClick={reveal} disabled={!isConnected || busy}>
                {!isConnected
                  ? "Connect a wallet to reveal"
                  : stage === "signing"
                    ? "Waiting for your signature…"
                    : stage === "computing"
                      ? "Recomputing on-chain… (two transactions)"
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
                One signature opens a session for this visit. Your balance is recomputed on-chain, then decrypted in
                this browser with a key that never leaves it.
              </div>
            </div>
          )}

          {isUnlocked && (
            <div className={styles.actions}>
              <button className="btnPrimary" style={{ flex: 1.3 }} onClick={() => setSheet("deposit")}>
                Put it in the pot
              </button>
              {/* Nothing in yet means nothing to take out. */}
              <button
                className="btnSecondary"
                style={{ flex: 1 }}
                onClick={() => setSheet("withdraw")}
                disabled={position.balance === 0n}
                title={position.balance === 0n ? "Deposit something first" : undefined}
              >
                Withdraw
              </button>
            </div>
          )}
        </section>

        {/* did I win ------------------------------------------------------ */}
        {lastDraw && state.drawCount > 0n && (
          <DidIWin
            drawId={state.drawCount - 1n}
            prize={lastDraw.prize}
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
          mode={sheet}
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
