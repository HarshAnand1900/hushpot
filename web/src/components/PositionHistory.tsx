"use client";

import { useCallback, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/format";
import styles from "./PositionHistory.module.css";

const EV_CLAIM = parseAbiItem(
  "event ClaimChecked(uint256 indexed drawId, uint16 indexed slot, address indexed checkedBy)",
);

type Row = { draw: bigint; found: string; amount: string; claim: string; opened: boolean };

/**
 * Your record, draw by draw.
 *
 * The column that matters is WHAT YOU FOUND WHEN YOU LOOKED, because that is the only
 * place an outcome ever exists. The contract never wrote one down: a claim adds the prize
 * or an encrypted zero, and the two are indistinguishable on-chain. So this table can
 * show that you checked, and when — both public — but the result stays •••••• until your
 * own key opens the balance in this tab.
 *
 * That is the honest shape of it. A history that filled in "won" or "lost" from a server
 * would mean a server knew, which is exactly the thing being avoided.
 */
export function PositionHistory({
  drawCount,
  unlocked,
  slot,
}: {
  drawCount: bigint;
  unlocked: boolean;
  /** Your slot, once known. The handle behind it is read here. */
  slot?: number;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Row[]>();

  // The real ciphertext handle. It is public, and showing it is a stronger statement than
  // dots: this is the actual thing stored on-chain, and it still tells you nothing.
  const [handle, setHandle] = useState<string>();
  useEffect(() => {
    if (!publicClient || slot === undefined) return;
    let live = true;
    void publicClient
      .readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "balanceHandle", args: [slot] })
      .then((h) => {
        if (live && typeof h === "string" && !/^0x0+$/.test(h)) setHandle(h);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [publicClient, slot]);

  const load = useCallback(async () => {
    if (!publicClient || !address) {
      setRows(undefined);
      return;
    }

    try {
      const checked = await publicClient.getLogs({
        address: POOL_ADDRESS,
        event: EV_CLAIM,
        args: { checkedBy: address },
        fromBlock: DEPLOY_BLOCK,
      });

      const seen = new Map<string, Row>();
      for (const l of checked as unknown as { args: Record<string, unknown> }[]) {
        const draw = l.args.drawId as bigint;
        seen.set(String(draw), {
          draw,
          found: unlocked ? "your balance, opened in this tab" : "••••••",
          amount: "••••••",
          claim: "CHECKED",
          opened: unlocked,
        });
      }

      // Every settled draw gets a line, so an unchecked one is visible as unchecked
      // rather than silently absent.
      const all: Row[] = [];
      for (let i = drawCount - 1n; i >= 0n && all.length < 6; i--) {
        all.push(
          seen.get(String(i)) ?? {
            draw: i,
            found: "you never looked",
            amount: "——",
            claim: "NOT CHECKED",
            opened: false,
          },
        );
        if (i === 0n) break;
      }

      setRows(all);
    } catch {
      setRows([]);
    }
  }, [address, drawCount, publicClient, unlocked]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!address) return null;

  return (
    <section className="panel">
      <div className="panelHead">
        <span>POSITION HISTORY · {shortenAddress(address)}</span>
        <span style={{ color: unlocked ? "var(--yellow)" : undefined }}>
          {unlocked ? "DECRYPTED IN THIS TAB" : "ENCRYPTED ON-CHAIN"}
        </span>
      </div>

      <div className={styles.intro}>
        Your whole record — deposits, withdrawals, claims, anything you ever won — is ciphertext until you decrypt it
        locally. Nothing here is fetched from a server.
        {!unlocked && <div className={styles.hint}>REVEAL BELOW TO OPEN THE RECORD ↓</div>}
      </div>

      <div className={styles.head}>
        <span>DRAW</span>
        <span>WHAT YOU FOUND WHEN YOU LOOKED</span>
        <span>AMOUNT</span>
        <span>CLAIM</span>
      </div>

      {rows?.length === 0 && <div className={styles.empty}>No draws have settled yet.</div>}

      {rows?.map((r) => (
        <div key={String(r.draw)} className={styles.row}>
          <span className={styles.draw}>#{String(r.draw)}</span>
          <span className={r.opened ? styles.found : `${styles.found} ${styles.masked}`}>{r.found}</span>
          <span className={styles.amount}>{r.amount}</span>
          <span className={r.claim === "CHECKED" ? `${styles.claim} ${styles.claimOn}` : styles.claim}>{r.claim}</span>
        </div>
      ))}

      {/* The proof strip: a real handle, and the two facts about where it can be read. */}
      <div className={styles.strip}>
        <Fact k="BALANCE HANDLE" v={handle ? `${handle.slice(0, 10)}…${handle.slice(-4)}` : "——"} />
        <Fact k="DECRYPTED" v={unlocked ? "IN THIS TAB ONLY" : "NOT YET"} gold={unlocked} />
        <Fact k="SERVER COPIES" v="NONE" gold />
      </div>
    </section>
  );
}

function Fact({ k, v, gold }: { k: string; v: string; gold?: boolean }) {
  return (
    <div className={styles.fact}>
      <div className={styles.factK}>{k}</div>
      <div className={styles.factV} style={{ color: gold ? "var(--yellow)" : undefined }}>
        {v}
      </div>
    </div>
  );
}
