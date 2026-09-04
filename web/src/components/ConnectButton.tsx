"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";

import { shortenAddress } from "@/lib/format";
import styles from "./ConnectButton.module.css";

/**
 * Opens Reown AppKit's connect modal.
 *
 * The modal itself is AppKit's - it detects installed browser wallets over EIP-6963 and
 * offers WalletConnect for phones, and it stays current as wallets come and go without us
 * maintaining a list. Only the trigger is ours, so the button still belongs to this
 * design; AppKit is themed to match in `providers.tsx`.
 *
 * Once connected, the same button opens the account view - network switching, balance and
 * disconnect all live there.
 */
export function ConnectButton({ variant = "header" }: { variant?: "header" | "hero" }) {
  const { open } = useAppKit();
  const { address, isConnected, isConnecting } = useAccount();

  const cls = variant === "hero" ? styles.hero : styles.header;

  return (
    <button
      className={cls}
      onClick={() => open({ view: isConnected ? "Account" : "Connect" })}
      disabled={isConnecting}
      title={isConnected ? "Account and network" : "Connect a wallet"}
    >
      {isConnecting ? "Connecting…" : isConnected ? shortenAddress(address) : "Connect wallet"}
    </button>
  );
}
