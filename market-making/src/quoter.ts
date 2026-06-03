import type { QuoterState } from "./types.js";

export interface RequoteOpts {
  requoteSecs: number;
  requoteBps: number;
}

/**
 * Decide whether to push a fresh quote this tick (cadence only — your *price* is in strategy.ts).
 * Re-quote when:
 *   - there's no live price yet            -> no (can't quote),
 *   - we've never quoted                   -> yes (first quote),
 *   - `requoteSecs` elapsed since the last -> yes (refresh the TTL before it expires), or
 *   - the price moved at least `requoteBps` since the last quoted price.
 */
export function shouldRequote(
  state: QuoterState,
  nowMs: number,
  latestPriceWad: bigint | null,
  opts: RequoteOpts,
): boolean {
  if (latestPriceWad === null || latestPriceWad <= 0n) {
    return false;
  }
  if (state.lastFeedPriceWad === null || state.lastQuoteMs === null) {
    return true;
  }
  if (nowMs - state.lastQuoteMs >= opts.requoteSecs * 1_000) {
    return true;
  }
  const last = state.lastFeedPriceWad;
  const diff = latestPriceWad > last ? latestPriceWad - last : last - latestPriceWad;
  const moveBps = (diff * 10_000n) / last;
  return moveBps >= BigInt(Math.max(0, Math.floor(opts.requoteBps)));
}
