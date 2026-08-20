"use client";

import { useState } from "react";
import { usePublicClient } from "wagmi";

import { POOL_ADDRESS, TOKEN_ADDRESS, poolAbi } from "@/lib/contract";
import styles from "./VerifyHandle.module.css";

type Result = { ok: boolean; lines: { k: string; v: string }[] };

/**
 * Resolve any ciphertext handle on this page against the chain.
 *
 * The point is the anticlimax. A handle is public, readable by anyone, and resolving it
 * tells you its type, its chain, and which slot holds it — and still not the number. That
 * is easier to believe once you have pasted one in yourself and watched it fail to open.
 */
export function VerifyHandle() {
  const publicClient = usePublicClient();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();

  const verify = async () => {
    if (!publicClient) return;
    const handle = raw.trim();
    setBusy(true);
    setResult(undefined);

    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(handle)) {
        setResult({
          ok: false,
          lines: [{ k: "MALFORMED", v: "A handle is 32 bytes — 0x followed by 64 hex characters." }],
        });
        return;
      }

      // The last bytes of an FHEVM handle carry its chain and type, in the clear.
      const chainHex = handle.slice(-10, -4);
      const typeHex = handle.slice(-4, -2);
      const types: Record<string, string> = { "00": "ebool", "05": "euint64", "04": "euint32", "03": "euint16" };

      // Which slot, if any, currently holds it — a public mapping, not a decryption.
      const slots = Number(
        await publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "slotsUsed" }),
      );
      let owner = "not a cached balance handle on this pool";

      for (let s = 0; s < slots; s++) {
        const h = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "balanceHandle",
          args: [s],
        })) as string;
        if (h.toLowerCase() === handle.toLowerCase()) {
          const who = (await publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "slotOwner",
            args: [s],
          })) as string;
          owner = `slot ${s} · ${who}`;
          break;
        }
      }

      setResult({
        ok: true,
        lines: [
          { k: "TYPE", v: types[typeHex] ?? `unknown (0x${typeHex})` },
          { k: "CHAIN", v: parseInt(chainHex, 16) === 11155111 ? "Sepolia · 11155111" : `0x${chainHex}` },
          { k: "HELD BY", v: owner },
          { k: "VALUE", v: "UNREADABLE — no decryption right, and none is obtainable" },
        ],
      });
    } catch (e) {
      setResult({
        ok: false,
        lines: [{ k: "FAILED", v: e instanceof Error ? e.message.slice(0, 140) : "read failed" }],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panelHead">
        <span>VERIFY A HANDLE YOURSELF</span>
        <span>READ-ONLY CALL</span>
      </div>

      <div className={styles.body}>
        <p className={styles.copy}>
          Paste any ciphertext handle from this page. It is resolved against contract state and you get back exactly
          what the chain holds — which is still nothing you can read. No wallet, no signature, no server.
        </p>

        <div className={styles.row}>
          <input
            className={styles.input}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            aria-label="Ciphertext handle"
          />
          <button className="btnOutlineYellow" onClick={verify} disabled={busy || raw.trim().length === 0}>
            {busy ? "Resolving…" : "Verify"}
          </button>
        </div>

        {result && (
          <div className={result.ok ? styles.out : `${styles.out} ${styles.outBad}`}>
            {result.lines.map((l) => (
              <div key={l.k} className={styles.outRow}>
                <span className={styles.outKey}>{l.k}</span>
                <span className={styles.outVal}>{l.v}</span>
              </div>
            ))}
          </div>
        )}

        <div className={styles.note}>
          Handles are public by design. Reading one is not the same as reading the number inside it, and the difference
          is the entire product. Contract {POOL_ADDRESS.slice(0, 10)}… · token {TOKEN_ADDRESS.slice(0, 10)}…
        </div>
      </div>
    </section>
  );
}
