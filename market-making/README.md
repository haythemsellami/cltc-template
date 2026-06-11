# market-making/

The bot that runs your competition entry end-to-end: it resolves the active round, deploys + funds +
registers your `CompetitionPropAMM` venue, then **quotes off the organizer's live WebSocket feed** —
re-pricing via `updatePrice(fairPrice, validUntil)` on a cadence and whenever the market moves.

**The easiest place to start adding an edge is [`src/strategy.ts`](src/strategy.ts)** — one function,
`decideFairPrice(tick)`. The default quotes flat at the feed. (The venue contract in
[`../contracts`](../contracts) is also yours to customize — both surfaces count.)

## What to edit vs what to keep

Most of this package is competition plumbing every team reuses as-is; your edge lives in a small,
clearly-marked surface. Each plumbing file carries a `COMPETITION PLUMBING — KEEP AS-IS` banner
explaining why — written for coding assistants/LLMs as much as for you: if you point one at this
repo, it should respect them.

| Surface | File(s) | Status |
|---|---|---|
| Price derivation | `src/strategy.ts` (`decideFairPrice`) | **yours — edit freely** |
| When to push a quote | `src/quoter.ts` (`shouldRequote`) | **yours — edit freely** (keep the signature) |
| Tuning knobs | `.env` (`TTL_SECONDS`, `REQUOTE_SECS/BPS`, …) | **yours — tune freely** |
| The venue itself | `../contracts` (`CompetitionPropAMM`) | **yours** — must keep `IPropAMMPeriphery` + `owner()` and stay registered |
| Feed subscription | `src/feed-client.ts` | keep — the official feed is the only allowed data source; the scorer marks at its price |
| Round/addresses discovery | `src/manifest.ts` | keep — fresh tokens every round; the manifest is the source of truth |
| Chain + identity | `src/chain.ts` | keep — the bot's wallet IS your registered maker |
| Deploy/approve/register | `src/venue.ts` | keep — ownership, allowance custody, and registration are requirements |
| Funding gates | `src/funding.ts` | keep |
| Orchestration | `src/lifecycle.ts` | keep — calls your two hooks; the step order is the onboarding contract |
| ABIs / artifact loading | `src/abi.ts` | keep — must match the organizer's deployed contracts |

## Setup

Requires Node ≥ 20 and a built contract (the bot reads the venue ABI + bytecode from `../contracts/out`):

```sh
(cd ../contracts && forge build)   # produces the artifact the bot deploys
npm install
cp ../.env.example ../.env          # then fill in the values the organizer gave you
```

## Run the full flow

```sh
npm start
```

