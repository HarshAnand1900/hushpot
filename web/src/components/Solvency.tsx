"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./Solvency.module.css";

/**
 * Solvency, proven rather than promised.
 *
 * The comparison runs on ciphertext inside the contract; the only thing that becomes
 * public is the single bit that falls out of it. Neither the pool's holdings nor what it
 * owes is ever revealed.
 */
export function Solvency() {
  const publicClient = usePublicClient();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<"idle" | "proving" | "backed" | "short" | "error">("idle");
  const [error, setError] = useState<string>();
  const [provenAt, setProvenAt] = useState<number>(0);
  const [rows, setRows] = useState<{ k: string; v: string; gold?: boolean }[]>([]);

  /**
   * The three lines the design puts under the badge: what the pool owes, what it holds,
   * and the comparison between them. The first is a handle rather than a number - that is
   * the whole point, and printing a total there would undo the proof it is describing.
   */
  const readRows = useCallback(
    async (handle: string, passed: boolean) => {
      if (!publicClient) return;
      try {
        const reserve = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "prizeReserve",
        })) as bigint;

        setRows([
          { k: "ENCRYPTED SUM OF ALL BALANCES", v: `handle ${handle.slice(0, 6)}…${handle.slice(-4)}` },
          { k: "POOL HOLDINGS · cUSDT", v: `${formatUnits(reserve)} cUSDT` },
          {
            k: "FHE.ge(assets, liabilities)",
            v: passed ? "TRUE · no amount revealed" : "FALSE",
            gold: passed,
          },
        ]);
      } catch {
        setRows([]);
      }
    },
    [publicClient],
  );

  /**
   * Read whatever proof already exists. No wallet, no transaction - the result was made
   * publicly decryptable when it was produced, so a passing visitor can check it. A
   * solvency proof only a connected wallet can see would defeat the point.
   */
  const readExisting = useCallback(async () => {
    if (!publicClient) return;
    try {
      const at = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "solvencyProvenAt",
      })) as bigint;

      if (at === 0n) return;
      setProvenAt(Number(at));

      const handle = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "solvencyHandle",
      })) as string;

      const { publicDecryptRetry } = await import("@/lib/fhe");
      const result = await publicDecryptRetry([handle]);
      const value = Object.values(result.clearValues ?? {})[0];
      setState(value ? "backed" : "short");
      await readRows(handle, !!value);
    } catch {
      /* leave it unproven rather than claiming anything */
    }
  }, [publicClient, readRows]);

  useEffect(() => {
    void readExisting();
  }, [readExisting]);

  const prove = useCallback(async () => {
    if (!publicClient) return;
    setError(undefined);
    setState("proving");

    try {
      const tx = await writeContractAsync({ address: POOL_ADDRESS, abi: poolAbi, functionName: "proveSolvency" });
      // The relayer has to see the publish grant this transaction made; one confirmation
      // leaves too little room for that to reach whichever node it reads.
      await waitForTransactionReceipt(config, { hash: tx, confirmations: 2 });

      const handle = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "solvencyHandle",
      })) as string;

      const { publicDecryptRetry } = await import("@/lib/fhe");
      const result = await publicDecryptRetry([handle]);
      const value = Object.values(result.clearValues ?? {})[0];

      setState(value ? "backed" : "short");
      await readRows(handle, !!value);
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 150) : "Could not prove solvency.");
      setState("error");
    }
  }, [config, publicClient, readRows, writeContractAsync]);

  const tag =
    state === "backed" ? "PASSED" : state === "short" ? "SHORTFALL" : state === "proving" ? "RUNNING" : "UNPROVEN";

  return (
    <section className={styles.band}>
      {/* the badge */}
      <div className={styles.badgeCell}>
        <div className={styles.badge}>
          <span className={styles.ring} />
          <span className={styles.ringInner} />
          <span className={`num ${styles.ratio}`}>1:1</span>
        </div>
        <div className={styles.badgeLabel}>{state === "backed" ? "FULLY BACKED" : "UNVERIFIED"}</div>
      </div>

      {/* the reading */}
      <div className={styles.readCell}>
        <div className={styles.readHead}>
          <span className="liveDot" />
          SOLVENCY PROOF
          <span className={styles.headRule} />
          <span style={{ color: state === "backed" ? "var(--yellow)" : undefined }}>{tag}</span>
        </div>

        {rows.length === 0 && (
          <div className={styles.readRow}>
            <span className={styles.rowK}>NOTHING PROVEN YET</span>
            <span className={styles.rowV}>run the check →</span>
          </div>
        )}

        {rows.map((r) => (
          <div key={r.k} className={styles.readRow}>
            <span className={styles.rowK}>{r.k}</span>
            <span className={styles.rowV} style={{ color: r.gold ? "var(--yellow)" : undefined }}>
              {r.v}
            </span>
          </div>
        ))}

        {provenAt > 0 && (
          <div className={styles.stamp}>
            last proven {new Date(provenAt * 1000).toUTCString().replace("GMT", "UTC")}
          </div>
        )}
      </div>

      {/* the copy and the button */}
      <div className={styles.ctaCell}>
        <div className={styles.copy}>
          Every principal is withdrawable at once, and the contract proves it without decrypting a single balance: the
          encrypted sum is compared to what the pool holds, in&#8209;contract.
        </div>
        {error && <div className={styles.err}>{error}</div>}
        <button className="btnOutlineYellow" onClick={prove} disabled={state === "proving"}>
          {state === "proving" ? "Proving…" : state === "idle" ? "Run solvency check" : "Re-run solvency check"}
        </button>
      </div>
    </section>
  );
}
