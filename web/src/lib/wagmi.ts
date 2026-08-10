import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { walletConnect } from "wagmi/connectors";

import { CHAIN_ID } from "./contract";

/**
 * Wallet + RPC configuration.
 *
 * Two ways in:
 *   - EIP-6963 discovery, which finds every installed browser wallet automatically and
 *     needs no configuration at all.
 *   - WalletConnect, so mobile wallets and anything without an extension can join.
 *
 * No RainbowKit. Its modal would sit awkwardly inside this design, so the wallet list is
 * rendered in our own styling — the connectors below are all it would have given us.
 *
 * Note `next.config.ts` stubs `@x402/svm`: importing anything from `wagmi/connectors`
 * pulls in Coinbase's connector, which depends on an unpublished package.
 *
 * A public RPC means no API key is needed to run this locally.
 */
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "f0e5578180851413284be061ff7c7b8f";

export const wagmiConfig = createConfig({
  chains: [sepolia],
  multiInjectedProviderDiscovery: true,
  connectors: [
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name: "Hushpot",
        description: "A no-loss prize pool where nobody learns who won.",
        url: "https://hushpot.vercel.app",
        icons: [],
      },
    }),
  ],
  transports: {
    [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
  },
  ssr: true,
});

export const EXPECTED_CHAIN_ID = CHAIN_ID;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
