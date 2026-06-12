use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

declare_id!("FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed");

pub const SETTLEMENT_SPEC_VERSION: u16 = 18;
pub const PROB_SCALE: u32 = 100_000;
pub const PROB_LEGENDARY: u32 = 10;
pub const PROB_EVENT: u32 = 100;
pub const MAX_DRAW_ID_LEN: usize = 32;
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
    ) -> Result<()> {
        require!(origin == ORIGIN_PURCHASE || origin == ORIGIN_CLAIM, RegistryError::InvalidOrigin);
        require!(ticket_id > 0, RegistryError::InvalidTicketId);

        let clock = Clock::get()?;
        let roll = roll_from_inputs(&purchase_tx_sig, ticket_index, clock.slot);
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
            slot: clock.slot,
            registry_version: SETTLEMENT_SPEC_VERSION,
            project_tag: PROJECT_TAG,
        });
        Ok(())
    }

    pub fn draw_randomness(
        ctx: Context<DrawRandomness>,
        draw_id: String,
        period_end_iso: String,
        merkle_root_hex: String,
    ) -> Result<()> {
        require!(draw_id.len() > 0 && draw_id.len() <= MAX_DRAW_ID_LEN, RegistryError::DrawIdTooLong);
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
        emit!(DrawSeedCommitted {
            draw_id,
            seed,
            merkle_root,
            spec_version: SETTLEMENT_SPEC_VERSION,
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
        let dc = &mut ctx.accounts.draw_commit;
        let (draw_id_buf, draw_id_len) = encode_draw_id(&draw_id)?;
        dc.draw_id = draw_id_buf;
        dc.draw_id_len = draw_id_len;
        dc.seed = ds.seed;
        dc.merkle_root = ds.merkle_root;
        dc.settlement_hash = settlement_hash;
        dc.spec_version = SETTLEMENT_SPEC_VERSION;
        dc.winner_count = winner_count;
        dc.bump = ctx.bumps.draw_commit;
        emit!(DrawResultCommitted {
            draw_id,
            seed: ds.seed,
            merkle_root: ds.merkle_root,
            settlement_hash,
            spec_version: SETTLEMENT_SPEC_VERSION,
            winner_count,
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

#[derive(Accounts)]
pub struct RollKind<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: buyer wallet referenced in KindRolledV2 event (not required to sign).
    pub buyer: UncheckedAccount<'info>,
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

/// Mirrors `settlementSeedHex` in server/lib/lottery-settlement-seed.ts (merkle as hex utf8).
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

pub fn decode_merkle_root_hex(hex: &str) -> Result<[u8; 32]> {
    let h = hex.trim();
    require!(h.len() == 64, RegistryError::InvalidMerkleRoot);
    let mut out = [0u8; 32];
    for i in 0..32 {
        let byte = u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).map_err(|_| error!(RegistryError::InvalidMerkleRoot))?;
        out[i] = byte;
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
    fn roll_is_deterministic() {
        let sig = [7u8; 64];
        let a = roll_from_inputs(&sig, 0, 12345);
        let b = roll_from_inputs(&sig, 0, 12345);
        assert_eq!(a, b);
        let c = roll_from_inputs(&sig, 1, 12345);
        assert_ne!(a, c);
    }
}
