#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

declare_id!("FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed");

pub const SETTLEMENT_SPEC_VERSION: u16 = 21;
/// v21: the settlement seed mixes in the hash of a slot that does not exist yet when the entrant
/// list is sealed — `draw_randomness` fixes `target_slot = slot + ENTROPY_DELAY_SLOTS`, and
/// `reveal_draw_entropy` reads that slot's hash from the SlotHashes sysvar once it has passed.
pub const ENTROPY_DELAY_SLOTS: u64 = 2;
pub const PROB_SCALE: u32 = 100_000;
pub const PROB_LEGENDARY: u32 = 10;
pub const PROB_EVENT: u32 = 100;
pub const MAX_DRAW_ID_LEN: usize = 32;
/// Upper bound on tickets attested in a single `roll_kind_batch` (real cap is tx size,
/// enforced client-side). Guards against an oversized Vec exhausting compute.
pub const MAX_ROLL_BATCH: usize = 60;
/// ASCII "GDT0" — GiftDraw Today roll events.
pub const PROJECT_TAG: u32 = 0x4754_4430;
pub const ORIGIN_PURCHASE: u8 = 0;
pub const ORIGIN_CLAIM: u8 = 1;

#[program]
pub mod gift_draw_registry {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.treasury = treasury;
        cfg.settlement_spec_version = SETTLEMENT_SPEC_VERSION;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn roll_kind(
        ctx: Context<RollKind>,
        purchase_tx_sig: [u8; 64],
        ticket_index: u16,
        ticket_id: u64,
        ticket_serial: u64,
        origin: u8,
        gift_amount_micro: u64,
        purchase_slot: u64,
    ) -> Result<()> {
        require!(origin == ORIGIN_PURCHASE || origin == ORIGIN_CLAIM, RegistryError::InvalidOrigin);
        require!(ticket_id > 0, RegistryError::InvalidTicketId);

        let roll = roll_from_inputs(&purchase_tx_sig, ticket_index, purchase_slot);
        let kind = kind_from_roll(roll);

        emit!(KindRolledV2 {
            ticket_id,
            ticket_serial,
            purchase_tx_sig,
            buyer: ctx.accounts.buyer.key(),
            ticket_index,
            origin,
            gift_amount_micro,
            roll,
            kind,
            slot: purchase_slot,
            registry_version: SETTLEMENT_SPEC_VERSION,
            project_tag: PROJECT_TAG,
        });
        Ok(())
    }

    /// Batched form of `roll_kind`: emits one `KindRolledV2` per ticket, grouped by purchase so the
    /// 64-byte signature + slot + buyer are shared across a purchase's tickets. Each event is
    /// byte-identical to the single-instruction path (same `roll_from_inputs`, `registry_version`,
    /// `project_tag`), so existing decoders/verifiers are unchanged. Deferring/batching the send is
    /// fairness-neutral: the roll is bound to `purchase_slot`, never the send slot.
    pub fn roll_kind_batch(ctx: Context<RollKindBatch>, groups: Vec<RollKindGroup>) -> Result<()> {
        require!(!groups.is_empty(), RegistryError::EmptyBatch);
        let total: usize = groups.iter().map(|g| g.tickets.len()).sum();
        require!(total > 0, RegistryError::EmptyBatch);
        require!(total <= MAX_ROLL_BATCH, RegistryError::BatchTooLarge);

        let buyer = ctx.accounts.authority.key();
        let _ = buyer; // authority signs; buyer pubkey travels in each group's data

        for group in groups.iter() {
            require!(
                group.origin == ORIGIN_PURCHASE || group.origin == ORIGIN_CLAIM,
                RegistryError::InvalidOrigin
            );
            require!(!group.tickets.is_empty(), RegistryError::EmptyBatch);
            for ticket in group.tickets.iter() {
                require!(ticket.ticket_id > 0, RegistryError::InvalidTicketId);
                let roll =
                    roll_from_inputs(&group.purchase_tx_sig, ticket.ticket_index, group.purchase_slot);
                let kind = kind_from_roll(roll);
                emit!(KindRolledV2 {
                    ticket_id: ticket.ticket_id,
                    ticket_serial: ticket.ticket_serial,
                    purchase_tx_sig: group.purchase_tx_sig,
                    buyer: group.buyer,
                    ticket_index: ticket.ticket_index,
                    origin: group.origin,
                    gift_amount_micro: ticket.gift_amount_micro,
                    roll,
                    kind,
                    slot: group.purchase_slot,
                    registry_version: SETTLEMENT_SPEC_VERSION,
                    project_tag: PROJECT_TAG,
                });
            }
        }
        Ok(())
    }

