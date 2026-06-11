// ─────────────────────────────────────────────────────────────────────────────────────────────
//  YOUR OFF-CHAIN PRICING LIVES HERE — the easiest place to start adding an edge.
//  (You can also customize the on-chain venue itself in ../contracts — both surfaces count.)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//  Every quote cycle the bot calls `decideFairPrice(tick)` and pushes the result on-chain via
//  `updatePrice(fairPrice, validUntil)`. With the reference venue, swaps fill at a default 20 bps
//  spread around that mid (buyers pay the ask, sellers hit the bid; retune on-chain via
//  `setSpreadBps`). The off-chain scorer marks your CASH + ASSET inventory at the official feed
//  price, so your PnL is driven by what price you quote relative to the market:
//
//    • quote ABOVE the feed  → you sell ASSET dear / buy it cheap, but informed takers pick you off
//    • quote BELOW the feed  → you fill more flow, but give up edge
//    • quote AT the feed      → the neutral baseline (the default below)
//
//  Prices are WAD-scaled: 1e18 == 1.0 CASH per ASSET. Helpers below keep the bigint math readable.
//
//  Edit surfaces: THIS file (price), src/quoter.ts (when to re-quote), the .env knobs, and the
//  venue contract in ../contracts. Everything else in src/ is competition plumbing (feed, manifest,
//  registration, funding, lifecycle) — see the KEEP-AS-IS banners in those files.
//
//  MORE SIGNAL — the organizer's PUBLIC DATA API (no auth, plain JSON at OPERATOR_API_URL):
//  the live trade tape (/api/tape — order-flow imbalance), per-maker flow share (/api/flow),
//  rivals' quotes + inventory (/api/market-makers), their quote quality (/api/quote-stats), depth
//  ladders (/api/depth), and WHY the router skipped your venue (/api/router/venues). Full table
//  with strategy hints: README.md → "Public data API". `decideFairPrice` is sync — poll the API
//  from your own loop (e.g. a setInterval in this file caching into module state) and read the
//  cache here. Quoting blind concedes this edge to everyone who doesn't.

/** Everything you know at quote time. Extend the bot if you want more signals (e.g. your inventory). */
export interface MarketTick {
  /** Latest official feed price (WAD CASH per ASSET). Always present when this is called. */
  feedPriceWad: bigint;
  /** Recent feed prices, oldest → newest (a rolling window), for momentum / volatility. */
  recentPricesWad: readonly bigint[];
  /** Your previous quoted fairPrice, or null before your first quote. */
  lastQuotedPriceWad: bigint | null;
  /** Whether a round is currently live (vs. idle between rounds). */
  roundActive: boolean;
}

/**
 * Decide the fair price your venue advertises this tick. Return a WAD-scaled CASH-per-ASSET price.
 *
 * DEFAULT: quote exactly at the feed (a flat, neutral market maker). Replace this with your edge.
 */
export function decideFairPrice(tick: MarketTick): bigint {
  return tick.feedPriceWad;

  // ── Example ideas (delete the early return above to use one) ──────────────────────────────────
  //
  // 1) Skew by a fixed number of basis points (e.g. quote 5 bps under the feed to win more flow):
  //      return applyBps(tick.feedPriceWad, -5);
  //
  // 2) Lean against short-term momentum — if the last few ticks rose, quote slightly rich so you
  //    don't sell ASSET into a rally too cheap:
  //      const mom = momentumBps(tick.recentPricesWad, 8); // bps change over the last ~8 ticks
  //      return applyBps(tick.feedPriceWad, clamp(mom / 4, -25, 25));
  //
  // 3) Smooth your quote toward the feed to avoid chasing every tick:
  //      if (tick.lastQuotedPriceWad === null) return tick.feedPriceWad;
  //      return (tick.lastQuotedPriceWad + tick.feedPriceWad) / 2n;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Shift a WAD price by `bps` basis points (positive = richer, negative = cheaper). */
export function applyBps(priceWad: bigint, bps: number): bigint {
  const b = BigInt(Math.trunc(bps));
  return (priceWad * (10_000n + b)) / 10_000n;
}

/** Signed bps change of the feed over the last `lookback` ticks (oldest vs. newest in the window). */
export function momentumBps(recentPricesWad: readonly bigint[], lookback: number): number {
  if (recentPricesWad.length < 2) {
    return 0;
  }
  const newest = recentPricesWad[recentPricesWad.length - 1]!;
  const idx = Math.max(0, recentPricesWad.length - 1 - Math.max(1, lookback));
  const old = recentPricesWad[idx]!;
  if (old === 0n) {
    return 0;
  }
  return Number(((newest - old) * 10_000n) / old);
}

/** Clamp a number to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
