"use client";

import { createAppKit } from "@reown/appkit/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { WALLETCONNECT_PROJECT_ID, networks, wagmiAdapter, wagmiConfig } from "@/lib/wagmi";

/**
 * AppKit is created once at module scope, not inside the component — calling it per
 * render would register the modal repeatedly.
 *
 * Themed to match: black surfaces, the one yellow accent, and square corners, so the
 * connect modal does not arrive looking like it came from somewhere else.
 */
createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId: WALLETCONNECT_PROJECT_ID,
  defaultNetwork: networks[0],
  metadata: {
    name: "Hushpot",
    description: "A no-loss prize pool where nobody learns who won.",
    url: "https://hushpot-fhevm.vercel.app",
    icons: [],
  },
  features: {
    analytics: false,
    // Email and social sign-in create custodial-ish accounts, which sits badly with a
    // product whose whole claim is that nobody else holds your keys.
    email: false,
    socials: false,
  },
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#FFD208",
    "--w3m-color-mix": "#000000",
    "--w3m-color-mix-strength": 20,
    "--w3m-border-radius-master": "0px",
    "--w3m-font-family": "var(--font-grotesk), system-ui, sans-serif",
  },
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain state changes on a block cadence; polling harder just burns RPC.
            staleTime: 10_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
