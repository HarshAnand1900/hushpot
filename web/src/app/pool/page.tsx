"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import Link from "next/link";

import { AppHeader, FAUCET_EVENT } from "@/components/AppHeader";
import { DepositSheet } from "@/components/DepositSheet";
import { DidIWin } from "@/components/DidIWin";
import { ContractLog } from "@/components/ContractLog";
import { PositionHistory } from "@/components/PositionHistory";
import { PositionPanel } from "@/components/PositionPanel";
import { Pot3D } from "@/components/Pot3D";
import { useMyPosition } from "@/hooks/useMyPosition";
import { useDraws } from "@/hooks/useDraws";
import { usePoolHref } from "@/hooks/usePoolHref";
import { poolPhase, type Phase } from "@/hooks/usePoolPhase";
import { useLastDraw, useNow, usePoolState, useWeeklyPot } from "@/hooks/usePoolState";
import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { formatCountdown, formatUnits, shortenAddress, splitUnits } from "@/lib/format";
import { describeError, toast } from "@/lib/toast";
import styles from "./pool.module.css";

export default function PoolTab() {
  const now = useNow();
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { draws } = useDraws(state.drawCount);
  // Built once per change of `draws` rather than once per render. This page polls, and
  // handing a freshly-built array down on every tick re-fired the panel's reads and made
  // it flicker between the answer and its loading state.
  const checkable = useMemo(() => draws.map((d) => ({ id: d.id, prize: d.prize, period: Number(d.period) })), [draws]);
  const { isConnected } = useAccount();
  const { stage, position, error, reveal, lock, isUnlocked } = useMyPosition();
  // "join" is deposit with the withdraw tab hidden: it is the way in for someone who
  // has nothing in yet, and withdrawing would need a decrypted balance to mean anything.
  const [sheet, setSheet] = useState<"deposit" | "withdraw" | "join" | null>(null);

  // The header's Faucet button lands here. Read from location rather than useSearchParams,
  // which would opt this page out of static prerendering for one query flag.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("faucet") === "1") {
      setSheet("join");
      window.history.replaceState(null, "", "/pool");
    }

    // Clicking Faucet while already on this page is a same-page navigation: React
    // re-renders without remounting, so the query check above never runs a second time
    // and the button looked completely dead. The event does not depend on routing.
    const open = () => setSheet("join");
    window.addEventListener(FAUCET_EVENT, open);
    return () => window.removeEventListener(FAUCET_EVENT, open);
  }, []);

  const drawNumber = Number(state.drawCount);
  const mounted = now > 0;
  const closesIn = Number(state.periodStart + state.periodSeconds) - now;
  const weekPct = Math.min(100, (Number(state.minuteOfPeriod) / 10080) * 100);

  // "This week's pot" is what gets paid at close, projected from the last published pool
  // total — never a live reading, which would leak deposits by subtraction. The share
  // accrued so far is shown separately rather than standing in for the whole thing.
  // What the last draw actually paid — not a forecast of the next one.
  //
  // Shared with every other tab, so the header never disagrees with itself.
  const { pot, yieldEstimate, lastPaid } = useWeeklyPot(state, lastDraw);
  const phase = poolPhase(state, lastDraw);

  // How much of that pot the week has earned so far. Sponsorship is already banked in
  // full, so only the yield half accrues.
  const accrued = (yieldEstimate * BigInt(Math.floor(weekPct * 100))) / 10_000n + state.sponsoredThisDraw;
  const potParts = splitUnits(pot);

  // Odds are computed inside PositionPanel, against a FROZEN denominator — the total
  // published at the last draw, never a live one. With a live denominator anyone could
  // divide their own odds into it and recover the running pool total, and from that
  // every individual deposit.
  const busy = stage === "signing" || stage === "computing" || stage === "decrypting";

  return (
    <>
      {/* No full-viewport 3D exhibit here, deliberately.
      
          Pool is the page where every transaction happens, and a second three.js renderer
          covering the viewport was competing with FHE encryption for the main thread —
          the deposit freeze. The global CSS backdrop in layout.tsx already provides the
          glow; the pot that matters is the interactive one in the hero, which is small and
          cheap. Draws and Proof keep the exhibit: nothing blocking happens there. */}
      <div className="warmGlow" aria-hidden="true" />
      <AppHeader pot={pot} />

      <main className={`${styles.page} rise`}>
        {/* status strip -------------------------------------------------- */}
        <div className={styles.status}>
          <span className={styles.chip}>
            <span className="liveDot" /> SEPOLIA
          </span>
          <span className={styles.chip}>PERIOD #{state.currentPeriod}</span>
          <span className={styles.chip}>MINUTE {String(state.minuteOfPeriod)} / 10080</span>
          <span className={styles.chip}>FHEVM · EUINT64</span>
          <span className={styles.statusRule} />
          {/* Which pool this tab points at is a client-side reading of the URL, and React
              does not patch text it hydrated from the server. Held back until mounted, so
              the chip never names one pool while the rest of the page reads another. */}
          <span className={styles.chip} suppressHydrationWarning>
            HUSHPOT {mounted ? shortenAddress(POOL_ADDRESS) : "…"}
          </span>
        </div>

        {/* hero band ------------------------------------------------------ */}
        <section className={`${styles.hero} brackets bracketsLower`}>
          <div className={`${styles.potCell} yellowBand`}>
            {/* Two numbers live here and they are not the same draw: the label is the one
                coming next, the figure is what the last one actually paid. Saying only
                "PUBLIC BY DESIGN" left that unexplained and read as a contradiction
                against PERIOD #0 in the status strip. */}
            {/* Naming the next draw is only honest while it can actually be opened. In the
                settling phase the last draw has landed but the period has not rolled, and
                the contract allows one draw per period — so "THIS WEEK'S POT · DRAW #1"
                described a draw that could not start, beside a countdown reading zero. */}
            <div className={styles.potKicker}>
              {drawNumber === 0
                ? "THE POT · DRAW #0 · PUBLIC BY DESIGN"
                : phase.id === "settling"
                  ? `DRAW #${drawNumber} OPENS ONCE THE PERIOD ROLLS · ESTIMATED FROM PUBLIC FIGURES`
                  : `THIS WEEK'S POT · DRAW #${drawNumber} · ESTIMATED FROM PUBLIC FIGURES`}
            </div>
            {/* An em dash, not 0.00: with no settled draw and nothing sponsored there is
                no published total to estimate from, so there is no pot yet rather than an
                empty one. See useWeeklyPot. */}
            <div className={`num ${styles.potNumber}`}>
              {pot > 0n ? (
                <>
                  {potParts.whole}
                  <span className={styles.potFrac}>.{potParts.frac}</span>
                </>
              ) : (
                "—"
              )}
            </div>
            <div className={styles.potUnit}>
              {drawNumber > 0
                ? `cUSDT · YIELD + ${formatUnits(state.sponsoredThisDraw)} SPONSORED · DRAW #${drawNumber - 1} PAID ${formatUnits(lastPaid)}`
                : pot > 0n
                  ? `cUSDT · ${formatUnits(state.sponsoredThisDraw)} SPONSORED · NO YIELD BASIS UNTIL DRAW #0 SETTLES`
                  : "cUSDT · NO DRAW HAS SETTLED YET, SO THERE IS NOTHING TO ESTIMATE FROM"}
            </div>

            <div className={styles.tagline}>
              <div className="editorial">
                Nobody loses.
                <br />
                Somebody wins.
              </div>
              <div className={styles.taglineNote}>
                YOU PLAY THE INTEREST, NEVER THE MONEY.
                <br />
                EVERY DEPOSIT WITHDRAWS IN FULL.
              </div>
            </div>

            {/* Between draws the pool looks stalled from outside: the countdown is spent,
                the pot does not move, and nothing admits a draw is halfway settled. */}
            <div className={styles.phase} data-phase={phase.id}>
              <span className={styles.phaseTag}>
                <span className={styles.phaseDot} aria-hidden="true" />
                {phase.tag}
              </span>
              {/* The detail runs to four or five lines and changes with the phase, so the
                  hero grew and shrank as the pool moved through its week. Collapsed to the
                  headline, which is the part that answers "what is happening"; the
                  reasoning is a click away for anyone who wants it. */}
              <div className={styles.phaseBody}>
                <div className={styles.phaseHeadline}>{phase.headline}</div>
                <details className={styles.phaseMore}>
                  <summary>Why</summary>
                  <div className={styles.phaseDetail}>{phase.detail}</div>
                </details>
              </div>
            </div>

            <div className={styles.potFooter}>
              <div>
                <div className={styles.potFootLabel}>{phase.countdownMeaningful ? "CLOSES IN" : "WEEK ENDED"}</div>
                <div className={`num ${styles.potCountdown}`} suppressHydrationWarning>
                  {!mounted ? "—" : phase.countdownMeaningful ? formatCountdown(closesIn) : "0d 0h 0m"}
                </div>
              </div>
              <div className={styles.week}>
                <div className={styles.weekTrack}>
                  <div className={styles.weekFill} style={{ width: `${phase.countdownMeaningful ? weekPct : 100}%` }} />
                </div>
                <div className={styles.potFootLabel}>
                  {phase.countdownMeaningful ? `${weekPct.toFixed(0)}% THROUGH THE WEEK` : "AWAITING THE NEXT PERIOD"}
                </div>
              </div>
            </div>
          </div>

          {/* The pot on its plinth: v6's glow and contact shadow, with the glint, the
              line and the way in that the cell had before. It is the only object on the
              page anyone wants to touch, so it carries the invitation too. */}
          <div className={styles.niche}>
            <span className={styles.seam} />
            <span className={styles.nicheGlow} aria-hidden="true" />
            <span className={styles.shimmer} aria-hidden="true" />

            <div className={styles.nicheKicker}>ALL OF IT · TO ONE OF {state.depositors || "—"}</div>

            <div className={styles.potWindow}>
              <Pot3D size={158} quiet quips />
            </div>
            <span className={styles.potShadow} aria-hidden="true" />

            <div className={styles.nicheDrag}>CLICK IT · DRAG TO TURN</div>

            <div className={`editorial ${styles.nicheLine}`}>
              All this
              <br />
              can be yours.
            </div>

            <button className={styles.nicheCta} onClick={() => setSheet("join")}>
              Take your shot
            </button>

            <span className={`${styles.seam} ${styles.seamRight}`} />
          </div>

          <div className={styles.yieldCell}>
            <div className={styles.yieldTop}>
              <div className={styles.yieldLabel}>
                <span className="liveDot" /> BUILDING TOWARD DRAW #{drawNumber}
              </div>
              <div className={`num ${styles.yieldValue}`}>+{formatUnits(accrued, 2)}</div>
              {/* Derived from the same figures the contract uses, not invented: the pot for
                  a full period divided by the blocks in one. */}
              <div className={styles.perBlock}>
                +{formatUnits(pot / BigInt(Math.max(1, Math.floor(Number(state.periodSeconds) / 12))), 4)} PER BLOCK ·
                EVERY 12s
              </div>
            </div>

            {/* The pot filling across the week, not one bar per settled draw.
                Draws are weekly, so a fourteen-draw history takes three months to fill and
                showed thirteen empty boxes beside a cell headed "BUILDING TOWARD DRAW #N" —
                a chart about the wrong axis. This is the axis the heading names, it is full
                from the first block, and it is computed from the same figures the contract
                uses rather than recorded: the pot for a full period, spread over its
                minutes, plus whatever has been sponsored outright. */}
            <div className={styles.bars}>
              {Array.from({ length: 14 }, (_, i) => {
                const atMinute = Math.round(((i + 1) / 14) * 10080);
                const done = Number(state.minuteOfPeriod) >= atMinute;
                const soFar = (yieldEstimate * BigInt(atMinute)) / 10080n + state.sponsoredThisDraw;
                const height = pot > 0n ? Math.max(6, (Number(soFar) / Number(pot)) * 100) : 3;

                return (
                  <span
                    key={i}
                    className={styles.bar}
                    style={{
                      height: `${height}%`,
                      background: done ? "var(--yellow)" : "rgba(255,210,8,.18)",
                    }}
                    title={`${done ? "reached" : "projected"} · minute ${atMinute.toLocaleString()} of 10,080 · ${formatUnits(soFar, 2)} cUSDT`}
                  />
                );
              })}
            </div>
            <div className={styles.yieldFoot}>
              <span>THE POT, ACROSS THE WEEK · SOLID IS EARNED</span>
              <span className={styles.yieldFootHi}>MINUTE {String(state.minuteOfPeriod)}</span>
            </div>

            {/* v6 shows STRATEGY / NET APY at the foot of this cell. There is no ERC-4626
                vault on Sepolia, since the reserve is funded directly, so the strategy is named
                for what it actually is rather than borrowing a label it has not earned. */}
            <div className={styles.yieldStrat}>
              <span>
                STRATEGY <span className={styles.stratV}>FUNDED RESERVE</span>
              </span>
              <span>
                NET APY{" "}
                <span className={styles.stratV}>
                  {state.annualRateBps ? `${(Number(state.annualRateBps) / 100).toFixed(2)}%` : "—"}
                </span>
              </span>
            </div>
          </div>
        </section>

        {/* stat rail ------------------------------------------------------ */}
        <section className={styles.rail}>
          <Rail label="POOLED PRINCIPAL" value={lastDraw ? formatUnits(lastDraw.total / 10080n) : "—"} />
          <Rail label="PRIZES PAID" value={formatUnits(draws.reduce((sum, d) => sum + d.prize, 0n))} accent />
          <Rail label="DRAWS SETTLED" value={String(draws.length)} />
        </section>

        {/* your position -------------------------------------------------- */}
        <PositionPanel
          balance={position.balance}
          weight={position.weight}
          slot={position.slot}
          isUnlocked={isUnlocked}
          drawNumber={drawNumber}
          poolTotal={lastDraw?.total}
          minuteOfPeriod={state.minuteOfPeriod}
          lastPrize={lastPaid > 0n ? lastPaid : undefined}
          onDeposit={() => setSheet("deposit")}
          onWithdraw={() => setSheet("withdraw")}
          onLock={lock}
        >
          <div className={styles.revealFooter}>
            <button className="btnPrimary" style={{ width: "100%" }} onClick={reveal} disabled={!isConnected || busy}>
              {!isConnected
                ? "Connect a wallet to reveal"
                : stage === "signing"
                  ? "Waiting for your signature…"
                  : stage === "computing"
                    ? "Recomputing on-chain…"
                    : stage === "decrypting"
                      ? "Decrypting locally with your key…"
                      : "Reveal my position · 1 signature"}
            </button>
            {busy && (
              <div className={styles.sweepTrack}>
                <span className={styles.sweep} />
              </div>
            )}
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.revealNote}>
              One signature opens a session for this visit. Your balance is recomputed on-chain, then decrypted in this
              browser with a key that never leaves it.
            </div>
            {/* Withdrawing does not have to wait on this. It was gated behind the reveal
                button above for no reason beyond convenience — the withdraw sheet has its
                own reveal step now, so opening it straight from here just moves the same
                signature to where someone actually asked for it. */}
            <button className="btnQuiet" style={{ width: "100%", marginTop: 8 }} onClick={() => setSheet("withdraw")}>
              Withdraw without revealing first
            </button>
          </div>
        </PositionPanel>

        {/* draw engine ---------------------------------------------------- */}
        <section className="panel">
          <div className="panelHead">
            <span>DRAW ENGINE · #{drawNumber}</span>
            {/* One vocabulary for the whole page. This badge used to run its own logic and
                say "SEALED UNTIL CLOSE" during a week where nothing was sealed, while the
                phase line below it said "OPEN" about the same moment. */}
            <span style={{ color: phase.id === "accruing" ? undefined : "var(--yellow)" }}>{phase.tag}</span>
          </div>
          {/* These three used to read `drawNumber > 0`, so every cell showed OK forever
              once any draw had ever settled — a diagram of the mechanism rather than a
              report on this one. They now track the cycle actually in front of you. */}
          <div className={styles.engine}>
            <EngineCell
              label="COMMITMENT"
              note="the pool total is sealed and published for decryption"
              done={phase.id === "sealed" || phase.id === "settling"}
              active={phase.id === "due"}
            />
            <EngineCell
              label="ENCRYPTED DIE"
              note="the network rolls it on-chain, inside the settling transaction"
              done={phase.id === "settling"}
              active={phase.id === "sealed"}
            />
            <EngineCell
              label="PAYOUT"
              note="every depositor is checked; FHE.select moves the pot, branchlessly"
              done={false}
              active={phase.id === "settling"}
            />
          </div>
          <CloseDraw phase={phase} />
        </section>

        {/* v6 pairs the personal question with the public record, side by side: the
            log is the evidence that answering it left nothing behind. */}
        <section className={styles.pair}>
          <div>
            {draws.length > 0 && (
              <DidIWin
                draws={checkable}
                currentPeriod={state.currentPeriod}
                unlocked={isUnlocked}
                onClaimed={() => state.refetch()}
              />
            )}
          </div>
          <ContractLog
            limit={100}
            // Undefined until the reads land, so the row shows a dash rather than three
            // zeros that look like a pool nobody has joined.
            depositors={state.loaded ? Number(state.depositors) : undefined}
            drawsSettled={state.loaded ? Number(state.drawCount) : undefined}
            paid={draws.length > 0 ? draws.reduce((sum, d) => sum + d.prize, 0n) : undefined}
          />
        </section>
        <PositionHistory drawCount={state.drawCount} slot={position.slot} />
      </main>

      {sheet && (
        <DepositSheet
          mode={sheet === "join" ? "deposit" : sheet}
          lockMode={sheet === "join"}
          drawNumber={drawNumber}
          inPool={position.balance}
          // Withdraw has no decrypt path of its own — it borrows this one, the same
          // signature-then-transaction flow the position panel's own reveal button runs.
          // `reveal()` writes into shared state (`position`, above), so a reveal
          // triggered from inside the sheet updates `inPool` the same way the panel's
          // own button would, and the sheet re-renders with the real balance.
          onRevealPosition={reveal}
          revealingPosition={busy}
          revealConnected={isConnected}
          onClose={() => setSheet(null)}
          onDone={() => {
            state.refetch();
            void reveal();
          }}
        />
      )}
    </>
  );
}

