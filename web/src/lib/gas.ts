import type { PublicClient } from "viem";

/**
 * A gas limit that is both sufficient and affordable.
 *
 * These calls state their gas rather than letting the wallet estimate, because estimation
 * runs against a node that may not yet have seen the transaction this one depends on — an
 * approval, an operator grant — and an estimate that reverts makes wallets fall back to an
 * enormous limit the RPC then rejects outright.
 *
 * The trap is that a stated limit has to be *paid for* up front. A wallet must hold
 * `limit × maxFeePerGas` before it will even submit, whatever the transaction actually
 * ends up burning. A flat 3,600,000 was covering a sweep that costs 1,691,077, and at
 * 2.2 gwei that ceiling reserved 0.008 ETH against a real cost of 0.0038 — so a wallet
 * holding 0.0064 test ETH was refused a transaction it could comfortably afford. On a
 * testnet where ETH arrives a faucet at a time, that is most wallets.
 *
 * So: estimate first, and add a margin for the FHE work whose cost moves with the number
 * of slots involved. Fall back to the stated ceiling only when estimation genuinely fails,
 * which is the case it was there for in the first place.
 */
export async function gasLimitFor(
  client: PublicClient | undefined,
  account: `0x${string}` | undefined,
  request: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
  fallback: bigint,
): Promise<bigint> {
  if (!client || !account) return fallback;
  try {
    const estimate = await client.estimateContractGas({ ...request, account } as never);
    // 30% over. Enough for block-to-block variation in the coprocessor's work without
    // reserving twice what the call needs. Not clamped to the fallback: a sweep over many
    // slots legitimately costs more than the flat ceiling used to allow.
    return (estimate * 13n) / 10n;
  } catch {
    return fallback;
  }
}
