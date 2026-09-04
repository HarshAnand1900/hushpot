"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useConfig, usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { DEPLOY_BLOCK, POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { isClaimable } from "@/lib/claim";
import { useReceipts } from "@/hooks/useReceipts";
import { useSettledAt } from "@/hooks/useSettledAt";
import { currentSession, decryptHandle, openSession } from "@/lib/fhe";
import { describeError, toast } from "@/lib/toast";
import { formatCountdown, formatUnits } from "@/lib/format";
import styles from "./DidIWin.module.css";

/** Addresses and hashes, trimmed to something a line can carry. */
const shorten = (v: string) => (v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);

/** An unwritten handle is thirty-two zero bytes; a real one never is. */
const isHandle = (v?: string) => !!v && /[1-9a-f]/i.test(v.slice(2));

export type CheckableDraw = { id: bigint; prize: bigint; period: number };

/**
 * Two questions, told apart - though the first one answers both at once.
 *
 * "Am I owed anything?" is a payment. `checkMyClaim` is one transaction: it evaluates the
 * draw against your band *and* writes the result down, crediting the prize or an encrypted
 * zero in the same call. There is no separate claim step after checking - checking is the
 * whole of it, which is also why it costs the same gas regardless of the answer. It works
 * for thirty days after settlement, not just the current period; the tree keeps five
 * periods of history so a roll does not end this the way it used to.
 *
 * "Did I win?" is information, once a check has already happened - by you or by a keeper
 * sweeping the pool for everyone. It opens `awardOf[draw][slot]` with a signature, costs no
 * gas, and keeps working afterwards - after a sweep, after a roll, indefinitely.
 *
 * This panel used to answer both by sending a transaction and diffing the balance either
 * side of it, which fails in the ordinary case: if anything checked your slot first, the
 * credit landed before the snapshot and the difference reads zero for winners and losers
 * alike. Every state below comes from two public reads and a stored ciphertext instead, so
 * the answer never depends on who got there first.
 */
type Answer =
  /** Reads outstanding. */
  | { kind: "loading" }
  /** No wallet, so no address to answer for. */
  | { kind: "disconnected" }
  /** No deposit, so no slot and nothing to answer. */
  | { kind: "no-slot" }
  /** A receipt exists. It opens for a signature and no gas. */
  | { kind: "ready"; handle: string }
  /** Checked, but before receipts were written. The balance is the only ledger. */
  | { kind: "legacy" }
  /** Nobody has checked this slot and the window is open. Claim it. */
  | { kind: "unclaimed" }
  /** Nobody checked it and the period rolled. Nothing can answer it now. */
  | { kind: "missed" };

