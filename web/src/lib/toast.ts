"use client";

/**
 * A one-line way to tell someone what just happened.
 *
 * Fired as a window event rather than through a context provider: the things worth
 * announcing happen inside hooks and sheets that are mounted and unmounted constantly, and
 * threading a callback down to each of them would be more plumbing than the feature is
 * worth. `Toast` listens once, from the layout, and lives above everything.
 */
export type ToastKind = "success" | "error" | "pending";

export interface ToastPayload {
  kind: ToastKind;
  title: string;
  /** One short clause of context. Optional - many toasts do not need it. */
  detail?: string;
  /** A transaction hash, rendered as a link to Etherscan. */
  hash?: string;
  /** Milliseconds on screen. Errors stay until dismissed unless overridden. */
  ttl?: number;
}

export const TOAST_EVENT = "hushpot:toast";

export function toast(payload: ToastPayload) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

/**
 * Turn a thrown wallet or RPC error into something worth reading.
 *
 * Wallet errors arrive as paragraphs - a summary, a details block, a docs link, a version
 * string. Showing all of it in a toast is worse than showing none, and "Transaction
 * declined" is the only part most people need.
 */
export function describeError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);

  if (/user rejected|denied transaction|user denied/i.test(message)) return "You declined it in your wallet.";
  if (/insufficient funds/i.test(message)) return "Not enough Sepolia ETH for gas.";
  // Wallets fall back to an enormous limit when `eth_estimateGas` reverts, and the node
  // then refuses it. The surface error is about gas; the cause almost never is.
  if (/gas limit too high|exceeds block/i.test(message))
    return "The node rejected the gas limit, which usually means the call itself would revert.";

  // First line only: the rest is stack and documentation links.
  return message.split("\n")[0].slice(0, 120);
}
