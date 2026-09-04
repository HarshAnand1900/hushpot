"use client";

import { useCallback, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { describeError, toast } from "@/lib/toast";

/**
 * Let the browser paint before something blocking runs.
 *
 * FHE encryption is WebAssembly on the main thread: for the second or two it runs, nothing
 * repaints and the tab reports as unresponsive. React had already been told to show the
 * "encrypting" step, but the commit had not been painted yet, so the freeze arrived with
 * the *previous* frame still on screen and looked like the click had done nothing.
 *
 * Two frames is the reliable point: one for React to commit, one for the browser to paint
 * it. It costs about 32ms and buys a UI that visibly acknowledges the click before it
 * stalls.
 */
const paint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

import { POOL_ADDRESS, TOKEN_ADDRESS, confidentialTokenAbi, poolAbi } from "@/lib/contract";
import { gasLimitFor } from "@/lib/gas";

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

  /**
   * Deposit confidential tokens, with the amount encrypted before it is broadcast.
   *
   * The only deposit route this app has. The contract also exposes `depositUnderlying`,
   * which takes plain tUSDT — but its `amount` rides in a plain ERC-20 transfer, so the
   * size of any deposit made that way is public forever, and no amount of encryption
   * downstream can unpublish it. It is not wired to anything here. On this route nothing
   * but a ciphertext leaves the browser, and the chain records that an address deposited
   * without recording how much.
   *
   * The cost is one extra step: the pool has to be an operator on your confidential
   * balance before it can pull anything, which is ERC-7984's equivalent of an approval.
   */
  const depositConfidential = useCallback(
    async (amount: bigint, balanceChecked = true) => {
      if (!address || !publicClient || amount <= 0n) return false;
      setError(undefined);

      try {
        const isOperator = (await publicClient.readContract({
          address: TOKEN_ADDRESS,
          abi: confidentialTokenAbi,
          functionName: "isOperator",
          args: [address, POOL_ADDRESS],
        })) as boolean;

        // Kicked off before the branch so the two paths share it, and so a returning
        // depositor — who needs no grant at all — starts encrypting immediately.
        const encrypt = async () => {
          await paint();
          const { getFhevm, toHex } = await import("@/lib/fhe");
          const fhevm = await getFhevm();
          const enc = await fhevm.createEncryptedInput(POOL_ADDRESS, address).add64(amount).encrypt();

          return { handle: toHex(enc.handles[0]), proof: toHex(enc.inputProof) };
        };
        let encryption: ReturnType<typeof encrypt> | undefined;

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
          // Encrypting takes seconds of WASM work and needs nothing from this receipt, so
          // it runs while the grant confirms rather than after it.
          encryption = encrypt();
          await waitForTransactionReceipt(config, { hash: opTx });
        }

        setStep("depositing");
        const encrypted = await (encryption ?? encrypt());

        const tx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "deposit",
          args: [encrypted.handle, encrypted.proof],
          // Estimated where possible, with the flat ceiling as the fallback it was always
          // meant to be. A stated limit is money the wallet has to hold before it will
          // submit, and 3.6M priced out wallets that could afford the call — see
          // `gasLimitFor`.
          gas: await gasLimitFor(
            publicClient,
            address,
            {
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "deposit",
              args: [encrypted.handle, encrypted.proof],
            },
            3_600_000n,
          ),
        });
        await waitForTransactionReceipt(config, { hash: tx });

        setStep("done");
        // Only claim the deposit landed when the amount was actually checked against a
        // revealed balance. ERC-7984 clamps instead of reverting, so an oversized transfer
        // moves nothing, emits `Deposited` regardless, and a flat "confirmed" would be the
        // app asserting something it has no way to know.
        toast(
          balanceChecked
            ? {
                kind: "success",
                title: "Deposit confirmed",
                detail: "Nothing but a ciphertext left this browser — the size was never written down.",
                hash: tx,
              }
            : {
                kind: "success",
                title: "Deposit submitted",
                detail:
                  "Your cUSDT balance was sealed, so the amount could not be checked against it. Reveal your position to see what actually landed.",
                hash: tx,
              },
        );
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "The deposit failed.";
        setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
        setStep("error");
        toast({ kind: "error", title: "Deposit failed", detail: describeError(e) });
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

        await paint();
        const { getFhevm, toHex } = await import("@/lib/fhe");
        const fhevm = await getFhevm();

        const encrypted = await fhevm.createEncryptedInput(POOL_ADDRESS, address).add64(amount).encrypt();

        const tx = await writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: "withdraw",
          args: [toHex(encrypted.handles[0]), toHex(encrypted.inputProof)],
          // Withdraw walks the same tree path a deposit does — the debit, the early-exit
          // credit and the ancestor repair, so it belongs on the same estimate-first
          // path, not on whatever the wallet guesses for an FHE call.
          gas: await gasLimitFor(
            publicClient,
            address,
            {
              address: POOL_ADDRESS,
              abi: poolAbi,
              functionName: "withdraw",
              args: [toHex(encrypted.handles[0]), toHex(encrypted.inputProof)],
            },
            3_600_000n,
          ),
        });
        await waitForTransactionReceipt(config, { hash: tx });

        setStep("done");
        toast({
          kind: "success",
          title: "Withdrawal confirmed",
          detail: "Principal is back in your wallet, still encrypted.",
          hash: tx,
        });
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "The withdrawal failed.";
        toast({ kind: "error", title: "Withdrawal failed", detail: describeError(e) });
        setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
        setStep("error");
        return false;
      }
    },
    [address, config, publicClient, writeContractAsync],
  );

  /**
   * Take everything out and give the slot back.
   *
   * Distinct from a withdrawal on purpose. `withdraw` clamps to whatever you asked for and
   * leaves the slot yours; this empties the balance by construction — it requests
   * `type(uint64).max`, which clamps to the whole of it — and then releases the slot at the
   * next period roll.
   *
   * Worth offering because a slot is otherwise permanent: every sweep pays gas for every
   * address that ever deposited, so somebody who has left and cannot say so keeps costing
   * the pool for ever.
   */
  const exitPool = useCallback(async () => {
    if (!address) return false;
    setError(undefined);

    try {
      setStep("withdrawing");
      const tx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "exitPool",
        gas: await gasLimitFor(
          publicClient,
          address,
          { address: POOL_ADDRESS, abi: poolAbi, functionName: "exitPool" },
          3_600_000n,
        ),
      });
      await waitForTransactionReceipt(config, { hash: tx });

      setStep("done");
      toast({
        kind: "success",
        title: "You have left the pool",
        detail: "Principal returned in full, still encrypted. The slot is released at the next period roll.",
        hash: tx,
      });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not exit.";
      setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
      setStep("error");
      toast({ kind: "error", title: "Exit failed", detail: describeError(e) });
      return false;
    }
  }, [address, config, publicClient, writeContractAsync]);

  return {
    step,
    error,
    depositConfidential,
    withdraw,
    exitPool,
    reset,
    busy: step === "approving" || step === "depositing" || step === "withdrawing",
  };
}
