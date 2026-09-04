"use client";

import { useEffect, useState } from "react";
import { useReadContracts } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";

const pool = { address: POOL_ADDRESS, abi: poolAbi } as const;

/**
 * Everything public about the pool.
 *
 * Note what is *not* here: no participant balances, no odds, no winner. Those are
 * ciphertext on-chain, and no amount of reading gets at them. This hook can only ever
 * return aggregates and schedule.
 */
export function usePoolState() {
  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...pool, functionName: "currentPeriod" },
      { ...pool, functionName: "periodStart" },
      { ...pool, functionName: "PERIOD_SECONDS" },
      { ...pool, functionName: "minuteOfPeriod" },
      { ...pool, functionName: "periodEnded" },
      { ...pool, functionName: "slotsUsed" },
      { ...pool, functionName: "prizeReserve" },
      { ...pool, functionName: "drawCount" },
      { ...pool, functionName: "drawPending" },
      { ...pool, functionName: "annualRateBps" },
      { ...pool, functionName: "sponsoredThisDraw" },
    ],
    query: { refetchInterval: 12_000 },
  });

  const [
    currentPeriod,
    periodStart,
    periodSeconds,
    minute,
    ended,
    slotsUsed,
    reserve,
    drawCount,
    drawPending,
    rateBps,
    sponsored,
  ] = data ?? [];

  return {
    isLoading,
    /**
     * Whether a read actually landed.
     *
     * `isLoading` is only true on the first fetch, so after a failed refetch it reads
     * false while every field below falls back to its default - `currentPeriod` to 0 on a
     * pool that is in period 3. Anything deciding on those values needs to know the
     * difference between "zero" and "not answered".
     */
    loaded: data !== undefined,
    refetch,
    currentPeriod: (currentPeriod?.result as number | undefined) ?? 0,
    periodStart: (periodStart?.result as bigint | undefined) ?? 0n,
    periodSeconds: (periodSeconds?.result as bigint | undefined) ?? 604_800n,
    minuteOfPeriod: (minute?.result as bigint | undefined) ?? 0n,
    periodEnded: (ended?.result as boolean | undefined) ?? false,
    depositors: (slotsUsed?.result as number | undefined) ?? 0,
    prizeReserve: (reserve?.result as bigint | undefined) ?? 0n,
    drawCount: (drawCount?.result as bigint | undefined) ?? 0n,
    drawPending: (drawPending?.result as boolean | undefined) ?? false,
    annualRateBps: (rateBps?.result as bigint | undefined) ?? 500n,
    /** Sponsorships banked for the next draw. Public, and nobody's position. */
    sponsoredThisDraw: (sponsored?.result as bigint | undefined) ?? 0n,
  };
}

/** The most recently settled draw, or undefined if none has run yet. */
export function useLastDraw(drawCount: bigint) {
  const hasDraw = drawCount > 0n;
  const { data } = useReadContracts({
    contracts: hasDraw ? [{ ...pool, functionName: "draws", args: [drawCount - 1n] }] : [],
    query: { enabled: hasDraw },
  });

  // Six fields: (total, prize, drawPoint, period, settledAt, settled). Reading the
  // settled flag out of slot 4 picked up the timestamp instead.
  const raw = data?.[0]?.result as readonly [bigint, bigint, string, number, bigint, boolean] | undefined;
  if (!raw) return undefined;

  return { total: raw[0], prize: raw[1], drawPoint: raw[2], period: raw[3], settledAt: raw[4], settled: raw[5] };
}

/**
 * A ticking clock. Drives the countdown and the pot's accrual without re-fetching.
 *
 * Starts at 0 rather than the current time on purpose: seeding from `Date.now()` makes
 * the server and the client render different countdowns, which is a hydration mismatch.
 * Callers treat 0 as "not mounted yet" and render a placeholder.
 */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

/**
 * This week's pot, estimated from public figures only.
 *
 * Lives here rather than in a page because every tab shows it in the header, and they had
 * drifted apart: Pool computed the estimate while Draws and Proof still showed the last
 * draw's prize, so the same header displayed different numbers under the same label
 * depending on which tab you were on.
 *
 * The exact figure is `prizeFor(liveTotal) + sponsored`, and `liveTotal` is encrypted
 * precisely so that nobody can read it - two readings either side of a deposit would give
 * up that deposit. So the yield half is estimated from the total the last draw published,
 * assuming the pool ends this week near where it ended the last one. Both inputs are
 * already public and the arithmetic is the contract's own `prizeFor`, so the estimate
 * discloses nothing new.
 *
 * `prizeFor(lastTotal)` rather than last week's *prize*: the prize included last week's
 * sponsorship, which is a one-off, and carrying it forward would promise a pot that never
 * arrives. This week's sponsorships are added separately, and those are exact.
 *
 * Before any draw has settled there is no published total to estimate from and nothing
 * sponsored, so this returns exactly zero. Callers render that as an em dash rather than
 * `0.00`, because there is no pot yet - not a pot that happens to be empty. The judge
 * sandbox is deliberately left in that state, with its first cycle still to run.
 */
const RATE_DIVISOR = 10_000n * 525_600n;

export function useWeeklyPot(state: ReturnType<typeof usePoolState>, lastDraw: ReturnType<typeof useLastDraw>) {
  const yieldEstimate = lastDraw ? (lastDraw.total * state.annualRateBps) / RATE_DIVISOR : 0n;

  return {
    /** Yield estimate plus everything sponsored so far. What the header shows. */
    pot: yieldEstimate + state.sponsoredThisDraw,
    /** The estimated half on its own, for accrual over the week. */
    yieldEstimate,
    /** What the previous draw actually paid, for the line that says so. */
    lastPaid: lastDraw ? lastDraw.prize : 0n,
  };
}
