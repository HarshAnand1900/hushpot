"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

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
  /** The reveal footer, when still locked. */
  children?: React.ReactNode;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const odds =
    weight !== undefined && poolTotal && poolTotal > 0n ? (Number(weight) / Number(poolTotal)) * 100 : undefined;

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

  const masked = handle ? `${handle.slice(0, 10)}…` : "••••••";

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
    return all > 0 ? (mine / all) * 100 : undefined;
  }, [add, odds, weight, poolTotal, minuteOfPeriod]);

  const delta = projected !== undefined && odds !== undefined ? projected - odds : 0;

  const bars = history.odds.slice(-6);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>YOUR POSITION</span>
        <span style={{ color: isUnlocked ? "var(--yellow)" : undefined }}>
          {isUnlocked ? "DECRYPTED IN THIS TAB" : "ENCRYPTED ON-CHAIN"}
        </span>
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

            <div className={styles.row}>
              <dt>
                BLOCKS HELD <span className={styles.rowNote}>earning the whole time</span>
              </dt>
              <dd className={isUnlocked ? styles.rowValue : styles.rowMasked}>
                {isUnlocked ? (history.blocksHeld !== undefined ? Number(history.blocksHeld).toLocaleString() : "—") : masked}
              </dd>
            </div>
          </dl>

          <div className={styles.foot}>
            {handle && <>HANDLE {handle.slice(0, 6)}…{handle.slice(-4)} · </>}
            PRINCIPAL AT RISK <span style={{ color: "var(--yellow)" }}>NONE</span>
          </div>
        </div>

        {/* ------------------------------------------------------- odds -- */}
        <div className={styles.cell}>
          <div className={styles.label}>
            <span className="liveDot" /> ODDS · DRAW #{drawNumber}
          </div>
          <div className={`num ${styles.value} ${isUnlocked ? "" : styles.valueMasked}`}>
            {odds !== undefined && isUnlocked ? `${odds.toFixed(2)}%` : masked}
          </div>

          <div className={styles.spark}>
            {Array.from({ length: 6 }, (_, i) => {
              const point = bars[i];
              const peak = Math.max(...bars.map((b) => b.odds), odds ?? 0, 0.01);
              const h = point ? Math.max(12, (point.odds / peak) * 100) : 34;
              const newest = i === bars.length - 1 && bars.length > 0;
              return (
                <span
                  key={i}
                  className={styles.bar}
                  style={{
                    height: `${h}%`,
                    background: !point
                      ? "rgba(255,255,255,.06)"
                      : newest
                        ? "var(--yellow)"
                        : "rgba(255,210,8,.42)",
                  }}
                  title={point ? `Draw #${point.draw} · ${point.odds.toFixed(2)}%` : "no reading"}
                />
              );
            })}
          </div>
          <div className={styles.sparkFoot}>
            <span>YOUR ODDS · LAST 6 DRAWS</span>
            <span>NOW</span>
          </div>

          <div className={styles.oddsNote}>
            {isUnlocked
              ? bars.length > 1
                ? "rising as your deposit accrues time"
                : "computed here, never transmitted"
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
                <span className={styles.projDelta}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(2)} pts
                </span>
              </span>
            </div>
            <div className={styles.projTrack}>
              <span
                className={styles.projFill}
                style={{ width: `${Math.min(100, ((projected ?? 0) / 10) * 100)}%` }}
              />
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
