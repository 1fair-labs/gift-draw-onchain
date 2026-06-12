import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DrawScheduleMode } from './draw-schedule.js';
import { compareDailyDrawIdChronological, dailyDrawCalendarBase } from './draw-schedule.js';
import { resolvePeriodBoundsForDrawId } from './draw-period-bounds-resolve.js';
import { setGlobalJackpotBalance } from './lottery-jackpot-state.js';
import { fetchAllTicketRows } from './tickets-paginated.js';
import {
  clearIncompleteSettlementsForDraw,
  insertRowsInChunks,
  updateTicketsByIdInChunks,
} from './supabase-batch.js';
import { allocateMainGiftPrizes } from './poker-payout-schedule.js';
import {
  assertForceJackpotAllowed,
  assertFreshShuffleAllowed,
  shouldForceJackpotHit,
} from './lottery-jackpot-dev.js';
import {
  JACKPOT_HIT_N,
  JACKPOT_HIT_VALUE,
  merkleRootFromTicketIds,
  settlementSeedHex,
} from './lottery-settlement-seed.js';
import {
  isRarePurchasableTicket,
  settlementShuffleSalt,
  ticketDrawWeight,
  weightedShuffle,
} from './draw-ticket-weights.js';
import { excludeUnverifiedDrawEntrants } from './draw-ticket-verification.js';
import {
  buildPrizeCommitRowsFromInserts,
  type SettlementPrizeCommitRow,
} from './settlement-prize-commit.js';
import { isFreeOrigin, TICKET_ORIGIN_PURCHASE } from './ticket-origin.js';

export const SETTLEMENT_SPEC_VERSION = 18;

const JACKPOT_CONTRIB_RATE = 0.1;
const COMPANY_RATE = 0.1;
const BURN_RATE = 0.01;
const OPS_EST = 0;

export type TicketRow = {
  id: number;
  owner_user_id: string | null;
  owner_wallet?: string | null;
  ticket_serial?: number | null;
  ticket_kind: string | null;
  ticket_origin?: string | null;
  purchase_tx_sig?: string | null;
  purchase_amount?: number | null;
  kind_roll_tx_sig?: string | null;
  kind_roll_verified_at?: string | null;
  purchase_amount_gift_equiv: number | null;
  status: string;
  draw_id?: string | null;
};

type TicketRowDb = TicketRow & { draw_id?: string | null };

async function filterTicketsNotInCompletedSettlement(
  supabase: SupabaseClient,
  tickets: TicketRowDb[]
): Promise<TicketRowDb[]> {
  const ids = tickets.map((t) => t.id);
  if (!ids.length) return [];

  const { data: prized, error: pErr } = await supabase
    .from('draw_ticket_prizes')
    .select('ticket_id,settlement_id')
    .in('ticket_id', ids);
  if (pErr) throw new Error(pErr.message);
  if (!prized?.length) return tickets;

  const settlementIds = [
    ...new Set(
      (prized as { settlement_id?: string }[])
        .map((p) => String(p.settlement_id || ''))
        .filter(Boolean)
    ),
  ];
  if (!settlementIds.length) return tickets;

  const { data: completed, error: cErr } = await supabase
    .from('draw_settlements')
    .select('id')
    .in('id', settlementIds)
    .eq('status', 'completed');
  if (cErr) throw new Error(cErr.message);

  const completedSet = new Set((completed || []).map((r: { id: string }) => String(r.id)));
  const prizedIds = new Set(
    (prized as { ticket_id?: number; settlement_id?: string }[])
      .filter((p) => completedSet.has(String(p.settlement_id || '')))
      .map((p) => Number(p.ticket_id))
      .filter((id) => Number.isFinite(id))
  );
  return tickets.filter((t) => !prizedIds.has(t.id));
}

