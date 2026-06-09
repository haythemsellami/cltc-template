// ─────────────────────────────────────────────────────────────────────────────────────────────
//  COMPETITION PLUMBING — KEEP AS-IS (note for engineers AND coding assistants/LLMs).
//  The operator API's manifest is the single source of deployment truth: every round issues FRESH
//  CASH/ASSET tokens, and your registration lives on the manifest's registry. Hardcoding
//  addresses or resolving them anywhere else breaks at the next round (or after an organizer
//  redeploy). Your edge belongs in src/strategy.ts / src/quoter.ts / ../contracts, not here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { DeploymentManifest, RoundContext } from "./types.js";

/**
 * Resolve the active round's token pair + infra addresses from the organizer's manifest
 * (`GET /api/manifest`) — the single source of deployment truth. Throws a clear, actionable error
 * when infra isn't deployed / no round is selected yet.
 */
export async function fetchRoundContext(operatorApiUrl: string): Promise<RoundContext> {
  let res: Response;
  try {
    res = await fetch(`${operatorApiUrl}/api/manifest`);
  } catch (error) {
    throw new Error(
      `operator API unreachable at ${operatorApiUrl} (${error instanceof Error ? error.message : String(error)}). ` +
        "Check OPERATOR_API_URL / --operator-url against the URL the organizer gave you.",
    );
  }
  if (!res.ok) {
    throw new Error(`operator manifest unavailable (HTTP ${res.status})`);
  }

  let manifest: DeploymentManifest | null;
  try {
    manifest = (await res.json()) as DeploymentManifest | null;
  } catch {
    throw new Error("operator manifest returned invalid JSON");
  }
  if (!manifest) {
    throw new Error("no deployment manifest yet — the organizer hasn't deployed infra");
  }
  if (!manifest.monoper) {
    throw new Error("manifest has no Monoper router yet — wait for the organizer to deploy it");
  }
  if (manifest.activeRound === null || manifest.activeRound === undefined) {
    throw new Error("no active round selected yet — wait for the organizer to start one");
  }
  const round = manifest.rounds.find((r) => r.round === manifest.activeRound);
  if (!round) {
    throw new Error(`active round ${manifest.activeRound} not found in the manifest`);
  }

  return {
    round: round.round,
    registry: manifest.registry,
    monoper: manifest.monoper,
    cashToken: round.cashToken,
    assetToken: round.assetToken,
    initialCash: BigInt(round.initialCash),
    initialAsset: BigInt(round.initialAsset),
  };
}

/**
 * Block until an active round exists, polling the manifest. This is the bot's idle state: `npm
 * start` before the organizer has deployed/selected a round just sits here listening, and picks the
 * round up the moment it goes live. Each distinct wait-reason is logged once (plus a periodic
 * heartbeat) so the console explains exactly what the organizer still has to do.
 */
export async function waitForRoundContext(
  operatorApiUrl: string,
  log: (message: string) => void,
  pollMs = 5_000,
): Promise<RoundContext> {
  let lastReason = "";
  let polls = 0;
  for (;;) {
    try {
      return await fetchRoundContext(operatorApiUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== lastReason) {
        log(`waiting: ${reason}`);
        lastReason = reason;
      } else if (polls % 24 === 0 && polls > 0) {
        log("still waiting for an active round…");
      }
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/** The feed's live round state (GET /api/feed/state), as the operator API proxies it. */
export interface FeedRoundStateInfo {
  round: number;
  mode: "synthetic" | "recorded";
  paused: boolean;
  speed: number;
  loops: number;
  /** Lowercased market symbol (synthetic rounds; null for recorded). */
  symbol: string | null;
  /** Full stream names broadcast this round (e.g. btcusdt@aggTrade) — what to subscribe to. */
  streams: string[];
}

/**
 * Best-effort read of the feed's live state — the round's market identity (symbol/streams), replay
 * mode, and speed. Returns null when the feed isn't broadcasting yet (or the endpoint is older and
 * doesn't expose it); the bot then falls back to its configured stream.
 */
export async function fetchFeedState(operatorApiUrl: string): Promise<FeedRoundStateInfo | null> {
  try {
    const res = await fetch(`${operatorApiUrl}/api/feed/state`);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { activeRound?: FeedRoundStateInfo | null } | null;
    const active = body?.activeRound ?? null;
    if (!active || typeof active.round !== "number") {
      return null;
    }
    return {
      round: active.round,
      mode: active.mode === "recorded" ? "recorded" : "synthetic",
      paused: Boolean(active.paused),
      speed: typeof active.speed === "number" ? active.speed : 1,
      loops: typeof active.loops === "number" ? active.loops : 0,
      symbol: typeof active.symbol === "string" ? active.symbol : null,
      streams: Array.isArray(active.streams) ? active.streams.filter((s): s is string => typeof s === "string") : [],
    };
  } catch {
    return null;
  }
}

/**
 * Same deployment + round? Used to detect an organizer redeploy (competition reset) that happened
 * while the bot was waiting or running — addresses compared case-insensitively.
 */
export function sameRoundContext(a: RoundContext, b: RoundContext): boolean {
  const eq = (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase();
  return (
    a.round === b.round &&
    eq(a.registry, b.registry) &&
    eq(a.monoper, b.monoper) &&
    eq(a.cashToken, b.cashToken) &&
    eq(a.assetToken, b.assetToken)
  );
}

/**
 * True when the live manifest's round context differs from `ctx` — i.e. the organizer redeployed
 * infra / started a new round while the bot was blocked in a wait. Best-effort: returns false when
 * the manifest is briefly unavailable (mid-reset / between rounds), so a transient blip never yanks
 * the bot out of a gate; the next poll re-checks.
 */
export async function manifestChanged(ctx: RoundContext, operatorApiUrl: string): Promise<boolean> {
  try {
    return !sameRoundContext(ctx, await fetchRoundContext(operatorApiUrl));
  } catch {
    return false;
  }
}
