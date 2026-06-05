import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sameRoundContext } from "../src/manifest.js";
import type { Hex, RoundContext } from "../src/types.js";

const addr = (h: string) => ("0x" + h.padEnd(40, "0")) as Hex;

const CTX: RoundContext = {
  round: 1,
  registry: addr("f"),
  monoper: addr("d"),
  cashToken: addr("c"),
  assetToken: addr("a"),
  initialCash: 1n,
  initialAsset: 1n,
};

test("sameRoundContext: identical (case-insensitive) contexts match", () => {
  assert.equal(sameRoundContext(CTX, { ...CTX }), true);
  assert.equal(sameRoundContext(CTX, { ...CTX, registry: CTX.registry.toUpperCase().replace("0X", "0x") as Hex }), true);
});

test("sameRoundContext: a redeploy or round change is detected", () => {
  assert.equal(sameRoundContext(CTX, { ...CTX, registry: addr("1") }), false); // fresh registry
  assert.equal(sameRoundContext(CTX, { ...CTX, monoper: addr("2") }), false); // fresh monoper
  assert.equal(sameRoundContext(CTX, { ...CTX, round: 2, cashToken: addr("3") }), false); // new round
});

// ── round gate + feed state (stubbed fetch) ──────────────────────────────────────────────────────

import { fetchFeedState, waitForRoundContext } from "../src/manifest.js";

const realFetch = globalThis.fetch;

function manifestJson(activeRound: number | null): unknown {
  return {
    chainId: 10143,
    registry: addr("f"),
    monoper: addr("d"),
    arbExecutor: null,
    deployer: addr("e"),
    deployedAtIso: "2026-01-01T00:00:00Z",
    deploymentBlock: "1",
    rounds: [{ round: 1, cashToken: addr("c"), assetToken: addr("a"), initialCash: "1", initialAsset: "1", createdAtIso: "2026-01-01T00:00:00Z" }],
    activeRound,
  };
}

test("waitForRoundContext keeps polling until a round goes active, logging each distinct reason once", async () => {
  const responses: unknown[] = [null, manifestJson(null), manifestJson(1)];
  let call = 0;
  globalThis.fetch = (async () => {
    const body = call < responses.length ? responses[call] : manifestJson(1);
    call += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const logs: string[] = [];
  try {
    const ctx = await waitForRoundContext("http://op", (m) => logs.push(m), 1);
    assert.equal(ctx.round, 1);
    assert.equal(ctx.registry.toLowerCase(), addr("f").toLowerCase());
    // Two distinct wait reasons (no manifest, then no active round), each logged once.
    assert.equal(logs.filter((l) => l.startsWith("waiting:")).length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchFeedState returns the round's market identity, and null when idle or unreachable", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        subscribers: 2,
        activeRound: { round: 1, mode: "synthetic", startedAtMs: 1, paused: false, speed: 4, virtualMs: 0, emitted: 9, loops: 0, symbol: "btcusdt", streams: ["btcusdt@aggTrade"] },
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const state = await fetchFeedState("http://op");
    assert.ok(state);
    assert.equal(state.symbol, "btcusdt");
    assert.deepEqual(state.streams, ["btcusdt@aggTrade"]);
    assert.equal(state.speed, 4);

    globalThis.fetch = (async () => new Response(JSON.stringify({ subscribers: 0, activeRound: null }), { status: 200 })) as typeof fetch;
    assert.equal(await fetchFeedState("http://op"), null);

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    assert.equal(await fetchFeedState("http://op"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
