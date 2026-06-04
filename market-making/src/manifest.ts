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
