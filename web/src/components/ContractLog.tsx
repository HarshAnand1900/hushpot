"use client";

import { useCallback, useEffect, useState } from "react";
import { parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";

import { DEPLOY_BLOCK, POOL_ADDRESS } from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/format";
import styles from "./ContractLog.module.css";

const EV_DEPOSITED = parseAbiItem("event Deposited(address indexed account, uint16 indexed slot)");
const EV_PLAIN = parseAbiItem(
  "event DepositedFromUnderlying(address indexed account, uint16 indexed slot, uint256 amount)",
);
const EV_WITHDRAWN = parseAbiItem("event Withdrawn(address indexed account, uint16 indexed slot)");
const EV_SETTLED = parseAbiItem("event DrawSettled(uint256 indexed drawId, uint64 total, uint64 prize)");
const EV_CLAIM = parseAbiItem(
  "event ClaimChecked(uint256 indexed drawId, uint16 indexed slot, address indexed checkedBy)",
);
const EV_RESERVE = parseAbiItem("event ReserveFunded(uint64 amount, uint64 newReserve)");
const EV_SPONSOR = parseAbiItem("event PrizeSponsored(address indexed sponsor, uint64 amount)");

type Entry = {
  block: bigint;
  hash: string;
  kind: string;
  headline: string;
  /** A yellow marker means money moved into the pot rather than between accounts. */
  accent?: boolean;
  /** Block timestamp, so the age can be recomputed every second without another fetch. */
  at?: number;
  /** Whether this row's amount was published, or is simply not there to publish. */
  clear?: boolean;
};

/**
 * What the chain actually recorded, as it happened.
 *
 * Everything here is public and always was. The point is what is missing from it: the
 * confidential rows carry •••••• where an amount would go, because there is no amount
 * field to render — and no settlement names a winner, because no winner is ever resolved.
 */
/**
 * Totals come from contract state; the feed comes from logs.
 *
 * They used to both come from logs, and the public RPC will not support that. It is load
 * balanced across nodes with different history, so the same `eth_getLogs` returned 97
 * entries on one call and 22 on the next, and the panel then reported "PAID OUT 922.81"
 * beside a rail reading 2,344.33 — one settled draw found instead of three. A number that
 * changes when you reload is worse than no number.
 *
 * `slotsUsed()` and `draws(i).prize` are state, so every node agrees on them. They are
 * read by the page already and handed down here, and the log-derived figures are kept only
 * for the two that have no state equivalent.
 */
export function ContractLog({
  limit = 8,
  depositors,
  paid,
  drawsSettled,
}: {
  limit?: number;
  /** From `slotsUsed()`. Authoritative, unlike counting distinct depositors in logs. */
  depositors?: number;
  /** Summed from `draws(i).prize`. Authoritative, unlike summing `DrawSettled` logs. */
  paid?: bigint;
  /** From `drawCount()`. */
  drawsSettled?: number;
}) {
  const publicClient = usePublicClient();
  const [rows, setRows] = useState<Entry[]>();
  const [head, setHead] = useState<bigint>();
  const [stats, setStats] = useState<{
    depositors: number;
    deposits: number;
    paid: bigint;
    sweeps: number;
    sponsored: bigint;
  }>();

  // Ages are stamped once per poll but tick every second, so the feed reads as something
  // happening rather than something that happened. A log that only moves every 20s looks
  // dead even when it is current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    if (!publicClient) return;
    type Raw = { blockNumber: bigint | null; transactionHash: string; args: Record<string, unknown> };
    const get = (event: ReturnType<typeof parseAbiItem>) =>
      publicClient.getLogs({ address: POOL_ADDRESS, event: event as never, fromBlock: DEPLOY_BLOCK });

    try {
      const [plain, shielded, out, settled, claims, funded, sponsored, block] = await Promise.all([
        get(EV_PLAIN),
        get(EV_DEPOSITED),
        get(EV_WITHDRAWN),
        get(EV_SETTLED),
        get(EV_CLAIM),
        get(EV_RESERVE),
        get(EV_SPONSOR),
        publicClient.getBlockNumber(),
      ]);
      setHead(block);

      // The two deposit events are emitted by different functions, not both by one — the
      // filter below is belt-and-braces for a shared transaction, not the normal case, so
      // counting must not assume an overlap that is usually empty.
      const plainTxs = new Set((plain as unknown as Raw[]).map((l) => l.transactionHash));
      const shieldedOnly = (shielded as unknown as Raw[]).filter((l) => !plainTxs.has(l.transactionHash));
      const sponsorTxs = new Set((sponsored as unknown as Raw[]).map((l) => l.transactionHash));
      const row = (l: Raw, kind: string, headline: string, accent?: boolean): Entry => ({
        block: l.blockNumber ?? 0n,
        hash: l.transactionHash,
        kind,
        headline,
        accent,
      });

      const all: Entry[] = [
        ...(plain as unknown as Raw[]).map((l) =>
          row(
            l,
            // The figure is here because this route genuinely published it — a plain
            // ERC-20 transfer of tUSDT, wrapped on arrival. Printing it beside the
            // shielded rows without saying so made it look like a leak rather than the
            // documented trade-off it is.
            "DEPOSIT · PUBLIC",
            `${shortenAddress(l.args.account as string)} DEPOSITED ${formatUnits(l.args.amount as bigint)} tUSDT · PLAIN ROUTE, SIZE PUBLIC BY DESIGN`,
          ),
        ),
        ...shieldedOnly.map((l) =>
          row(l, "DEPOSIT", `${shortenAddress(l.args.account as string)} DEPOSITED •••••• cUSDT`),
        ),
        ...(out as unknown as Raw[]).map((l) =>
          row(l, "WITHDRAW", `${shortenAddress(l.args.account as string)} WITHDREW ••••• cUSDT`),
        ),
        ...(settled as unknown as Raw[]).map((l) =>
          row(l, "SETTLE", `DRAW #${l.args.drawId} SETTLED · NO WINNER RESOLVED`),
        ),
        ...(claims as unknown as Raw[]).map((l) =>
          row(l, "CLAIM", `SLOT ${l.args.slot} CHECKED · OUTCOME UNKNOWN TO EVERYONE`),
        ),
        // A sponsorship emits ReserveFunded too, because it goes through the same funding
        // path. Labelling both rows "FROM YIELD" credited a stranger's gift to the house,
        // so the sponsored transactions are pulled out and named for what they are.
        ...(sponsored as unknown as Raw[]).map((l) =>
          row(
            l,
            "SPONSOR",
            `${shortenAddress(l.args.sponsor as string)} SPONSORED +${formatUnits(l.args.amount as bigint)} cUSDT INTO THE POT`,
            true,
          ),
        ),
        ...(funded as unknown as Raw[])
          .filter((l) => !sponsorTxs.has(l.transactionHash))
          .map((l) => row(l, "RESERVE", `RESERVE TOPPED UP +${formatUnits(l.args.amount as bigint)} cUSDT`, true)),
      ].sort((a, b) => Number(b.block - a.block));

      // A standing summary above the feed. Everything in it is already public — how many
      // people are in, how many deposits they have made between them, what has been paid
      // out. None of it is anybody's position.
      const accounts = new Set<string>();
      for (const l of [...(plain as unknown as Raw[]), ...shieldedOnly]) {
        accounts.add(l.args.account as string);
      }
      // Logs only ever accumulate, so a count that came back lower than one already seen
      // is a bad read rather than news — the public endpoint is load balanced across nodes
      // that do not all hold the same history, and the same query returned 97 entries on
      // one call and 22 on the next. Keeping the high-water mark makes these figures stop
      // moving backwards between polls, which is what made them untrustworthy on screen.
      const fresh = {
        depositors: accounts.size,
        deposits: plain.length + shieldedOnly.length,
        paid: (settled as unknown as Raw[]).reduce((sum, l) => sum + (l.args.prize as bigint), 0n),
        sweeps: claims.length,
        sponsored: (sponsored as unknown as Raw[]).reduce((sum, l) => sum + (l.args.amount as bigint), 0n),
      };
      setStats((prev) =>
        prev
          ? {
              depositors: Math.max(prev.depositors, fresh.depositors),
              deposits: Math.max(prev.deposits, fresh.deposits),
              paid: prev.paid > fresh.paid ? prev.paid : fresh.paid,
              sweeps: Math.max(prev.sweeps, fresh.sweeps),
              sponsored: prev.sponsored > fresh.sponsored ? prev.sponsored : fresh.sponsored,
            }
          : fresh,
      );

      const shown = all.slice(0, limit);

      // Ages, for the newest rows only — not every row shown. Each one is a separate
      // `getBlock` call, and this panel polls every 20 seconds for as long as the tab is
      // open: at `limit=100` that is 100 extra RPC calls a poll, against the same public
      // endpoint that has already rate-limited this project once. Age matters most where
      // "36s ago" reads as live; a hundred rows deep, the block number already on the row
      // says everything an exact age would, and {formatAge} already falls back to an
      // em dash when `.at` is missing, so scrolling that far costs nothing broken.
      const AGE_LOOKUP_LIMIT = 20;
      await Promise.all(
        shown.slice(0, AGE_LOOKUP_LIMIT).map(async (r) => {
          try {
            const b = await publicClient.getBlock({ blockNumber: r.block });
            r.at = Number(b.timestamp);
          } catch {
            /* a missing age costs one line, not the panel */
          }
        }),
      );

      setRows(shown);
    } catch {
      setRows([]);
    }
  }, [limit, publicClient]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="panel">
      <div className="panelHead">
        <span>
          <span className="liveDot" /> CONTRACT LOG
        </span>
        <span>{head ? `BLOCK ${head.toLocaleString()}` : "READING…"}</span>
      </div>

      {stats && (
        <div className={styles.stats}>
          {/* Only figures backed by contract state survive here. Deposits made, claims
              checked and sponsorship totals were counted from logs, and this endpoint
              answers the same log query from nodes holding different history — so those
              three changed on every reload and sometimes read 1. They are still visible
              as rows in the feed below, where a partial list is obviously a recent slice
              rather than a total that happens to be wrong. */}
          <Stat k="IN THE POOL" v={depositors === undefined ? "—" : String(depositors)} />
          <Stat k="DRAWS SETTLED" v={drawsSettled === undefined ? "—" : String(drawsSettled)} />
          <Stat k="PAID OUT" v={paid === undefined ? "—" : formatUnits(paid)} gold />
        </div>
      )}

      <div className={styles.feed}>
        {rows === undefined && <div className={styles.empty}>Reading the chain…</div>}
        {rows?.length === 0 && <div className={styles.empty}>No events yet.</div>}

        {rows?.map((r, i) => (
          <div key={`${r.hash}-${i}`} className={styles.row}>
            <span className={r.accent ? `${styles.dot} ${styles.dotOn}` : styles.dot} />
            <div className={styles.rowBody}>
              <div className={r.accent ? `${styles.headline} ${styles.headlineOn}` : styles.headline}>{r.headline}</div>
              <div className={styles.meta}>
                <span>{r.kind}</span>
                <span>{r.block.toLocaleString()}</span>
                <span>
                  {r.hash.slice(0, 6)}…{r.hash.slice(-4)}
                </span>
              </div>
            </div>
            <span className={styles.age}>{r.at === undefined ? "—" : formatAge(now() - r.at)}</span>
          </div>
        ))}
      </div>

      <div className={styles.foot}>
        Every row is public and always was. Note what is absent: no amount on a confidential deposit, and no winner on
        any settlement, because there is no winner field in storage for a log to carry.
      </div>
    </section>
  );
}

function Stat({ k, v, gold }: { k: string; v: string; gold?: boolean }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statK}>{k}</div>
      <div className={`num ${styles.statV}`} style={{ color: gold ? "var(--yellow)" : undefined }}>
        {v}
      </div>
    </div>
  );
}

const now = () => Math.floor(Date.now() / 1000);

function formatAge(s: number) {
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
