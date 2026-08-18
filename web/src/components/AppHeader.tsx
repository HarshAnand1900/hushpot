"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { clearSession, currentSession } from "@/lib/fhe";
import { formatUnits } from "@/lib/format";
import { ConnectButton } from "./ConnectButton";
import styles from "./AppHeader.module.css";

const TABS = [
  { href: "/pool", label: "Pool" },
  { href: "/draws", label: "Draws" },
  { href: "/proof", label: "Proof" },
  // Reachable rather than a URL you have to know. Most of what it does is open to anyone
  // anyway, so hiding it only made the app look like half a product.
  { href: "/judge", label: "Judge" },
];

export function AppHeader({ pot }: { pot: bigint }) {
  const pathname = usePathname();
  const session = useSessionState();

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          <span className={styles.mark}>
            <span className={styles.markDot} />
          </span>
          <span className={styles.word}>Hushpot</span>
        </Link>

        <nav className={styles.tabs}>
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className={pathname === tab.href ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            >
              {tab.label}
            </Link>
          ))}
        </nav>

        <div className={styles.spacer} />

        {/* Live pot readout — no box, no chip, hairlines either side. */}
        <div className={styles.potRead}>
          <span className={styles.hair} />
          <span className={styles.potLabel}>POT</span>
          <span className={`num ${styles.potValue}`}>{formatUnits(pot)}</span>
          <span className="liveDot" />
          <span className={styles.potLive}>LIVE</span>
          <span className={styles.hair} />
        </div>

        {/* Reads the real session rather than decorating the header with a lock.
            While locked it says so and cannot be clicked into an error — the only way to
            unlock is the reveal button on Pool, which is where it means something. Once
            open it becomes the way to close it again, for a shared screen. */}
        {session ? (
          <button
            className={`${styles.lock} ${styles.lockOpen}`}
            onClick={clearSession}
            title="End the decrypt session"
          >
            <span className="liveDot" /> OPEN · LOCK
          </button>
        ) : (
          <span className={styles.lock} title="No decrypt session — everything on screen is ciphertext">
            LOCKED
          </span>
        )}

        {/* A judge lands with an empty wallet, so the faucet has to be reachable from
            anywhere — not only from inside a sheet they have to find first. */}
        <Link className={styles.faucet} href="/pool?faucet=1">
          Faucet
        </Link>

        <ConnectButton />
      </div>
    </header>
  );
}

/**
 * Whether a decrypt session is open, polled rather than pushed.
 *
 * The session lives in a module-level variable in lib/fhe, opened from the Pool tab and
 * cleared from here — no shared store connects the two. A 1.5s poll of an in-memory
 * boolean is cheaper than the wiring that would avoid it, and the chip is never more
 * than a moment stale.
 */
function useSessionState() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const read = () => setOpen(currentSession() !== null);
    read();
    const id = setInterval(read, 1500);
    return () => clearInterval(id);
  }, []);

  return open;
}
