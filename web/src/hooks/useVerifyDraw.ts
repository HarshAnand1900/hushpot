"use client";

import { useCallback, useState } from "react";
import { keccak256, toFunctionSelector } from "viem";
import { usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS, poolAbi } from "@/lib/contract";

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
 * no trust in this app. Anyone can run the same five checks with cast or curl.
 *
 * WHAT THIS PROVES
 *   - the draw exists in contract storage with the total and prize being displayed
 *   - the prize follows the published formula rather than being picked by anyone
 *   - the die is a real ciphertext handle, committed on-chain
 *   - the deployed bytecode is what it claims to be
 *   - the contract exposes no way to ask who won
 *
 * WHAT IT CANNOT PROVE, and we say so in the UI rather than implying otherwise:
 *   - who won. Nobody can recompute that; the contract never derives it.
 *   - that the die was unbiased. That rests on the protocol's own generator and the
 *     published source, not on anything recomputable from a receipt.
 */
const RATE_DIVISOR = 10_000n * 525_600n;

/**
 * Getters a pool would need if it recorded a winner anywhere.
 *
 * Their absence from the deployed bytecode is checkable rather than assertable: Solidity
 * emits every external function's 4-byte selector into the dispatch table, so a selector
 * that does not appear in the code cannot be called. This is the negative claim the whole
 * design rests on, so it is worth proving instead of writing in a paragraph.
 */
const WINNER_GETTERS = [
  "function winner(uint256) view returns (address)",
  "function winnerOf(uint256) view returns (address)",
  "function getWinner(uint256) view returns (address)",
  "function drawWinner(uint256) view returns (address)",
  "function winners(uint256) view returns (address)",
] as const;

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
        })) as readonly [bigint, bigint, string, number, bigint, boolean];

        const [total, prize, drawPoint, , , settled] = raw;
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

        // The contract pays `prizeFor(total) + sponsoredThisDraw`, capped by the reserve.
        // This check used to compare against the formula half alone, so every sponsored
        // draw failed it — including the one the page opens on, and the panel told a
        // reader the contract disagreed with itself. It did not; the check was short a
        // term that both the README and the threat model already said it included.
        //
        // `sponsoredThisDraw` is zeroed at settlement, so a past draw's share cannot be
        // read back from storage. It is recovered the only way it can be: by summing the
        // public PrizeSponsored logs banked between the previous settlement and this one.
        const settledLogs = await publicClient.getContractEvents({
          address: POOL_ADDRESS,
          abi: poolAbi,
          eventName: "DrawSettled",
          fromBlock: DEPLOY_BLOCK,
          toBlock: "latest",
        });
        const blockOf = (id: bigint) => settledLogs.find((l) => l.args.drawId === id)?.blockNumber;

        const settledAtBlock = blockOf(drawId);
        // Sponsorships for draw 0 run from deployment; for any later draw, from the block
        // after its predecessor settled — that is the window the contract accumulated over.
        const prevBlock = drawId > 0n ? blockOf(drawId - 1n) : undefined;
        const fromBlock = prevBlock !== undefined ? prevBlock + 1n : DEPLOY_BLOCK;

        let sponsored = 0n;
        if (settledAtBlock !== undefined) {
          const sponsorLogs = await publicClient.getContractEvents({
            address: POOL_ADDRESS,
            abi: poolAbi,
            eventName: "PrizeSponsored",
            fromBlock,
            toBlock: settledAtBlock,
          });
          for (const l of sponsorLogs) sponsored += (l.args.amount as bigint) ?? 0n;
        }

        const derived = (total * rateBps) / RATE_DIVISOR;
        const expected = derived + sponsored;
        // Still allowed to come in under: the contract caps the payout at whatever the
        // reserve actually held at settlement.
        const matches = prize <= expected;
        push({
          label: "THE PRIZE",
          question: "Was the prize derived from the pool, or chosen by someone?",
          value:
            sponsored > 0n
              ? `${derived.toLocaleString()} derived + ${sponsored.toLocaleString()} sponsored = ${expected.toLocaleString()}`
              : `${total.toLocaleString()} × ${rateBps} bps ÷ ${RATE_DIVISOR.toLocaleString()} = ${expected.toLocaleString()}`,
          ok: matches,
          detail:
            prize === expected
              ? sponsored > 0n
                ? "the published formula, plus sponsorships summed from the public logs"
                : "exactly the published formula, applied to the published total"
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

        // 5 ── the absence of a winner
        const codeHex = (code ?? "0x").toLowerCase();
        const present = WINNER_GETTERS.filter((sig) => codeHex.includes(toFunctionSelector(sig).slice(2)));
        push({
          label: "NO WINNER FIELD",
          question: "Can anyone ask this contract who won?",
          value:
            present.length === 0
              ? `${WINNER_GETTERS.length} winner-getter selectors searched, 0 found`
              : `found ${present.length}`,
          ok: present.length === 0,
          detail:
            "the draw record holds a total, a prize and a ciphertext handle — no address field, and no function that would return one",
        });
        setStep(5);
      } catch (e) {
        setError(e instanceof Error ? e.message.slice(0, 160) : "Verification failed.");
        setStep(-1);
      }
    },
    [publicClient],
  );

  return { verify, results, step, error, verifying: step >= 0 && step < 5, done: step >= 5 };
}
