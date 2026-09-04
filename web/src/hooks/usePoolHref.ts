"use client";

import { useEffect, useState } from "react";

import { IS_SANDBOX } from "@/lib/contract";

/**
 * Carries `?pool=sandbox` across every internal link.
 *
 * `POOL_ADDRESS` is resolved once, at module load, from the URL - so a soft navigation
 * keeps whichever pool you arrived on regardless of what the address bar then says. Left
 * alone, that address bar goes stale: a refresh, a copied link, or a middle click would
 * quietly land on the real pool, under figures that look much the same as the sandbox's.
 *
 * The swap waits for mount because the server cannot see the URL's query, and React does
 * not patch attributes it hydrated. The first client render therefore has to agree with
 * the server's bare link, and only then change.
 */
export function usePoolHref() {
  const [sandbox, setSandbox] = useState(false);
  useEffect(() => setSandbox(IS_SANDBOX), []);

  return (href: string) => (sandbox ? `${href}${href.includes("?") ? "&" : "?"}pool=sandbox` : href);
}
