# GiftDraw — on-chain trust model (spec + plan)

**Status:** devnet implementation in repo (enable with `GIFT_DRAW_REGISTRY_ENABLED=1` after deploy)  
**Last updated:** 2026-05-28 (anchored settlement + kind roll via events)

This document is the **single source of truth** for transparency work. Re-read this file instead of re-explaining in chat.

## Product intent (кратко)

| Момент | Что делаем | Что **не** делаем |
|--------|------------|-------------------|
| **Минт** | Оплата, Bubblegum, БД — **как сейчас**. Только **тип билета** (common/event/legendary) берём из **неизменяемой** on-chain программы. | Не пишем каждый билет в chain (нет PDA на каждый common). Не меняем flow минта. |
| **Розыгрыш** | **Anchored settlement:** правила + random **фиксированы в программе**; расчёт победителей — в **открытом TypeScript** (v17). Один **commit на draw** on-chain. Claim сверяется с chain. | Не гоняем весь v17 внутри Solana VM. Не «только Postgres». |
| **Доверие** | Rust program + TS integration — **публичный Git**. Program **immutable** (no silent upgrade). | Админ не может тихо поменять шансы или механику без нового Program ID. |

---

## 0. Где «логи» и публичны ли они

Когда программа выполняет `roll_kind`, она пишет **Anchor event** (например `KindRolled { kind, roll, purchase_tx_sig, ticket_index }`).

Это **не** логи вашего сервера. Это данные **внутри Solana-транзакции**, которые:

