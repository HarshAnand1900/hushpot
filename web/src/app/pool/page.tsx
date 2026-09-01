"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import Link from "next/link";

import { AppHeader, FAUCET_EVENT } from "@/components/AppHeader";
import { DepositSheet } from "@/components/DepositSheet";
import { DidIWin } from "@/components/DidIWin";
import { ContractLog } from "@/components/ContractLog";
import { PositionHistory } from "@/components/PositionHistory";
import { PositionPanel } from "@/components/PositionPanel";
import { Pot3D } from "@/components/Pot3D";
import { useMyPosition } from "@/hooks/useMyPosition";
import { useDraws } from "@/hooks/useDraws";
import { usePoolHref } from "@/hooks/usePoolHref";
import { poolPhase } from "@/hooks/usePoolPhase";
import { useLastDraw, useNow, usePoolState, useWeeklyPot } from "@/hooks/usePoolState";
import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { formatCountdown, formatUnits, shortenAddress, splitUnits } from "@/lib/format";
import styles from "./pool.module.css";

export default function PoolTab() {
  const now = useNow();
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { draws } = useDraws(state.drawCount);
  // Built once per change of `draws` rather than once per render. This page polls, and
  // handing a freshly-built array down on every tick re-fired the panel's reads and made
  // it flicker between the answer and its loading state.
  const checkable = useMemo(() => draws.map((d) => ({ id: d.id, prize: d.prize, period: Number(d.period) })), [draws]);
  const { isConnected } = useAccount();
  const { stage, position, error, reveal, lock, isUnlocked } = useMyPosition();
  // "join" is deposit with the withdraw tab hidden: it is the way in for someone who
  // has nothing in yet, and withdrawing would need a decrypted balance to mean anything.
  const [sheet, setSheet] = useState<"deposit" | "withdraw" | "join" | null>(null);

  // The header's Faucet button lands here. Read from location rather than useSearchParams,
  // which would opt this page out of static prerendering for one query flag.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("faucet") === "1") {
      setSheet("join");
      window.history.replaceState(null, "", "/pool");
    }

    // Clicking Faucet while already on this page is a same-page navigation: React
    // re-renders without remounting, so the query check above never runs a second time
    // and the button looked completely dead. The event does not depend on routing.
    const open = () => setSheet("join");
    window.addEventListener(FAUCET_EVENT, open);
    return () => window.removeEventListener(FAUCET_EVENT, open);
  }, []);

  const drawNumber = Number(state.drawCount);
  const mounted = now > 0;
  const closesIn = Number(state.periodStart + state.periodSeconds) - now;
  const weekPct = Math.min(100, (Number(state.minuteOfPeriod) / 10080) * 100);

  // "This week's pot" is what gets paid at close, projected from the last published pool
  // total — never a live reading, which would leak deposits by subtraction. The share
  // accrued so far is shown separately rather than standing in for the whole thing.
  // What the last draw actually paid — not a forecast of the next one.
  //
  // Shared with every other tab, so the header never disagrees with itself.
  const { pot, yieldEstimate, lastPaid } = useWeeklyPot(state, lastDraw);
  const phase = poolPhase(state, lastDraw);

  // How much of that pot the week has earned so far. Sponsorship is already banked in
  // full, so only the yield half accrues.
  const accrued = (yieldEstimate * BigInt(Math.floor(weekPct * 100))) / 10_000n + state.sponsoredThisDraw;
  const potParts = splitUnits(pot);

  // Odds are computed inside PositionPanel, against a FROZEN denominator — the total
  // published at the last draw, never a live one. With a live denominator anyone could
  // divide their own odds into it and recover the running pool total, and from that
  // every individual deposit.
  const busy = stage === "signing" || stage === "computing" || stage === "decrypting";

  return (
    <>
      {/* No full-viewport 3D exhibit here, deliberately.
      
          Pool is the page where every transaction happens, and a second three.js renderer
          covering the viewport was competing with FHE encryption for the main thread —
          the deposit freeze. The global CSS backdrop in layout.tsx already provides the
          glow; the pot that matters is the interactive one in the hero, which is small and
          cheap. Draws and Proof keep the exhibit: nothing blocking happens there. */}
      <div className="warmGlow" aria-hidden="true" />
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
          {/* Which pool this tab points at is a client-side reading of the URL, and React
              does not patch text it hydrated from the server. Held back until mounted, so
              the chip never names one pool while the rest of the page reads another. */}
          <span className={styles.chip} suppressHydrationWarning>
            HUSHPOT {mounted ? shortenAddress(POOL_ADDRESS) : "…"}
          </span>
        </div>

        {/* hero band ------------------------------------------------------ */}
        <section className={`${styles.hero} brackets bracketsLower`}>
          <div className={`${styles.potCell} yellowBand`}>
            {/* Two numbers live here and they are not the same draw: the label is the one
                coming next, the figure is what the last one actually paid. Saying only
                "PUBLIC BY DESIGN" left that unexplained and read as a contradiction
                against PERIOD #0 in the status strip. */}
            <div className={styles.potKicker}>
              {drawNumber > 0
                ? `THIS WEEK'S POT · DRAW #${drawNumber} · ESTIMATED FROM PUBLIC FIGURES`
                : "THE POT · DRAW #0 · PUBLIC BY DESIGN"}
            </div>
            {/* An em dash, not 0.00: with no settled draw and nothing sponsored there is
                no published total to estimate from, so there is no pot yet rather than an
                empty one. See useWeeklyPot. */}
            <div className={`num ${styles.potNumber}`}>
              {pot > 0n ? (
                <>
                  {potParts.whole}
                  <span className={styles.potFrac}>.{potParts.frac}</span>
                </>
              ) : (
                "—"
              )}
            </div>
            <div className={styles.potUnit}>
              {drawNumber > 0
                ? `cUSDT · YIELD + ${formatUnits(state.sponsoredThisDraw)} SPONSORED · DRAW #${drawNumber - 1} PAID ${formatUnits(lastPaid)}`
                : pot > 0n
                  ? `cUSDT · ${formatUnits(state.sponsoredThisDraw)} SPONSORED · NO YIELD BASIS UNTIL DRAW #0 SETTLES`
                  : "cUSDT · NO DRAW HAS SETTLED YET, SO THERE IS NOTHING TO ESTIMATE FROM"}
            </div>

            <div className={styles.tagline}>
              <div className="editorial">
                Nobody loses.
                <br />
                Somebody wins.
              </div>
              <div className={styles.taglineNote}>
                YOU PLAY THE INTEREST, NEVER THE MONEY.
                <br />
                EVERY DEPOSIT WITHDRAWS IN FULL.
              </div>
            </div>

            {/* Between draws the pool looks stalled from outside: the countdown is spent,
                the pot does not move, and nothing admits a draw is halfway settled. */}
            <div className={styles.phase} data-phase={phase.id}>
              <span className={styles.phaseTag}>
                <span className={styles.phaseDot} aria-hidden="true" />
                {phase.tag}
              </span>
              <div className={styles.phaseBody}>
                <div className={styles.phaseHeadline}>{phase.headline}</div>
                <div className={styles.phaseDetail}>{phase.detail}</div>
              </div>
            </div>

            <div className={styles.potFooter}>
              <div>
                <div className={styles.potFootLabel}>{phase.countdownMeaningful ? "CLOSES IN" : "WEEK ENDED"}</div>
                <div className={`num ${styles.potCountdown}`} suppressHydrationWarning>
                  {!mounted ? "—" : phase.countdownMeaningful ? formatCountdown(closesIn) : "0d 0h 0m"}
                </div>
              </div>
              <div className={styles.week}>
                <div className={styles.weekTrack}>
                  <div className={styles.weekFill} style={{ width: `${phase.countdownMeaningful ? weekPct : 100}%` }} />
                </div>
                <div className={styles.potFootLabel}>
                  {phase.countdownMeaningful ? `${weekPct.toFixed(0)}% THROUGH THE WEEK` : "AWAITING THE NEXT PERIOD"}
                </div>
              </div>
            </div>
          </div>

          {/* The pot on its plinth: v6's glow and contact shadow, with the glint, the
              line and the way in that the cell had before. It is the only object on the
              page anyone wants to touch, so it carries the invitation too. */}
          <div className={styles.niche}>
            <span className={styles.seam} />
            <span className={styles.nicheGlow} aria-hidden="true" />
            <span className={styles.shimmer} aria-hidden="true" />

            <div className={styles.nicheKicker}>ALL OF IT · TO ONE OF {state.depositors || "—"}</div>

            <div className={styles.potWindow}>
              <Pot3D size={158} quiet quips />
            </div>
            <span className={styles.potShadow} aria-hidden="true" />

            <div className={styles.nicheDrag}>CLICK IT · DRAG TO TURN</div>

            <div className={`editorial ${styles.nicheLine}`}>
              All this
              <br />
              can be yours.
            </div>

            <button className={styles.nicheCta} onClick={() => setSheet("join")}>
              Take your shot
            </button>

            <span className={`${styles.seam} ${styles.seamRight}`} />
          </div>

          <div className={styles.yieldCell}>
            <div className={styles.yieldTop}>
              <div className={styles.yieldLabel}>
                <span className="liveDot" /> BUILDING TOWARD DRAW #{drawNumber}
              </div>
              <div className={`num ${styles.yieldValue}`}>+{formatUnits(accrued, 2)}</div>
              {/* Derived from the same figures the contract uses, not invented: the pot for
                  a full period divided by the blocks in one. */}
              <div className={styles.perBlock}>
                +{formatUnits(pot / BigInt(Math.max(1, Math.floor(Number(state.periodSeconds) / 12))), 4)} PER BLOCK ·
                EVERY 12s
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
              <span>PRIZE PER DRAW · LAST 14</span>
              <span className={styles.yieldFootHi}>PERIOD #{state.currentPeriod}</span>
            </div>

            {/* v6 shows STRATEGY / NET APY at the foot of this cell. There is no ERC-4626
                vault on Sepolia, since the reserve is funded directly, so the strategy is named
                for what it actually is rather than borrowing a label it has not earned. */}
            <div className={styles.yieldStrat}>
              <span>
                STRATEGY <span className={styles.stratV}>FUNDED RESERVE</span>
              </span>
              <span>
                NET APY{" "}
                <span className={styles.stratV}>
                  {state.annualRateBps ? `${(Number(state.annualRateBps) / 100).toFixed(2)}%` : "—"}
                </span>
              </span>
            </div>
          </div>
        </section>

        {/* stat rail ------------------------------------------------------ */}
        <section className={styles.rail}>
          <Rail label="POOLED PRINCIPAL" value={lastDraw ? formatUnits(lastDraw.total / 10080n) : "—"} />
          <Rail label="PRIZES PAID" value={formatUnits(draws.reduce((sum, d) => sum + d.prize, 0n))} accent />
          <Rail label="DRAWS SETTLED" value={String(draws.length)} />
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
          onLock={lock}
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
          <CloseDraw periodEnded={state.periodEnded} drawPending={state.drawPending} onDone={() => state.refetch()} />
        </section>

        {/* v6 pairs the personal question with the public record, side by side: the
            log is the evidence that answering it left nothing behind. */}
        <section className={styles.pair}>
          <div>
            {draws.length > 0 && (
              <DidIWin
                draws={checkable}
                currentPeriod={state.currentPeriod}
                unlocked={isUnlocked}
                onClaimed={() => state.refetch()}
              />
            )}
          </div>
          <ContractLog limit={12} />
        </section>
        <PositionHistory drawCount={state.drawCount} slot={position.slot} />
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

/**
 * Closing the week, from the app rather than from a console.
 *
 * `openDraw` is permissionless by design — a pool whose draw only its operator can start
 * is a pool whose operator can stall it — so the button belongs here, where depositors
 * are, and not only on the Judge tab.
 *
 * Settlement is the second half and needs a decryption proof fetched from the relayer,
 * which is a flow rather than a button; it lives on Judge, and this points there once the
 * total is sealed.
 */
function CloseDraw({
  periodEnded,
  drawPending,
  onDone,
}: {
  periodEnded: boolean;
  drawPending: boolean;
  onDone: () => void;
}) {
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const withPool = usePoolHref();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await writeContractAsync({ address: POOL_ADDRESS, abi: poolAbi, functionName: "openDraw" });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 140) : "Could not close the draw.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.engineFoot}>
      <span>
        One round closes the week: the pool is sealed, the network rolls an encrypted die, and the pot moves without
        ever resolving a name.
      </span>

      {drawPending ? (
        <Link className="btnOutlineYellow" href={withPool("/judge")}>
          Sealed · settle it on Judge
        </Link>
      ) : (
        <button className="btnOutlineYellow" onClick={close} disabled={!isConnected || !periodEnded || busy}>
          {busy
            ? "Sealing the total…"
            : !isConnected
              ? "Connect a wallet to close"
              : periodEnded
                ? "Close this draw"
                : "Opens when the week ends"}
        </button>
      )}

      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
