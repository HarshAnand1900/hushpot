"use client";

import { useReadContracts } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";

export interface DrawRecord {
  id: bigint;
  total: bigint;
  prize: bigint;
  drawPoint: string;
  period: number;
  /** Unix seconds. The claim window runs from here, not from the period roll. */
  settledAt: bigint;
  settled: boolean;
}

/**
 * Every settled draw, newest first.
 *
 * Note what a draw record contains: a pool total, a prize, and the ciphertext handle of
 * the die. There is no winner field - not hidden, not omitted for privacy, simply never
 * computed. The missing column is the product working.
 */
export function useDraws(drawCount: bigint) {
  const ids = Array.from({ length: Number(drawCount) }, (_, i) => BigInt(i));

  const { data, isLoading } = useReadContracts({
    contracts: ids.map((id) => ({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "draws" as const,
      args: [id] as const,
    })),
    query: { enabled: drawCount > 0n },
  });

  const draws: DrawRecord[] = (data ?? [])
    .map((entry, i) => {
      // Six fields, not five. `draws()` returns (total, prize, drawPoint, period,
      // settledAt, settled), and reading `raw[4]` as the settled flag picked up the
      // timestamp instead. The filter below still behaved, because a timestamp is
      // non-zero exactly when a draw is settled, but the type said boolean while the
      // value was a bigint, so the first strict comparison anyone wrote would have
      // silently dropped every draw.
      const raw = entry?.result as readonly [bigint, bigint, string, number, bigint, boolean] | undefined;
      if (!raw) return undefined;
      return {
        id: ids[i],
        total: raw[0],
        prize: raw[1],
        drawPoint: raw[2],
        period: raw[3],
        settledAt: raw[4],
        settled: raw[5],
      };
    })
    .filter((d): d is DrawRecord => !!d && d.settled)
    .reverse();

  const totalPaid = draws.reduce((sum, d) => sum + d.prize, 0n);

  return { draws, totalPaid, isLoading };
}
