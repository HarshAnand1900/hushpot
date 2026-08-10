"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

import { shortenAddress } from "@/lib/format";
import styles from "./ConnectButton.module.css";

/**
 * Wallet connection, in our own styling.
 *
 * Two routes in: browser wallets found over EIP-6963 (MetaMask, Rabby, Brave and so on,
 * discovered without configuration) and WalletConnect for mobile or anything without an
 * extension. Rendering the picker ourselves rather than pulling in RainbowKit keeps the
 * design intact and avoids a large dependency for what is essentially a list.
 */
export function ConnectButton({ variant = "header" }: { variant?: "header" | "hero" }) {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cls = variant === "hero" ? styles.hero : styles.header;

  if (isConnected) {
    return (
      <button className={cls} onClick={() => disconnect()} title="Disconnect">
        {shortenAddress(address)}
      </button>
    );
  }

  // Discovered browser wallets first — that is what most people on desktop want — with
  // WalletConnect after, rather than whatever order wagmi happens to return.
  const injected = connectors.filter((c) => c.type === "injected" || c.id !== "walletConnect");
  const walletConnect = connectors.filter((c) => c.id === "walletConnect");
  const ordered = [...injected, ...walletConnect];

  return (
    <>
      <button className={cls} onClick={() => setOpen(true)} disabled={isPending}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>

      {open && (
        <div className={styles.scrim} onClick={() => setOpen(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className={styles.head}>
              <span>CONNECT A WALLET</span>
              <button className={styles.close} onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>

            <div className={styles.list}>
              {ordered.length === 0 && (
                <div className={styles.empty}>
                  No wallet found. Install MetaMask, or use WalletConnect from a phone.
                </div>
              )}

              {ordered.map((connector) => (
                <button
                  key={connector.uid}
                  className={styles.option}
                  onClick={() => connect({ connector })}
                  disabled={isPending}
                >
                  <span className={styles.optionName}>{connector.name}</span>
                  <span className={styles.optionKind}>
                    {connector.id === "walletConnect" ? "scan from a phone" : "browser extension"}
                  </span>
                </button>
              ))}
            </div>

            {error && <div className={styles.error}>{error.message.slice(0, 140)}</div>}

            <div className={styles.foot}>Hushpot runs on Sepolia. Nothing here touches mainnet funds.</div>
          </div>
        </div>
      )}
    </>
  );
}
