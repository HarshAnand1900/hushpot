"use client";

import { AppHeader } from "@/components/AppHeader";
import { Pot3D } from "@/components/Pot3D";
import { PrivacyDemo } from "@/components/PrivacyDemo";
import { HardParts } from "@/components/HardParts";
import { Solvency } from "@/components/Solvency";
import { ContractLog } from "@/components/ContractLog";
import { VerifyHandle } from "@/components/VerifyHandle";
import { SponsorPot } from "@/components/SponsorPot";
import { useLastDraw, usePoolState } from "@/hooks/usePoolState";
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
  { name: "HushpotPool", address: POOL_ADDRESS, purpose: "the pool, the draw, and the claim" },
  { name: "cUSDTMock", address: TOKEN_ADDRESS, purpose: "Zama's confidential USDT — ERC-7984" },
  { name: "USDTMock", address: UNDERLYING_ADDRESS, purpose: "the plain token behind it, with an open faucet" },
];

const LIMITS = [
  {
    now: "The plain-token route publishes the deposit's size. It is offered as a quick demo.",
    next: "The cUSDT route is the default and leaves nothing in the clear — the faucet shields for you.",
  },
  {
    now: "The pool total is published once per draw.",
    next: "Week-over-week it moves by the sum of everyone's activity, never one person's.",
  },
  {
    now: "Yield is funded from a reserve rather than a live strategy.",
    next: "The same reserve would be fed by real yield in production.",
  },
  {
    now: "One address may hold a large share of a small pool.",
    next: "Capping odds was built and removed: it takes from depositors without giving anyone else more, and the prize scales with the pool anyway.",
  },
];

export default function ProofTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const pot = lastDraw ? lastDraw.prize : 0n;

  return (
    <>
      <Pot3D variant="exhibit" dim />
      <AppHeader pot={pot} />

      <main className={`${styles.page} rise`}>
        {/* the demonstration comes first, before any prose */}
        <PrivacyDemo />

        <Solvency />

        <HardParts />

        <SponsorPot reserve={state.prizeReserve} onDone={() => state.refetch()} />

        {/* boundary ------------------------------------------------------- */}
        <section className={`${styles.boundary} yellowBand`}>
          <div className={styles.col}>
            <div className={styles.colHead}>ENCRYPTED — euint64, PER DEPOSITOR</div>
            {ENCRYPTED.map((row) => (
              <div key={row} className={styles.row}>
                {row}
              </div>
            ))}
          </div>
          <div className={styles.col}>
            <div className={styles.colHead}>PUBLIC — ANYONE WITH AN RPC</div>
            {PUBLIC.map((row) => (
              <div key={row} className={styles.row}>
                {row}
              </div>
            ))}
          </div>
          <div className={styles.boundaryNote}>
            We state the boundary instead of hiding it. Addresses and timing are public by Ethereum&apos;s nature. What
            matters — amounts, odds, winnings — is ciphertext.
          </div>
        </section>

        {/* deployed ------------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>DEPLOYED · ETHEREUM SEPOLIA · chainId 11155111</span>
            <span>{CONTRACTS.length} CONTRACTS</span>
          </div>
          {CONTRACTS.map((c) => (
            <div key={c.address} className={styles.contract}>
              <span className={styles.cName}>{c.name}</span>
              <a
                className={styles.cAddress}
                href={`https://sepolia.etherscan.io/address/${c.address}`}
                target="_blank"
                rel="noreferrer"
              >
                {c.address}
              </a>
              <span className={styles.cPurpose}>{c.purpose}</span>
            </div>
          ))}
        </section>

        <VerifyHandle />

        <ContractLog limit={10} />

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
      </main>
    </>
  );
}
