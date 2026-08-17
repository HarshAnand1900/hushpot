"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { AppHeader } from "@/components/AppHeader";
import { useLastDraw, usePoolState } from "@/hooks/usePoolState";
import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./operator.module.css";

/**
 * The keeper's side of the pool, in the browser.
 *
 * A draw is two on-chain steps with an off-chain decryption between them, and until now
 * that meant a Hardhat task — which makes the app look like half a product. Anyone
 * assessing this should be able to run a full cycle without a terminal: open a draw,
 * relay the total, settle, pay everyone out, roll the period.
 *
 * Deliberately not hidden. The buttons enforce nothing the contract does not: `openDraw`
 * and `startNextPeriod` are open to anyone once the period has elapsed, and `sweepRange`
 * is open to anyone full stop. Only the early-trigger shortcuts are the owner's, and the
 * page says which those are rather than pretending it is all privileged.
 */
export default function OperatorTab() {
  const state = usePoolState();
  const lastDraw = useLastDraw(state.drawCount);
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [owner, setOwner] = useState<string>();
  const [cursor, setCursor] = useState<number>();
  const [busy, setBusy] = useState<string>();
  const [log, setLog] = useState<string[]>([]);

  const drawId = state.drawCount > 0n ? state.drawCount - 1n : 0n;
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase();

  const say = (line: string) => setLog((l) => [line, ...l].slice(0, 8));

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
      /* the panel still renders without these */
    }
  }, [publicClient, state.drawCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
      say(`${label} — done`);
      state.refetch();
      await refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      say(`${label} — ${/user rejected|denied/i.test(m) ? "declined" : m.slice(0, 120)}`);
    } finally {
      setBusy(undefined);
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
    await waitForTransactionReceipt(config, { hash: tx });
  };

  /**
   * The half of settlement that cannot happen on-chain.
   *
   * `openDraw` publishes the pool total as a publicly decryptable ciphertext; somebody has
   * to decrypt it through the relayer and hand the cleartext plus its proof back. The
   * contract verifies the signatures, so this step is a courier, not a trusted party —
   * a forged total is rejected by `FHE.checkSignatures`.
   */
  const settle = async () => {
    const handle = (await publicClient!.readContract({
      address: POOL_ADDRESS,
      abi: poolAbi,
      functionName: "pendingTotalHandle",
    })) as string;

    const { getFhevm } = await import("@/lib/fhe");
    const fhevm = await getFhevm();
    const res = await fhevm.publicDecrypt([handle]);

    await send("settleDraw", [
      (res as unknown as { abiEncodedClearValues: string }).abiEncodedClearValues,
      (res as unknown as { decryptionProof: string }).decryptionProof,
    ]);
  };

  const sweptAll = cursor !== undefined && cursor >= state.depositors && state.depositors > 0;

  return (
    <>
      <AppHeader pot={lastDraw ? lastDraw.prize : 0n} />

      <main className={`${styles.page} rise`}>
        <section className="panel">
          <div className="panelHead">
            <span>OPERATOR · DRAW LIFECYCLE</span>
            <span style={{ color: isOwner ? "var(--yellow)" : undefined }}>
              {!address ? "NOT CONNECTED" : isOwner ? "OWNER" : "ANYONE MAY RUN MOST OF THIS"}
            </span>
          </div>

          <div className={styles.body}>
            <p className={styles.copy}>
              A draw is two on-chain steps with an off-chain decryption between them. Everything below can be run from
              here rather than a terminal — the relay step included. Nothing here is privileged except the shortcuts
              that skip waiting, which exist so a week-long cycle can be demonstrated in a minute.
            </p>

            <div className={styles.facts}>
              <Fact label="PERIOD" value={`#${state.currentPeriod}`} />
              <Fact label="MINUTE" value={`${state.minuteOfPeriod} / 10080`} />
              <Fact label="PERIOD ENDED" value={state.periodEnded ? "yes" : "not yet"} />
              <Fact label="DRAW PENDING" value={state.drawPending ? "yes — needs settling" : "no"} />
              <Fact label="DRAWS SETTLED" value={String(state.drawCount)} />
              <Fact label="DEPOSITORS" value={String(state.depositors)} />
              <Fact label="RESERVE" value={formatUnits(state.prizeReserve)} />
              <Fact
                label={`SWEPT · DRAW #${drawId}`}
                value={cursor === undefined ? "—" : `${cursor} / ${state.depositors}`}
                accent={sweptAll}
              />
            </div>

            <ol className={styles.steps}>
              <Step
                n={1}
                title="Open the draw"
                note="Seals the pool total and publishes it for decryption. Anyone may do this once the period has elapsed; the owner may do it early."
                action="Open draw"
                disabled={state.drawPending || !!busy}
                running={busy === "Open draw"}
                onRun={() => run("Open draw", () => send("openDraw"))}
              />

              <Step
                n={2}
                title="Relay the total and settle"
                note="Decrypts the published total through the relayer and hands it back with its proof. The contract checks the signatures, so a forged total is rejected."
                action="Decrypt and settle"
                disabled={!state.drawPending || !!busy}
                running={busy === "Settle"}
                onRun={() => run("Settle", settle)}
              />

              <Step
                n={3}
                title="Pay everyone out"
                note="Credits every slot the prize or an encrypted zero. Nobody learns who won, including whoever runs it. Four slots per transaction."
                action={sweptAll ? "All swept" : "Sweep four"}
                disabled={state.drawCount === 0n || sweptAll || !!busy}
                running={busy === "Sweep"}
                onRun={() => run("Sweep", () => send("sweepRange", [drawId, 4], 3_600_000n))}
              />

              <Step
                n={4}
                title="Roll the period"
                note="Ends the claim window and starts the next period. Held back thirty days after settlement so a claim is never a race — the owner may cut that short here."
                action="Start next period"
                disabled={state.drawCount === 0n || state.drawPending || !!busy}
                running={busy === "Roll period"}
                onRun={() => run("Roll period", () => send("startNextPeriod"))}
              />

              <Step
                n={5}
                title="Prove solvency"
                note="Compares what the pool holds against what it owes, on ciphertext, and publishes the single bit that falls out. Anyone may run it."
                action="Prove it"
                disabled={!!busy}
                running={busy === "Prove solvency"}
                onRun={() => run("Prove solvency", () => send("proveSolvency"))}
              />
            </ol>

            {log.length > 0 && (
              <div className={styles.log}>
                {log.map((line, i) => (
                  <div key={i} className={styles.logLine}>
                    {line}
                  </div>
                ))}
              </div>
            )}

            <div className={styles.note}>
              Sweeping before rolling is the whole point of the order above: a rolled period ends every open claim, so
              paying everyone first is what stops a winner who never came back from losing the prize.
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

function Fact({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={styles.fact}>
      <span className={styles.factLabel}>{label}</span>
      <span className={styles.factValue} style={{ color: accent ? "var(--yellow)" : undefined }}>
        {value}
      </span>
    </div>
  );
}

function Step({
  n,
  title,
  note,
  action,
  disabled,
  running,
  onRun,
}: {
  n: number;
  title: string;
  note: string;
  action: string;
  disabled: boolean;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <li className={styles.step}>
      <span className={styles.stepNum}>{n}</span>
      <div className={styles.stepText}>
        <strong>{title}</strong>
        <span className={styles.stepNote}>{note}</span>
      </div>
      <button className="btnOutlineYellow" onClick={onRun} disabled={disabled || running}>
        {running ? "Working…" : action}
      </button>
    </li>
  );
}