function Rail({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={styles.railCell}>
      <div className={styles.railLabel}>{label}</div>
      <div className={styles.railValue} style={{ color: accent ? "var(--yellow)" : undefined }}>
        {value}
      </div>
    </div>
  );
}

function EngineCell({ label, note, done, active }: { label: string; note: string; done: boolean; active: boolean }) {
  return (
    <div className={styles.engineCell} style={{ background: active ? "rgba(255,210,8,.07)" : undefined }}>
      <div className={styles.engineTop}>
        <span>{label}</span>
        <span style={{ color: done || active ? "var(--yellow)" : "var(--text-4)" }}>
          {done ? "OK" : active ? "···" : "—"}
        </span>
      </div>
      <div className={styles.engineRail}>
        <span className={styles.engineFill} style={{ width: done ? "100%" : active ? "58%" : "0%" }} />
      </div>
      <div className={styles.engineNote}>{note}</div>
    </div>
  );
}

/**
 * What the cycle needs next, said where depositors stand — with a button, not just a link.
 *
 * There used to be a button here that gated on the elapsed period alone, so it sat greyed
 * out for the owner opening early and never worked at all on the sandbox, where the pool's
 * owner is a forwarding contract rather than the caller. It was pulled rather than fixed in
 * place.
 *
 * Both buttons below are safe from that trap for the same reason: `due` only exists once
 * `periodEnded()` is already true, and `sealed` only exists once a draw is already pending
 * — and `openDraw` past that point, and `settleDraw` always, take no owner check at all.
 * There is no early-open case to get wrong, because a button offered from either state was
 * never gated on ownership to begin with. Nothing here needs the sandbox's forwarding
 * contract, so the same two buttons work unmodified on both pools.
 */
