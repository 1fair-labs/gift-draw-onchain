# GiftDraw.today — On-Chain Transparency Mirror

**Program ID (devnet):** `FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed`
**Settlement spec:** v20

This repository is a **read-only audit mirror** for [GiftDraw.today](https://giftdraw.today). It holds the Solana program, its compiled binary, the settlement rules, and scripts that check a draw against the chain.

Start by proving the binary here is the program that actually runs — everything else in the repo is only evidence if that holds:

```bash
npm install
npm run verify-program-binary
```

---

## How every draw works

```
1. MINT     Ticket bought → on-chain roll → ticket kind assigned (common / event / legendary)
            Check: recompute the roll from the payment signature — decode-kind-rolled.ts

2. SEED     Draw closes → entrant list hashed → seed committed on-chain (DrawSeed PDA)
            Check: hash the published entrant list, compare to the chain — verify-entrants.ts

3. SETTLE   Winners picked from the seed by the open algorithm → hash committed (DrawCommit PDA)
            Check: recompute the hash from the results — verify-settlement.ts
```

Each step writes a record to Solana that nobody, operator included, can alter afterwards.

---

## What this repository covers

GiftDraw is currently in its **airdrop stage**: tickets are free, there is no wallet and no payment,
and every draw runs on Solana **devnet**.

| | Airdrop stage |
|---|---|
| Site | [giftdraw.today](https://giftdraw.today) |
| Cluster | devnet |
| Tickets | free — faucet, referrals, streaks, promos |
| Ticket rolls on-chain | yes |
| Draw seed + result on-chain | yes |

Everything documented here — the program, the settlement rules, the four verification scripts —
describes that stage, and every command below is written for it.

Scripts take `--cluster` (default `devnet`), plus optional `--rpc` and `--program-id`;
`verify-entrants` also takes `--api` for the site to read the entrant list from. Devnet SOL has no
monetary value, so treat the current deployment as a system under test.

---

## Verify it yourself

Four scripts. Three need nothing but a network connection — no API key, no database, no cooperation from us. Point them at any RPC you trust.

```bash
npm install
```

### 1. The published binary is the deployed program

```bash
npm run verify-program-binary
```

Pulls the executable bytes straight from the chain and compares them to `release/gift_draw_registry.so`. Same thing with the Solana CLI:

```bash
solana program dump FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed dumped.so --url devnet
```

### 2. A ticket's kind follows from its payment transaction

```bash
npm run decode-kind-rolled -- <ROLL_TX_SIGNATURE>
```

Decodes every `KindRolledV2` event in the transaction **and recomputes each roll** from the payment signature, ticket index and slot using the same SHA-256 the program uses. `recomputed roll ✓ matches` means the number was hashed, not chosen. Works on batched rolls (several tickets in one transaction).

You can also paste the `Program data:` base64 from Solscan directly:

```bash
npm run decode-kind-rolled -- --data "<PROGRAM_DATA_BASE64>"
```

### 3. The entrant list is the one the draw ran on

Draw ids are dates — `YYYYMMDD`, or `YYYYMMDD_N` when a day holds more than one. Use a recently
completed one:

```bash
npm run verify-entrants -- --drawId 20260720
```

Fetches the entrant list from the public API, hashes it here with the production hash function, and compares against `DrawSeed.merkle_root` — which was committed before the draw closed and cannot be rewritten. It also re-applies the entrant rule ([`server/lib/draw-entrant-rules.ts`](server/lib/draw-entrant-rules.ts)) to the raw ticket rows, so the API's own filtering is not taken on trust.

A draw with no published entrant list reports `entrant-list-not-published` rather than a mismatch —
a commitment with nothing to check it against is neither confirmed nor contradicted.

### 4. Prize amounts and ranks are the committed ones

```bash
npm run verify-settlement -- --file settlement-20260720.json
```

Recomputes `settlement_hash` from the draw's results and compares it to `DrawCommit.settlement_hash`. Change one amount, rank or ticket id and the hashes diverge. The export format is in [`docs/SETTLEMENT-EXPORT.md`](docs/SETTLEMENT-EXPORT.md).

**This one needs the results as input.** The prize rows are public (`GET /api/draws?action=leaderboard&drawId=…`), but assembling them into an export is a manual step today. A single endpoint that emits the export directly is planned; until then, this check is easier to run against a file we publish than to assemble from scratch.

---

## Can the operator cheat?

### "Rig which ticket type a buyer gets"

**No.** Ticket kind comes from the program at purchase time, out of a SHA-256 of the buyer's payment transaction signature + ticket index + slot ([`programs/gift_draw_registry/src/lib.rs`](programs/gift_draw_registry/src/lib.rs)):

```rust
pub fn roll_from_inputs(purchase_tx_sig: &[u8; 64], ticket_index: u16, slot: u64) -> u32 {
    let digest = hashv(&[purchase_tx_sig, &ticket_index.to_le_bytes(), &slot.to_le_bytes()]);
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) % 100_000
}
```

Validators produce the payment signature; the operator can neither predict nor pick it. The roll is bound to the **purchase** slot, not the slot the roll was sent in — so retrying a roll always yields the same result, and delaying it changes nothing. `scripts/decode-kind-rolled.ts` recomputes this hash for you.

### "Quietly add or remove someone from the entrant list"

**No.** Before the seed is committed, the sorted list of verified entrant ticket ids is hashed with SHA-256 and written on-chain as `DrawSeed.merkle_root`. Anyone can pull the list from the public API and recompute it.

> **On the name:** the on-chain field is called `merkle_root` for historical reasons. It is **not** a binary Merkle tree — it is a flat SHA-256 of sorted ticket ids joined by commas. There are no membership proofs; verification needs the full list ([`server/lib/draw-settlement-seed.ts`](server/lib/draw-settlement-seed.ts)).

Not every ticket carrying a draw id is an entrant: a paid ticket with no verified on-chain roll is excluded before hashing. That rule is [`server/lib/draw-entrant-rules.ts`](server/lib/draw-entrant-rules.ts), it has no I/O, and `verify-entrants.ts` re-runs it against the raw rows.

### "Commit the seed early and test outcomes before entries close"

**No.** `draw_randomness` takes a `period_end_unix` and enforces it on-chain:

```rust
let clock = Clock::get()?;
require!(clock.unix_timestamp >= period_end_unix, RegistryError::DrawPeriodNotEnded);
```

The Solana clock comes from validators. Committing early fails with `DrawPeriodNotEnded` (error 6006).

There is also nothing to grind: the program **derives** the seed itself from the draw id, the period end and the entrant list hash — it is not a value the operator hands in. One entrant list, one seed.

### "Change the winner selection algorithm secretly"

**No.** The algorithm is [`server/lib/draw-settlement.ts`](server/lib/draw-settlement.ts), published here. `settlement_spec_version` (`20`) is compiled into the program and stored in every `DrawSeed` and `DrawCommit`. Changing the rules means a new spec version and a program upgrade — an on-chain event, and `verify-program-binary` starts failing against this repo until the mirror is updated.

### "Re-run settlement with different seeds until the result is favourable"

**No.** Settlement is deterministic: the same seed and entrant list always produce the same winners, and the seed is on-chain before settlement runs. One seed, one outcome.

### "Alter prize amounts or winner ranks after the draw"

**No.** The committed hash covers every prize row:

```
SHA-256(drawId | specVersion | seedHex | entrantListHash | winnerCount | prizeLines)
```

Each prize line is `ticket_id:prize_bucket:rank:gift_amount_micro`. Editing any amount, rank or count in the database changes the hash, and the payout path refuses to release a prize whose recomputed hash does not match `DrawCommit.settlement_hash`.

### "Rewrite the database to swap winners"

**No.** Same gate: the server recomputes `settlement_hash` from the database rows at claim time and rejects anything that does not match the on-chain commitment.

### "Upgrade the program to change the rules"

**Visible.** The program is upgradable while on devnet. Any upgrade is a public on-chain transaction, and `verify-program-binary` compares this repo against the live bytecode — a silent upgrade shows up as a mismatch. Before mainnet the upgrade authority will be transferred to a multisig or burned.

---

## What this does not protect against

An audit mirror is worth less if it only lists its own strengths.

- **The entrant list comes from us.** The chain commits its *hash*, not the list. If a ticket were dropped before the seed was committed, the hash would match a list that was already short. What the commitment prevents is editing after the fact — the list you get today must be the one hashed before the draw closed.
- **A key holder could bypass the server.** `draw_randomness` accepts any 32-byte root from the authority key. A crafted root written outside our settlement path is detectable exactly because the entrant list is public — that is the point of publishing it — but the program itself cannot tell the difference.
- **Free-ticket quota is server-side.** How many free entries are sampled into a draw is settlement logic, not a program constraint. It is deterministic from the seed and open in `draw-settlement.ts`, but nothing on-chain enforces it.
- **Claim rolls use `purchase_slot = 0`.** A claimed ticket has no payment transaction, so its roll is bound to the prize id instead. The prize id is assigned at settlement, before any roll — but it is a weaker binding than a purchase roll.
- **Devnet.** The airdrop stage runs on Solana devnet, where SOL has no value — treat it as a system under test.
- **One draw namespace per cluster.** `DrawSeed` and `DrawCommit` are addressed by draw id alone, so a cluster holds exactly one deployment's draw commitments.
- **One authority key.** Seed and result commitments are written by a single key. The commitments are public and checkable; the writing is not decentralised.

---

## Win probability

Set by the program at purchase:

| Kind | Probability | Draw weight |
|---|---|---|
| Legendary | 1 in 10,000 (0.01%) | 500× |
| Event | 1 in 1,000 (0.1%) | 50× |
| Common | ~99.89% | 1× |

Free tickets enter with a lower weight: promo 0.2×, welcome 0.3×, referral 0.4×.

Winner order uses the Efraimidis–Spirakis weighted shuffle — [`server/lib/draw-settlement.ts`](server/lib/draw-settlement.ts), weights in [`server/lib/draw-ticket-weights.ts`](server/lib/draw-ticket-weights.ts).

---

## Where the prize pool goes

Each draw's pool is split before winners are paid ([`server/lib/draw-settlement.ts`](server/lib/draw-settlement.ts)):

| Share | Rate | Purpose |
|---|---|---|
| Jackpot | 10% | Grand Prize, carried forward until hit |
| Company | 10% | Operator |
| Referral reserve | 5% | Funds inviter rewards |
| Mega Prize | 5% | Accumulates for a separate draw — see below |
| Burn | 1% | GIFT removed from supply |
| Network costs | estimated | Solana fees for the draw |
| **Winners** | **the rest** | Paid out by rank |

Each share is written to its own column on `draw_settlements` (`jackpot_contribution`,
`company_amount`, `referral_amount`, `mega_prize_amount`, `burn_amount`, `ops_amount_est`,
`winner_pool_snapshot`), so any settled draw can be checked against these rates.

These rates are constants at the top of the settlement module, and the resulting per-row amounts are what the on-chain `settlement_hash` commits to.

---

## Mega Prize

Introduced in **spec v20**.

- 5% of every draw's pool is set aside rather than paid out that day
- The pot only grows — nothing is ever withdrawn from it per draw
- It is a running total, not an on-chain account: the sum of `mega_prize_amount` over completed
  settlements, auditable per draw from the same rows every other share is checked against

### Who plays

An entry is a ticket **bought with money**. One ticket, one entry, and every entry is equal.

Free tickets do not enter. The airdrop fills the pot through the 5% carve, but only bought
tickets play for it. Ticket kind (common / event / legendary) decides prize weight in the daily
draw and is **ignored** here — a legendary is one entry, exactly like a common.

Buying more tickets means holding more entries, so odds rise in direct proportion to what was
spent — and a holder of a single entry can still beat a holder of thousands.

| | Enters the Mega Prize |
|---|---|
| bought with USDC | yes — one entry per ticket |
| bought with GIFT | from the second draw on (see below) |
| free (faucet, referral, promo, welcome) | no |
| Play Dollar (airdrop currency) | no |

The USDC-to-GIFT switch is **resolved from state, not scheduled**: GIFT-bought tickets start
counting once a Mega Prize draw has completed. Since the first draw cannot run until the unlock
ledger is fully released, "a completed draw exists" is itself the proof that unlock finished —
there is no date to trust and no flag for the operator to flip early or late
(`resolveMegaPrizeCurrencies`, which fails closed to USDC-only).

### One winner

Rank 1 takes the **entire pot**. Lower ranks are recorded so the results table can show a
finishing order, and every one of them carries `gift_amount = 0` — the prize is never split.

### How it is committed

The same three-step shape as a daily draw, using the same instructions and the same
`SeedPrng` — the draw id is `MEGA-YYYYMMDD`, which fits `MAX_DRAW_ID_LEN`:

```text
entrant list  ->  SHA-256 of sorted ticket ids  ->  DrawSeed.merkle_root   (draw_randomness)
seed          ->  derived by the program from draw id + period end + list hash
ordering      ->  the daily draw's weighted shuffle with every weight set to 1,
                  which is a uniform draw
result        ->  settlement_hash                                         (commit_draw_result)
```

Rules: [`server/lib/mega-prize-draw.ts`](server/lib/mega-prize-draw.ts). No program upgrade was
needed for any of it — the Mega Prize reuses instructions that already existed.

### When

The first draw runs after the unlock stage completes. The pot sits **last** in the unlock ledger,
behind every referral accrual and every ticket prize, so it cannot be drawn until everything owed
to players has been released. After that it runs once a quarter, and the pot rebuilds in between.

> **Not yet run.** The mechanics above are implemented and published here, but no Mega Prize draw
> has taken place. There is nothing on-chain to verify for it until the first one settles.

---

## Jackpot

- 10% of every draw's pool accumulates
- Each draw takes one PRNG value from the settlement seed against 1-in-30 odds
- On a hit, the balance goes to the top 1–3 winners of that draw
- The jackpot roll is the **first** PRNG call from the seed — deterministic, and reproducible from the published algorithm

---

## On-chain accounts

| Account | PDA seeds | Content |
|---|---|---|
| `DrawSeed` | `["draw_seed", draw_id]` | entrant list hash, settlement seed, spec version |
| `DrawCommit` | `["draw_commit", draw_id]` | settlement_hash, winner_count, spec version |

View on Solscan: `https://solscan.io/account/<PDA>?cluster=devnet` — the scripts print the address and link for you.

PDA derivation: [`src/lib/on-chain-gift-draw/pda.ts`](src/lib/on-chain-gift-draw/pda.ts)

---

## Instructions

| Instruction | Purpose |
|---|---|
| `roll_kind` | Assign one ticket's kind, emitting `KindRolledV2` |
| `roll_kind_batch` | Same for several tickets in one transaction, grouped by purchase |
| `draw_randomness` | Commit the entrant list hash + settlement seed (after `period_end_unix`) |
| `commit_draw_result` | Commit the settlement hash and winner count |
| `initialize` | One-time config account setup |

`roll_kind_batch` exists only to fit more tickets in a transaction. It emits `KindRolledV2` events byte-identical to the single-ticket path — same `roll_from_inputs`, same spec version, same tag — so every decoder and check in this repo treats both the same way. A unit test in the program (`batch_roll_matches_single`) pins that equivalence. Batching does not touch fairness: a roll is bound to `purchase_slot`, never to the slot it was sent in.

---

## Repository contents

```
programs/gift_draw_registry/src/lib.rs    On-chain program (roll logic, seed & result commitment)
idl/gift_draw_registry.json               Anchor IDL (instruction + account layouts)
release/gift_draw_registry.so             Compiled binary — verify-program-binary proves it is deployed

server/lib/                               Production settlement code, mirrored verbatim
  draw-settlement.ts                        Winner selection (Efraimidis–Spirakis, spec v20)
  draw-settlement-seed.ts                   Seed + entrant list hash
  draw-entrant-rules.ts                     Who counts as an entrant (pure, no I/O)
  draw-entrants-public.ts                   The public entrant snapshot endpoint
  draw-ticket-verification.ts               On-chain roll checks applied at entry and settlement
  settlement-prize-commit.ts                Settlement hash formula (v17 / v18 / v19+)
  settlement-commit-hash.ts                 Re-exports of the above
  draw-ticket-weights.ts                    Ticket weights + weighted shuffle
  poker-payout-schedule.ts                  Prize distribution schedule
  mega-prize.ts                             Mega Prize reserve (5% of each pool)
  mega-prize-draw.ts                        Mega Prize draw — weights, ranking, single winner
  kind-roll-verify.ts                       Roll event verification
  gift-draw-registry-client.ts              Program client used by the server

scripts/
  verify-program-binary.ts                Deployed bytecode vs release/*.so
  verify-entrants.ts                      Published entrant list vs on-chain DrawSeed
  verify-settlement.ts                    Recomputed settlement hash vs on-chain DrawCommit
  decode-kind-rolled.ts                   Decode + recompute a ticket roll
  lib/chain.ts                            Standalone Solana reader (mirror-only plumbing)

src/lib/on-chain-gift-draw/               Client-side verification helpers
docs/
  SETTLEMENT-SPEC.md                      Hash formula and spec history
  SETTLEMENT-EXPORT.md                    Export format for verify-settlement
  VERIFY-ON-SOLSCAN.md                    Reading the accounts by hand
  AUDIT-RESPONSE.md                       Review findings and responses
```

`server/lib/*` is mirrored verbatim from production for reading; it is not what the scripts run on. The scripts depend only on the pure rule and hash modules, plus `scripts/lib/chain.ts`, which reads bytes and computes nothing.

The mirror is updated when the program is redeployed or the settlement rules change. An unchanged mirror with a passing `verify-program-binary` means the rules have not moved.

---

## Security

To report a vulnerability, open a [GitHub Security Advisory](../../security/advisories/new) or contact us via [giftdraw.today](https://giftdraw.today).
