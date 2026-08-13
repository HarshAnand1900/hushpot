"use client";

import { useCallback, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import {
  POOL_ADDRESS,
  TOKEN_ADDRESS,
  UNDERLYING_ADDRESS,
  confidentialTokenAbi,
  erc20Abi,
  poolAbi,
} from "@/lib/contract";

export type FlowStep = "idle" | "approving" | "depositing" | "withdrawing" | "done" | "error";

/**
 * Deposit and withdraw.
 *
 * Two things here are not obvious and both cause silent failures if missed:
 *
 * 1. The test USDT copies real Tether's approve semantics — approving a non-zero amount
 *    while a non-zero allowance already exists reverts. Any stale allowance has to be
 *    zeroed first, which is why `approve` is sometimes two transactions.
 *
 * 2. A confidential transfer that exceeds your balance does NOT revert; it silently moves
 *    nothing. So the pool credits whatever actually arrived, and the UI has to refuse an
 *    oversized deposit up front — otherwise the user pays gas for a no-op with no error.
 */
export function useDeposit() {
  const { address } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [step, setStep] = useState<FlowStep>("idle");
  const [error, setError] = useState<string>();

  const reset = useCallback(() => {
    setStep("idle");
    setError(undefined);
  }, []);

  const deposit = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient || amount <= 0n) return false;
      setError(undefined);

      try {
        const balance = await publicClient.readContract({
          address: UNDERLYING_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });

        if ((balance as bigint) < amount) {
          setError("You don't hold that many tokens. Use the faucet first.");
          setStep("error");
          return false;
        }

        const allowance = (await publicClient.readContract({
          address: UNDERLYING_ADDRESS,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, POOL_ADDRESS],
        })) as bigint;

        if (allowance < amount) {
          setStep("approving");

          // Tether semantics: clear a stale allowance before setting a new one.
          if (allowance > 0n) {
            const zeroTx = await writeContractAsync({
              address: UNDERLYING_ADDRESS,
              abi: erc20Abi,
              functionName: "approve",
              args: [POOL_ADDRESS, 0n],
            });
            await waitForTransactionReceipt(config, { hash: zeroTx });
          }

          const approveTx = await writeContractAsync({
            address: UNDERLYING_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [POOL_ADDRESS, amount],
          });
          // Two confirmations: the deposit below is estimated against whatever node the
          // wallet talks to, and that node has to be able to see this allowance.
          await waitForTransactionReceipt(config, { hash: approveTx, confirmations: 2 });
        }

        // One transaction shields the tokens and credits an encrypted position.
        setStep("depositing");
        const depositTx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "depositUnderlying",
          args: [amount],
          // Stated, not estimated. If the approval has not reached the estimating node,
          // `eth_estimateGas` reverts and the wallet falls back to an enormous limit that
          // the RPC rejects as over its cap — a confusing "gas limit too high" for a
          // transaction that was never going to be large. Measured at ~2.5M on Sepolia;
          // unused gas is refunded.
          gas: 3_600_000n,
        });
        await waitForTransactionReceipt(config, { hash: depositTx });

        setStep("done");
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "The deposit failed.";
        setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
        setStep("error");
        return false;
      }
    },
    [address, config, publicClient, writeContractAsync],
  );

  /**
   * Deposit confidential tokens, with the amount encrypted before it is broadcast.
   *
   * This is the route that actually keeps the promise. `depositUnderlying` is convenient
   * but its `amount` is a plain number in a plain ERC-20 transfer, so the size of every
   * deposit made that way is public forever. Here nothing but a ciphertext leaves the
   * browser, and the chain records that an address deposited without recording how much.
   *
   * The cost is one extra step: the pool has to be an operator on your confidential
   * balance before it can pull anything, which is ERC-7984's equivalent of an approval.
   */
  const depositConfidential = useCallback(
    async (amount: bigint) => {
      if (!address || !publicClient || amount <= 0n) return false;
      setError(undefined);

      try {
        const isOperator = (await publicClient.readContract({
          address: TOKEN_ADDRESS,
          abi: confidentialTokenAbi,
          functionName: "isOperator",
          args: [address, POOL_ADDRESS],
        })) as boolean;

        if (!isOperator) {
          setStep("approving");
          // Granted for a year. An operator permission is time-bounded rather than
          // amount-bounded, so it cannot be sized to leak anything.
          const until = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
          const opTx = await writeContractAsync({
            address: TOKEN_ADDRESS,
            abi: confidentialTokenAbi,
            functionName: "setOperator",
            args: [POOL_ADDRESS, until],
          });
          await waitForTransactionReceipt(config, { hash: opTx, confirmations: 2 });
        }

        setStep("depositing");
        const { getFhevm, toHex } = await import("@/lib/fhe");
        const fhevm = await getFhevm();
        const encrypted = await fhevm.createEncryptedInput(POOL_ADDRESS, address).add64(amount).encrypt();

        const tx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "deposit",
          args: [toHex(encrypted.handles[0]), toHex(encrypted.inputProof)],
          gas: 3_600_000n,
        });
        await waitForTransactionReceipt(config, { hash: tx });

        setStep("done");
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "The deposit failed.";
        setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
        setStep("error");
        return false;
      }
    },
    [address, config, publicClient, writeContractAsync],
  );

  /**
   * Withdraw principal. The amount is encrypted in the browser before it is broadcast, so
   * unlike the plain-token deposit path this leaves no figure in the clear.
   *
   * Asking for more than you hold is clamped to your balance rather than reverted — a
   * ciphertext can't be compared and branched on, so the contract takes the minimum. You
   * always receive exactly what you own, never less and never more.
   */
  const withdraw = useCallback(
    async (amount: bigint) => {
      if (!address || amount <= 0n) return false;
      setError(undefined);

      try {
        setStep("withdrawing");

        const { getFhevm, toHex } = await import("@/lib/fhe");
        const fhevm = await getFhevm();

        const encrypted = await fhevm.createEncryptedInput(POOL_ADDRESS, address).add64(amount).encrypt();

        const tx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "withdraw",
          args: [toHex(encrypted.handles[0]), toHex(encrypted.inputProof)],
        });
        await waitForTransactionReceipt(config, { hash: tx });

        setStep("done");
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "The withdrawal failed.";
        setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
        setStep("error");
        return false;
      }
    },
    [address, config, writeContractAsync],
  );

  return {
    step,
    error,
    deposit,
    depositConfidential,
    withdraw,
    reset,
    busy: step === "approving" || step === "depositing" || step === "withdrawing",
  };
}
