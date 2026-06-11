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

## Validation

```sh
cd contracts && forge build && forge test
cd market-making && npm run typecheck && npm test
```
