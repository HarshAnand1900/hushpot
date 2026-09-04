"use client";

import { useEffect, useState } from "react";

import styles from "./Schedule.module.css";

/**
 * What the week actually does, hour by hour.
 *
 * The first version of this was a five-row table whose second row read "MON → MON", which
 * is not a time - it is two times with an arrow between them, and it left the reader to
 * work out that the pool spends most of the week deliberately doing nothing visible. So
 * this is a bar rather than a list: one week wide, with the long quiet stretch and the
 * short loud one drawn to scale, because the whole point is that they are not the same
 * size.
 *
 * The times are fixed in UTC rather than derived from `periodStart`, because the schedule
 * is a promise about when the keeper acts, not a reading of contract state. Where the two
 * disagree - as they do until the first Monday roll - the contract is the truth, and the
 * last panel here says so rather than letting the table quietly imply otherwise.
 */

/** The accrual stretch runs 162 of the week's 168 hours; settlement takes the other six. */
const ACCRUAL_HOURS = 162;
const SETTLE_HOURS = 6;

const MOMENTS = [
  {
    when: "MONDAY 06:00",
    call: "startNextPeriod()",
    what: "The week opens",
    who: "The keeper. Open to anybody only once the 30-day claim window has expired",
    detail:
      "Balances carry over untouched, so nobody re-deposits. A deposit made from this minute earns odds for every minute it stays; one made on Friday earns only the minutes that are left.",
    reveals: "Nothing",
  },
  {
    when: "THE NEXT 162 HOURS",
    call: "nothing is called",
    what: "Odds accrue, silently",
    who: "No keeper, no cron, no transactions",
    detail:
      "Your weight is balance × minutes held, kept as a ciphertext in a segment tree and adjusted as deposits and withdrawals happen. This part has to stay quiet: publishing anything here, even a running total, would give up individual deposits by subtraction.",
    reveals: "Nothing",
  },
  {
    when: "MONDAY 00:00",
    call: "openDraw() → settleDraw()",
    what: "The draw is sealed, then settled",
    who: "Any wallet. openDraw needs no permission once the week is up, and settleDraw never did",
    detail:
      "The pool total is decrypted and published, for the first and only time that week. An encrypted die is then rolled against it on-chain: a random point inside the total, landing in exactly one depositor's band.",
    reveals: "The pool total, and the prize",
  },
  {
    when: "THE SIX HOURS AFTER",
    call: "checkMyClaim() - or sweepRange()",
    what: "Everyone is checked, then the books are proved",
    who: "You, for yourself. Or a keeper, for everybody",
    detail:
      "Claiming for yourself is one transaction and the path the protocol actually relies on, because its cost per depositor is flat and the person who pays is the person who gets paid. A keeper sweep does the same job for everyone at once, so nobody has to remember - a convenience worth running at this size, and one that no design should need at ten thousand. Either way a loser receives an encrypted zero, which costs the same gas and looks identical on-chain to a win, so being checked tells an observer nothing.",
    reveals: "That everyone was checked. Not who won",
  },
  {
    when: "MONDAY 06:00",
    call: "startNextPeriod()",
    what: "And the week opens again",
    who: "The keeper again",
    detail:
      "The claim window closes and the next period begins. This is the one step a weekly cadence keeps in the operator's hands: the contract only opens it to everybody else after the full thirty days, which a seven-day week never reaches. What protects an unclaimed slot is that thirty-day hold, not a sweep check - the contract does not verify one, and the owner can roll early. The Judge panel declines to until every slot is covered, but that is the app being careful, not the contract.",
    reveals: "Nothing",
  },
];

