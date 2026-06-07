import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { parseEther } from "viem";

import type { Hex } from "./types.js";

// Load the repo-root .env (one config file for both the contracts and the bot), then let any .env in
// the current directory override it. Real environment variables always win over both.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
loadEnv();

export interface BotConfig {
  rpcUrl: string;
  chainId: number;
  /** Operator API base URL (reads GET /api/manifest). The organizer gives you this. */
  operatorApiUrl: string;
  /** Market-data WebSocket. The organizer gives you this. */
  feedWsUrl: string;
  /** What to track for the price: a bare KIND ("aggTrade"/"bookTicker") follows the live round's
   *  symbol automatically; a full "symbol@kind" pins one exact stream (legacy feed servers). */
  feedPriceStream: string;
  /** The maker dashboard URL — where you register your team (printed in the registration gate). */
  dashboardUrl: string;
  /** Fallback venue label only — your ROSTER name is whatever you registered on the dashboard. */
  teamName: string;
  /** Explicit key (env PRIVATE_KEY or --key). When null, a keyfile is loaded/generated. */
  privateKey: Hex | null;
  /** Where a generated key is persisted (and reused on the next run). */
  keyFile: string;
  /** Quote validity window in seconds (validUntil = now + ttl on every quote). */
  ttlSeconds: number;
  /** Re-quote at least this often (seconds), to refresh the TTL even when the price is flat. */
  requoteSecs: number;
  /** Re-quote immediately when the price moves at least this many bps since the last quote. */
  requoteBps: number;
  /** MON to require on your address before proceeding (gas), in wei. */
  monForGasWei: bigint;
  /** Fair price (WAD) used to seed the first quote if the feed hasn't ticked yet. */
  fallbackPriceWad: bigint;
  /** Reuse an already-deployed venue you own instead of deploying a fresh one. */
  venueOverride: Hex | null;
  /** Skip the interactive funding gate (assume the address is already funded). */
  assumeFunded: boolean;
}

const BOOLEAN_FLAGS = new Set(["--assume-funded"]);

/** Minimal `--flag value` / `--bool-flag` parser. Unknown flags are ignored. */
function parseArgs(argv: string[]): { flags: Map<string, string>; bools: Set<string> } {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) {
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) {
      bools.add(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg, next);
      i += 1;
    }
  }
  return { flags, bools };
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function loadConfig(argv: string[] = []): BotConfig {
  const { flags, bools } = parseArgs(argv);
  const pick = (flag: string, env: string, fallback: string): string => flags.get(flag) ?? envOr(env, fallback);
  const num = (flag: string, env: string, fallback: number): number => {
    const raw = flags.get(flag) ?? process.env[env];
    const n = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`invalid number for ${flag}/${env}: ${raw}`);
    }
    return n;
  };

  const keyRaw = (flags.get("--key") ?? process.env.PRIVATE_KEY ?? "").trim();
  const venueRaw = (flags.get("--venue") ?? process.env.VENUE ?? "").trim();

  const ttlSeconds = num("--ttl", "TTL_SECONDS", 30);
  const requoteSecs = num("--requote-secs", "REQUOTE_SECS", 15);
  const fallbackPriceWad = parseEther(pick("--fallback-price", "FALLBACK_PRICE", "65000"));
  if (fallbackPriceWad <= 0n) {
    throw new Error("FALLBACK_PRICE must be > 0 — it seeds the first quote before the feed ticks.");
  }
  if (requoteSecs >= ttlSeconds) {
    console.warn(
      `warning: REQUOTE_SECS (${requoteSecs}) >= TTL_SECONDS (${ttlSeconds}) — your quote can expire before ` +
        "it refreshes, leaving gaps where swaps revert. Set REQUOTE_SECS well below TTL_SECONDS.",
    );
  }

  return {
    rpcUrl: pick("--rpc-url", "RPC_URL", "https://testnet-rpc.monad.xyz"),
    chainId: num("--chain-id", "CHAIN_ID", 10143),
    operatorApiUrl: pick("--operator-url", "OPERATOR_API_URL", "http://localhost:8080").replace(/\/$/, ""),
    feedWsUrl: pick("--feed-ws", "FEED_WS_URL", "ws://localhost:7777/stream"),
    feedPriceStream: pick("--feed-stream", "FEED_PRICE_STREAM", "aggTrade"),
    dashboardUrl: pick("--dashboard-url", "DASHBOARD_URL", "http://localhost:5176").replace(/\/$/, ""),
    teamName: pick("--team", "TEAM_NAME", "my-team"),
    privateKey: keyRaw ? (keyRaw as Hex) : null,
    keyFile: pick("--key-file", "KEY_FILE", ".venue-key"),
    ttlSeconds,
    requoteSecs,
    requoteBps: num("--requote-bps", "REQUOTE_BPS", 15),
    monForGasWei: parseEther(pick("--mon-gas", "MON_FOR_GAS", "0.5")),
    fallbackPriceWad,
    venueOverride: venueRaw ? (venueRaw as Hex) : null,
    assumeFunded: bools.has("--assume-funded"),
  };
}
