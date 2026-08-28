"use client";

import { useEffect, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { Pot3D } from "@/components/Pot3D";
import { PrivacyDemo } from "@/components/PrivacyDemo";
import { ChainSees } from "@/components/ChainSees";
import { HardParts } from "@/components/HardParts";
import { Solvency } from "@/components/Solvency";
import { VerifyHandle } from "@/components/VerifyHandle";
import { SponsorPot } from "@/components/SponsorPot";
import { useLastDraw, usePoolState, useWeeklyPot } from "@/hooks/usePoolState";
import { POOL_ADDRESS, TOKEN_ADDRESS, UNDERLYING_ADDRESS } from "@/lib/contract";
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
  // The pool address is read from the URL on the client — `?pool=sandbox` swaps it — so it
  // is a function of mount, not a constant. The other two never move.
  { name: "HushpotPool", address: () => POOL_ADDRESS, purpose: "the pool, the draw, and the claim" },
  { name: "cUSDTMock", address: () => TOKEN_ADDRESS, purpose: "Zama's confidential USDT, an ERC-7984" },
  { name: "USDTMock", address: () => UNDERLYING_ADDRESS, purpose: "the plain token behind it, with an open faucet" },
];

const LIMITS = [
  {
    now: "Shielding plain tUSDT into cUSDT publishes that amount, because a plain ERC-20 transfer cannot hide it.",
    next: "It happens at the faucet, before any deposit, so what reaches the pool is already encrypted and unlinked to a position.",
  },
  {
    now: "The pool total is published once per draw.",
    next: "Week-over-week it moves by the sum of everyone's activity, never one person's.",
  },
  {
    now: "Yield is funded from a reserve, not a live strategy.",
    next: "The same reserve would be fed by real yield in production.",
  },
  {
    now: "One address may hold a large share of a small pool.",
    next: "Capping odds was built and removed: it takes from depositors without giving anyone else more, and the prize scales with the pool anyway.",
  },
];

/** A numbered rule between acts, so ten panels read as five moves. */
function Act({ n, label }: { n: string; label: string }) {
  return (
    <div className={styles.act}>
      <span className={styles.actNum}>{n}</span>
      <span className={styles.actLabel}>{label}</span>
      <span className={styles.actLine} />
    </div>
  );
}

export default function ProofTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  // The same estimate the other tabs show, so the header is consistent everywhere.
  const { pot } = useWeeklyPot(state, lastDraw);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      <Pot3D variant="exhibit" dim />
      <AppHeader pot={pot} />

      <main className={`${styles.page} rise`}>
        {/* ── 01 · the claim, tested live ───────────────────────────────── */}
        <Act n="01" label="TRY TO BREAK IT" />

        <PrivacyDemo />
        <ChainSees />

        {/* boundary ------------------------------------------------------- */}
        <section className={`${styles.boundary} yellowBand`}>
          <div className={styles.col}>
            <div className={styles.colHead}>ENCRYPTED · euint64, PER DEPOSITOR</div>
            {ENCRYPTED.map((row) => (
              <div key={row} className={styles.row}>
                {row}
              </div>
            ))}
          </div>
          <div className={styles.col}>
            <div className={styles.colHead}>PUBLIC · READABLE WITH ANY RPC</div>
            {PUBLIC.map((row) => (
              <div key={row} className={styles.row}>
                {row}
              </div>
            ))}
          </div>
          <div className={styles.boundaryNote}>
            We state the boundary instead of hiding it. Addresses and timing are public by Ethereum&apos;s nature. What
            matters (amounts, odds, winnings) is ciphertext.
          </div>
        </section>

        {/* ── 02 · the money ────────────────────────────────────────────── */}
        <Act n="02" label="IS THE MONEY STILL THERE" />

        <Solvency />

        {/* ── 03 · the engineering ──────────────────────────────────────── */}
        <Act n="03" label="WHAT FHE MADE HARD" />

        <HardParts />

        {/* ── 04 · check it without us ──────────────────────────────────── */}
        <Act n="04" label="CHECK IT WITHOUT TRUSTING US" />

        <VerifyHandle />

        {/* deployed ------------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>DEPLOYED · ETHEREUM SEPOLIA · chainId 11155111</span>
            <span>{CONTRACTS.length} CONTRACTS</span>
          </div>
          {CONTRACTS.map((c) => (
            <div key={c.name} className={styles.contract}>
              <span className={styles.cName}>{c.name}</span>
              <a
                className={styles.cAddress}
                href={`https://sepolia.etherscan.io/address/${c.address()}`}
                target="_blank"
                rel="noreferrer"
                suppressHydrationWarning
              >
                {mounted ? c.address() : "…"}
              </a>
              <span className={styles.cPurpose}>{c.purpose}</span>
            </div>
          ))}
        </section>

        {/* ── 05 · what we do not claim ─────────────────────────────────── */}
        <Act n="05" label="WHAT WE DO NOT CLAIM" />

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

        {/* ── 06 · take part ───────────────────────────────────────────── */}
        <Act n="06" label="GROW THE POT WITHOUT TAKING ODDS" />

        <SponsorPot reserve={state.prizeReserve} onDone={() => state.refetch()} />
      </main>
    </>
  );
}
