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

  const raw = data?.[0]?.result as readonly [bigint, bigint, string, number, boolean] | undefined;
  if (!raw) return undefined;

  return { total: raw[0], prize: raw[1], drawPoint: raw[2], period: raw[3], settled: raw[4] };
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
