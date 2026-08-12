"use client";

import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";

/**
 * How far a keeper has swept a draw.
 *
 * Claiming is not something a depositor has to do. `checkClaim` is callable by anyone for
 * anyone, and it credits `select(won, prize, 0)` — the prize or an encrypted zero. Because
 * the amount is ciphertext, a keeper can run it across every slot without learning, or
 * leaking, which one moved. So the pot reaches its winner unattended.
 *
 * That is worth showing rather than asserting: `claimChecked` is public per slot, so the
 * count below is read straight off the chain.
 */
export function useSweepStatus(drawId?: bigint) {
  const publicClient = usePublicClient();
  const [checked, setChecked] = useState(0);
  const [total, setTotal] = useState(0);

  const read = useCallback(async () => {
    if (!publicClient || drawId === undefined) return;

    const slots = Number(
      (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotsUsed",
      })) as number,
    );
    setTotal(slots);
    if (slots === 0) return;

    // One multicall rather than a request per slot — this runs on every Pool view.
    const results = await publicClient.multicall({
      contracts: Array.from({ length: slots }, (_, slot) => ({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "claimChecked" as const,
        args: [drawId, slot],
      })),
      allowFailure: true,
    });

    setChecked(results.filter((r) => r.status === "success" && r.result === true).length);
  }, [drawId, publicClient]);

  useEffect(() => {
    void read();
  }, [read]);

  return { checked, total, refetch: read };
}
