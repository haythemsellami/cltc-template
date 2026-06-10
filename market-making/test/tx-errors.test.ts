import assert from "node:assert/strict";
import test from "node:test";

import { BaseError, ContractFunctionRevertedError, InsufficientFundsError, encodeErrorResult } from "viem";

import { registryAbi } from "../src/abi.js";
import { explainTxError } from "../src/tx-errors.js";

test("explainTxError: a custom revert decodes to its error name + args", () => {
  const data = encodeErrorResult({
    abi: registryAbi,
    errorName: "NotVenueOwner",
    args: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
  });
  const reverted = new ContractFunctionRevertedError({ abi: registryAbi, functionName: "registerVenue", data });
  const wrapped = new BaseError("registerVenue failed", { cause: reverted });
  const msg = explainTxError(wrapped, "registerVenue");
  assert.match(msg, /registerVenue reverted: NotVenueOwner\(0x1111/u);
});

test("explainTxError: insufficient funds becomes the out-of-MON hint", () => {
  const wrapped = new BaseError("tx failed", { cause: new InsufficientFundsError() });
  const msg = explainTxError(wrapped, "updatePrice", "0xBot");
  assert.match(msg, /updatePrice failed: out of MON gas — top up 0xBot/u);
});

test("explainTxError: other viem errors collapse to the short message; plain errors pass through", () => {
  const base = new BaseError("something exploded", { details: "very long dump ".repeat(50) });
  assert.equal(explainTxError(base, "deploy"), `deploy failed: ${base.shortMessage}`);
  assert.equal(explainTxError(new Error("boom"), "deploy"), "deploy failed: boom");
});
