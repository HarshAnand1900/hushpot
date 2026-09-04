"use client";

import { POOL_ADDRESS, TOKEN_ADDRESS } from "./contract";

/**
 * Contracts this session can decrypt for.
 *
 * The pool holds your position; the confidential token holds your wallet balance. Both
 * have to be named when the session is signed — an EIP-712 grant is scoped to a fixed
 * list, so a handle from a contract missing here is refused however clearly you own it.
 */
const SESSION_CONTRACTS: string[] = [POOL_ADDRESS, TOKEN_ADDRESS];

const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * The relayer SDK, and the session that makes decryption bearable.
 *
 * Reading one of your own encrypted values normally costs a typed-data signature plus a
 * relayer round trip — seconds, and a wallet popup. Doing that per value, per glance,
 * would make the app feel broken.
 *
 * So a session is opened once: one keypair, one signature, valid for seven days, cached in
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
  /** Exactly what the signature authorises. A session is only valid for these. */
  contracts: string[];
}

let session: DecryptSession | null = null;

/**
 * Where a session survives a reload.
 *
 * `localStorage`, so it outlives the tab. The reasoning: the EIP-712 grant you sign is
 * already valid for seven days — that is the permission you gave. Throwing the session
 * away when the tab closes did not shorten that grant, it just made you re-sign to use
 * the days you had already authorised. One signature a week rather than one per tab.
 *
 * The trade this makes, stated plainly: the keypair now sits on disk for the week. It is
 * generated in the browser and never leaves it, and it only decrypts handles you already
 * own — but anyone with access to your machine and your browser profile could open your
 * balance without your wallet. On a shared computer, use the LOCK AGAIN control on
 * YOUR POSITION, which clears it immediately.
 */
/**
 * Keyed by the contracts the signature actually names.
 *
 * An EIP-712 decrypt grant is bound to a fixed list of contracts. Persisting a session
 * therefore has a failure mode holding it in memory never had: redeploy the pool, and a
 * stored signature still names the *old* address, so every decrypt is refused for handles
 * the user plainly owns. Folding the addresses into the key retires that session the
 * moment the deployment moves, instead of leaving it to fail confusingly.
 */
const STORE_KEY = `hushpot.session.${POOL_ADDRESS.slice(2, 10)}.${TOKEN_ADDRESS.slice(2, 10)}`;

function persist(s: DecryptSession | null) {
  try {
    if (!s) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode, or storage disabled — the session simply stays in memory */
  }
}

function restore(): DecryptSession | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;

    const s = JSON.parse(raw) as DecryptSession;

    const expiresAt = (s.startTimestamp + s.durationDays * 86_400) * 1000;
    // A signature authorises a fixed set of contracts. If that set has moved — a redeploy,
    // or a contract added to the list — the stored one cannot speak for the new one, and
    // reusing it fails as "not authorized" for handles the user demonstrably owns.
    const covers =
      Array.isArray(s.contracts) &&
      s.contracts.length === SESSION_CONTRACTS.length &&
      SESSION_CONTRACTS.every((c) => s.contracts.some((h) => h.toLowerCase() === c.toLowerCase()));

    if (Date.now() >= expiresAt || !covers) {
      localStorage.removeItem(STORE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** Drop any session stored under a previous deployment's key. */
function sweepStaleSessions() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith("hushpot.session.") && key !== STORE_KEY) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable — nothing was stored to go stale */
  }
}

/**
 * The stored session, optionally checked against who is connected now.
 *
 * The `user` argument is not decoration. An EIP-712 decrypt grant authorises one address,
 * and callers that only asked "is there a session?" would happily reuse the previous
 * account's grant after a wallet switch — the relayer then refuses with "not authorized to
 * user decrypt handle", naming an address the user is no longer using. Persisting sessions
 * across tabs made that a routine occurrence rather than a rare one.
 */
export function currentSession(user?: string): DecryptSession | null {
  if (!session && typeof window !== "undefined") {
    sweepStaleSessions();
    session = restore();
  }

  // A grant belongs to one address. Handing the previous account's session to a newly
  // connected wallet is how you get "not authorized to user decrypt handle" naming an
  // address the person is not even using any more.
  if (user && session && session.user.toLowerCase() !== user.toLowerCase()) return null;

  return session;
}

export function clearSession() {
  session = null;
  persist(null);
}

/**
 * Open a decryption session. One wallet signature, good for seven days.
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
  const existing = currentSession(user);
  if (existing) return existing;

  const fhevm = await getFhevm();
  const { publicKey, privateKey } = fhevm.generateKeypair();

  // Timestamps must be numbers here, not strings — the SDK is strict about it.
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 7;

  const eip712 = fhevm.createEIP712(publicKey, SESSION_CONTRACTS, startTimestamp, durationDays);

  const signature = await signTypedDataAsync({
    domain: eip712.domain as Record<string, unknown>,
    types: { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification } as Record<string, unknown>,
    primaryType: "UserDecryptRequestVerification",
    message: eip712.message as Record<string, unknown>,
  });

  session = { privateKey, publicKey, signature, startTimestamp, durationDays, user, contracts: SESSION_CONTRACTS };
  persist(session);
  return session;
}

/**
 * Publicly decrypt a handle, waiting out the propagation lag.
 *
 * `makePubliclyDecryptable` is an on-chain grant like any other, and the relayer checks it
 * against its own view of the chain. Ask the instant the transaction lands and you can be
 * told the handle "is not allowed for public decryption" when it demonstrably is — the
 * same race that made user decryption fail, wearing a different error message.
 *
 * Needs no session: a public decryption is public, and a solvency proof only its operator
 * could read would defeat the point of publishing it.
 */
export async function publicDecryptRetry(handles: string[]) {
  const fhevm = await getFhevm();
  let lastError: unknown;

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));

    try {
      return await fhevm.publicDecrypt(handles);
    } catch (e) {
      lastError = e;
      const message = e instanceof Error ? e.message : String(e);
      // Only a missing grant is worth waiting out. Anything else fails immediately.
      if (!/not allowed|not authorized|unauthorized/i.test(message)) throw e;
    }
  }

  throw lastError;
}

/**
 * Decrypt one of your own ciphertext handles using the open session.
 * Returns undefined for an uninitialised handle — an empty slot, not an error.
 */
export async function decryptHandle(handle: string, contract: string = POOL_ADDRESS): Promise<bigint | undefined> {
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
        [{ handle, contractAddress: contract }],
        session.privateKey,
        session.publicKey,
        session.signature.replace(/^0x/, ""),
        SESSION_CONTRACTS,
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
