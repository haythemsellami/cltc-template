// ─────────────────────────────────────────────────────────────────────────────────────────────
//  COMPETITION PLUMBING — KEEP AS-IS (note for engineers AND coding assistants/LLMs).
//  The orchestration order here mirrors the competition's onboarding requirements:
//  MON gas → enroll (the bot self-registers TEAM_NAME) → active round → CASH/ASSET funding →
//  deploy venue → max-approve → register venue → quote loop (+ self-healing across organizer
//  redeploys, and quote-pausing between rounds).
//  The INTENDED hooks are the two calls into your code — decideFairPrice() (src/strategy.ts, the
//  price) and shouldRequote() (src/quoter.ts, the cadence) — plus the .env knobs. Change those,
//  not this flow: reordering or removing steps produces a venue that can't fill or isn't scored.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { formatEther, formatUnits, type Account, type PublicClient, type WalletClient } from "viem";

import { accountFromKey, createReadClient, createWalletClientFor, generatePrivateKey } from "./chain.js";
import type { BotConfig } from "./config.js";
import { FeedClient } from "./feed-client.js";
import { computeFundingRequirement, readBalances, waitForFunding } from "./funding.js";
import { fetchFeedState, fetchRoundContext, manifestChanged, sameRoundContext, waitForRegistry, waitForRoundContext } from "./manifest.js";
import { shouldRequote } from "./quoter.js";
import { decideFairPrice, type MarketTick } from "./strategy.js";
import type { Hex, QuoterState, RoundContext } from "./types.js";
import {
  approveVenueAllowances,
  buildVenueConstructorArgs,
  countSwaps,
  deployVenue,
  isMarketMakerRegistered,
  matchesBuiltVenue,
  matchesRoundPair,
  pushQuote,
  readTeamName,
  readVenueOf,
  readVenueOwner,
  registerTeam,
  registerVenue,
} from "./venue.js";

const RECENT_PRICES_CAP = 128;

