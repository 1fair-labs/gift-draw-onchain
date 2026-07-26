# Reading the commitments by hand

The scripts in this repo are a convenience. Everything they read is public, and you can get to it
through a block explorer without running anything.

Devnet accounts carry `?cluster=devnet` on Solscan; mainnet accounts carry nothing. Which cluster
you want depends on the version — see "Which deployment am I verifying?" in the README.

## The program

<https://solscan.io/account/FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed?cluster=devnet>

The **Upgradeable Loader** section lists the upgrade authority and the last deployed slot. Every
upgrade appears in the account's transaction history — there is no way to replace the program
quietly. `npm run verify-program-binary` compares the bytes behind this account to
`release/gift_draw_registry.so`.

## Finding a draw's accounts

Both are PDAs derived from the draw id:

```
DrawSeed    seeds = ["draw_seed",   <draw_id>]
DrawCommit  seeds = ["draw_commit", <draw_id>]
```

The verification scripts print the addresses:

```bash
npm run verify-entrants -- --drawId 20260720     # prints drawSeedPda + Solscan link
npm run verify-settlement -- --file export.json  # prints drawCommitPda + Solscan link
```

## Reading the account data

Solscan shows the raw account data; the layouts are fixed-width, so you can index into it directly.
All integers are little-endian, and the first 8 bytes are the Anchor discriminator.

**DrawSeed**

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | `draw_id_len` |
| 9 | 32 | `draw_id` (UTF-8, padded) |
| 41 | 32 | `seed` |
| 73 | 32 | `merkle_root` — the entrant list hash |
| 105 | 2 | `spec_version` |
| 107 | 1 | `bump` |

**DrawCommit**

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | discriminator |
| 8 | 1 | `draw_id_len` |
| 9 | 32 | `draw_id` |
| 41 | 32 | `seed` (copied from DrawSeed by the program) |
| 73 | 32 | `merkle_root` (copied from DrawSeed) |
| 105 | 32 | `settlement_hash` |
| 137 | 2 | `spec_version` |
| 139 | 4 | `winner_count` |
| 143 | 1 | `bump` |

## Checking an entrant list by hand

```bash
curl "https://www.giftdraw.today/api/draws?action=entrants&drawId=<DRAW_ID>"
```

Take `sortedTicketIds`, join the numbers with commas, and hash the result. It must equal
`merkle_root` at offset 73 of that draw's `DrawSeed` account — a value written before the draw
closed and unchangeable since.

A worked example, from draw `20260720` on devnet as it stood in July 2026:

```bash
# the API returned "sortedTicketIds": [1, 3, 5]
printf '1,3,5' | sha256sum
# → c45ddb5ff9af0a6a331c53c3b82006c04f624d3712e915ee628e58c05251d8be
```

That hash still sits in the account at
<https://solscan.io/account/4aUqWM2jD32rARedrv8Hm9i8YqkddYFCmwkbAGeXYKT8?cluster=devnet> and always
will — the arithmetic above is reproducible forever. Run the same two steps against a recent
completed draw to watch both halves line up on a draw of your choosing.

## Reading a roll transaction

Open the roll transaction on Solscan and find the `Program data:` line in the program logs — that is
the base64 `KindRolledV2` event. Paste it into:

```bash
npm run decode-kind-rolled -- --data "<PROGRAM_DATA_BASE64>"
```

It decodes the fields and recomputes the roll from the payment signature, ticket index and slot, so
you can confirm the emitted number is the hash of those inputs rather than a value someone picked.
