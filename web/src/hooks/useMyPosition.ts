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
 * off-chain. Nobody else can do any of this for you - the contract only ever grants
 * decryption rights to the slot's owner.
 */
export function useMyPosition() {
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  // Always starts locked, even when a session is stored. Holding a session means the next
  // reveal costs no signature - it does not mean the position has been fetched, and
  // claiming otherwise would show "decrypted" over figures nobody has decrypted yet.
  const [stage, setStage] = useState<RevealStage>("locked");

  // Whether revealing will need a signature, so the button can stop promising one it is
  // not going to ask for. Read in an effect: the stored session lives in `localStorage`,
  // which is invisible to the server, and reading it during the first render would break
  // hydration.
  const [needsSignature, setNeedsSignature] = useState(true);
  useEffect(() => setNeedsSignature(!currentSession(address)), [address]);
  const [position, setPosition] = useState<MyPosition>({});
  const [error, setError] = useState<string>();

  const reveal = useCallback(async () => {
    if (!address || !publicClient) return;
    setError(undefined);

    try {
      // A slot is only assigned by depositing, and `slotOf` reverts without one. Someone
      // who has not deposited has a position - it is simply empty. Unlock it as zero
      // rather than refusing: an empty position is a legitimate thing to be shown, and
      // the deposit and withdraw controls live behind this same gate.
      //
      // No signature and no transaction here. There is no ciphertext to decrypt, so
      // asking them to sign for it would be friction charged for nothing.
      const joined = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "hasSlot",
        args: [address],
      });

      if (!joined) {
        setPosition({ balance: 0n, weight: 0n });
        setStage("unlocked");
        return;
      }

      // 1. One signature, cached for the visit.
      if (!currentSession(address)) {
        setStage("signing");
        await openSession(address, signTypedDataAsync as never);
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
      // Two confirmations, not one. The handles are read straight afterwards and the
      // relayer has to see the grant that this transaction made; a single confirmation
      // leaves too little room for that to propagate.
      await waitForTransactionReceipt(config, { hash: tx, confirmations: 2 });

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

  return { stage, position, error, reveal, lock, needsSignature, isUnlocked: stage === "unlocked" };
}
