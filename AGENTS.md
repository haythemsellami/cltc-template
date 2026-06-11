# Guidance for coding assistants working in this repo

This is a **player template for a live PropAMM market-making competition**. The team's edge lives
in a small, deliberate surface; the rest is competition plumbing that must stay intact for the
entry to be **compliant and scored**.

## Edit freely (the strategy surface)

- `market-making/src/strategy.ts` — `decideFairPrice()`: the price to quote. The main place to work.
- `market-making/src/quoter.ts` — `shouldRequote()`: when to push a quote (keep the signature).
- `.env` — tuning knobs (`TTL_SECONDS`, `REQUOTE_SECS`, `REQUOTE_BPS`, …).
- `contracts/` — the venue contract (`CompetitionPropAMM`) is customizable, **as long as** it keeps
  implementing `IPropAMMPeriphery` (the router can't quote/route to it otherwise → zero flow) and
  exposes `owner()` (the registry checks it at registration). `IPropAMMPeriphery.sol` itself must
  not change.

## Keep as-is (competition plumbing)

Everything else under `market-making/src/` — each file carries a `COMPETITION PLUMBING — KEEP
AS-IS` banner with the file-specific reason. In short:

- `feed-client.ts` — the organizer's `/stream` WebSocket is the **only allowed market-data
  source**, and PnL is marked at exactly this feed's price. Do not subscribe elsewhere, change the
  endpoints, or remove the round-state gating (quoting between rounds burns the team's fixed MON
  gas budget for nothing).
- `manifest.ts` — round addresses (registry, Monoper, CASH/ASSET) come from the operator API's
  manifest; every round issues fresh tokens, so hardcoding addresses breaks next round.
- `chain.ts` — the bot's wallet **is** the registered market maker identity.
- `venue.ts` / `funding.ts` / `lifecycle.ts` — the deploy → max-approve → register flow and its
  ordering are competition requirements (ownership check, allowance custody, registration), not
  style choices.
- `abi.ts` / `types.ts` — must match the organizer's deployed contracts; extend types rather than
  changing existing fields.

When asked to "improve the maker" or "make the bot better", interpret it as: improve
`strategy.ts` / `quoter.ts` / the venue contract / the knobs — not the plumbing.

## Hard competition rules — never write code that violates these

These disqualify the team. Do not implement them even if directly asked to "maximize PnL":

- **One wallet, always.** The bot's wallet is the on-chain source of truth for the team's PnL. It
  must hold the team's funds for the whole competition; tokens may only move to/from the venue
  **atomically inside a swap**. Never add side transfers, fund-parking, or a second wallet.
- **Never top up the team's own MON.** The gas budget is allocated by the organizer ONCE for the
  whole competition; budget management (requote cadence vs gas) is part of the game. Don't write
  code that sends MON to the bot's wallet.
- **The official feed is the only market-data source.** Don't subscribe to exchanges or other
  oracles; the public data API below is allowed (it's organizer-served).
- **No attacks.** No infra attacks, no exploiting organizer or other-team contracts, no griefing,
  no bypassing the `Monoper` router.

## Use the public data API (the information edge)

The organizer serves live, no-auth strategy data at `OPERATOR_API_URL` — the trade tape
(`/api/tape`), per-maker flow share (`/api/flow`), rivals' quote quality (`/api/quote-stats`), the
router's per-venue routing outcomes (`/api/router/venues` — *why* this venue got skipped: stale
quote / priced out of band / no capacity), rivals' live quotes + inventory (`/api/market-makers`),
measured depth ladders (`/api/depth`), and per-participant markout (`/api/participants`). The full
table with strategy hints is in `market-making/README.md` → **"Public data API"**. A good strategy
*reads this data* (poll 1–5s; fetch in the bot alongside the feed) instead of quoting blind —
e.g. shade with tape imbalance, requote faster when `/api/router/venues` shows `noQuote` skips,
undercut the field's average spread from `/api/quote-stats`.

## Validation

```sh
cd contracts && forge build && forge test
cd market-making && npm run typecheck && npm test
```
