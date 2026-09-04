"use client";

import { useCallback, useEffect, useState } from "react";

import { POOL_ADDRESS } from "@/lib/contract";

export type LogEntry = {
  call: string;
  note: string;
  ok: boolean;
  /** Present on anything that actually reached the chain, so a row can be checked. */
  hash?: string;
  /** Epoch millis, for a wall-clock stamp that survives a reload. */
  at: number;
};

/**
 * The judge console's record of what you have run, kept across navigation.
 *
 * It was React state, which meant switching to the Pool tab to look at what a step had
 * changed - the obvious thing to do - threw away the evidence that it had run at all. You
 * came back to an empty log and a progress counter reading 0/6 on a pool you had just
 * swept. That reads as the console losing your work, and on a page whose entire job is to
 * demonstrate that the protocol is trustworthy, it is close to the worst possible bug.
 *
 * Kept per pool, because the sandbox and the real deployment are different runs and
 * mixing their histories would be its own kind of lie. Nothing here is confidential -
 * function names, gas, and transaction hashes are all public the moment they are mined.
 */
const KEY = `hushpot.judge.${POOL_ADDRESS.slice(2, 10)}`;
const LIMIT = 40;

type Stored = { log: LogEntry[]; done: string[]; cycle?: number };

function read(): Stored {
  if (typeof window === "undefined") return { log: [], done: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { log: [], done: [] };
    const parsed = JSON.parse(raw) as Stored;
    return { log: parsed.log ?? [], done: parsed.done ?? [], cycle: parsed.cycle };
  } catch {
    return { log: [], done: [] };
  }
}

/**
 * @param cycle the pool's `currentPeriod`. Completion marks belong to one turn of the
 *   cycle, so when the period rolls they have to go; the log is history and stays.
 * @param settled whether pool state has actually loaded. Before it has, `cycle` reads 0,
 *   which would look like a roll back to the first period and wipe a live cycle's marks.
 */
export function useJudgeSession(cycle: number, settled: boolean) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [storedCycle, setStoredCycle] = useState<number>();
  // Restored after mount, never during SSR - the server has no localStorage, and a first
  // client render that disagreed with it would be a hydration mismatch.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = read();
    setLog(stored.log);
    setDone(new Set(stored.done));
    setStoredCycle(stored.cycle);
    setReady(true);
  }, []);

  /**
   * Rolling the period starts the cycle over, so the console has to as well.
   *
   * Without this every step still read DONE on a pool that had just opened a fresh week,
   * with a progress counter stuck at 6/6 and Run buttons that were in fact live. The
   * console was describing the cycle you had finished, not the one you were in, which is
   * indistinguishable from a page that has failed to update.
   */
  useEffect(() => {
    if (!ready || !settled) return;
    if (storedCycle === cycle) return;
    // Only ever forward. `_advancePeriod` increments and never decrements, so a lower
    // number is not a roll - it is a failed read falling back to its default, and acting
    // on it would wipe a live cycle's progress over a momentary RPC hiccup.
    if (storedCycle !== undefined && cycle < storedCycle) return;
    if (storedCycle !== undefined) setDone(new Set());
    setStoredCycle(cycle);
  }, [ready, settled, cycle, storedCycle]);

  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ log, done: [...done], cycle: storedCycle }));
    } catch {
      /* a full or disabled store costs the history, not the console */
    }
  }, [ready, log, done, storedCycle]);

  const append = useCallback((entry: Omit<LogEntry, "at">) => {
    setLog((l) => [{ ...entry, at: Date.now() }, ...l].slice(0, LIMIT));
  }, []);

  const complete = useCallback((id: string) => setDone((d) => new Set(d).add(id)), []);

  const clear = useCallback(() => {
    setLog([]);
    setDone(new Set());
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* the state is already cleared; the store catching up is a nicety */
    }
  }, []);

  return { log, done, append, complete, clear, ready };
}
