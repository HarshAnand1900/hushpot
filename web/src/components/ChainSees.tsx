"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import styles from "./ChainSees.module.css";

/**
 * The same three reads an explorer would make, made here.
 *
 * Not a diagram of what the chain sees - the actual return values of the actual calls,
 * side by side: a published number, your handle, and a stranger's handle. Two of the
 * three come back as ciphertext, and the page does not pretend to open either.
 */
export function ChainSees() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<{ call: string; value: string; clear: boolean }[]>();

  const load = useCallback(async () => {
    if (!publicClient) return;

    const read = (fn: string, args?: readonly unknown[]) =>
      publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: fn as never,
        args: args as never,
      });

    const short = (h: string) => `${h.slice(0, 20)}…`;
    const isEmpty = (h: string) => /^0x0+$/.test(h);

    try {
      const drawCount = (await read("drawCount")) as bigint;

      // The published total - the one legible number in the whole system.
      let total = "not published yet";
      let die = "no draw settled yet";
      if (drawCount > 0n) {
        const d = (await read("draws", [drawCount - 1n])) as readonly [bigint, bigint, string, number, boolean];
        total = d[0].toLocaleString();
        die = isEmpty(d[2]) ? "——" : short(d[2]);
      }

      // Your own balance handle. This is a cache the contract fills only when you ask it
      // to, which is itself the point: nobody publishes a handle on your behalf, so an
      // untouched slot has nothing at all for an observer to fetch.
      let mine = "empty, since you have not asked the contract to compute it";
      if (address) {
        try {
          const has = (await read("hasSlot", [address])) as boolean;
          if (has) {
            const slot = Number((await read("slotOf", [address])) as number);
            const h = (await read("balanceHandle", [slot])) as string;
            mine = isEmpty(h) ? "empty until you reveal, with nothing published for you" : short(h);
          }
        } catch {
          /* no slot is an ordinary state */
        }
      }

      setRows([
        {
          call: `draws(${drawCount > 0n ? drawCount - 1n : 0n}).total · the published pool`,
          value: total,
          clear: true,
        },
        { call: `draws(${drawCount > 0n ? drawCount - 1n : 0n}).drawPoint · the die`, value: die, clear: false },
        { call: "balanceHandle(you) · your balance", value: mine, clear: false },
      ]);
    } catch {
      setRows([]);
    }
  }, [address, publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>WHAT THE CHAIN SEES</span>
        <span>THREE READ-ONLY CALLS · NO WALLET</span>
      </div>

      {rows?.map((r) => (
        <div key={r.call} className={styles.row}>
          <span className={styles.call}>{r.call}</span>
          <span className={r.clear ? styles.value : `${styles.value} ${styles.cipher}`}>{r.value}</span>
          <span className={r.clear ? `${styles.tag} ${styles.tagPublic}` : styles.tag}>
            {r.clear ? "PLAINTEXT" : "CIPHERTEXT"}
          </span>
        </div>
      ))}

      {rows === undefined && <div className={styles.foot}>Reading the chain…</div>}

      <div className={styles.foot}>
        One number and one ciphertext, from the same three calls anyone can make. The die decided a whole draw and is
        still unreadable by you, by us, and by the contract that rolled it. Your own balance handle is not even
        published until you ask for it, so an untouched slot gives an observer nothing to fetch at all.
      </div>
    </section>
  );
}
