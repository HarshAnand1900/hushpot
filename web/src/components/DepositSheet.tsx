"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount, useConfig, usePublicClient, useReadContract, useSignTypedData, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { useDeposit } from "@/hooks/useDeposit";
import { TOKEN_ADDRESS, TOKEN_DECIMALS, UNDERLYING_ADDRESS, confidentialTokenAbi, erc20Abi } from "@/lib/contract";
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
  lockMode = false,
}: {
  mode: Mode;
  onClose: () => void;
  onDone: () => void;
  inPool?: bigint;
  drawNumber?: number;
  /** Hide the other tab. Used by the "take your shot" entry, which is only ever a way in. */
  lockMode?: boolean;
}) {
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const { step, error, deposit, depositConfidential, withdraw, reset, busy } = useDeposit();

  /**
   * Which token funds the deposit, and it is a privacy decision rather than a preference.
   * Plain tUSDT is one approval and one call, but the amount rides in a plain ERC-20
   * transfer and is public forever. cUSDT costs an operator grant the first time and
   * leaves nothing in the clear.
   */
  const [route, setRoute] = useState<"plain" | "confidential">("plain");

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
   * Your cUSDT balance, once you ask for it.
   *
   * Left sealed by default rather than decrypted on open: a confidential balance is
   * private from the page as much as from the chain, and reading it costs a relayer round
   * trip. Asking is one click, and the answer never leaves the browser.
   */
  const [shielded, setShielded] = useState<bigint>();
  const [revealing, setRevealing] = useState(false);

  const revealShielded = async () => {
    if (!address) return;
    setRevealing(true);
    try {
      const { currentSession, openSession, decryptHandle } = await import("@/lib/fhe");
      if (!currentSession()) await openSession(address, signTypedDataAsync as never);

      const handle = (await publicClient?.readContract({
        address: TOKEN_ADDRESS,
        abi: confidentialTokenAbi,
        functionName: "confidentialBalanceOf",
        args: [address],
      })) as string | undefined;

      if (handle) setShielded((await decryptHandle(handle, TOKEN_ADDRESS)) ?? 0n);
    } catch {
      /* a declined signature is not worth an error banner here */
    } finally {
      setRevealing(false);
    }
  };

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

  // A confidential balance is a ciphertext, so there is no figure to show and no Max to
  // offer. Comparing the requested amount against the *plain* balance would be worse than
  // useless here — it is a different token.
  const balanceKnown = mode === "withdraw" || route === "plain";
  const available = mode === "deposit" ? ((walletBalance as bigint | undefined) ?? 0n) : (inPool ?? 0n);

  const amount = useMemo(() => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * Number(SCALE)));
  }, [raw]);

  const tooMuch = balanceKnown && amount > available;
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
    if (mode === "withdraw") {
      void withdraw(amount);
      return;
    }
    void (route === "confidential" ? depositConfidential(amount) : deposit(amount));
  };

  const steps =
    mode === "deposit"
      ? route === "confidential"
        ? [
            { key: "approving", label: "Authorise the pool", note: "one-time operator grant on your cUSDT" },
            { key: "encrypting", label: "Encrypt the amount", note: "client-side, before broadcast" },
            { key: "depositing", label: "Submit ciphertext", note: "the size never appears in the clear" },
          ]
        : [
            { key: "approving", label: "Approve tUSDT", note: "one-time, lets the pool pull tokens" },
            { key: "encrypting", label: "Shield into cUSDT", note: "wrapped by the pool on arrival" },
            { key: "depositing", label: "Credit your slot", note: "the position is encrypted from here on" },
          ]
      : [
          { key: "encrypting", label: "Encrypt the amount", note: "sealed in this browser first" },
          { key: "withdrawing", label: "Receive cUSDT", note: "your principal back in full, still encrypted" },
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
            {(lockMode ? ([initialMode] as Mode[]) : (["deposit", "withdraw"] as Mode[])).map((m) => (
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
                {!balanceKnown ? (
                  shielded !== undefined ? (
                    <>
                      Wallet: <strong>{formatUnits(shielded)}</strong>
                    </>
                  ) : (
                    <>
                      Wallet: <strong>encrypted</strong>{" "}
                      <button className={styles.reveal} onClick={revealShielded} disabled={revealing || busy}>
                        {revealing ? "opening…" : "reveal"}
                      </button>
                    </>
                  )
                ) : (
                  <>
                    {mode === "deposit" ? "Wallet:" : "In pool:"} <strong>{formatUnits(available)}</strong>
                  </>
                )}
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
                disabled={busy || !balanceKnown || available === 0n}
                title={!balanceKnown ? "Your confidential balance is a ciphertext — there is no figure to fill in" : undefined}
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
                  disabled={busy || (balanceKnown && BigInt(q) * SCALE > available)}
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

          {/* which token, which is a privacy choice ----------------------- */}
          {mode === "deposit" && (
            <div className={styles.routes} role="radiogroup" aria-label="Deposit route">
              {(
                [
                  { key: "plain", title: "Plain tUSDT", sub: "Shielded for you · size public" },
                  { key: "confidential", title: "cUSDT", sub: "Goes straight in · size hidden" },
                ] as const
              ).map((r) => (
                <button
                  key={r.key}
                  role="radio"
                  aria-checked={route === r.key}
                  className={route === r.key ? `${styles.route} ${styles.routeOn}` : styles.route}
                  onClick={() => !busy && setRoute(r.key)}
                  disabled={busy}
                >
                  <span className={styles.routeTitle}>{r.title}</span>
                  <span className={styles.routeSub}>{r.sub}</span>
                </button>
              ))}
            </div>
          )}

          {/* what this actually does -------------------------------------- */}
          <div className={styles.note}>
            <span className={styles.noteMark} aria-hidden="true" />
            {mode === "deposit" && route === "confidential" ? (
              <span>
                Nothing but a ciphertext leaves this browser. The chain will record that you deposited, and when — but
                not how much, not now and not ever. Asking for more cUSDT than you hold moves nothing rather than
                failing, so check the figure: a confidential transfer cannot revert on a balance it is not allowed to
                read.
              </span>
            ) : mode === "deposit" ? (
              <span>
                This starts earning odds the moment it lands — no waiting for the draw boundary. Odds are weighted by
                amount and by how long it sits, so the earlier it arrives the more of
                {drawNumber !== undefined ? ` draw #${drawNumber}` : " this draw"} it earns. Deposit once and you are in
                every draw until you withdraw.
              </span>
            ) : (
              <span>
                Your principal was never at risk and comes back in full, as <strong>cUSDT</strong> — still encrypted.
                Unwrapping it to plain tUSDT would publish the amount, so that stays your decision rather than ours.
                Withdrawing keeps the odds this money already earned for the current draw; you only stop earning from
                now on.
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

          {mode === "deposit" && route === "plain" && available === 0n && (
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
