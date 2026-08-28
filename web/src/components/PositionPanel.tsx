"use client";

import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";

import { usePositionHistory } from "@/hooks/usePositionHistory";
import { POOL_ADDRESS, TOKEN_DECIMALS, poolAbi } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./PositionPanel.module.css";

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);
const PERIOD_MINUTES = 10080n;

export function PositionPanel({
  balance,
  weight,
  slot,
  isUnlocked,
  drawNumber,
  poolTotal,
  minuteOfPeriod,
  onDeposit,
  onWithdraw,
  onLock,
  children,
}: {
  balance?: bigint;
  weight?: bigint;
  slot?: number;
  isUnlocked: boolean;
  drawNumber: number;
  /** Pool ticket-minutes published at the last draw. Frozen — never a live figure. */
  poolTotal?: bigint;
  minuteOfPeriod: bigint;
  onDeposit: () => void;
  onWithdraw: () => void;
  /** Clears the stored decrypt key. Absent when there is nothing to clear. */
  onLock?: () => void;
  /** The reveal footer, when still locked. */
  children?: React.ReactNode;
}) {
  const publicClient = usePublicClient();

  const hasDenominator = poolTotal !== undefined && poolTotal > 0n;

  // Your weight is current; the denominator is the total published at the last draw. When
  // the pool has grown since — you deposited, or a prize was folded into your balance —
  // the ratio compares two different moments and can exceed 100%, which is nonsense on
  // its face. It is capped and labelled as an estimate rather than printed as fact.
  //
  // There is no exact figure available: the live total is encrypted precisely so nobody
  // can read it, and a per-slot weight snapshot at draw time would be storage nobody
  // needs. An estimate honestly labelled beats a wrong number stated plainly.
  const rawOdds = weight !== undefined && hasDenominator ? (Number(weight) / Number(poolTotal)) * 100 : undefined;

  // Past 100% the denominator is provably out of date — your weight has outgrown the total
  // that was published at the last draw, because you deposited or won since. Capping it at
  // 100 was worse than useless: it reads as "you will certainly win", which is false and
  // was being shown while a second depositor sat in the pool.
  //
  // There is no better figure to substitute. The live total is encrypted precisely so
  // nobody can read it, and the other depositors' weights are theirs. So the number is
  // withheld until the next draw republishes a total, and the panel says why.
  const oddsStale = rawOdds !== undefined && rawOdds > 100.5;
  const odds = rawOdds === undefined || oddsStale ? undefined : rawOdds;

  const history = usePositionHistory(drawNumber, isUnlocked ? odds : undefined);

  // The real ciphertext handle, shown in place of the value while locked. It is a far
  // better mask than dots: it is the actual thing stored on-chain, and it is public.
  const [handle, setHandle] = useState<string>();
  useEffect(() => {
    if (!publicClient || slot === undefined) return;
    let live = true;
    void publicClient
      .readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "balanceHandle", args: [slot] })
      .then((h) => {
        if (live && typeof h === "string" && !/^0x0+$/.test(h)) setHandle(h);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [publicClient, slot, isUnlocked]);

  const masked = "▪▪▪▪▪▪";

  // --- add-to-position projection -----------------------------------------
  const [add, setAdd] = useState(0);
  const maxAdd = 20_000;

  const projected = useMemo(() => {
    if (odds === undefined || weight === undefined || !poolTotal || poolTotal === 0n) return undefined;

    // Money added now earns only the minutes left in the period, on both sides of the
    // ratio — it enlarges the pot exactly as much as it enlarges your share.
    const left = PERIOD_MINUTES - minuteOfPeriod;
    const extra = Number(BigInt(Math.floor(add)) * SCALE * left);

    const mine = Number(weight) + extra;
    const all = Number(poolTotal) + extra;
    const p = all > 0 ? (mine / all) * 100 : undefined;

    // Same staleness, same answer: no projection is better than a confident wrong one.
    return p !== undefined && p <= 100.5 ? p : undefined;
  }, [add, odds, weight, poolTotal, minuteOfPeriod]);

  const delta = projected !== undefined && odds !== undefined ? projected - odds : 0;

  /**
   * Your odds across this period, minute by minute.
   *
   * The six-draw history was the wrong chart: draws are weekly, so it took over a month to
   * fill and showed five empty boxes in the meantime. This one is full immediately and
   * shows the thing that actually moves — odds are weighted by time held, so a position
   * climbs all period and a late deposit visibly starts behind.
   *
   * Computed, not recorded. Your weight rises by your balance every minute that passes,
   * and the pool total the draw will use is the frozen one, so the whole curve is known.
   */
  const curve = useMemo(() => {
    if (weight === undefined || balance === undefined || !poolTotal || poolTotal === 0n) return [];

    const now = Number(minuteOfPeriod);
    const perMinute = Number(balance);

    return Array.from({ length: 6 }, (_, i) => {
      const minute = Math.round(((i + 1) / 6) * Number(PERIOD_MINUTES));
      // Before now it is history, after now it is the projection if nothing changes.
      const mine = Number(weight) + perMinute * Math.max(0, minute - now);
      const all = Number(poolTotal) + perMinute * Math.max(0, minute - now);
      return { minute, odds: all > 0 ? (mine / all) * 100 : 0, future: minute > now };
    });
  }, [weight, balance, poolTotal, minuteOfPeriod]);

  const curvePeak = Math.max(...curve.map((p) => p.odds), 0.0001);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>YOUR POSITION</span>
        {/* The session key now lives on disk for the week the signature covers, so there
            has to be a way to revoke it without waiting the week out. It belongs here,
            beside the state it controls, rather than as a chip in the header that competed
            with the reveal button. */}
        {isUnlocked && onLock ? (
          <button className={styles.lock} onClick={onLock} title="Forget the decrypt key on this device">
            DECRYPTED · LOCK AGAIN
          </button>
        ) : (
          <span style={{ color: isUnlocked ? "var(--yellow)" : undefined }}>
            {isUnlocked ? "DECRYPTED" : "ENCRYPTED ON-CHAIN"}
          </span>
        )}
      </div>

      <div className={styles.grid}>
        {/* ---------------------------------------------------- balance -- */}
        <div className={styles.cell}>
          <div className={styles.label}>BALANCE IN POOL</div>
          <div
            className={`num ${styles.value} ${isUnlocked ? "" : styles.valueMasked}`}
            title={isUnlocked ? undefined : handle}
          >
            {isUnlocked && balance !== undefined ? formatUnits(balance) : masked}
          </div>

          <div className={styles.recordHead}>YOUR RECORD · THIS BROWSER ONLY</div>

          <dl className={styles.record}>
            {(history.deposits ?? []).slice(-2).map((d) => (
              <div key={String(d.block)} className={styles.row}>
                <dt>
                  DEPOSIT <span className={styles.rowNote}>draw #{d.draw}</span>
                </dt>
                <dd className={isUnlocked ? styles.rowValue : styles.rowMasked}>
                  {isUnlocked ? (d.amount !== undefined ? `+${formatUnits(d.amount)}` : "encrypted") : masked}
                </dd>
              </div>
            ))}

            <div className={styles.row}>
              <dt>
                DRAWS ENTERED <span className={styles.rowNote}>since first deposit</span>
              </dt>
              <dd className={isUnlocked ? styles.rowValue : styles.rowMasked}>
                {isUnlocked ? (history.drawsEntered ?? "—") : masked}
              </dd>
            </div>

            {/* Blocks held was the honest figure and a useless one. Time is what odds are
                actually weighted by, so time is what belongs here. */}
            <div className={styles.row}>
              <dt>
                BLOCKS HELD <span className={styles.rowNote}>earning the whole time</span>
              </dt>
              <dd className={isUnlocked ? styles.rowValue : styles.rowMasked}>
                {isUnlocked ? (history.heldFor ?? "—") : masked}
              </dd>
            </div>
          </dl>

          <div className={styles.foot}>
            {handle && (
              <>
                HANDLE {handle.slice(0, 6)}…{handle.slice(-4)} ·{" "}
              </>
            )}
            PRINCIPAL AT RISK <span style={{ color: "var(--yellow)" }}>NONE</span>
          </div>
        </div>

        {/* ------------------------------------------------------- odds -- */}
        <div className={styles.cell}>
          <div className={styles.label}>
            <span className="liveDot" /> ODDS · DRAW #{drawNumber}
          </div>
          {/* Odds divide your weight by a denominator that is only published at a draw.
              On a pool where none has settled there is no such figure, so the number is
              not merely hidden. It does not exist yet, and saying so beats a mask that
              looks identical to "you have not revealed", which is what it looked like. */}
          <div className={`num ${styles.value} ${isUnlocked && odds !== undefined ? "" : styles.valueMasked}`}>
            {odds !== undefined && isUnlocked ? `${odds.toFixed(2)}%` : oddsStale && isUnlocked ? "—" : masked}
          </div>

          {!hasDenominator && (
            <div className={styles.oddsPending}>
              No draw has settled yet, so there is no published pool total to divide into. Your odds appear once the
              first draw closes. The denominator is frozen at a draw instead of read live, because a live one would let
              anyone recover every deposit by subtraction.
            </div>
          )}

          <div className={styles.spark}>
            {(curve.length ? curve : Array.from({ length: 6 }, () => null)).map((p, i) => (
              <span
                key={i}
                className={styles.bar}
                style={{
                  height: p ? `${Math.max(6, (p.odds / curvePeak) * 100)}%` : "22%",
                  background: !p ? "rgba(255,255,255,.05)" : p.future ? "rgba(255,210,8,.28)" : "var(--yellow)",
                }}
                title={p ? `minute ${p.minute} · ${p.odds.toFixed(3)}%` : undefined}
              />
            ))}
          </div>
          <div className={styles.sparkFoot}>
            <span>YOUR ODDS · THIS PERIOD</span>
            <span>NOW</span>
          </div>

          <div className={styles.oddsNote}>
            {!hasDenominator
              ? "waiting on the first draw"
              : oddsStale
                ? `out of date: the pool has grown past the total published at draw #${Math.max(0, drawNumber - 1)}, and the live one is encrypted. Your real share is recalculable only when the next draw publishes a new total.`
                : isUnlocked
                  ? "climbing every minute you stay in, computed here and never transmitted"
                  : "computed here, never transmitted"}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- actions -- */}
      {isUnlocked ? (
        <div className={styles.actions}>
          <div className={styles.sliderCell}>
            <div className={styles.sliderTop}>
              <span className={styles.label}>ADD TO YOUR POSITION</span>
              <span className={`num ${styles.sliderValue}`}>
                {add.toLocaleString()} <span className={styles.sliderUnit}>cUSDT</span>
              </span>
            </div>
            <input
              className={styles.slider}
              type="range"
              min={0}
              max={maxAdd}
              step={100}
              value={add}
              onChange={(e) => setAdd(Number(e.target.value))}
              aria-label="Amount to add, for projecting odds"
            />
            <div className={styles.ticks}>
              {[0, 5_000, 10_000, 15_000, 20_000].map((t) => (
                <span key={t}>{t.toLocaleString()}</span>
              ))}
            </div>
          </div>

          <div className={styles.projCell}>
            <div className={styles.projTop}>
              <span className={styles.label}>ODDS AFTER</span>
              <span className={`num ${styles.projValue}`}>
                {projected !== undefined ? `${projected.toFixed(2)}%` : "—"}
                {projected !== undefined && (
                  <span className={styles.projDelta}>
                    {delta >= 0 ? "+" : ""}
                    {delta.toFixed(2)} pts
                  </span>
                )}
              </span>
            </div>
            <div className={styles.projTrack}>
              <span className={styles.projFill} style={{ width: `${Math.min(100, ((projected ?? 0) / 10) * 100)}%` }} />
            </div>
            <div className={styles.projFoot}>
              <span>NOW {odds !== undefined ? `${odds.toFixed(2)}%` : "—"}</span>
              <span>SCALE 0–10%</span>
            </div>

            <div className={styles.buttons}>
              <button className="btnPrimary" style={{ flex: 1.2 }} onClick={onDeposit}>
                Put it in the pot
              </button>
              <button
                className="btnSecondary"
                style={{ flex: 1 }}
                onClick={onWithdraw}
                disabled={balance === 0n}
                title={balance === 0n ? "Deposit something first" : undefined}
              >
                Withdraw
              </button>
            </div>
          </div>
        </div>
      ) : (
        children
      )}
    </section>
  );
}
