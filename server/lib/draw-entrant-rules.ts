/**
 * Who counts as an entrant in a draw — the pure rule, with no I/O.
 *
 * Split out of `draw-ticket-verification.ts` so it can be read and re-run on its own: this is the
 * predicate the settlement applies before hashing the entrant list into `DrawSeed.merkle_root`,
 * so anyone reproducing that hash has to apply exactly this and nothing else. Keep it free of
 * Supabase, RPC and env — the moment it needs I/O, independent verification stops being possible.
 *
 * Published in the on-chain audit mirror.
 */
import { isRarePurchasableTicket } from './draw-ticket-weights.js';
import {
  TICKET_ORIGIN_PURCHASE,
  TICKET_ORIGIN_CLAIM,
  isFreeOrigin,
  ticketKindOriginMismatch,
} from './ticket-origin.js';

/** Shown in Tickets → Value (red) and stored in tickets.sync_error. */
export const DRAW_EXCLUDED_NO_ROLL_MSG = 'Not in draw: no on-chain kind roll';

export const DRAW_EXCLUDED_ADMIN_GRANT_MSG = 'Not in draw: admin grant (no on-chain roll)';

export const DRAW_EXCLUDED_INVALID_ORIGIN_MSG = 'Not in draw: invalid ticket kind/origin';

export const DRAW_EXCLUDED_ROLL_UNVERIFIED_MSG = 'Not in draw: kind roll not verified on-chain';

/** Prefix every exclusion reason shares — `sync_error` is the durable mark on an excluded row. */
export const DRAW_EXCLUDED_PREFIX = 'Not in draw:';

/**
 * The only columns the rule reads. Kept narrow so a caller that must not expose owner columns
 * (the public verification endpoint) can select just these.
 */
export type DrawEntrantVerdictFields = {
  ticket_kind: string | null;
  ticket_origin?: string | null;
  purchase_tx_sig?: string | null;
  kind_roll_tx_sig?: string | null;
  kind_roll_verified_at?: string | null;
};

export function requiresKindRollForDrawEntrant(
  ticket: Pick<DrawEntrantVerdictFields, 'ticket_origin'>
): boolean {
  // Purchase AND claim tickets must carry a verified on-chain kind roll to enter/settle — both have
  // real value and a real on-chain roll (claim rolls via the custodial mint wallet). Only free-origin
  // tickets (promo/welcome/referral) are exempt. This gates entry and DB-gates settlement for both;
  // rare tickets of either origin additionally get the live RPC re-verify (see requiresSettlement...).
  const origin = String(ticket.ticket_origin || '').trim().toLowerCase();
  return origin === TICKET_ORIGIN_PURCHASE || origin === TICKET_ORIGIN_CLAIM;
}

/** Settlement: re-parse KindRolledV2 on Solana for paid event/legendary only (common = DB check). */
export function requiresSettlementOnChainRollVerify(ticket: DrawEntrantVerdictFields): boolean {
  return requiresKindRollForDrawEntrant(ticket) && isRarePurchasableTicket(ticket);
}

export function drawEntrantExclusionReason(ticket: DrawEntrantVerdictFields): string | null {
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
 * Was this row part of the committed entrant set?
 *
 * Two things can drop a ticket: the pure rule above, and the live on-chain re-verify that rare
 * entrants get at settlement — which this cannot replay. Settlement records that second outcome by
 * writing the reason into `sync_error`, so honour it as well.
 */
export function isCommittedDrawEntrant(
  ticket: DrawEntrantVerdictFields & { sync_error?: string | null }
): boolean {
  if (String(ticket.sync_error || '').trim().startsWith(DRAW_EXCLUDED_PREFIX)) return false;
  return drawEntrantExclusionReason(ticket) === null;
}
