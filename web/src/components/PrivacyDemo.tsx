"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useSignTypedData } from "wagmi";

import { POOL_ADDRESS, poolAbi } from "@/lib/contract";
import { currentSession, decryptHandle, openSession } from "@/lib/fhe";
import { formatUnits, shortenAddress, shortenHandle } from "@/lib/format";
import styles from "./PrivacyDemo.module.css";

type Outcome = { handle: string; owner: string; opened: boolean; value?: bigint; reason?: string };

/**
 * The privacy claim, demonstrated instead of asserted.
 *
 * Two ciphertext handles, both read off the public chain, both fed to the same relayer
 * with the same session key. Yours opens. Somebody else's does not. Same code path, same
 * few seconds, two different answers — which is the whole product in one interaction.
 */
export function PrivacyDemo() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();

  const [running, setRunning] = useState(false);
  const [mine, setMine] = useState<Outcome>();
  const [theirs, setTheirs] = useState<Outcome>();
  const [note, setNote] = useState<string>();

  const run = useCallback(async () => {
    if (!address || !publicClient) return;
    setRunning(true);
    setMine(undefined);
    setTheirs(undefined);
    setNote(undefined);

    try {
      if (!currentSession(address)) {
        await openSession(address, signTypedDataAsync as never);
      }

      // The demo compares your own ciphertext against someone else's, so it needs you to
      // have one. Without a deposit there is no slot and `slotOf` reverts.
      const joined = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "hasSlot",
        args: [address],
      });

      if (!joined) {
        setNote("Deposit first — this compares your own ciphertext against another depositor's.");
        return;
      }

      const mySlot = await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotOf",
        args: [address],
      });

      const myHandle = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "balanceHandle",
        args: [mySlot],
      })) as string;

      // `balanceHandle` is a cache, filled by refreshMyPosition. Deposit without ever
      // revealing and it is still zero — and decrypting nothing would report "opened"
      // with no value, making the demo look broken while the contract is perfectly fine.
      if (!myHandle || /^0x0+$/.test(myHandle)) {
        setNote("Reveal your position on the Pool tab first — there is no ciphertext of yours cached yet.");
        return;
      }

      // Yours — opens.
      try {
        const value = await decryptHandle(myHandle);
        setMine({ handle: myHandle, owner: address, opened: true, value });
      } catch (e) {
        setMine({
          handle: myHandle,
          owner: address,
          opened: false,
          reason: e instanceof Error ? e.message.slice(0, 90) : "refused",
        });
      }

      // Somebody else's — find another occupied slot.
      const slotsUsed = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotsUsed",
      })) as number;

      let otherSlot: number | undefined;
      for (let s = 0; s < slotsUsed; s++) {
        if (s !== Number(mySlot)) {
          otherSlot = s;
          break;
        }
      }

      if (otherSlot === undefined) {
        setNote(
          "You are currently the only depositor, so there is no second balance to try. The check below runs against a slot that has never been used — a handle you equally cannot open.",
        );
        otherSlot = Number(mySlot) + 1;
      }

      const otherOwner = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "slotOwner",
        args: [otherSlot],
      })) as string;

      const otherHandle = (await publicClient.readContract({
        address: POOL_ADDRESS,
        abi: poolAbi,
        functionName: "balanceHandle",
        args: [otherSlot],
      })) as string;

      try {
        const value = await decryptHandle(otherHandle);
        // Reaching here with a real value would mean the privacy model had failed.
        setTheirs({ handle: otherHandle, owner: otherOwner, opened: value !== undefined, value });
      } catch (e) {
        setTheirs({
          handle: otherHandle,
          owner: otherOwner,
          opened: false,
          reason: e instanceof Error ? e.message.slice(0, 110) : "the relayer refused",
        });
      }
    } finally {
      setRunning(false);
    }
  }, [address, publicClient, signTypedDataAsync]);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>CAN WE READ YOUR BALANCE?</span>
        <span>LIVE · NOT A CLAIM</span>
      </div>

      <div className={styles.body}>
        <p className={styles.copy}>
          Every balance in this pool sits on-chain as a ciphertext handle that anyone can read. Reading the handle is
          not the same as reading the number. Below, the same relayer and the same key are pointed at two of them —
          yours, and somebody else&apos;s.
        </p>

        <button className="btnPrimary" onClick={run} disabled={!isConnected || running}>
          {!isConnected ? "Connect a wallet to run it" : running ? "Running both…" : "Try to open both balances"}
        </button>

        {note && <div className={styles.note}>{note}</div>}

        {(mine || theirs) && (
          <div className={styles.grid}>
            <Result title="YOUR BALANCE" outcome={mine} />
            <Result title="SOMEBODY ELSE'S" outcome={theirs} />
          </div>
        )}

        {mine && theirs && (
          <div className={styles.verdict}>
            {mine.opened && !theirs.opened
              ? "Same request, same key, same relayer. One opened, one did not — and nothing about the second one is recoverable, by us or by anyone else."
              : "Unexpected result. Both handles should not behave the same way; if they do, something is wrong and we would want to know."}
          </div>
        )}
      </div>
    </section>
  );
}

function Result({ title, outcome }: { title: string; outcome?: Outcome }) {
  if (!outcome) return <div className={styles.cell} />;

  return (
    <div className={outcome.opened ? `${styles.cell} ${styles.cellOpen}` : `${styles.cell} ${styles.cellShut}`}>
      <div className={styles.cellTitle}>{title}</div>
      <div className={styles.cellOwner}>{shortenAddress(outcome.owner)}</div>
      <div className={styles.cellHandle}>{shortenHandle(outcome.handle)}</div>

      <div className={styles.cellResult}>
        {outcome.opened && outcome.value !== undefined ? formatUnits(outcome.value) : "UNREADABLE"}
      </div>

      <div className={styles.cellNote}>
        {outcome.opened
          ? "opened locally with your key — it never crossed the wire in the clear"
          : "no decryption right. The relayer will not serve it, and the ciphertext is useless without one."}
      </div>
    </div>
  );
}
