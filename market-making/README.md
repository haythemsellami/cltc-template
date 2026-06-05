# market-making/

The bot that runs your competition entry end-to-end: it resolves the active round, deploys + funds +
registers your `CompetitionPropAMM` venue, then **quotes off the organizer's live WebSocket feed** —
re-pricing via `updatePrice(fairPrice, validUntil)` on a cadence and whenever the market moves.

**The easiest place to start adding an edge is [`src/strategy.ts`](src/strategy.ts)** — one function,
`decideFairPrice(tick)`. The default quotes flat at the feed. (The venue contract in
[`../contracts`](../contracts) is also yours to customize — both surfaces count.)

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

The feed subscription follows the round automatically (the bot reads the live symbol/streams from
the operator API); set `FEED_PRICE_STREAM` only to pin a specific stream.

Re-running deploys a **fresh** venue. To keep market-making the **same** venue across restarts, pass
its address:

```sh
VENUE=0xYourVenue npm start     # skip deploy/fund; just re-link the venue + quote
```

## Configuration

Set via `.env` (preferred) or `--flags`. The organizer gives you `OPERATOR_API_URL`, `FEED_WS_URL`,
the RPC URL, and funds your address.

| flag | env | default | meaning |
|---|---|---|---|
| `--key` | `PRIVATE_KEY` | (generate) | your venue owner / deployer key |
| `--key-file` | `KEY_FILE` | `.venue-key` | where a generated key is stored/reused (gitignored) |
| `--operator-url` | `OPERATOR_API_URL` | `http://localhost:8080` | reads `GET /api/manifest` |
| `--feed-ws` | `FEED_WS_URL` | `ws://localhost:7777/stream` | market-data WebSocket |
| `--feed-stream` | `FEED_PRICE_STREAM` | `btcusdt@aggTrade` | which stream to price off |
| `--rpc-url` | `RPC_URL` | `https://testnet-rpc.monad.xyz` | Monad testnet RPC |
| `--chain-id` | `CHAIN_ID` | `10143` | Monad testnet chain id |
| `--team` | `TEAM_NAME` | `my-team` | fallback venue label — your ROSTER name is what you registered on the dashboard |
| `--dashboard-url` | `DASHBOARD_URL` | `http://localhost:5176` | the maker dashboard (where you register your team) |
| `--ttl` | `TTL_SECONDS` | `30` | quote validity window (`validUntil = now + ttl`) |
| `--requote-secs` | `REQUOTE_SECS` | `15` | refresh at least this often (keeps the quote live) |
| `--requote-bps` | `REQUOTE_BPS` | `15` | re-quote immediately on a feed move this large |
| `--mon-gas` | `MON_FOR_GAS` | `0.5` | MON to require before proceeding (gas) |
| `--fallback-price` | `FALLBACK_PRICE` | `65000` | seed price if the feed hasn't ticked yet |
| `--venue` | `VENUE` | – | reuse a venue you already own (skip deploy + fund) |
| `--assume-funded` | – | off | skip the interactive funding gate |

## Writing a strategy

`decideFairPrice(tick)` returns a WAD-scaled CASH-per-ASSET price the venue fills every swap at.
There's no spread — your PnL comes from *where* you quote vs. the feed (the scorer marks your
inventory at the feed price). The `tick` gives you the latest feed price, a rolling window of recent
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
