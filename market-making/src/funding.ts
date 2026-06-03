import { createInterface } from "node:readline";

import { formatEther, formatUnits, type PublicClient } from "viem";

import { tokenAbi } from "./abi.js";
import type { Balances, FundingRequirement, Hex, RoundContext } from "./types.js";

/**
 * You need MON for gas, plus a positive balance of each token the round uses (so your venue can quote
 * both directions). The exact CASH/ASSET amount is up to you — the round's initial capital is only a
 * recommendation surfaced in the gate.
 */
export function computeFundingRequirement(ctx: RoundContext, monForGasWei: bigint): FundingRequirement {
  return {
    monWei: monForGasWei,
    needsCash: ctx.initialCash > 0n,
    needsAsset: ctx.initialAsset > 0n,
  };
}

/** True once MON clears the gas floor and every token the round uses has a positive balance. */
export function meetsRequirement(bal: Balances, req: FundingRequirement): boolean {
  return (
    bal.monWei >= req.monWei && (!req.needsCash || bal.cashWad > 0n) && (!req.needsAsset || bal.assetWad > 0n)
  );
}

export async function readBalances(
  client: PublicClient,
  address: Hex,
  cashToken: Hex,
  assetToken: Hex,
): Promise<Balances> {
  const [cashWad, assetWad, monWei] = await Promise.all([
    client.readContract({ address: cashToken, abi: tokenAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
    client.readContract({ address: assetToken, abi: tokenAbi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
    client.getBalance({ address }),
  ]);
  return { cashWad, assetWad, monWei };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FundingGateDeps {
  client: PublicClient;
  address: Hex;
  ctx: RoundContext;
  req: FundingRequirement;
  log: (message: string) => void;
  pollMs?: number;
  assumeFunded?: boolean;
}

/**
 * Print funding instructions, then wait until your address is funded. The gate auto-detects funding
 * by polling balances; or press Enter to continue regardless. `assumeFunded` skips the gate entirely.
 */
export async function waitForFunding(deps: FundingGateDeps): Promise<void> {
  const { client, address, ctx, req, log } = deps;
  const pollMs = deps.pollMs ?? 5_000;

  if (deps.assumeFunded) {
    log("--assume-funded: skipping the funding gate.");
    return;
  }

  log("");
  log("Have the organizer fund this address before the bot continues.");
  log(
    `Gate: MON >= ${formatEther(req.monWei)}` +
      `${req.needsCash ? ", CASH > 0" : ""}${req.needsAsset ? ", ASSET > 0" : ""} (any amount).`,
  );
  log(`  address : ${address}`);
  if (req.needsCash) {
    log(`  CASH    : any > 0   (recommended ${formatUnits(ctx.initialCash, 18)} — the round's initial)`);
  }
  if (req.needsAsset) {
    log(`  ASSET   : any > 0   (recommended ${formatUnits(ctx.initialAsset, 18)})`);
  }
  log(`  MON     : >= ${formatEther(req.monWei)}   (for gas)`);
  log(`  round   : #${ctx.round}  CASH=${ctx.cashToken}  ASSET=${ctx.assetToken}`);
  log("Polling balances… (or press Enter to continue regardless)");

  let manualContinue = false;
  const rl = createInterface({ input: process.stdin });
  rl.on("line", () => {
    manualContinue = true;
  });

  try {
    for (;;) {
      let bal: Balances;
      try {
        bal = await readBalances(client, address, ctx.cashToken, ctx.assetToken);
      } catch (error) {
        log(`  (balance read failed, retrying: ${error instanceof Error ? error.message : String(error)})`);
        await sleep(pollMs);
        continue;
      }
      const ok = meetsRequirement(bal, req);
      log(
        `  have CASH=${formatUnits(bal.cashWad, 18)} ASSET=${formatUnits(bal.assetWad, 18)} ` +
          `MON=${formatEther(bal.monWei)} -> ${ok ? "funded ✓" : "waiting"}`,
      );
      if (ok) {
        log("Funding detected — continuing.");
        return;
      }
      if (manualContinue) {
        log("Manual override — continuing despite unmet thresholds.");
        return;
      }
      await sleep(pollMs);
    }
  } finally {
    rl.close();
  }
}