export function Schedule({ drawNumber }: { drawNumber: number }) {
  const [nextTurn, setNextTurn] = useState<string>();

  useEffect(() => {
    const d = new Date();
    // Next Monday 06:00 UTC, from now.
    d.setUTCHours(6, 0, 0, 0);
    while (d.getUTCDay() !== 1 || d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
    setNextTurn(d.toUTCString().replace("GMT", "UTC"));
  }, []);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>THE WEEK · ALL TIMES UTC</span>
        <span suppressHydrationWarning>{nextTurn ? `NEXT TURN ${nextTurn}` : "—"}</span>
      </div>

      {/* One week, drawn to scale, so the shape is legible before the words are. */}
      <div className={styles.barWrap}>
        <div className={styles.bar}>
          <div className={styles.accrual} style={{ flexGrow: ACCRUAL_HOURS }}>
            <span className={styles.segLabel}>{ACCRUAL_HOURS}h · ODDS ACCRUING · NOTHING PUBLISHED</span>
          </div>
          <div className={styles.settle} style={{ flexGrow: SETTLE_HOURS }}>
            <span className={styles.segLabelSmall}>{SETTLE_HOURS}h</span>
          </div>
        </div>

        <div className={styles.barAxis}>
          <span>MON 06:00 · opens</span>
          <span className={styles.axisRight}>MON 00:00 · draw → 06:00 · opens again</span>
        </div>

        <p className={styles.barNote}>
          Six days and eighteen hours of accrual, then a six-hour window to settle the draw, pay whoever won and prove
          the books. That window is when the <strong>keeper</strong> works - not when you can. Deposits and withdrawals
          stay open every minute of the week, those six hours included.
        </p>
      </div>

      <div className={styles.moments}>
        {MOMENTS.map((m, i) => (
          <div key={m.when + i} className={styles.moment}>
            <div className={styles.mHead}>
              <span className={styles.mWhen}>{m.when}</span>
              <span className={styles.mCall}>{m.call}</span>
            </div>

            <div className={styles.mBody}>
              <div className={styles.mWhat}>{m.what}</div>
              <div className={styles.mWho}>{m.who}</div>
              <p className={styles.mDetail}>{m.detail}</p>
            </div>

            <div className={styles.mReveals}>
              <span className={styles.mRevealsLabel}>BECOMES PUBLIC</span>
              <span className={m.reveals === "Nothing" ? styles.mRevealsNone : styles.mRevealsSome}>{m.reveals}</span>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.basis}>
        <div className={styles.basisHead}>WHERE THE POT FIGURE COMES FROM</div>
        <p className={styles.copy}>
          The pot shown for draw #{drawNumber} is an <strong>estimate</strong>, and deliberately so. The exact figure is
          the yield on this week&apos;s pool plus anything sponsored - but the live pool total is encrypted, and
          publishing it continuously is the one thing that would break this. Read it, wait for a deposit, read it again,
          and the difference is that depositor&apos;s amount in the clear.
        </p>
        <p className={styles.copy}>
          So the yield half is computed from the total the <strong>last draw published</strong>, using the
          contract&apos;s own formula, run in your browser. Both inputs are already public. The sponsored half is not
          estimated at all - sponsorships are plain transfers and the figure is exact.
        </p>
        <p className={styles.copy}>
          <strong>The draw does not use this number.</strong> When it opens, the contract computes the pool total fresh
          from the live tree and pays the yield on that. So the prize actually paid can land above or below the figure
          shown here, and by more than a little if the pool has grown since the last draw. Treat it as a preview, not a
          promise.
        </p>
        <p className={styles.copy}>
          Nothing about the current week is disclosed to produce it, and nothing here is invented: every number on this
          site is read from the chain or derived from figures the chain has already made public.
        </p>
      </div>

      <div className={styles.basis}>
        <div className={styles.basisHead}>WHY A COUNTDOWN MAY NOT LAND ON A MONDAY</div>
        <p className={styles.copy}>
          The contract has no calendar. A period is seven days measured from{" "}
          <strong>whenever the roll was last called</strong>, so the table above is a promise about when the keeper
          acts, not a rule the chain enforces. The first period started when the pool was deployed, which was not a
          Monday - so the countdown on the pool page runs to that anniversary until the first Monday roll cuts it short
          and locks the boundary in place.
        </p>
        <p className={styles.copy}>
          Where the two disagree, <strong>the countdown is the truth</strong> and this table is the intention. Both are
          on this site, instead of one quietly overriding the other.
        </p>
      </div>
    </section>
  );
}
