# Settlement export format

`scripts/verify-settlement.ts` reads a JSON file describing one draw's results and recomputes its
`settlement_hash` from them. The file is the *claim* — the on-chain `DrawCommit` is what it is
checked against.

Values below are draw `20260906` on devnet — the same file as
[`examples/settlement-20260906.json`](../examples/settlement-20260906.json), so you can run it as it
stands. Substitute the completed draw you are checking; `seedHex` and `merkleRootHex` can be read
straight off that draw's `DrawSeed` account.

```json
{
  "drawId": "20260906",
  "specVersion": 20,
  "seedHex": "e0caa4c8ac006a307c2bd59c80f50896d7d0b02e528e46748a4373173858010f",
  "merkleRootHex": "b2bdbe6dba66f9a26cfa13c4deb9104da320aadd809be069594378599c1d33e2",
  "prizes": [
    { "ticket_id": 82, "prize_bucket": "main_gift", "rank": 1, "gift_amount": 24.57105878 },
    { "ticket_id": 93, "prize_bucket": "main_gift", "rank": 2, "gift_amount": 12.8161646 },
    { "ticket_id": 84, "prize_bucket": "main_ticket", "rank": 3, "gift_amount": null }
  ]
}
```

| Field | Source | Meaning |
|---|---|---|
| `drawId` | `draw_settlements.draw_id` | `YYYYMMDD`, optionally `_N` for extra draws in a day |
| `specVersion` | `draw_settlements.spec_version` | selects the hash formula; must equal the on-chain value |
| `seedHex` | `draw_settlements.random_seed_hex` | settlement seed |
| `merkleRootHex` | `draw_settlements.merkle_root_hex` | entrant list hash |
| `prizes[]` | `draw_ticket_prizes` | one object per prize row, **not** per winner |

Prize rows use the raw database shape — `ticket_id`, `prize_bucket`, `rank`, `gift_amount` — because
that is what the hash is computed over. `gift_amount` is a decimal GIFT amount; the hash uses its
micro-unit integer form (`gift_amount_micro`), converted by `server/lib/gift-amount-micro.ts`.

## Buckets

| Bucket | Awarded |
|---|---|
| `main_gift` | GIFT to a ranked winner |
| `main_ticket` | a free ticket instead of GIFT |
| `jackpot_gift` | Grand Prize share |

One ticket can hold two rows — a rank prize and a jackpot share. Both are separate lines in the hash,
so keep them separate here. Collapsing them (as the leaderboard UI does for display) changes the
hash and the check will fail.

## Building an export today

A worked example is in the repository, and it verifies against the chain exactly as published:

```bash
npm run verify-settlement -- --file examples/settlement-20260906.json
```

It was assembled entirely from public sources — `seedHex` and `merkleRootHex` read off that draw's
`DrawSeed` account, the prize rows from `GET /api/draws?action=leaderboard&drawId=20260906`.

To build one for another draw the same two sources apply, with one caveat: the leaderboard response
is shaped for display. For a small draw with no jackpot hit it maps over directly — `place` →
`rank`, `prizeKind: "gift"` → `main_gift` carrying `prizeGift` as `gift_amount`, `prizeKind:
"ticket"` → `main_ticket` with `gift_amount: null`. For a draw with a jackpot hit or more than 100
entrants it does not, because the merged jackpot row has to be split back into its own prize line
and the response paginates.

The site now emits this file directly, for any settled draw:

```bash
npm run verify-settlement -- --drawId 20260925
```

which reads `GET /api/draws?action=settlement-export&drawId=20260925` — the prize rows exactly as the
settlement hashed them, jackpot shares as their own lines — and checks it against `DrawCommit`.

A large draw does not fit one response (the host caps a response at 4.5 MB), so past 10 000 prize
rows the one-piece request answers `413` and the export is read in pages: `&page=0`, `&page=1`, …
up to `pageCount`. Each page repeats `drawId`, `specVersion`, `seedHex` and `merkleRootHex` and adds
`page`, `pageCount`, `totalRows` and its slice of `prizes`; joined, the slices are the file above.
Row order across pages does not matter — the hash sorts the rows itself. `verify-settlement
--drawId` and the verifier page do the paging for you.

A passing run prints `"ok": true` with `hashOk`, `winnerCountOk`, `seedOk`, `merkleOk` and `specOk`
all true, plus the Solscan link to the `DrawCommit` account holding the value it matched.
