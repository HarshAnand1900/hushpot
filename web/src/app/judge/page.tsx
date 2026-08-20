"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { AppHeader } from "@/components/AppHeader";
import { useLastDraw, usePoolState } from "@/hooks/usePoolState";
import { POOL_ADDRESS, TOKEN_DECIMALS, UNDERLYING_ADDRESS, erc20Abi, poolAbi } from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/format";
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
export default function JudgeTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [owner, setOwner] = useState<string>();
  const [cursor, setCursor] = useState<number>();
  const [running, setRunning] = useState<string>();
  const [log, setLog] = useState<{ call: string; note: string; ok: boolean }[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());

  const drawId = state.drawCount > 0n ? state.drawCount - 1n : 0n;
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();
  const sweptAll = cursor !== undefined && cursor >= state.depositors && state.depositors > 0;

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    try {
      const [o, c] = await Promise.all([
        publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "owner" }),
        state.drawCount > 0n
          ? publicClient.readContract({
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "sweepCursor",
              args: [state.drawCount - 1n],
            })
          : Promise.resolve(0),
      ]);
      setOwner(o as string);
      setCursor(Number(c));
    } catch {
      /* the console still renders without these */
    }
  }, [publicClient, state.drawCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const say = (call: string, note: string, ok: boolean) => setLog((l) => [{ call, note, ok }, ...l].slice(0, 12));

  const run = async (id: string, call: string, fn: () => Promise<string>) => {
    setRunning(id);
    try {
      const note = await fn();
      say(call, note, true);
      setDone((d) => new Set(d).add(id));
      state.refetch();
      await refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      say(call, /user rejected|denied/i.test(m) ? "declined in wallet" : m.slice(0, 110), false);
    } finally {
      setRunning(undefined);
    }
  };

  const send = async (functionName: string, args: unknown[] = [], gas?: bigint) => {
    const tx = await writeContractAsync({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName,
      args,
      ...(gas ? { gas } : {}),
    } as never);
    const receipt = await waitForTransactionReceipt(config, { hash: tx });
    return `gas ${receipt.gasUsed}`;
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
  const settle = async () => {
    const handle = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "pendingTotalHandle",
    })) as string;

    const { publicDecryptRetry } = await import("@/lib/fhe");
    const res = await publicDecryptRetry([handle]);

    return send("settleDraw", [
      (res as unknown as { abiEncodedClearValues: string }).abiEncodedClearValues,
      (res as unknown as { decryptionProof: string }).decryptionProof,
    ]);
  };

  const steps = [
    {
      id: "sponsor",
      n: "01",
      role: "ANYONE",
      title: "Grow the prize",
      sig: "sponsorPrize(uint256)",
      note: "Mints 500 test tokens and puts them straight into the reserve. Takes no odds and creates no position — a sponsorship can never win itself back.",
      disabled: !isConnected,
      go: () => run("sponsor", "sponsorPrize(500)", sponsor),
    },
    {
      id: "open",
      n: "02",
      role: "OWNER EARLY · ANYONE AFTER CLOSE",
      title: "Open the draw",
      sig: "openDraw()",
      note: "Seals the pool total and publishes it for decryption. Anyone may call it once the period has elapsed; the owner may call it early so a week-long cycle fits in a demo.",
      disabled: state.drawPending || (!state.periodEnded && !isOwner),
      go: () => run("open", "openDraw()", () => send("openDraw")),
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
      note: "Credits four slots the prize or an encrypted zero. Nobody learns who won, including whoever runs it. Repeat until every depositor is covered.",
      disabled: state.drawCount === 0n || sweptAll,
      go: () => run("sweep", `sweepRange(${drawId}, 4)`, () => send("sweepRange", [drawId, 4], 3_600_000n)),
    },
    {
      id: "solvency",
      n: "05",
      role: "ANYONE",
      title: "Prove solvency",
      sig: "proveSolvency()",
      note: "Compares what the pool holds against what it owes, on ciphertext, and publishes the single bit that falls out. Neither figure is revealed.",
      disabled: !isConnected,
      go: () => run("solvency", "proveSolvency()", () => send("proveSolvency")),
    },
    {
      id: "roll",
      n: "06",
      role: "OWNER EARLY · ANYONE AFTER 30 DAYS",
      title: "Roll the period",
      sig: "startNextPeriod()",
      note: sweptAll
        ? "Ends the claim window and opens the next period. Held back thirty days after settlement so a claim is never a race."
        : `Locked until everyone is swept — ${cursor ?? 0} of ${state.depositors}. Rolling now would end the claim window on anyone still unpaid.`,
      disabled: state.drawCount === 0n || state.drawPending || !sweptAll,
      go: () => run("roll", "startNextPeriod()", () => send("startNextPeriod")),
    },
  ];

  const stateOf = (s: (typeof steps)[number]): StepState =>
    running === s.id ? "running" : done.has(s.id) ? "done" : s.disabled ? "blocked" : "ready";

  return (
    <>
      <AppHeader pot={lastDraw ? lastDraw.prize : 0n} />

      <main className={`${styles.page} rise`}>
        {/* hero ------------------------------------------------------------ */}
        <section className={styles.hero}>
          <div className={`${styles.heroCell} yellowBand`}>
            <div className={styles.kicker}>JUDGE MODE · EVERY FEATURE, ONE PAGE</div>
            <h1 className={`editorial ${styles.heroTitle}`}>Run the whole cycle yourself.</h1>
            <p className={styles.heroCopy}>
              Grow the prize, open a draw, relay and settle it, pay every depositor out, prove solvency, roll the
              period. Owner-gated calls are labelled; everything else works from any connected wallet on Sepolia.
            </p>
          </div>

          <div className={styles.heroSide}>
            <Row label="CONNECTED" value={address ? shortenAddress(address) : "not connected"} />
            <Row
              label="ROLE"
              value={!isConnected ? "—" : isOwner ? "DEPOSITOR + OWNER (testnet)" : "DEPOSITOR"}
              accent={isOwner}
            />
            <Row label="CYCLE PROGRESS" value={`${done.size} / ${steps.length}`} accent={done.size > 0} />
            <Row label="RESERVE" value={`${formatUnits(state.prizeReserve)} cUSDT`} />
            <Row
              label={`SWEPT · DRAW #${drawId}`}
              value={cursor === undefined ? "—" : `${cursor} / ${state.depositors}`}
              accent={sweptAll}
            />

            <button
              className={styles.reset}
              onClick={() => {
                setDone(new Set());
                setLog([]);
              }}
            >
              Reset console
            </button>
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
            <span>SESSION LOG</span>
            <span>{log.length} CALLS</span>
          </div>
          <div className={styles.log}>
            {log.length === 0 ? (
              <div className={styles.logEmpty}>NO CALLS YET · RUN A STEP ABOVE</div>
            ) : (
              log.map((l, i) => (
                <div key={i} className={styles.logRow}>
                  <span className={styles.logCall}>{l.call}</span>
                  <span className={styles.logNote}>{l.note}</span>
                  <span className={l.ok ? styles.logOk : styles.logBad}>{l.ok ? "OK" : "FAILED"}</span>
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
              Topping up the reserve directly, and the shortcuts that skip waiting — opening a draw before the period
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
              resolving a name — there is no winner field in storage to read.
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