function CloseDraw({ phase }: { phase: Phase }) {
  const withPool = usePoolHref();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);

  const said: Record<Phase["id"], string> = {
    accruing: "Odds are accruing. Nothing to do until the week is up.",
    due: "The week is up. Sealing the total needs no permission.",
    sealed: "Sealed. Settling rolls the die and needs one confirmation.",
    settling: "Rolled. Check your own result below, or sweep others on Judge.",
  };

  const openIt = async () => {
    setBusy(true);
    try {
      const tx = await writeContractAsync({ address: POOL_ADDRESS, abi: poolAbi, functionName: "openDraw" });
      await waitForTransactionReceipt(config, { hash: tx });
      toast({ kind: "success", title: "Draw opened", detail: "The total is sealed and published for decryption." });
    } catch (e) {
      toast({ kind: "error", title: "Could not open the draw", detail: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  const settleIt = async () => {
    if (!publicClient) return;
    setBusy(true);
    try {
      const handle = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "pendingTotalHandle",
      });
      const { publicDecryptRetry } = await import("@/lib/fhe");
      const res = (await publicDecryptRetry([handle as string])) as {
        abiEncodedClearValues: string;
        decryptionProof: string;
      };
      const tx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "settleDraw",
        args: [res.abiEncodedClearValues, res.decryptionProof],
      } as never);
      await waitForTransactionReceipt(config, { hash: tx });
      toast({
        kind: "success",
        title: "Draw settled",
        detail: "The die is rolled. Every depositor can now be checked.",
      });
    } catch (e) {
      toast({ kind: "error", title: "Could not settle the draw", detail: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.engineFoot}>
      <span>{said[phase.id]}</span>
      {phase.id === "due" && (
        <button className="btnPrimary" onClick={openIt} disabled={busy || !address}>
          {busy ? "Opening…" : "Open the draw"}
        </button>
      )}
      {phase.id === "sealed" && (
        <button className="btnPrimary" onClick={settleIt} disabled={busy || !address}>
          {busy ? "Settling…" : "Settle it"}
        </button>
      )}
      {phase.id === "settling" && <Link href={withPool("/judge")}>Sweep on Judge →</Link>}
    </div>
  );
}
