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
  const [running, setRunning] = useState<string>();
  // Persisted per pool: switching tabs to look at what a step changed used to wipe the
  // record that it had run. See useJudgeSession.
  const { log, done, append, complete, clear } = useJudgeSession(state.currentPeriod, !state.isLoading);

  const drawId = state.drawCount > 0n ? state.drawCount - 1n : 0n;
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();
  const sweptAll = cursor !== undefined && cursor >= state.depositors && state.depositors > 0;

  /** How many slots carry the checked flag for the current draw. */
  const countChecked = useCallback(async () => {
    if (!publicClient || state.drawCount === 0n) return 0;
    const flags = await Promise.all(
      Array.from({ length: state.depositors }, (_, slot) =>
        publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "claimChecked",
          args: [state.drawCount - 1n, slot],
        }),
      ),
    );
    return flags.filter(Boolean).length;
  }, [publicClient, state.drawCount, state.depositors]);

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    try {
      // Progress is counted from `claimChecked`, not from `sweepCursor`.
      //
      // Only `sweepRange` advances that cursor. `checkClaim` does not — and that is what
      // the CLI sweep uses, what `checkMyClaim` uses behind the "Did I win?" button, and
      // what `checkClaimBatch` uses. So a pool swept by any of those still read 0 here,
      // which left step 06 permanently blocked on a console whose whole purpose is running
      // the cycle to completion. The per-slot flag is the truth whichever path set it.
      const slots = state.depositors;
      const [o, ...flags] = await Promise.all([
        publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "owner" }),
        ...Array.from({ length: state.drawCount > 0n ? slots : 0 }, (_, slot) =>
          publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "claimChecked",
            args: [state.drawCount - 1n, slot],
          }),
        ),
      ]);

      setOwner(o as string);
      setCursor(flags.filter(Boolean).length);
    } catch {
      /* the console still renders without these */
    }
  }, [publicClient, state.drawCount, state.depositors]);

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
      state.refetch();
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
    const draw = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "draws",
      args: [drawId],
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
      note: onSandbox
        ? "Seals the pool total and publishes it for decryption. Sent through the sandbox's owner contract, which forwards this call to any address, so it works from your wallet, now, without waiting for the period to elapse."
        : "Seals the pool total and publishes it for decryption. Anyone may call it once the period has elapsed; the owner may call it early so a week-long cycle fits in a demo.",
      disabled: !isConnected || state.drawPending || (!state.periodEnded && !isOwner && !onSandbox),
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
      note: `Credits four slots the prize or an encrypted zero. Nobody learns who won, including whoever runs it. A slot already checked is skipped instead of paid twice, so this is safe to repeat. ${cursor ?? 0} of ${state.depositors} covered.`,
      disabled: state.drawCount === 0n || sweptAll,
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
      note: sweptAll
        ? onSandbox
          ? "Ends the claim window and opens the next period, through the owner contract so it needs no key and no thirty-day wait. The pool is then back at step 01, ready to run again."
          : "Ends the claim window and opens the next period. Held back thirty days after settlement so a claim is never a race."
        : `Locked until everyone is swept: ${cursor ?? 0} of ${state.depositors}. Rolling now would end the claim window on anybody still unpaid.`,
      disabled: !isConnected || state.drawCount === 0n || state.drawPending || !sweptAll,
      go: () =>
        run("roll", onSandbox ? "SandboxOperator.startNextPeriod()" : "startNextPeriod()", async () => {
          const out = await sendGated("startNextPeriod");
          const period = (await publicClient!.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "currentPeriod",
          })) as number;
          return { ...out, note: `claim window closed · period #${period} now open · back to step 01` };
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
            <p className={styles.heroCopy} suppressHydrationWarning>
              {onSandbox
                ? "You are on the sandbox, a throwaway pool nobody has run a cycle on yet. Every step below works from the wallet you already have. No key to import, no week to wait."
                : "Two of the six steps are gated to the owner until the period elapses on 3 September. Run those today on the sandbox instead."}
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
              value={cursor === undefined ? "—" : `${cursor} / ${state.depositors}`}
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
              minute.
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
