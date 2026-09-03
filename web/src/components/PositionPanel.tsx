"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { usePositionHistory } from "@/hooks/usePositionHistory";
import { POOL_ADDRESS, TOKEN_DECIMALS, poolAbi } from "@/lib/contract";
import { describeError, toast } from "@/lib/toast";
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
  lastPrize,
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
  /** What the last draw paid, for the expected-value line. */
  lastPrize?: bigint;
  onDeposit: () => void;
  onWithdraw: () => void;
  /** Clears the stored decrypt key. Absent when there is nothing to clear. */
  onLock?: () => void;
  /** The reveal footer, when still locked. */
  children?: React.ReactNode;
}) {
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

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

  /**
   * How much of full credit this position is currently earning.
   *
   * Odds are weighted by amount AND time, so two people holding the same balance can have
   * different weights: `weight = balance × (PERIOD_MINUTES − minuteDeposited)`. Divide by
   * what a full period would have earned and the result is a plain multiplier — 1.00× for
   * somebody who was there when the week opened, 0.50× for somebody who arrived halfway.
   *
   * It resets every week, and deliberately so. There is no bonus for staying multiple
   * periods: `_advancePeriod` lets the period-scoped corrections age out, so everyone
   * returns to full credit together. A depositor of five weeks and one who arrives at the
   * top of this week have identical odds for the same balance. Showing a "loyalty"
   * multiplier would be inventing a mechanic the contract does not have.
   */
  const fullCredit = balance !== undefined ? balance * PERIOD_MINUTES : undefined;
  const timeCredit =
    weight !== undefined && fullCredit !== undefined && fullCredit > 0n
      ? Number(weight) / Number(fullCredit)
      : undefined;

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

  /**
   * The loyalty boost: what staying is worth, and whether it has been taken this period.
   *
   * Both figures are public on-chain and always were — a slot is taken in a transaction
   * anyone can watch, and `slotAssignedAt` records when. What stays encrypted is the thing
   * the boost multiplies, so an observer learns that this slot has been here four weeks
   * and still nothing about how much is in it.
   */
  const [streak, setStreak] = useState<number>();
  const [boosted, setBoosted] = useState<boolean>();
  const [boosting, setBoosting] = useState(false);
  const [boostNonce, setBoostNonce] = useState(0);

  useEffect(() => {
    if (!publicClient) return;
    // No wallet, or a wallet with no slot: either way the answer is 1.0x, not a pending
    // read. Leaving it undefined parked a first-time visitor on "reading the chain…"
    // forever — and they are the one person this control exists to talk to, since the
    // whole point of drawing a ladder is to show someone at the bottom of it where it goes.
    if (!address || slot === undefined) {
      setStreak(0);
      setBoosted(false);
      return;
    }
    let live = true;
    void Promise.all([
      publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "streakOf", args: [address] }),
      publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "boostedThisPeriod",
        args: [slot],
      }),
    ])
      .then(([n, taken]) => {
        if (!live) return;
        setStreak(Number(n as number));
        setBoosted(taken as boolean);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [publicClient, address, slot, drawNumber, boostNonce]);

  const boost = async () => {
    setBoosting(true);
    try {
      await writeContractAsync({ address: POOL_ADDRESS, abi: poolAbi, functionName: "boostStreak" });
      toast({ kind: "success", title: "Boost applied", detail: "Your weight is up for this week." });
      setBoostNonce((n) => n + 1);
    } catch (e) {
      toast({ kind: "error", title: "Boost failed", detail: describeError(e) });
    } finally {
      setBoosting(false);
    }
  };

  const masked = "▪▪▪▪▪▪";

  // --- add-to-position projection -----------------------------------------
  const [add, setAdd] = useState(0);
  // Comfortably above a single faucet press, since the faucet can be pressed again — but
  // not so far above it that most of the track is unreachable.
  const maxAdd = 50_000;

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

  /** Odds after the projected deposit, times the prize: what the week is worth on average. */
  const expectedWeekly =
    projected !== undefined && lastPrize !== undefined
      ? (lastPrize * BigInt(Math.round(projected * 100))) / 10_000n
      : undefined;

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

          {/* Loyalty.
              Time-weighting rewards depositing early in the week; it said nothing about
              staying past the week you arrived in, so week fifty looked exactly like week
              one. This is the ladder out of that, and it is drawn as a ladder on purpose:
              a bare "1.0x" tells a first-time depositor nothing, whereas four rungs with
              the first one lit says where they are and what staying is worth. */}
          <div className={styles.loyalty}>
            <div className={styles.loyaltyHead}>
              <span className={styles.loyaltyK}>LOYALTY</span>
              <span className={styles.loyaltyV}>{(1 + (streak ?? 0) * 0.1).toFixed(1)}×</span>
            </div>

            <div className={styles.rungs} aria-hidden>
              {[0, 1, 2, 3, 4].map((n) => (
                <span
                  key={n}
                  className={[
                    styles.rung,
                    n <= (streak ?? 0) ? styles.rungOn : "",
                    n === (streak ?? 0) ? styles.rungNow : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              ))}
            </div>

            <div className={styles.loyaltyNote}>
              {streak === undefined ? (
                "reading the chain…"
              ) : streak === 0 ? (
                <>
                  Everyone starts at 1.0×. Stay through the roll and it climbs 0.1× a week, to 1.4×.
                </>
              ) : boosted ? (
                <>
                  Applied for this week — {streak} week{streak > 1 ? "s" : ""} held.{" "}
                  {streak < 4 ? `${(1 + (streak + 1) * 0.1).toFixed(1)}× next week.` : "This is the top rung."}
                </>
              ) : (
                <>
                  {streak} week{streak > 1 ? "s" : ""} held, unclaimed. It expires with the week, and taking it commits
                  your stake until the roll.
                </>
              )}
            </div>

            {streak !== undefined && streak > 0 && !boosted && (
              <button className={styles.boost} onClick={boost} disabled={boosting}>
                {boosting ? "applying…" : `Apply ${(1 + streak * 0.1).toFixed(1)}×`}
              </button>
            )}
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

            {/* Time credit: what the contract charges you for arriving late in the week.
                Yellow because it is the other number that moves your odds, and the one you
                act on by depositing earlier next week. */}
            <div className={styles.row}>
              <dt>
                TIME CREDIT <span className={styles.rowNote}>this period only, resets weekly</span>
              </dt>
              <dd className={isUnlocked ? styles.rowValue : styles.rowMasked}>
                {isUnlocked && timeCredit !== undefined ? (
                  <span className={styles.credit}>
                    {timeCredit.toFixed(2)}×{" "}
                    <span className={styles.creditNote}>
                      {timeCredit > 0.995 ? "full week" : `joined at minute ${Math.round((1 - timeCredit) * 10080)}`}
                    </span>
                  </span>
                ) : isUnlocked ? (
                  "—"
                ) : (
                  masked
                )}
              </dd>
            </div>

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
                HELD FOR <span className={styles.rowNote}>blocks, since your first deposit</span>
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
                  ? "your share of the pool, against the total published at the last draw. It climbs through the period because that denominator is frozen while your weight accrues — not because holding beats holding. If everyone stays, everyone's weight grows together and the real shares barely move. Computed here, never transmitted."
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

            {/* Odds alone read as a verdict on the deposit, and a small percentage in a
                large pool looks like a bad deal. It is not: expected return is odds times
                prize, and both scale with the pool, so the product is the yield rate at any
                size. A depositor in a million-token pool wins rarely and wins large; one in
                a small pool wins often and wins little. Same return, different variance —
                and since principal is never at stake, variance is the only thing being
                chosen. Saying so turns 0.75% from a disappointment into the mechanism. */}
            {expectedWeekly !== undefined && (
              <div className={styles.expected}>
                <span className={styles.label}>EXPECTED</span>{" "}
                <span className={styles.expectedV}>{formatUnits(expectedWeekly, 2)} cUSDT a week</span>{" "}
                <span className={styles.expectedNote}>
                  — odds × prize. It comes to the pool&apos;s yield rate whatever the pool&apos;s size, so a smaller
                  share of a bigger pot is the same return with rarer, larger wins. Your principal is never at stake.
                </span>
              </div>
            )}

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
