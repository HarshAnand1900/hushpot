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
const EV_DEPOSITED = parseAbiItem("event Deposited(address indexed account, uint16 indexed slot)");
const EV_PLAIN = parseAbiItem(
  "event DepositedFromUnderlying(address indexed account, uint16 indexed slot, uint256 amount)",
);
const EV_WITHDRAWN = parseAbiItem("event Withdrawn(address indexed account, uint16 indexed slot)");

type Row = {
  block: bigint;
  at?: number;
  kind: "JOINED" | "ADDED" | "WITHDREW" | "DRAW" | "CHECKED";
  what: string;
  amount: string;
  /** True when the figure is genuinely public rather than masked. */
  clear: boolean;
};

/**
 * Everything the chain records about you, in order.
 *
 * Deliberately the observer's view: built from public logs only, no signature, exactly
 * what somebody watching your address could assemble without asking. Showing it to you is
 * the point — you can see how much of your activity is legible, and see that the amounts
 * are not part of it.
 *
 * Draws are interleaved with your own actions so it reads as a sequence rather than two
 * disconnected lists. Whether any of those draws paid you is the one thing missing, and
 * it is missing everywhere: the contract never wrote it down.
 */
export function PositionHistory({
  drawCount,
  unlocked,
  slot,
}: {
  drawCount: bigint;
  unlocked: boolean;
  slot?: number;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Row[]>();
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
    type Raw = { blockNumber: bigint | null; transactionHash: string; args: Record<string, unknown> };

    try {
      const mine = (event: ReturnType<typeof parseAbiItem>, key: string) =>
        publicClient.getLogs({
          address: POOL_ADDRESS,
          event: event as never,
          args: { [key]: address } as never,
          fromBlock: DEPLOY_BLOCK,
        });

      const [plain, shielded, out, checked, drawList] = await Promise.all([
        mine(EV_PLAIN, "account"),
        mine(EV_DEPOSITED, "account"),
        mine(EV_WITHDRAWN, "account"),
        mine(EV_CLAIM, "checkedBy"),
        Promise.all(
          Array.from({ length: Number(drawCount) }, (_, i) =>
            publicClient.readContract({
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "draws",
              args: [BigInt(i)],
            }),
          ),
        ),
      ]);

      const plainTxs = new Set((plain as unknown as Raw[]).map((l) => l.transactionHash));
      const shieldedOnly = (shielded as unknown as Raw[]).filter((l) => !plainTxs.has(l.transactionHash));

      const deposits: Row[] = [
        ...(plain as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "ADDED" as const,
          what: "deposited — plain route, so the size is public",
          amount: formatUnits(l.args.amount as bigint),
          clear: true,
        })),
        ...shieldedOnly.map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "ADDED" as const,
          what: "deposited — confidential route, no amount was written",
          amount: "••••••",
          clear: false,
        })),
      ].sort((a, b) => Number(a.block - b.block));

      // The earliest deposit is the moment the slot was claimed — the only thing here
      // that happened exactly once.
      if (deposits.length > 0) {
        deposits[0] = { ...deposits[0], kind: "JOINED", what: `joined the pool · slot ${slot ?? "—"}` };
      }

      const checkedDraws = new Set((checked as unknown as Raw[]).map((l) => String(l.args.drawId as bigint)));

      const all: Row[] = [
        ...deposits,
        ...(out as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "WITHDREW" as const,
          what: "took principal back out",
          amount: "••••••",
          clear: false,
        })),
        // A settled draw is a checkpoint in your story whether or not you touched it.
        ...(drawList as readonly (readonly [bigint, bigint, string, number, boolean])[]).map((d, i) => ({
          block: 0n,
          kind: checkedDraws.has(String(i)) ? ("CHECKED" as const) : ("DRAW" as const),
          what: checkedDraws.has(String(i))
            ? `draw #${i} was checked for you — the result went into your balance, unread by anyone`
            : `draw #${i} settled — you have not checked it`,
          amount: formatUnits(d[1]),
          clear: true,
        })),
      ];

      await Promise.all(
        all.map(async (r) => {
          if (r.block === 0n) return;
          try {
            const b = await publicClient.getBlock({ blockNumber: r.block });
            r.at = Number(b.timestamp);
          } catch {
            /* a missing timestamp costs one cell, not the panel */
          }
        }),
      );

      setRows(all.sort((a, b) => Number(b.block - a.block)));
    } catch {
      setRows([]);
    }
  }, [address, drawCount, publicClient, slot]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!address) return null;

  const yours = rows?.filter((r) => r.kind !== "DRAW" && r.kind !== "CHECKED").length ?? 0;

  return (
    <section className="panel">
      <div className="panelHead">
        <span>POSITION HISTORY · {shortenAddress(address)}</span>
        <span>{rows === undefined ? "READING CHAIN…" : `${yours} ACTIONS · NO SIGNATURE NEEDED`}</span>
      </div>

      <div className={styles.intro}>
        The observer&apos;s view — assembled from public logs, exactly what somebody watching your address could build
        without asking you. It is here so you can see how much of your activity is legible, and see that the amounts are
        not part of it.
      </div>

      <div className={styles.head}>
        <span>WHEN</span>
        <span>WHAT THE CHAIN RECORDED</span>
        <span>AMOUNT</span>
      </div>

      {rows?.length === 0 && <div className={styles.empty}>Nothing yet. Deposit and this fills in.</div>}

      {rows?.map((r, i) => (
        <div key={`${r.kind}-${r.block}-${i}`} className={styles.row}>
          <span className={styles.when}>
            <span className={r.kind === "JOINED" ? `${styles.tag} ${styles.tagOn}` : styles.tag}>{r.kind}</span>
            <span className={styles.stamp}>{r.at ? new Date(r.at * 1000).toUTCString().slice(5, 22) : "—"}</span>
          </span>
          <span className={styles.what}>{r.what}</span>
          <span className={r.clear ? styles.amount : `${styles.amount} ${styles.masked}`}>{r.amount}</span>
        </div>
      ))}

      <div className={styles.strip}>
        <Fact k="BALANCE HANDLE" v={handle ? `${handle.slice(0, 10)}…${handle.slice(-4)}` : "not published yet"} />
        <Fact k="AMOUNTS ABOVE" v={unlocked ? "STILL NOT THERE" : "NOT THERE"} gold />
        <Fact k="SERVER COPIES" v="NONE" gold />
      </div>

      <div className={styles.foot}>
        The one thing missing is whether any of those draws paid you — and it is missing everywhere, not only here. The
        contract never wrote it down. Only your own key, on your own balance, can answer it.
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
