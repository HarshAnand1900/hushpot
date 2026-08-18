"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import styles from "./Solvency.module.css";

/**
 * Solvency, proven rather than promised.
 *
 * The comparison runs on ciphertext inside the contract; the only thing that becomes
 * public is the single bit that falls out of it. Neither the pool's holdings nor what it
 * owes is ever revealed.
 */
export function Solvency({ compact }: { compact?: boolean }) {
  const publicClient = usePublicClient();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<"idle" | "proving" | "backed" | "short" | "error">("idle");
  const [error, setError] = useState<string>();
  const [provenAt, setProvenAt] = useState<number>(0);

  /**
   * Read whatever proof already exists. No wallet, no transaction — the result was made
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
    } catch {
      /* leave it unproven rather than claiming anything */
    }
  }, [publicClient]);

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
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 150) : "Could not prove solvency.");
      setState("error");
    }
  }, [config, publicClient, writeContractAsync]);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>IS THE MONEY STILL THERE?</span>
        <span style={{ color: state === "backed" ? "var(--yellow)" : undefined }}>
          {state === "backed" ? "FULLY BACKED" : state === "short" ? "SHORTFALL" : "UNPROVEN"}
        </span>
      </div>

      <div className={styles.solvency}>
        {!compact && (
          <p className={styles.copy}>
            The fair objection to a pool with encrypted balances is that nobody can check the money is still there. So
            the contract compares what it holds against what it owes — on ciphertext, without revealing either figure —
            and publishes the one bit that comes out.
          </p>
        )}

        {state === "backed" && (
          <div className={styles.backed}>
            Every deposit is fully backed. Neither the pool&apos;s holdings nor its liabilities were revealed to
            establish that
            {provenAt > 0 && <> — last proven {new Date(provenAt * 1000).toUTCString().replace("GMT", "UTC")}</>}.
          </div>
        )}
        {state === "short" && <div className={styles.short}>The pool reports a shortfall. That would be serious.</div>}
        {error && <div className={styles.short}>{error}</div>}

        <button className="btnOutlineYellow" onClick={prove} disabled={state === "proving"}>
          {state === "proving" ? "Proving…" : state === "idle" ? "Prove solvency now" : "Prove it again"}
        </button>

        <div className={styles.solvencyNote}>
          {compact
            ? "Every deposit is backed 1:1. Anyone can re-run the proof — it is on the Proof tab too."
            : "Anyone can run this — a solvency proof only the operator can trigger is not worth much."}
        </div>
      </div>
    </section>
  );
}
