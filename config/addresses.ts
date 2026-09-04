/**
 * Known deployments Hushpot builds on.
 *
 * The Sepolia entries are Zama's official Developer Program mock tokens, reused here
 * rather than deploying our own so that anyone who took part in an earlier season already
 * holds the token - including the judges. The underlying has an open `mint`, so it doubles
 * as the faucet and no separate faucet contract is needed.
 *
 * All values below were read directly from Sepolia on 8 August 2026, not copied from
 * documentation. Re-verify before deploying; testnet mocks do occasionally get replaced.
 */

export interface NetworkAddresses {
  /** ERC-7984 confidential token the pool accepts. */
  confidentialToken: string;
  /** Plain ERC-20 behind it. The pool shields this automatically on deposit. */
  underlyingToken: string;
  /** Zama's wrapper registry, for the frontend's token picker. */
  wrapperRegistry?: string;
}

export const SEPOLIA: NetworkAddresses = {
  // "Confidential USDT (Mock)" · cUSDTMock · 6 decimals · rate 1
  // An OpenZeppelin ERC7984ERC20Wrapper behind an ERC-1967 proxy.
  confidentialToken: "0x4E7B06D78965594eB5EF5414c357ca21E1554491",

  // "Tether USD (Mock)" · USDTMock · 6 decimals · open public mint(), so it is the faucet
  underlyingToken: "0xa7dA08FafDC9097Cc0E7D4f113A61e31d7e8e9b0",

  wrapperRegistry: "0x2f0750Bbb0A246059d80e94c454586a7F27a128e",
};

export const ADDRESSES: Record<number, NetworkAddresses> = {
  11155111: SEPOLIA,
};

export function addressesFor(chainId: number): NetworkAddresses | undefined {
  return ADDRESSES[chainId];
}
