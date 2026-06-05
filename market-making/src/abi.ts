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
function loadVenueArtifact(): { abi: Abi; bytecode: Hex } {
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

  const json = JSON.parse(raw) as { abi?: Abi; bytecode?: { object?: string } };
  const object = json.bytecode?.object;
  if (!json.abi || !object) {
    throw new Error(`venue artifact at ${path} has no abi/bytecode — re-run \`forge build\` in ../contracts`);
  }
  return { abi: json.abi, bytecode: (object.startsWith("0x") ? object : `0x${object}`) as Hex };
}

const artifact = loadVenueArtifact();
export const venueAbi: Abi = artifact.abi;
export const venueBytecode: Hex = artifact.bytecode;

/**
 * The registry methods the bot calls — the registry itself is the organizer's deployment.
 * Note: team enrollment (`registerMarketMaker`) is deliberately NOT here — you register your team
 * manually on the maker dashboard with this bot's wallet; the bot only reads the roster.
 */
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
