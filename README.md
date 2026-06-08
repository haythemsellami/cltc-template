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
- **Scoring** (per round — this is the real rule): `net PnL = final CASH + final ASSET·(feed price) −
  initial capital − on-chain gas you spent`. Quote **above** the feed and you sell ASSET dear but
  informed takers pick you off; quote **below** and you win flow but give up edge; every on-chain
  write costs gas. That trade-off is the whole game.

**Two surfaces to compete on:** the venue logic (`contracts/`) and the quoting logic
(`market-making/`). The reference fills every swap at a single `fairPrice` with a `validUntil` expiry,
and the bot re-quotes to keep it live — that's just one simple design. A smarter venue (your own
pricing curve, spread/skew, inventory rules, a different expiry policy or none at all) and a smarter
bot both count. Anything that scores higher within the rule above wins.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for the contract)
- [Node.js](https://nodejs.org) ≥ 20 (for the bot)
- A Monad-testnet wallet key. The **organizer** funds your address with CASH + ASSET + MON, grants
  you tailnet access to the competition host, and gives you the RPC URL. The bot's
  `OPERATOR_API_URL` / `FEED_WS_URL` / `DASHBOARD_URL` already default to the live host.

## Quickstart

```sh
# 1. clone (with submodules — they're the contract's dependencies)
git clone --recurse-submodules <your-fork-url> && cd <repo>
#    (already cloned without --recurse-submodules? run:  git submodule update --init --recursive)

# 2. build the contract  (if you skipped --recurse-submodules: forge install first)
cd contracts && forge build && forge test   # 6 tests pass
cd ..

# 3. configure
cp .env.example .env       # fill in PRIVATE_KEY + the URLs the organizer gave you

# 4. install + run the bot — deploys, funds, registers your venue, then market-makes
cd market-making && npm install && npm start
```

`npm start` listens until the organizer has an active round (start it any time — it picks the
round up the moment it goes live and prints its details: tokens, recommended capital, the feed's
market), then waits for you to **register your team manually on the maker dashboard** (Register
tab, connected as the bot's printed wallet — the registry enrolls the signer, and your venue's
owner must be that same address), waits for the round capital the organizer mints against the
roster, deploys your venue, max-approves it for CASH+ASSET (your inventory stays in your wallet),
registers it, seeds the first quote, then loops — re-pricing from your strategy. `Ctrl+C` prints a
summary. Re-running deploys a fresh venue; pass `VENUE=0x…` to keep market-making the same one.

## Make it yours

Two surfaces, both yours to change — start from the working defaults and improve whichever you like:

- **The venue** — [`contracts/src/CompetitionPropAMM.sol`](contracts/src/CompetitionPropAMM.sol). The
  reference quotes a symmetric spread (default 20 bps, settable via `setSpreadBps`) around one
  `fairPrice`, with no inventory limits, and expires quotes at `validUntil`. Change any of it: your
  own pricing curve, a wider/asymmetric spread or skew, fill rules, inventory
  management, expiry policy (or no expiry). Just keep it implementing `IPropAMMPeriphery` so the
  router can route to it, then re-run `forge build` — the bot picks up your new bytecode automatically.
- **The bot** — [`market-making/src/strategy.ts`](market-making/src/strategy.ts). `decideFairPrice(tick)`
  returns the price you publish each cycle (default: flat at the feed). Ships `applyBps` /
  `momentumBps` / `clamp` helpers + commented examples (fixed skew, momentum lean, smoothing). Tune
  cadence and sizing via `.env`.

The deploy / fund / register / feed plumbing is handled for you either way.

## More

- [`contracts/README.md`](contracts/README.md) — the venue, how it quotes/fills, manual deploy.
- [`market-making/README.md`](market-making/README.md) — the bot's full flag/env reference and the
  strategy API.

## Develop

```sh
cd contracts     && forge test            # 6 passing
cd market-making && npm run typecheck && npm test
```
