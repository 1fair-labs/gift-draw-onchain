# GiftDraw.today — On-Chain Transparency Mirror

**Program ID (devnet):** `FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed`
**Settlement spec:** v21

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

2. SEED     Draw closes → entrant list hashed and sealed on-chain (DrawSeed PDA)
            → the hash of a slot two slots later is mixed in (DrawEntropy PDA)
            Check: hash the published entrant list, compare to the chain — verify-entrants.ts
            Check: recompute the seed from the chain alone — verify-seed.ts

3. SETTLE   Winners picked from the seed by the open algorithm → hash committed (DrawCommit PDA)
            Check: recompute the hash from the results — verify-settlement.ts
```

Each step writes a record to Solana that nobody, operator included, can alter afterwards.

---

## What this repository covers

**This repository documents the airdrop stage, and only the airdrop stage.** Tickets are free, there
is no wallet and no payment, and every draw runs on Solana **devnet**.

| | Airdrop stage |
|---|---|
| Site | [giftdraw.today](https://giftdraw.today) |
| Cluster | devnet |
| Tickets | free — faucet, referrals, streaks, promos |
| Ticket rolls on-chain | yes |
| Draw seed + result on-chain | yes |

Everything documented here — the program, the settlement rules, the verification scripts —
describes that stage, and every command below is written for it.

### Why you will see a free/paid branch in the code

GiftDraw runs as two deployments built from one codebase, sharing one database: the free version
(the airdrop stage, live) and a paid version (not launched). Every row of game state carries a
`stage`, and a few rules genuinely differ between the two — the Grand Prize trigger is the
important one, and it is spelled out under [Jackpot](#jackpot-grand-prize) below.

The files here are published **exactly as they run**, branch and all, rather than rewritten to hide
the half that does not apply. A rewritten file is a file you have to take on trust; this way the
branch is visible and you can check which side this deployment takes (`server/lib/stage.ts`).

The paid version's rules are **not** documented here, and this repository must not be read as
describing them. When it launches it gets its own audit mirror, which will link back to this one —
the airdrop's draws stay verifiable here forever, because the rules that settled them stay here
unchanged.

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
npm run verify-entrants -- --drawId 20260906
```

Fetches the entrant list from the public API, hashes it here with the production hash function, and compares against `DrawSeed.merkle_root` — which was committed before the draw closed and cannot be rewritten. It also re-applies the entrant rule ([`server/lib/draw-entrant-rules.ts`](server/lib/draw-entrant-rules.ts)) to the raw ticket rows, so the API's own filtering is not taken on trust.

A draw with no published entrant list reports `entrant-list-not-published` rather than a mismatch —
a commitment with nothing to check it against is neither confirmed nor contradicted.

### 4. The seed could not be known when the entrant list was sealed

```bash
npm run verify-seed -- --drawId 20260925
```

Reads the `draw_randomness` transaction that sealed the entrant list and recomputes the base seed
from its arguments, then (spec 21 and later) reads `DrawEntropy`: the target slot must be two
slots after the sealing transaction, and the seed must be
`SHA256(base_seed ‖ slot ‖ slot_hash)` for the slot the program actually used. Finally the seed
the draw was settled with (`DrawCommit.seed`) must be that value. Draws before spec 21 check the
base seed and the commit only.

### 5. Prize amounts and ranks are the committed ones

```bash
npm run verify-settlement -- --file examples/settlement-20260906.json
```

Recomputes `settlement_hash` from the draw's results and compares it to `DrawCommit.settlement_hash`. Change one amount, rank or ticket id and the hashes diverge. The export format is in [`docs/SETTLEMENT-EXPORT.md`](docs/SETTLEMENT-EXPORT.md).

**This one needs the results as input**, and the file above is a worked example so the command runs
out of the box. Every value in it came from public sources and none of it has to be taken from us:

| Field | Where it came from |
|---|---|
| `seedHex`, `merkleRootHex` | the draw's `DrawSeed` account on devnet |
| `prizes[]` | `GET /api/draws?action=leaderboard&drawId=20260906` |
| `specVersion` | the `DrawCommit` account (the script re-checks it anyway) |