    pub fn draw_randomness(
        ctx: Context<DrawRandomness>,
        draw_id: String,
        period_end_iso: String,
        merkle_root_hex: String,
        period_end_unix: i64,
    ) -> Result<()> {
        require!(draw_id.len() > 0 && draw_id.len() <= MAX_DRAW_ID_LEN, RegistryError::DrawIdTooLong);
        // Prevent operator from committing the seed before the draw period actually ends.
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= period_end_unix, RegistryError::DrawPeriodNotEnded);
        let merkle_root = decode_merkle_root_hex(&merkle_root_hex)?;
        let seed = settlement_seed_bytes(&draw_id, &period_end_iso, &merkle_root_hex);
        let ds = &mut ctx.accounts.draw_seed;
        let (draw_id_buf, draw_id_len) = encode_draw_id(&draw_id)?;
        ds.draw_id = draw_id_buf;
        ds.draw_id_len = draw_id_len;
        ds.seed = seed;
        ds.merkle_root = merkle_root;
        ds.spec_version = SETTLEMENT_SPEC_VERSION;
        ds.bump = ctx.bumps.draw_seed;
        // `seed` above is the base seed (entrant list only). The settlement seed is fixed later by
        // `reveal_draw_entropy`, from a slot that is still in the future at this point.
        let de = &mut ctx.accounts.draw_entropy;
        de.draw_id = draw_id_buf;
        de.draw_id_len = draw_id_len;
        de.target_slot = clock.slot.saturating_add(ENTROPY_DELAY_SLOTS);
        de.slot = 0;
        de.slot_hash = [0u8; 32];
        de.seed = [0u8; 32];
        de.revealed = false;
        de.rearm_count = 0;
        de.bump = ctx.bumps.draw_entropy;
        let target_slot = de.target_slot;
        emit!(DrawSeedCommitted {
            draw_id: draw_id.clone(),
            seed,
            merkle_root,
            spec_version: SETTLEMENT_SPEC_VERSION,
        });
        emit!(DrawEntropyArmed { draw_id, target_slot });
        Ok(())
    }

    /// Fixes the settlement seed: base seed ‖ hash of the first slot at or after `target_slot`.
    /// No authority check on purpose — anyone may reveal, so the operator cannot sit on a draw
    /// waiting for the window to lapse. The result does not depend on who calls it or when.
    pub fn reveal_draw_entropy(ctx: Context<RevealDrawEntropy>, draw_id: String) -> Result<()> {
        require!(draw_id.len() > 0 && draw_id.len() <= MAX_DRAW_ID_LEN, RegistryError::DrawIdTooLong);
        let base_seed = ctx.accounts.draw_seed.seed;
        let de = &mut ctx.accounts.draw_entropy;
        require!(draw_id_matches_account(&draw_id, &de.draw_id, de.draw_id_len), RegistryError::DrawIdMismatch);
        require!(!de.revealed, RegistryError::EntropyAlreadyRevealed);
        let (slot, slot_hash) = {
            let data = ctx.accounts.slot_hashes.try_borrow_data()?;
            find_slot_hash(&data, de.target_slot)?
        };
        let seed = entropy_seed_bytes(&base_seed, slot, &slot_hash);
        de.slot = slot;
        de.slot_hash = slot_hash;
        de.seed = seed;
        de.revealed = true;
        emit!(DrawEntropyRevealed {
            draw_id,
            target_slot: de.target_slot,
            slot,
            slot_hash,
            seed,
            rearm_count: de.rearm_count,
        });
        Ok(())
    }

    /// Only when nobody revealed in time (the target slot has aged out of SlotHashes, ~512 slots):
    /// points the draw at a new future slot. Every rearm is counted on the account and emitted, so
    /// a draw that was re-armed stays visibly so — the one lever an operator has, made public.
    pub fn rearm_draw_entropy(ctx: Context<RearmDrawEntropy>, draw_id: String) -> Result<()> {
        require!(draw_id.len() > 0 && draw_id.len() <= MAX_DRAW_ID_LEN, RegistryError::DrawIdTooLong);
        let de = &mut ctx.accounts.draw_entropy;
        require!(draw_id_matches_account(&draw_id, &de.draw_id, de.draw_id_len), RegistryError::DrawIdMismatch);
        require!(!de.revealed, RegistryError::EntropyAlreadyRevealed);
        let expired = {
            let data = ctx.accounts.slot_hashes.try_borrow_data()?;
            slot_window_expired(&data, de.target_slot)?
        };
        require!(expired, RegistryError::EntropyNotExpired);
        let clock = Clock::get()?;
        de.target_slot = clock.slot.saturating_add(ENTROPY_DELAY_SLOTS);
        de.rearm_count = de.rearm_count.saturating_add(1);
        emit!(DrawEntropyRearmed {
            draw_id,
            target_slot: de.target_slot,
            rearm_count: de.rearm_count,
        });
        Ok(())
    }

    pub fn commit_draw_result(
        ctx: Context<CommitDrawResult>,
        draw_id: String,
        settlement_hash: [u8; 32],
        winner_count: u32,
    ) -> Result<()> {
        require!(draw_id.len() > 0 && draw_id.len() <= MAX_DRAW_ID_LEN, RegistryError::DrawIdTooLong);
        let ds = &ctx.accounts.draw_seed;
        require!(draw_id_matches_account(&draw_id, &ds.draw_id, ds.draw_id_len), RegistryError::DrawIdMismatch);
        require!(
            ds.spec_version == SETTLEMENT_SPEC_VERSION,
            RegistryError::SpecVersionMismatch
        );
        let de = &ctx.accounts.draw_entropy;
        require!(draw_id_matches_account(&draw_id, &de.draw_id, de.draw_id_len), RegistryError::DrawIdMismatch);
        require!(de.revealed, RegistryError::EntropyNotRevealed);
        let seed = de.seed;
        let dc = &mut ctx.accounts.draw_commit;
        let (draw_id_buf, draw_id_len) = encode_draw_id(&draw_id)?;
        dc.draw_id = draw_id_buf;
        dc.draw_id_len = draw_id_len;
        dc.seed = seed;
        dc.merkle_root = ds.merkle_root;
        dc.settlement_hash = settlement_hash;
        dc.spec_version = SETTLEMENT_SPEC_VERSION;
        dc.winner_count = winner_count;
        dc.bump = ctx.bumps.draw_commit;
        emit!(DrawResultCommitted {
            draw_id,
            seed,
            merkle_root: ds.merkle_root,
            settlement_hash,
            spec_version: SETTLEMENT_SPEC_VERSION,
            winner_count,
        });
        Ok(())
    }

    /// Hands the registry's write key to `new_authority`. Only the program's upgrade authority may
    /// call it — never the current `config.authority` — so a leaked operator key cannot lock the
    /// project out by rotating itself to an attacker; the upgrade authority rotates it away instead.
    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.upgrade_authority.key())?;
        let cfg = &mut ctx.accounts.config;
        let old_authority = cfg.authority;
        cfg.authority = new_authority;
        emit!(RegistryAuthorityChanged {
            old_authority,
            new_authority,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

// Every write instruction below takes `config` LAST and requires `authority == config.authority`.
// Before this check existed, any signer could emit roll events and — worse — `init` the
// `draw_seed` / `draw_commit` PDA of a future draw first, squatting it forever. Keeping `config`
// last means a client that passes it still works against a program that predates the check (Anchor
// ignores trailing accounts), so the client can ship before the program.

#[derive(Accounts)]
pub struct RollKind<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: buyer wallet referenced in KindRolledV2 event (not required to sign).
    pub buyer: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
}

/// One ticket inside a `RollKindGroup` (purchase-scoped fields live on the group).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RollKindTicket {
    pub ticket_index: u16,
    pub ticket_id: u64,
    pub ticket_serial: u64,
    pub gift_amount_micro: u64,
}

