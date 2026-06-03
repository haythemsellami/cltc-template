# contracts/

The on-chain side of your competition entry: the **`CompetitionPropAMM`** reference venue you deploy,
plus the `IPropAMMPeriphery` interface the organizer's router speaks.

> **This is a starting point, not a fixed rule.** `CompetitionPropAMM` works out of the box, but the
> venue is fair game to improve — your own pricing curve, spread/skew, fill logic, inventory rules,
> expiry policy, whatever scores better. The **one hard requirement** is that your venue keeps
> implementing **`IPropAMMPeriphery`** (so the organizer's `Monoper` router can call `getAmountOut` /
> `swap` and route flow to it) and that you register it. Read the reference to see how it's quoted and
> filled, then change as much or as little as you like — both the contract and the bot are surfaces to
> compete on.

## Layout

```
src/
  CompetitionPropAMM.sol          # the reference venue you deploy — customize it freely
  interfaces/IPropAMMPeriphery.sol # the router <-> venue interface — keep implementing this
script/DeployVenue.s.sol          # optional manual deploy (the bot deploys for you by default)
test/CompetitionPropAMM.t.sol     # a starting test suite — extend it
```

## Setup

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation). Dependencies are git
submodules — after cloning:

```sh
forge install            # or: git submodule update --init --recursive
forge build              # compiles to out/  (the bot reads the venue artifact from there)
forge test               # 6 passing
```

If you cloned without submodules, `forge install` pulls them. The pinned versions are
`openzeppelin-contracts@v5.6.1` and `forge-std@v1.16.1`.

## How the reference venue works

This is how `CompetitionPropAMM` behaves as shipped — each of these is a design choice you can change.

- **Quote:** `QuoteState { uint256 fairPrice; uint64 validUntil; }`. `fairPrice` is WAD-scaled CASH
  per ASSET (1e18 = 1.0), the same scale as the market feed. `validUntil` is an absolute unix
  timestamp — past it, the quote is expired and nothing fills. (Want quotes that never expire, or a
  different curve? Change it.)
- **Fills:** every swap executes at exactly `fairPrice` — `CASH→ASSET` divides by it, `ASSET→CASH`
  multiplies by it. **No spread, no size cap, no inventory band.** The venue pays out of its own
  balance; a fill it can't cover just reverts. (Add your own spread/skew or inventory rules here.)
- **Control:** `updatePrice(fairPrice, validUntil)` (owner only) is how the bot re-prices. It runs no
  checks and always emits `PriceUpdated` — a handy re-quote signal.
- **Withdraw:** `withdraw(token, to, amount)` (owner only) pulls inventory back out, e.g. between rounds.

Whatever you change, keep implementing `IPropAMMPeriphery` and register the venue — that's all the
router needs to route flow to you.

## Deploy

The recommended path is the bot — `cd ../market-making && npm start` deploys, funds, registers, and
quotes in one command. To deploy by hand instead:

```sh
PRIVATE_KEY=0x… CASH=0x… ASSET=0x… TEAM_NAME=alpha \
  forge script script/DeployVenue.s.sol:DeployVenue --rpc-url "$RPC_URL" --broadcast
```

`CASH` / `ASSET` are the active round's token addresses (from the operator dashboard / `GET
/api/manifest`). After a manual deploy, point the bot at it: `VENUE=<address> npm start` to fund,
register, and start quoting.
