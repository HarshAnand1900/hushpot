"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";

/** Draws that wrote you a receipt, newest first. */
export type Receipt = { drawId: bigint; handle: string; opened: boolean };

/**
 * Which draws are waiting for you to open them.
 *
 * The notification problem, stated honestly: telling somebody they won is exactly the
 * disclosure this protocol exists to prevent. Any channel that carries the *result* — a
 * push, an email, an on-chain message to one address — knows the result, and so does
 * anyone watching the channel. Winners would be identifiable by the traffic alone, even if
 * every payload were encrypted, because losers would get no traffic.
 *
 * What can be published is that a result *exists*, because that is already public and,
 * more importantly, identical for everybody. `claimChecked` and the `ClaimChecked` event
 * fire for every depositor in a sweep, winner and loser, at the same gas. So the pool can
 * say "draw #3 has been checked for you, and your receipt is ready" to all fourteen people
 * at once, and an observer counting notifications learns nothing they could not already
 * count on-chain.
 *
 * The result itself never travels. It sits in `awardOf` as ciphertext only the depositor
 * can open, so the notification is a doorbell and the answer is behind a door only one
 * person has the key to.
 *
 * Which draws you have already opened is kept in this browser. That is public information
 * — `claimChecked` says it on-chain — so writing it down costs nothing. The amounts are
 * never stored, only draw ids.
 */
const OPENED_KEY = `hushpot.opened.${POOL_ADDRESS.slice(2, 10)}`;

function readOpened(account?: string): Set<string> {
  if (typeof window === "undefined" || !account) return new Set();
  try {
    const raw = window.localStorage.getItem(`${OPENED_KEY}.${account.slice(2, 10)}`);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function useReceipts(drawCount: bigint) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [receipts, setReceipts] = useState<Receipt[]>([]);

  const load = useCallback(async () => {
    if (!publicClient || !address || drawCount === 0n) return setReceipts([]);
    try {
      const joined = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "hasSlot",
        args: [address],
      });
      if (!joined) return setReceipts([]);

      const slot = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotOf",
        args: [address],
      })) as number;

      const ids = Array.from({ length: Number(drawCount) }, (_, i) => BigInt(i));
      const handles = await Promise.all(
        ids.map((id) =>
          publicClient.readContract({
            address: POOL_ADDRESS,
            abi: poolAbi,
            functionName: "awardOf",
            args: [id, slot],
          }),
        ),
      );

      const opened = readOpened(address);
      const found = ids
        .map((drawId, i) => ({ drawId, handle: handles[i] as string, opened: opened.has(String(drawId)) }))
        // An unwritten slot is thirty-two zero bytes. A real handle never is.
        .filter((r) => r.handle && /[1-9a-f]/i.test(r.handle.slice(2)))
        .reverse();

      setReceipts(found);
    } catch {
      /* the page reads fine without the badge */
    }
  }, [publicClient, address, drawCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const markOpened = useCallback(
    (drawId: bigint) => {
      if (!address) return;
      const opened = readOpened(address);
      opened.add(String(drawId));
      try {
        window.localStorage.setItem(`${OPENED_KEY}.${address.slice(2, 10)}`, JSON.stringify([...opened]));
      } catch {
        /* the badge simply stays lit */
      }
      setReceipts((rs) => rs.map((r) => (r.drawId === drawId ? { ...r, opened: true } : r)));
    },
    [address],
  );

  return { receipts, unopened: receipts.filter((r) => !r.opened).length, markOpened, reload: load };
}
