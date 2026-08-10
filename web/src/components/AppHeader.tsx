"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect } from "wagmi";

import { formatUnits, shortenAddress } from "@/lib/format";
import styles from "./AppHeader.module.css";

const TABS = [
  { href: "/pool", label: "Pool" },
  { href: "/draws", label: "Draws" },
  { href: "/proof", label: "Proof" },
];

export function AppHeader({ pot, sessionOpen }: { pot: bigint; sessionOpen: boolean }) {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

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

        {isConnected ? (
          <button className={styles.wallet} onClick={() => disconnect()} title="Disconnect">
            {shortenAddress(address)}
          </button>
        ) : (
          <button
            className={styles.ghost}
            disabled={isPending || connectors.length === 0}
            onClick={() => connect({ connector: connectors[0] })}
          >
            {connectors.length === 0 ? "No wallet found" : isPending ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>
    </header>
  );
}
