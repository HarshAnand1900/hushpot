"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import styles from "./DrawTimeline.module.css";

/**
 * Where a draw is in its life, and where you are in it.
 *
 * Two different questions, and the second one is answerable without giving anything away.
 * `claimChecked` is public per slot, so the chain will happily say whether you have opened
 * a draw — it just will not say what you found. That distinction is the product, so the
 * copy states it rather than leaving it to be assumed.
 */
export function DrawTimeline({ drawId, isLatest }: { drawId: bigint; isLatest: boolean }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [settledAt, setSettledAt] = useState<number>();
  const [grace, setGrace] = useState<number>();
  const [checked, setChecked] = useState<boolean>();
  const [swept, setSwept] = useState<{ done: number; total: number }>();
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!publicClient) return;
    let live = true;

    const load = async () => {
      try {
        const [at, window, slots] = await Promise.all([
          publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "lastDrawSettledAt" }),
          publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "CLAIM_GRACE" }),
          publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "slotsUsed" }),
        ]);
        if (!live) return;

        setSettledAt(Number(at as bigint));
        setGrace(Number(window as bigint));

        const count = Number(slots as number);
        const results = await publicClient.multicall({
          contracts: Array.from({ length: count }, (_, slot) => ({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "claimChecked" as const,
            args: [drawId, slot],
          })),
          allowFailure: true,
        });
        if (!live) return;

        setSwept({
          done: results.filter((r) => r.status === "success" && r.result === true).length,
          total: count,
        });

        if (address) {
          const has = await publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "hasSlot",
            args: [address],
          });
          if (!live) return;

          if (has) {
            const slot = await publicClient.readContract({
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "slotOf",
              args: [address],
            });
            const mine = await publicClient.readContract({
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "claimChecked",
              args: [drawId, slot],
            });
            if (live) setChecked(mine as boolean);
          }
        }
      } catch {
        /* the receipt is still readable without this strip */
      }
    };

    // Polled, because a sweep happening while this page is open should be visible without
    // a reload — the claim counts are the part of the receipt that actually moves.
    void load();
    const id = setInterval(() => void load(), 20_000);

    return () => {
      live = false;
      clearInterval(id);
    };
  }, [publicClient, address, drawId]);

  // Only the most recent draw can still be claimed — the period rolls once the window
  // closes, and a rolled period ends every claim behind it.
  const closesAt = settledAt && grace ? settledAt + grace : undefined;
  const remaining = closesAt && now ? closesAt - now : undefined;
  const open = isLatest && remaining !== undefined && remaining > 0;

  const left = (() => {
    if (remaining === undefined || remaining <= 0) return "closed";
    const days = Math.floor(remaining / 86_400);
    if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left`;
    const hours = Math.floor(remaining / 3_600);
    return hours >= 1 ? `${hours} hr left` : "closing today";
  })();

  const stamp = (t?: number) => (t ? new Date(t * 1000).toUTCString().replace("GMT", "UTC") : "—");

  return (
    <div className={styles.wrap}>
      <ol className={styles.track}>
        <li className={styles.stepDone}>
          <span className={styles.dot} />
          <span className={styles.stepLabel}>SETTLED</span>
          <span className={styles.stepValue}>{stamp(settledAt)}</span>
        </li>

        <li className={open ? styles.stepLive : styles.stepDone}>
          <span className={styles.dot} />
          <span className={styles.stepLabel}>{open ? "CLAIMABLE NOW" : "CLAIM WINDOW"}</span>
          <span className={styles.stepValue}>{open ? left : "closed"}</span>
        </li>

        <li className={open ? styles.step : styles.stepDone}>
          <span className={styles.dot} />
          <span className={styles.stepLabel}>PERIOD ROLLS</span>
          <span className={styles.stepValue}>{stamp(closesAt)}</span>
        </li>
      </ol>

      <div className={styles.status}>
        <span className={styles.statusCell}>
          <span className={styles.statusLabel}>OPENED BY DEPOSITORS</span>
          <span className={styles.statusValue}>{swept ? `${swept.done} / ${swept.total}` : "—"}</span>
        </span>

        <span className={styles.statusCell}>
          <span className={styles.statusLabel}>YOUR CLAIM</span>
          <span className={styles.statusValue} style={{ color: checked ? "var(--yellow)" : undefined }}>
            {checked === undefined ? "not in this draw" : checked ? "opened" : "unopened"}
          </span>
        </span>
      </div>

      <p className={styles.note}>
        Whether an address opened a draw is public; what it found is not. So this says how many people have looked, and
        never how many were paid. The winner is somewhere in that count and stays there.
      </p>
    </div>
  );
}
