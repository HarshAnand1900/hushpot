"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { usePoolHref } from "@/hooks/usePoolHref";
import { formatUnits } from "@/lib/format";
import { ConnectButton } from "./ConnectButton";
import styles from "./AppHeader.module.css";

/** Fired by the header Faucet button when the Pool tab is already open. */
export const FAUCET_EVENT = "hushpot:faucet";

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
  const router = useRouter();

  const withPool = usePoolHref();

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href={withPool("/")} className={styles.logo}>
          <span className={styles.mark}>
            <span className={styles.markDot} />
          </span>
          <span className={styles.word}>Hushpot</span>
        </Link>

        <nav className={styles.tabs}>
          {TABS.map((tab) => (
            <Link
              key={tab.href}
              href={withPool(tab.href)}
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
          {/* Zero means no draw has settled and nothing is sponsored, so there is no pot
              to estimate — not a pot that happens to be empty. See useWeeklyPot. */}
          <span className={`num ${styles.potValue}`}>{pot > 0n ? formatUnits(pot) : "—"}</span>
          <span className="liveDot" />
          <span className={styles.potLive}>THIS WEEK</span>

          <span className={styles.hair} />
        </div>

        {/* A judge lands with an empty wallet, so the faucet has to be reachable from
            anywhere — not only from inside a sheet they have to find first. */}
        {/* This was a link to /pool?faucet=1, which silently did nothing when you were
            already on /pool: the App Router re-renders without remounting, so the effect
            reading that query never fired again. An event works from any page and does
            not depend on routing at all. */}
        <button
          className={styles.faucet}
          onClick={() => {
            if (pathname === "/pool") window.dispatchEvent(new Event(FAUCET_EVENT));
            else router.push(withPool("/pool?faucet=1"));
          }}
        >
          Faucet
        </button>

        <ConnectButton />
      </div>
    </header>
  );
}
