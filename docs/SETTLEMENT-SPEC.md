# Settlement spec — the committed hashes

Current spec version: **20**. It is compiled into the program (`SETTLEMENT_SPEC_VERSION`), stored on
every `DrawSeed` and `DrawCommit`, and written to `draw_settlements.spec_version`. Changing any rule
below requires a new spec version and a program upgrade.

**v20 changed the prize pool split, not the hash.** A 5% Mega Prize reserve now comes off the pool
before winners are paid (see [Prize pool split](#prize-pool-split)), so payout *amounts* differ from
v19. The hash input is byte-for-byte the v19 formula — the hash is computed over the prize rows that
were actually produced, never over the rates that produced them. Verification of v19 draws is
unaffected.

## Entrant list hash

Committed as `DrawSeed.merkle_root` before the draw closes.

```text
entrant_list_hash = SHA256("1,2,5,10,…")     // sorted ticket ids, comma-joined, UTF-8
```

Despite the on-chain field name, this is **not** a binary Merkle tree — there are no membership
proofs, so verification needs the full list. Source: `server/lib/draw-settlement-seed.ts`
(`merkleRootFromTicketIds`).

Which tickets are in the list is decided by `server/lib/draw-entrant-rules.ts`. A ticket carrying the
draw id is excluded when:

| Reason | Condition |
|---|---|
| `invalid ticket kind/origin` | kind and origin disagree (e.g. a `common` ticket with a free origin) |
| `admin grant (no on-chain roll)` | `purchase_tx_sig` starts with `admin_grant:` |
| `no on-chain kind roll` | paid or claimed ticket with no `kind_roll_tx_sig` |
| `kind roll not verified on-chain` | roll signature present but never confirmed against the chain |

Free-origin tickets (promo, welcome, referral) are exempt — they have no purchase to bind a roll to.
Excluded rows keep their draw id and are marked `used` with the reason in `sync_error`, so the public
snapshot reports them separately rather than dropping them silently.

## Settlement seed

```text
seed = SHA256(drawId | periodEndIso | entrant_list_hash)
```

The seed is **not supplied by the operator** — `draw_randomness` derives it inside the program from
the three arguments and stores the result as `DrawSeed.seed` (`settlement_seed_bytes` in
`programs/gift_draw_registry/src/lib.rs`, byte-identical to `settlementSeedHex` in
`server/lib/draw-settlement-seed.ts`). Given a draw id, a period end and an entrant list there is
exactly one possible seed, and it can only be written once the validator clock has passed
`period_end_unix`.

`commit_draw_result` then copies `seed` and `merkle_root` from the `DrawSeed` account rather than
accepting them again, so the two commitments cannot disagree about which draw they describe.

## Prize pool split

The pool is the summed GIFT equivalent of the draw's paid entries. These shares come off the top,
and the remainder is the winner pool the payout schedule distributes:

| Share | Constant | Column on `draw_settlements` |
|---|---|---|
| 10% | `JACKPOT_CONTRIB_RATE` | `jackpot_contribution` |
| 10% | `COMPANY_RATE` | `company_amount` |
| 5% | `REFERRAL_RATE` | `referral_amount` |
| 5% | `MEGA_PRIZE_RATE` *(v20)* | `mega_prize_amount` |
| 1% | `BURN_RATE` | `burn_amount` |
| est. | tx fee estimate | `ops_amount_est` |

```text
winner_pool = max(0, pool − jackpot − company − referral − megaPrize − burn − ops)
```

Recorded as `winner_pool_snapshot`. Source: `server/lib/draw-settlement.ts`.

The **Mega Prize** is not paid out per draw — it accumulates across every settled draw, and is
awarded once, to a single entry, after the unlock stage completes (quarterly thereafter).

Its draw reuses this spec's primitives rather than defining new ones:

| | Daily draw | Mega Prize draw |
|---|---|---|
| Draw id | `YYYYMMDD` | `MEGA-YYYYMMDD` |
| Entrant list hash | SHA-256 of sorted ticket ids | same |
| Seed | derived by the program | same |
| Ordering | weighted shuffle (Efraimidis–Spirakis) | same primitive, all weights = 1 (uniform) |
| Who enters | tickets entered into that day's draw | tickets **bought with money**, free tickets excluded |
| Entry value | ticket kind weight | every entry equal — kind ignored |
| Winners | up to 25% of paid entries, by rank | **rank 1 only** — lower ranks are history rows with `gift_amount = 0` |
| Instructions | `draw_randomness`, `commit_draw_result` | same — no new instruction, no program upgrade |

`settlement_hash` for a Mega Prize draw is
`SHA256(megaDrawId | seedHex | entrantListHash | winnerTicketId | potMicro)` — a different body
from the daily formula, because there is exactly one prize row rather than a prize set. Rules:
`server/lib/mega-prize-draw.ts`.

The pot is released last in the unlock ledger, so the draw cannot run until every referral accrual
and ticket prize ahead of it has been paid.

**No Mega Prize draw has run yet.** Nothing is committed on-chain for it until the first one settles.

## Settlement hash (v19 formula — current, used by v20)

Committed as `DrawCommit.settlement_hash`.

```text
SHA256(drawId | specVersion | seedHex | entrant_list_hash | winnerCount | prizeBody)
```

- `winnerCount` — distinct ticket ids across all prize rows. Binding it into the hash means the
  separately stored `DrawCommit.winner_count` cannot disagree with the prize set.
- `prizeBody` — canonical prize lines, sorted, joined with `\n`
- each line — `ticket_id:prize_bucket:rank:gift_amount_micro`

Source: `server/lib/settlement-prize-commit.ts`.

### Earlier versions

| Spec | Hash input | Notes |
|---|---|---|
| v20 | `drawId \| spec \| seed \| entrants \| winnerCount \| prizeBody` | current — same input as v19; changed the pool split |
| v19 | `drawId \| spec \| seed \| entrants \| winnerCount \| prizeBody` | added `winnerCount` to the hash |
| v18 | `drawId \| spec \| seed \| entrants \| prizeBody` | prize rows, no winner count |
| v17 | `drawId \| spec \| seed \| entrants \| sortedWinnerIds` | winner ids only |

Draws settled under an older spec keep verifying against their own formula —
`settlementCommitHashHex` dispatches on the spec version stored with the draw.

## Payout gate

For spec 18 and above, a claim is only paid when:

1. the hash recomputed from all `draw_ticket_prizes` of the draw matches `DrawCommit.settlement_hash`, and
2. the specific prize row being claimed matches a line inside that committed body.

Step 2 is what stops a single row's amount or rank being edited: the total would still have to hash
to the committed value.

## Program guards

- `draw_randomness` — requires `period_end_unix`, rejects with `DrawPeriodNotEnded` (6006) if the
  window is still open; validates the 64-character hex root before parsing.
- `commit_draw_result` — requires the `DrawSeed` for the draw to already exist with a matching spec
  version.
- `roll_kind` / `roll_kind_batch` — roll is derived from the purchase signature, ticket index and
  **purchase slot**, so resending a roll cannot change its outcome.
