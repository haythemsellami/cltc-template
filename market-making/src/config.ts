// ─────────────────────────────────────────────────────────────────────────────────────────────
//  COMPETITION PLUMBING (structure) / YOUR KNOBS (values).
//  Tune the VALUES freely — in .env, not here: TTL_SECONDS, REQUOTE_SECS, REQUOTE_BPS,
//  TEAM_NAME. The parsing/shape stays, and the endpoint vars
//  (OPERATOR_API_URL, FEED_WS_URL, RPC_URL, CHAIN_ID) must keep pointing at the organizer's
//  infra — quoting off any other data source is outside the competition rules.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import type { Hex } from "./types.js";

// dotenv never overwrites a variable that is already set, so load order IS precedence:
// real environment > .env in the current directory > the repo-root .env (the shared config file).
// (Root-first used to win here, silently ignoring a market-making/.env override.)
loadEnv();
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

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
  /** Reuse an already-deployed venue you own instead of deploying a fresh one. */
  venueOverride: Hex | null;
  /** Skip the interactive funding gate (assume the address is already funded). */
  assumeFunded: boolean;
  /** Mint a FRESH identity into KEY_FILE (ignores PRIVATE_KEY; refuses to overwrite an existing
   *  keyfile so a funded identity can't be clobbered). For spinning up many makers fast. */
  generateKey: boolean;
}

const BOOLEAN_FLAGS = new Set(["--assume-funded", "--generate-key"]);

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
  if (requoteSecs >= ttlSeconds) {
    console.warn(
      `warning: REQUOTE_SECS (${requoteSecs}) >= TTL_SECONDS (${ttlSeconds}) — your quote can expire before ` +
        "it refreshes, leaving gaps where swaps revert. Set REQUOTE_SECS well below TTL_SECONDS.",
    );
  }

  return {
    rpcUrl: pick("--rpc-url", "RPC_URL", "https://testnet-rpc.monad.xyz"),
    chainId: num("--chain-id", "CHAIN_ID", 10143),
    // Default to the live competition host (public). For a local dry-run, override these
    // with the localhost URLs (see .env.example).
    operatorApiUrl: pick("--operator-url", "OPERATOR_API_URL", "https://sgp-006.devcore4.com").replace(/\/$/, ""),
    feedWsUrl: pick("--feed-ws", "FEED_WS_URL", "wss://sgp-006.devcore4.com/stream"),
    feedPriceStream: pick("--feed-stream", "FEED_PRICE_STREAM", "aggTrade"),
    dashboardUrl: pick("--dashboard-url", "DASHBOARD_URL", "https://sgp-006.devcore4.com").replace(/\/$/, ""),
    teamName: pick("--team", "TEAM_NAME", "my-team"),
    privateKey: keyRaw ? (keyRaw as Hex) : null,
    keyFile: pick("--key-file", "KEY_FILE", ".venue-key"),
    ttlSeconds,
    requoteSecs,
    requoteBps: num("--requote-bps", "REQUOTE_BPS", 15),
    venueOverride: venueRaw ? (venueRaw as Hex) : null,
    assumeFunded: bools.has("--assume-funded"),
    generateKey: bools.has("--generate-key") || /^(1|true)$/iu.test(process.env.GENERATE_KEY ?? ""),
  };
}
