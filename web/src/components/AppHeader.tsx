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
  // Reachable rather than a URL you have to know. Most of what it does is open to anyone
  // anyway, so hiding it only made the app look like half a product.
  { href: "/judge", label: "Judge" },
];

export function AppHeader({ pot }: { pot: bigint }) {
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
          <span className="liveDot" />
          <span className={styles.potLive}>LIVE</span>
          <span className={styles.hair} />
        </div>

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