export function DidIWin({
  draws,
  currentPeriod,
  unlocked,
  onClaimed,
}: {
  /** Every settled draw, newest first. */
  draws: CheckableDraw[];
  currentPeriod: number;
  unlocked: boolean;
  onClaimed: () => void;
}) {
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const [picked, setPicked] = useState(0);
  const [answer, setAnswer] = useState<Answer>({ kind: "loading" });
  /** Opened receipts, by draw id. Keeps a revisited draw instant and silent. */
  const [openedByDraw, setOpenedByDraw] = useState<Record<string, bigint>>({});
  const [arrival, setArrival] = useState<{ at: number; hash: string; by: string }>();
  const [busy, setBusy] = useState<"signing" | "claiming" | "opening">();
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);

  /**
   * This address's slot and when it was assigned. One address per pool, so this is fetched
   * once and shared across every draw, rather than per draw the way the rest of the answer
   * is.
   *
   * A slot is permanent once taken (recycling only happens after `exitPool`), but the
   * *draws it can answer for* are not: `checkClaim` forces an encrypted zero, no win check
   * at all, for any draw settled before `slotAssignedAt`. A new depositor who has never
   * touched an old draw used to see it marked "YOURS TO CLAIM" anyway, because the resolve
   * effect only tested `hasSlot` - true the moment they joined, for every draw that had
   * ever run, including the ones from before they existed. Checking one would have cost
   * real gas for a result that was never in question: the contract had already decided it
   * before the transaction landed.
   */
  const [mySlot, setMySlot] = useState<{ slot: number; since: number } | "none" | undefined>();
  useEffect(() => {
    if (!publicClient || !address) {
      setMySlot(undefined);
      return;
    }
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
          if (live) setMySlot("none");
          return;
        }
        const slot = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "slotOf",
          args: [address],
        })) as number;
        const since = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "slotAssignedAt",
          args: [slot],
        })) as number;
        if (live) setMySlot({ slot, since });
      } catch {
        if (live) setMySlot(undefined);
      }
    })();
    return () => {
      live = false;
    };
  }, [publicClient, address, nonce]);

  /** Whether this address could possibly have anything to answer for a draw settled in
   * `period` - false for a slot that did not exist yet, exactly as `checkClaim` decides it. */
  const enteredBy = (period: number) => mySlot !== undefined && mySlot !== "none" && mySlot.since <= period;
  // A rehearsal of the winning screen, with no transaction behind it. Most visitors will
  // lose - that is what a lottery is - and the screen that matters would otherwise never
  // be seen. It is labelled on every line so it can never be mistaken for a result.
  const [preview, setPreview] = useState(false);

  const draw = draws[picked];
  /** A bigint compares by value, so effects keyed on this survive the parent's re-renders. */
  const drawId = draw?.id;
  const drawPeriod = draw?.period;
  const key = draw ? String(draw.id) : "";
  const opened = openedByDraw[key];
  const { unopened, markOpened } = useReceipts(BigInt(draws.length));

  /** Which draw the resolve effect last settled, so a re-run does not blank a good answer. */
  const resolved = useRef<string>(undefined);

  // How long *this* draw's thirty days still have to run. Both halves come from the
  // contract - the draw's own `settledAt` and `CLAIM_GRACE` - rather than being counted in
  // rolls here, because a countdown that disagrees with the chain is worse than none.
  const { at: settledAt, grace } = useSettledAt(BigInt(draws.length));
  const drawSettledAt = drawId !== undefined ? settledAt[String(drawId)] : undefined;

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const claimLeft = drawSettledAt !== undefined && grace !== undefined ? drawSettledAt + grace - now : undefined;

  /** Whether a claim would still be accepted on-chain for this draw. */
  const windowOpen = draw !== undefined && isClaimable(draw.period, currentPeriod, drawSettledAt, now);

  /**
   * Resolve which state this draw is in, from public reads only.
   *
   * Keyed on `drawId` rather than on `draw`. The parent builds its array inline, so every
   * one of its renders - and it polls - hands down a new object with the same contents.
   * Depending on that identity re-ran this effect several times a second and flashed
   * "reading the chain" over an answer that was already correct.
   */
  useEffect(() => {
    if (!publicClient || drawId === undefined) return;
    // Without an address there is nobody to answer for, and leaving the panel on "reading"
    // makes a missing wallet look like a stalled network.
    if (!address) {
      setAnswer({ kind: "disconnected" });
      return;
    }
    let live = true;

    void (async () => {
      // Blank the panel only when moving to a different draw. A background re-resolve of
      // the one already on screen must not throw the answer away and put it back.
      if (resolved.current !== String(drawId)) {
        setAnswer({ kind: "loading" });
        setArrival(undefined);
      }
      try {
        // Not loaded yet - nothing to resolve against, so wait rather than guess.
        if (mySlot === undefined) return;

        // No deposit, ever, and `slotOf` would revert rather than returning one.
        if (mySlot === "none") {
          if (live) setAnswer({ kind: "no-slot" });
          return;
        }

        // A slot, but not one this draw could ever have known about: `checkClaim` forces
        // an encrypted zero for it, without running the win check at all, so there is
        // nothing here to read and nothing worth spending gas to confirm. Same state, same
        // copy, as never having deposited - which is exactly what was true when this draw
        // ran.
        if (drawPeriod !== undefined && mySlot.since > drawPeriod) {
          if (live) setAnswer({ kind: "no-slot" });
          return;
        }

        const slot = mySlot.slot;

        const [checked, award] = (await Promise.all([
          publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "claimChecked",
            args: [drawId, slot],
          }),
          publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "awardOf",
            args: [drawId, slot],
          }),
        ])) as [boolean, string];

        if (!live) return;
        if (isHandle(award)) setAnswer({ kind: "ready", handle: award });
        else if (checked) setAnswer({ kind: "legacy" });
        else if (windowOpen) setAnswer({ kind: "unclaimed" });
        else setAnswer({ kind: "missed" });
        // Marked only once the reads have landed, so an interrupted resolve is retried
        // from scratch rather than treated as already answered.
        resolved.current = String(drawId);

        // Provenance. `ClaimChecked` is public and indexed by draw and slot, so the panel
        // can name the block, the time and the caller without decrypting anything.
        if (checked) {
          const logs = await publicClient.getLogs({
            address: POOL_ADDRESS,
            event: {
              type: "event",
              name: "ClaimChecked",
              inputs: [
                { name: "drawId", type: "uint256", indexed: true },
                { name: "slot", type: "uint16", indexed: true },
                { name: "checkedBy", type: "address", indexed: true },
              ],
            },
            args: { drawId, slot: Number(slot) },
            fromBlock: DEPLOY_BLOCK,
          });
          const hit = logs[logs.length - 1];
          if (hit && live) {
            const block = await publicClient.getBlock({ blockNumber: hit.blockNumber });
            setArrival({
              at: Number(block.timestamp),
              hash: hit.transactionHash,
              by: (hit.args as { checkedBy?: string }).checkedBy ?? "",
            });
          }
        }
      } catch {
        if (live) setAnswer({ kind: "loading" });
      }
    })();

    return () => {
      live = false;
    };
  }, [publicClient, address, drawId, windowOpen, nonce, mySlot, drawPeriod]);

  /**
   * Make sure a decrypt session exists, opening one if it does not.
   *
   * The panel used to render a disabled button reading "Reveal your position first",
   * which is an instruction to go and operate a different panel and then come back. A
   * signature this flow needs is a signature this flow should ask for.
   */
  const ensureSession = useCallback(async () => {
    if (!address || currentSession(address)) return;
    setBusy("signing");
    await openSession(address, signTypedDataAsync as never);
  }, [address, signTypedDataAsync]);

  /** Open a receipt. A decryption: one signature at most, no gas, works whenever. */
  const open = useCallback(
    async (handle: string, drawId: bigint, announce: boolean) => {
      setError(undefined);
      try {
        await ensureSession();
        setBusy("opening");
        const value = (await decryptHandle(handle)) ?? 0n;
        setOpenedByDraw((m) => ({ ...m, [String(drawId)]: value }));
        markOpened(drawId);
        if (announce) {
          toast(
            value > 0n
              ? {
                  kind: "success",
                  title: `You won ${formatUnits(value)} cUSDT`,
                  detail: "Read from your own receipt. Nobody else can open it.",
                }
              : { kind: "success", title: "Not this draw", detail: "Your receipt for it decrypts to zero." },
          );
        }
      } catch (e) {
        setError(describeError(e));
        throw e;
      } finally {
        setBusy(undefined);
      }
    },
    [ensureSession, markOpened],
  );

  /**
   * Open the answer without being asked, once the session is already unlocked.
   *
   * The click that used to sit here bought nothing: revealing your position has already
   * cost the signature, so the extra step was a gate in front of a door that was open. A
   * draw whose result is known should say the result.
   */
  const tried = useRef<Set<string>>(new Set());
  const handle = answer.kind === "ready" ? answer.handle : undefined;
  useEffect(() => {
    if (!handle || !unlocked || drawId === undefined) return;
    const k = String(drawId);
    // `tried` is the loop guard, so this stays keyed on values rather than on the objects
    // the parent rebuilds every render.
    if (tried.current.has(k)) return;
    tried.current.add(k);
    void open(handle, drawId, false).catch(() => {
      // A failed decrypt stays failed until the draw is picked again; the manual button
      // below is the retry, so nothing here loops.
    });
  }, [handle, unlocked, drawId, open]);

  /**
   * Claim the draw for yourself: one transaction, one wallet prompt.
   *
   * `checkMyClaim` runs the check and refreshes the balance cache in the same call, and it
   * writes the receipt this panel then opens. Nothing here reads a balance delta, so a
   * keeper racing you changes which state you land in and never the answer.
   */
  const claim = useCallback(async () => {
    if (!draw || !address || !publicClient) return;
    setError(undefined);
    try {
      // Signature first, while nothing has been spent. Asking for it afterwards left the
      // user holding a settled transaction and a panel that would not say what it did.
      await ensureSession();

      setBusy("claiming");
      const tx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "checkMyClaim",
        args: [draw.id],
      });
      // Two confirmations: the relayer has to see the grant this transaction made before
      // it will decrypt, and one block leaves too little room for that to propagate.
      await waitForTransactionReceipt(config, { hash: tx, confirmations: 2 });

      // Read and open the receipt here rather than waiting for the resolve effect to
      // notice. One button, one continuous flow, ending on the answer.
      setBusy("opening");
      const slot = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotOf",
        args: [address],
      })) as number;
      const award = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "awardOf",
        args: [draw.id, slot],
      })) as string;

      if (isHandle(award)) {
        const value = (await decryptHandle(award)) ?? 0n;
        setOpenedByDraw((m) => ({ ...m, [String(draw.id)]: value }));
        markOpened(draw.id);
        setAnswer({ kind: "ready", handle: award });
        tried.current.add(String(draw.id));
        toast(
          value > 0n
            ? {
                kind: "success",
                title: `You won ${formatUnits(value)} cUSDT`,
                detail: "Only you can read it.",
                hash: tx,
              }
            : { kind: "success", title: "Not this draw", detail: "Your receipt decrypts to zero.", hash: tx },
        );
      }
      setNonce((n) => n + 1);
      onClaimed();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not claim this draw.";
      setError(/user rejected|denied/i.test(message) ? "Declined." : describeError(e));
      toast({ kind: "error", title: "Could not claim this draw", detail: describeError(e) });
    } finally {
      setBusy(undefined);
    }
  }, [address, config, draw, ensureSession, markOpened, onClaimed, publicClient, writeContractAsync]);

  /** What the header says. Short, and about you rather than about the contract. */
  const status = (() => {
    if (opened !== undefined) return opened > 0n ? "YOU WON" : "NOT THIS ONE";
    switch (answer.kind) {
      case "ready":
        return "RESULT READY";
      case "unclaimed":
        return "NOT YET CHECKED";
      case "missed":
      case "legacy":
        return "NO RECORD";
      case "no-slot":
        return "NOT ENTERED";
      default:
        return windowOpen ? "OPEN" : "CLOSED";
    }
  })();

  /** A one-glance marker per draw, so the strip carries the state and prose need not. */
  const markFor = (d: CheckableDraw) => {
    if (openedByDraw[String(d.id)] !== undefined) return { mark: "✓", cls: styles.pickDone };
    // A draw this slot did not exist for is not "yours to claim," whatever the window
    // says - same reasoning as the resolve effect above.
    if (enteredBy(d.period) && isClaimable(d.period, currentPeriod, settledAt[String(d.id)], now))
      return { mark: "!", cls: styles.pickLive };
    return { mark: "·", cls: styles.pickShut };
  };

  return (
    <section className="panel">
      <div className="panelHead">
        <span>DRAW #{draw ? String(draw.id) : "—"} · SETTLED</span>
        <span style={{ color: opened !== undefined && opened > 0n ? "var(--yellow)" : undefined }}>{status}</span>
      </div>

      {unopened > 0 && (
        <div className={styles.waiting}>
          <span className="liveDot" />
          {unopened === 1 ? "1 result is waiting for you" : `${unopened} results are waiting for you`}. Opening one
          costs a signature and no gas, and only you can do it.
        </div>
      )}

      {/* This draw's own countdown, from its own settle time. It is still gated on the
          window being open, so it can never read "CHECK CLOSES 29d" under the word
          "CLOSED" - and it no longer borrows the newest draw's clock to say so. */}
      {windowOpen && claimLeft !== undefined && claimLeft > 0 && (
        <div className={styles.claimBar}>
          <span className={styles.claimK}>CHECK CLOSES</span>
          <span className={`num ${styles.claimV}`} suppressHydrationWarning>
            {formatCountdown(claimLeft)}
          </span>
          <span className={styles.claimNote}>
            Thirty days is how long the roll is held back from everybody else, so claiming is never a race.
          </span>
        </div>
      )}

      <div className={styles.body}>
        {draws.length > 1 && (
          <div className={styles.picker}>
            {draws.map((d, i) => {
              const { mark, cls } = markFor(d);
              return (
                <button
                  key={String(d.id)}
                  className={i === picked ? `${styles.pick} ${styles.pickOn}` : styles.pick}
                  onClick={() => {
                    setPicked(i);
                    setPreview(false);
                    setError(undefined);
                  }}
                  title={
                    openedByDraw[String(d.id)] !== undefined
                      ? "You have opened this one"
                      : !enteredBy(d.period)
                        ? "You joined after this one ran"
                        : isClaimable(d.period, currentPeriod, settledAt[String(d.id)], now)
                          ? "Ready to check"
                          : "Check window closed"
                  }
                >
                  #{String(d.id)}
                  <span className={cls}>{mark}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ---------------------------------------------------------- the answer -- */}

        {opened !== undefined && (
          <div className={opened > 0n ? `${styles.receipt} ${styles.receiptWon}` : styles.receipt}>
            <div className={styles.receiptHead}>{opened > 0n ? "PRIZE ARRIVED" : "NOT THIS DRAW"}</div>
            <div className={`num ${styles.receiptValue}`}>
              {opened > 0n ? `+${formatUnits(opened)}` : formatUnits(0n)} cUSDT
            </div>

            {arrival && (
              <div className={styles.arrival}>
                {/* Shown for a zero as well as a prize, and deliberately: these three facts
                    are public and identical either way, so a losing panel that omitted them
                    would imply they meant something. */}
                <div className={styles.arrivalRow}>
                  <span>CHECKED AT</span>
                  <span suppressHydrationWarning>
                    {new Date(arrival.at * 1000).toUTCString().replace("GMT", "UTC")}
                  </span>
                </div>
                <div className={styles.arrivalRow}>
                  <span>CHECKED BY</span>
                  <span>{shorten(arrival.by)}</span>
                </div>
                <div className={styles.arrivalRow}>
                  <span>IN</span>
                  <a href={`https://sepolia.etherscan.io/tx/${arrival.hash}`} target="_blank" rel="noreferrer">
                    {shorten(arrival.hash)} ↗
                  </a>
                </div>
              </div>
            )}

            <p className={styles.copy}>
              {opened > 0n
                ? "It is already in your pool balance - added the moment you were checked, which is why nothing announced it at the time. Withdraw it whenever you like; it is principal now."
                : "Your receipt decrypts to zero. It cost the same gas as a winner's and looks identical on-chain, which is what stops anybody reading the result off the ledger."}
            </p>
            <p className={styles.fine}>
              The amount above came from decrypting your own receipt in this browser and is visible to nobody else. The
              three lines under it are public: the chain records that your slot was checked, when, and by whom, for
              every depositor alike. That is what makes them safe to show - a losing panel says the same three things.
            </p>
          </div>
        )}

        {/* A receipt exists but the session is locked, so the signature has to be asked
            for. Once it has been, the block above opens by itself. */}
        {answer.kind === "ready" && opened === undefined && (
          <div className={styles.receipt}>
            <div className={styles.receiptHead}>YOUR RESULT IS WAITING</div>
            <p className={styles.copy}>
              This draw was checked for you and the answer was written down, encrypted to your address. Nobody else can
              open it - not whoever ran the check, not us, not the contract.
            </p>
            <button
              className="btnPrimary"
              onClick={() => draw && open(answer.handle, draw.id, true).catch(() => {})}
              disabled={!!busy}
            >
              {busy === "signing" ? "Check your wallet…" : busy === "opening" ? "Opening…" : "Open my result · no gas"}
            </button>
          </div>
        )}

        {/* ---------------------------------------------------------- the action -- */}

        {answer.kind === "unclaimed" && (
          <div className={styles.receipt}>
            <div className={styles.receiptHead}>THIS ONE IS STILL UNCHECKED</div>
            <p className={styles.copy}>
              One transaction settles it: the draw is evaluated against your band and the result written down, crediting
              you the prize or an encrypted zero - that evaluation is the whole of it, there is no separate step after.
              On-chain those two outcomes are identical, down to the gas, which is the entire point: checking is not an
              admission of anything. Your answer opens straight afterwards, and reopens for free whenever you like.
            </p>
            <button className="btnPrimary" onClick={claim} disabled={!!busy}>
              {busy === "signing"
                ? "Check your wallet…"
                : busy === "claiming"
                  ? "Checking…"
                  : busy === "opening"
                    ? "Opening your result…"
                    : "Check this draw"}
            </button>
            <p className={styles.fine}>
              You never have to be first. A keeper sweeping the pool credits you exactly the same amount, and being
              swept costs you nothing.
            </p>
          </div>
        )}

        {/* ------------------------------------------------------ the quiet cases -- */}

        {answer.kind === "loading" && <p className={styles.copy}>Reading the chain…</p>}

        {answer.kind === "disconnected" && (
          <p className={styles.copy}>
            Connect a wallet to see where you stand in this draw. Everything here is read for your address alone, and
            the result itself only ever opens with your key.
          </p>
        )}

        {answer.kind === "no-slot" && (
          <p className={styles.copy}>
            You had no deposit when this one ran, so there is nothing to answer. Deposit before the next draw closes and
            your odds start accruing from the minute it lands.
          </p>
        )}

        {/* Dead ends, kept to a line. The mechanics are true and worth having, and they are
            not what somebody wants shouted at them for asking a simple question. */}
        {(answer.kind === "missed" || answer.kind === "legacy") && (
          <div className={styles.quiet}>
            <span>
              {answer.kind === "legacy"
                ? "Checked, but no receipt was kept for this one."
                : "No record was kept of this one for you."}
            </span>
            <details className={styles.why}>
              <summary>Why</summary>
              {answer.kind === "legacy" ? (
                <p>
                  Your slot was checked, so the prize or the encrypted zero went into your balance then and nothing was
                  missed. Receipts were added after this draw ran, which is why the amount cannot be separated back out
                  now. Your balance against what you deposited is the only ledger of winnings there is, and it is yours
                  alone to read.
                </p>
              ) : (
                <p>
                  This draw&rsquo;s thirty days ran out before anybody checked your slot. Rolling does not end this -
                  the pool keeps five periods of history and will not roll past a draw still inside its window - so the
                  only thing that closes one is the clock. Checking any time in that month, or leaving a keeper to
                  sweep, both prevent this.
                </p>
              )}
            </details>
          </div>
        )}

        <p className={styles.cipher}>
          This draw paid {draw ? formatUnits(draw.prize) : "—"} cUSDT to exactly one depositor. Nobody - not the other
          players, not the contract, not us - can say which.
        </p>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button className="btnQuiet" onClick={() => setPreview(true)}>
            Preview a win
          </button>
        </div>

        {preview && (
          <div className={`${styles.result} ${styles.preview}`}>
            <div className={styles.previewTag}>PREVIEW · NOT A RESULT · NOTHING WAS CHECKED</div>
            <div className={styles.wonKicker}>THIS IS WHAT WINNING WOULD LOOK LIKE</div>
            <div className={`num ${styles.wonAmount}`}>+{draw ? formatUnits(draw.prize) : "—"}</div>
            <p className={styles.copy}>
              Only the winner ever sees this screen, because only their key opens the receipt it reads. No transaction
              was sent and your position is untouched.
            </p>
            <button className="btnQuiet" onClick={() => setPreview(false)}>
              Close preview
            </button>
          </div>
        )}

        {(busy === "claiming" || busy === "opening") && (
          <>
            <div className={styles.scramble}>
              {busy === "claiming" ? "Running the check on-chain…" : "Decrypting your answer, in this browser…"}
            </div>
            <p className={styles.copy}>
              {busy === "claiming"
                ? "Your claim adds the prize or an encrypted zero. On-chain the two are indistinguishable."
                : "The result never crosses the wire in the clear. Only your key opens it."}
            </p>
            <div className={styles.sweepTrack}>
              <span className={styles.sweep} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
