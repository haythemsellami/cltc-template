import { strict as assert } from "node:assert";
import { test } from "node:test";

import { shouldRequote } from "../src/quoter.js";
import type { QuoterState } from "../src/types.js";

const opts = { requoteSecs: 15, requoteBps: 15 };

test("never quote without a live price", () => {
  const state: QuoterState = { lastFeedPriceWad: 100n, lastQuoteMs: 0, quoteCount: 1 };
  assert.equal(shouldRequote(state, 1_000_000, null, opts), false);
  assert.equal(shouldRequote(state, 1_000_000, 0n, opts), false);
});

test("always quote the first time", () => {
  const state: QuoterState = { lastFeedPriceWad: null, lastQuoteMs: null, quoteCount: 0 };
  assert.equal(shouldRequote(state, 1_000, 100n, opts), true);
});

test("re-quote after the time threshold even when flat", () => {
  const price = 100_000n * 10n ** 18n;
  const state: QuoterState = { lastFeedPriceWad: price, lastQuoteMs: 0, quoteCount: 1 };
  assert.equal(shouldRequote(state, 14_000, price, opts), false); // 14s < 15s, flat
  assert.equal(shouldRequote(state, 15_000, price, opts), true); // 15s elapsed
});

test("re-quote on a price move past the bps threshold", () => {
  const last = 100_000n * 10n ** 18n;
  const state: QuoterState = { lastFeedPriceWad: last, lastQuoteMs: 10_000, quoteCount: 1 };
  const now = 11_000; // only 1s elapsed -> time threshold not hit
  const tinyMove = last + (last * 10n) / 10_000n; // +10 bps < 15 bps
  const bigMove = last + (last * 20n) / 10_000n; // +20 bps >= 15 bps
  assert.equal(shouldRequote(state, now, tinyMove, opts), false);
  assert.equal(shouldRequote(state, now, bigMove, opts), true);
  // symmetric on the downside
  const bigDrop = last - (last * 20n) / 10_000n;
  assert.equal(shouldRequote(state, now, bigDrop, opts), true);
});