async function summarizeTicketDrawIds(
  supabase: SupabaseClient,
  statuses: readonly string[]
): Promise<string> {
  const rows = await fetchAllTicketRows<{ draw_id?: string | null }>(supabase, (from, to) =>
    supabase
      .from('tickets')
      .select('draw_id')
      .in('status', [...statuses])
      .order('id', { ascending: true })
      .range(from, to)
  );
  if (!rows.length) return '';

  const counts = new Map<string, number>();
  for (const r of rows) {
    const id = String(r.draw_id || '').trim() || '(no draw_id)';
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return sorted.map(([id, n]) => `${id} (${n})`).join(', ');
}

/** Load entrants, exclude paid tickets without on-chain roll, return verified ids for merkle/seed. */
export async function prepareVerifiedDrawEntrantIds(
  supabase: SupabaseClient,
  drawId: string,
  includeUsed: boolean
): Promise<{ sortedIds: number[]; excludedCount: number; reassignedCount: number }> {
  const loaded = await loadTicketsForSettlement(supabase, drawId, includeUsed);
  const { verified, excludedCount } = await excludeUnverifiedDrawEntrants(supabase, loaded.tickets);
  const sortedIds = verified.map((t) => t.id).sort((a, b) => a - b);
  return { sortedIds, excludedCount, reassignedCount: loaded.reassignedCount };
}

/**
 * Load entrants for settlement. Recovery (`includeUsed`) may pull same-calendar-day
 * tickets and reassign `draw_id` to the draw being settled.
 */
async function loadTicketsForSettlement(
  supabase: SupabaseClient,
  drawId: string,
  includeUsed: boolean
): Promise<{ tickets: TicketRow[]; reassignedCount: number }> {
  const statuses = includeUsed ? (['in_draw', 'used'] as const) : (['in_draw'] as const);

  const selectCols =
    'id,owner_user_id,owner_wallet,ticket_serial,ticket_kind,ticket_origin,purchase_tx_sig,purchase_amount,purchase_amount_gift_equiv,kind_roll_tx_sig,kind_roll_verified_at,status,draw_id';

  let pool = await fetchAllTicketRows<TicketRowDb>(supabase, (from, to) =>
    supabase
      .from('tickets')
      .select(selectCols)
      .eq('draw_id', drawId)
      .in('status', [...statuses])
      .order('id', { ascending: true })
      .range(from, to)
  );
  if (pool.length > 0) {
    return { tickets: pool, reassignedCount: 0 };
  }

  if (!includeUsed) {
    return { tickets: [], reassignedCount: 0 };
  }

  const base = dailyDrawCalendarBase(drawId);
  if (!base) {
    return { tickets: [], reassignedCount: 0 };
  }

  const dayTickets = await fetchAllTicketRows<TicketRowDb>(supabase, (from, to) =>
    supabase
      .from('tickets')
      .select(selectCols)
      .in('status', [...statuses])
      .or(`draw_id.eq.${base},draw_id.like.${base}_%`)
      .order('id', { ascending: true })
      .range(from, to)
  );
  pool = dayTickets.filter((t) => String(t.draw_id || '').trim() === drawId);

  if (!pool.length) {
    const seqMatch = /^(\d{8})_(\d+)$/.exec(drawId);
    const seq = seqMatch?.[2] ? Number(seqMatch[2]) : 0;
    if (seq >= 1) {
      pool = dayTickets.filter((t) => String(t.draw_id || '').trim() === base);
    }
  }

  if (!pool.length && dayTickets.length > 0) {
    pool = await filterTicketsNotInCompletedSettlement(supabase, dayTickets);
  }

  if (!pool.length) {
    return { tickets: [], reassignedCount: 0 };
  }

  const reassignIds = pool
    .filter((t) => String(t.draw_id || '').trim() !== drawId)
    .map((t) => t.id);
  if (reassignIds.length > 0) {
    await updateTicketsByIdInChunks(supabase, reassignIds, { draw_id: drawId });
  }

  return {
    tickets: pool.map((t) => ({ ...t, draw_id: drawId })),
    reassignedCount: reassignIds.length,
  };
}

const isFreeEntryKind = (kind: unknown, origin?: string | null): boolean => {
  if (isFreeOrigin(origin)) return true;
  const k = String(kind || '').trim().toLowerCase();
  return k === 'welcome' || k === 'referral' || k === 'promo';
};

const giftEquiv = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Jackpot balance at the start of `currentDrawId`, derived only from **completed**
 * settlements in chronological draw_id order (not insert order / not global row alone).
 * After a hit, only that draw's 10% slice rolls forward; otherwise contributions accumulate.
 */
export async function jackpotRunningBeforeDrawFromLedger(
  supabase: SupabaseClient,
  currentDrawId: string
): Promise<number> {
  const { data: rows, error } = await supabase
    .from('draw_settlements')
    .select('draw_id,jackpot_contribution,jackpot_hit')
    .eq('status', 'completed');
  if (error || !rows?.length) return 0;

  type Row = { draw_id: string; jackpot_contribution: unknown; jackpot_hit: unknown };
  const sorted = [...(rows as Row[])].sort((x, y) =>
    compareDailyDrawIdChronological(String(x.draw_id), String(y.draw_id))
  );

  let running = 0;
  for (const r of sorted) {
    const id = String(r.draw_id);
    if (compareDailyDrawIdChronological(id, currentDrawId) >= 0) break;
    const jc = Number(r.jackpot_contribution);
    const hit = Boolean(r.jackpot_hit);
    if (!Number.isFinite(jc)) continue;
    if (hit) running = jc;
    else running += jc;
  }
  return running;
}

const PURCHASABLE_KINDS = new Set(['common', 'event', 'legendary']);

const isPaidTicket = (r: TicketRow): boolean => {
  const kind = String(r.ticket_kind || '').trim().toLowerCase();
  const origin = String(r.ticket_origin || '').trim().toLowerCase();
  if (isFreeEntryKind(kind, origin)) return false;
  if (origin === TICKET_ORIGIN_PURCHASE && PURCHASABLE_KINDS.has(kind)) return true;
  const equiv = giftEquiv(r.purchase_amount_gift_equiv);
  const equivMissing =
    r.purchase_amount_gift_equiv == null || !Number.isFinite(Number(r.purchase_amount_gift_equiv));
  const free = equivMissing || equiv === 0;
  return !free;
};

class SeedPrng {
  private counter = 0;
  constructor(private readonly seedBuf: Buffer) {}

  /** Uniform in [0, max) */
  nextBelow(max: number): number {
    if (max <= 0) return 0;
    const h = createHash('sha256')
      .update(this.seedBuf)
      .update(Buffer.from(`|${this.counter++}|`))
      .digest();
    const u = h.readUInt32BE(0);
    return u % max;
  }

  nextU32(): number {
    const h = createHash('sha256')
      .update(this.seedBuf)
      .update(Buffer.from(`|${this.counter++}|`))
      .digest();
    return h.readUInt32BE(0);
  }

  /** Uniform in (0, 1] for weighted shuffle keys. */
  nextOpenUnit(salt: string): number {
    const h = createHash('sha256')
      .update(this.seedBuf)
      .update(Buffer.from(`|open|${this.counter++}|${salt}|`))
      .digest();
    return (h.readUInt32BE(0) + 1) / 4294967296;
  }
}

export type SettleDrawOptions = {
  /** Recovery: include tickets already `used` (manual draw / SQL). */
  includeUsedTickets?: boolean;
  /**
   * Recovery default: do not rewrite `lottery_jackpot_state` (later draws may already exist).
   * Set false only when you are sure this settlement is the latest chronological close.
   */
  skipJackpotGlobalUpdate?: boolean;
  /** Staging only (`LOTTERY_JACKPOT_DEV_TOOLS=1`): force jackpot hit regardless of roll. */
  forceJackpotHit?: boolean;
  /** Staging Recalc only: mix unique nonce into seed for a new weighted shuffle. */
  freshShuffleNonce?: string | null;
  /** Anchored draw: seed from on-chain `draw_randomness` (hex). */
  seedHexOverride?: string;
};

export type SettleDrawResult =
  | { ok: true; skipped: true; reason: string }
  | {
      ok: true;
      skipped: false;
      settlementId: string;
      drawId: string;
      merkleRootHex?: string;
      seedHex?: string;
      winnerTicketIds?: number[];
      prizeCommitRows?: SettlementPrizeCommitRow[];
      prizePool: number;
      winnerPool: number;
      mainWinnerCount: number;
      jackpotHit: boolean;
      jackpotPayoutTotal: number;
      jackpotRoll?: number;
      jackpotForced?: boolean;
      recovery?: boolean;
      note?: string;
      reassignedTickets?: number;
      freshShuffleNonce?: string;
    }
  | { ok: false; error: string };

type DrawRowSyncStats = {
  prizePool: number;
  totalEntries: number;
  paidEntries: number;
  freeEntries: number;
  totalWinners: number;
  paidWinners: number;
  freeWinners: number;
  /** Jackpot pool snapshot at draw close (before hit payout). */
  jackpotSnapshot: number;
  periodEndIso: string;
};

/** Keep `draws` in sync with settlement — same outcome as cron / Run draw now. */
async function syncDrawRowsAfterSettlement(
  supabase: SupabaseClient,
  drawId: string,
  stats: DrawRowSyncStats
): Promise<void> {
  const patch = {
    prize_pool: stats.prizePool,
    total_entries: stats.totalEntries,
    paid_entries: stats.paidEntries,
    free_entries: stats.freeEntries,
    total_winners: stats.totalWinners,
    paid_winners: stats.paidWinners,
    free_winners: stats.freeWinners,
    jackpot: stats.jackpotSnapshot,
    end_at: stats.periodEndIso,
  };

  const { data: rows, error } = await supabase
    .from('draws')
    .select('id,status')
    .eq('draw_id', drawId)
    .order('id', { ascending: false });
  if (error) throw new Error(error.message);

  const list = (rows || []) as { id: number; status?: string }[];
  if (list.length > 0) {
    for (const row of list) {
      const statusPatch = row.status === 'active' ? { status: 'completed' as const } : {};
      const { error: uErr } = await supabase.from('draws').update({ ...patch, ...statusPatch }).eq('id', row.id);
      if (uErr) throw new Error(uErr.message);
    }
    return;
  }

  const { error: insErr } = await supabase.from('draws').insert({
    draw_id: drawId,
    status: 'completed',
    created_at: new Date().toISOString(),
    ...patch,
  });
  if (insErr) throw new Error(insErr.message);
}

/**
 * Settlement spec v2: DB ledger + deterministic RNG from merkle(draw tickets) + period end.
 * Winner pool: each of W slots absorbs avg (ticket prizes imputed at avg); remainder MTT-style among GIFT winners.
 * Does not move SPL on-chain (company / burn / claims) — amounts recorded only.
 */
export async function settleDrawById(
  supabase: SupabaseClient,
  drawId: string,
  mode: DrawScheduleMode,
  options?: SettleDrawOptions
): Promise<SettleDrawResult> {
  const includeUsed = options?.includeUsedTickets === true;
  const skipJackpotGlobal =
    options?.skipJackpotGlobalUpdate ?? (includeUsed ? true : false);
  const bounds = await resolvePeriodBoundsForDrawId(supabase, drawId, mode);
  if (!bounds) return { ok: false, error: 'Invalid draw_id for schedule mode' };
  const periodEndIso = bounds.periodEnd.toISOString();

  const { data: existingDone, error: exErr } = await supabase
    .from('draw_settlements')
    .select('id')
    .eq('draw_id', drawId)
    .eq('status', 'completed')
    .maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (existingDone) return { ok: true, skipped: true, reason: 'Draw already settled' };

  try {
    await clearIncompleteSettlementsForDraw(supabase, drawId);
  } catch (clearErr) {
    const msg = clearErr instanceof Error ? clearErr.message : 'clear failed settlements failed';
    return { ok: false, error: msg };
  }

  let reassignedCount = 0;
  let excludedFromDrawCount = 0;
  let tickets: TicketRow[];
  try {
    const loaded = await loadTicketsForSettlement(supabase, drawId, includeUsed);
    reassignedCount = loaded.reassignedCount;
    const prepared = await excludeUnverifiedDrawEntrants(supabase, loaded.tickets);
    tickets = prepared.verified;
    excludedFromDrawCount = prepared.excludedCount;
  } catch (loadErr) {
    const msg = loadErr instanceof Error ? loadErr.message : 'ticket load failed';
    return { ok: false, error: msg };
  }

  if (tickets.length === 0) {
    const hint = await summarizeTicketDrawIds(
      supabase,
      includeUsed ? ['in_draw', 'used'] : ['in_draw']
    );
    const reason = includeUsed
      ? hint
        ? `No verified tickets for draw_id ${drawId}. in_draw/used tickets are on: ${hint}`
        : `No verified tickets for draw_id ${drawId}`
      : excludedFromDrawCount > 0
        ? 'No verified in_draw tickets for this draw (unverified entrants excluded)'
        : 'No in_draw tickets for this draw';
    return { ok: true, skipped: true, reason };
  }

  const paid: TicketRow[] = [];
  const freeList: TicketRow[] = [];
  for (const t of tickets) {
    if (isPaidTicket(t)) paid.push(t);
    else freeList.push(t);
  }
  /** Purchased Event/Legendary must compete as paid even if gift_equiv was missing in DB. */
  for (let i = freeList.length - 1; i >= 0; i--) {
    const t = freeList[i]!;
    if (isRarePurchasableTicket(t)) {
      paid.push(t);
      freeList.splice(i, 1);
    }
  }

  /** Sum of GIFT equivalent — paid tickets only; free entries do not dilute pool or avg. */
  const prizePool = paid.reduce((s, t) => s + giftEquiv(t.purchase_amount_gift_equiv), 0);
  const paidCount = paid.length;
  if (paidCount === 0) {
    return { ok: true, skipped: true, reason: 'No paid tickets; settlement not run' };
  }

  assertForceJackpotAllowed(options?.forceJackpotHit);

  const rerollNonce =
    options?.freshShuffleNonce != null ? String(options.freshShuffleNonce).trim() : '';
  if (rerollNonce) {
    assertFreshShuffleAllowed(true);
  }

  const sortedIds = tickets.map((t) => t.id).sort((a, b) => a - b);
  const merkleRoot = merkleRootFromTicketIds(sortedIds);
  const computedSeedHex = settlementSeedHex(drawId, periodEndIso, sortedIds, {
    rerollNonce: rerollNonce || null,
  });
  const overrideSeed = options?.seedHexOverride?.trim();
  if (overrideSeed && overrideSeed !== computedSeedHex && !rerollNonce) {
    return { ok: false, error: 'seedHexOverride does not match settlement formula' };
  }
  const seedHex = overrideSeed || computedSeedHex;
  const prng = new SeedPrng(Buffer.from(seedHex, 'hex'));

  const jackpotContrib = prizePool * JACKPOT_CONTRIB_RATE;
  const companyAmount = prizePool * COMPANY_RATE;
  const burnAmount = prizePool * BURN_RATE;
  const winnerPool = Math.max(
    0,
    prizePool - jackpotContrib - companyAmount - burnAmount - OPS_EST
  );

  const jackpotBefore = await jackpotRunningBeforeDrawFromLedger(supabase, drawId);

  const jackpotAfterContrib = jackpotBefore + jackpotContrib;
  const roll30 = prng.nextBelow(JACKPOT_HIT_N);
  const naturalJackpotHit = roll30 === JACKPOT_HIT_VALUE;
  const jackpotForced = shouldForceJackpotHit(options?.forceJackpotHit);
  const jackpotHit = jackpotForced || naturalJackpotHit;
  let jackpotSplitMode: number | null = null;
  let jackpotPayoutTotal = 0;
  if (jackpotHit) {
    /** Internal 0/1/2 → UI split 1/2/3 (JP winners count). */
    jackpotSplitMode = prng.nextBelow(3);
    /** In play if hit = accumulated before this draw; 10% slice still rolls to next round. */
    jackpotPayoutTotal = jackpotBefore;
  }

  const wCap = Math.floor(paidCount * 0.25);
  /** Spec v17: free pool size from seed between 1:20 paid (min) and 1:10 paid (max). */
  const kMin = Math.min(Math.floor(paidCount / 20), freeList.length);
  const kMax = Math.min(Math.floor(paidCount / 10), freeList.length);
  const kActual =
    kMax <= 0
      ? 0
      : kMax <= kMin
        ? kMax
        : kMin + prng.nextBelow(kMax - kMin + 1);
  const sampledFree =
    kActual > 0
      ? weightedShuffle(
          freeList,
          ticketDrawWeight,
          prng,
          settlementShuffleSalt(drawId, 'admit-free')
        ).slice(0, kActual)
      : [];

  const rareInDraw = tickets.filter((t) => isRarePurchasableTicket(t)).length;
  const paidWinnerBase = Math.max(1, Math.min(wCap, paid.length));
  const paidWinnerTarget = Math.min(paid.length, Math.max(paidWinnerBase, rareInDraw));
  const freeWinnerTarget = Math.min(kActual, sampledFree.length);
  const paidWinnersFixed = weightedShuffle(
    paid,
    ticketDrawWeight,
    prng,
    settlementShuffleSalt(drawId, 'winners-paid')
  ).slice(0, paidWinnerTarget);
  const freeWinnersFixed =
    freeWinnerTarget > 0
      ? weightedShuffle(
          sampledFree,
          ticketDrawWeight,
          prng,
          settlementShuffleSalt(drawId, 'winners-free')
        ).slice(0, freeWinnerTarget)
      : [];
  const winnerSet = [...paidWinnersFixed, ...freeWinnersFixed];
  const W = winnerSet.length;
  const prizeOrder = weightedShuffle(
    winnerSet,
    ticketDrawWeight,
    prng,
    settlementShuffleSalt(drawId, 'rank')
  );

  const giftCount = Math.ceil(W / 2);
  const giftWinners = prizeOrder.slice(0, giftCount);
  const ticketWinners = prizeOrder.slice(giftCount);

  /** Average GIFT per paid entry — each winner slot absorbs this before MTT remainder (spec v2). */
  const avgGift = paidCount > 0 ? prizePool / paidCount : 0;
  const { giftCashAmounts, effectiveBase } = allocateMainGiftPrizes({
    winnerPool,
    mainWinnerCount: W,
    giftWinnerCount: giftWinners.length,
    avgGift,
  });

  const { data: inserted, error: insErr } = await supabase
    .from('draw_settlements')
    .insert({
      draw_id: drawId,
      schedule_mode: mode,
      status: 'pending',
      prize_pool_snapshot: prizePool,
      winner_pool_snapshot: winnerPool,
      jackpot_balance_before: jackpotBefore,
      jackpot_contribution: jackpotContrib,
      jackpot_hit: jackpotHit,
      jackpot_split_mode: jackpotSplitMode,
      jackpot_payout_total: jackpotHit ? jackpotPayoutTotal : null,
      company_amount: companyAmount,
      burn_amount: burnAmount,
      ops_amount_est: OPS_EST,
      random_seed_hex: seedHex,
      merkle_root_hex: merkleRoot,
      spec_version: SETTLEMENT_SPEC_VERSION,
      main_winner_count: winnerSet.length,
      paid_count: paidCount,
      free_sampled_count: kActual,
    })
    .select('id')
    .single();
  if (insErr || !inserted?.id) return { ok: false, error: insErr?.message || 'insert settlement failed' };

  const settlementId = String((inserted as { id: string }).id);
  const prizeRows: Record<string, unknown>[] = [];

  for (let i = 0; i < giftWinners.length; i++) {
    const t = giftWinners[i];
    const rank = i + 1;
    const amt = giftCashAmounts[i] ?? 0;
    prizeRows.push({
      settlement_id: settlementId,
      ticket_id: t.id,
      owner_user_id: t.owner_user_id,
      prize_bucket: 'main_gift',
      rank,
      gift_amount: amt,
      avg_gift_snapshot: effectiveBase,
      mint_ticket_kind: null,
      claim_status: 'pending',
    });
  }
  for (let j = 0; j < ticketWinners.length; j++) {
    const t = ticketWinners[j];
    const rank = giftWinners.length + j + 1;
    prizeRows.push({
      settlement_id: settlementId,
      ticket_id: t.id,
      owner_user_id: t.owner_user_id,
      prize_bucket: 'main_ticket',
      rank,
      gift_amount: null,
      avg_gift_snapshot: effectiveBase,
      mint_ticket_kind: null,
      claim_status: 'pending',
    });
  }

  if (jackpotHit && jackpotPayoutTotal > 0 && jackpotSplitMode != null) {
    const top1 = prizeOrder[0];
    const top2 = prizeOrder[1];
    const top3 = prizeOrder[2];
    const split = (amount: number, parts: number): number[] => {
      if (parts <= 0) return [];
      const base = Math.floor((amount * 1e8) / parts) / 1e8;
      const arr = Array(parts).fill(base);
      const rem = Math.round((amount - base * parts) * 1e8) / 1e8;
      if (rem > 0) arr[0] = Math.round((arr[0] + rem) * 1e8) / 1e8;
      return arr;
    };
    if (jackpotSplitMode === 0 && top1) {
      prizeRows.push({
        settlement_id: settlementId,
        ticket_id: top1.id,
        owner_user_id: top1.owner_user_id,
        prize_bucket: 'jackpot_gift',
        rank: 1,
        gift_amount: jackpotPayoutTotal,
        avg_gift_snapshot: null,
        mint_ticket_kind: null,
        claim_status: 'pending',
      });
    } else if (jackpotSplitMode === 1 && top1 && top2) {
      const [a, b] = split(jackpotPayoutTotal, 2);
      prizeRows.push({
        settlement_id: settlementId,
        ticket_id: top1.id,
        owner_user_id: top1.owner_user_id,
        prize_bucket: 'jackpot_gift',
        rank: 1,
        gift_amount: a,
        claim_status: 'pending',
      });
      prizeRows.push({
        settlement_id: settlementId,
        ticket_id: top2.id,
        owner_user_id: top2.owner_user_id,
        prize_bucket: 'jackpot_gift',
        rank: 2,
        gift_amount: b,
        claim_status: 'pending',
      });
    } else if (jackpotSplitMode === 2 && top1 && top2 && top3) {
      const [a, b, c] = split(jackpotPayoutTotal, 3);
      prizeRows.push({
        settlement_id: settlementId,
        ticket_id: top1.id,
        owner_user_id: top1.owner_user_id,
        prize_bucket: 'jackpot_gift',
        rank: 1,
        gift_amount: a,
        claim_status: 'pending',
      });
      prizeRows.push({
        settlement_id: settlementId,
        ticket_id: top2.id,
        owner_user_id: top2.owner_user_id,
        prize_bucket: 'jackpot_gift',
        rank: 2,
        gift_amount: b,
        claim_status: 'pending',
      });
      prizeRows.push({
        settlement_id: settlementId,
        ticket_id: top3.id,
        owner_user_id: top3.owner_user_id,
        prize_bucket: 'jackpot_gift',
        rank: 3,
        gift_amount: c,
        claim_status: 'pending',
      });
    } else {
      /** Fewer than required top ranks: give all to rank 1 if present. */
      if (top1) {
        prizeRows.push({
          settlement_id: settlementId,
          ticket_id: top1.id,
          owner_user_id: top1.owner_user_id,
          prize_bucket: 'jackpot_gift',
          rank: 1,
          gift_amount: jackpotPayoutTotal,
          claim_status: 'pending',
        });
      }
    }
  }

  for (const row of prizeRows) {
    row.draw_id = drawId;
  }

  const prizeCommitRows = buildPrizeCommitRowsFromInserts(prizeRows);

  try {
    await insertRowsInChunks(supabase, 'draw_ticket_prizes', prizeRows);
  } catch (pErr) {
    const msg = pErr instanceof Error ? pErr.message : 'prize insert failed';
    await supabase.from('draw_settlements').update({ status: 'failed', error: msg }).eq('id', settlementId);
    return { ok: false, error: msg };
  }

  const winnerTicketIds = new Set<number>();
  for (const row of prizeRows) {
    const tid = Number((row as { ticket_id?: unknown }).ticket_id);
    if (Number.isFinite(tid)) winnerTicketIds.add(tid);
  }
  /** Normal path: mark every entrant used. Recovery: tickets may already be `used`. */
  const inDrawIds = tickets.filter((t) => t.status === 'in_draw').map((t) => t.id);
  if (inDrawIds.length > 0) {
    try {
      await updateTicketsByIdInChunks(supabase, inDrawIds, { status: 'used' });
    } catch (uErr) {
      const msg = uErr instanceof Error ? uErr.message : 'ticket status update failed';
      await supabase.from('draw_settlements').update({ status: 'failed', error: msg }).eq('id', settlementId);
      return { ok: false, error: msg };
    }
  }

  if (!skipJackpotGlobal) {
    /** No hit: carry full pool forward. Hit: pay `before`; only this draw's 10% stays for next round. */
    const newJackpotBal = jackpotHit ? jackpotContrib : jackpotAfterContrib;
    try {
      await setGlobalJackpotBalance(supabase, newJackpotBal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'jackpot update failed';
      await supabase.from('draw_settlements').update({ status: 'failed', error: msg }).eq('id', settlementId);
      return { ok: false, error: msg };
    }
  }

  const distinctPrizeTickets = winnerTicketIds.size;

  const { error: finErr } = await supabase
    .from('draw_settlements')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', settlementId);
  if (finErr) return { ok: false, error: finErr.message };

  const paidWinners = prizeOrder.filter((w) => isPaidTicket(w)).length;
  const freeWinners = prizeOrder.length - paidWinners;
  const freeEntries = tickets.length - paidCount;
  /** `draws.jackpot` for home = pool at risk if hit (before); contrib is separate (→ next round). */
  const jackpotSnapshot = jackpotBefore;

  try {
    await syncDrawRowsAfterSettlement(supabase, drawId, {
      prizePool,
      totalEntries: tickets.length,
      paidEntries: paidCount,
      freeEntries,
      totalWinners: distinctPrizeTickets,
      paidWinners,
      freeWinners,
      jackpotSnapshot,
      periodEndIso,
    });
  } catch (syncErr) {
    const msg = syncErr instanceof Error ? syncErr.message : 'draw row sync failed';
    await supabase.from('draw_settlements').update({ status: 'failed', error: msg }).eq('id', settlementId);
    return { ok: false, error: msg };
  }

  return {
    ok: true,
    skipped: false,
    settlementId,
    drawId,
    merkleRootHex: merkleRoot,
    seedHex,
    winnerTicketIds: [...winnerTicketIds],
    prizeCommitRows,
    prizePool,
    winnerPool,
    mainWinnerCount: W,
    jackpotHit,
    jackpotPayoutTotal,
    jackpotRoll: roll30,
    jackpotForced: jackpotForced || undefined,
    recovery: includeUsed,
    reassignedTickets: reassignedCount > 0 ? reassignedCount : undefined,
    note: [
      includeUsed
        ? [
            reassignedCount > 0 ? `Reassigned ${reassignedCount} ticket(s) to ${drawId}.` : null,
            skipJackpotGlobal
              ? 'Recovery settlement; global jackpot balance was not changed.'
              : 'Recovery settlement from used tickets.',
          ]
            .filter(Boolean)
            .join(' ')
        : null,
      jackpotForced ? `Jackpot forced (dev); natural roll was ${roll30}/${JACKPOT_HIT_N}.` : null,
      rerollNonce ? `Fresh shuffle (dev); nonce ${rerollNonce}.` : null,
    ]
      .filter(Boolean)
      .join(' ')
      || undefined,
    freshShuffleNonce: rerollNonce || undefined,
  };
}
