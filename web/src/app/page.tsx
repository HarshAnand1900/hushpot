"use client";

import { ConnectButton } from "@/components/ConnectButton";
import { LandingSections } from "@/components/LandingSections";
import { Pot3D } from "@/components/Pot3D";
import { usePoolHref } from "@/hooks/usePoolHref";
import { useLastDraw, useNow, usePoolState, useWeeklyPot } from "@/hooks/usePoolState";
import { POOL_ADDRESS } from "@/lib/contract";
import { formatCountdown, formatUnits, splitUnits } from "@/lib/format";
import styles from "./landing.module.css";

export default function Landing() {
  const now = useNow();
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);

  const withPool = usePoolHref();

  const drawNumber = Number(state.drawCount);
  const mounted = now > 0;
  const closesIn = Number(state.periodStart + state.periodSeconds) - now;

  // "This week's pot" is what pays out at close, projected from the last published pool
  // total. Never a live reading — that would leak every deposit by subtraction.
  // The same estimate the app tabs show — see useWeeklyPot for why it is an estimate.
  const { pot: projectedPot } = useWeeklyPot(state, lastDraw);
  const pot = splitUnits(projectedPot, 2);

  return (
    <main className={styles.page}>
      {/* The exhibit fills the viewport behind everything; the type sits over it. */}
      <Pot3D variant="exhibit" />

      {/* The hero owns one viewport; its furniture is positioned against this, not the
          whole scrolling page. */}
      <div className={styles.hero}>
        <div className={`${styles.frame} brackets bracketsLower`}>
          {/* `?pool=sandbox` swaps the pool, and that is read from the URL on the client.
              React does not patch text it hydrated from the server, so the serial waits
              for mount rather than naming a pool this page is not talking to. */}
          <div className={styles.serial} suppressHydrationWarning>
            SER. {mounted ? `${POOL_ADDRESS.slice(0, 6)}—${POOL_ADDRESS.slice(-4)}` : "————"} · FHEVM SEPOLIA ·
            NON—TRANSFERABLE RECORD
          </div>
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
          <ConnectButton variant="hero" />
        </div>

        {/* left edge -------------------------------------------------------- */}
        <div className={styles.edgeLeft}>EVERY DEPOSIT EARNS FROM THE MINUTE IT LANDS</div>

        {/* right edge stats -------------------------------------------------- */}
        <aside className={styles.stats}>
          <Stat
            label={`POOLED AT DRAW #${Math.max(0, drawNumber - 1)}`}
            value={lastDraw ? formatUnits(lastDraw.total / 10080n) : "—"}
          />
          <Stat label="PRIZE LAST DRAW" value={lastDraw ? `${formatUnits(lastDraw.prize)} cUSDT` : "—"} />
          <Stat label="DRAWS SETTLED" value={String(drawNumber)} />
          <Stat label="DEPOSITORS" value={String(state.depositors)} />
          <Stat label="PRINCIPAL AT RISK" value="NONE" />
        </aside>

        {/* the figure, hung near the top ------------------------------------ */}
        <section className={styles.potBlock}>
          <span className={`${styles.scrim} ${styles.scrimTop}`} />
          <div className={styles.potRow}>
            <span className={styles.potTick}>POT</span>
            {/* No settled draw and nothing sponsored means there is no pot to estimate,
                which is not the same as an empty one. See useWeeklyPot. */}
            <span className={`num ${styles.potNumber}`}>
              {projectedPot > 0n ? (
                <>
                  {pot.whole}
                  <span className={styles.potFrac}>.{pot.frac}</span>
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className={styles.potStrap}>
            <span className="liveDot" />
            LIVE · THIS WEEK&apos;S POT · THE ONLY PUBLIC NUMBER
          </div>
        </section>

        {/* the pitch, sat at the foot ---------------------------------------- */}
        <section className={styles.bottomBlock}>
          <span className={`${styles.scrim} ${styles.scrimBottom}`} />
          <h1 className={`editorial ${styles.headline}`}>
            One depositor takes all of it. Nobody finds out who, <em>unless they say so.</em>
          </h1>

          <div className={styles.ctas}>
            {/* A full page load, so the sandbox parameter has to travel with it or the
                click silently lands on the real pool. */}
            <a className={styles.ctaPrimary} href={withPool("/pool")}>
              Enter the pool
            </a>
          </div>
        </section>

        {/* ticker ------------------------------------------------------------ */}
        <div className={styles.ticker}>
          <div className={styles.tickerTrack}>
            {[0, 1].map((copy) => (
              <div className={styles.tickerRun} key={copy}>
                <TickerItem text="ENCRYPTED ON-CHAIN" />
                <TickerItem text="0x7a4f…19cD DEPOSITED ●●●●●● cUSDT" />
                <TickerItem
                  text={`POT +${lastDraw ? formatUnits(lastDraw.prize / 168n) : "0.00"} cUSDT FROM YIELD`}
                  accent
                />
                <TickerItem text={`DRAW #${Math.max(0, drawNumber - 1)} SETTLED · NO WINNER RESOLVED`} accent />
                <TickerItem text={`${state.depositors} DEPOSITORS · AMOUNTS UNREADABLE`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <LandingSections />
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
