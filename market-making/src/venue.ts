import type { PublicClient, WalletClient } from "viem";

import { registryAbi, tokenAbi, venueAbi, venueBytecode } from "./abi.js";
import type { Hex, RoundContext } from "./types.js";

/** Constructor args for `CompetitionPropAMM`, in the order the Solidity constructor expects. */
export type VenueConstructorArgs = readonly [
  string, // teamName_
  Hex, // cash_
  Hex, // asset_
  Hex, // teamOwner_
];

/**
 * Build the venue constructor args. The venue takes no quote in its constructor — it deploys
 * un-quoted, and the first `updatePrice` (see `pushQuote`) makes it live.
 */
export function buildVenueConstructorArgs(teamName: string, owner: Hex, ctx: RoundContext): VenueConstructorArgs {
  return [teamName, ctx.cashToken, ctx.assetToken, owner];
}

export interface DeployedVenue {
  address: Hex;
  blockNumber: bigint;
}

/**
 * Throw if a mined tx actually reverted — `waitForTransactionReceipt` resolves either way, so
 * without this a reverted register/fund would be reported as success and fail silently downstream.
 */
function assertSuccess(receipt: { status: string }, what: string): void {
  if (receipt.status !== "success") {
    throw new Error(`${what} transaction reverted on-chain`);
  }
}

/** Deploy a CompetitionPropAMM from the Foundry build bytecode and return its address + deploy block. */
export async function deployVenue(
  wallet: WalletClient,
  client: PublicClient,
  args: VenueConstructorArgs,
): Promise<DeployedVenue> {
  const hash = await wallet.deployContract({
    abi: venueAbi,
    bytecode: venueBytecode,
    args,
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assertSuccess(receipt, "venue deploy");
  if (!receipt.contractAddress) {
    throw new Error("venue deploy mined but produced no contract address");
  }
  return { address: receipt.contractAddress as Hex, blockNumber: receipt.blockNumber };
}

/** Read a venue's owner — used to pre-check the VENUE reuse path before registering. */
export async function readVenueOwner(client: PublicClient, venue: Hex): Promise<Hex> {
  return (await client.readContract({ address: venue, abi: venueAbi, functionName: "owner" })) as Hex;
}

/**
 * Move CASH + ASSET inventory from your EOA into the venue (self-custody: the venue pays swaps out of
 * its own balance, so it needs both sides). Transfers `fundFractionBps` of each current balance.
 */
export async function fundVenue(
  wallet: WalletClient,
  client: PublicClient,
  venue: Hex,
  ctx: RoundContext,
  cashBalanceWad: bigint,
  assetBalanceWad: bigint,
  fundFractionBps: number,
): Promise<{ cashMoved: bigint; assetMoved: bigint }> {
  const frac = BigInt(Math.max(0, Math.min(10_000, Math.floor(fundFractionBps))));
  const cashMoved = (cashBalanceWad * frac) / 10_000n;
  const assetMoved = (assetBalanceWad * frac) / 10_000n;

  for (const [token, amount] of [
    [ctx.cashToken, cashMoved],
    [ctx.assetToken, assetMoved],
  ] as const) {
    if (amount <= 0n) {
      continue;
    }
    const hash = await wallet.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "transfer",
      args: [venue, amount],
      account: wallet.account!,
      chain: wallet.chain,
    });
    assertSuccess(await client.waitForTransactionReceipt({ hash }), "inventory transfer");
  }
  return { cashMoved, assetMoved };
}

/**
 * Enroll your EOA on the competition roster under your team name (idempotent — calling again just
 * updates the name). The registry requires enrollment before `registerVenue`, and the organizer's
 * funding flow keys off the roster. Skipped when already enrolled (e.g. you registered on the
 * maker site first) so we don't overwrite a name you picked there.
 */
export async function ensureMarketMakerRegistered(
  wallet: WalletClient,
  client: PublicClient,
  registry: Hex,
  teamName: string,
): Promise<boolean> {
  const enrolled = (await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "isMarketMaker",
    args: [wallet.account!.address],
  })) as boolean;
  if (enrolled) {
    return false;
  }
  const hash = await wallet.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: "registerMarketMaker",
    args: [teamName],
    account: wallet.account!,
    chain: wallet.chain,
  });
  assertSuccess(await client.waitForTransactionReceipt({ hash }), "registerMarketMaker");
  return true;
}

/** Register the venue under your EOA in the organizer's CompetitionRegistry (owner check passes). */
export async function registerVenue(
  wallet: WalletClient,
  client: PublicClient,
  registry: Hex,
  venue: Hex,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: "registerVenue",
    args: [venue],
    account: wallet.account!,
    chain: wallet.chain,
  });
  assertSuccess(await client.waitForTransactionReceipt({ hash }), "registerVenue");
  return hash;
}

/** Push a fresh quote: `updatePrice(fairPrice, validUntil)`. Awaits the receipt. */
export async function pushQuote(
  wallet: WalletClient,
  client: PublicClient,
  venue: Hex,
  fairPriceWad: bigint,
  validUntilSec: bigint,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: venue,
    abi: venueAbi,
    functionName: "updatePrice",
    args: [fairPriceWad, validUntilSec],
    account: wallet.account!,
    chain: wallet.chain,
  });
  assertSuccess(await client.waitForTransactionReceipt({ hash }), "updatePrice");
  return hash;
}

/** Pull the venue's full CASH + ASSET balance back to the EOA (owner-only `withdraw`). */
export async function withdrawAll(
  wallet: WalletClient,
  client: PublicClient,
  venue: Hex,
  to: Hex,
  ctx: RoundContext,
): Promise<void> {
  for (const token of [ctx.cashToken, ctx.assetToken]) {
    const balance = (await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [venue],
    })) as bigint;
    if (balance <= 0n) {
      continue;
    }
    const hash = await wallet.writeContract({
      address: venue,
      abi: venueAbi,
      functionName: "withdraw",
      args: [token, to, balance],
      account: wallet.account!,
      chain: wallet.chain,
    });
    assertSuccess(await client.waitForTransactionReceipt({ hash }), "withdraw");
  }
}

/** Count Swap events the venue has served since `fromBlock` — a quick "did takers hit me" summary. */
export async function countSwaps(client: PublicClient, venue: Hex, fromBlock: bigint): Promise<number> {
  try {
    const logs = await client.getContractEvents({ address: venue, abi: venueAbi, eventName: "Swap", fromBlock });
    return logs.length;
  } catch {
    return -1; // unknown (RPC range limit, etc.)
  }
}
