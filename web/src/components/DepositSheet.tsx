"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConfig, useReadContract, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { useDeposit } from "@/hooks/useDeposit";
import { TOKEN_DECIMALS, UNDERLYING_ADDRESS, erc20Abi } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./DepositSheet.module.css";

type Mode = "deposit" | "withdraw";

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);

/** Round numbers a depositor actually reaches for, rather than fractions of a balance. */
const QUICK = [100, 500, 1_000, 2_500];

export function DepositSheet({
  mode: initialMode,
  onClose,
  onDone,
  inPool,
  drawNumber,
}: {
  mode: Mode;
  onClose: () => void;
  onDone: () => void;
  inPool?: bigint;
  drawNumber?: number;
}) {
  const { address } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const { step, error, deposit, withdraw, reset, busy } = useDeposit();

  // The two directions live in one sheet, so changing your mind costs a tab rather than
  // closing, finding the other button, and reopening.
  const [mode, setMode] = useState<Mode>(initialMode);
  const [raw, setRaw] = useState("");

  // Portalled to <body> for the same reason as the wallet picker: a fixed overlay
  // rendered inside the page loses to siblings painted above it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: walletBalance, refetch: refetchWallet } = useReadContract({
    address: UNDERLYING_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && mode === "deposit" },
  });

  const [minting, setMinting] = useState(false);

  /**
   * The underlying is a mock whose `mint` is open to anyone — that is the faucet.
   *
   * Surfaced here because an empty wallet is the default state of every new visitor, and
   * without it the deposit sheet is a dead end for exactly the people we want to reach.
   */
  const faucet = async () => {
    if (!address) return;
    setMinting(true);
    try {
      const tx = await writeContractAsync({
        address: UNDERLYING_ADDRESS,
        abi: erc20Abi,
        functionName: "mint",
        args: [address, 10_000n * SCALE],
      });
      await waitForTransactionReceipt(config, { hash: tx, confirmations: 2 });
      await refetchWallet();
    } finally {
      setMinting(false);
    }
  };

  const available = mode === "deposit" ? ((walletBalance as bigint | undefined) ?? 0n) : (inPool ?? 0n);

  const amount = useMemo(() => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * Number(SCALE)));
  }, [raw]);

  const tooMuch = amount > available;
  const canSubmit = amount > 0n && !tooMuch && !busy;

  useEffect(() => {
    if (step === "done") {
      const id = setTimeout(() => {
        onDone();
        onClose();
      }, 900);
      return () => clearTimeout(id);
    }
  }, [step, onDone, onClose]);

  const submit = () => {
    if (!canSubmit) return;
    void (mode === "deposit" ? deposit(amount) : withdraw(amount));
  };

  const steps =
    mode === "deposit"
      ? [
          { key: "approving", label: "Approve tUSDT", note: "one-time, lets the pool pull tokens" },
          { key: "encrypting", label: "Encrypt the amount", note: "client-side, before broadcast" },
          { key: "depositing", label: "Submit ciphertext", note: "the contract stores a number it can't read" },
        ]
      : [
          { key: "encrypting", label: "Encrypt the amount", note: "sealed in this browser first" },
          { key: "withdrawing", label: "Submit ciphertext", note: "the pool returns your principal in full" },
        ];

  // `useDeposit` reports approving/depositing/withdrawing; encryption happens inside the
  // deposit step, so it lights up alongside it rather than as its own transaction.
  const activeKey = step === "depositing" || step === "withdrawing" ? "encrypting" : step;
  const activeIndex = steps.findIndex((s) => s.key === activeKey);

  if (!mounted) return null;

  const pretty = amount > 0n ? formatUnits(amount) : "";

  return createPortal(
    <div className={styles.scrim} onClick={() => !busy && onClose()}>
      <div
        className={styles.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "deposit" ? "Deposit" : "Withdraw"}
      >
        <div className={styles.head}>
          <div className={styles.tabs} role="tablist">
            {(["deposit", "withdraw"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={mode === m ? `${styles.tab} ${styles.tabOn}` : styles.tab}
                onClick={() => {
                  if (busy) return;
                  setMode(m);
                  setRaw("");
                  reset();
                }}
                disabled={busy}
              >
                {m === "deposit" ? "Deposit" : "Withdraw"}
              </button>
            ))}
          </div>
          <button className={styles.close} onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {/* amount ------------------------------------------------------- */}
          <div className={styles.amountCard}>
            <div className={styles.amountTop}>
              <label className={styles.amountLabel} htmlFor="amount">
                Amount
              </label>
              <span className={styles.avail}>
                {mode === "deposit" ? "Wallet:" : "In pool:"} <strong>{formatUnits(available)}</strong>
              </span>
            </div>

            <div className={styles.amountRow}>
              <input
                id="amount"
                className={styles.input}
                inputMode="decimal"
                placeholder="0.00"
                value={raw}
                onChange={(e) => setRaw(e.target.value.replace(/[^0-9.]/g, ""))}
                disabled={busy}
                autoFocus
              />
              <span className={styles.unit}>cUSDT</span>
              <button
                className={styles.max}
                disabled={busy || available === 0n}
                onClick={() => setRaw((Number(available) / Number(SCALE)).toString())}
              >
                Max
              </button>
            </div>

            <div className={styles.chips}>
              {QUICK.map((q) => (
                <button
                  key={q}
                  className={styles.chip}
                  disabled={busy || BigInt(q) * SCALE > available}
                  onClick={() => setRaw(String(q))}
                >
                  {q.toLocaleString()}
                </button>
              ))}
            </div>
          </div>

          {tooMuch && (
            <div className={styles.warn}>
              More than you {mode === "deposit" ? "hold" : "have in the pool"}. A confidential transfer that exceeds
              your balance moves nothing — it would cost gas and do nothing at all.
            </div>
          )}

          {/* what this actually does -------------------------------------- */}
          <div className={styles.note}>
            <span className={styles.noteMark} aria-hidden="true" />
            {mode === "deposit" ? (
              <span>
                This starts earning odds the moment it lands — no waiting for the draw boundary. Odds are weighted by
                amount and by how long it sits, so the earlier it arrives the more of
                {drawNumber !== undefined ? ` draw #${drawNumber}` : " this draw"} it earns. Deposit once and you are in
                every draw until you withdraw.
              </span>
            ) : (
              <span>
                Your principal was never at risk and comes back in full. Withdrawing keeps the odds this money already
                earned for the current draw — you only stop earning from now on.
              </span>
            )}
          </div>

          {/* steps --------------------------------------------------------- */}
          <ol className={styles.steps}>
            {steps.map((s, i) => {
              const done = step === "done" || (activeIndex >= 0 && i < activeIndex);
              const active = activeIndex === i;
              return (
                <li key={s.key} className={active ? styles.stepOn : done ? styles.stepDone : styles.step}>
                  <span className={styles.stepNum}>{done ? "✓" : i + 1}</span>
                  <span className={styles.stepText}>
                    <strong>{s.label}</strong>
                    <span className={styles.stepNote}>{s.note}</span>
                  </span>
                  {active && <span className={styles.stepNow}>now</span>}
                </li>
              );
            })}
          </ol>

          {error && <div className={styles.error}>{error}</div>}

          {mode === "deposit" && available === 0n && (
            <button className={styles.faucet} onClick={faucet} disabled={minting || busy}>
              {minting ? "Minting…" : "Your wallet is empty — get 10,000 test tUSDT"}
            </button>
          )}

          <button className={styles.submit} onClick={submit} disabled={!canSubmit}>
            {busy
              ? step === "approving"
                ? "Approving…"
                : mode === "deposit"
                  ? "Depositing…"
                  : "Withdrawing…"
              : step === "done"
                ? "Done"
                : // A confident label on a dead button reads as a broken page. Say what is
                  // missing instead, so the sheet looks like it is waiting.
                  amount === 0n
                  ? "Enter an amount"
                  : tooMuch
                    ? "More than you have"
                    : `${mode === "deposit" ? "Deposit" : "Withdraw"} ${pretty} cUSDT`}
          </button>

          {step === "error" && (
            <button className={styles.retry} onClick={reset}>
              Start over
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
