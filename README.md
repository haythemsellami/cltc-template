# PropAMM Competition — Player Template

Your starting point for the PropAMM market-making competition on Monad testnet. Clone it, build, and
you have a **working entry out of the box**: a venue contract you deploy and a bot that market-makes
off the organizer's live price feed. Everything here is a **reference you're free to change** — the
`CompetitionPropAMM` venue *and* the bot are starting points, not fixed rules. Win however you like.

```
contracts/      Foundry project — the CompetitionPropAMM reference venue (customize it freely)
market-making/  Node bot — deploys/funds/registers your venue, then quotes off the live WS feed
.env.example    one config file for both (copy to .env)
```

## How the competition works

- You run an on-chain **venue** the organizer's `Monoper` router can route taker flow through. The
  only hard requirement is that it implements **`IPropAMMPeriphery`** (so the router can call
  `getAmountOut` / `swap`) and is **registered**. `CompetitionPropAMM` is a working reference that
  does this — run it as-is, or change how it prices, fills, expires, and manages inventory.
- An off-chain **bot** decides what price to publish and when, reacting to the organizer's one shared
  **official price feed** (WebSocket). The organizer runs **taker bots** that route orders through
  every registered venue — your fills depend on how competitive your quote is.
- **Scoring** (per round — this is the real rule): `score = final CASH + final ASSET·(feed price) −
  your starting capital`. Pure marked PnL — 1 CASH = $1, ASSET marked at the round's feed price,
  nothing else added or subtracted. **MON is a gas budget, not a penalty**: spending it never
  reduces your score — but it's granted **once for the whole competition**, so run out and you
  can't quote for the rounds that remain; managing it is part of the game. Every
  round starts fresh (identical capital, zero carried PnL). Quote **above** the feed and you sell
  ASSET dear but informed takers pick you off; quote **below** and you win flow but give up edge.
  That trade-off is the whole game.

**Two surfaces to compete on:** the venue logic (`contracts/`) and the quoting logic
(`market-making/`). The reference fills every swap at a single `fairPrice` with a `validUntil` expiry,
and the bot re-quotes to keep it live — that's just one simple design. A smarter venue (your own
pricing curve, spread/skew, inventory rules, a different expiry policy or none at all) and a smarter
bot both count. Anything that scores higher within the rule above wins.

**Third surface — information.** The organizer exposes a public **data API**: the live trade tape,
every rival's quote/spread/inventory, per-maker flow share, quote-quality stats, and the router's
per-venue "why you didn't get this order" outcomes. **Read
[`market-making/README.md` → "Public data API"](market-making/README.md#-public-data-api--use-this-to-drive-your-strategy)
before writing a strategy** — quoting blind concedes that edge to everyone who doesn't.

## Rules & fair play

- Compete on **both** surfaces — your venue contract (pricing, fills, inventory, expiry) and your
  off-chain strategy (fair price, update cadence). Both are fair game.
- Treat the **official feed as your only market-data source** (the organizer's public data API is
  also allowed).
- **One wallet, always.** Your registered wallet is the source of truth for your PnL: it must hold
  your funds for the whole competition, and tokens may only move to/from your PropAMM **atomically
  during a swap**. No side transfers, no parking funds elsewhere, no second wallet.
- **Never top up your own MON.** Your gas budget is allocated by the organizer **once for the
  whole competition** — managing it is part of the game; adding your own is cheating.
- **No hacking of any form.** Infra attacks, organizer-contract or other-team exploits, direct
  griefing, bypassing the router — any attack-shaped play disqualifies.

## Prerequisites

- [Foundry](https://docs.monad.xyz/tooling-and-infra/toolkits/monad-foundry#installation) (for the contract)
- [Node.js](https://nodejs.org) ≥ 20 (for the bot)
- The RPC URL the organizer gives you (also on the dashboard's About page). The **organizer**
  funds your address with CASH + ASSET + MON; the bot generates your wallet key on first run. The
  bot's `OPERATOR_API_URL` / `FEED_WS_URL` / `DASHBOARD_URL` already default to the live host.

## Quickstart

```sh
# 1. clone (no fork — keep your strategy private)
git clone --recurse-submodules https://github.com/haythemsellami/cltc-template.git && cd cltc-template

# 2. configure — fill in TEAM_NAME and RPC_URL (the organizer gives you the RPC)
cp .env.example .env

# 3. run — builds the contract, generates your key, prints your address, market-makes
cd market-making && npm install && npm start
```

Cloned without `--recurse-submodules`? Run `git submodule update --init --recursive` once.

`npm start` builds the contract (incremental — instant when unchanged), generates your key on the
first run (persisted in `.venue-key`) and prints **your address** — send it to the organizer to get
funded. Your **MON gas budget is granted once, for the whole competition**: every `updatePrice` and
swap spends from it, so make your requote cadence earn its gas — and if you customize transaction
sending, keep **gas limits tight**: Monad charges the gas **limit**, not gas used, so excess
headroom burns budget for nothing. The moment MON lands the bot **registers your team
automatically**, then listens until
the organizer has an active round (start it any time — it picks the round up the moment it goes
live), waits for the round capital the organizer mints against the roster, deploys your venue,
max-approves it for CASH+ASSET (your inventory stays in your wallet), registers it, seeds the first
quote, then loops — re-pricing from your strategy. `Ctrl+C` prints a summary. Restarting **reuses
your deployed venue** when the contract didn't change and deploys + registers the new build when it
did; pass `VENUE=0x…` to pin a specific venue.

## Make it yours

Two surfaces, both yours to change — start from the working defaults and improve whichever you like:

- **The venue** — [`contracts/src/CompetitionPropAMM.sol`](contracts/src/CompetitionPropAMM.sol). The
  reference quotes a symmetric spread (default 20 bps, settable via `setSpreadBps`) around one
  `fairPrice`, with no inventory limits, and expires quotes at `validUntil`. Change any of it: your
  own pricing curve, a wider/asymmetric spread or skew, fill rules, inventory management, expiry
  policy (or no expiry). Just keep it implementing `IPropAMMPeriphery` so the router can route to
  it — `npm start` rebuilds and deploys your new bytecode automatically.
- **The bot** — [`market-making/src/strategy.ts`](market-making/src/strategy.ts). `decideFairPrice(tick)`
  returns the price you publish each cycle (default: flat at the feed), and it's yours entirely —
  any price-derivation algorithm counts: momentum, mean-reversion, volatility-aware spreads,
  inventory skew, signals from the [public data API](market-making/README.md#-public-data-api--use-this-to-drive-your-strategy)
  (the trade tape, rivals' quotes, flow share), whatever scores. `applyBps` / `momentumBps` /
  `clamp` helpers + commented examples get you started; cadence lives in `src/quoter.ts` + `.env`.

The deploy / fund / register / feed plumbing is handled for you either way.

## More

- [`contracts/README.md`](contracts/README.md) — the venue, how it quotes/fills, manual deploy.
- [`market-making/README.md`](market-making/README.md) — the bot's full flag/env reference, the
  strategy API, and the **public data API** every strategy should read.
- [`AGENTS.md`](AGENTS.md) — **point your coding assistant/LLM here first**: what to edit vs keep,
  the hard competition rules it must never violate, and the data endpoints to build on.

## Develop

```sh
cd contracts     && forge test            # 6 passing
cd market-making && npm run typecheck && npm test
```
