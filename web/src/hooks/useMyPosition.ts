"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, usePublicClient, useSignTypedData, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { clearSession, currentSession, decryptHandle, openSession } from "@/lib/fhe";

export type RevealStage = "locked" | "signing" | "computing" | "decrypting" | "unlocked" | "error";

export interface MyPosition {
  slot?: number;
  balance?: bigint;
  weight?: bigint;
}

/**
 * Your own position, revealed on request.
 *
 * Three steps, and the middle one surprises people: computing an encrypted value is a
 * *transaction*, not a call, because FHE operations mutate coprocessor state. So we ask
 * the contract to recompute your balance, wait for it to land, then decrypt the handle
 * off-chain. Nobody else can do any of this for you — the contract only ever grants
 * decryption rights to the slot's owner.
 */
export function useMyPosition() {
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const [stage, setStage] = useState<RevealStage>(currentSession() ? "unlocked" : "locked");
  const [position, setPosition] = useState<MyPosition>({});
  const [error, setError] = useState<string>();

  /**
   * Whether this address is in the pool at all. `undefined` until we have asked.
   *
   * Needed before any decryption is attempted, because a first-time visitor has nothing
   * to decrypt — and, more importantly, because depositing must not be gated behind
   * revealing a position that does not exist yet.
   */
  const [hasPosition, setHasPosition] = useState<boolean>();

  const refreshHasPosition = useCallback(async () => {
    if (!address || !publicClient) {
      setHasPosition(undefined);
      return;
    }

    try {
      const joined = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "hasSlot",
        args: [address],
      });
      setHasPosition(joined as boolean);
    } catch {
      setHasPosition(undefined);
    }
  }, [address, publicClient]);

  useEffect(() => {
    void refreshHasPosition();
  }, [refreshHasPosition]);

  const reveal = useCallback(async () => {
    if (!address || !publicClient) return;
    setError(undefined);

    try {
      // 1. One signature, cached for the visit.
      if (!currentSession()) {
        setStage("signing");
        await openSession(address, signTypedDataAsync as never);
      }

      // A slot is only assigned by depositing, and `slotOf` reverts without one. Ask
      // first: an address that has never deposited is the ordinary case for a visitor,
      // not an error to show them a decoded revert signature for.
      const joined = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "hasSlot",
        args: [address],
      });

      if (!joined) {
        setStage("locked");
        setError("You have no position in this pool yet — make a deposit and it will appear here.");
        return;
      }

      const slot = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotOf",
        args: [address],
      });

      // 2. Ask the contract to recompute both figures. This has to be a transaction, not
      //    a call: FHE operations mutate coprocessor state, so there is no free read.
      //    Balance and odds are done together to keep it to one wallet prompt.
      setStage("computing");
      const tx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "refreshMyPosition",
      });
      await waitForTransactionReceipt(config, { hash: tx });

      // 3. Read the handles and open them locally.
      setStage("decrypting");
      const [balanceHandle, weightHandle] = await Promise.all([
        publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "balanceHandle", args: [slot] }),
        publicClient.readContract({ address: POOL_ADDRESS, abi: poolAbi, functionName: "weightHandle", args: [slot] }),
      ]);

      const [balance, weight] = await Promise.all([
        decryptHandle(balanceHandle as string),
        decryptHandle(weightHandle as string),
      ]);

      setPosition({ slot: Number(slot), balance, weight });
      setStage("unlocked");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not reveal your position.";
      // A rejected signature isn't a failure worth shouting about.
      setError(/user rejected|denied/i.test(message) ? "Signature declined." : message);
      setStage("error");
    }
  }, [address, config, publicClient, signTypedDataAsync, writeContractAsync]);

  const lock = useCallback(() => {
    clearSession();
    setPosition({});
    setStage("locked");
  }, []);

  return {
    stage,
    position,
    error,
    reveal,
    lock,
    hasPosition,
    refreshHasPosition,
    isUnlocked: stage === "unlocked",
  };
}
