import type { SupabaseClient } from '@supabase/supabase-js';
import { updateTicketsByIdInChunks } from './supabase-batch.js';
import type { TicketRow } from './draw-settlement.js';
import { verifyTicketKindRollOnChain, type TicketRollRow } from './kind-roll-verify.js';
import type { ParsedKindRolledV2 } from './gift-draw-registry-client.js';
import { isRarePurchasableTicket } from './draw-ticket-weights.js';
import {
  TICKET_ORIGIN_PURCHASE,
  isFreeOrigin,
  ticketKindOriginMismatch,
} from './ticket-origin.js';

/** Shown in Tickets → Value (red) and stored in tickets.sync_error. */
export const DRAW_EXCLUDED_NO_ROLL_MSG = 'Not in draw: no on-chain kind roll';

export const DRAW_EXCLUDED_ADMIN_GRANT_MSG = 'Not in draw: admin grant (no on-chain roll)';

export const DRAW_EXCLUDED_INVALID_ORIGIN_MSG = 'Not in draw: invalid ticket kind/origin';

export const DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG = 'Not in draw: kind roll not verified on-chain';

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

export function requiresKindRollForDrawEntrant(ticket: DrawEntrantTicket): boolean {
  const origin = String(ticket.ticket_origin || '').trim().toLowerCase();
  return origin === TICKET_ORIGIN_PURCHASE;
}

/** Settlement: re-parse KindRolledV2 on Solana for paid event/legendary only (common = DB check). */
export function requiresSettlementOnChainRollVerify(ticket: DrawEntrantTicket): boolean {
  return requiresKindRollForDrawEntrant(ticket) && isRarePurchasableTicket(ticket);
}

export function drawEntrantExclusionReason(ticket: DrawEntrantTicket): string | null {
  if (ticketKindOriginMismatch(ticket.ticket_kind, ticket.ticket_origin)) {
    return DRAW_EXCLUDED_INVALID_ORIGIN_MSG;
  }

  if (isFreeOrigin(ticket.ticket_origin)) {
    return null;
  }

  if (!requiresKindRollForDrawEntrant(ticket)) return null;

  const pay = String(ticket.purchase_tx_sig || '').trim();
  if (pay.startsWith('admin_grant:')) return DRAW_EXCLUDED_ADMIN_GRANT_MSG;
  if (!(ticket.kind_roll_tx_sig || '').trim()) return DRAW_EXCLUDED_NO_ROLL_MSG;
  if (!(ticket.kind_roll_verified_at || '').trim()) return DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG;
  return null;
}

/**
 * DB pre-check, then live RPC parse of `kind_roll_tx_sig` (KindRolledV2 must match this row).
 * Blocks rows that only have roll fields set in Supabase without a valid on-chain roll.
 */
export async function drawEntrantExclusionReasonWithOnChainVerify(
  ticket: DrawEntrantRollTicket
): Promise<{ reason: string | null; parsed?: ParsedKindRolledV2 }> {
  const pre = drawEntrantExclusionReason(ticket);
  if (pre) return { reason: pre };
  if (!requiresKindRollForDrawEntrant(ticket)) return { reason: null };

  const chain = await verifyTicketKindRollOnChain(ticket as TicketRollRow);
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
        const { reason } = await drawEntrantExclusionReasonWithOnChainVerify(t);
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
