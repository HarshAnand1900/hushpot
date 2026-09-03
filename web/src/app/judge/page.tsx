"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { AppHeader } from "@/components/AppHeader";
import { useLastDraw, usePoolState, useWeeklyPot } from "@/hooks/usePoolState";
import {
  IS_SANDBOX,
  POOL_ADDRESS,
  SANDBOX_OPERATOR,
  TOKEN_DECIMALS,
  UNDERLYING_ADDRESS,
  erc20Abi,
  poolAbi,
  sandboxOperatorAbi,
} from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/format";
import { useJudgeSession } from "@/hooks/useJudgeSession";
import { poolPhase } from "@/hooks/usePoolPhase";
import { gasLimitFor } from "@/lib/gas";
import { describeError, toast } from "@/lib/toast";
import styles from "./judge.module.css";

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);

type StepState = "ready" | "running" | "done" | "blocked" | "failed";

/**
 * Every feature on one page, runnable from a connected wallet.
 *
 * The bounty asks that a judge be able to try the whole thing. A draw is two on-chain
 * steps with an off-chain decryption between them, which used to mean a Hardhat task —
 * so the interesting half of the protocol was invisible to anyone assessing it.
 *
 * Owner-gated calls are labelled as such rather than hidden, because most of this is not
 * gated at all: sweeping and withdrawing are open to anyone, and opening a draw is open to
 * anyone once the period has elapsed. Only the shortcuts that skip waiting are the
 * owner's, and pretending otherwise would misrepresent the contract.
 */
/** What a step reports when it finishes: what changed, and where to check it. */
type Outcome = { note: string; hash?: string };