/// Tickets sharing one purchase: signature, buyer, origin and slot are shared to save tx bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RollKindGroup {
    pub purchase_tx_sig: [u8; 64],
    pub buyer: Pubkey,
    pub origin: u8,
    pub purchase_slot: u64,
    pub tickets: Vec<RollKindTicket>,
}

#[derive(Accounts)]
pub struct RollKindBatch<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(draw_id: String)]
pub struct DrawRandomness<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + DrawSeed::INIT_SPACE,
        seeds = [b"draw_seed", draw_id.as_bytes()],
        bump
    )]
    pub draw_seed: Account<'info, DrawSeed>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + DrawEntropy::INIT_SPACE,
        seeds = [b"draw_entropy", draw_id.as_bytes()],
        bump
    )]
    pub draw_entropy: Account<'info, DrawEntropy>,
}

#[derive(Accounts)]
#[instruction(draw_id: String)]
pub struct RevealDrawEntropy<'info> {
    #[account(seeds = [b"draw_seed", draw_id.as_bytes()], bump = draw_seed.bump)]
    pub draw_seed: Account<'info, DrawSeed>,
    #[account(mut, seeds = [b"draw_entropy", draw_id.as_bytes()], bump = draw_entropy.bump)]
    pub draw_entropy: Account<'info, DrawEntropy>,
    /// CHECK: the SlotHashes sysvar (address-checked), read as raw bytes — too large for Sysvar::get.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(draw_id: String)]
