# Settlement spec — the committed hashes

Current spec version: **21**. It is compiled into the program (`SETTLEMENT_SPEC_VERSION`), stored on
every `DrawSeed` and `DrawCommit`, and written to `draw_settlements.spec_version`. Changing any rule
below requires a new spec version and a program upgrade.

**v21 changed where the seed comes from and how many random bits a shuffle key uses — not the
hash.** Up to v20 the seed was fully determined by the entrant list, so whoever decided the last
entry could compute in advance how it moved the result. From v21 the hash of a Solana slot that did
not exist when the list was sealed is mixed into the seed (see [Settlement seed](#settlement-seed)),
and shuffle keys use 53 bits instead of 32 (see [Shuffle keys](#shuffle-keys-53-bits)). The same
entrants therefore produce a different result under v21 than under v20 — which is what the version
bump records. Draws settled under v20 keep verifying against their own rules.

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

Two steps since v21. First the **base seed**, exactly as before:

```text
base_seed = SHA256(drawId | periodEndIso | entrant_list_hash)
```

The base seed is **not supplied by the operator** — `draw_randomness` derives it inside the program from
the three arguments and stores the result as `DrawSeed.seed` (`settlement_seed_bytes` in
`programs/gift_draw_registry/src/lib.rs`, byte-identical to `settlementSeedHex` in
`server/lib/draw-settlement-seed.ts`). Given a draw id, a period end and an entrant list there is
exactly one possible seed, and it can only be written once the validator clock has passed
`period_end_unix`.

Then the **slot entropy** (v21):

1. The same `draw_randomness` call creates `DrawEntropy` (PDA `["draw_entropy", drawId]`) with
   `target_slot = slot of that transaction + 2`.
2. Once `target_slot` has passed, `reveal_draw_entropy` — callable by **anyone** — takes the first
   non-skipped slot `>= target_slot` from the `SlotHashes` sysvar and stores

   ```text
   seed = SHA256(base_seed[32 bytes] ‖ slot as u64 little-endian[8] ‖ slot_hash[32])
   ```

   in `DrawEntropy.seed`, with `slot` and `slot_hash` beside it (event `DrawEntropyRevealed`).
   Source: `entropy_seed_bytes` in the program, `entropySeedHex` in
   `server/lib/draw-settlement-seed.ts`.
3. `commit_draw_result` requires a revealed `DrawEntropy` and writes that seed into
   `DrawCommit.seed`. It is the seed the winners are drawn from.

Nobody knows the hash of `target_slot` when the list is sealed, so the list cannot be tuned to a
result, and because the reveal is permissionless the operator cannot hold a draw back either.

**Missed window.** `SlotHashes` keeps about 512 slots (~3.4 minutes). If nobody reveals in time,
`reveal` fails with `EntropyExpired`, and only then may the authority call `rearm_draw_entropy`: a
new `target_slot`, and `DrawEntropy.rearm_count` goes up by one (event `DrawEntropyRearmed`). A
re-armed draw stays visibly re-armed on-chain; in normal operation `rearm_count` is 0.

**Checking it:** `npm run verify-seed -- --drawId <id>` recomputes the base seed from the sealing
transaction, checks `target_slot` against that transaction's slot, recomputes the final seed from
`DrawEntropy` and compares it with `DrawCommit.seed`.

`commit_draw_result` copies `merkle_root` from the `DrawSeed` account rather than accepting it
again, so the two commitments cannot disagree about which draw they describe.

### Shuffle keys (53 bits)

Winners are drawn with Efraimidis–Spirakis keys, one uniform number per entry.
`SeedPrng.nextOpenUnit(salt)` computes `h = SHA256(seed ‖ "|open|{counter}|{salt}|")` and, from
v21,

```text
u = ((u64 big-endian of h[0..8]) >> 11) + 1) / 2^53        // in (0, 1], exact in a double
```

Before v21 it was `(u32 big-endian of h[0..4] + 1) / 2^32`: with many entrants two keys could
collide, and a tie went to the lower index — the older ticket. `nextBelow` / `nextU32` (jackpot
roll, split mode, free-pool size) are unchanged.

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

The **Mega Prize** is not paid out per draw — it accumulates. In the airdrop stage that is all it
does: the 5% carve above is the whole of it, `mega_prize_amount` per settled draw sums to the pot,
and no Mega Prize draw runs in this stage (its runner sits behind `if (IS_PAID_STAGE)`). How it is
drawn is a paid-stage rule and is documented with the paid version.

**No Mega Prize draw has run yet.** Nothing is committed on-chain for it until the first one settles.

## Grand Prize: when it fires

**This is not a hash-format rule and does not change the spec version.** It decides one boolean in
the settlement, so anyone reproducing a draw from its published seed needs it.

| Stage | When the Grand Prize pays out |
|---|---|
| **airdrop** (this repository) | `jackpot_hit = (draw_id is announced)`. The 1/30 roll decides nothing. The pot accumulates across the whole stage and pays out once, split three ways (`jackpot_split_mode = 2`). |
| **paid** (not launched) | `jackpot_hit = (roll30 == 0) OR announced` — documented with the paid version. |

Announcements are published before the draw they name is reached. That publication is what keeps a
scheduled trigger honest: *when* it fires stops being derivable from the seed, so it must not be
derivable only by the operator either. *Who* wins is untouched — still drawn from the committed
seed, still reproducible from the published entrant list.

### Reproducing a draw in this stage

`prng.nextBelow(30)` (counter 0) and `prng.nextBelow(3)` (counter 1, on a hit) are **still consumed
even where their results are discarded**. Skipping either would shift every later random —
winner selection, free-pool size — so the number stream is identical between the two stages and only
the one boolean differs. A verifier must consume them the same way.

### Guaranteed minimums

An announcement may carry a floor. When it does:

```text
jackpot_payout_total = max(jackpot_balance_before, guarantee_gift)
jackpot_topup_gift   = max(0, guarantee_gift - jackpot_balance_before)
```

Both figures are snapshotted onto the settlement row (`jackpot_guarantee_gift`,
`jackpot_topup_gift`) so a draw stays checkable even if a later announcement changes. The top-up is
**company money**: the prize pool's own arithmetic is untouched, and after a hit the pool still
rolls forward exactly this draw's 10% slice. The floor may be raised but never lowered.

This does not change the spec version. Prize amounts enter the hash as values, not as formulas — the
program stores an opaque `settlement_hash` and never evaluates them. A verifier reads the payout from
the published prize rows, exactly as before.

Implementation: `server/lib/draw-settlement.ts` (the branch), `server/lib/announced-draws.ts`
(announcements and floors).

## Settlement hash (v19 formula — current, used by v20 and v21)

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
| v21 | `drawId \| spec \| seed \| entrants \| winnerCount \| prizeBody` | current — same input; `seed` is the slot-entropy seed |
| v20 | `drawId \| spec \| seed \| entrants \| winnerCount \| prizeBody` | same input as v19; changed the pool split |
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
  version, and (v21) a revealed `DrawEntropy`, whose seed it commits.
- `reveal_draw_entropy` — no signer check by design; refuses a second reveal
  (`EntropyAlreadyRevealed`) and a target slot that has left `SlotHashes` (`EntropyExpired`).
- `rearm_draw_entropy` — authority only, and only once the target slot has left `SlotHashes`
  (`EntropyNotExpired` otherwise); counted in `rearm_count`.
- `roll_kind` / `roll_kind_batch` — roll is derived from the purchase signature, ticket index and
  **purchase slot**, so resending a roll cannot change its outcome.