const log = (message = ""): void => console.log(message);
const banner = (title: string): void => {
  log("");
  log(`━━ ${title} ━━`);
};
const fmt = (wad: bigint): string => formatUnits(wad, 18);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Load the key from --key/env, else from the keyfile, else generate one and persist it (gitignored). */
function resolveIdentity(cfg: BotConfig): Hex {
  const normalize = (k: string): Hex => (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (cfg.generateKey) {
    // Explicit fresh identity (--generate-key): PRIVATE_KEY is deliberately ignored, and an
    // existing keyfile is NEVER overwritten — it may hold a funded identity. Keys come from the
    // OS CSPRNG (256 bits), so two machines can't mint the same key — no coordination needed.
    if (existsSync(cfg.keyFile)) {
      throw new Error(
        `--generate-key: ${cfg.keyFile} already exists — refusing to overwrite a possibly-funded identity. ` +
          `Pass a fresh path (--key-file .venue-key-2) or delete the file if you're sure.`,
      );
    }
    const fresh = generatePrivateKey();
    writeFileSync(cfg.keyFile, `${fresh}\n`, { mode: 0o600 });
    log(`identity: FRESH key generated -> ${cfg.keyFile} (PRIVATE_KEY ignored)`);
    return fresh;
  }
  if (cfg.privateKey) {
    log("identity: using key from PRIVATE_KEY / --key");
    return normalize(cfg.privateKey);
  }
  if (existsSync(cfg.keyFile)) {
    log(`identity: loaded key from ${cfg.keyFile}`);
    return normalize(readFileSync(cfg.keyFile, "utf8").trim());
  }
  const key = generatePrivateKey();
  writeFileSync(cfg.keyFile, `${key}\n`, { mode: 0o600 });
  log(`identity: generated a fresh key -> ${cfg.keyFile} (reused next run; gitignored). Fund this address.`);
  return key;
}

/** Per-identity record of the last deployed venue, so a restart can REUSE it when nothing
 *  changed (same round, same registry, and the on-chain bytecode still matches the local build —
 *  i.e. you only edited strategy.ts, not the contract). Lives next to the keyfile, gitignored. */
interface VenueState {
  venue: Hex;
  round: number;
  registry: Hex;
}
const venueStatePath = (cfg: BotConfig): string => `${cfg.keyFile}.venue.json`;
function loadVenueState(cfg: BotConfig): VenueState | null {
  try {
    const raw = JSON.parse(readFileSync(venueStatePath(cfg), "utf8")) as VenueState;
    return raw && typeof raw.venue === "string" && typeof raw.round === "number" ? raw : null;
  } catch {
    return null;
  }
}
function saveVenueState(cfg: BotConfig, state: VenueState): void {
  try {
    writeFileSync(venueStatePath(cfg), `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* best-effort — worst case the next run redeploys */
  }
}

/** Best-effort wait for the first feed tick so we can seed a quote at a real price. */
async function waitForFirstPrice(feed: FeedClient, timeoutMs: number): Promise<bigint | null> {
  const start = Date.now();
  while (feed.latestPriceWad() === null && Date.now() - start < timeoutMs) {
    await sleep(250);
  }
  return feed.latestPriceWad();
}

/**
 * FALLBACK manual registration: normally the bot self-registers (ensureRegistered), but if that
 * transaction fails this waits for you to sign `registerMarketMaker(teamName)` on the maker
 * dashboard's Register tab — with THIS bot's wallet (the registry enrolls msg.sender, and your
 * venue's owner must be the enrolled maker).
 */
async function waitForTeamRegistration(deps: {
  client: PublicClient;
  registry: Hex;
  address: Hex;
  dashboardUrl: string;
  pollMs?: number;
  /** Optional redeploy probe — returns null (instead of blocking forever) when the organizer
   *  redeployed, so the caller re-resolves the manifest and waits on the NEW registry's roster. */
  redeployed?: () => Promise<boolean>;
}): Promise<string | null> {
  const { client, registry, address, dashboardUrl } = deps;
  const pollMs = deps.pollMs ?? 5_000;

  if (await isMarketMakerRegistered(client, registry, address).catch(() => false)) {
    const name = await readTeamName(client, registry, address);
    log(`already on the roster${name ? ` as "${name}"` : ""} ✓`);
    return name;
  }

  log("");
  log("Register your team on the maker dashboard — the bot waits here until you do:");
  log(`  1. open ${dashboardUrl} → Register tab`);
  log(`  2. connect THIS bot's wallet:  ${address}`);
  log("     (set PRIVATE_KEY to a key your browser wallet holds, or import the generated key file)");
  log("  3. sign \"Register team\" with your team name");
  log("Once you're on the roster the organizer can fund this address with the round's CASH/ASSET.");
  log("Polling the roster…");

  let polls = 0;
  for (;;) {
    try {
      if (await isMarketMakerRegistered(client, registry, address)) {
        const name = await readTeamName(client, registry, address);
        log(`team registered${name ? ` as "${name}"` : ""} ✓`);
        return name;
      }
    } catch (error) {
      log(`  (roster read failed, retrying: ${error instanceof Error ? error.message : String(error)})`);
    }
    if (deps.redeployed && (await deps.redeployed())) {
      log("  organizer redeployed — re-resolving the round before re-registering.");
      return null;
    }
    polls += 1;
    if (polls % 12 === 0) {
      log(`  still waiting for ${address} to appear on the roster…`);
    }
    await sleep(pollMs);
  }
}

export async function run(cfg: BotConfig): Promise<void> {
  banner("PropAMM competition — market maker");
  const key = resolveIdentity(cfg);
  const account: Account = accountFromKey(key);
  const address = account.address as Hex;
  const client: PublicClient = createReadClient(cfg.chainId, cfg.rpcUrl);
  const wallet: WalletClient = createWalletClientFor(account, cfg.chainId, cfg.rpcUrl);

  log(`address     : ${address}`);
  log(`operator API: ${cfg.operatorApiUrl}`);
  log(`dashboard   : ${cfg.dashboardUrl}`);
  if (cfg.generateKey) {
    log("");
    log("━━ Share this address with the organizer (internal channel) so they can fund it ━━");
    log(`    ${address}`);
    log("");
  }

  /** Make sure this wallet is enrolled on `registry` — self-registers TEAM_NAME (the bot's own
   *  transaction) and falls back to the manual dashboard flow only if that tx fails. Re-registering
   *  is how the registry RENAMES a team, so an enrolled wallet whose on-chain name drifted from
   *  TEAM_NAME re-registers to update it — but ONLY while no round has been deployed yet
   *  (`allowRename`): once the competition has rounds, the name is locked so a team keeps one
   *  identity across every round's standings. */
  async function ensureRegistered(registry: Hex, allowRename = false): Promise<string> {
    if (await isMarketMakerRegistered(client, registry, address).catch(() => false)) {
      const name = (await readTeamName(client, registry, address).catch(() => null)) || cfg.teamName;
      if (name !== cfg.teamName && cfg.teamName !== "my-team") {
        if (!allowRename) {
          log(`on the roster as "${name}" ✓ (TEAM_NAME is "${cfg.teamName}", but the name is locked once rounds exist)`);
          return name;
        }
        try {
          log(`on the roster as "${name}" but TEAM_NAME is "${cfg.teamName}" — updating the team name…`);
          await registerTeam(wallet, client, registry, cfg.teamName);
          log(`team renamed to "${cfg.teamName}" ✓`);
          return cfg.teamName;
        } catch (e) {
          log(`rename failed (${e instanceof Error ? e.message : String(e)}) — keeping "${name}"`);
          return name;
        }
      }
      log(`on the roster as "${name}" ✓`);
      return name;
    }
    if (cfg.teamName === "my-team") {
      log('note: TEAM_NAME is still the default "my-team" — set it in .env for a real name');
    }
    try {
      log(`registering team "${cfg.teamName}" (the bot's first transaction)…`);
      await registerTeam(wallet, client, registry, cfg.teamName);
      log(`team registered as "${cfg.teamName}" ✓ — the organizer can now fund this address`);
      return cfg.teamName;
    } catch (e) {
      log(`self-registration failed (${e instanceof Error ? e.message : String(e)}) — falling back to the dashboard flow`);
      const name = await waitForTeamRegistration({ client, registry, address, dashboardUrl: cfg.dashboardUrl });
      return name || cfg.teamName;
    }
  }

  // ── gas gate ────────────────────────────────────────────────────────────────────────────────
  // Registration is the bot's first on-chain transaction, so ANY MON unlocks the flow. The
  // organizer just sends gas to the printed address; everything after is automatic.
  banner("Waiting for MON gas");
  if (cfg.assumeFunded) {
    log("--assume-funded: skipping the gas gate.");
  } else {
    log("Send MON (any amount) to this address — the bot registers your team the moment it lands:");
    log(`  ${address}`);
    let gasPolls = 0;
    while ((await client.getBalance({ address })) === 0n) {
      gasPolls += 1;
      if (gasPolls % 12 === 0) {
        log("  still waiting for MON…");
      }
      await sleep(5_000);
    }
    log("MON received ✓");
  }

  // ── team registration (registry-level — happens BEFORE any round exists) ───────────────────
  // Registering early puts this wallet on the roster the organizer funds against, so when a round
  // starts the bot only has to wait for its CASH/ASSET to arrive.
  banner("Team registration");
  const earlyInfra = await waitForRegistry(cfg.operatorApiUrl, log);
  // Renaming (re-registering under a changed TEAM_NAME) is allowed only before the first round
  // exists — after that the name is locked for the rest of the competition.
  await ensureRegistered(earlyInfra.registry, !earlyInfra.hasRounds);

  // ── round gate ─────────────────────────────────────────────────────────────────────────────
  // The bot idles here until the organizer has an active round — `npm start` any time, even days
  // before the competition; it picks the round up the moment it goes live.
  banner("Waiting for an active round");
  let ctx = await waitForRoundContext(cfg.operatorApiUrl, log);
  let feedState = await fetchFeedState(cfg.operatorApiUrl);
  const printCtx = (): void => {
    log(`round #${ctx.round}`);
    log(`  registry : ${ctx.registry}`);
    log(`  monoper  : ${ctx.monoper}`);
    log(`  CASH     : ${ctx.cashToken}`);
    log(`  ASSET    : ${ctx.assetToken}`);
    log(`  initial  : ${fmt(ctx.initialCash)} CASH + ${fmt(ctx.initialAsset)} ASSET per maker (recommended)`);
    if (feedState) {
      log(
        `  feed     : ${feedState.mode}${feedState.symbol ? ` ${feedState.symbol}` : ""} ×${feedState.speed}` +
          `${feedState.paused ? " (paused)" : ""} — streams: ${feedState.streams.join(", ") || "(none yet)"}`,
      );
    } else {
      log("  feed     : not broadcasting yet — quoting starts on the first tick");
    }
  };
  printCtx();

  // Subscribing by KIND (no symbol) — the feed delivers whatever market the live round emits, and
  // keeps doing so across round changes. Pin FEED_PRICE_STREAM=<symbol>@<kind> only against an
  // older feed server without ?kinds= support.
  log(`feed        : ${cfg.feedWsUrl}  ${cfg.feedPriceStream.includes("@") ? `stream=${cfg.feedPriceStream} (pinned)` : `kind=${cfg.feedPriceStream} (follows the round)`}`);
  const feed = new FeedClient(cfg.feedWsUrl, cfg.feedPriceStream, `mm:${cfg.teamName}`);
  feed.start();

  // Rolling window of recent feed prices, handed to your strategy each quote (oldest → newest).
  const recentPrices: bigint[] = [];
  feed.on("tick", (priceWad: bigint) => {
    recentPrices.push(priceWad);
    if (recentPrices.length > RECENT_PRICES_CAP) {
      recentPrices.shift();
    }
  });

  // ── roster check ────────────────────────────────────────────────────────────────────────────
  // Already registered above (before the round) — re-verify against the ROUND's registry in case
  // the organizer redeployed infra in between (a fresh registry starts with an empty roster).
  banner("Roster check");
  const onChainTeamName = await ensureRegistered(ctx.registry);
  // The venue's baked-in label mirrors your roster name; TEAM_NAME is only the fallback.
  const venueLabel = onChainTeamName || cfg.teamName;

  // Shared mutable run state.
  const state: QuoterState = { lastFeedPriceWad: null, lastQuoteMs: null, quoteCount: 0 };
  let lastFairWad: bigint | null = null;
  let venue: Hex | null = null;
  let deployBlock = 0n;
  let timer: ReturnType<typeof setInterval> | null = null;
  let registryWatch: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inFlight = false;

  /**
   * Run your strategy against the latest feed price and push the result on-chain. Returns whether a
   * quote was actually pushed — a non-positive fairPrice from your strategy is skipped (not pushed),
   * since fairPrice = 0 would make the venue unfillable.
   */
  async function quoteNow(feedPriceWad: bigint, now: number): Promise<boolean> {
    const tick: MarketTick = {
      feedPriceWad,
      recentPricesWad: recentPrices,
      lastQuotedPriceWad: lastFairWad,
      roundActive: feed.isRoundActive(),
    };
    const fairPriceWad = decideFairPrice(tick);
    if (fairPriceWad <= 0n) {
      log(`strategy returned a non-positive fairPrice (${fairPriceWad}); skipping — fix decideFairPrice in src/strategy.ts`);
      return false;
    }
    await pushQuote(wallet, client, venue!, fairPriceWad, BigInt(Math.floor(now / 1000) + cfg.ttlSeconds));
    lastFairWad = fairPriceWad;
    state.lastFeedPriceWad = feedPriceWad;
    state.lastQuoteMs = now;
    state.quoteCount += 1;
    return true;
  }

  async function shutdown(reason: string): Promise<void> {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      clearInterval(timer);
    }
    if (registryWatch) {
      clearInterval(registryWatch);
    }
    banner(`Shutting down (${reason})`);
    feed.stop();
    // Let any in-flight quote settle before exit work, so its nonce doesn't race a withdraw tx.
    for (let i = 0; inFlight && i < 200; i += 1) {
      await sleep(50);
    }
    if (venue) {
      try {
        const swaps = await countSwaps(client, venue, deployBlock);
        const eb = await readBalances(client, address, ctx.cashToken, ctx.assetToken);
        log(`quotes pushed    : ${state.quoteCount}`);
        log(`swaps served     : ${swaps < 0 ? "unknown (RPC range limit)" : swaps}`);
        log(`your CASH/ASSET  : ${fmt(eb.cashWad)} / ${fmt(eb.assetWad)}   (MON ${formatEther(eb.monWei)})`);
        log(`venue            : ${venue}  (holds no inventory — it trades against your wallet)`);
      } catch (error) {
        log(`summary failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // ── automatic venue reuse ─────────────────────────────────────────────────────────────────
  // Ctrl+C → edit strategy.ts → npm start should NOT redeploy when the CONTRACT didn't change:
  // if the venue from the last run still belongs to this round + registry, is ours, and its
  // on-chain runtime bytecode matches the current forge build (immutables masked), reuse it.
  // Any mismatch (you rebuilt the contract, a new round, a redeployed registry) falls through to
  // a fresh deploy. An explicit VENUE= override always wins over the saved state.
  let autoReuse: Hex | null = null;
  if (!cfg.venueOverride) {
    const saved = loadVenueState(cfg);
    if (saved && saved.round === ctx.round && saved.registry.toLowerCase() === ctx.registry.toLowerCase()) {
      const [owner, sameBuild, samePair] = await Promise.all([
        readVenueOwner(client, saved.venue).catch(() => null),
        matchesBuiltVenue(client, saved.venue),
        // The bytecode check masks immutables (same code, ANY pair) — this pins the venue to the
        // round's actual CASH/ASSET, independent of what the state file claims.
        matchesRoundPair(client, saved.venue, ctx),
      ]);
      if (owner?.toLowerCase() !== address.toLowerCase()) {
        log(`saved venue ${saved.venue} isn't owned by this wallet — deploying fresh`);
      } else if (!sameBuild) {
        log(`saved venue ${saved.venue} was built from a DIFFERENT contract than ../contracts/out — deploying the new build`);
      } else if (!samePair) {
        log(`saved venue ${saved.venue} trades a different token pair than round ${ctx.round} — deploying fresh`);
      } else {
        autoReuse = saved.venue;
        log(`venue contract unchanged since last run — reusing ${saved.venue} (no redeploy)`);
      }
    }
  }

  const reuseVenue = cfg.venueOverride ?? autoReuse;
  if (reuseVenue) {
    // ── reuse path ─────────────────────────────────────────────────────────────────────────
    banner("Reusing an existing venue");
    const owner = await readVenueOwner(client, reuseVenue);
    if (owner.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`VENUE ${reuseVenue} is owned by ${owner}, not your address ${address}`);
    }
    venue = reuseVenue;
    // Bound the shutdown Swap-log scan to this session (the venue's creation block is unknown here).
    deployBlock = await client.getBlockNumber();
    log(`venue ${venue} owned by you ✓`);
    if ((await approveVenueAllowances(wallet, client, venue, ctx)) > 0) {
      log("venue re-approved for CASH + ASSET ✓");
    }
    // Re-link only when the registry points elsewhere — the registration tx is skipped when the
    // backend is already routing to this venue.
    const registered = await readVenueOf(client, ctx.registry, address).catch(() => null);
    if (registered?.toLowerCase() === venue.toLowerCase()) {
      log("already registered — the backend keeps routing to this venue ✓");
    } else {
      await registerVenue(wallet, client, ctx.registry, venue);
      log("registered ✓");
    }
    saveVenueState(cfg, { venue, round: ctx.round, registry: ctx.registry });
  } else {
    // ── funding gate ───────────────────────────────────────────────────────────────────────
    banner("Funding gate");
    // You're on the roster, so the organizer's Funding tab now shows this address. The gate can
    // outlast an organizer redeploy (fresh Registry/Monoper, or a new round) — re-resolve the
    // manifest after the wait and re-gate if the context changed under us, otherwise we would
    // deploy/fund/register against a registry that no longer exists in the manifest.
    for (;;) {
      const req = computeFundingRequirement(ctx);
      await waitForFunding({
        client,
        address,
        ctx,
        req,
        log,
        assumeFunded: cfg.assumeFunded,
        // Don't poll the old round's tokens forever if the organizer redeploys mid-wait — bail out
        // so we re-resolve below instead of waiting on funding that will never land.
        redeployed: () => manifestChanged(ctx, cfg.operatorApiUrl),
      });
      const fresh = await waitForRoundContext(cfg.operatorApiUrl, log);
      if (sameRoundContext(ctx, fresh)) {
        break;
      }
      log("organizer redeployed while we waited — refreshing the round context:");
      ctx = fresh;
      feedState = await fetchFeedState(cfg.operatorApiUrl);
      printCtx();
      // A fresh registry has an empty roster — re-register your team on the dashboard against it.
      await waitForTeamRegistration({
        client,
        registry: ctx.registry,
        address,
        dashboardUrl: cfg.dashboardUrl,
        redeployed: () => manifestChanged(ctx, cfg.operatorApiUrl),
      });
    }

    // ── deploy ────────────────────────────────────────────────────────────────────────────
    banner("Deploying your CompetitionPropAMM venue");
    const deployed = await deployVenue(wallet, client, buildVenueConstructorArgs(venueLabel, address, ctx));
    venue = deployed.address;
    deployBlock = deployed.blockNumber;
    log(`venue deployed un-quoted: ${venue}  (block ${deployBlock})`);

    // ── approve the venue ───────────────────────────────────────────────────────────────────
    banner("Approving the venue");
    // Inventory stays in YOUR wallet — the venue settles swaps against it via these allowances.
    await approveVenueAllowances(wallet, client, venue, ctx);
    log("venue max-approved for CASH + ASSET (your tokens never leave your wallet) ✓");

    // ── register ────────────────────────────────────────────────────────────────────────────
    banner("Registering the venue");
    await registerVenue(wallet, client, ctx.registry, venue);
    log("registered with the CompetitionRegistry ✓");
    saveVenueState(cfg, { venue, round: ctx.round, registry: ctx.registry });
  }

  // ── seed the first quote ────────────────────────────────────────────────────────────────────
  // The venue deploys un-quoted, so it can't fill until the first updatePrice. Seed it (via your
  // strategy) from the feed — or a fallback if the feed hasn't ticked yet — before the loop runs.
  banner("Seeding the first quote");
  const seenPrice = await waitForFirstPrice(feed, 6_000);
  if (seenPrice === null) {
    // NEVER seed without a real tick. A live round ticks every second, so no tick within 6s means
    // no round is broadcasting (between rounds, or the feed just connected) — and a made-up seed
    // price would be a live, hittable quote that can be wildly off the asset's scale for a whole
    // TTL. An unquoted venue simply can't fill; the loop quotes on the first real tick.
    log("no feed tick — skipping the seed quote (the loop quotes the moment the feed ticks; an unquoted venue can't fill)");
  } else {
    log(`feed price: ${fmt(seenPrice)}`);
    const seeded = await quoteNow(seenPrice, Date.now());
    if (seeded) {
      log(`quote #${state.quoteCount}  fairPrice=${fmt(lastFairWad!)}  (feed ${fmt(seenPrice)}, validUntil +${cfg.ttlSeconds}s)`);
      log("");
      log("→ Venue is live. Ask the organizer to re-baseline your gas (so it's accounted for) before the round.");
    } else {
      log("→ First quote skipped (strategy returned a non-positive price) — the loop retries as the feed moves.");
    }
  }

  // ── market-making loop ────────────────────────────────────────────────────────────────────
  banner("Market making");
  log(
    `quoting venue ${venue}: ttl=${cfg.ttlSeconds}s, ` +
      `re-quote every ${cfg.requoteSecs}s or on a ${cfg.requoteBps}bps feed move. Edit src/strategy.ts. Ctrl+C to stop.`,
  );

  feed.on("round-start", (round: number | null) => {
    log(`feed: round ${round ?? "?"} started — refreshing quote`);
    state.lastQuoteMs = null; // force an immediate re-quote at the new round's price
  });
  feed.on("round-end", (round: number | null) => {
    log(`feed: round ${round ?? "?"} ended — pausing quotes until the next round (saving your MON budget)`);
  });

  // Set after an out-of-MON failure: retrying every tick can't succeed and floods the log, so
  // quote attempts pause briefly between retries (a top-up resumes quoting within a minute).
  let gasPausedUntil = 0;

  async function maybeQuote(): Promise<void> {
    if (stopped || inFlight || !venue || pairStale || Date.now() < gasPausedUntil) {
      return;
    }
    // No live round = nothing to make a market for: every updatePrice would just burn your fixed
    // MON budget. Gate only when the feed actually signals rounds (the organizer feed does; a raw
    // Binance practice stream doesn't, and keeps quoting freely). The last quote expires on its
    // own TTL; round-start clears lastQuoteMs so quoting resumes immediately.
    if (feed.hasRoundSignal() && !feed.isRoundActive()) {
      return;
    }
    const price = feed.latestPriceWad();
    const now = Date.now();
    if (price === null || !shouldRequote(state, now, price, { requoteSecs: cfg.requoteSecs, requoteBps: cfg.requoteBps })) {
      return;
    }
    inFlight = true;
    try {
      if (await quoteNow(price, now)) {
        log(
          `quote #${state.quoteCount}  fairPrice=${fmt(lastFairWad!)}  ` +
            `(feed ${fmt(price)}, round ${feed.isRoundActive() ? "active" : "idle"})`,
        );
      }
    } catch (error) {
      // venue.ts already rethrows one-line readable errors (revert name / out-of-gas hint).
      const msg = error instanceof Error ? error.message : String(error);
      log(`quote failed: ${msg}`);
      if (/insufficient balance|out of MON/iu.test(msg)) {
        gasPausedUntil = Date.now() + 60_000;
        log("→ no MON left for gas — pausing quote attempts (retrying once a minute; a top-up resumes quoting, otherwise you're out for the round)");
      }
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => void maybeQuote(), 1_000);

  // ── registry watch: self-heal across organizer redeploys ───────────────────────────────────
  // If the organizer resets the competition mid-run (fresh Registry/Monoper), this maker's
  // registration vanishes with the old registry and it silently stops receiving flow. Poll the
  // manifest; when the registry changes, wait for you to re-register your team on the dashboard
  // (registration is manual), then re-link the venue — and when a new round changes the token
  // pair, automatically deploy + register a fresh venue for it (redeployForNewPair).
  let watchBusy = false;
  let needRelink = false;
  let relinkNagged = false;
  // Set when the active round's CASH/ASSET differ from this venue's immutables: the venue can no
  // longer fill, so quoting it only burns the MON budget. Cleared by the automatic redeploy below
  // once a venue for the new pair is live.
  let pairStale = false;
  let redeploying = false;

  /**
   * AUTO-REDEPLOY on a round's pair change: wait for the new round's CASH/ASSET funding, then
   * deploy + approve + register a fresh venue for the new pair and resume quoting — the same flow
   * as a manual restart, without needing one. On failure pairStale stays set and the watch kicks
   * this off again on its next tick.
   */
  async function redeployForNewPair(): Promise<void> {
    const target = ctx; // snapshot — if the organizer changes the round again mid-flight, abort and retry
    banner(`Round ${target.round}: new token pair — deploying a fresh venue`);
    // The new round's capital may not be minted yet — same gate as a cold start.
    await waitForFunding({
      client,
      address,
      ctx: target,
      req: computeFundingRequirement(target),
      log,
      assumeFunded: cfg.assumeFunded,
      redeployed: () => manifestChanged(target, cfg.operatorApiUrl),
    });
    if (!sameRoundContext(ctx, target)) {
      log("the round changed again while waiting — the watch retries against the latest round");
      return;
    }
    const deployed = await deployVenue(wallet, client, buildVenueConstructorArgs(venueLabel, address, target));
    log(`venue deployed un-quoted: ${deployed.address}  (block ${deployed.blockNumber})`);
    await approveVenueAllowances(wallet, client, deployed.address, target);
    await registerVenue(wallet, client, target.registry, deployed.address);
    saveVenueState(cfg, { venue: deployed.address, round: target.round, registry: target.registry });
    venue = deployed.address;
    deployBlock = deployed.blockNumber;
    // The previous round's price scale is meaningless for the new asset — drop strategy memory so
    // the first quote prices purely off the new feed.
    recentPrices.length = 0;
    lastFairWad = null;
    state.lastFeedPriceWad = null;
    state.lastQuoteMs = null;
    pairStale = false;
    log(`venue ${deployed.address} registered for round ${target.round} — quoting resumes on the next feed tick ✓`);
  }
  registryWatch = setInterval(() => {
    if (stopped || watchBusy) {
      return;
    }
    watchBusy = true;
    void (async () => {
      try {
        let fresh: RoundContext;
        try {
          fresh = await fetchRoundContext(cfg.operatorApiUrl);
        } catch {
          return; // between rounds / mid-reset — wait for the next active round to compare against
        }
        if (!sameRoundContext(ctx, fresh)) {
          const registryChanged = fresh.registry.toLowerCase() !== ctx.registry.toLowerCase();
          log(
            registryChanged
              ? `organizer redeployed (registry ${ctx.registry} → ${fresh.registry}) — refreshing…`
              : `round changed (#${ctx.round} → #${fresh.round}) — refreshing…`,
          );
          const pairChanged =
            fresh.cashToken.toLowerCase() !== ctx.cashToken.toLowerCase() ||
            fresh.assetToken.toLowerCase() !== ctx.assetToken.toLowerCase();
          ctx = fresh;
          if (pairChanged) {
            // The venue's CASH/ASSET are immutable — it cannot fill the new round's pair. Stop
            // quoting it (every updatePrice would burn MON on a venue takers skip) and auto-deploy
            // a fresh venue for the new pair (kicked off below).
            pairStale = true;
            log("→ the round's token pair changed — this venue trades the OLD pair. Quoting paused; deploying a venue for the new round…");
          } else {
            needRelink = true;
            relinkNagged = false;
          }
        }
        if (pairStale && !redeploying) {
          redeploying = true;
          void redeployForNewPair()
            .catch((error) => {
              log(`auto-redeploy failed (${error instanceof Error ? error.message : String(error)}) — retrying on the next watch tick`);
            })
            .finally(() => {
              redeploying = false;
            });
          return;
        }
        if (needRelink) {
          // A fresh registry has an empty roster, and registration is manual — wait for you to
          // re-register on the dashboard, then re-link the venue.
          if (!(await isMarketMakerRegistered(client, ctx.registry, address))) {
            if (!relinkNagged) {
              log(`→ your team isn't on the NEW roster yet — re-register on the dashboard (${cfg.dashboardUrl}, Register tab, wallet ${address}); the bot re-links the venue once you do.`);
              relinkNagged = true;
            }
            return;
          }
          await registerVenue(wallet, client, ctx.registry, venue!);
          needRelink = false;
          log("re-registered on the new registry ✓");
        }
      } catch (error) {
        log(`registry watch: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        watchBusy = false;
      }
    })();
  }, 30_000);
}
