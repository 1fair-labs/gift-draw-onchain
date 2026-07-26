# Audit response — gift_draw_registry + settlement

Findings from the 2026-06 transparency review and what was done about them. Spec version at the time
of writing: **19**.

## The model, stated plainly

`gift_draw_registry` is a **commitment layer**, not a lottery engine. The program derives and stores
the draw seed, and stores the hash of the results. Winner selection itself runs off-chain in open
TypeScript (`server/lib/draw-settlement.ts`), and is verified by recomputing hashes from the
published rules and comparing them to what is on-chain.

What that model assumes:

- The settlement server runs the code published here. `verify-program-binary` proves it for the
  program; for the TypeScript, the evidence is that its outputs keep hashing to the committed values.
- The entrant list can be checked against `DrawSeed.merkle_root`.
- A roll is bound to the **purchase transaction slot**, not the slot the roll was sent in, and the
  database allows one roll transaction per ticket.
- Settlement reads `in_draw` tickets only. There is no recovery path that re-settles from `used`
  tickets (removed 2026-06).

---

## 1. Entrant list grinding (High) — mitigated, residual risk documented

**Finding:** `draw_randomness` accepts any 64-character `merkle_root_hex` from the authority.

**Mitigations**

| Layer | Action |
|---|---|
| Program | Seed is derived on-chain from the root; it is not an operator input. Commit is rejected before `period_end_unix`. |
| Server | The root is computed from verified `in_draw` entrants only, then re-read from the chain and compared. |
| Public | `GET /api/draws?action=entrants&drawId=…` publishes the full list and the exclusion reason for every non-entrant. |
| Verify | `scripts/verify-entrants.ts` re-hashes the list and re-applies the entrant rule. |

**Residual risk:** a key holder could call `draw_randomness` outside the settlement path with a
crafted root. The program cannot distinguish this. It is detectable only because the entrant list is
public — which is why it is published rather than summarised.

---

## 2. Reroll (High) — removed

**Finding:** the TypeScript accepted a `|reroll|<nonce>` component in the seed that the program did
not, which would have allowed grinding.

**Status:** removed. No `freshShuffleNonce` or `rerollNonce` remains in `settlementSeedHex`.

---

## 3. Roll slot grinding (Medium/High) — fixed in the program

**Finding:** rolls used `clock.slot` at instruction time, so the authority could retry a roll until
it liked the result.

**Fix:** `roll_kind` takes a `purchase_slot` argument and hashes that instead. Retrying with the same
inputs always yields the same roll, so there is nothing to gain from resending. The server passes the
slot from the payment transaction and re-checks the emitted event against it; the database holds one
`kind_roll_tx_sig` per ticket.

`roll_kind_batch` (added 2026-06) shares this property — it computes each ticket's roll through the
same `roll_from_inputs` against the same `purchase_slot`, and a unit test pins the two paths to
identical output.

---

## 4. `decode_merkle_root_hex` panic (Low) — fixed

The root is validated as 64 ASCII hex characters before parsing.

---

## 5. Re-settlement with `used` tickets — removed

**Finding:** an `includeUsedTickets` path allowed re-settling a draw with tickets already marked
used, making results irreproducible for a verifier.

**Status:** removed from `draw-settlement.ts`, `draw-manual.ts` and the on-chain settle path;
`admin-draw-reset-resettle.ts` deleted. The one-time `DrawSeed` PDA makes a silent re-settle
impractical regardless.

---

## 6. `winner_count` outside the settlement hash (Medium) — fixed in v19

**Finding:** under spec v18 the on-chain `winner_count` was stored beside `settlement_hash` but not
bound by it.

**Status:** fixed. Spec v19 includes `winnerCount` in the hash input, so a count that disagrees with
the prize set produces a different hash. This required the program upgrade that shipped v19.

---

## 7. Claim roll predictability (Medium) — documented, no code change

**Finding:** claim rolls use `purchase_slot = 0` and entropy derived from `claim:{prizeId}`.

**Response:** a claimed ticket has no payment transaction to bind to. The prize id is assigned when
the settlement is written — before any roll exists — so it is not selectable at roll time. The roll
is still on-chain and independently checkable. This remains a weaker binding than a purchase roll and
is listed as such in the README.

---

## 8. Single authority (structural) — documented

Seed and result commitments are written by one key. The program is a commitment board; the defence
is that every commitment is public and checkable, not that the writer is trustless. After the mainnet
audit the upgrade authority can be made immutable
(`solana program set-upgrade-authority --final`).

---

## Verification checklist for any draw

```bash
npm run verify-program-binary                       # the program is what this repo says
npm run verify-entrants -- --drawId YYYYMMDD        # the entrant list matches the chain
npm run verify-settlement -- --file export.json     # the results match the chain
npm run decode-kind-rolled -- <ROLL_TX_SIGNATURE>   # a winner's ticket kind was not chosen
```
