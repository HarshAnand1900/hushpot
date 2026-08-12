"use client";

import { POOL_ADDRESS } from "./contract";

const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * The relayer SDK, and the session that makes decryption bearable.
 *
 * Reading one of your own encrypted values normally costs a typed-data signature plus a
 * relayer round trip — seconds, and a wallet popup. Doing that per value, per glance,
 * would make the app feel broken.
 *
 * So a session is opened once: one keypair, one signature, valid for a day, cached in
 * memory. Every subsequent decrypt reuses it and just costs a fetch. Sign once per visit.
 *
 * The keypair is generated in the browser and never leaves it. The relayer returns values
 * re-encrypted to that public key, so nothing readable crosses the wire.
 */

// The SDK is ESM + WASM and touches `window`, so it is imported lazily on first use.
type FhevmInstance = Awaited<ReturnType<typeof createInstanceLazy>>;

let instancePromise: Promise<FhevmInstance> | null = null;

async function createInstanceLazy() {
  const { initSDK, createInstance, SepoliaConfig } = await import("@zama-fhe/relayer-sdk/web");

  // Loads the FHE WASM. Required before an instance can be built in the browser.
  await initSDK();

  // Must be the EIP-1193 provider itself, not a wagmi wallet client — or an RPC URL.
  type Network = Parameters<typeof createInstance>[0]["network"];
  const ethereum = (window as unknown as { ethereum?: Network }).ethereum;

  // Fall back to a plain RPC when there is no wallet. Public decryption — the solvency
  // proof, the pool total — needs no signature, and a proof only a connected wallet can
  // read would defeat the purpose of publishing it.
  const network: Network = ethereum ?? (PUBLIC_RPC as Network);

  // The base Sepolia config targets the correct relayer; the versioned variants don't.
  return createInstance({ ...SepoliaConfig, network });
}

export function getFhevm(): Promise<FhevmInstance> {
  if (!instancePromise) instancePromise = createInstanceLazy();
  return instancePromise;
}

/** Warm the WASM up ahead of time, so the first reveal isn't the slow one. */
export function preloadFhevm() {
  void getFhevm().catch(() => {
    /* surfaced when the user actually asks to decrypt */
  });
}

/**
 * `encrypt()` hands back `Uint8Array` for both the handles and the proof, but viem wants
 * `0x`-prefixed hex for `bytes32` and `bytes` arguments. Passing the raw array through
 * fails deep inside viem with "e.replace is not a function", which is a miserable thing
 * to debug — so convert at the boundary, always.
 */
export function toHex(value: Uint8Array | string): `0x${string}` {
  if (typeof value === "string") return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
  return `0x${Array.from(value)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
}

export interface DecryptSession {
  privateKey: string;
  publicKey: string;
  signature: string;
  startTimestamp: number;
  durationDays: number;
  user: `0x${string}`;
}

let session: DecryptSession | null = null;

export function currentSession(): DecryptSession | null {
  return session;
}

export function clearSession() {
  session = null;
}

/**
 * Open a decryption session. One wallet signature, good for a day.
 *
 * `signTypedDataAsync` comes from wagmi so the wallet stays the single source of truth
 * for signing.
 */
export async function openSession(
  user: `0x${string}`,
  signTypedDataAsync: (args: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>,
): Promise<DecryptSession> {
  if (session && session.user.toLowerCase() === user.toLowerCase()) return session;

  const fhevm = await getFhevm();
  const { publicKey, privateKey } = fhevm.generateKeypair();

  // Timestamps must be numbers here, not strings — the SDK is strict about it.
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;

  const eip712 = fhevm.createEIP712(publicKey, [POOL_ADDRESS], startTimestamp, durationDays);

  const signature = await signTypedDataAsync({
    domain: eip712.domain as Record<string, unknown>,
    types: { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification } as Record<string, unknown>,
    primaryType: "UserDecryptRequestVerification",
    message: eip712.message as Record<string, unknown>,
  });

  session = { privateKey, publicKey, signature, startTimestamp, durationDays, user };
  return session;
}

/**
 * Decrypt one of your own ciphertext handles using the open session.
 * Returns undefined for an uninitialised handle — an empty slot, not an error.
 */
export async function decryptHandle(handle: string): Promise<bigint | undefined> {
  if (!session) throw new Error("No decryption session open.");
  if (!handle || /^0x0+$/.test(handle)) return undefined;

  const fhevm = await getFhevm();

  // The grant and the decryption race each other.
  //
  // `refreshMyPosition` calls `FHE.allow` on a ciphertext it has just produced, and the
  // relayer checks that grant against its own view of the chain. Confirming the receipt
  // on one RPC node says nothing about whether the node the relayer reads has caught up,
  // so a decryption fired the instant the transaction lands can be told the account is
  // not authorised for a handle it demonstrably owns.
  //
  // Verified against the ACL on Sepolia: `persistAllowed(handle, account)` returns true
  // for exactly the handles that fail this way. So it is propagation, not permission —
  // waiting and asking again is the fix, and there is nothing to correct on-chain.
  let lastError: unknown;

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));

    try {
      const result = await fhevm.userDecrypt(
        [{ handle, contractAddress: POOL_ADDRESS }],
        session.privateKey,
        session.publicKey,
        session.signature.replace(/^0x/, ""),
        [POOL_ADDRESS],
        session.user,
        session.startTimestamp,
        session.durationDays,
      );

      // Keyed by handle; there is only ever one entry here.
      const value = Object.values(result)[0];
      return typeof value === "bigint" ? value : BigInt(value as string | number);
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      // Only a missing grant is worth waiting out. Anything else fails immediately.
      if (!/not authorized|unauthorized/i.test(message)) throw e;
    }
  }

  throw lastError;
}
