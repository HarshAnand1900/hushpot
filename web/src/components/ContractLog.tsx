"use client";

import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/format";
import styles from "./ContractLog.module.css";

type Entry = { block: bigint; kind: string; who?: string; detail: string; accent?: boolean };

/**
 * What the chain actually recorded, as it happened.
 *
 * Everything here is public and always was — deposits, settlements, claims checked. The
 * point is what is *missing* from it: no amounts on the confidential route, and no winner
 * on any row. A log that shows every event and still cannot tell you who won is a better
 * argument than a paragraph claiming the same thing.
 */
export function ContractLog({ limit = 8 }: { limit?: number }) {
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Entry[]>();
  const [head, setHead] = useState<bigint>();

  const load = useCallback(async () => {
    if (!publicClient) return;

    const ev = (name: string) => poolAbi.find((e) => e.type === "event" && e.name === name) as never;
    type Raw = { blockNumber: bigint | null; args: Record<string, unknown> };

    try {
      const [plain, shielded, settled, checked, block] = await Promise.all([
        publicClient.getLogs({ address: POOL_ADDRESS, event: ev("DepositedFromUnderlying"), fromBlock: DEPLOY_BLOCK }),
        publicClient.getLogs({ address: POOL_ADDRESS, event: ev("Deposited"), fromBlock: DEPLOY_BLOCK }),
        publicClient.getLogs({ address: POOL_ADDRESS, event: ev("DrawSettled"), fromBlock: DEPLOY_BLOCK }),
        publicClient.getLogs({ address: POOL_ADDRESS, event: ev("ClaimChecked"), fromBlock: DEPLOY_BLOCK }),
        publicClient.getBlockNumber(),
      ]);

      const plainTxs = new Set((plain as unknown as { transactionHash: string }[]).map((l) => l.transactionHash));

      const all: Entry[] = [
        ...(plain as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "DEPOSIT",
          who: l.args.account as string,
          detail: `${formatUnits(l.args.amount as bigint)} cUSDT · plain route, size public`,
        })),
        ...(shielded as unknown as (Raw & { transactionHash: string })[])
          .filter((l) => !plainTxs.has(l.transactionHash))
          .map((l) => ({
            block: l.blockNumber ?? 0n,
            kind: "DEPOSIT",
            who: l.args.account as string,
            detail: "•••••• cUSDT · confidential route, amount never in the clear",
          })),
        ...(settled as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "DRAW SETTLED",
          detail: `#${l.args.drawId} · ${formatUnits(l.args.prize as bigint)} cUSDT · NO WINNER RESOLVED`,
          accent: true,
        })),
        ...(checked as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "CLAIM CHECKED",
          detail: `slot ${l.args.slot} · result encrypted, outcome unknown to everyone`,
        })),
      ].sort((a, b) => (a.block > b.block ? -1 : 1));

      setRows(all.slice(0, limit));
      setHead(block);
    } catch {
      setRows([]);
    }
  }, [publicClient, limit]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>
          <span className="liveDot" /> CONTRACT LOG
        </span>
        <span>{head !== undefined ? `BLOCK ${Number(head).toLocaleString()}` : "—"}</span>
      </div>

      <div className={styles.body}>
        {rows === undefined ? (
          <div className={styles.empty}>READING THE CHAIN…</div>
        ) : rows.length === 0 ? (
          <div className={styles.empty}>NOTHING YET · THE POOL IS NEW</div>
        ) : (
          rows.map((r, i) => (
            <div key={i} className={styles.row}>
              <span className={styles.block}>{Number(r.block).toLocaleString()}</span>
              <span className={r.accent ? `${styles.kind} ${styles.kindAccent}` : styles.kind}>{r.kind}</span>
              <span className={styles.who}>{r.who ? shortenAddress(r.who) : "—"}</span>
              <span className={styles.detail}>{r.detail}</span>
            </div>
          ))
        )}
      </div>

      <div className={styles.foot}>
        Every row is public and always was. Note what is absent: no amount on a confidential deposit, and no winner on
        any settlement — there is no winner field in storage for a log to carry.
      </div>
    </section>
  );
}
