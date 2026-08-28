"use client";

import { useEffect, useState } from "react";

import { IS_SANDBOX, POOL_ADDRESS } from "@/lib/contract";
import { shortenAddress } from "@/lib/format";
import styles from "./SandboxBanner.module.css";

/**
 * Says, unmissably, that this is not the real pool.
 *
 * The sandbox exists so a judge can run the owner-gated steps immediately instead of
 * waiting a week for a period to elapse. That makes it useful and also makes it dangerous:
 * every figure on screen belongs to a throwaway contract that anyone can run a draw on,
 * and somebody arriving on a shared link should not have to check an address to know it.
 *
 * Rendered after mount rather than during SSR, because which pool this tab points at is
 * decided by the URL and the server has no view of it.
 */
export function SandboxBanner() {
  const [shown, setShown] = useState(false);

  useEffect(() => setShown(IS_SANDBOX), []);

  if (!shown) return null;

  return (
    <div className={styles.banner} role="status">
      <span className={styles.tag}>SANDBOX</span>
      <span className={styles.copy}>
        Pointed at <strong>{shortenAddress(POOL_ADDRESS)}</strong> — a throwaway pool whose owner is a contract that
        lets anyone run every step of the cycle, right now. Same test tokens as the live pool,{" "}
        <strong>separate balances</strong>: nothing you do here touches the real deployment, and nothing on screen is
        its figures.
      </span>
      <a className={styles.link} href="/pool">
        Back to the live pool →
      </a>
    </div>
  );
}
