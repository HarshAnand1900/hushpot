"use client";

import { useCallback, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { decryptHandle } from "@/lib/fhe";
import { formatUnits } from "@/lib/format";
import styles from "./DidIWin.module.css";

type Phase = "idle" | "checking" | "reading" | "won" | "lost" | "error";

/**
 * The reveal.
 *
 * There is no announcement to listen for. The contract genuinely does not know who won —
 * a claim adds `select(won, prize, 0)` to your balance, and a loser's claim adds an
 * encrypted zero that is indistinguishable on-chain from a winner's, down to the gas.
 *
 * So the only way to find out is to open your own balance and see whether it moved. That
 * is what this does: run the check, then decrypt your balance and compare.
 */
export type CheckableDraw = { id: bigint; prize: bigint; period: number };

export function DidIWin({
  draws,
  currentPeriod,
  balanceBefore,
  unlocked,
  onClaimed,
}: {
  /** Every settled draw, newest first. */
  draws: CheckableDraw[];
  currentPeriod: number;
  balanceBefore?: bigint;
  unlocked: boolean;
  onClaimed: () => void;
}) {
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<Phase>("idle");
  const [delta, setDelta] = useState<bigint>(0n);
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState(0);

  const draw = draws[picked];

  /**
   * A draw is only claimable while its own period is still the current one.
   *
   * `checkClaim` requires it, and for a good reason: the check recomputes your band from
   * the live tree, which only matches what the draw was settled against until the period
   * rolls. So an older draw is not merely closed by policy — it is no longer answerable.
   */
  const claimable = draw !== undefined && draw.period === currentPeriod;

  const check = useCallback(async () => {
    if (!address || !publicClient || balanceBefore === undefined || !draw) return;
    setError(undefined);

    try {
      // No deposit, no slot, and `slotOf` reverts rather than returning one.
      const joined = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "hasSlot",
        args: [address],
      });

      if (!joined) {
        setError("You were not in this draw — deposit before the next one closes.");
        setPhase("error");
        return;
      }

      const slot = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotOf",
        args: [address],
      });

      const alreadyChecked = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "claimChecked",
        args: [draw.id, slot],
      });

      // Anyone can run this for anyone — a keeper may already have swept you.
      if (!alreadyChecked) {
        setPhase("checking");
        const tx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "checkClaim",
          args: [draw.id, address],
        });
        await waitForTransactionReceipt(config, { hash: tx });
      }

      setPhase("reading");
      const refreshTx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "refreshMyBalance",
      });
      await waitForTransactionReceipt(config, { hash: refreshTx });

      const handle = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "balanceHandle",
        args: [slot],
      });

      const after = await decryptHandle(handle as string);
      const gained = after !== undefined && after > balanceBefore ? after - balanceBefore : 0n;

      setDelta(gained);
      setPhase(gained > 0n ? "won" : "lost");
      onClaimed();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not check the draw.";
      setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
      setPhase("error");
    }
  }, [address, balanceBefore, config, draw, onClaimed, publicClient, writeContractAsync]);

  const busy = phase === "checking" || phase === "reading";

  return (
    <section className="panel">
      <div className="panelHead">
        <span>DRAW #{draw ? String(draw.id) : "—"} · SETTLED</span>
        <span style={{ color: phase === "won" ? "var(--yellow)" : undefined }}>
          {phase === "won" ? "YOURS ONLY" : phase === "lost" ? "CHECKED" : claimable ? "OPEN" : "WINDOW CLOSED"}
        </span>
      </div>

      <div className={styles.body}>
        {draws.length > 1 && (
          <div className={styles.picker}>
            {draws.map((d, i) => (
              <button
                key={String(d.id)}
                className={i === picked ? `${styles.pick} ${styles.pickOn}` : styles.pick}
                onClick={() => {
                  setPicked(i);
                  setPhase("idle");
                  setError(undefined);
                }}
                title={d.period === currentPeriod ? "Still claimable" : "Claim window closed"}
              >
                #{String(d.id)}
                {d.period !== currentPeriod && <span className={styles.pickShut}>·</span>}
              </button>
            ))}
          </div>
        )}

        {(phase === "idle" || phase === "error") && (
          <>
            <p className={styles.copy}>
              The pot landed in somebody&apos;s balance with no announcement. The only way to know is to open yours.
            </p>
            <p className={styles.cipher}>
              This draw paid {draw ? formatUnits(draw.prize) : "—"} cUSDT to exactly one depositor. Nobody — not the
              other players, not the contract, not us — can say which.
            </p>

            {!claimable && draw && (
              <div className={styles.expired}>
                The claim window for this draw closed when period #{draw.period} rolled over. A claim recomputes your
                band from the live tree, and those numbers moved on — so this one can no longer be answered, by anyone.
                Draws are swept before the roll for exactly this reason.
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}
            <button className="btnPrimary" onClick={check} disabled={!unlocked || busy || !claimable}>
              {!claimable ? "Window closed" : unlocked ? "Did I win?" : "Reveal your position first"}
            </button>
          </>
        )}

        {busy && (
          <>
            <div className={styles.scramble}>
              {phase === "checking" ? "Running the check on-chain…" : "Decrypting your balance locally…"}
            </div>
            <p className={styles.copy}>
              {phase === "checking"
                ? "Your claim adds the prize or an encrypted zero. On-chain the two are identical."
                : "Only your key opens this. The answer never crosses the wire in the clear."}
            </p>
            <div className={styles.sweepTrack}>
              <span className={styles.sweep} />
            </div>
          </>
        )}

        {phase === "lost" && (
          <div className={styles.result}>
            <div className={`num ${styles.lostHead}`}>Not this time.</div>
            <p className={styles.copy}>
              Your balance is unchanged — exactly what you put in. Nothing was ever at risk, and you are already
              entered in the next draw.
            </p>
          </div>
        )}

        {phase === "won" && (
          <div className={styles.result}>
            <div className={styles.wonKicker}>LEGIBLE TO YOU AND TO NO ONE ELSE</div>
            <div className={`num ${styles.wonAmount}`}>+{formatUnits(delta)}</div>
            <p className={styles.copy}>
              It landed in your balance, and it is already earning odds for the next draw. If you want anyone to know,
              that is your call to make.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
