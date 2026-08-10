"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { AppHeader } from "@/components/AppHeader";
import { PrivacyDemo } from "@/components/PrivacyDemo";
import { useLastDraw, usePoolState } from "@/hooks/usePoolState";
import { POOL_ADDRESS, TOKEN_ADDRESS, UNDERLYING_ADDRESS, poolAbi } from "@/lib/contract";
import styles from "./proof.module.css";

const ENCRYPTED = [
  "Every depositor's balance",
  "Every depositor's odds",
  "The prize, until its winner opens it",
  "The die that decides the draw",
  "Whether any given person won",
];

const PUBLIC = [
  "That an address deposited, and when",
  "The pool total, once per draw",
  "The prize each draw paid out",
  "How many depositors there are",
  "Every line of the contract",
];

const CONTRACTS = [
  { name: "HushpotPool", address: POOL_ADDRESS, purpose: "the pool, the draw, and the claim" },
  { name: "cUSDTMock", address: TOKEN_ADDRESS, purpose: "Zama's confidential USDT — ERC-7984" },
  { name: "USDTMock", address: UNDERLYING_ADDRESS, purpose: "the plain token behind it, with an open faucet" },
];

const LIMITS = [
  {
    now: "Depositing plain tokens makes that deposit's size public.",
    next: "Bring cUSDT instead and the amount never appears in the clear.",
  },
  {
    now: "The pool total is published once per draw.",
    next: "Week-over-week it moves by the sum of everyone's activity, never one person's.",
  },
  {
    now: "Yield is funded from a reserve rather than a live strategy.",
    next: "The same reserve would be fed by real yield in production.",
  },
  {
    now: "One address may hold a large share of a small pool.",
    next: "An encrypted cap on odds is possible without touching principal.",
  },
];

export default function ProofTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const pot = lastDraw ? lastDraw.prize : 0n;

  return (
    <>
      <AppHeader pot={pot} sessionOpen={false} />

      <main className={`${styles.page} rise`}>
        {/* the demonstration comes first, before any prose */}
        <PrivacyDemo />

        <Solvency />

        {/* boundary ------------------------------------------------------- */}
        <section className={`${styles.boundary} yellowBand`}>
          <div className={styles.col}>
            <div className={styles.colHead}>ENCRYPTED — euint64, PER DEPOSITOR</div>
            {ENCRYPTED.map((row) => (
              <div key={row} className={styles.row}>
                {row}
              </div>
            ))}
          </div>
          <div className={styles.col}>
            <div className={styles.colHead}>PUBLIC — ANYONE WITH AN RPC</div>
            {PUBLIC.map((row) => (
              <div key={row} className={styles.row}>
                {row}
              </div>
            ))}
          </div>
          <div className={styles.boundaryNote}>
            We state the boundary instead of hiding it. Addresses and timing are public by Ethereum&apos;s nature.
            What matters — amounts, odds, winnings — is ciphertext.
          </div>
        </section>

        {/* deployed ------------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>DEPLOYED · ETHEREUM SEPOLIA · chainId 11155111</span>
            <span>{CONTRACTS.length} CONTRACTS</span>
          </div>
          {CONTRACTS.map((c) => (
            <div key={c.address} className={styles.contract}>
              <span className={styles.cName}>{c.name}</span>
              <a
                className={styles.cAddress}
                href={`https://sepolia.etherscan.io/address/${c.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {c.address}
              </a>
              <span className={styles.cPurpose}>{c.purpose}</span>
            </div>
          ))}
        </section>

        {/* limits --------------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>LIMITATIONS, HONESTLY</span>
            <span>{LIMITS.length}</span>
          </div>
          {LIMITS.map((l) => (
            <div key={l.now} className={styles.limit}>
              <span className={styles.limitNow}>{l.now}</span>
              <span className={styles.limitNext}>
                <span className={styles.limitTag}>Roadmap · next</span> {l.next}
              </span>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}

/**
 * Solvency, proven rather than promised.
 *
 * The comparison runs on ciphertext inside the contract; the only thing that becomes
 * public is the single bit that falls out of it. Neither the pool's holdings nor what it
 * owes is ever revealed.
 */
function Solvency() {
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

      const { getFhevm } = await import("@/lib/fhe");
      const fhevm = await getFhevm();
      const result = await fhevm.publicDecrypt([handle]);
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
      await waitForTransactionReceipt(config, { hash: tx });

      const handle = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "solvencyHandle",
      })) as string;

      const { getFhevm } = await import("@/lib/fhe");
      const fhevm = await getFhevm();
      const result = await fhevm.publicDecrypt([handle]);
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
        <p className={styles.copy}>
          The fair objection to a pool with encrypted balances is that nobody can check the money is still there. So
          the contract compares what it holds against what it owes — on ciphertext, without revealing either figure —
          and publishes the one bit that comes out.
        </p>

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
          Anyone can run this — a solvency proof only the operator can trigger is not worth much.
        </div>
      </div>
    </section>
  );
}
