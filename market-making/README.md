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

That, in order: **listens until the organizer has an active round** (start it any time — even days
early; it prints the round's details the moment it goes live: CASH/ASSET token addresses, the
recommended initial capital, and the feed's market/symbol/streams) → **waits for your manual team
registration** — open the maker dashboard's Register tab, connect THIS bot's wallet (the printed
address), and sign "Register team"; the bot polls the on-chain roster until you appear → waits for
the round funding (the organizer mints CASH/ASSET — and MON — against that roster) → deploys your
venue → max-approves it for CASH+ASSET (your inventory stays in your wallet) → registers the venue
→ seeds the first quote → then loops, re-quoting from your strategy. `Ctrl+C` prints a summary
(quotes pushed, swaps served, balances).

> **Why the bot's wallet?** The registry enrolls whoever signs `registerMarketMaker`, and your
> venue's owner must be that same enrolled address. So register with the SAME key the bot runs on:
> either set `PRIVATE_KEY` to a key your browser wallet holds, or import the generated `.venue-key`
> into your wallet before registering.

The feed subscription follows the round automatically — the bot subscribes by stream *kind*
(`?kinds=aggTrade`), so it receives whatever market symbol the live round emits and keeps tracking
across round changes. Set `FEED_PRICE_STREAM=<symbol>@<kind>` only to pin one exact stream (or
against an older feed server without `?kinds=` support).

Re-running deploys a **fresh** venue. To keep market-making the **same** venue across restarts, pass
its address:

```sh
VENUE=0xYourVenue npm start     # skip deploy/fund; just re-link the venue + quote
```

## Configuration

Set via `.env` (preferred) or `--flags`. The defaults point at the **live competition host** (a
Tailscale tailnet URL — you must be on the tailnet or have the node shared); the organizer gives you
the RPC URL, tailnet access, and funds your address. For a local dry-run, override the URLs with the
`localhost` ones (the organizer's `setup.sh --local`).

| flag | env | default | meaning |
|---|---|---|---|
| `--key` | `PRIVATE_KEY` | (generate) | your venue owner / deployer key |
| `--key-file` | `KEY_FILE` | `.venue-key` | where a generated key is stored/reused (gitignored) |
| `--operator-url` | `OPERATOR_API_URL` | `https://sgp-006.tail08a730.ts.net` | reads `GET /api/manifest` (BASE origin — no `/api`) |
| `--feed-ws` | `FEED_WS_URL` | `wss://sgp-006.tail08a730.ts.net/stream` | market-data WebSocket |
| `--feed-stream` | `FEED_PRICE_STREAM` | `aggTrade` | which stream KIND to price off (follows the live round) |
| `--rpc-url` | `RPC_URL` | `https://testnet-rpc.monad.xyz` | Monad testnet RPC (organizer may give you a faster endpoint) |
| `--chain-id` | `CHAIN_ID` | `10143` | Monad testnet chain id |
| `--team` | `TEAM_NAME` | `my-team` | fallback venue label — your ROSTER name is what you registered on the dashboard |
| `--dashboard-url` | `DASHBOARD_URL` | `https://sgp-006.tail08a730.ts.net` | the maker dashboard (where you register your team) |
| `--ttl` | `TTL_SECONDS` | `30` | quote validity window (`validUntil = now + ttl`) |
| `--requote-secs` | `REQUOTE_SECS` | `15` | refresh at least this often (keeps the quote live) |
| `--requote-bps` | `REQUOTE_BPS` | `15` | re-quote immediately on a feed move this large |
| `--mon-gas` | `MON_FOR_GAS` | `0.5` | MON to require before proceeding (gas) |
| `--fallback-price` | `FALLBACK_PRICE` | `65000` | seed price if the feed hasn't ticked yet |
| `--venue` | `VENUE` | – | reuse a venue you already own (skip deploy + fund) |
| `--assume-funded` | – | off | skip the interactive funding gate |

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

## Develop

```sh
npm run typecheck   # clean
npm test            # strategy + re-quote cadence unit tests
```
