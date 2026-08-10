"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

import { Pot3D } from "@/components/Pot3D";
import { useLastDraw, useNow, usePoolState } from "@/hooks/usePoolState";
import { POOL_ADDRESS } from "@/lib/contract";
import { formatCountdown, formatUnits, shortenAddress, splitUnits } from "@/lib/format";
import styles from "./landing.module.css";

export default function Landing() {
  const now = useNow();
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);

  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const drawNumber = Number(state.drawCount);
  const mounted = now > 0;
  const closesIn = Number(state.periodStart + state.periodSeconds) - now;
  const weekPct = Math.min(100, Math.max(0, (Number(state.minuteOfPeriod) / 10080) * 100));

  // "This week's pot" is what pays out at close, projected from the last published pool
  // total. Never a live reading — that would leak every deposit by subtraction.
  const projectedPot = lastDraw ? lastDraw.prize : 0n;
  const pot = splitUnits(projectedPot, 2);

  return (
    <main className={styles.page}>
      <div className={`${styles.frame} brackets bracketsLower`}>
        <div className={styles.serial}>SER. {POOL_ADDRESS.slice(0, 6)}—{POOL_ADDRESS.slice(-4)} · FHEVM SEPOLIA · NON—TRANSFERABLE RECORD</div>
      </div>

      {/* top-left --------------------------------------------------------- */}
      <header className={styles.topLeft}>
        <div className={styles.lockup}>
          <span className={styles.ring}>
            <span className={styles.ringDot} />
          </span>
          <span className={styles.wordmark}>HUSHPOT</span>
        </div>
        <div className={styles.subLockup}>
          CONFIDENTIAL PRIZE POOL
          <br />
          SEPOLIA · FHEVM
        </div>
      </header>

      {/* top-right -------------------------------------------------------- */}
      <div className={styles.topRight}>
        <div className={styles.closesLabel}>DRAW #{drawNumber} CLOSES IN</div>
        <div className={styles.countdown} suppressHydrationWarning>
          {mounted ? formatCountdown(closesIn) : "—"}
        </div>
        {isConnected ? (
          <button className={styles.connect} onClick={() => disconnect()}>
            {shortenAddress(address)}
          </button>
        ) : (
          <button
            className={styles.connect}
            disabled={isPending || connectors.length === 0}
            onClick={() => connect({ connector: connectors[0] })}
          >
            {isPending ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>

      {/* left edge -------------------------------------------------------- */}
      <div className={styles.edgeLeft}>EVERY DEPOSIT EARNS FROM THE MINUTE IT LANDS</div>

      {/* right edge stats -------------------------------------------------- */}
      <aside className={styles.stats}>
        <Stat label={`POOLED AT DRAW #${Math.max(0, drawNumber - 1)}`} value={lastDraw ? formatUnits(lastDraw.total / 10080n) : "—"} />
        <Stat label="PRIZE LAST DRAW" value={lastDraw ? `${formatUnits(lastDraw.prize)} cUSDT` : "—"} />
        <Stat label="DRAWS SETTLED" value={String(drawNumber)} />
        <Stat label="DEPOSITORS" value={String(state.depositors)} />
        <Stat label="PRINCIPAL AT RISK" value="NONE" />
      </aside>

      {/* centre ----------------------------------------------------------- */}
      <section className={styles.centre}>
        <div className={styles.potRow}>
          <span className={styles.potTick}>POT</span>
          <span className={`num ${styles.potNumber}`}>
            {pot.whole}
            <span className={styles.potFrac}>.{pot.frac}</span>
          </span>
        </div>
        <div className={styles.potStrap}>
          <span className="liveDot" />
          LIVE · THIS WEEK&apos;S POT · THE ONLY PUBLIC NUMBER
        </div>

        <div className={styles.potNiche} data-pot-window>
          <Pot3D size={210} />
        </div>

        <h1 className={`editorial ${styles.headline}`}>
          One depositor takes all of it. Nobody finds out who — <em>unless they say so.</em>
        </h1>

        <div className={styles.ctas}>
          <button className={styles.ctaPrimary}>Enter the pool</button>
          <button className={styles.ctaGhost}>Drop a deposit</button>
        </div>

        <div className={styles.hint}>IT TURNS ON ITS OWN · HOVER TO TAKE THE WHEEL</div>
      </section>

      {/* ticker ------------------------------------------------------------ */}
      <div className={styles.ticker}>
        <div className={styles.tickerTrack}>
          {[0, 1].map((copy) => (
            <div className={styles.tickerRun} key={copy}>
              <TickerItem text="ENCRYPTED ON-CHAIN" />
              <TickerItem text="0x7a4f…19cD DEPOSITED ●●●●●● cUSDT" />
              <TickerItem text={`POT +${lastDraw ? formatUnits(lastDraw.prize / 168n) : "0.00"} cUSDT FROM YIELD`} accent />
              <TickerItem text={`DRAW #${Math.max(0, drawNumber - 1)} SETTLED · NO WINNER RESOLVED`} accent />
              <TickerItem text={`${state.depositors} DEPOSITORS · AMOUNTS UNREADABLE`} />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
}

function TickerItem({ text, accent }: { text: string; accent?: boolean }) {
  return (
    <span className={accent ? `${styles.tickerItem} ${styles.tickerAccent}` : styles.tickerItem}>
      <span className={styles.tickerDot} />
      {text}
    </span>
  );
}
