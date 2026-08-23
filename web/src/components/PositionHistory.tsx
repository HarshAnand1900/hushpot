"use client";

import { useCallback, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { useAccount, usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS, TOKEN_ADDRESS, poolAbi } from "@/lib/contract";
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

/**
 * The token's own transfer event, which is where the amounts actually are.
 *
 * The pool never stores what an individual deposit was — only a running balance — so for a
 * long time this table could show that you deposited and never what. The token, though,
 * emits the amount as an indexed ciphertext handle on every move, and the ACL keeps the
 * sender permitted on it permanently: `isAllowed(sender)` and `persistAllowed(sender)` are
 * both true for handles from months ago.
 *
 * So the figure is recoverable, by you and by nobody else. That is a better demonstration
 * than a row of dots: the amount is not gone, it is addressed to exactly one person.
 */
const EV_CTRANSFER = parseAbiItem(
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)",
);

type Row = {
  block: bigint;
  at?: number;
  /** The transaction this row came from, for the detail panel and Etherscan. */
  tx?: string;
  /** The token-side ciphertext of the amount, when there is one to reveal. */
  cipher?: string;
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
export function PositionHistory({ drawCount, slot }: { drawCount: bigint; slot?: number }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Row[]>();
  const [handle, setHandle] = useState<string>();

  // Which row is expanded, and what its amount turned out to be once opened. Keyed by
  // transaction hash so a poll refreshing the rows does not close what you were reading.
  const [openTx, setOpenTx] = useState<string>();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string>();

  const reveal = useCallback(async (tx: string, cipher: string) => {
    setRevealing(tx);
    try {
      const { decryptHandle } = await import("@/lib/fhe");
      const value = await decryptHandle(cipher, TOKEN_ADDRESS);
      setRevealed((prev) => ({ ...prev, [tx]: value === undefined ? "could not open" : formatUnits(value) }));
    } catch {
      setRevealed((prev) => ({ ...prev, [tx]: "could not open" }));
    } finally {
      setRevealing(undefined);
    }
  }, []);

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

      // Amounts come from the token, keyed back to the pool's events by transaction.
      const transfers = (event: ReturnType<typeof parseAbiItem>, key: string) =>
        publicClient.getLogs({
          address: TOKEN_ADDRESS,
          event: event as never,
          args: { [key]: address } as never,
          fromBlock: DEPLOY_BLOCK,
        });

      const [plain, shielded, out, checked, sent, received, drawList] = await Promise.all([
        mine(EV_PLAIN, "account"),
        mine(EV_DEPOSITED, "account"),
        mine(EV_WITHDRAWN, "account"),
        mine(EV_CLAIM, "checkedBy"),
        transfers(EV_CTRANSFER, "from"),
        transfers(EV_CTRANSFER, "to"),
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

      // One lookup from transaction hash to the amount's ciphertext. A deposit is a
      // transfer out of your wallet, a withdrawal is one back in, and both land in the
      // same transaction as the pool event they belong to.
      const cipherByTx = new Map<string, string>();
      for (const l of [...(sent as unknown as Raw[]), ...(received as unknown as Raw[])]) {
        const h = (l as unknown as { topics: string[] }).topics?.[3];
        if (h) cipherByTx.set(l.transactionHash, h);
      }

      const plainTxs = new Set((plain as unknown as Raw[]).map((l) => l.transactionHash));
      const shieldedOnly = (shielded as unknown as Raw[]).filter((l) => !plainTxs.has(l.transactionHash));

      const deposits: Row[] = [
        ...(plain as unknown as Raw[]).map((l) => ({
          block: l.blockNumber ?? 0n,
          kind: "ADDED" as const,
          what: "deposited — plain route, so the size is public",
          amount: formatUnits(l.args.amount as bigint),
          tx: l.transactionHash,
          clear: true,
        })),
        ...shieldedOnly.map((l) => ({
          block: l.blockNumber ?? 0n,
          tx: l.transactionHash,
          cipher: cipherByTx.get(l.transactionHash),
          kind: "ADDED" as const,
          what: "deposited — confidential, the amount was never written down",
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
          tx: l.transactionHash,
          cipher: cipherByTx.get(l.transactionHash),
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

  // Polled like the rest of the page, so a deposit or a sweep shows up here without a
  // reload. Everything it reads is a public log, so this costs nothing but an RPC call.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
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

      {rows?.map((r, i) => {
        const openable = !!r.cipher && !!r.tx;
        const isOpen = openable && openTx === r.tx;

        return (
          <div key={`${r.kind}-${r.block}-${i}`}>
            <div
              className={openable ? `${styles.row} ${styles.rowOpenable}` : styles.row}
              onClick={() => openable && setOpenTx(isOpen ? undefined : r.tx)}
              role={openable ? "button" : undefined}
              tabIndex={openable ? 0 : undefined}
            >
              <span className={styles.when}>
                <span className={r.kind === "JOINED" ? `${styles.tag} ${styles.tagOn}` : styles.tag}>{r.kind}</span>
                <span className={styles.stamp}>{r.at ? new Date(r.at * 1000).toUTCString().slice(5, 22) : "—"}</span>
              </span>
              <span className={styles.what}>{r.what}</span>
              <span className={r.clear ? styles.amount : `${styles.amount} ${styles.masked}`}>
                {r.tx && revealed[r.tx] ? revealed[r.tx] : r.amount}
                {openable && <span className={styles.chev}>{isOpen ? " ▾" : " ▸"}</span>}
              </span>
            </div>

            {isOpen && r.tx && r.cipher && (
              <div className={styles.detail}>
                <div className={styles.detailGrid}>
                  <span className={styles.dk}>TRANSACTION</span>
                  <a
                    className={styles.dv}
                    href={`https://sepolia.etherscan.io/tx/${r.tx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.tx.slice(0, 18)}…{r.tx.slice(-6)} ↗
                  </a>

                  <span className={styles.dk}>BLOCK</span>
                  <span className={styles.dv}>{r.block.toLocaleString()}</span>

                  <span className={styles.dk}>AMOUNT, AS STORED</span>
                  <span className={styles.dv}>
                    {r.cipher.slice(0, 22)}…{r.cipher.slice(-4)}
                  </span>
                </div>

                {revealed[r.tx] ? (
                  <div className={styles.revealed}>
                    <span className={styles.dk}>OPENED WITH YOUR KEY</span>
                    <span className={`num ${styles.revealedValue}`}>{revealed[r.tx]} cUSDT</span>
                  </div>
                ) : (
                  <button
                    className="btnOutlineYellow"
                    onClick={(e) => {
                      e.stopPropagation();
                      void reveal(r.tx!, r.cipher!);
                    }}
                    disabled={revealing === r.tx}
                  >
                    {revealing === r.tx ? "Opening…" : "Reveal this amount"}
                  </button>
                )}

                <div className={styles.detailNote}>
                  That ciphertext is the amount, exactly as the token recorded it. The ACL has kept you permitted on it
                  since the day it was written and nobody else — not the pool, not us — was ever added. Opening it uses
                  the session you already signed; it costs no transaction and reveals nothing to anyone else.
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className={styles.strip}>
        <Fact k="BALANCE HANDLE" v={handle ? `${handle.slice(0, 10)}…${handle.slice(-4)}` : "not published yet"} />
        <Fact k="AMOUNTS ABOVE" v="YOURS TO OPEN" gold />
        <Fact k="SERVER COPIES" v="NONE" gold />
      </div>

      <div className={styles.foot}>
        Every confidential row opens: the amount is stored as a ciphertext only you are permitted to read, so click one
        and reveal it. What stays missing everywhere, including here, is whether a draw paid you — the contract never
        wrote that down for anyone.
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