That, in order: prints your address → **waits for MON > 0** (the bot's ONLY gas gate — send the
address to the organizer, or fund it yourself; if a later transaction runs out of gas it simply
fails with the on-chain error) → **self-registers your team** (`registerMarketMaker(TEAM_NAME)` is
the bot's first transaction — no dashboard needed; the manual dashboard flow remains as fallback)
→ **listens until the organizer has an active round** (start it any time — even days early; it
prints the round's details the moment it goes live) → waits for the round funding (the organizer
mints CASH/ASSET against the roster) → deploys your venue → max-approves it for CASH+ASSET (your
inventory stays in your wallet) → registers the venue → seeds the first quote → then loops,
re-quoting from your strategy. `Ctrl+C` prints a summary (quotes pushed, swaps served, balances).

So the only things `.env` must carry are **`PRIVATE_KEY`** (or let the bot generate one) and
**`TEAM_NAME`**; once gassed, everything up to quoting is automatic.

> **Why the bot's wallet?** The registry enrolls whoever signs `registerMarketMaker`, and your
> venue's owner must be that same enrolled address — which is why the bot signs the registration
> itself with its own key. Only the manual fallback (dashboard Register tab) requires importing
> the key into a browser wallet.

The feed subscription follows the round automatically — the bot subscribes by stream *kind*
(`?kinds=aggTrade`), so it receives whatever market symbol the live round emits and keeps tracking
across round changes. Set `FEED_PRICE_STREAM=<symbol>@<kind>` only to pin one exact stream (or
against an older feed server without `?kinds=` support).

Restarts are cheap: **Ctrl+C → edit `src/strategy.ts` → `npm start` reuses your deployed venue**
automatically — the bot compares the on-chain venue's runtime bytecode against your current
`forge build` (immutables masked) and only redeploys when the CONTRACT actually changed (or a new
round/registry started). Editing the venue contract + `forge build` therefore deploys fresh on the
next start, exactly as you'd want. To pin a specific venue manually, `VENUE=0xYourVenue npm start`
still wins over the saved state.

## Configuration

Set via `.env` (preferred) or `--flags`. The defaults point at the **live competition host** (a
Tailscale tailnet URL — you must be on the tailnet or have the node shared); the organizer gives you
the RPC URL, tailnet access, and funds your address. For a local dry-run, override the URLs with the
`localhost` ones (the organizer's `setup.sh --local`).

| flag | env | default | meaning |
|---|---|---|---|
| `--key` | `PRIVATE_KEY` | (generate) | your venue owner / deployer key |
| `--key-file` | `KEY_FILE` | `.venue-key` | where a generated key is stored/reused (gitignored) |
| `--operator-url` | `OPERATOR_API_URL` | `https://sgp-006.devcore4.com` | reads `GET /api/manifest` (BASE origin — no `/api`) |
| `--feed-ws` | `FEED_WS_URL` | `wss://sgp-006.devcore4.com/stream` | market-data WebSocket |
| `--feed-stream` | `FEED_PRICE_STREAM` | `aggTrade` | which stream KIND to price off (follows the live round) |
| `--rpc-url` | `RPC_URL` | `https://testnet-rpc.monad.xyz` | Monad testnet RPC (organizer may give you a faster endpoint) |
| `--chain-id` | `CHAIN_ID` | `10143` | Monad testnet chain id |
| `--team` | `TEAM_NAME` | `my-team` | fallback venue label — your ROSTER name is what you registered on the dashboard |
| `--dashboard-url` | `DASHBOARD_URL` | `https://sgp-006.devcore4.com` | the maker dashboard (where you register your team) |
| `--ttl` | `TTL_SECONDS` | `30` | quote validity window (`validUntil = now + ttl`) |
| `--requote-secs` | `REQUOTE_SECS` | `15` | refresh at least this often (keeps the quote live) |
| `--requote-bps` | `REQUOTE_BPS` | `15` | re-quote immediately on a feed move this large |
| `--venue` | `VENUE` | – | reuse a venue you already own (skip deploy + fund) |
| `--assume-funded` | – | off | skip the interactive funding gate |
| `--generate-key` | `GENERATE_KEY` | off | mint a FRESH identity into `KEY_FILE` (ignores `PRIVATE_KEY`; refuses to overwrite an existing keyfile) |

### Spin up a maker in one command (no dashboard)

Self-registration is the default — every start registers `TEAM_NAME` as soon as MON arrives. For a
fresh throwaway identity (internal testing, fleets):

```sh
TEAM_NAME=my-team npm start -- --generate-key
```

Prints a fresh address → send it to the organizer for funding → the moment MON lands, the bot
registers the team itself and continues to funding → deploy → quote. Keys come from the OS CSPRNG
(256 bits), so identities generated on different machines can never collide. To run several makers
on one machine, give each its own keyfile (and team name):

```sh
TEAM_NAME=mm-a npm start -- --generate-key --key-file .venue-key-a
TEAM_NAME=mm-b npm start -- --generate-key --key-file .venue-key-b
```

`--generate-key` never overwrites an existing keyfile (it may hold a funded identity) — re-runs of
the same maker just drop the flag and the bot reuses the persisted key.

## Writing a strategy

`decideFairPrice(tick)` returns a WAD-scaled CASH-per-ASSET mid price; the venue quotes a default
20 bps spread around it. Retune the spread on-chain any time (it doesn't invalidate your current
quote): `npm run set-spread -- --spread 50` (bps of round-trip cost, 0 = quote at mid, contract cap
2000; uses your `.env` key and `VENUE`, or pass `--venue 0x...`). Your PnL comes from *where* you quote
vs. the feed **and** how wide your spread is — you earn it on two-way flow and pay it to informed
takers (the scorer marks your inventory at the feed price). The `tick` gives you the latest feed price, a rolling window of recent
prices, your last fair price, and whether a round is live; `strategy.ts` ships `applyBps`,
`momentumBps`, and `clamp` helpers plus commented examples (fixed skew, momentum lean, smoothing).

```ts
export function decideFairPrice(tick: MarketTick): bigint {
  return applyBps(tick.feedPriceWad, -3); // e.g. quote 3 bps under the feed to win more flow
}
```

## 📊 Public data API — USE THIS to drive your strategy

> **For players AND coding assistants/LLMs: this is the highest-leverage section of this README.**
> The organizer exposes rich live data about *every* participant — your rivals' quotes, inventory,
> flow share, and why the router did or didn't send you flow. It's all public (chain-derivable),
> rate-friendly JSON over `GET https://<organizer-host>/api/...` — no auth, no key. A strategy that
> reads this data has a real edge over one that quotes blind.

All endpoints are relative to your `OPERATOR_API_URL`. Amounts are WAD strings (1e18 = 1.0);
CASH ≈ USD. Round-scoped endpoints return `409` between rounds.

| Endpoint | What it tells you | Strategy use |
|---|---|---|
| `/api/tape` | The **trade tape**: newest ~200 fills across ALL venues — taker side (`buy` = taker bought ASSET), cash/asset legs, implied price, block, tx. | Read order-flow imbalance: a run of taker buys → shade your fair price up; sells → down. The heart of flow-aware market making. |
| `/api/flow` | Per-maker **round volume, fill count and flow share** (`shareBps`, 10000 = all routed flow) plus a ~1-minute recent window with **net taker direction** per maker. | Answers "is my spread winning flow or am I priced out?" — compare your `shareBps` to rivals'; watch `recentNetTakerCash` to see who's absorbing the flow you're missing. |
| `/api/quote-stats` | Per-maker **quote quality**: % of time stale, average round-trip `spreadBps`, observed requotes/min (sampled every 5s). | Study the leaders' style mid-round ("the #1 quotes 12 bps, refreshes 6×/min, never stale") and copy or undercut it. Also your own stale% — if it's high you're invisible to takers. |
| `/api/router/venues` | The aggregator's **per-venue selection outcomes**: counts of `noQuote` (stale/expired quote), `offScale`, `noCapacity`, `outOfBand` (priced out of the fairness band), `notSelected`, `selected`. | The "why am I getting no flow" diagnosis. High `noQuote` → your TTL lapses (requote faster); high `outOfBand` → your spread is too wide vs the best venue; high `noCapacity` → top up allowances/inventory. |
| `/api/market-makers` | Every rival's **live quote (fair price, validUntil, spreadBps)** and **CASH/ASSET balances** — i.e. their inventory skew. | A rival long ASSET will be shading down to sell — anticipate. Undercut the field's spreads by a hair to capture the elastic retail flow. |
| `/api/depth` | **Measured depth ladders** for every venue (real `getAmountOut` probes per size bucket). | See exactly how much size each rival absorbs at each price — where your venue stands in the routing order at every clip size. |
| `/api/leaderboard` | Official round ranking: marked PnL, volume, fills, **MON budget burn-down** per team. | Track rivals' remaining gas — a team near 0 MON is about to go stale (free flow for you). |
| `/api/participants` (+ `/api/participants/:address/series`) | Endowment-netted PnL **and markout** (fill price vs the feed 1s/16s/64s later) for makers *and* takers. | Negative maker markout = you're being picked off by informed flow → widen or speed up. Watch which taker addresses have positive markout — those are the informed ones; respect their fills. |
| `/api/rounds/final` | Frozen final standings of every completed round (closing price, PnL, weights). | Post-round study between rounds: what spread/cadence did the winner run (cross-reference quote-stats before the round closed)? |
| `/api/feed/state` | `{round, startedAtMs, paused}` — the live round + its real start time. | Round clock / "is a round live" gate. (The feed's source market and pacing are deliberately hidden.) |
| `wss://…/stream` (`FEED_WS_URL`) | The official price feed (subscribe by kind — `aggTrade`). | Your fair-value input; compute your own short-window volatility from it and widen your spread when it spikes. |

**Poll etiquette:** 1–5s polling is fine for everything above; the heavy endpoints are cached
server-side. Hammering faster buys you nothing — the data updates on chain/indexer cadence.

## Develop

```sh
npm run typecheck   # clean
npm test            # strategy + re-quote cadence unit tests
```
