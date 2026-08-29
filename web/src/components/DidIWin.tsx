"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { useReceipts } from "@/hooks/useReceipts";
import { decryptHandle } from "@/lib/fhe";
import { describeError, toast } from "@/lib/toast";
import { formatCountdown, formatUnits } from "@/lib/format";
import styles from "./DidIWin.module.css";

type Phase = "idle" | "checking" | "reading" | "won" | "lost" | "settled" | "error";

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

  /**
   * Whether this draw has already been checked for you.
   *
   * `claimChecked` is a public view per slot, so the panel can say this before anybody
   * signs anything. It answers the question people actually have about an old draw, "was
   * I included?", which is knowable — without pretending to answer "did I win", which
   * after a sweep is not.
   */
  const [checkedForYou, setCheckedForYou] = useState<boolean>();
  /**
   * The handle holding what this draw awarded you.
   *
   * Written by whichever call checked the slot, keeper or self, and granted to the
   * depositor. Opening it is a decryption, so it costs a signature and no gas, and it
   * keeps working after the period rolls — which is the point, because `checkClaim`
   * does not.
   */
  const [receipt, setReceipt] = useState<string>();
  // Bumped after a check writes one, so the panel picks up a receipt it did not have when
  // the draw was selected.
  const [receiptNonce, setReceiptNonce] = useState(0);
  const { unopened, markOpened } = useReceipts(BigInt(draws.length));
  const [opened, setOpened] = useState<bigint>();
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!publicClient || !address || draw === undefined) return;
    let live = true;
    void (async () => {
      try {
        const joined = await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "hasSlot",
          args: [address],
        });
        if (!joined) {
          if (live) setCheckedForYou(undefined);
          return;
        }
        const slot = await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "slotOf",
          args: [address],
        });
        const [flag, award] = await Promise.all([
          publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "claimChecked",
            args: [draw.id, slot],
          }),
          publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "awardOf",
            args: [draw.id, slot],
          }),
        ]);
        if (!live) return;
        setCheckedForYou(flag as boolean);
        // An unset handle is thirty-two zero bytes, which is also a legitimate encrypted
        // zero — but an unchecked slot has never been written, so the two cannot collide.
        const handle = award as string;
        setReceipt(handle && /[1-9a-f]/i.test(handle.slice(2)) ? handle : undefined);
      } catch {
        /* the panel reads fine without it */
      }
    })();
    return () => {
      live = false;
    };
  }, [publicClient, address, draw, receiptNonce]);

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
        setError("You were not in this draw. Deposit before the next one closes.");
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

      // One transaction, not two. `checkMyClaim` runs the check and opens the answer in
      // the same call; asking it separately meant two wallet prompts and a block of dead
      // time between them to answer a single question.
      //
      // A keeper may already have swept this slot, in which case the check is done and
      // only the reveal is outstanding — that path still needs `refreshMyBalance`, but it
      // is one transaction too.
      setPhase("checking");
      const tx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: alreadyChecked ? "refreshMyBalance" : "checkMyClaim",
        args: alreadyChecked ? [] : [draw.id],
      });
      // Two confirmations: the relayer has to see the grant this transaction made before
      // it will decrypt, and one block leaves too little room for that to reach whichever
      // node it happens to read.
      setPhase("reading");
      await waitForTransactionReceipt(config, { hash: tx, confirmations: 2 });

      const handle = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "balanceHandle",
        args: [slot],
      });

      const after = await decryptHandle(handle as string);
      const gained = after !== undefined && after > balanceBefore ? after - balanceBefore : 0n;

      /**
       * A delta only answers the question when this transaction is what moved the balance.
       *
       * If a keeper had already swept the slot, the credit landed at sweep time, which is
       * before the balance this compares against was read. The difference is then zero for
       * a winner and a loser alike, and reporting "not this draw" off the back of it was
       * telling some winners they had lost. The contract stores no won-flag to fall back
       * on, so the honest answer in that case is that the delta cannot say.
       */
      if (alreadyChecked) {
        setDelta(0n);
        setPhase("settled");
        setReceiptNonce((n) => n + 1);
        toast({
          kind: "success",
          title: "Already checked for you",
          detail: "Your prize, if there was one, is in the balance above. A fresh check cannot separate it out.",
          hash: tx,
        });
        onClaimed();
        return;
      }

      setDelta(gained);
      setPhase(gained > 0n ? "won" : "lost");
      setReceiptNonce((n) => n + 1);
      toast(
        gained > 0n
          ? {
              kind: "success",
              title: `You won ${formatUnits(gained)} cUSDT`,
              detail: "It is already in your pool balance, legible to nobody else.",
              hash: tx,
            }
          : {
              kind: "success",
              title: "Not this draw",
              detail: "Your balance is unchanged. Nothing was ever at risk.",
              hash: tx,
            },
      );
      onClaimed();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not check the draw.";
      setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
      setPhase("error");
      toast({ kind: "error", title: "Could not check the draw", detail: describeError(e) });
    }
  }, [address, balanceBefore, config, draw, onClaimed, publicClient, writeContractAsync]);

  const openReceipt = async () => {
    if (!receipt) return;
    setOpening(true);
    setError(undefined);
    try {
      const value = await decryptHandle(receipt);
      setOpened(value ?? 0n);
      if (draw) markOpened(draw.id);
      toast(
        value && value > 0n
          ? {
              kind: "success",
              title: `You won ${formatUnits(value)} cUSDT`,
              detail: "Read from your own receipt for this draw. Nobody else can open it.",
            }
          : { kind: "success", title: "Not this draw", detail: "Your receipt for it decrypts to zero." },
      );
    } catch (e) {
      setError(e instanceof Error ? describeError(e) : "Could not open the receipt.");
    } finally {
      setOpening(false);
    }
  };

  const busy = phase === "checking" || phase === "reading" || opening;

  return (
    <section className="panel">
      <div className="panelHead">
        <span>DRAW #{draw ? String(draw.id) : "—"} · SETTLED</span>
        <span style={{ color: phase === "won" ? "var(--yellow)" : undefined }}>
          {phase === "won"
            ? "YOURS ONLY"
            : phase === "lost" || phase === "settled"
              ? "CHECKED"
              : claimable
                ? "OPEN"
                : "WINDOW CLOSED"}
        </span>
      </div>

      {unopened > 0 && (
        <div className={styles.waiting}>
          <span className="liveDot" />
          {unopened === 1 ? "1 result is waiting for you" : `${unopened} results are waiting for you`}. Opening one
          costs a signature and no gas, and only you can do it.
        </div>
      )}

      {/* `lastDrawSettledAt` is one global figure describing the newest draw, so this bar
          belongs only to a draw that is still claimable. Beside an older one it read
          "CLAIM CLOSES 29d" directly under the words "WINDOW CLOSED". */}
      {claimable && claimLeft !== undefined && claimLeft > 0 && (
        <div className={styles.claimBar}>
          <span className={styles.claimK}>CLAIM CLOSES</span>
          <span className={`num ${styles.claimV}`} suppressHydrationWarning>
            {formatCountdown(claimLeft)}
          </span>
          <span className={styles.claimNote}>
            Thirty days is how long the roll is held back from everybody else, so a claim is never a race. The pool
            owner is exempt and can roll sooner, which is why a sweep runs before every roll.
          </span>
        </div>
      )}

      {/* A window that closed early closed because somebody rolled, not because a month
          passed. Left unsaid, the countdown above makes it look like a clock ran out. */}
      {!claimable && draw && (
        <div className={styles.claimBar}>
          <span className={styles.claimK}>CLOSED BY</span>
          <span className={`num ${styles.claimV}`}>THE ROLL</span>
          <span className={styles.claimNote}>
            Not by the clock. Period #{draw.period} rolling is what ended this one, whether or not the thirty days had
            run. Every depositor was checked before that happened.
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
              other players, not the contract, not us, can say which.
            </p>

            {/* A receipt exists whenever the slot was checked, by anyone, ever. Opening it
                is a decryption: one signature, no gas, and it still works long after the
                period rolled and `checkClaim` stopped being callable. */}
            {receipt && opened === undefined && (
              <div className={styles.receipt}>
                <div className={styles.receiptHead}>YOUR RECEIPT FOR THIS DRAW</div>
                <p className={styles.copy}>
                  This draw was checked for you and the result was written down, encrypted to your address. Opening it
                  costs a signature and no gas, and nobody else can open it — not the keeper that ran the check, not us,
                  not the contract.
                </p>
                <button className="btnPrimary" onClick={openReceipt} disabled={busy || !unlocked}>
                  {opening ? "Opening…" : unlocked ? "Open my result · no gas" : "Reveal your position first"}
                </button>
              </div>
            )}

            {receipt && opened !== undefined && (
              <div className={styles.receipt}>
                <div className={styles.receiptHead}>{opened > 0n ? "YOU WON THIS DRAW" : "NOT THIS DRAW"}</div>
                <div className={`num ${styles.receiptValue}`}>
                  {opened > 0n ? `+${formatUnits(opened)}` : formatUnits(0n)} cUSDT
                </div>
                <p className={styles.copy}>
                  {opened > 0n
                    ? "Already in your pool balance, and legible to nobody but you. The chain recorded that a claim happened, never what it found."
                    : "Your receipt decrypts to zero. It cost the same gas as a winner's and looks identical on-chain, which is what stops anybody reading the result off the ledger."}
                </p>
                <button className="btnQuiet" onClick={() => setOpened(undefined)}>
                  Close
                </button>
              </div>
            )}

            {!claimable && draw && !receipt && (
              <div className={styles.expired}>
                Period #{draw.period} has rolled, and that is what closes a claim, not the thirty-day countdown. A claim
                recomputes your band from the live tree; those numbers have moved on, so this draw can no longer be
                answered by anybody.
                {checkedForYou === true ? (
                  <>
                    {" "}
                    <strong>You were checked for this one</strong>, before the roll, and the prize or the encrypted zero
                    went into your balance then. Nothing was missed. What no longer exists is a way to separate that
                    credit back out: the contract keeps no record of who won a draw, which is the whole point of it.
                    Your balance against what you deposited is the only ledger of winnings there is, and it is yours
                    alone to read.
                  </>
                ) : (
                  <> Every depositor is checked before a roll, so any prize here was credited to whoever won it.</>
                )}
              </div>
            )}

            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.actions}>
              {/* Once a receipt exists it answers the question for a signature and no gas,
                  which makes a transaction here strictly worse: it costs money and, on a
                  slot somebody else swept, cannot tell you anything the balance still
                  shows. The receipt panel above is the action in that case. */}
              {!receipt && (
                <button className="btnPrimary" onClick={check} disabled={!unlocked || busy || !claimable}>
                  {!claimable ? "Window closed" : !unlocked ? "Reveal your position first" : "Did I win?"}
                </button>
              )}
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

        {/* Checked by somebody else before you asked, so a delta cannot attribute the
            prize to this draw. Saying what *is* knowable beats inventing a verdict. */}
        {phase === "settled" && (
          <div className={styles.result}>
            <div className={`num ${styles.lostHead}`}>Already checked for you.</div>
            <p className={styles.copy}>
              A keeper swept this draw before you asked, which is what is meant to happen: every depositor is checked
              before the period rolls, so nobody has to remember to collect. The prize or the encrypted zero went into
              your balance at that moment.
            </p>
            <p className={styles.copy}>
              That is also why this panel will not now tell you which it was. The check compares your balance before and
              after, and the credit landed before you looked. The contract keeps no record of who won any draw, so
              nothing here can be consulted after the fact. <strong>Your balance above is the answer</strong>: compare
              it against what you deposited, and the difference is everything you have ever won.
            </p>
            <button className="btnQuiet" onClick={() => setPhase("idle")}>
              Reset
            </button>
          </div>
        )}

        {phase === "lost" && (
          <div className={styles.result}>
            <div className={`num ${styles.lostHead}`}>Not this time.</div>
            <p className={styles.copy}>
              Your balance is unchanged: exactly what you put in. Nothing was ever at risk, and you are already entered
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
