import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";

import { CHAIN_ID } from "./contract";

/**
 * Wallet + RPC configuration.
 *
 * No connectors are declared on purpose. wagmi discovers installed wallets over EIP-6963,
 * which finds MetaMask and friends without importing `wagmi/connectors` — that barrel
 * pulls in Coinbase's SDK and its broken optional dependencies, which fails the build.
 *
 * Discovery also suits the design better: a third-party connect modal would sit awkwardly
 * inside this one, so the wallet list is rendered in our own styling.
 *
 * A public RPC means no API key is needed to run this locally.
 */
export const wagmiConfig = createConfig({
  chains: [sepolia],
  multiInjectedProviderDiscovery: true,
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
