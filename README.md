# gift-draw-onchain

Public on-chain draw rules for [GiftDraw.today](https://www.giftdraw.today) — Solana program source, settlement spec (v18), and verification scripts.

This repository is a **read-only transparency mirror**. It is updated only when the on-chain program is deployed or upgraded (see [Releases](https://github.com/1fair-labs/gift-draw-onchain/releases)).

The consumer app (UI, API, database) is **not** published here.

## On-chain program

| | |
|--|--|
| **Program ID** | `FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed` |
| **Devnet (Solscan)** | [View program](https://solscan.io/account/FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed?cluster=devnet) |
| **Devnet (Explorer)** | [View program](https://explorer.solana.com/address/FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed?cluster=devnet) |
| **Mainnet** | Deploy pending — same Program ID planned |

### Instructions (Anchor)

- `roll_kind` — ticket kind roll (`KindRolledV2` event)
- `draw_randomness` — per-draw seed commitment
- `commit_draw_result` — settlement hash + winner count on-chain

## What is in this repo

| Path | Purpose |
|------|---------|
| `programs/gift_draw_registry/` | Rust program (frozen rules, spec version) |
| `idl/gift_draw_registry.json` | Anchor IDL |
| `server/lib/draw-settlement.ts` | Off-chain winner selection (spec 18) |
| `server/lib/settlement-prize-commit.ts` | Settlement hash (v17 / v18) |
| `server/lib/lottery-settlement-seed.ts` | Merkle root + seed formula |
| `server/lib/gift-draw-registry-client.ts` | RPC / tx helpers |
| `src/lib/on-chain-gift-draw/` | Client-side verify helpers |
| `scripts/verify-draw-commit.ts` | Compare DB settlement vs on-chain commit |
| `scripts/decode-kind-rolled.ts` | Decode `KindRolledV2` from a tx |
| `docs/` | Trust model and settlement spec |

## Verify a completed draw

Requires Supabase read access (service role) and Solana RPC:

```bash
npm install
cp .env.example .env   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional RPC
npx tsx scripts/verify-draw-commit.ts --drawId YYYYMMDD
```

## Decode a kind roll transaction

```bash
npx tsx scripts/decode-kind-rolled.ts <ROLL_TX_SIGNATURE>
```

## Build program (auditors)

```bash
anchor build
```

See `docs/SETTLEMENT-SPEC-V18.md` and `docs/on-chain-trust-model.md`.

## License

MIT — see [LICENSE](LICENSE).
