import { strict as assert } from "node:assert";
import { test } from "node:test";

import { applyBps, clamp, decideFairPrice, momentumBps, type MarketTick } from "../src/strategy.js";

const WAD = 10n ** 18n;

function tick(over: Partial<MarketTick> = {}): MarketTick {
  return {
    feedPriceWad: 1_000n * WAD,
    recentPricesWad: [],
    lastQuotedPriceWad: null,
    roundActive: true,
    ...over,
  };
}

test("default strategy mirrors the feed price", () => {
  assert.equal(decideFairPrice(tick({ feedPriceWad: 65_000n * WAD })), 65_000n * WAD);
});

test("applyBps shifts a WAD price up and down", () => {
  assert.equal(applyBps(10_000n * WAD, 100), (10_000n * WAD * 10_100n) / 10_000n); // +1%
  assert.equal(applyBps(10_000n * WAD, -50), (10_000n * WAD * 9_950n) / 10_000n); // -0.5%
  assert.equal(applyBps(10_000n * WAD, 0), 10_000n * WAD);
});

test("momentumBps reports signed change across the window", () => {
  // +2% over the window
  const rising = [100n * WAD, 101n * WAD, 102n * WAD];
  assert.equal(momentumBps(rising, 2), 200);
  // symmetric on the downside
  const falling = [100n * WAD, 99n * WAD, 98n * WAD];
  assert.equal(momentumBps(falling, 2), -200);
  // too few points -> flat
  assert.equal(momentumBps([100n * WAD], 5), 0);
});

test("clamp bounds a value", () => {
  assert.equal(clamp(30, -25, 25), 25);
  assert.equal(clamp(-30, -25, 25), -25);
  assert.equal(clamp(10, -25, 25), 10);
});
