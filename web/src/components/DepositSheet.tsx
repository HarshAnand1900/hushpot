"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useReadContract } from "wagmi";

import { useDeposit } from "@/hooks/useDeposit";
import { TOKEN_DECIMALS, UNDERLYING_ADDRESS, erc20Abi } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./DepositSheet.module.css";

type Mode = "deposit" | "withdraw";

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);

export function DepositSheet({
  mode,
  onClose,
  onDone,
  inPool,
}: {
  mode: Mode;
  onClose: () => void;
  onDone: () => void;
  inPool?: bigint;
}) {
  const { address } = useAccount();
  const { step, error, deposit, withdraw, reset, busy } = useDeposit();
  const [raw, setRaw] = useState("");

  // Portalled to <body> for the same reason as the wallet picker: a fixed overlay
  // rendered inside the page loses to siblings painted above it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: walletBalance } = useReadContract({
    address: UNDERLYING_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && mode === "deposit" },
  });

  const available = mode === "deposit" ? ((walletBalance as bigint | undefined) ?? 0n) : (inPool ?? 0n);

  const amount = useMemo(() => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * Number(SCALE)));
  }, [raw]);

  const tooMuch = mode === "deposit" && amount > available;
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

  // Escape closes, unless a transaction is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = () => {
    if (!canSubmit) return;
    void (mode === "deposit" ? deposit(amount) : withdraw(amount));
  };

  const steps =
    mode === "deposit"
      ? [
          { key: "approving", label: "APPROVE", note: "one-time, lets the pool pull your tokens" },
          { key: "depositing", label: "SHIELD & DEPOSIT", note: "wrapped and credited as a number nobody can read" },
        ]
      : [{ key: "withdrawing", label: "ENCRYPT & WITHDRAW", note: "the amount is sealed in this browser first" }];

  const activeIndex = steps.findIndex((s) => s.key === step);

  if (!mounted) return null;

  return createPortal(
    <div className={styles.scrim} onClick={() => !busy && onClose()}>
      <div
        className={mode === "deposit" ? `${styles.sheet} yellowBand` : styles.sheet}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "deposit" ? "Deposit" : "Withdraw"}
      >
        <div className={styles.head}>
          <span>{mode === "deposit" ? "DEPOSIT INTO THE POOL" : "WITHDRAW YOUR PRINCIPAL"}</span>
          <button className={styles.close} onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <label className={styles.label} htmlFor="amount">
            AMOUNT
          </label>
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

          <div className={styles.chips}>
            {[0.25, 0.5, 1].map((frac) => (
              <button
                key={frac}
                className={styles.chip}
                disabled={busy || available === 0n}
                onClick={() => setRaw((Number((available * BigInt(Math.round(frac * 100))) / 100n) / Number(SCALE)).toString())}
              >
                {frac === 1 ? "MAX" : `${frac * 100}%`}
              </button>
            ))}
          </div>

          <div className={styles.source}>
            {mode === "deposit" ? "Wallet:" : "In pool:"} <strong>{formatUnits(available)}</strong>{" "}
            {mode === "deposit" ? "tUSDT" : "cUSDT"}
          </div>

          {tooMuch && <div className={styles.warn}>More than you hold. An oversized deposit would move nothing.</div>}

          {mode === "deposit" && (
            <div className={styles.privacy}>
              This route takes plain tokens, so <strong>this deposit&apos;s size is public</strong>. Everything after it
              — your position, your odds, your winnings — is encrypted. Already holding cUSDT? That path hides the
              amount too.
            </div>
          )}

          <ol className={styles.steps}>
            {steps.map((s, i) => {
              const done = step === "done" || (activeIndex >= 0 && i < activeIndex);
              const active = step === s.key;
              return (
                <li key={s.key} className={active ? styles.stepActive : done ? styles.stepDone : styles.step}>
                  <span className={styles.stepMark}>{done ? "OK" : active ? "···" : "—"}</span>
                  <span>
                    <strong>{s.label}</strong>
                    <span className={styles.stepNote}>{s.note}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          {error && <div className={styles.error}>{error}</div>}

          <button className={styles.submit} onClick={submit} disabled={!canSubmit}>
            {busy
              ? step === "approving"
                ? "Approving…"
                : step === "depositing"
                  ? "Depositing…"
                  : "Withdrawing…"
              : step === "done"
                ? "Done"
                : // A disabled button with a confident label reads as broken. Say what is
                  // missing instead, so the sheet looks like it is waiting, not stuck.
                  amount === 0n
                  ? "Enter an amount above"
                  : tooMuch
                    ? "More than you hold"
                    : mode === "deposit"
                      ? "Put it in the pot"
                      : "Take it back out"}
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
