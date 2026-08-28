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
 * changed — the obvious thing to do — threw away the evidence that it had run at all. You
 * came back to an empty log and a progress counter reading 0/6 on a pool you had just
 * swept. That reads as the console losing your work, and on a page whose entire job is to
 * demonstrate that the protocol is trustworthy, it is close to the worst possible bug.
 *
 * Kept per pool, because the sandbox and the real deployment are different runs and
 * mixing their histories would be its own kind of lie. Nothing here is confidential —
 * function names, gas, and transaction hashes are all public the moment they are mined.
 */
const KEY = `hushpot.judge.${POOL_ADDRESS.slice(2, 10)}`;
const LIMIT = 40;

type Stored = { log: LogEntry[]; done: string[] };

function read(): Stored {
  if (typeof window === "undefined") return { log: [], done: [] };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { log: [], done: [] };
    const parsed = JSON.parse(raw) as Stored;
    return { log: parsed.log ?? [], done: parsed.done ?? [] };
  } catch {
    return { log: [], done: [] };
  }
}

export function useJudgeSession() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  // Restored after mount, never during SSR — the server has no localStorage, and a first
  // client render that disagreed with it would be a hydration mismatch.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = read();
    setLog(stored.log);
    setDone(new Set(stored.done));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ log, done: [...done] }));
    } catch {
      /* a full or disabled store costs the history, not the console */
    }
  }, [ready, log, done]);

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