export default function JudgeTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  // The same derivation every other tab uses, so the header cannot disagree with itself
  // from one tab to the next. See useWeeklyPot.
  const { pot } = useWeeklyPot(state, lastDraw);
  const phase = poolPhase(state, lastDraw);
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // Which pool this tab points at is read from the URL on the client, so it waits for
  // mount — the server renders the main pool's copy and React does not patch text it
  // hydrated.
  const [onSandbox, setOnSandbox] = useState(false);
  useEffect(() => setOnSandbox(IS_SANDBOX), []);

  const [owner, setOwner] = useState<string>();
  const [cursor, setCursor] = useState<number>();
  /** Slots the latest draw covered, snapshotted at settlement. */
  const [covered, setCovered] = useState<number>();
  const [running, setRunning] = useState<string>();
  // Persisted per pool: switching tabs to look at what a step changed used to wipe the
  // record that it had run. See useJudgeSession.
  const { log, done, append, complete, clear } = useJudgeSession(state.currentPeriod, state.loaded);

  const drawId = state.drawCount > 0n ? state.drawCount - 1n : 0n;
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();
  const target = covered ?? state.depositors;
  // `checkClaim` has no `covered` bound, so a depositor who joins after a draw settles and
  // answers it anyway pushes `checked` past the count that draw covered. Their award is
  // forced to an encrypted zero by `slotAssignedAt`, so nothing is mispaid — but the panel
  // would render "22 / 21", which reads as a bug. Clamped here rather than in the contract:
  // a redeploy to correct a display artefact would put the repo and the chain back out of
  // step, which is a worse problem than the one it fixes.
  const answered = Math.min(Number(cursor ?? 0), target);
  const sweptAll = cursor !== undefined && target > 0 && cursor >= target;
  // How many more times step 04 has to be pressed. A sweep covers four slots, and without
  // this the panel showed progress but never said that pressing the same button again is
  // what finishes it — which reads as a stuck pool rather than an unfinished one.
  const sweepsLeft = Math.max(0, Math.ceil((target - answered) / 4));

  /**
   * When this period actually elapses, read from the chain rather than written down.
   *
   * This was the literal string "3 September", which was true of the period it was written
   * during and wrong by two rolls afterwards — and wrong in the worst direction, since a
   * reviewer reading it after that date would believe a gate had lifted while the contract
   * still held it shut.
   */
  const periodElapsesOn =
    state.periodStart > 0n && state.periodSeconds > 0n
      ? new Date(Number(state.periodStart + state.periodSeconds) * 1000).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        })
      : undefined;
  /**
   * Whether the last settled draw still belongs to the current period.
   *
   * Both `sweepRange` and `startNextPeriod` test this on-chain, and once a period rolls
   * they revert — `AlreadyChecked` and `DrawNotSettled` respectively. Without it here, a
   * pool that had just rolled showed both steps live and both failed on click, which
   * reads as a broken console rather than a finished cycle.
   */
  const claimOpen = lastDraw !== undefined && lastDraw.period === state.currentPeriod;

  /** How many slots carry the checked flag for the current draw. */
  /**
   * How many of the draw's slots have been answered, straight from the contract.
   *
   * This used to read `claimChecked` once per slot and count the trues, because the only
   * alternative was `sweepCursor`, which `sweepRange` advances and a self-settled claim
   * does not. `checkedCount` is now maintained by both paths, so one read replaces N and
   * — more to the point — it is the exact number the roll itself is gated on, rather than
   * a reconstruction of it that could disagree.
   */
  const countChecked = useCallback(async () => {
    if (!publicClient || state.drawCount === 0n) return 0;
    const c = (await publicClient.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "claims",
      args: [state.drawCount - 1n],
    })) as readonly [number, number];
    return Number(c[1]);
  }, [publicClient, state.drawCount]);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    try {
      const id = state.drawCount > 0n ? state.drawCount - 1n : 0n;
      const [o, c] = await Promise.all([
        publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "owner" }),
        state.drawCount > 0n
          ? (publicClient.readContract({
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "claims",
              args: [id],
            }) as Promise<readonly [number, number]>)
          : Promise.resolve([0, 0] as const),
      ]);
      const [covered, checked] = c;

      setOwner(o as string);
      setCursor(Number(checked));
      // What the draw actually covered, not who is in the pool now. A depositor who joined
      // after settlement has no claim on it, and measuring against the live count would
      // show "15 of 16" for a cycle the contract considers finished.
      setCovered(Number(covered));
    } catch {
      /* the console still renders without these */
    }
  }, [publicClient, state.drawCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Run a step and say so, loudly.
   *
   * The log at the foot of the page was the only feedback a step gave, which meant a call
   * that took thirty seconds and then quietly succeeded looked, from the top of the page,
   * exactly like a call that had done nothing at all. Every step now also raises the same
   * toast the rest of the app uses, and reports what actually changed on-chain rather than
   * only the gas it burned.
   */
  const run = async (id: string, call: string, fn: () => Promise<Outcome>) => {
    setRunning(id);
    try {
      const { note, hash } = await fn();
      append({ call, note, ok: true, hash });
      complete(id);
      toast({ kind: "success", title: call, detail: note, hash });
      // Awaited: `drawId` is derived from `drawCount`, and settling increments it. Left
      // unawaited, a judge clicking straight from settle to sweep could send the previous
      // draw's id, which reverts on the period check and reads as a broken step.
      await state.refetch();
      await refresh();
    } catch (e) {
      const detail = describeError(e);
      append({ call, note: detail, ok: false });
      toast({ kind: "error", title: `${call} failed`, detail });
    } finally {
      setRunning(undefined);
    }
  };

  const send = async (functionName: string, args: unknown[] = [], gasFallback?: bigint) => {
    // Estimated, not stated. A stated ceiling has to be affordable up front — see
    // `gasLimitFor`, where a flat limit was pricing modest wallets out of a call they
    // could easily pay for.
    const gas = gasFallback
      ? await gasLimitFor(
          publicClient,
          address,
          { address: POOL_ADDRESS, abi: poolAbi, functionName, args },
          gasFallback,
        )
      : undefined;
    const tx = await writeContractAsync({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName,
      args,
      ...(gas ? { gas } : {}),
    } as never);
    const receipt = await waitForTransactionReceipt(config, { hash: tx });
    return { note: `gas ${receipt.gasUsed}`, hash: tx };
  };

  /**
   * The two owner-gated calls, sent wherever they will actually go through.
   *
   * On the real pool that is the pool itself, and early callers must be the owner. On the
   * sandbox the owner is a contract that forwards these two to anyone, so they go there
   * instead — which is what makes every step on this page runnable from a stranger's
   * wallet without a key changing hands.
   */
  const sendGated = async (functionName: "openDraw" | "startNextPeriod"): Promise<Outcome> => {
    if (!IS_SANDBOX) return send(functionName);
    const tx = await writeContractAsync({
      address: SANDBOX_OPERATOR,
      abi: sandboxOperatorAbi,
      functionName,
    });
    const receipt = await waitForTransactionReceipt(config, { hash: tx });
    return { note: `gas ${receipt.gasUsed}`, hash: tx };
  };

  /** Sponsorship rather than the owner-only reserve top-up, so any wallet can do it. */
  const sponsor = async () => {
    if (!address) throw new Error("Connect a wallet first.");
    const amount = 500n * SCALE;

    const mint = await writeContractAsync({
      address: UNDERLYING_ADDRESS,
      abi: erc20Abi,
      functionName: "mint",
      args: [address, amount],
    });
    await waitForTransactionReceipt(config, { hash: mint });

    const allowance = (await publicClient!.readContract({
      address: UNDERLYING_ADDRESS,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, POOL_ADDRESS],
    })) as bigint;

    // Tether-style approve: a stale non-zero allowance has to be cleared first.
    if (allowance > 0n && allowance < amount) {
      const clear = await writeContractAsync({
        address: UNDERLYING_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [POOL_ADDRESS, 0n],
      });
      await waitForTransactionReceipt(config, { hash: clear });
    }
    // Approved to the maximum once. A judge running the cycle twice should not pay for
    // an approval twice, and `sponsorPrize` below states its gas rather than estimating,
    // so one confirmation is enough.
    if (allowance < amount) {
      const ok = await writeContractAsync({
        address: UNDERLYING_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [POOL_ADDRESS, (1n << 256n) - 1n],
      });
      await waitForTransactionReceipt(config, { hash: ok });
    }

    return send("sponsorPrize", [amount], 1_200_000n);
  };

  /** The half of settlement that cannot happen on-chain. */
  const settle = async (): Promise<Outcome> => {
    const handle = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "pendingTotalHandle",
    })) as string;

    const { publicDecryptRetry } = await import("@/lib/fhe");
    const res = await publicDecryptRetry([handle]);

    const out = await send("settleDraw", [
      (res as unknown as { abiEncodedClearValues: string }).abiEncodedClearValues,
      (res as unknown as { decryptionProof: string }).decryptionProof,
    ]);

    // The one moment in the week that publishes anything. Say what it published.
    //
    // Read the count back rather than reusing `drawId`. `settleDraw` writes `draws[
    // drawCount]` and *then* increments, so the draw just settled is the one this page's
    // `drawId` was pointing one behind — reporting it would print the previous draw's
    // prize under the new draw's name.
    const settledCount = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "drawCount",
    })) as bigint;
    const draw = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "draws",
      args: [settledCount > 0n ? settledCount - 1n : 0n],
    })) as readonly [bigint, bigint, string, number, boolean];
    return {
      ...out,
      note: `total ${formatUnits(draw[0] / 10080n)} pooled · prize ${formatUnits(draw[1])} cUSDT · winner unresolved`,
    };
  };

  /**
   * Seal the draw, then say what became readable.
   *
   * "gas 214817" is true and tells a judge nothing. What matters is that a handle now
   * exists which anybody — not just this app — can decrypt, and that until this moment it
   * could not be decrypted by anyone at all.
   */
  const open = async (): Promise<Outcome> => {
    const out = await sendGated("openDraw");
    const handle = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "pendingTotalHandle",
    })) as string;
    return { ...out, note: `sealed · total now publicly decryptable as ${handle.slice(0, 12)}…` };
  };

  /**
   * Prove solvency, and report the bit the chain published rather than the fact a
   * transaction succeeded.
   *
   * The step's whole claim is that the pool holds at least what it owes, compared on
   * ciphertext so neither figure is revealed. A judge who only sees "OK · gas 189204" is
   * being asked to take that on trust, which is precisely the thing this project argues
   * nobody should have to do. So the published `ebool` is decrypted here through the same
   * public path anyone else can use, and the answer — with the handle it came from — is
   * what gets reported.
   */
  const solvency = async (): Promise<Outcome> => {
    const out = await send("proveSolvency");

    const handle = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "solvencyHandle",
    })) as string;

    const { publicDecryptRetry } = await import("@/lib/fhe");
    const res = await publicDecryptRetry([handle]);
    const value = Object.values((res as { clearValues?: Record<string, unknown> }).clearValues ?? {})[0];

    return {
      ...out,
      note: value
        ? `BACKED · every deposit still covered · bit ${handle.slice(0, 12)}… decrypts to true`
        : `SHORTFALL · the pool holds less than it owes · bit ${handle.slice(0, 12)}… decrypts to false`,
    };
  };

  const steps = [
    {
      id: "sponsor",
      n: "01",
      role: "ANYONE",
      title: "Grow the prize",
      sig: "sponsorPrize(uint256)",
      note: `Mints 500 test tokens and adds them to the next prize on top of the yield. Takes no odds and creates no position, so a sponsorship can never win itself back. It does not move the figure in the header, which is what the last draw paid; banked so far for draw #${state.drawCount}: ${formatUnits(state.sponsoredThisDraw)} cUSDT.`,
      disabled: !isConnected,
      go: () =>
        run("sponsor", "sponsorPrize(500)", async () => {
          const out = await sponsor();
          return { ...out, note: `+500.00 cUSDT banked for draw #${state.drawCount}` };
        }),
    },
    {
      id: "open",
      n: "02",
      role: onSandbox ? "ANYONE" : "OWNER EARLY · ANYONE AFTER CLOSE",
      title: "Open the draw",
      sig: onSandbox ? "SandboxOperator.openDraw()" : "openDraw()",
      note: claimOpen
        ? `Draw #${Number(state.drawCount) - 1} has already settled in this period, and the contract allows one per period. The next draw lives on the other side of a roll, so the order from here is: step 04 ${sweepsLeft > 0 ? `${sweepsLeft} more time${sweepsLeft === 1 ? "" : "s"}` : "until everyone is covered"}, then step 06, then this one.`
        : onSandbox
          ? "Seals the pool total and publishes it for decryption. Sent through the sandbox's owner contract, which forwards this call to any address, so it works from your wallet, now, without waiting for the period to elapse."
          : "Seals the pool total and publishes it for decryption. Anyone may call it once the period has elapsed; the owner may call it early so a week-long cycle fits in a demo.",
      // `claimOpen` blocks this one and enables steps 04 and 06, which is the right way
      // round: the contract allows one draw per period, so a draw already settled in this
      // period means the next thing to do is sweep and roll, not open another. Without it
      // the step read READY, reverted with DrawAlreadySettledThisPeriod, and surfaced as
      // "the node rejected the gas limit" — an estimation failure wearing a disguise.
      disabled: !isConnected || state.drawPending || claimOpen || (!state.periodEnded && !isOwner && !onSandbox),
      go: () => run("open", onSandbox ? "SandboxOperator.openDraw()" : "openDraw()", open),
    },
    {
      id: "settle",
      n: "03",
      role: "ANYONE",
      title: "Relay and settle",
      sig: "settleDraw(bytes, bytes)",
      note: "Decrypts the published total through the relayer and hands it back with its proof. FHE.checkSignatures rejects a forged total, so this step is a courier, not a trusted party.",
      disabled: !state.drawPending,
      go: () => run("settle", "settleDraw(…)", settle),
    },
    {
      id: "sweep",
      n: "04",
      role: "ANYONE",
      title: "Pay everyone out",
      sig: "sweepRange(uint256, uint16)",
      note: `Credits four slots the prize or an encrypted zero. Nobody learns who won, including whoever runs it. A slot already checked is skipped instead of paid twice, so this is safe to repeat. ${answered} of ${target} covered${sweepsLeft > 1 ? ` — press Run ${sweepsLeft} more times to finish` : sweepsLeft === 1 ? " — one more Run finishes it" : ""}.`,
      disabled: !isConnected || state.drawCount === 0n || !claimOpen || sweptAll,
      go: () =>
        run("sweep", `sweepRange(${drawId}, 4)`, async () => {
          const out = await send("sweepRange", [drawId, 4], 3_600_000n);
          const covered = await countChecked();
          return {
            ...out,
            note: `${covered} of ${state.depositors} checked · each credited the prize or an encrypted zero`,
          };
        }),
    },
    {
      id: "solvency",
      n: "05",
      role: "ANYONE",
      title: "Prove solvency",
      sig: "proveSolvency()",
      note: "Compares what the pool holds against what it owes, on ciphertext, so neither figure is revealed, then publishes the single bit that falls out. The bit is publicly decryptable, so this console decrypts it through the same open path anybody else can use and reports the answer, instead of reporting that a transaction succeeded.",
      disabled: !isConnected,
      go: () => run("solvency", "proveSolvency()", solvency),
    },
    {
      id: "roll",
      n: "06",
      role: onSandbox ? "ANYONE" : "OWNER EARLY · ANYONE AFTER 30 DAYS",
      title: "Roll the period",
      sig: onSandbox ? "SandboxOperator.startNextPeriod()" : "startNextPeriod()",
      // No sweep gate, and the note used to claim one. It said the contract reverts with
      // `ClaimsOutstanding` "for the owner too" — an error that no longer exists, guarding
      // a rule that was removed, for a reason that stopped being true when the tree started
      // keeping a generation of history. Rolling ends nothing now: a claim outlives its
      // period, so a slot nobody has answered yet is not a slot about to lose anything.
      note: !claimOpen
        ? "Already done for this period. The last draw settled in an earlier one, and the pool is waiting for the next draw before there is anything to roll."
        : onSandbox
          ? `Opens the next period, through the owner contract so it needs no key and no thirty-day wait. ${answered} of ${target} claims answered — the roll does not wait for the rest, because a claim stays answerable for a period after its own. The pool is then back at step 01.`
          : `Opens the next period. ${answered} of ${target} claims answered, and the roll does not wait for the rest: the tree keeps a generation of history, so a claim outlives the period it belongs to. Held back thirty days from everybody but the owner all the same, so nobody else can shorten the window.`,
      disabled: !isConnected || state.drawCount === 0n || state.drawPending || !claimOpen,
      go: () =>
        run("roll", onSandbox ? "SandboxOperator.startNextPeriod()" : "startNextPeriod()", async () => {
          const out = await sendGated("startNextPeriod");
          const period = (await publicClient!.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "currentPeriod",
          })) as number;
          return { ...out, note: `period #${period} now open · earlier claims stay answerable · back to step 01` };
        }),
    },
  ];

  const stateOf = (s: (typeof steps)[number]): StepState =>
    running === s.id ? "running" : done.has(s.id) ? "done" : s.disabled ? "blocked" : "ready";

  return (
    <>
      <div className="warmGlow" aria-hidden="true" />
      <AppHeader pot={pot} />

      <main className={`${styles.page} rise`}>
        {/* hero ------------------------------------------------------------ */}
        <section className={styles.hero}>
          <div className={`${styles.heroCell} yellowBand`}>
            <div className={styles.kicker}>JUDGE MODE · EVERY FEATURE, ONE PAGE</div>
            <h1 className={`editorial ${styles.heroTitle}`}>Run the whole cycle yourself.</h1>
            <p className={styles.heroCopy}>
              Grow the prize, open a draw, relay and settle it, pay every depositor out, prove solvency, roll the
              period.{" "}
              <span suppressHydrationWarning>
                {onSandbox
                  ? "All six run from any wallet on Sepolia. Nothing here is owner-gated."
                  : "Owner-gated calls are labelled; everything else works from any connected wallet on Sepolia."}
              </span>
            </p>
            {/* Opening a draw and rolling the period are gated only for running them
                early. A judge arriving before the first period elapses would find two of
                six steps closed, so there is a throwaway pool that opens all of them,
                and no reason to advertise it to someone already standing in it. */}
            {/* Both halves used to be hardcoded, and both went stale: the sandbox has now
                run cycles, and the gate date named a period that had already rolled. A
                sentence a reviewer can check against the chain has to come from it. */}
            <p className={styles.heroCopy} suppressHydrationWarning>
              {onSandbox
                ? `You are on the sandbox, a throwaway pool${
                    state.drawCount > 0n
                      ? ` that has already run ${state.drawCount === 1n ? "a full cycle" : `${state.drawCount} full cycles`}`
                      : " with its first cycle still to run"
                  }. Every step below works from the wallet you already have. No key to import, no week to wait.`
                : `Two of the six steps are gated to the owner until this period elapses${
                    periodElapsesOn ? ` on ${periodElapsesOn}` : ""
                  }. Run those today on the sandbox instead.`}
            </p>

            {/* A judge arriving before the period elapses finds two of six steps closed,
                which reads as a broken page rather than a deliberate gate. This is the way
                out, so it is a door rather than a sentence with a link in it. */}
            <p className={styles.phaseLine}>
              <strong>{phase.headline}</strong> {phase.detail}
            </p>

            {!onSandbox && (
              <a className={styles.sandboxCta} href="/judge?pool=sandbox" suppressHydrationWarning>
                <span className={styles.sandboxCtaLabel}>OPEN THE SANDBOX</span>
                <span className={styles.sandboxCtaNote}>
                  A second pool whose owner is a contract that forwards those two calls to anyone. All six steps, your
                  own wallet, right now.
                </span>
                <span className={styles.sandboxCtaArrow} aria-hidden="true">
                  →
                </span>
              </a>
            )}

            {/* A divergence notice lived here while the main pool ran older bytecode than
                the repo. Both pools now run the same source, so there is nothing to warn
                about — and a notice claiming otherwise would be worse than none, since it
                told a reviewer this pool lacked a fix it has. What immutability actually
                cost is in the README, where it reads as history rather than as a caveat. */}
          </div>

          <div className={styles.heroSide}>
            <Row label="CONNECTED" value={address ? shortenAddress(address) : "not connected"} />
            {/* On the sandbox the owner is a contract that forwards the gated calls to
                everyone, so there is no role to be in: every wallet has all six. */}
            <Row
              label="ROLE"
              value={
                onSandbox
                  ? "ANY WALLET · ALL SIX STEPS"
                  : !isConnected
                    ? "—"
                    : isOwner
                      ? "DEPOSITOR + OWNER (testnet)"
                      : "DEPOSITOR"
              }
              accent={isOwner || onSandbox}
            />
            <Row label="POOL IS" value={phase.tag} accent />
            <Row label="CYCLE PROGRESS" value={`${done.size} / ${steps.length}`} accent={done.size > 0} />
            <Row label="RESERVE" value={`${formatUnits(state.prizeReserve)} cUSDT`} />
            <Row
              label={`BANKED · DRAW #${state.drawCount}`}
              value={`${formatUnits(state.sponsoredThisDraw)} cUSDT`}
              accent={state.sponsoredThisDraw > 0n}
            />
            <Row
              label={`SWEPT · DRAW #${drawId}`}
              value={cursor === undefined ? "—" : `${answered} / ${target}`}
              accent={sweptAll}
            />

            <button
              className={styles.reset}
              onClick={() => {
                clear();
                toast({
                  kind: "success",
                  title: "Console cleared",
                  detail: "Only this browser's record. Nothing on-chain was touched.",
                });
              }}
            >
              {done.size >= steps.length ? "Run the cycle again" : "Reset console"}
            </button>
            {/* It clears a checklist. Saying so stops it reading like a contract call. */}
            <p className={styles.resetNote}>
              Clears the checklist and the log in this browser. It sends no transaction and changes nothing on-chain.
              The marks also clear on their own when the period rolls, since that starts a new cycle.
            </p>
          </div>
        </section>

        {/* steps ----------------------------------------------------------- */}
        <section className={styles.grid}>
          {steps.map((s) => {
            const st = stateOf(s);
            return (
              <div key={s.id} className={st === "done" ? `${styles.card} ${styles.cardDone}` : styles.card}>
                <div className={styles.cardTop}>
                  <span className={styles.stepNo}>STEP {s.n}</span>
                  <span className={styles.role}>{s.role}</span>
                </div>

                <div className={styles.cardTitle}>{s.title}</div>
                <code className={styles.sig}>{s.sig}</code>
                <p className={styles.cardNote}>{s.note}</p>

                <div className={styles.cardFoot}>
                  <span className={styles.status} data-state={st}>
                    {st === "running" ? "RUNNING" : st === "done" ? "DONE" : st === "blocked" ? "NOT YET" : "READY"}
                  </span>
                  <button className={styles.run} onClick={s.go} disabled={s.disabled || !!running || !isConnected}>
                    {running === s.id ? "…" : "Run"}
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        {/* session log ------------------------------------------------------ */}
        <section className="panel">
          <div className="panelHead">
            <span>SESSION LOG · KEPT ACROSS TABS</span>
            <span suppressHydrationWarning>{log.length} CALLS</span>
          </div>
          <div className={styles.log}>
            {log.length === 0 ? (
              <div className={styles.logEmpty}>NO CALLS YET · RUN A STEP ABOVE</div>
            ) : (
              log.map((l, i) => (
                <div key={`${l.at}-${i}`} className={styles.logRow}>
                  <span className={styles.logCall}>
                    {l.call}
                    <span className={styles.logTime} suppressHydrationWarning>
                      {new Date(l.at).toLocaleTimeString()}
                    </span>
                  </span>
                  <span className={styles.logNote}>{l.note}</span>
                  {/* A row nobody can check is a row asking to be believed. */}
                  {l.hash ? (
                    <a
                      className={l.ok ? styles.logOk : styles.logBad}
                      href={`https://sepolia.etherscan.io/tx/${l.hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {l.ok ? "OK ↗" : "FAILED ↗"}
                    </a>
                  ) : (
                    <span className={l.ok ? styles.logOk : styles.logBad}>{l.ok ? "OK" : "FAILED"}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* the boundary ----------------------------------------------------- */}
        <section className={styles.boundary}>
          <div className={styles.bCol}>
            <div className={styles.bHead}>WHAT NEEDS OWNER RIGHTS</div>
            <p>
              Topping up the reserve directly, plus the shortcuts that skip waiting: opening a draw before the period
              ends, rolling before the thirty-day claim window closes. Both exist so a week-long cycle can be shown in a
              minute. Worth being plain about the second one: thirty days outlasts a seven-day week, so on the weekly
              cadence the roll never becomes permissionless and stays the operator&apos;s job.
            </p>
          </div>
          <div className={styles.bCol}>
            <div className={styles.bHead}>WHAT ANY WALLET CAN DO</div>
            <p>
              Sponsor the prize, deposit, check a draw, decrypt its own balance, sweep the whole pool, prove solvency,
              withdraw in full. No allowlist, no registration step.
            </p>
          </div>
          <div className={styles.bCol}>
            <div className={styles.bHead}>WHAT NEVER HAPPENS</div>
            <p>
              No call on this page reveals a balance, and none of them writes a winner. Settlement moves the pot without
              resolving a name. There is no winner field in storage to read.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={styles.sideRow}>
      <span className={styles.sideLabel}>{label}</span>
      <span className={styles.sideValue} style={{ color: accent ? "var(--yellow)" : undefined }}>
        {value}
      </span>
    </div>
  );
}
