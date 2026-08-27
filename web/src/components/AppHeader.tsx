"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

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

export function AppHeader({ pot, sponsored = 0n }: { pot: bigint; sponsored?: bigint }) {
  const pathname = usePathname();
  const router = useRouter();

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
          <span className={styles.potLive}>THIS WEEK</span>

          {/* A sponsorship lands in the *next* draw, so the figure beside it does not move
              and the gift looks like it went nowhere. This is the only place it can be
              seen before the draw settles, and it is public either way. */}
          {sponsored > 0n && (
            <>
              <span className={styles.hair} />
              <span className={styles.potLabel}>BANKED</span>
              <span className={`num ${styles.potValue} ${styles.banked}`}>+{formatUnits(sponsored)}</span>
            </>
          )}

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
            else router.push("/pool?faucet=1");
          }}
        >
          Faucet
        </button>

        <ConnectButton />
      </div>
    </header>
  );
}
