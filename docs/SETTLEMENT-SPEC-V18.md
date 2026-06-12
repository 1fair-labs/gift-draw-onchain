# Settlement spec v18 — prize-level `settlement_hash`

## Summary

- **Spec version:** `18` (program constant `SETTLEMENT_SPEC_VERSION`, `draw_settlements.spec_version`).
- **On-chain `DrawCommit` layout:** unchanged (still `settlement_hash[32]`).
- **Program redeploy required:** yes — bump embedded spec `17` → `18` for new `draw_randomness` / `commit_draw_result`.
- **Legacy draws (spec 17):** Claim and `verify-draw-commit` use v17 hash (sorted winner ticket ids only).

## v18 hash input

Canonical prize lines (sorted), one per `draw_ticket_prizes` row:

```text
ticket_id:prize_bucket:rank:gift_amount_micro
```

- `main_ticket` → `gift_amount_micro = 0`
- `main_gift` / `jackpot_gift` → micro from human `gift_amount` (6 decimals)

Body = lines joined with `\n`. Hash:

```text
sha256(drawId | spec | seedHex | merkleRootHex | body)
```

Includes **rank**, **bucket**, **GIFT amount**, and **ticket prize** rows (`main_ticket`).

## Claim

When `spec_version >= 18`:

1. Recompute hash from all `draw_ticket_prizes` for the draw.
2. Compare to on-chain `DrawCommit.settlement_hash`.
3. For each pending row on this ticket: row must match a commit line (blocks DB amount/rank tampering).

## Deploy order

1. **Build** — Actions → **Build gift_draw_registry (Anchor)** (green run on `main` with spec 18).
2. **Upgrade program** (same Program ID `FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed`):
   - **GitHub (recommended):** Actions → **Deploy registry to devnet** (uses latest anchor-build `.so` + `CNFT_MINT_SECRET_KEY` in repo secrets).
   - **Local:** fresh `.so` in `artifacts/`, `CNFT_MINT_SECRET_KEY` in `.env.local`, then `npm run registry:upgrade`.
   - Do **not** use a mismatched `artifacts/gift_draw_registry-keypair.json` — upgrade with `--program-id FZzo…`, not a random CI keypair address.
3. Vercel already has TS v18 after deploy; **Redeploy** if needed.
4. New settlements only after steps 1–2; old draws on spec **17** stay valid.
