"use client";

import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS, poolAbi } from "@/lib/contract";

const EV_SETTLED = parseAbiItem("event DrawSettled(uint256 indexed drawId, uint64 total, uint64 prize)");

/**
 * When each draw was actually settled, and how long its claim window still has to run.
 *
 * The `Draw` struct stores no timestamp, so everything that wanted one reached for
 * `lastDrawSettledAt` — a single value describing only the newest draw. Read per draw it
 * is simply wrong: every draw showed the same settle time, and every draw inherited the
 * newest draw's countdown, so an older window looked as fresh as the current one no matter
 * how much of its thirty days had already gone.
 *
 * The honest source is the log. `DrawSettled` is emitted in the settling transaction, so
 * its block timestamp *is* the settle time, per draw, with nothing to store on-chain.
 *
 * A missing draw is left missing rather than guessed at. Log queries are the flakiest read
 * this app makes — nodes behind one endpoint disagree about how much history they hold —
 * and a countdown that quietly falls back to another draw's clock is the bug this replaces.
 */
export function useSettledAt(drawCount: bigint) {
  const publicClient = usePublicClient();
  const [at, setAt] = useState<Record<string, number>>({});
  const [grace, setGrace] = useState<number>();

  useEffect(() => {
    if (!publicClient) return;
    let live = true;

    void (async () => {
      try {
        const window = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "CLAIM_GRACE",
        })) as bigint;
        if (live) setGrace(Number(window));

        const logs = await publicClient.getLogs({
          address: POOL_ADDRESS,
          event: EV_SETTLED,
          fromBlock: DEPLOY_BLOCK,
        });

        // One `getBlock` per distinct block, not per log: draws settle in their own
        // transactions, but two settled in the same block would otherwise be fetched twice.
        const blocks = [...new Set(logs.map((l) => l.blockNumber))];
        const times = new Map<bigint, number>();
        for (const blockNumber of blocks) {
          const block = await publicClient.getBlock({ blockNumber });
          times.set(blockNumber, Number(block.timestamp));
        }
        if (!live) return;

        const next: Record<string, number> = {};
        for (const log of logs) {
          const id = (log.args as { drawId?: bigint }).drawId;
          const time = times.get(log.blockNumber);
          if (id !== undefined && time !== undefined) next[String(id)] = time;
        }
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
