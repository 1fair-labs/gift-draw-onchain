/**
 * Mega Prize draw — one bought ticket, one entry, winner takes the pot.
 *
 * Relationship to the daily draw: same primitives. The seed is committed on-chain first, the
 * entrant list is hashed the same way, and the ordering uses the same weighted shuffle driven
 * by the same `SeedPrng`. Every entry carries weight 1, which makes that shuffle a plain
 * uniform draw — one algorithm to audit, not two. See docs/SETTLEMENT-SPEC.md.
 *
 * Who is in it:
 *   Tickets BOUGHT with money (`MEGA_PRIZE_ELIGIBLE_CURRENCIES`) during the draw's period.
 *   Free play does not enter. The airdrop funds the pot through the 5% carve, but only bought
 *   tickets play for it.
 *
 * How chance works:
 *   Every entry is identical. Buying 10 tickets is 10 entries, not a multiplier — so someone
 *   holding a single ticket can win against someone holding thousands, and volume raises your
 *   odds exactly in proportion to what you put in. Ticket kind (common/event/legendary) is
 *   deliberately IGNORED here: it decides prize weight in the daily draw, nothing else.
 *
 * What the ranks mean:
 *   Rank 1 takes the entire pot. Lower ranks are recorded with `gift_amount = 0` purely so the
 *   results screen can show a finishing order.
 */
import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SeedPrng } from './draw-settlement.js';
import { merkleRootFromTicketIds, settlementSeedHex } from './draw-settlement-seed.js';
import { settlementShuffleSalt, weightedShuffle } from './draw-ticket-weights.js';
import { TICKET_ORIGIN_PURCHASE } from './ticket-origin.js';
import { fetchAllTicketRows } from './tickets-paginated.js';
import { getMegaPrizeSnapshot, resolveMegaPrizeCurrencies } from './mega-prize.js';
import {
  isRegistryEnabled,
  sendCommitDrawResultTx,
  sendDrawRandomnessTx,
} from './gift-draw-registry-client.js';

/** How many ranks are persisted for the results history. The winner is rank 1. */
export const MEGA_PRIZE_STORED_RANKS = 200;

/** Every entry is one bought ticket and they are all equal — there is no weighting to store. */
export type MegaPrizeEntrant = {
  ticketId: number;
  ownerAnonId: string | null;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

/**
 * Every entry in the period: one row per bought ticket.
 *
 * Paginated from the start — this spans the whole purchase history and the PostgREST 1000-row
 * cap would silently drop most of the field.
 *
 * Deliberately NOT filtered by draw participation: buying the ticket is the entry. A ticket
 * bought and never entered into a daily draw still played for the Mega Prize, because its
 * purchase is what fed the pot.
 */
export async function collectMegaPrizeEntrants(
  supabase: SupabaseClient,
  opts?: { periodStartIso?: string | null; periodEndIso?: string | null; currencies?: readonly string[] }
): Promise<MegaPrizeEntrant[]> {
  // Resolved from state: USDC only until the first draw completes, USDC+GIFT afterwards.
  const currencies = opts?.currencies ?? (await resolveMegaPrizeCurrencies(supabase));
  const rows = await fetchAllTicketRows<{
    id?: number | null;
    owner_user_id?: string | null;
  }>(supabase, (from, to) => {
    let q = supabase
      .from('tickets')
      .select('id,owner_user_id')
      .eq('stage', 'paid')
      .eq('ticket_origin', TICKET_ORIGIN_PURCHASE)
      .in('purchase_currency', [...currencies]);
    // Period bounds scope a quarterly draw to its own quarter. The first draw passes none,
    // so it covers everything bought up to that point.
    if (opts?.periodStartIso) q = q.gte('created_at', opts.periodStartIso);
    if (opts?.periodEndIso) q = q.lt('created_at', opts.periodEndIso);
    return q.order('id', { ascending: true }).range(from, to);
  });

  const out: MegaPrizeEntrant[] = [];
  for (const r of rows) {
    const ticketId = Number(r.id);
    if (!Number.isFinite(ticketId) || ticketId <= 0) continue;
    out.push({
      ticketId,
      ownerAnonId: r.owner_user_id != null ? String(r.owner_user_id) : null,
    });
  }
  return out;
}

/** Deterministic id for the draw, so a retry targets the same row and the same PDA. */
export function megaDrawIdForDate(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `MEGA-${y}${m}${day}`;
}

/**
 * Is every locked entry released?
 *
 * The Mega Prize sits last in the unlock ledger, so "nothing left locked" means every referral
 * accrual and every ticket prize ahead of it has been paid out first.
 */
export async function isMegaPrizeUnlockReady(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.rpc('mega_prize_unlock_ready');
  if (error) {
    console.error('mega_prize_unlock_ready', error.message);
    return false;
  }
  return data === true;
}

export type MegaPrizeDrawResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      // Required, not optional: an optional discriminant cannot narrow the union, which
      // silently turns every field access below into `any`.
      skipped: false;
      megaDrawId: string;
      potGift: number;
      entrantCount: number;
      winnerTicketId: number;
      winnerAnonId: string | null;
      seedHex: string;
      entrantListHash: string;
    }
  | { ok: false; error: string };

