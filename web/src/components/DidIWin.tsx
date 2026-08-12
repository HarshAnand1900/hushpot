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
export function DidIWin({
  drawId,
  prize,
  balanceBefore,
  unlocked,
  onClaimed,
}: {
  drawId: bigint;
  prize: bigint;
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

  const check = useCallback(async () => {
    if (!address || !publicClient || balanceBefore === undefined) return;
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
        args: [drawId, slot],
      });

      // Anyone can run this for anyone — a keeper may already have swept you.
      if (!alreadyChecked) {
        setPhase("checking");
        const tx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "checkClaim",
          args: [drawId, address],
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
  }, [address, balanceBefore, config, drawId, onClaimed, publicClient, writeContractAsync]);

  const busy = phase === "checking" || phase === "reading";

  return (
    <section className="panel">
      <div className="panelHead">
        <span>DRAW #{String(drawId)} · SETTLED</span>
        <span style={{ color: phase === "won" ? "var(--yellow)" : undefined }}>
          {phase === "won" ? "YOURS ONLY" : phase === "lost" ? "CHECKED" : "UNREAD"}
        </span>
      </div>

      <div className={styles.body}>
        {(phase === "idle" || phase === "error") && (
          <>
            <p className={styles.copy}>
              The pot landed in somebody&apos;s balance with no announcement. The only way to know is to open yours.
            </p>
            <p className={styles.cipher}>
              This draw paid {formatUnits(prize)} cUSDT to exactly one depositor. Nobody — not the other players, not
              the contract, not us — can say which.
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <button className="btnPrimary" onClick={check} disabled={!unlocked || busy}>
              {unlocked ? "Did I win?" : "Reveal your position first"}
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
