"use client";

import { useEffect, useState } from "react";

import { TOAST_EVENT, type ToastPayload } from "@/lib/toast";
import styles from "./Toast.module.css";

interface Entry extends ToastPayload {
  id: number;
}

/**
 * The bottom-of-screen record of what just happened.
 *
 * Wallet flows are long enough that people look away — approve, wait, sign, wait — and
 * come back to a screen that has quietly returned to its resting state. Whether the
 * deposit landed was knowable only by reading the balance and inferring. This says it.
 *
 * Failures stay until dismissed. A deposit that silently did nothing is precisely the
 * thing worth not missing, so it does not get to time out while you are in another tab.
 */
export function Toast() {
  const [items, setItems] = useState<Entry[]>([]);

  useEffect(() => {
    let seq = 0;

    const onToast = (e: Event) => {
      const payload = (e as CustomEvent<ToastPayload>).detail;
      const id = ++seq;

      setItems((prev) => [...prev.slice(-2), { ...payload, id }]);

      const ttl = payload.ttl ?? (payload.kind === "error" ? 0 : payload.kind === "pending" ? 0 : 6000);
      if (ttl > 0) setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), ttl);
    };

    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className={styles.stack} role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`}>
          <span className={styles.mark} aria-hidden="true">
            {t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : "···"}
          </span>

          <div className={styles.body}>
            <div className={styles.title}>{t.title}</div>
            {t.detail && <div className={styles.detail}>{t.detail}</div>}
            {t.hash && (
              <a
                className={styles.link}
                href={`https://sepolia.etherscan.io/tx/${t.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {t.hash.slice(0, 10)}…{t.hash.slice(-6)} ↗
              </a>
            )}
          </div>

          <button
            className={styles.close}
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