Building your own export for a different draw is still a manual step — the leaderboard response is
shaped for display, so it merges a ticket's jackpot row into its rank row and paginates at 100.
[`docs/SETTLEMENT-EXPORT.md`](docs/SETTLEMENT-EXPORT.md) covers the mapping and where it stops being
mechanical. A single endpoint that emits the export directly is planned.

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

There is also nothing to grind: the program **derives** the seed itself — it is not a value the operator hands in. Since spec v21 the seed is not a function of the entrant list alone either. Sealing the list fixes a target slot two slots ahead; the seed is `SHA256(base_seed ‖ slot ‖ slot_hash)` of the first slot at or after that target, read by the program from the `SlotHashes` sysvar. When the list is sealed that slot has not been produced yet, so neither adding a last ticket nor choosing which tickets enter can be tuned to a result. Revealing the slot is permissionless — anyone can call `reveal_draw_entropy`.

### "Change the winner selection algorithm secretly"

**No.** The algorithm is [`server/lib/draw-settlement.ts`](server/lib/draw-settlement.ts), published here. `settlement_spec_version` (`21`) is compiled into the program and stored in every `DrawSeed` and `DrawCommit`. Changing the rules means a new spec version and a program upgrade — an on-chain event, and `verify-program-binary` starts failing against this repo until the mirror is updated.

### "Decide after the fact which draw the Grand Prize lands on"

