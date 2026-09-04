"use client";

import type { useLastDraw, usePoolState } from "./usePoolState";

export type PhaseId = "accruing" | "due" | "sealed" | "settling";

export type Phase = {
  id: PhaseId;
  /** Two or three words for a badge. */
  tag: string;
  /** What is true right now. */
  headline: string;
  /** What happens next, and who makes it happen. */
  detail: string;
  /** Whether the countdown to the period boundary still means anything. */
  countdownMeaningful: boolean;
};

/**
 * Which part of the week the pool is in.
 *
 * A pool between draws looks, from the outside, exactly like a pool that has stalled: the
 * countdown reads zero or keeps ticking against a boundary that has already passed, the
 * pot does not move, and nothing on the page admits that a draw is halfway through being
 * settled. Reading four contract flags in the right order says so plainly instead.
 *
 * The order matters. `drawPending` wins over everything, because a sealed total is the
 * most specific thing that can be true. A draw settled in the current period comes next,
 * since that is the window where claims are paid and the countdown is meaningless. Only
 * then does an elapsed period mean a draw is due.
 */
export function poolPhase(state: ReturnType<typeof usePoolState>, lastDraw: ReturnType<typeof useLastDraw>): Phase {
  const drawNumber = Number(state.drawCount);

  if (state.drawPending) {
    return {
      id: "sealed",
      tag: "SEALED",
      headline: `Draw #${drawNumber} is sealed and waiting to settle.`,
      detail:
        "The pool total has been published for decryption. The die has not been rolled yet, and any wallet can roll it — settling is a courier's job, not a trusted one.",
      countdownMeaningful: false,
    };
  }

  // Settled, and the period has not rolled: the claim window is open and prizes are
  // landing. `hushpot:status` calls this same condition an open claim window.
  if (lastDraw && lastDraw.period === state.currentPeriod && drawNumber > 0) {
    return {
      id: "settling",
      tag: "PAYING OUT",
      headline: `Draw #${drawNumber - 1} has settled. Everyone is being checked.`,
      detail:
        "Winner or not, every depositor is checked in turn, and a loser's check costs the same gas as a winner's. The next week opens when the keeper rolls the period — it does not wait on the sweep, and nobody forfeits a prize by not being checked in time. On a weekly cadence that roll is always the keeper's: anybody else has to wait out the full thirty-day claim window first. Deposits and withdrawals stay open throughout.",
      countdownMeaningful: false,
    };
  }

  if (state.periodEnded) {
    return {
      id: "due",
      tag: "DRAW DUE",
      headline: "The week is up and the total has not been sealed yet.",
      detail:
        "Opening the draw needs no permission now that the period has elapsed, so any wallet can do it. Nothing is stuck; the pool is waiting for somebody to press the button.",
      countdownMeaningful: false,
    };
  }

  return {
    id: "accruing",
    tag: "OPEN",
    headline: "The week is running. Deposits are earning odds.",
    detail:
      "Nothing is published while this runs. Your weight is balance times minutes held, and a deposit made now earns odds for every minute it stays.",
    countdownMeaningful: true,
  };
}
