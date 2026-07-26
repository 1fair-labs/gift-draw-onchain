# Settlement export format

`scripts/verify-settlement.ts` reads a JSON file describing one draw's results and recomputes its
`settlement_hash` from them. The file is the *claim* — the on-chain `DrawCommit` is what it is
checked against.

Values below are from draw `20260720` on devnet, kept as a concrete illustration. Substitute the
completed draw you are checking — `seedHex` and `merkleRootHex` can also be read straight off that
draw's `DrawSeed` account.

```json
{
  "drawId": "20260720",
  "specVersion": 19,
  "seedHex": "6fe80288ac754c086a0011b725dc3ecf178f5b9e9ce848d37bc3ca796bc30472",
  "merkleRootHex": "c45ddb5ff9af0a6a331c53c3b82006c04f624d3712e915ee628e58c05251d8be",
  "prizes": [
    { "ticket_id": 5, "prize_bucket": "main_gift", "rank": 1, "gift_amount": 2.95690423 }
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

The prize rows are public through `GET /api/draws?action=leaderboard&drawId=…`, but that response is
shaped for display: it merges a ticket's jackpot row into its rank row and paginates at 100 entries.
For a small draw it maps over directly; for a draw with a jackpot hit or more than 100 entrants it
does not, and the export we publish is the reliable input.

A dedicated endpoint that emits this file directly is planned. Until then:

```bash
npm run verify-settlement -- --file settlement-20260720.json
```

A passing run prints `"ok": true` with `hashOk`, `winnerCountOk`, `seedOk`, `merkleOk` and `specOk`
all true, plus the Solscan link to the `DrawCommit` account holding the value it matched.