**Partly — and this is the one place the seed does not answer for us.** In the airdrop stage the
Grand Prize is not rolled for daily; it accumulates all stage long and pays out in a single closing
draw whose date we pick and announce in advance (see [Jackpot](#jackpot-grand-prize)). *When* it fires is
therefore not derivable from the committed seed — only the announcement constrains it, which is why
it is published before the draw is reached rather than revealed with the result.

*Who* wins is untouched: the winners of that draw are still drawn from the committed seed against
the published entrant list, and `verify-entrants` / `verify-settlement` check them exactly as they
check any other draw.

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
- **The Grand Prize date is announced, not derived.** In this stage the pot pays out in one closing draw that we schedule; nothing on-chain says when. The announcement is the only constraint on it. The payout amount is likewise not on-chain — it appears in the settlement's prize rows, which the committed hash does cover.
- **Claim rolls use `purchase_slot = 0`.** A claimed ticket has no payment transaction, so its roll is bound to the prize id instead. The prize id is assigned at settlement, before any roll — but it is a weaker binding than a purchase roll.
- **Devnet.** The airdrop stage runs on Solana devnet, where SOL has no value — treat it as a system under test.
- **A missed reveal can be re-armed.** `SlotHashes` keeps about 512 slots (~3.4 minutes). If nobody reveals in that window the hash is gone, and only then may the authority call `rearm_draw_entropy` for a new target slot. Once a target slot has passed its hash is public, so re-arming is, in effect, a second draw — which is why it is only allowed after the window has expired, and why it increments `DrawEntropy.rearm_count` permanently. `verify-seed` prints the count; in normal operation it is 0.
- **The slot hash comes from validators.** The leader of the target slot could skip its block, which moves the seed to the next slot's hash. That is one leader withholding one block at a known time, with no way to choose the replacement hash.
- **One draw namespace per cluster.** `DrawSeed` and `DrawCommit` are addressed by draw id alone, so a cluster holds exactly one deployment's draw commitments.
- **One authority key.** Seed and result commitments are written by a single key. The commitments
  are public and checkable; the writing is not decentralised. The program now refuses any other
  signer, and the key can be rotated only by the upgrade authority — which narrows a leaked key
  to "can write commitments until rotated", not "can take the registry".

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

Introduced in **spec v20**. In the airdrop stage the Mega Prize **only accumulates**.

- 5% of every draw's pool is set aside rather than paid out that day
- Nothing is drawn from it in this stage, and nobody holds an entry in it: an entry is a ticket
  bought with money, and this stage has no payments
- It is a running total, not an on-chain account: the sum of `mega_prize_amount` over this stage's
  completed settlements, auditable per draw from the same rows every other share is checked against
  (`getAirdropMegaPrizePot` in [`server/lib/mega-prize.ts`](server/lib/mega-prize.ts))

So there is exactly one thing to verify here, and it needs no chain read: every settled draw's 5%
carve is a column on its own row, and they sum to the pot the site shows.

**Who plays for it, when it is drawn, and how the winner is picked are paid-stage rules**, and they
are deliberately not documented here — the code that runs them
(`server/lib/mega-prize-draw.ts`) is not in this repository, because this deployment never calls it
(the call site is behind `if (IS_PAID_STAGE)`). They belong to the paid version's own audit mirror,
alongside the draws they will actually settle.

> **Nothing to verify on-chain yet.** No Mega Prize draw has taken place, in either stage.

---

## Jackpot (Grand Prize)

**In the airdrop stage the Grand Prize is not rolled for daily.** It accumulates across the whole
stage and pays out **once**, in a single closing draw whose date is announced in advance, split
three ways among the top 3.

- 10% of every draw's pool accumulates, and keeps accumulating until that closing draw
- The daily 1-in-30 roll that the paid version uses **decides nothing here** — see below
- Who wins is still drawn from the committed settlement seed against the published entrant list,
  exactly like any other draw

The branch is in [`server/lib/draw-settlement.ts`](server/lib/draw-settlement.ts):

```ts
const jackpotHit = IS_AIRDROP_STAGE
  ? jackpotForced || scheduledJackpotHit          // this deployment
  : jackpotForced || naturalJackpotHit || scheduledJackpotHit;
```

### Reproducing a draw: the discarded rolls are still consumed

This matters to anyone recomputing a draw from its seed, and getting it wrong desynchronises
everything downstream.

`prng.nextBelow(30)` (PRNG counter 0) and, on a hit, `prng.nextBelow(3)` (counter 1) are **still
drawn from the seed in this stage even though their results are ignored**. Skipping either would
shift every later random value — winner selection, free-ticket sampling — so the number stream is
byte-identical between the two stages and only the one boolean differs. Consume them the same way.

### Guaranteed floor

An announcement may carry a published minimum. When the accumulated pot falls below it:

```text
jackpot_payout_total = max(jackpot_balance_before, guarantee_gift)
jackpot_topup_gift   = max(0, guarantee_gift - jackpot_balance_before)
```

The top-up is **company money, not pool money**: the pool's own arithmetic is untouched and it still
rolls forward exactly this draw's 10% slice. Both figures are snapshotted onto the settlement row
(`jackpot_guarantee_gift`, `jackpot_topup_gift`) so a draw stays checkable even if a later
announcement changes, and the floor may be raised but never lowered.

This does not change the spec version or the hash: prize amounts enter `settlement_hash` as values,
never as formulas, so a topped-up payout verifies exactly like any other.

---

## On-chain accounts

| Account | PDA seeds | Content |
|---|---|---|
| `DrawSeed` | `["draw_seed", draw_id]` | entrant list hash, settlement seed, spec version |
| `DrawEntropy` | `["draw_entropy", draw_id]` | target slot, slot used, slot hash, final seed, `rearm_count` (spec v21) |
| `DrawCommit` | `["draw_commit", draw_id]` | settlement_hash, winner_count, spec version |

View on Solscan: `https://solscan.io/account/<PDA>?cluster=devnet` — the scripts print the address and link for you.

PDA derivation: [`src/lib/on-chain-gift-draw/pda.ts`](src/lib/on-chain-gift-draw/pda.ts)

---

## Instructions

| Instruction | Purpose |
|---|---|
| `roll_kind` | Assign one ticket's kind, emitting `KindRolledV2` |
| `roll_kind_batch` | Same for several tickets in one transaction, grouped by purchase |
| `draw_randomness` | Seal the entrant list hash + base seed (after `period_end_unix`), arm `DrawEntropy` with a target slot |
| `reveal_draw_entropy` | Mix the target slot's hash into the seed — callable by anyone |
| `rearm_draw_entropy` | Authority only, and only once the reveal window has expired: new target slot, `rearm_count` + 1 |
| `commit_draw_result` | Commit the settlement hash and winner count |
| `initialize` | One-time config account setup |
| `set_authority` | Rotates the write key — callable only by the program's upgrade authority |

Every writing instruction takes the `config` account and requires the signer to equal
`config.authority`. Without that check any signer could emit roll events, and — the worse
case — `init` the `draw_seed` or `draw_commit` account of a future draw first, squatting the
draw id forever. `set_authority` is deliberately **not** callable by the current authority: a
leaked operator key cannot rotate itself to an attacker, while the upgrade authority can rotate
it away. Both were added in the September 2026 upgrade; the deploy is a public transaction and
`verify-program-binary` pins this repository to the bytecode that contains them.

`roll_kind_batch` exists only to fit more tickets in a transaction. It emits `KindRolledV2` events byte-identical to the single-ticket path — same `roll_from_inputs`, same spec version, same tag — so every decoder and check in this repo treats both the same way. A unit test in the program (`batch_roll_matches_single`) pins that equivalence. Batching does not touch fairness: a roll is bound to `purchase_slot`, never to the slot it was sent in.

---

## Repository contents

```
programs/gift_draw_registry/src/lib.rs    On-chain program (roll logic, seed & result commitment)
idl/gift_draw_registry.json               Anchor IDL (instruction + account layouts)
release/gift_draw_registry.so             Compiled binary — verify-program-binary proves it is deployed

server/lib/                               Production settlement code, mirrored verbatim
  draw-settlement.ts                        Winner selection (Efraimidis–Spirakis, spec v21)
  draw-settlement-seed.ts                   Seed + entrant list hash
  draw-entrant-rules.ts                     Who counts as an entrant (pure, no I/O)
  draw-entrants-public.ts                   The public entrant snapshot endpoint
  draw-ticket-verification.ts               On-chain roll checks applied at entry and settlement
  settlement-prize-commit.ts                Settlement hash formula (v17 / v18 / v19+)
  settlement-commit-hash.ts                 Re-exports of the above
  draw-ticket-weights.ts                    Ticket weights + weighted shuffle
  poker-payout-schedule.ts                  Prize distribution schedule
  mega-prize.ts                             Mega Prize reserve (5% of each pool)
  mega-prize-schedule.ts                    Period boundaries the reserve is read against
  announced-draws.ts                        Announced payouts and guaranteed floors
  stage.ts                                  The free/paid split this code branches on
  kind-roll-verify.ts                       Roll event verification
  gift-draw-registry-client.ts              Program client used by the server

scripts/
  verify-program-binary.ts                Deployed bytecode vs release/*.so
  verify-entrants.ts                      Published entrant list vs on-chain DrawSeed
  verify-seed.ts                          Seed recomputed from the sealing tx + DrawEntropy vs DrawCommit
  verify-settlement.ts                    Recomputed settlement hash vs on-chain DrawCommit
  decode-kind-rolled.ts                   Decode + recompute a ticket roll
  lib/chain.ts                            Standalone Solana reader (mirror-only plumbing)

examples/
  settlement-20260906.json                Worked export, verifies against the chain as published

src/lib/on-chain-gift-draw/               Client-side verification helpers
docs/
  SETTLEMENT-SPEC.md                      Hash formula and spec history
  SETTLEMENT-EXPORT.md                    Export format for verify-settlement
  VERIFY-ON-SOLSCAN.md                    Reading the accounts by hand
  AUDIT-RESPONSE.md                       Review findings and responses
```

`server/lib/*` is copied from production **byte for byte** — not rewritten, not simplified, not
stripped of the branch that does not apply to this stage. It is published for reading and is not
what the scripts run on: it imports server modules that are not here, so it does not compile in this
repository and is not in its `tsconfig.json`. The scripts depend only on the pure rule and hash
modules, plus `scripts/lib/chain.ts`, which reads bytes and computes nothing.

One production file is deliberately absent: `mega-prize-draw.ts`, the Mega Prize draw itself. This
deployment never calls it — the call site is behind `if (IS_PAID_STAGE)` — so it will be published
in the paid version's mirror, where it can be checked against draws it actually settled.

The mirror is updated when the program is redeployed or the settlement rules change. An unchanged
mirror with a passing `verify-program-binary` means the rules have not moved.

---

## Security

To report a vulnerability, open a [GitHub Security Advisory](../../security/advisories/new) or contact us via [giftdraw.today](https://giftdraw.today).
