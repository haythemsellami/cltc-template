# contracts/

The on-chain side of your competition entry: the **`CompetitionPropAMM`** venue you deploy, plus the
`IPropAMMPeriphery` interface the organizer's router speaks.

> **You compete off-chain.** Do **not** modify `CompetitionPropAMM.sol` — a modified venue is out of
> scope and will be rejected. Your only on-chain lever is `updatePrice(fairPrice, validUntil)`, which
> the bot in [`../market-making`](../market-making) calls for you. Read the contract to understand
> exactly how you're quoted and filled, then put your effort into your pricing strategy.

## Layout

```
src/
  CompetitionPropAMM.sol          # the venue you deploy (fills every swap at your fairPrice)
  interfaces/IPropAMMPeriphery.sol # the router <-> venue interface (don't touch)
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

## How the venue works

- **Quote:** `QuoteState { uint256 fairPrice; uint64 validUntil; }`. `fairPrice` is WAD-scaled CASH
  per ASSET (1e18 = 1.0), the same scale as the market feed. `validUntil` is an absolute unix
  timestamp — past it, the quote is expired and nothing fills.
- **Fills:** every swap executes at exactly `fairPrice` — `CASH→ASSET` divides by it, `ASSET→CASH`
  multiplies by it. **No spread, no size cap, no inventory band.** The venue pays out of its own
  balance; a fill it can't cover just reverts.
- **Control:** `updatePrice(fairPrice, validUntil)` (owner only) is the whole strategy surface. It
  runs no checks and always emits `PriceUpdated` — that event is the canonical re-quote signal the
  organizer's scorer watches.
- **Withdraw:** `withdraw(token, to, amount)` (owner only) pulls inventory back out, e.g. between rounds.

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
