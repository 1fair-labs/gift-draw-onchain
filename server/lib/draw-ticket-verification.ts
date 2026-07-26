import type { SupabaseClient } from '@supabase/supabase-js';
import { updateTicketsByIdInChunks } from './supabase-batch.js';
import type { TicketRow } from './draw-settlement.js';
import { verifyTicketKindRollOnChain, type TicketRollRow } from './kind-roll-verify.js';
import type { ParsedKindRolledV2 } from './gift-draw-registry-client.js';
import {
  drawEntrantExclusionReason,
  requiresKindRollForDrawEntrant,
  requiresSettlementOnChainRollVerify,
  DRAW_EXCLUDED_NO_ROLL_MSG,
  DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG,
} from './draw-entrant-rules.js';

// The pure entrant rule lives in `draw-entrant-rules.ts` (no I/O, published in the audit mirror).
// Re-exported here so existing call sites keep their import path.
export {
  DRAW_EXCLUDED_NO_ROLL_MSG,
  DRAW_EXCLUDED_ADMIN_GRANT_MSG,
  DRAW_EXCLUDED_INVALID_ORIGIN_MSG,
  DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG,
  DRAW_EXCLUDED_PREFIX,
  drawEntrantExclusionReason,
  isCommittedDrawEntrant,
  requiresKindRollForDrawEntrant,
  requiresSettlementOnChainRollVerify,
  type DrawEntrantVerdictFields,
} from './draw-entrant-rules.js';

export type DrawEntrantTicket = TicketRow & {
  ticket_origin?: string | null;
  purchase_tx_sig?: string | null;
  kind_roll_tx_sig?: string | null;
  kind_roll_verified_at?: string | null;
};

/** Fields required to re-parse KindRolledV2 from Solana at enter-draw time. */
export type DrawEntrantRollTicket = DrawEntrantTicket &
  Pick<
    TicketRollRow,
    | 'owner_wallet'
    | 'ticket_serial'
    | 'purchase_amount'
    | 'purchase_amount_gift_equiv'
  >;

export const ENTER_DRAW_ON_CHAIN_VERIFY_CONCURRENCY = 8;
export const SETTLEMENT_ON_CHAIN_VERIFY_CONCURRENCY = 8;

/**
 * DB pre-check, then live RPC parse of `kind_roll_tx_sig` (KindRolledV2 must match this row).
 * Blocks rows that only have roll fields set in Supabase without a valid on-chain roll.
 */
export async function drawEntrantExclusionReasonWithOnChainVerify(
  ticket: DrawEntrantRollTicket,
  supabase?: SupabaseClient
): Promise<{ reason: string | null; parsed?: ParsedKindRolledV2 }> {
  const pre = drawEntrantExclusionReason(ticket);
  // ROLL_UNVERIFIED means the sig is present but kind_roll_verified_at is not yet set (e.g. the roll
  // landed but its event read-back was pending). That's NOT a hard exclusion — confirm it on-chain
  // here (which sets verified_at) instead of blocking, matching the batch enter path. Any other
  // reason (no roll, admin grant, invalid origin) is a hard exclusion.
  if (pre && pre !== DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG) return { reason: pre };
  if (!requiresKindRollForDrawEntrant(ticket)) return { reason: null };

  // Pass supabase so claim tickets can resolve their `claim:{prizeId}` reference from the on-chain
  // entropy (the roll event carries a hash, not the literal claim ref); without it a valid claim
  // roll is wrongly rejected as a "claim reference mismatch".
  const chain = await verifyTicketKindRollOnChain(ticket as TicketRollRow, supabase);
  if (!chain.ok) {
    return { reason: `${DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG} (${chain.error})` };
  }
  return { reason: null, parsed: chain.parsed };
}

export function partitionDrawEntrants(tickets: DrawEntrantTicket[]): {
  verified: DrawEntrantTicket[];
  excluded: DrawEntrantTicket[];
} {
  const verified: DrawEntrantTicket[] = [];
  const excluded: DrawEntrantTicket[] = [];
  for (const t of tickets) {
    const reason = drawEntrantExclusionReason(t);
    if (reason) excluded.push(t);
    else verified.push(t);
  }
  return { verified, excluded };
}

async function markExcludedEntrants(
  supabase: SupabaseClient,
  excluded: DrawEntrantTicket[],
  reasonForId: (t: DrawEntrantTicket) => string
): Promise<void> {
  if (!excluded.length) return;
  const byReason = new Map<string, number[]>();
  for (const t of excluded) {
    const reason = reasonForId(t) || DRAW_EXCLUDED_NO_ROLL_MSG;
    const ids = byReason.get(reason) || [];
    ids.push(t.id);
    byReason.set(reason, ids);
  }
  for (const [reason, ids] of byReason) {
    await updateTicketsByIdInChunks(supabase, ids, {
      status: 'used',
      sync_error: reason,
    });
  }
}

/** Mark unverified paid entrants used so they leave the active pool; settlement uses the rest only. */
export async function excludeUnverifiedDrawEntrants(
  supabase: SupabaseClient,
  tickets: DrawEntrantTicket[]
): Promise<{ verified: DrawEntrantTicket[]; excludedCount: number }> {
  const { verified: dbVerified, excluded: dbExcluded } = partitionDrawEntrants(tickets);
  const verified: DrawEntrantTicket[] = [];
  const excluded: DrawEntrantTicket[] = [...dbExcluded];
  const exclusionReasonById = new Map<number, string>();

  for (const t of dbExcluded) {
    exclusionReasonById.set(t.id, drawEntrantExclusionReason(t) || DRAW_EXCLUDED_NO_ROLL_MSG);
  }

  const rareForRpc: DrawEntrantRollTicket[] = [];
  for (const t of dbVerified) {
    if (requiresSettlementOnChainRollVerify(t)) {
      rareForRpc.push(t as DrawEntrantRollTicket);
    } else {
      verified.push(t);
    }
  }

  const concurrency = SETTLEMENT_ON_CHAIN_VERIFY_CONCURRENCY;
  for (let i = 0; i < rareForRpc.length; i += concurrency) {
    const slice = rareForRpc.slice(i, i + concurrency);
    await Promise.all(
      slice.map(async (t) => {
        const { reason } = await drawEntrantExclusionReasonWithOnChainVerify(t, supabase);
        if (reason) {
          excluded.push(t);
          exclusionReasonById.set(t.id, reason);
          return;
        }
        verified.push(t);
      })
    );
  }

  await markExcludedEntrants(supabase, excluded, (t) => exclusionReasonById.get(t.id) || DRAW_EXCLUDED_NO_ROLL_MSG);

  return { verified, excludedCount: excluded.length };
}
