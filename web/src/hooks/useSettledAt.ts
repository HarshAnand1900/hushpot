"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";

/**
 * When each draw was settled, and the length of the claim grace.
 *
 * Everything that wanted a settle time used to reach for `lastDrawSettledAt` — a single
 * value describing only the newest draw. Read per draw it is simply wrong: every draw
 * showed the same moment, and every draw inherited the newest draw's countdown, so an
 * older window looked as fresh as the current one however much of its thirty days had
 * gone. This walked the `DrawSettled` logs to get a real answer, which worked but made the
 * flakiest read in the app load-bearing for a countdown.
 *
 * The draw now records its own `settledAt`, because the contract needs it too: the claim
 * window is thirty days of wall-clock time, not a count of rolls. So this is an ordinary
 * multicall over state, and the interface and the contract are reading the same field.
 */
export function useSettledAt(drawCount: bigint) {
  const publicClient = usePublicClient();
  const [at, setAt] = useState<Record<string, number>>({});
  const [grace, setGrace] = useState<number>();

  useEffect(() => {
    if (!publicClient || drawCount === 0n) return;
    let live = true;

    void (async () => {
      try {
        const window = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "CLAIM_GRACE",
        })) as bigint;
        if (live) setGrace(Number(window));

        const rows = await publicClient.multicall({
          contracts: Array.from({ length: Number(drawCount) }, (_, i) => ({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "draws" as const,
            args: [BigInt(i)],
          })),
          allowFailure: true,
        });
        if (!live) return;

        const next: Record<string, number> = {};
        rows.forEach((row, i) => {
          if (row.status !== "success") return;
          // total, prize, drawPoint, period, settledAt, settled
          const settledAt = (row.result as readonly unknown[])[4] as bigint;
          if (settledAt > 0n) next[String(i)] = Number(settledAt);
        });
        setAt(next);
      } catch {
        /* leave the map empty; callers show no countdown rather than a borrowed one */
      }
    })();

    return () => {
      live = false;
    };
  }, [publicClient, drawCount]);

  return { at, grace };
}
