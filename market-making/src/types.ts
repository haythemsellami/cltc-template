// Standalone types for the market-making bot. On-chain bigints stay bigint in memory; only the CLI
// and wire boundaries format them.
//
// COMPETITION PLUMBING — these shapes are shared by the plumbing modules (manifest, funding,
// venue, lifecycle). Extend them (add fields for your strategy's signals) rather than changing
// existing fields.

export type Hex = `0x${string}`;

/** The active round's economic context, resolved from the operator manifest. */
export interface RoundContext {
  round: number;
  registry: Hex;
  monoper: Hex;
  cashToken: Hex;
  assetToken: Hex;
  /** Per-maker starting capital for the round (WAD) — a recommendation, not a hard requirement. */
  initialCash: bigint;
  initialAsset: bigint;
}

/**
 * The funding gate's pass condition: a positive balance of each token the round actually uses
 * (so the venue can quote both directions). MON is not gated here — the startup gate (> 0) is
 * the only gas check; out-of-gas transactions fail loudly instead.
 */
export interface FundingRequirement {
  needsCash: boolean;
  needsAsset: boolean;
}

/** A snapshot of an address's CASH / ASSET / native MON balances. */
export interface Balances {
  cashWad: bigint;
  assetWad: bigint;
  monWei: bigint;
}

/** Mutable state the re-quote cadence keys off. */
export interface QuoterState {
  /** Feed price (WAD) at the last quote — the reference shouldRequote() measures price moves against. */
  lastFeedPriceWad: bigint | null;
  lastQuoteMs: number | null;
  quoteCount: number;
}

// ── operator manifest wire shapes (GET /api/manifest) ────────────────────────────────────────────
// All on-chain bigints arrive as decimal strings.

export interface RoundConfig {
  round: number;
  cashToken: Hex;
  assetToken: Hex;
  initialCash: string;
  initialAsset: string;
  label?: string;
  createdAtIso: string;
}

export interface DeploymentManifest {
  chainId: number;
  registry: Hex;
  monoper: Hex | null;
  arbExecutor: Hex | null;
  deployer: Hex;
  deployedAtIso: string;
  deploymentBlock: string | null;
  rounds: RoundConfig[];
  activeRound: number | null;
  label?: string;
}
