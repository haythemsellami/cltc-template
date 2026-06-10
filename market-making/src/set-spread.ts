// ─────────────────────────────────────────────────────────────────────────────────────────────
//  YOURS TO USE — one-shot CLI to retune your venue's on-chain spread (setSpreadBps).
//  The bot doesn't manage the spread: it is an owner-only venue knob, independent of the price
//  quote (retuning it does not invalidate your current updatePrice). Half the spread is applied
//  to each side of your fair price; 0 quotes at mid; the contract caps it at 2000 (20%).
//
//      npm run set-spread -- --spread 50 [--venue 0x...]
//
//  Venue defaults to VENUE in .env; the key comes from PRIVATE_KEY / --key or the keyfile the
//  bot generated (KEY_FILE) — the same identity that owns the venue.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";

import { venueAbi } from "./abi.js";
import { accountFromKey, createReadClient, createWalletClientFor } from "./chain.js";
import { loadConfig } from "./config.js";
import type { Hex } from "./types.js";

const MAX_SPREAD_BPS = 2_000n; // mirrors CompetitionPropAMM.MAX_SPREAD_BPS

function fail(message: string): never {
  console.error(`set-spread failed: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg = loadConfig(argv);

  const spreadIdx = argv.indexOf("--spread");
  const spreadRaw = spreadIdx >= 0 ? argv[spreadIdx + 1] : undefined;
  if (!spreadRaw || !/^\d+$/.test(spreadRaw)) {
    fail("pass --spread <bps> (a whole number of basis points, e.g. 50 = 0.5% round-trip)");
  }
  const spreadBps = BigInt(spreadRaw);
  if (spreadBps > MAX_SPREAD_BPS) {
    fail(`--spread ${spreadBps} exceeds the contract cap of ${MAX_SPREAD_BPS} bps (20% round-trip)`);
  }

  const venue = cfg.venueOverride;
  if (!venue) {
    fail("no venue: pass --venue 0x... or set VENUE in .env (the venue your bot deployed)");
  }

  // Same identity resolution as the bot, minus key generation — a spread tweak on a venue you
  // already own must never mint a fresh identity.
  let key: Hex;
  if (cfg.privateKey) {
    key = cfg.privateKey.startsWith("0x") ? cfg.privateKey : (`0x${cfg.privateKey}` as Hex);
  } else if (existsSync(cfg.keyFile)) {
    key = readFileSync(cfg.keyFile, "utf8").trim() as Hex;
  } else {
    fail(`no key: set PRIVATE_KEY in .env or run the bot once so ${cfg.keyFile} exists`);
  }

  const account = accountFromKey(key);
  const client = createReadClient(cfg.chainId, cfg.rpcUrl);
  const wallet = createWalletClientFor(account, cfg.chainId, cfg.rpcUrl);

  const before = (await client.readContract({ address: venue, abi: venueAbi, functionName: "spreadBps" })) as bigint;
  console.log(`venue ${venue} (owner tx from ${account.address})`);
  console.log(`spreadBps: ${before} -> ${spreadBps}`);

  const { request } = await client.simulateContract({
    address: venue,
    abi: venueAbi,
    functionName: "setSpreadBps",
    args: [spreadBps],
    account,
  });
  const hash = await wallet.writeContract(request);
  console.log(`tx: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    fail(`transaction reverted (block ${receipt.blockNumber})`);
  }

  const after = (await client.readContract({ address: venue, abi: venueAbi, functionName: "spreadBps" })) as bigint;
  console.log(`confirmed in block ${receipt.blockNumber}: spreadBps = ${after} ✓`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
