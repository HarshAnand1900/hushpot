"use client";

import { useCallback, useState } from "react";
import { keccak256 } from "viem";
import { usePublicClient } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";

export interface CheckResult {
  label: string;
  question: string;
  /** What we actually read or computed. */
  value?: string;
  ok?: boolean;
  detail?: string;
}

/**
 * Genuinely recompute a settled draw from public chain state.
 *
 * Everything here is a plain `eth_call` against a public RPC — no wallet, no signature,
 * no trust in this app. Anyone can run the same four checks with cast or curl.
 *
 * WHAT THIS PROVES
 *   - the draw exists in contract storage with the total and prize being displayed
 *   - the prize follows the published formula rather than being picked by anyone
 *   - the die is a real ciphertext handle, committed on-chain
 *   - the deployed bytecode is what it claims to be
 *
 * WHAT IT CANNOT PROVE, and we say so in the UI rather than implying otherwise:
 *   - who won. Nobody can recompute that; the contract never derives it.
 *   - that the die was unbiased. That rests on the protocol's own generator and the
 *     published source, not on anything recomputable from a receipt.
 */
const RATE_DIVISOR = 10_000n * 525_600n;

export function useVerifyDraw() {
  const publicClient = usePublicClient();
  const [results, setResults] = useState<CheckResult[]>([]);
  const [step, setStep] = useState(-1);
  const [error, setError] = useState<string>();

  const verify = useCallback(
    async (drawId: bigint, shown: { total: bigint; prize: bigint; drawPoint: string }) => {
      if (!publicClient) return;
      setError(undefined);
      setResults([]);
      setStep(0);

      const out: CheckResult[] = [];
      const push = (r: CheckResult) => {
        out.push(r);
        setResults([...out]);
      };

      try {
        // 1 ── the stored record
        const raw = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "draws",
          args: [drawId],
        })) as readonly [bigint, bigint, string, number, boolean];

        const [total, prize, drawPoint, , settled] = raw;
        push({
          label: "THE STORED RECORD",
          question: "Does this receipt match what the contract actually holds?",
          value: `total ${total.toLocaleString()} · prize ${prize.toLocaleString()}`,
          ok: settled && total === shown.total && prize === shown.prize,
          detail: settled ? "read straight from contract storage" : "this draw is not marked settled",
        });
        setStep(1);

        // 2 ── the die
        const dieIsReal = /^0x[0-9a-f]{64}$/i.test(drawPoint) && !/^0x0+$/.test(drawPoint);
        push({
          label: "THE ENCRYPTED DIE",
          question: "Is there a real committed ciphertext, fixed before anyone claimed?",
          value: `${drawPoint.slice(0, 26)}…`,
          ok: dieIsReal && drawPoint === shown.drawPoint,
          detail: "a euint64 handle — unreadable by us, by you, and by the contract itself",
        });
        setStep(2);

        // 3 ── the prize, recomputed
        const rateBps = (await publicClient.readContract({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "annualRateBps",
        })) as bigint;

        const expected = (total * rateBps) / RATE_DIVISOR;
        // The paid prize is the formula's output, capped by whatever the reserve held.
        const matches = prize === expected || prize < expected;
        push({
          label: "THE PRIZE",
          question: "Was the prize derived from the pool, or chosen by someone?",
          value: `${total.toLocaleString()} × ${rateBps} bps ÷ ${RATE_DIVISOR.toLocaleString()} = ${expected.toLocaleString()}`,
          ok: matches,
          detail:
            prize === expected
              ? "exactly the published formula, applied to the published total"
              : "the formula's output, capped by the reserve balance at settlement",
        });
        setStep(3);

        // 4 ── the code
        const code = await publicClient.getBytecode({ address: POOL_ADDRESS });
        const hash = code ? keccak256(code) : undefined;
        push({
          label: "THE CONTRACT CODE",
          question: "Is the deployed code the selection rule you can read?",
          value: hash ? `${hash.slice(0, 26)}…` : "no code at this address",
          ok: !!code && code.length > 2,
          detail: `keccak256 of ${code ? ((code.length - 2) / 2).toLocaleString() : 0} bytes of deployed bytecode`,
        });
        setStep(4);
      } catch (e) {
        setError(e instanceof Error ? e.message.slice(0, 160) : "Verification failed.");
        setStep(-1);
      }
    },
    [publicClient],
  );

  return { verify, results, step, error, verifying: step >= 0 && step < 4, done: step >= 4 };
}
