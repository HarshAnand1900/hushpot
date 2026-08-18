"use client";

import { useCallback, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./PositionHistory.module.css";

// Written out rather than pulled from the ABI array: viem needs the literal type to know
// which `args` filters are legal, and a runtime `.find()` erases exactly that.
const DEPOSITED = parseAbiItem("event Deposited(address indexed account, uint16 indexed slot)");
const DEPOSITED_PLAIN = parseAbiItem(
  "event DepositedFromUnderlying(address indexed account, uint16 indexed slot, uint256 amount)",
);
const WITHDRAWN = parseAbiItem("event Withdrawn(address indexed account, uint16 indexed slot)");
const CLAIM_CHECKED = parseAbiItem(
  "event ClaimChecked(uint256 indexed drawId, uint16 indexed slot, address indexed checkedBy)",
);

type Row = {
  block: bigint;
  when?: number;
  kind: "DEPOSIT" | "WITHDRAW" | "CLAIM CHECKED";
  detail: string;
  clear: boolean;
};

/**
 * Your own history, assembled from public events.
 *
 * This is the honest version of an account statement: the chain knows *that* you acted
 * and when, so we show it rather than pretending otherwise. What it cannot show is how
 * much — every confidential row reads ••••••, because the amount was never written down.
 * Only the plain-token demo route carries a number, and it is labelled as such.
 *
 * Nothing here is decrypted and nothing needs a signature. It is the same view an
 * observer would build about you, which is precisely why it is worth showing you.
 */
export function PositionHistory() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Row[]>();

  const load = useCallback(async () => {
    if (!publicClient || !address) {
      setRows(undefined);
      return;
    }

    type Raw = { blockNumber: bigint | null; transactionHash: string; args: Record<string, unknown> };

    try {
      const [plain, shielded, out, checked] = await Promise.all([
        publicClient.getLogs({
          address: POOL_ADDRESS,
          event: DEPOSITED_PLAIN,
          args: { account: address },
          fromBlock: DEPLOY_BLOCK,
        }),
        publicClient.getLogs({
          address: POOL_ADDRESS,
          event: DEPOSITED,
          args: { account: address },
          fromBlock: DEPLOY_BLOCK,
        }),
        publicClient.getLogs({
          address: POOL_ADDRESS,
          event: WITHDRAWN,
          args: { account: address },
          fromBlock: DEPLOY_BLOCK,
        }),
        publicClient.getLogs({
          address: POOL_ADDRESS,
          event: CLAIM_CHECKED,
          args: { checkedBy: address },
          fromBlock: DEPLOY_BLOCK,
        }),
      ]);

      // The plain route emits both events in one transaction. Keeping both would double
      // every demo deposit, so the confidential row is dropped where a plain one exists.
      const plainTxs = new Set((plain as unknown as Raw[]).map((l) => l.transactionHash));

      const all: Row[] = [
        ...(plain as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "DEPOSIT" as const,
          detail: `${formatUnits(l.args.amount as bigint)} cUSDT · plain route`,
          clear: true,
        })),
        ...(shielded as unknown as Raw[])
          .filter((l) => !plainTxs.has(l.transactionHash))
          .map((l) => ({
            block: l.blockNumber ?? 0n,
            kind: "DEPOSIT" as const,
            detail: "•••••• cUSDT · confidential",
            clear: false,
          })),
        ...(out as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "WITHDRAW" as const,
          detail: "•••••• cUSDT · confidential",
          clear: false,
        })),
        ...(checked as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "CLAIM CHECKED" as const,
          detail: `draw #${l.args.drawId} · result stayed encrypted`,
          clear: false,
        })),
      ].sort((a, b) => Number(b.block - a.block));

      // Timestamps for the visible rows only — one RPC call each, and nobody scrolls a
      // statement far enough to justify fetching the rest.
      const shown = all.slice(0, 8);
      await Promise.all(
        shown.map(async (r) => {
          try {
            const b = await publicClient.getBlock({ blockNumber: r.block });
            r.when = Number(b.timestamp);
          } catch {
            /* a missing timestamp costs a line, not the panel */
          }
        }),
      );

      setRows(shown);
    } catch {
      setRows([]);
    }
  }, [address, publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!address) return null;

  return (
    <section className="panel">
      <div className="panelHead">
        <span>POSITION HISTORY</span>
        <span>{rows === undefined ? "READING CHAIN…" : `${rows.length} EVENTS · NO SIGNATURE`}</span>
      </div>

      {rows !== undefined && rows.length === 0 && (
        <div className={styles.empty}>
          Nothing yet. Once you deposit, this is everything the chain will know about you — the fact of it, and the
          minute. Never the size.
        </div>
      )}

      {rows?.map((r, i) => (
        <div key={`${r.block}-${i}`} className={styles.row}>
          <span className={styles.kind} data-clear={r.clear ? "yes" : "no"}>
            {r.kind}
          </span>
          <span className={styles.detail}>{r.detail}</span>
          <span className={styles.when}>
            {r.when ? new Date(r.when * 1000).toUTCString().replace("GMT", "UTC") : `block ${r.block}`}
          </span>
        </div>
      ))}

      {rows !== undefined && rows.length > 0 && (
        <div className={styles.foot}>
          Assembled from public logs — this is the statement an observer could build about you without asking. Every
          amount in it is •••••• unless you chose the plain demo route.
        </div>
      )}
    </section>
  );
}
