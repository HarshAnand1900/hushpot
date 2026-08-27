"use client";

import { useEffect, useState } from "react";

import styles from "./Schedule.module.css";

/**
 * When the week turns, and what the pot figure is actually made of.
 *
 * Both halves are here for the same reason: the headline number is an estimate, and a
 * number presented without its basis is a number somebody has to take on trust. This is a
 * product whose entire argument is that you should not have to.
 *
 * The times are fixed in UTC rather than derived from `periodStart`, because the schedule
 * is a promise about when the keeper acts, not a reading of contract state. If the two
 * ever disagree, the contract is the truth and this is the intention.
 */
const STEPS = [
  { when: "MON 06:00 UTC", what: "The week opens", detail: "Deposits start earning from the minute they land." },
  { when: "MON → MON", what: "Odds accrue", detail: "Balance × minutes held. Nothing is published while it runs." },
  {
    when: "MON 06:00 UTC",
    what: "The draw settles",
    detail: "The pool total is published for the first time, and an encrypted die is rolled on-chain.",
  },
  {
    when: "THE HOURS AFTER",
    what: "Everyone is checked",
    detail: "One transaction per depositor. A loser receives an encrypted zero, identical on-chain to a win.",
  },
  { when: "THEN", what: "The week turns", detail: "Claims close, the next period opens, and balances carry over." },
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
        <span>THE WEEK · UTC</span>
        <span suppressHydrationWarning>{nextTurn ? `NEXT TURN ${nextTurn}` : "—"}</span>
      </div>

      <div className={styles.steps}>
        {STEPS.map((s, i) => (
          <div key={s.when + i} className={styles.step}>
            <span className={styles.when}>{s.when}</span>
            <span className={styles.what}>{s.what}</span>
            <span className={styles.detail}>{s.detail}</span>
          </div>
        ))}
      </div>

      <div className={styles.basis}>
        <div className={styles.basisHead}>WHERE THE POT FIGURE COMES FROM</div>
        <p className={styles.copy}>
          The pot shown for draw #{drawNumber} is an <strong>estimate</strong>, and deliberately so. The exact figure is
          the yield on this week&apos;s pool plus anything sponsored — but the live pool total is encrypted, and
          publishing it continuously is the one thing that would break this. Read it, wait for a deposit, read it again,
          and the difference is that depositor&apos;s amount in the clear.
        </p>
        <p className={styles.copy}>
          So the yield half is computed from the total the <strong>last draw published</strong>, using the contract&apos;s
          own formula, run in your browser. Both inputs are already public. The sponsored half is not estimated at all —
          sponsorships are plain transfers and the figure is exact.
        </p>
        <p className={styles.copy}>
          Nothing about the current week is disclosed to produce it, and nothing here is invented: every number on this
          site is read from the chain or derived from figures the chain has already made public.
        </p>
      </div>
    </section>
  );
}
