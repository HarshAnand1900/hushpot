import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The contracts package one level up has its own lockfile; pin the root so Next stops
  // guessing which one owns this app.
  outputFileTracingRoot: __dirname,

  // The relayer SDK ships ESM + WASM and needs transpiling for the client bundle.
  transpilePackages: ["@zama-fhe/relayer-sdk"],

  webpack: (config) => {
    // The SDK pulls in node built-ins that don't exist in the browser.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    // FHE key material is loaded as WebAssembly.
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      topLevelAwait: true,
    };
    return config;
  },
};

export default nextConfig;
