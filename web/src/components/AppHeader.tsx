"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { formatUnits } from "@/lib/format";
import { ConnectButton } from "./ConnectButton";
import styles from "./AppHeader.module.css";

const TABS = [
  { href: "/pool", label: "Pool" },
  { href: "/draws", label: "Draws" },
  { href: "/proof", label: "Proof" },
];

export function AppHeader({ pot, sessionOpen }: { pot: bigint; sessionOpen: boolean }) {
  const pathname = usePathname();

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
          <span className={styles.potLive}>LIVE</span>
          <span className={styles.hair} />
        </div>

        <span className={`${styles.session} ${sessionOpen ? styles.sessionOpen : ""}`}>
          <span className={styles.sessionDot} />
          {sessionOpen ? "Session open" : "Locked"}
        </span>

        <ConnectButton />
      </div>
    </header>
  );
}
