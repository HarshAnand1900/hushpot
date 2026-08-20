"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { decryptHandle } from "@/lib/fhe";
import { formatCountdown, formatUnits } from "@/lib/format";
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
  // A rehearsal of the winning screen, with no transaction behind it. Most visitors will
  // lose — that is what a lottery is — and the screen that matters would otherwise never
  // be seen. It is labelled on every line so it can never be mistaken for a result.
  const [preview, setPreview] = useState(false);

  // How long the 30-day window still has to run. The grace period is the contract's, read
  // from it rather than hard-coded here — a countdown that disagrees with the chain is
  // worse than no countdown.
  const [claimLeft, setClaimLeft] = useState<number>();
  useEffect(() => {
    if (!publicClient) return;
    let live = true;

    const tick = async () => {
      try {
        const [settledAt, grace] = (await Promise.all([
          publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "lastDrawSettledAt" }),
          publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "CLAIM_GRACE" }),
        ])) as [bigint, bigint];

        if (settledAt === 0n) return;
        const closesAt = Number(settledAt + grace);
        if (live) setClaimLeft(closesAt - Math.floor(Date.now() / 1000));
      } catch {
        /* no countdown is better than a wrong one */
      }
    };

    void tick();
    const id = setInterval(tick, 30_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [publicClient]);

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
        // Two confirmations, not one. The relayer has to see the grant this transaction
        // made before it will decrypt, and one block leaves too little room for that to
        // reach whichever node it happens to read — the same reason every other decrypt
        // path here waits for two.
        await waitForTransactionReceipt(config, { hash: tx, confirmations: 2 });
      }

      setPhase("reading");
      const refreshTx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "refreshMyBalance",
      });
      await waitForTransactionReceipt(config, { hash: refreshTx, confirmations: 2 });

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

      {claimLeft !== undefined && claimLeft > 0 && (
        <div className={styles.claimBar}>
          <span className={styles.claimK}>CLAIM CLOSES</span>
          <span className={`num ${styles.claimV}`} suppressHydrationWarning>
            {formatCountdown(claimLeft)}
          </span>
          <span className={styles.claimNote}>
            The next period cannot open until this runs out, so a claim is never a race against anyone.
          </span>
        </div>
      )}

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
                  setPreview(false);
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
            <div className={styles.actions}>
              <button className="btnPrimary" onClick={check} disabled={!unlocked || busy || !claimable}>
                {!claimable ? "Window closed" : unlocked ? "Did I win?" : "Reveal your position first"}
              </button>
              <button className="btnQuiet" onClick={() => setPreview(true)}>
                Preview a win
              </button>
            </div>
          </>
        )}

        {preview && phase !== "won" && (
          <div className={`${styles.result} ${styles.preview}`}>
            <div className={styles.previewTag}>PREVIEW · NOT A RESULT · NOTHING WAS CHECKED</div>
            <div className={styles.wonKicker}>THIS IS WHAT WINNING WOULD LOOK LIKE</div>
            <div className={`num ${styles.wonAmount}`}>+{draw ? formatUnits(draw.prize) : "—"}</div>
            <p className={styles.copy}>
              Only the winner ever sees this screen, because only their key opens the balance it reads. No transaction
              was sent and your position is untouched.
            </p>
            <button className="btnQuiet" onClick={() => setPreview(false)}>
              Close preview
            </button>
          </div>
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
              Your balance is unchanged — exactly what you put in. Nothing was ever at risk, and you are already entered
              in the next draw.
            </p>
            <button className="btnQuiet" onClick={() => setPhase("idle")}>
              Reset
            </button>
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
            <button className="btnQuiet" onClick={() => setPhase("idle")}>
              Reset
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
