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
