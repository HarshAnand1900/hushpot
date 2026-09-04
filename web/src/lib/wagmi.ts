import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { sepolia, type AppKitNetwork } from "@reown/appkit/networks";
import { http } from "wagmi";

import { CHAIN_ID } from "./contract";

/**
 * Wallet + RPC configuration, via Reown AppKit (formerly WalletConnect).
 *
 * AppKit supplies the connect modal, which detects installed browser wallets over
 * EIP-6963 and offers WalletConnect for phones - so one component covers extensions,
 * mobile and everything in between, and it stays current as wallets come and go without
 * us maintaining a list.
 *
 * A public RPC means no API key is needed to run this locally.
 */
export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "f0e5578180851413284be061ff7c7b8f";

// AppKit wants a guaranteed-non-empty tuple, not a plain array.
export const networks: [AppKitNetwork, ...AppKitNetwork[]] = [sepolia];

export const wagmiAdapter = new WagmiAdapter({
  projectId: WALLETCONNECT_PROJECT_ID,
  networks,
  transports: {
    [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
  },
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

export const EXPECTED_CHAIN_ID = CHAIN_ID;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
