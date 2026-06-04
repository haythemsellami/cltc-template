import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { formatEther, formatUnits, type Account, type PublicClient, type WalletClient } from "viem";

import { accountFromKey, createReadClient, createWalletClientFor, generatePrivateKey } from "./chain.js";
import type { BotConfig } from "./config.js";
import { FeedClient } from "./feed-client.js";
import { computeFundingRequirement, readBalances, waitForFunding } from "./funding.js";
import { fetchRoundContext, sameRoundContext } from "./manifest.js";
import { shouldRequote } from "./quoter.js";
import { decideFairPrice, type MarketTick } from "./strategy.js";
import type { Hex, QuoterState } from "./types.js";
import {
  buildVenueConstructorArgs,
  countSwaps,
  deployVenue,
  ensureMarketMakerRegistered,
  fundVenue,
  pushQuote,
  readVenueOwner,
  registerVenue,
  withdrawAll,
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

/** Best-effort wait for the first feed tick so we can seed a quote at a real price. */
async function waitForFirstPrice(feed: FeedClient, timeoutMs: number): Promise<bigint | null> {
  const start = Date.now();
  while (feed.latestPriceWad() === null && Date.now() - start < timeoutMs) {
    await sleep(250);
  }
  return feed.latestPriceWad();
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
  log(`feed        : ${cfg.feedWsUrl}  stream=${cfg.feedPriceStream}`);

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

  // ── round context ──────────────────────────────────────────────────────────────────────────
  banner("Resolving the active round");
  let ctx = await fetchRoundContext(cfg.operatorApiUrl);
  const printCtx = (): void => {
    log(`round #${ctx.round}`);
    log(`  registry : ${ctx.registry}`);
    log(`  monoper  : ${ctx.monoper}`);
    log(`  CASH     : ${ctx.cashToken}`);
    log(`  ASSET    : ${ctx.assetToken}`);
    log(`  initial  : ${fmt(ctx.initialCash)} CASH + ${fmt(ctx.initialAsset)} ASSET per maker (recommended)`);
  };
  printCtx();

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
        const vb = await readBalances(client, venue, ctx.cashToken, ctx.assetToken);
        const eb = await readBalances(client, address, ctx.cashToken, ctx.assetToken);
        log(`quotes pushed    : ${state.quoteCount}`);
        log(`swaps served     : ${swaps < 0 ? "unknown (RPC range limit)" : swaps}`);
        log(`venue CASH/ASSET : ${fmt(vb.cashWad)} / ${fmt(vb.assetWad)}`);
        log(`EOA   CASH/ASSET : ${fmt(eb.cashWad)} / ${fmt(eb.assetWad)}   (MON ${formatEther(eb.monWei)})`);
        log(`venue            : ${venue}`);
        if (cfg.withdrawOnExit) {
          log("withdrawing venue inventory back to the EOA…");
          await withdrawAll(wallet, client, venue, address, ctx);
          log("withdrawn.");
        }
      } catch (error) {
        log(`summary failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (cfg.venueOverride) {
    // ── reuse path ─────────────────────────────────────────────────────────────────────────
    banner("Reusing an existing venue");
    const owner = await readVenueOwner(client, cfg.venueOverride);
    if (owner.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`VENUE ${cfg.venueOverride} is owned by ${owner}, not your address ${address}`);
    }
    venue = cfg.venueOverride;
    // Bound the shutdown Swap-log scan to this session (the venue's creation block is unknown here).
    deployBlock = await client.getBlockNumber();
    log(`venue ${venue} owned by you ✓`);
    log("ensuring registration (idempotent)…");
    if (await ensureMarketMakerRegistered(wallet, client, ctx.registry, cfg.teamName)) {
      log(`enrolled on the roster as "${cfg.teamName}" ✓`);
    }
    await registerVenue(wallet, client, ctx.registry, venue);
    log("registered ✓");
  } else {
    // ── funding gate ───────────────────────────────────────────────────────────────────────
    banner("Funding gate");
    // The gate can outlast an organizer redeploy (fresh Registry/Monoper, or a new round). Re-resolve
    // the manifest after the wait and re-gate if the context changed under us — otherwise we would
    // deploy/fund/register against a registry that no longer exists in the manifest.
    for (;;) {
      const req = computeFundingRequirement(ctx, cfg.monForGasWei);
      await waitForFunding({ client, address, ctx, req, log, assumeFunded: cfg.assumeFunded });
      const fresh = await fetchRoundContext(cfg.operatorApiUrl);
      if (sameRoundContext(ctx, fresh)) {
        break;
      }
      log("organizer redeployed while we waited — refreshing the round context:");
      ctx = fresh;
      printCtx();
    }

    // ── deploy ────────────────────────────────────────────────────────────────────────────
    banner("Deploying your CompetitionPropAMM venue");
    const deployed = await deployVenue(wallet, client, buildVenueConstructorArgs(cfg.teamName, address, ctx));
    venue = deployed.address;
    deployBlock = deployed.blockNumber;
    log(`venue deployed un-quoted: ${venue}  (block ${deployBlock})`);

    // ── fund the venue with inventory ───────────────────────────────────────────────────────
    banner("Funding the venue with inventory");
    const bal = await readBalances(client, address, ctx.cashToken, ctx.assetToken);
    const moved = await fundVenue(wallet, client, venue, ctx, bal.cashWad, bal.assetWad, cfg.fundFractionBps);
    log(`moved into venue: ${fmt(moved.cashMoved)} CASH + ${fmt(moved.assetMoved)} ASSET`);

    // ── register ────────────────────────────────────────────────────────────────────────────
    banner("Registering the venue");
    // The registry requires roster enrollment (team name) before a venue can be linked. Ideally
    // you registered on the maker site already; if not, enroll here with TEAM_NAME.
    if (await ensureMarketMakerRegistered(wallet, client, ctx.registry, cfg.teamName)) {
      log(`enrolled on the roster as "${cfg.teamName}" ✓`);
    }
    await registerVenue(wallet, client, ctx.registry, venue);
    log("registered with the CompetitionRegistry ✓");
  }

  // ── seed the first quote ────────────────────────────────────────────────────────────────────
  // The venue deploys un-quoted, so it can't fill until the first updatePrice. Seed it (via your
  // strategy) from the feed — or a fallback if the feed hasn't ticked yet — before the loop runs.
  banner("Seeding the first quote");
  const seenPrice = await waitForFirstPrice(feed, 6_000);
  const firstPrice = seenPrice ?? cfg.fallbackPriceWad;
  log(
    seenPrice
      ? `feed price: ${fmt(firstPrice)}`
      : `feed has no tick yet — seeding fallback ${fmt(firstPrice)} (the loop corrects it)`,
  );
  const seeded = await quoteNow(firstPrice, Date.now());
  if (seeded) {
    log(`quote #${state.quoteCount}  fairPrice=${fmt(lastFairWad!)}  (feed ${fmt(firstPrice)}, validUntil +${cfg.ttlSeconds}s)`);
    log("");
    log("→ Venue is live. Ask the organizer to re-baseline your gas (so it's accounted for) before the round.");
  } else {
    log("→ First quote skipped (strategy returned a non-positive price) — the loop retries as the feed moves.");
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
    log(`feed: round ${round ?? "?"} ended`);
  });

  async function maybeQuote(): Promise<void> {
    if (stopped || inFlight || !venue) {
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
      log(`quote failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  }

  timer = setInterval(() => void maybeQuote(), 1_000);

  // ── registry watch: self-heal across organizer redeploys ───────────────────────────────────
  // If the organizer resets the competition mid-run (fresh Registry/Monoper), this maker's
  // registration vanishes with the old registry and it silently stops receiving flow. Poll the
  // manifest and re-register the venue on the new registry — or tell the operator to restart the
  // bot when the round's token pair changed (this venue holds the old pair).
  let watchBusy = false;
  registryWatch = setInterval(() => {
    if (stopped || watchBusy) {
      return;
    }
    watchBusy = true;
    void (async () => {
      try {
        const fresh = await fetchRoundContext(cfg.operatorApiUrl);
        if (sameRoundContext(ctx, fresh)) {
          return;
        }
        log(`organizer redeployed (registry ${ctx.registry} → ${fresh.registry}) — refreshing…`);
        const pairChanged =
          fresh.cashToken.toLowerCase() !== ctx.cashToken.toLowerCase() ||
          fresh.assetToken.toLowerCase() !== ctx.assetToken.toLowerCase();
        ctx = fresh;
        if (pairChanged) {
          log("→ the round's token pair changed — this venue trades the OLD pair. Restart the bot to deploy a venue for the new round.");
          return;
        }
        // A fresh registry has an empty roster — enroll there before re-linking the venue.
        await ensureMarketMakerRegistered(wallet, client, fresh.registry, cfg.teamName);
        await registerVenue(wallet, client, fresh.registry, venue!);
        log("re-registered on the new registry ✓");
      } catch (error) {
        log(`registry watch: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        watchBusy = false;
      }
    })();
  }, 30_000);
}
