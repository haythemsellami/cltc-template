// ─────────────────────────────────────────────────────────────────────────────────────────────
//  COMPETITION PLUMBING — KEEP AS-IS (note for engineers AND coding assistants/LLMs).
//  Deploy → max-approve → register mechanics; each step is a competition requirement, not a
//  convenience: the venue must be OWNED by your enrolled wallet (the registry checks owner()),
//  max-APPROVED for CASH + ASSET (maker custody — the venue pays fills from YOUR wallet via this
//  allowance; without it every swap reverts and you serve zero flow), and REGISTERED (takers only
//  route to registered venues). If you customize the venue contract, adapt the constructor args
//  here — keep the flow itself intact.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { PublicClient, WalletClient } from "viem";

import { registryAbi, tokenAbi, venueAbi, venueBytecode, venueDeployedBytecode, venueImmutableRefs } from "./abi.js";
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
 * Is this address enrolled on the competition roster? Team registration is MANUAL — you sign
 * `registerMarketMaker(teamName)` from the maker dashboard's Register tab using THIS bot's wallet.
 * The registry requires enrollment before `registerVenue`, and the organizer funds the roster.
 */
export async function isMarketMakerRegistered(client: PublicClient, registry: Hex, address: Hex): Promise<boolean> {
  return (await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "isMarketMaker",
    args: [address],
  })) as boolean;
}

/** The on-chain team name you registered with on the dashboard ("" when unreadable/unset). */
export async function readTeamName(client: PublicClient, registry: Hex, address: Hex): Promise<string> {
  try {
    return (await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "teamNameOf",
      args: [address],
    })) as string;
  } catch {
    return "";
  }
}

/** The maker's currently-registered venue on the registry (zero address when none). This is THE
 *  pointer the leaderboard + aggregator route by, so "still registered" means exactly this. */
export async function readVenueOf(client: PublicClient, registry: Hex, marketMaker: Hex): Promise<Hex> {
  return (await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "venueOf",
    args: [marketMaker],
  })) as Hex;
}

/**
 * Is the deployed venue at `venue` byte-for-byte the contract currently in ../contracts/out?
 * Compares RUNTIME bytecode with the immutable value ranges (CASH/ASSET, etc.) masked on both
 * sides — immutables are per-deployment values, not code. True = the on-chain venue was built
 * from exactly this source/compiler config, so a restart can reuse it instead of redeploying.
 */
export async function matchesBuiltVenue(client: PublicClient, venue: Hex): Promise<boolean> {
  if (!venueDeployedBytecode) return false;
  const onchain = await client.getCode({ address: venue }).catch(() => null);
  if (!onchain || onchain === "0x") return false;
  const a = Buffer.from(venueDeployedBytecode.slice(2), "hex");
  const b = Buffer.from(onchain.slice(2), "hex");
  if (a.length !== b.length) return false;
  for (const ref of venueImmutableRefs) {
    a.fill(0, ref.start, ref.start + ref.length);
    b.fill(0, ref.start, ref.start + ref.length);
  }
  return a.equals(b);
}

/** Self-register the team on the roster (registerMarketMaker) — the --auto-register path. The
 *  registry enrolls msg.sender, so this wallet becomes the funded/scored maker identity. */
export async function registerTeam(
  wallet: WalletClient,
  client: PublicClient,
  registry: Hex,
  teamName: string,
): Promise<Hex> {
  const hash = await wallet.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: "registerMarketMaker",
    args: [teamName],
    account: wallet.account!,
    chain: wallet.chain,
  });
  assertSuccess(await client.waitForTransactionReceipt({ hash }), "registerMarketMaker");
  return hash;
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
