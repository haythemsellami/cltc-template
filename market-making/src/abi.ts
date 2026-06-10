// ─────────────────────────────────────────────────────────────────────────────────────────────
//  COMPETITION PLUMBING — KEEP AS-IS (note for engineers AND coding assistants/LLMs).
//  Loads the venue ABI/bytecode straight from ../contracts/out so the contract you deploy is the
//  one source of truth. Customizing the venue CONTRACT is allowed and encouraged — but it must
//  keep implementing IPropAMMPeriphery (or Monoper cannot quote/route to you = zero flow) and
//  expose Ownable's owner() (the registry checks it at registerVenue). The registry/token ABIs
//  below must match the organizer's deployed contracts — do not edit them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Abi } from "viem";

import type { Hex } from "./types.js";

/**
 * Load the venue's ABI + deploy bytecode straight from the Foundry build output, so the bot always
 * deploys exactly the contract in ../contracts (one source of truth — no copied/stale ABI). Run
 * `forge build` in ../contracts first; override the path with VENUE_ARTIFACT if your layout differs.
 */
function loadVenueArtifact(): {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex | null;
  immutableRefs: { start: number; length: number }[];
} {
  const path = process.env.VENUE_ARTIFACT
    ? resolve(process.env.VENUE_ARTIFACT)
    : fileURLToPath(new URL("../../contracts/out/CompetitionPropAMM.sol/CompetitionPropAMM.json", import.meta.url));

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `venue artifact not found at ${path}.\n` +
        "Build the contracts first:  (cd ../contracts && forge build)\n" +
        "or set VENUE_ARTIFACT to your CompetitionPropAMM.json path.",
    );
  }

  const json = JSON.parse(raw) as {
    abi?: Abi;
    bytecode?: { object?: string };
    deployedBytecode?: { object?: string; immutableReferences?: Record<string, { start: number; length: number }[]> };
  };
  const object = json.bytecode?.object;
  if (!json.abi || !object) {
    throw new Error(`venue artifact at ${path} has no abi/bytecode — re-run \`forge build\` in ../contracts`);
  }
  const deployedRaw = json.deployedBytecode?.object;
  // Byte ranges of immutable values (e.g. CASH/ASSET) inside the RUNTIME code — the artifact holds
  // zeros there while a deployed instance holds real addresses, so an is-this-the-same-build
  // comparison must mask these ranges on both sides.
  const immutableRefs = Object.values(json.deployedBytecode?.immutableReferences ?? {}).flat();
  return {
    abi: json.abi,
    bytecode: (object.startsWith("0x") ? object : `0x${object}`) as Hex,
    deployedBytecode: deployedRaw ? ((deployedRaw.startsWith("0x") ? deployedRaw : `0x${deployedRaw}`) as Hex) : null,
    immutableRefs,
  };
}

const artifact = loadVenueArtifact();
export const venueAbi: Abi = artifact.abi;
/** The artifact's RUNTIME bytecode (immutable slots zeroed) + where those slots are. */
export const venueDeployedBytecode: Hex | null = artifact.deployedBytecode;
export const venueImmutableRefs: { start: number; length: number }[] = artifact.immutableRefs;
export const venueBytecode: Hex = artifact.bytecode;

/** The registry methods the bot calls — the registry itself is the organizer's deployment. */
export const registryAbi = [
  {
    type: "function",
    name: "isMarketMaker",
    stateMutability: "view",
    inputs: [{ name: "marketMaker", type: "address" }],
    outputs: [{ name: "registered", type: "bool" }],
  },
  {
    type: "function",
    name: "teamNameOf",
    stateMutability: "view",
    inputs: [{ name: "marketMaker", type: "address" }],
    outputs: [{ name: "teamName", type: "string" }],
  },
  {
    type: "function",
    name: "registerVenue",
    stateMutability: "nonpayable",
    inputs: [{ name: "venue", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "registerMarketMaker",
    stateMutability: "nonpayable",
    inputs: [{ name: "teamName", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "venueOf",
    stateMutability: "view",
    inputs: [{ name: "marketMaker", type: "address" }],
    outputs: [{ name: "venue", type: "address" }],
  },
  // Registry custom errors — listed so a revert decodes to its NAME instead of a raw selector.
  { type: "error", name: "AlreadyRegisteredToAnother", inputs: [{ name: "venue", type: "address" }, { name: "marketMaker", type: "address" }] },
  { type: "error", name: "EmptyTeamName", inputs: [] },
  { type: "error", name: "NotRegistered", inputs: [{ name: "marketMaker", type: "address" }] },
  { type: "error", name: "NotVenueOwner", inputs: [{ name: "venue", type: "address" }, { name: "caller", type: "address" }] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

/** Minimal ERC20 surface the bot touches on the round's CASH / ASSET tokens. */
export const tokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