pub struct RearmDrawEntropy<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"draw_entropy", draw_id.as_bytes()], bump = draw_entropy.bump)]
    pub draw_entropy: Account<'info, DrawEntropy>,
    /// CHECK: the SlotHashes sysvar (address-checked), read as raw bytes.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(draw_id: String)]
pub struct CommitDrawResult<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"draw_seed", draw_id.as_bytes()],
        bump = draw_seed.bump
    )]
    pub draw_seed: Account<'info, DrawSeed>,
    #[account(
        init,
        payer = authority,
        space = 8 + DrawCommit::INIT_SPACE,
        seeds = [b"draw_commit", draw_id.as_bytes()],
        bump
    )]
    pub draw_commit: Account<'info, DrawCommit>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"draw_entropy", draw_id.as_bytes()], bump = draw_entropy.bump)]
    pub draw_entropy: Account<'info, DrawEntropy>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub upgrade_authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: this program's ProgramData account — address, owner and contents are verified in
    /// `require_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
}

/// The signer must be this program's upgrade authority.
///
/// Read straight from the ProgramData bytes rather than through Anchor's `ProgramData` account type:
/// that type deserializes with bincode, which grew the binary by ~76 KB — past the deployed program
/// account's capacity. Layout (`UpgradeableLoaderState::ProgramData`, bincode):
/// tag u32 = 3 | slot u64 | Option<Pubkey> = tag u8 + 32 bytes.
fn require_upgrade_authority(program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
    let (expected, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &loader);
    require_keys_eq!(program_data.key(), expected, RegistryError::Unauthorized);
    require_keys_eq!(*program_data.owner, loader, RegistryError::Unauthorized);
    let data = program_data.try_borrow_data()?;
    require!(data.len() >= 45, RegistryError::Unauthorized);
    require!(data[0..4] == [3, 0, 0, 0], RegistryError::Unauthorized);
    require!(data[12] == 1, RegistryError::Unauthorized);
    require!(data[13..45] == signer.to_bytes()[..], RegistryError::Unauthorized);
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub settlement_spec_version: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DrawSeed {
    pub draw_id_len: u8,
    pub draw_id: [u8; 32],
    pub seed: [u8; 32],
    pub merkle_root: [u8; 32],
    pub spec_version: u16,
    pub bump: u8,
}

/// v21 entropy for one draw. Kept apart from `DrawSeed` / `DrawCommit`, whose layouts the vault
/// program reads by offset.
#[account]
#[derive(InitSpace)]
pub struct DrawEntropy {
    pub draw_id_len: u8,
    pub draw_id: [u8; 32],
    /// First slot whose hash may be used; fixed when the entrant list is sealed.
    pub target_slot: u64,
    /// The slot actually used: the first non-skipped slot at or after `target_slot`.
    pub slot: u64,
    pub slot_hash: [u8; 32],
    /// Settlement seed = SHA256(DrawSeed.seed ‖ slot LE u64 ‖ slot_hash).
    pub seed: [u8; 32],
    pub revealed: bool,
    pub rearm_count: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DrawCommit {
    pub draw_id_len: u8,
    pub draw_id: [u8; 32],
    pub seed: [u8; 32],
    pub merkle_root: [u8; 32],
    pub settlement_hash: [u8; 32],
    pub spec_version: u16,
    pub winner_count: u32,
    pub bump: u8,
}

#[event]
pub struct KindRolledV2 {
    pub ticket_id: u64,
    pub ticket_serial: u64,
    pub purchase_tx_sig: [u8; 64],
    pub buyer: Pubkey,
    pub ticket_index: u16,
    pub origin: u8,
    pub gift_amount_micro: u64,
    pub roll: u32,
    /// 0 common, 1 event, 2 legendary
    pub kind: u8,
    /// Purchase tx slot used in roll hash (claim origin uses 0).
    pub slot: u64,
    pub registry_version: u16,
    pub project_tag: u32,
}

#[event]
pub struct DrawSeedCommitted {
    pub draw_id: String,
    pub seed: [u8; 32],
    pub merkle_root: [u8; 32],
    pub spec_version: u16,
}

#[event]
pub struct DrawResultCommitted {
    pub draw_id: String,
    pub seed: [u8; 32],
    pub merkle_root: [u8; 32],
    pub settlement_hash: [u8; 32],
    pub spec_version: u16,
    pub winner_count: u32,
}

#[event]
pub struct DrawEntropyArmed {
    pub draw_id: String,
    pub target_slot: u64,
}

#[event]
pub struct DrawEntropyRevealed {
    pub draw_id: String,
    pub target_slot: u64,
    pub slot: u64,
    pub slot_hash: [u8; 32],
    pub seed: [u8; 32],
    pub rearm_count: u8,
}

#[event]
pub struct DrawEntropyRearmed {
    pub draw_id: String,
    pub target_slot: u64,
    pub rearm_count: u8,
}

#[event]
pub struct RegistryAuthorityChanged {
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[error_code]
pub enum RegistryError {
    #[msg("draw_id exceeds max length")]
    DrawIdTooLong,
    #[msg("draw_id does not match draw_seed account")]
    DrawIdMismatch,
    #[msg("settlement spec version mismatch")]
    SpecVersionMismatch,
    #[msg("invalid merkle_root hex")]
    InvalidMerkleRoot,
    #[msg("invalid roll origin")]
    InvalidOrigin,
    #[msg("invalid ticket_id")]
    InvalidTicketId,
    #[msg("draw period has not ended yet")]
    DrawPeriodNotEnded,
    #[msg("roll batch is empty")]
    EmptyBatch,
    #[msg("roll batch exceeds MAX_ROLL_BATCH")]
    BatchTooLarge,
    // Appended last so existing error codes keep their numbers.
    #[msg("signer is not the registry authority")]
    Unauthorized,
    #[msg("target slot has not passed yet")]
    EntropyNotReady,
    #[msg("target slot aged out of SlotHashes; rearm the draw")]
    EntropyExpired,
    #[msg("target slot is still revealable; rearm refused")]
    EntropyNotExpired,
    #[msg("draw entropy already revealed")]
    EntropyAlreadyRevealed,
    #[msg("draw entropy not revealed yet")]
    EntropyNotRevealed,
    #[msg("malformed SlotHashes sysvar data")]
    InvalidSlotHashes,
}

pub fn roll_from_inputs(purchase_tx_sig: &[u8; 64], ticket_index: u16, slot: u64) -> u32 {
    let idx_bytes = ticket_index.to_le_bytes();
    let slot_bytes = slot.to_le_bytes();
    let digest = hashv(&[purchase_tx_sig, &idx_bytes, &slot_bytes]);
    let bytes = digest.to_bytes();
    let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    n % PROB_SCALE
}

pub fn kind_from_roll(roll: u32) -> u8 {
    if roll < PROB_LEGENDARY {
        2
    } else if roll < PROB_LEGENDARY + PROB_EVENT {
        1
    } else {
        0
    }
}

/// Mirrors `settlementSeedHex` in server/lib/draw-settlement-seed.ts (merkle as hex utf8).
pub fn settlement_seed_bytes(draw_id: &str, period_end_iso: &str, merkle_root_hex: &str) -> [u8; 32] {
    let digest = hashv(&[
        draw_id.as_bytes(),
        b"|",
        period_end_iso.as_bytes(),
        b"|",
        merkle_root_hex.as_bytes(),
    ]);
    digest.to_bytes()
}

/// v21 settlement seed. Mirrors `entropySeedHex` in server/lib/draw-settlement-seed.ts.
pub fn entropy_seed_bytes(base_seed: &[u8; 32], slot: u64, slot_hash: &[u8; 32]) -> [u8; 32] {
    hashv(&[base_seed, &slot.to_le_bytes(), slot_hash]).to_bytes()
}

/// SlotHashes sysvar data (bincode `Vec<(Slot, Hash)>`): count u64 LE, then `count` entries of
/// slot u64 LE + hash [u8; 32], newest first. Entries are the bank's ancestors, so between the
/// oldest and newest entry every non-skipped slot is present.
const SLOT_HASH_ENTRY: usize = 40;

fn slot_hash_entries(data: &[u8]) -> Result<usize> {
    require!(data.len() >= 8, RegistryError::InvalidSlotHashes);
    let mut len = [0u8; 8];
    len.copy_from_slice(&data[0..8]);
    let n = u64::from_le_bytes(len) as usize;
    require!(n > 0 && data.len() >= 8 + n * SLOT_HASH_ENTRY, RegistryError::InvalidSlotHashes);
    Ok(n)
}

fn slot_hash_entry(data: &[u8], i: usize) -> (u64, [u8; 32]) {
    let at = 8 + i * SLOT_HASH_ENTRY;
    let mut slot = [0u8; 8];
    slot.copy_from_slice(&data[at..at + 8]);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[at + 8..at + SLOT_HASH_ENTRY]);
    (u64::from_le_bytes(slot), hash)
}

/// The first slot at or after `target_slot` and its hash. Fails with `EntropyExpired` once the
/// oldest entry is past `target_slot` (a slot in between may have aged out, so "first" is no longer
/// provable), and with `EntropyNotReady` while no such slot has completed.
pub fn find_slot_hash(data: &[u8], target_slot: u64) -> Result<(u64, [u8; 32])> {
    let n = slot_hash_entries(data)?;
    require!(slot_hash_entry(data, n - 1).0 <= target_slot, RegistryError::EntropyExpired);
    let mut found: Option<(u64, [u8; 32])> = None;
    for i in 0..n {
        let entry = slot_hash_entry(data, i);
        if entry.0 < target_slot {
            break;
        }
        found = Some(entry);
    }
    found.ok_or_else(|| error!(RegistryError::EntropyNotReady))
}

pub fn slot_window_expired(data: &[u8], target_slot: u64) -> Result<bool> {
    let n = slot_hash_entries(data)?;
    Ok(slot_hash_entry(data, n - 1).0 > target_slot)
}

fn hex_nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

pub fn decode_merkle_root_hex(hex: &str) -> Result<[u8; 32]> {
    let bytes = hex.trim().as_bytes();
    require!(bytes.len() == 64, RegistryError::InvalidMerkleRoot);
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = hex_nibble(bytes[i * 2]).ok_or_else(|| error!(RegistryError::InvalidMerkleRoot))?;
        let lo = hex_nibble(bytes[i * 2 + 1]).ok_or_else(|| error!(RegistryError::InvalidMerkleRoot))?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn encode_draw_id(draw_id: &str) -> Result<([u8; 32], u8)> {
    require!(draw_id.len() <= MAX_DRAW_ID_LEN, RegistryError::DrawIdTooLong);
    let mut dest = [0u8; 32];
    dest[..draw_id.len()].copy_from_slice(draw_id.as_bytes());
    Ok((dest, draw_id.len() as u8))
}

fn draw_id_matches_account(draw_id: &str, stored: &[u8; 32], stored_len: u8) -> bool {
    let n = stored_len as usize;
    if n != draw_id.len() {
        return false;
    }
    &stored[..n] == draw_id.as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_thresholds_match_ts() {
        assert_eq!(kind_from_roll(0), 2);
        assert_eq!(kind_from_roll(9), 2);
        assert_eq!(kind_from_roll(10), 1);
        assert_eq!(kind_from_roll(109), 1);
        assert_eq!(kind_from_roll(110), 0);
        assert_eq!(kind_from_roll(99_999), 0);
    }

    #[test]
    fn decode_merkle_rejects_non_hex() {
        let bad = "gg".repeat(32);
        assert!(decode_merkle_root_hex(&bad).is_err());
    }

    #[test]
    fn roll_is_deterministic() {
        let sig = [7u8; 64];
        let a = roll_from_inputs(&sig, 0, 12345);
        let b = roll_from_inputs(&sig, 0, 12345);
        assert_eq!(a, b);
        let c = roll_from_inputs(&sig, 1, 12345);
        assert_ne!(a, c);
    }

    fn slot_hashes(slots_newest_first: &[u64]) -> Vec<u8> {
        let mut data = (slots_newest_first.len() as u64).to_le_bytes().to_vec();
        for &slot in slots_newest_first {
            data.extend_from_slice(&slot.to_le_bytes());
            data.extend_from_slice(&[slot as u8; 32]);
        }
        data
    }

    #[test]
    fn slot_hash_lookup() {
        let data = slot_hashes(&[110, 108, 105, 100]);
        assert_eq!(find_slot_hash(&data, 106).unwrap(), (108, [108u8; 32]));
        assert_eq!(find_slot_hash(&data, 105).unwrap(), (105, [105u8; 32]));
        assert_eq!(find_slot_hash(&data, 101).unwrap(), (105, [105u8; 32]));
        assert_eq!(find_slot_hash(&data, 100).unwrap(), (100, [100u8; 32]));
        assert_eq!(find_slot_hash(&data, 110).unwrap(), (110, [110u8; 32]));
        assert!(find_slot_hash(&data, 111).is_err());
        assert!(find_slot_hash(&data, 99).is_err());
        assert!(!slot_window_expired(&data, 100).unwrap());
        assert!(slot_window_expired(&data, 99).unwrap());
        assert!(find_slot_hash(&[], 1).is_err());
        assert!(find_slot_hash(&slot_hashes(&[])[..], 1).is_err());
    }

    #[test]
    fn entropy_seed_binds_every_input() {
        let base = [1u8; 32];
        let a = entropy_seed_bytes(&base, 5, &[2u8; 32]);
        assert_eq!(a, entropy_seed_bytes(&base, 5, &[2u8; 32]));
        assert_ne!(a, entropy_seed_bytes(&base, 6, &[2u8; 32]));
        assert_ne!(a, entropy_seed_bytes(&base, 5, &[3u8; 32]));
        assert_ne!(a, entropy_seed_bytes(&[9u8; 32], 5, &[2u8; 32]));
    }

    #[test]
    fn batch_roll_matches_single() {
        // A batched group must produce the exact same roll/kind per ticket as the single path,
        // since both call roll_from_inputs(purchase_tx_sig, ticket_index, purchase_slot).
        let sig = [42u8; 64];
        let slot = 9_876_543u64;
        for ticket_index in 0u16..5 {
            let single = roll_from_inputs(&sig, ticket_index, slot);
            // Mirror what roll_kind_batch computes for the same shared inputs.
            let batched = roll_from_inputs(&sig, ticket_index, slot);
            assert_eq!(single, batched);
            assert_eq!(kind_from_roll(single), kind_from_roll(batched));
        }
    }
}
