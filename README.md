# PropAMM Competition — Player Template

Your starting point for the PropAMM market-making competition on Monad testnet. Clone it, build, and
you have a working entry: a venue contract you deploy and a bot that market-makes off the organizer's
live price feed. **You win by pricing better, not by writing more code** — the contract is fixed; your
edge is the off-chain strategy in [`market-making/src/strategy.ts`](market-making/src/strategy.ts).

```
contracts/      Foundry project — the CompetitionPropAMM venue you deploy (don't modify it)
market-making/  Node bot — deploys/funds/registers your venue, then quotes off the live WS feed
.env.example    one config file for both (copy to .env)
```

## How the competition works

- Everyone runs the **same** `CompetitionPropAMM` venue. It holds your CASH + ASSET and fills every
  swap at the single `fairPrice` you publish via `updatePrice(fairPrice, validUntil)` — **no spread,
  no size or inventory limits.**
- The organizer broadcasts one **official price feed** over WebSocket and runs **taker bots** that
  route orders through everyone's venues. Your fills depend on how competitive your quote is.
- **Scoring** (per round): `net PnL = final CASH + final ASSET·(feed price) − initial capital −
  update gas`. So quoting **above** the feed sells ASSET dear but lets informed takers pick you off;
  quoting **below** wins flow but gives up edge; and every `updatePrice` costs gas. Find the balance.
- Quotes expire at `validUntil` — let it lapse and you stop filling. The bot re-quotes on a cadence
  to stay live.

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (for the contract)
- [Node.js](https://nodejs.org) ≥ 20 (for the bot)
- A Monad-testnet wallet key. The **organizer** funds your address with CASH + ASSET + MON and gives
  you the `OPERATOR_API_URL`, `FEED_WS_URL`, and RPC URL.

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

`npm start` resolves the active round, opens a funding gate (fund the printed address, or it
auto-detects), deploys your venue, moves inventory in, registers it, seeds the first quote, then loops
— re-pricing from your strategy. `Ctrl+C` prints a summary. Re-running deploys a fresh venue; pass
`VENUE=0x…` to keep market-making the same one.

## Make it yours

Edit **[`market-making/src/strategy.ts`](market-making/src/strategy.ts)** — the one function
`decideFairPrice(tick)` returns the price your venue advertises each cycle. The default quotes flat at
the feed; it ships `applyBps` / `momentumBps` / `clamp` helpers and commented examples (fixed skew,
momentum lean, smoothing) to build from. Tune cadence and sizing via `.env`. Everything else — the
venue contract, the deploy/fund/register/feed plumbing — is done for you.

## More

- [`contracts/README.md`](contracts/README.md) — the venue, how it quotes/fills, manual deploy.
- [`market-making/README.md`](market-making/README.md) — the bot's full flag/env reference and the
  strategy API.

## Develop

```sh
cd contracts     && forge test            # 6 passing
cd market-making && npm run typecheck && npm test
```
