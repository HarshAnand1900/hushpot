/** Thirty days, matching the contract's `CLAIM_GRACE`. */
export const CLAIM_GRACE_SECONDS = 30 * 24 * 60 * 60;

/** Matches the contract's `MAX_HISTORY`: how many periods of weights the tree can answer. */
export const MAX_HISTORY = 5;

/**
 * Whether the pool would still answer a claim for a draw.
 *
 * Mirrors the contract's own test, in `checkClaim` and `sweepRange`:
 *
 *     if (block.timestamp > d.settledAt + CLAIM_GRACE) revert ClaimWindowClosed();
 *     if (currentPeriod > d.period + MAX_HISTORY) revert ClaimWindowClosed();
 *
 * Thirty days of wall-clock time, not a count of rolls. Four different places in this app
 * tested `drawPeriod === currentPeriod` — the rule from before the tree kept history — and
 * so called a draw closed while the chain would happily have paid it out. One function
 * now, so the interface and the contract cannot drift apart again.
 *
 * `settledAt` is what actually decides it. The period test is the tree's reach rather than
 * a second policy, and it is the fallback while the timestamp is still loading: a draw
 * inside `MAX_HISTORY` is the most optimistic honest answer, and it is the one the chain
 * gives at the seven-day cadence.
 */
export function isClaimable(drawPeriod: number, currentPeriod: number, settledAt?: number, now?: number): boolean {
  if (currentPeriod > drawPeriod + MAX_HISTORY) return false;
  if (settledAt === undefined) return true;
  const at = now ?? Math.floor(Date.now() / 1000);
  return at <= settledAt + CLAIM_GRACE_SECONDS;
}