- попадают в **transaction metadata** (program logs / events);
- **публичны навсегда** — любой может открыть tx в [Solscan](https://solscan.io), [Solana Explorer](https://explorer.solana.com), Helius и т.д.;
- читаются через RPC: `getTransaction` → `meta.logMessages` и parsed events.

**Пример:** tx `5abc…` → вкладка *Program Logs* / *Events* → `KindRolled: kind=event, roll=45231`.

В приложении кнопка **«Verify roll»** = ссылка на эту tx + Program ID. Пользователь проверяет chain, а не только UI.

**Стоимость:** event-only = **только комиссия tx** (~0.000005 SOL), **без rent** за аккаунт на билет.

---

## 1. Problem today

| Area | On-chain today | Gap |
|------|----------------|-----|
| Payment | USDC/GIFT → treasury | OK |
| cNFT mint | Bubblegum | OK |
| **Ticket kind** | `pickRandomTicketKind()` (`Math.random`) → DB → `mint-prepare` trusts body | Operator can assign legendary without honest roll |
| **Admin grant** | DB insert only | Free legendary possible |
| **Draw** | seed + merkle only in **Postgres** | Rules/seed changeable without public trace |
| **Claim** | Supabase only | No chain check |

**Code map:**

- Kind roll (client): `src/lib/ticket-economy.ts`, `src/pages/MiniApp.tsx`
- Mint: `server/lib/mint-prepare-build.ts`
- Seed/merkle: `server/lib/lottery-settlement-seed.ts`
- Settlement: `server/lib/draw-settlement.ts`
- Claim: `server/lib/ticket-api-router.ts`

---

## 2. Target architecture — one immutable program

**One** Anchor program `gift_draw_registry` (Rust → `.so`), **upgrade disabled** (or multisig + timelock only).

```
┌──────────────────────────────────────────────────────────────────┐
│  gift_draw_registry  (immutable — same Program ID = same rules)   │
├─────────────────────┬──────────────────────┬─────────────────────┤
│  roll_kind          │  draw_randomness     │  commit_draw        │
│  (per payment)      │  (per draw_id)       │  (once per draw)    │
│  → KindRolled event │  → seed on-chain     │  → hash + roots     │
└─────────────────────┴──────────────────────┴─────────────────────┘
         ▲                      ▲                      ▲
         │                      │                      │
   public TS in Git        public TS v17           cron after settle
   (mint API)             (uses chain seed)         (claim verifies)
```

**Public Git (обязательно):**

- `programs/gift_draw_registry/` — Rust, правила ролла и константы spec version
- `src/lib/on-chain-gift-draw/` — как вызываем программу (tx build, parse events)
- `server/lib/draw-settlement.ts` — reference implementation v17

Изменение TS без смены program → verifiers увидят расхождение с on-chain seed / `spec_version` / `settlement_hash`.

---

## 3. Module A — Kind roll (events only) ✅

### 3.1 Purpose

After a real payment, **only** the program decides `common | event | legendary`. Result is **public** in the roll transaction event. **No per-ticket storage account.**

### 3.2 Rules (frozen in program, mirror `ticket-economy.ts`)

| Kind | Per 100_000 |
|------|-------------|
| legendary | 10 (1 / 10_000) |
| event | 100 (1 / 1_000) |
| common | 99_890 |

Free kinds (`welcome`, `referral`, `promo`): **not** via `roll_kind`. Unchanged off-chain grants; excluded from paid draw rules.

### 3.3 Instruction: `roll_kind`

**Signers:** sponsor (fee payer), as today.

**Inputs:** `purchase_tx_sig` (64 bytes), `buyer_wallet`, `ticket_index` (u16, 0 for single buy).

**Checks:**

1. Payment signature not used before (program or indexer dedupe; DB enforces before second roll).
2. Payment tx verified: success, treasury received ≥ 1 USDC equivalent (same as app).
3. `roll = SHA256(sig || ticket_index || slot) mod 100_000` → kind.

**Output (no per-ticket PDA):**

```rust
#[event]
pub struct KindRolled {
    pub purchase_tx_sig: [u8; 64],
    pub buyer: Pubkey,
    pub ticket_index: u16,
    pub roll: u32,      // 0..99_999
    pub kind: u8,       // 0 common, 1 event, 2 legendary
    pub slot: u64,
}
```

Separate PDA only for event/legendary — **out of scope for v1** (events are enough).

### 3.4 App integration (mint unchanged)

1. User pays → `purchase_tx_sig`
2. Sponsor sends tx: `roll_kind`
3. API parses `KindRolled` from **confirmed tx** (`getTransaction` / webhook)
4. Insert DB `ticket_kind` from event only
5. `mint-prepare` **fails** if request `ticketKind` ≠ parsed event
6. Bubblegum mint as today

**Remove:** `pickRandomTicketKind()` on paid path in `MiniApp.tsx`.

**Admin grants:** `purchase_tx_sig` with `admin_grant:` prefix → never call `roll_kind`; not eligible as paid in settlement.

### 3.5 Trust model

| Question | Answer |
|----------|--------|
| Logs public? | **Yes** — Solana tx metadata, forever |
| Git changes? | **Visible** — integration layer must call program |
| Change odds without deploy? | **No** — bytecode immutable |

---

## 4. Module B — Anchored settlement (draw) ✅

### 4.1 Purpose (суть)

- **Механика розыгрыша** (weighted shuffle, free quotas, jackpot, prize split) runs in **open-source TypeScript** (`draw-settlement.ts`, spec v17).
- **Нельзя сменить правила «по тихому»:** program embeds `SETTLEMENT_SPEC_VERSION` (and optionally `SPEC_RULES_HASH`); **draw seed** comes from program; result **committed** on-chain.
- Operator changing server TS without matching program + public code → `settlement_hash` / verifier scripts fail.

This is **not** full settlement inside BPF. This **is** mechanics bound to immutable on-chain rules + seed.

### 4.2 Flow per draw

```
1. Close entries (DB as today)
2. merkle_root = SHA256(sorted in_draw ticket ids)  — lottery-settlement-seed.ts
3. On-chain: draw_randomness(draw_id, merkle_root, period_end)
      → DrawSeed account OR DrawSeedEvent { seed[32], spec_version }
4. Off-chain: settleDrawById() using:
      - ticket list from DB
      - seed from step 3 (read from chain, not invented server-side)
      - SETTLEMENT_SPEC_VERSION from program constant
5. On-chain: commit_draw_result(draw_id, merkle_root, seed, settlement_hash, …)
      → one DrawCommit PDA per draw_id
6. Claim: API requires DrawCommit + hash / merkle proof before payout
```

**Seed (v1):** Program uses the **same formula** as `settlementSeedHex(draw_id, period_end, merkle_root)` and stores result on-chain — TS must use RPC-read seed only.

### 4.3 On-chain artifacts per draw

| Artifact | Storage | Purpose |
|----------|---------|---------|
| `DrawSeed` / event | 1 tx | Public randomness input for v17 |
| `DrawCommit` PDA | ~200–280 bytes | `merkle_root`, `seed`, `settlement_hash`, `spec_version`, counts |

### 4.4 Instructions

**`draw_randomness`** — once per draw; writes seed (crank / settlement authority).

**`commit_draw_result`** — once per draw; requires seed; checks `spec_version` matches program.

**Claim (API v1)** — read `DrawCommit` via RPC; recompute `settlement_hash` with public TS; payout only if valid.

### 4.5 Capacity (100 years daily draws)

Not a single “full” contract — **one new PDA per draw**. ~36_500 accounts over 100 years is fine on Solana. Cost is **cumulative rent** (~0.002–0.003 SOL per draw), not a hard entry limit.

### 4.6 Security outcome

| Threat | Mitigated? |
|--------|------------|
| Change settlement code secretly | **Yes** — verifiers + on-chain `spec_version` + public Git |
| Change seed after draw | **Yes** — seed on-chain before commit |
| Rewrite winners in DB only | **Yes** — claim checks commit / hash |
| Run full v17 inside BPF | **N/A** — intentionally in TS |

---

## 5. Repository layout (when built)

```text
programs/gift_draw_registry/
  src/lib.rs
  src/instructions/roll_kind.rs
  src/instructions/draw_randomness.rs
  src/instructions/commit_draw.rs
  src/events.rs

src/lib/on-chain-gift-draw/
  program-id.ts
  roll-kind.ts          # build tx, parse KindRolled
  draw-commit.ts
  verify-settlement.ts

scripts/verify-draw-commit.ts
```

Program ID and cluster in `.env.example` + About page.

---

## 6. Implementation plan

### Phase 0 — Hygiene

- [ ] Approve this doc
- [ ] Prod: restrict admin paid-kind grants
- [ ] Verify draw page: seed, merkle, spec, checker script link

### Phase 1 — Kind roll (devnet)

- [ ] `gift_draw_registry`: `initialize`, `roll_kind` + `KindRolled`
- [ ] Immutable deploy; document Program ID
- [ ] `src/lib/on-chain-gift-draw/roll-kind.ts` + API route
- [ ] Replace paid `pickRandomTicketKind`; `mint-prepare` enforcement
- [ ] UI: Verify roll → Solscan

### Phase 2 — Anchored draw (devnet)

- [ ] `draw_randomness` + `commit_draw_result`
- [ ] Cron: read seed from chain → `settleDrawById` → commit
- [ ] `scripts/verify-draw-commit.ts`
- [ ] Admin: link to DrawCommit

### Phase 3 — Claim gate (devnet → mainnet)

- [ ] Claim API: on-chain commit + hash / proof
- [ ] E2E tests; audit; mainnet

**Estimate:** ~6–10 weeks one Solana-capable dev (excludes audit).

---

## 7. On-chain operating costs (not development)

SOL ≈ **$150** used below. **Default: kind roll = events only.**

### 7.1 One-time

| Item | SOL | USD ≈ |
|------|-----|-------|
| Deploy program | ~1–3 | $150–450 |
| `Config` PDA | ~0.002 | ~$0.30 |

### 7.2 Per paid ticket — `roll_kind` (events only) ✅

| Item | Per ticket |
|------|------------|
| Tx fee (sponsor) | ~0.000005–0.00005 SOL (**&lt; $0.01**) |
| Account rent | **$0** |

| Tickets / month | Fees only (USD ≈) |
|-----------------|-------------------|
| 3_000 | **&lt; $1** |
| 30_000 | **&lt; $10** |

### 7.3 Per draw — anchored settlement

| Item | Per draw |
|------|----------|
| `draw_randomness` tx | ~$0.001 |
| `DrawCommit` PDA rent | ~0.002–0.003 SOL (~**$0.30**) |
| `commit_draw_result` tx | ~$0.001 |

**1 draw/day → ~$10/month** chain writes.  
**100 years ~36_500 draws → ~70–110 SOL total rent** if every `DrawCommit` stays open (no “capacity limit”, only economics).

### 7.4 Per claim (v1)

Server reads `DrawCommit` + verifies hash: **$0** extra on-chain at claim.

### 7.5 Unchanged

Bubblegum mint — same sponsor SOL as today.

---

## 8. Decisions

| # | Decision | Status |
|---|----------|--------|
| 1 | Kind roll storage | **Events only** (no per-ticket PDA) |
| 2 | Mint / Bubblegum | **Unchanged** |
| 3 | Settlement execution | **Public TS v17** |
| 4 | Settlement binding | **On-chain seed + spec_version + commit** |
| 5 | Full v17 inside BPF | **Out of scope** |
| 6 | Program | **Immutable** (or multisig upgrade only) |
| 7 | Who pays roll tx | Sponsor (default) — open |
| 8 | Admin promo on prod | Restrict paid-kind grants — open |

---

## 9. Acceptance criteria

**Kind roll**

- [ ] Every `ticket_origin=purchase` ticket has a `roll_kind` tx before mint.
- [ ] `KindRolled` in tx matches DB `ticket_kind`.
- [ ] `mint-prepare` rejects mismatch.
- [ ] Solscan link from ticket card works.

**Anchored draw**

- [ ] Every completed draw has `DrawCommit` on chain.
- [ ] Seed from chain matches `settlementSeedHex` formula in docs.
- [ ] Public script reproduces `settlement_hash` from export + seed.

**Claim**

- [ ] Claim blocked if ticket not in committed winner set.
- [ ] Claim succeeds for test winner with valid proof/hash.

**Immutability**

- [ ] Program upgrade authority documented (none or multisig).

---

## 10. References

- Probabilities: `src/lib/ticket-economy.ts`
- Settlement: `SETTLEMENT_SPEC_VERSION` in `server/lib/draw-settlement.ts`
- Seed: `server/lib/lottery-settlement-seed.ts`
- Anchor events: [Solana program events](https://www.anchor-lang.com/docs/features/events)
