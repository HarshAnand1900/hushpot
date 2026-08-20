import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The contracts package one level up has its own lockfile; pin the root so Next stops
  // guessing which one owns this app.
  outputFileTracingRoot: __dirname,

  // The relayer SDK ships ESM + WASM and needs transpiling for the client bundle.
  transpilePackages: ["@zama-fhe/relayer-sdk"],

  // The panel used to live at /operator and that URL is already in the wild — in an
  // earlier README, and anywhere it was copied from. A 404 on a judge-facing link is
  // the cheapest possible way to lose marks, so the old path keeps working.
  async redirects() {
    return [{ source: "/operator", destination: "/judge", permanent: true }];
  },

  webpack: (config, { webpack }) => {
    // `@wagmi/connectors` re-exports Coinbase's baseAccount connector, which reaches
    // @coinbase/cdp-sdk → @x402/* — packages that aren't published. We never use that
    // connector, but importing anything from the barrel drags it in and fails the build.
    // Ignoring the namespace is safer than aliasing each one as they surface.
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));

    // MetaMask's SDK optionally imports React Native storage, which obviously isn't
    // present in a browser build. Harmless, but it warns on every compile.
    config.plugins.push(
      new webpack.IgnorePlugin({ resourceRegExp: /^@react-native-async-storage\/async-storage$/ }),
      new webpack.IgnorePlugin({ resourceRegExp: /^pino-pretty$/ }),
    );

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
