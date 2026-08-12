"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS, poolAbi } from "@/lib/contract";

export type DepositRow = {
  /** Draw that was open when this landed. */
  draw: number;
  /** Base units. `undefined` for a confidential deposit, whose size is not public. */
  amount?: bigint;
  block: bigint;
};

export type OddsPoint = { draw: number; odds: number };

const HISTORY_KEY = "hushpot.odds.v1";

/**
 * Your record, assembled from two places.
 *
 * Deposits, draws entered and blocks held come off the chain — they are public facts about
 * an address, and the Proof tab already says so. Deposits made through the plain-token
 * route carry their size in the clear; ones made in cUSDT do not, and are shown without an
 * amount rather than guessed at.
 *
 * Odds history cannot come off the chain. Nobody stores your past weight — that is the
 * point of the product — so a series can only be built from readings you took yourself.
 * It is kept in this browser and labelled as such. Clearing site data loses it, which is
 * the correct trade for a figure the chain deliberately does not keep.
 */
export function usePositionHistory(drawCount: number, currentOdds?: number) {
  const { address } = useAccount();
  const publicClient = usePublicClient();

  const [deposits, setDeposits] = useState<DepositRow[]>();
  const [drawsEntered, setDrawsEntered] = useState<number>();
  const [blocksHeld, setBlocksHeld] = useState<bigint>();
  const [odds, setOdds] = useState<OddsPoint[]>([]);

  // --- chain half ----------------------------------------------------------
  useEffect(() => {
    if (!address || !publicClient) {
      setDeposits(undefined);
      return;
    }

    let live = true;

    // `getLogs` with a runtime-selected event gives back an opaque type, so the shape we
    // rely on is stated here rather than inferred.
    type RawLog = { blockNumber: bigint | null; transactionHash: string; args: { amount?: bigint } };

    void (async () => {
      try {
        const [plainRaw, shieldedRaw, settledRaw, head] = await Promise.all([
          publicClient.getLogs({
            address: POOL_ADDRESS,
            event: poolAbi.find((e) => e.type === "event" && e.name === "DepositedFromUnderlying") as never,
            args: { account: address } as never,
            fromBlock: DEPLOY_BLOCK,
            toBlock: "latest",
          }),
          publicClient.getLogs({
            address: POOL_ADDRESS,
            event: poolAbi.find((e) => e.type === "event" && e.name === "Deposited") as never,
            args: { account: address } as never,
            fromBlock: DEPLOY_BLOCK,
            toBlock: "latest",
          }),
          publicClient.getLogs({
            address: POOL_ADDRESS,
            event: poolAbi.find((e) => e.type === "event" && e.name === "DrawSettled") as never,
            fromBlock: DEPLOY_BLOCK,
            toBlock: "latest",
          }),
          publicClient.getBlockNumber(),
        ]);

        if (!live) return;

        const plain = plainRaw as unknown as RawLog[];
        const shielded = shieldedRaw as unknown as RawLog[];
        const settled = settledRaw as unknown as RawLog[];

        const settledBlocks = settled.map((l) => l.blockNumber ?? 0n).sort((a, b) => (a < b ? -1 : 1));

        // A plain-route deposit emits both events in one transaction; keep the plain one so
        // the amount survives, and treat the rest as confidential.
        const plainTxs = new Set(plain.map((l) => l.transactionHash));

        const rows: DepositRow[] = [
          ...plain.map((l) => ({ block: l.blockNumber ?? 0n, amount: l.args.amount })),
          ...shielded
            .filter((l) => !plainTxs.has(l.transactionHash))
            .map((l) => ({ block: l.blockNumber ?? 0n, amount: undefined })),
        ]
          .map((r) => ({
            ...r,
            // Which draw was open when it landed: the number that had already settled.
            draw: settledBlocks.filter((b) => b <= r.block).length,
          }))
          .sort((a, b) => (a.block < b.block ? -1 : 1));

        setDeposits(rows);

        if (rows.length > 0) {
          setBlocksHeld(head - rows[0].block);
          setDrawsEntered(Math.max(0, drawCount - rows[0].draw));
        } else {
          setBlocksHeld(undefined);
          setDrawsEntered(undefined);
        }
      } catch {
        if (live) setDeposits(undefined);
      }
    })();

    return () => {
      live = false;
    };
  }, [address, publicClient, drawCount]);

  // --- browser half --------------------------------------------------------
  const read = useCallback((): Record<string, OddsPoint[]> => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}") as Record<string, OddsPoint[]>;
    } catch {
      return {};
    }
  }, []);

  useEffect(() => {
    if (!address) return;
    setOdds(read()[address.toLowerCase()] ?? []);
  }, [address, read]);

  /** Remember today's reading, so a series exists next time. One entry per draw. */
  useEffect(() => {
    if (!address || currentOdds === undefined || !Number.isFinite(currentOdds)) return;

    const key = address.toLowerCase();
    const all = read();
    const mine = all[key] ?? [];

    if (mine.some((p) => p.draw === drawCount)) return;

    const next = [...mine, { draw: drawCount, odds: currentOdds }].slice(-12);
    all[key] = next;

    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
      setOdds(next);
    } catch {
      /* private mode, or the quota is gone — the series is a nicety, not the product */
    }
  }, [address, currentOdds, drawCount, read]);

  return { deposits, drawsEntered, blocksHeld, odds };
}
