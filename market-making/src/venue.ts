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

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Max-approve the venue for CASH and ASSET so it can settle swaps against your wallet — your
 * inventory never leaves your EOA. Idempotent: a token whose allowance is already effectively
 * unlimited is skipped, so re-running (or reusing a venue) costs nothing. Returns how many
 * approvals were actually sent.
 */
export async function approveVenueAllowances(
  wallet: WalletClient,
  client: PublicClient,
  venue: Hex,
  ctx: RoundContext,
): Promise<number> {
  let sent = 0;
  for (const token of [ctx.cashToken, ctx.assetToken]) {
    const current = (await client.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "allowance",
      args: [wallet.account!.address, venue],
    })) as bigint;
    if (current >= MAX_UINT256 / 2n) {
      continue; // already effectively unlimited
    }
    const hash = await wallet.writeContract({
      address: token,
      abi: tokenAbi,
      functionName: "approve",
      args: [venue, MAX_UINT256],
      account: wallet.account!,
      chain: wallet.chain,
    });
    assertSuccess(await client.waitForTransactionReceipt({ hash }), "venue approval");
    sent += 1;
  }
  return sent;
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

/** Count Swap events the venue has served since `fromBlock` — a quick "did takers hit me" summary. */
export async function countSwaps(client: PublicClient, venue: Hex, fromBlock: bigint): Promise<number> {
  try {
    const logs = await client.getContractEvents({ address: venue, abi: venueAbi, eventName: "Swap", fromBlock });
    return logs.length;
  } catch {
    return -1; // unknown (RPC range limit, etc.)
  }
}