/**
 * Run the draw.
 *
 * Refuses to run unless the unlock ledger is fully released — that gate is the whole reason
 * the pot sits third in the ledger. Idempotent per `megaDrawId`: a completed row short-circuits,
 * so a retrying cron cannot draw twice.
 */
export async function runMegaPrizeDraw(
  supabase: SupabaseClient,
  opts?: { megaDrawId?: string; force?: boolean; periodEndIso?: string }
): Promise<MegaPrizeDrawResult> {
  const megaDrawId = (opts?.megaDrawId || megaDrawIdForDate()).trim();

  const { data: existing, error: exErr } = await supabase
    .from('mega_prize_draws')
    .select('mega_draw_id,status')
    .eq('mega_draw_id', megaDrawId)
    .maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (existing && String((existing as { status: string }).status) === 'completed') {
    return { ok: true, skipped: true, reason: `${megaDrawId} already settled` };
  }

  if (!opts?.force) {
    const ready = await isMegaPrizeUnlockReady(supabase);
    if (!ready) {
      return { ok: true, skipped: true, reason: 'Unlock ledger still has locked entries' };
    }
  }

  const pot = await getMegaPrizeSnapshot(supabase);
  if (!pot.available) return { ok: false, error: 'Mega Prize pot unreadable' };
  if (pot.totalGift <= 0) return { ok: true, skipped: true, reason: 'Pot is empty' };

  const entrants = await collectMegaPrizeEntrants(supabase);
  if (entrants.length === 0) return { ok: true, skipped: true, reason: 'No entrants' };

  // Same commitment shape as a daily draw: sorted ids → list hash → seed.
  const sortedIds = entrants.map((e) => e.ticketId).sort((a, b) => a - b);
  const entrantListHash = merkleRootFromTicketIds(sortedIds);
  const periodEndIso = opts?.periodEndIso || new Date().toISOString();
  const seedHex = settlementSeedHex(megaDrawId, periodEndIso, sortedIds);
  const prng = new SeedPrng(Buffer.from(seedHex, 'hex'));

  // Weight 1 for every entry — this is a uniform shuffle. Kept on the weighted primitive so
  // both draws in the product run on the same audited code path.
  const ordered = weightedShuffle(
    entrants,
    () => 1,
    prng,
    settlementShuffleSalt(megaDrawId, 'mega-prize')
  );

  const winner = ordered[0];
  if (!winner) return { ok: false, error: 'Shuffle produced no winner' };

  const potGift = round8(pot.totalGift);

  const { error: upErr } = await supabase
    .from('mega_prize_draws')
    .upsert(
      {
        mega_draw_id: megaDrawId,
        status: 'pending',
        pot_gift: potGift,
        entrant_count: entrants.length,
        entrant_list_hash: entrantListHash,
        random_seed_hex: seedHex,
        winner_ticket_id: winner.ticketId,
        winner_anon_id: winner.ownerAnonId,
        error: null,
      },
      { onConflict: 'mega_draw_id' }
    );
  if (upErr) return { ok: false, error: upErr.message };

  // Store the visible slice of the finishing order. Rank 1 carries the pot; the rest are
  // history rows, which is why gift_amount is 0 on every one of them.
  const stored = ordered.slice(0, MEGA_PRIZE_STORED_RANKS);
  const entryRows = stored.map((e, i) => ({
    mega_draw_id: megaDrawId,
    rank: i + 1,
    ticket_id: e.ticketId,
    owner_anon_id: e.ownerAnonId,
    gift_amount: i === 0 ? potGift : 0,
  }));

  // Replace rather than append: a re-run of a still-pending draw must not leave stale ranks.
  const { error: delErr } = await supabase
    .from('mega_prize_entries')
    .delete()
    .eq('mega_draw_id', megaDrawId);
  if (delErr) return { ok: false, error: delErr.message };

  const { error: insErr } = await supabase.from('mega_prize_entries').insert(entryRows);
  if (insErr) return { ok: false, error: insErr.message };

  // Commit the seed on-chain BEFORE the result, same order as a daily draw. The program takes
  // an arbitrary draw id (MAX_DRAW_ID_LEN = 32; 'MEGA-YYYYMMDD' is 13), so this reuses
  // draw_randomness / commit_draw_result as-is — no program upgrade for the Mega Prize.
  //
  // Fail-soft: the draw itself is already deterministic from data anyone can recompute, so a
  // chain outage must not block paying the winner. The tx sigs stay null and can be backfilled.
  let seedTxSig: string | null = null;
  if (isRegistryEnabled()) {
    try {
      const { signature } = await sendDrawRandomnessTx({
        drawId: megaDrawId,
        periodEndIso,
        merkleRootHex: entrantListHash,
        periodEndUnix: Math.floor(new Date(periodEndIso).getTime() / 1000),
      });
      seedTxSig = signature;
    } catch (e) {
      console.error('mega prize draw_randomness', e instanceof Error ? e.message : e);
    }
  }

  const settlementHash = createHash('sha256')
    .update(megaDrawId, 'utf8')
    .update('|', 'utf8')
    .update(seedHex, 'utf8')
    .update('|', 'utf8')
    .update(entrantListHash, 'utf8')
    .update('|', 'utf8')
    .update(String(winner.ticketId), 'utf8')
    .update('|', 'utf8')
    .update(String(Math.round(potGift * 1e6)), 'utf8')
    .digest('hex');

  // The result hash goes on-chain only if the seed did — a commit against a missing DrawSeed
  // fails on-chain anyway, and a half-written pair is worse than none.
  let commitTxSig: string | null = null;
  if (seedTxSig) {
    try {
      const { signature } = await sendCommitDrawResultTx({
        drawId: megaDrawId,
        settlementHash: Buffer.from(settlementHash, 'hex'),
        winnerCount: 1,
      });
      commitTxSig = signature;
    } catch (e) {
      console.error('mega prize commit_draw_result', e instanceof Error ? e.message : e);
    }
  }

  const { error: doneErr } = await supabase
    .from('mega_prize_draws')
    .update({
      status: 'completed',
      settlement_hash: settlementHash,
      seed_tx_sig: seedTxSig,
      commit_tx_sig: commitTxSig,
      completed_at: new Date().toISOString(),
    })
    .eq('mega_draw_id', megaDrawId);
  if (doneErr) return { ok: false, error: doneErr.message };

  return {
    ok: true,
    skipped: false,
    megaDrawId,
    potGift,
    entrantCount: entrants.length,
    winnerTicketId: winner.ticketId,
    winnerAnonId: winner.ownerAnonId,
    seedHex,
    entrantListHash,
  };
}
