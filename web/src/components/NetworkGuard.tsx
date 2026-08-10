"use client";

import { useAccount, useSwitchChain } from "wagmi";

import { CHAIN_ID } from "@/lib/contract";
import styles from "./NetworkGuard.module.css";

/**
 * Wrong-network banner.
 *
 * Without this, connecting on the wrong chain looks like the app is broken: reads return
 * nothing, balances render as dashes, and there is no explanation anywhere. Sepolia is the
 * only chain Hushpot is deployed on, so say so and offer the switch.
 */
export function NetworkGuard() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending, error } = useSwitchChain();

  if (!isConnected || chainId === CHAIN_ID) return null;

  return (
    <div className={styles.bar} role="alert">
      <span className={styles.dot} />
      <span className={styles.text}>
        <strong>Wrong network.</strong> Hushpot lives on Sepolia. Nothing below will load until you switch
        {chainId ? ` — you are on chain ${chainId}` : ""}.
      </span>
      <button className={styles.action} onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={isPending}>
        {isPending ? "Switching…" : "Switch to Sepolia"}
      </button>
      {error && <span className={styles.err}>Your wallet declined the switch — change it there instead.</span>}
    </div>
  );
}
