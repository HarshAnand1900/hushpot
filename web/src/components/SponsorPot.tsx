"use client";

import { useCallback, useState } from "react";
import { useAccount, useConfig, usePublicClient, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { POOL_ADDRESS, TOKEN_DECIMALS, UNDERLYING_ADDRESS, erc20Abi, poolAbi } from "@/lib/contract";
import { formatUnits } from "@/lib/format";
import styles from "./SponsorPot.module.css";

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);

/**
 * Grow the prize without competing for it.
 *
 * PoolTogether V5 calls this sponsoring — `PrizeVault.sponsor` delegates a deposit to the
 * sponsorship address so it earns for the pool but never wins. Ours is simpler: the money
 * goes straight to the shared reserve, so there is no slot, no odds, and nothing to
 * delegate. It is public and in plain tokens on purpose — a claim about the prize should
 * be checkable by anyone.
 */
export function SponsorPot({ reserve, onDone }: { reserve: bigint; onDone?: () => void }) {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [raw, setRaw] = useState("");
  const [state, setState] = useState<"idle" | "approving" | "sponsoring" | "done" | "error">("idle");
  const [error, setError] = useState<string>();

  const amount = (() => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * Number(SCALE)));
  })();

  const busy = state === "approving" || state === "sponsoring";

  const sponsor = useCallback(async () => {
    if (!address || !publicClient || amount <= 0n) return;
    setError(undefined);

    try {
      const allowance = (await publicClient.readContract({
        address: UNDERLYING_ADDRESS,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, POOL_ADDRESS],
      })) as bigint;

      // The test USDT copies real Tether's approve semantics: raising a non-zero
      // allowance reverts, so a stale one has to be zeroed first.
      if (allowance < amount) {
        setState("approving");
        if (allowance > 0n) {
          const clear = await writeContractAsync({
            address: UNDERLYING_ADDRESS,
            abi: erc20Abi,
            functionName: "approve",
            args: [POOL_ADDRESS, 0n],
          });
          await waitForTransactionReceipt(config, { hash: clear });
        }
        const ok = await writeContractAsync({
          address: UNDERLYING_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [POOL_ADDRESS, amount],
        });
        await waitForTransactionReceipt(config, { hash: ok });
      }

      setState("sponsoring");
      const tx = await writeContractAsync({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "sponsorPrize",
        args: [amount],
      });
      await waitForTransactionReceipt(config, { hash: tx });

      setState("done");
      setRaw("");
      onDone?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not sponsor the pot.";
      setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message.slice(0, 160));
      setState("error");
    }
  }, [address, amount, config, onDone, publicClient, writeContractAsync]);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>SPONSOR THE POT</span>
        <span>RESERVE {formatUnits(reserve)} cUSDT</span>
      </div>

      <div className={styles.body}>
        <p className={styles.copy}>
          Anyone can grow the prize without taking any share of it. A sponsorship joins the reserve rather than the
          pool, so it never becomes a position, never earns odds, and can never win itself back. Every depositor&apos;s
          chances are untouched — there are simply more winnings to hand out.
        </p>

        <div className={styles.row}>
          <input
            className={styles.input}
            inputMode="decimal"
            placeholder="0.00"
            value={raw}
            onChange={(e) => setRaw(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={busy}
            aria-label="Amount to sponsor"
          />
          <span className={styles.unit}>tUSDT</span>
          <button className="btnOutlineYellow" onClick={sponsor} disabled={!isConnected || busy || amount === 0n}>
            {!isConnected
              ? "Connect a wallet"
              : state === "approving"
                ? "Approving…"
                : state === "sponsoring"
                  ? "Sponsoring…"
                  : amount === 0n
                    ? "Enter an amount"
                    : `Sponsor ${formatUnits(amount)}`}
          </button>
        </div>

        {state === "done" && <div className={styles.ok}>Added to the pot. It will be paid out at the next draw.</div>}
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.note}>
          Plain tokens, and deliberately public — a claim about the size of the prize should be checkable by everybody.
          On mainnet this reserve would be fed by real yield instead.
        </div>
      </div>
    </section>
  );
}
