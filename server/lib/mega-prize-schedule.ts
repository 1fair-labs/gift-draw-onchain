/**
 * Mega Prize schedule — WHEN the pot is drawn, and WHICH period each draw covers.
 *
 * Two rules, and they are different in kind:
 *
 *   1. The FIRST draw has no date. It fires as soon as the unlock ledger is fully released —
 *      the day everything owed to airdrop players has been paid out. Nobody can announce that
 *      date in advance because it depends on how fast the ledger closes, so the gate is state
 *      (`mega_prize_unlock_ready`), not a calendar.
 *
 *   2. Every draw after it is quarterly, on the LAST DAY of the quarter (UTC). The pot is drawn
 *      the moment the quarter is over — i.e. at the 00:00 UTC boundary that ends it, which the
 *      daily settlement pass reaches at 00:02. So the draw dated `MEGA-20260630` runs a couple of
 *      minutes into 1 July and covers everything up to that instant, including the last daily
 *      draw of the quarter (which settles earlier in the same pass and feeds the pot first).
 *
 * Why the period start is the previous draw's `period_end` and not the calendar boundary:
 *   the pot is what has accrued SINCE the last payout. Anchoring on the moment the previous draw
 *   actually took the money means every settlement lands in exactly one period — no gap where a
 *   late-completing settlement's 5% belongs to a pot that has already been paid out, and no
 *   overlap where it would be counted into two.
 *
 * Everything here is UTC, like every other period boundary in the product.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { IS_PAID_STAGE } from './stage.js';
import { UNLOCK_KIND_MEGA } from './unlock-tree.js';
import { baseToGift } from './unlock-snapshot.js';
import { unlockSnapshotNetwork } from './unlock-vault-publish.js';

/**
 * How short the first quarterly period is allowed to be before it is rolled into the next one.
 *
 * The first draw lands on an arbitrary day — whenever the unlock ledger closes. If that happens
 * on, say, 20 September, the very next quarter end is ten days later and would draw a pot fed by
 * ten days of play. Rolling such a stub into the following quarter keeps "a quarter's worth of
 * pot" honest. Set to 0 to always draw on the first quarter end, whatever the gap.
 */
export const MEGA_PRIZE_MIN_PERIOD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic id for the draw, so a retry targets the same row and the same PDA. */
export function megaDrawIdForDate(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `MEGA-${y}${m}${day}`;
}

/**
 * The first quarter boundary strictly after `after`: 00:00 UTC on 1 Jan / 1 Apr / 1 Jul / 1 Oct.
 *
 * "Strictly after" is what makes a draw that ran exactly at a boundary schedule the NEXT quarter
 * rather than itself.
 */
export function nextQuarterBoundaryUtc(after: Date): Date {
  const quarter = Math.floor(after.getUTCMonth() / 3);
  // Month 12 rolls over into January of the following year on its own.
  return new Date(Date.UTC(after.getUTCFullYear(), (quarter + 1) * 3, 1));
}

/**
 * The draw id for a period that ends at `boundary` — named after the LAST DAY of the quarter,
 * not the midnight that ends it. A draw run at 00:02 on 1 July is the 30 June draw, and 30 June
 * is the date players were given.
 */
export function megaDrawIdForBoundary(boundary: Date): string {
  return megaDrawIdForDate(new Date(boundary.getTime() - 1));
}

export type MegaPrizeSchedule = {
  /**
   * No Mega Prize draw has completed yet. The date rules do not apply to this one: the caller
   * gates it on the unlock ledger instead.
   */
  first: boolean;
  /**
   * Start of the period the next draw covers — the previous draw's cutoff. On the first draw it is
   * the snapshot's creation when there is a carry, and null otherwise.
   */
  periodStartIso: string | null;
  /** When the next draw becomes due. Null on the first, which waits on state rather than a date. */
  dueAtIso: string | null;
  /** Is the date gate open right now? Always true on the first draw (it has no date gate). */
  due: boolean;
  /** The id the next draw will be written under. */
  megaDrawId: string;
  /**
   * The airdrop's share of the FIRST paid-stage pot: the Mega Prize row of the activated unlock
   * snapshot. Null on every later draw, on the airdrop stage, and before a snapshot is activated.
   */
  carry: MegaPrizeCarry | null;
};

/**
 * What the airdrop hands the first paid-stage Mega Prize.
 *
 * The snapshot folds three things into its Mega Prize row: the airdrop's own 5% accrual, the wins
 * of players who never verified, and rows that lost their owner at the verification close. That row
 * reaches the draw vault's Mega pot through the unlock queue like any other row — the cron deposits
 * it once the chain R covers it (sweepUnlockMegaDeposit) — so the first draw must both count it and
 * wait for it: drawing before the deposit would promise a prize the pot cannot pay.
 */
export type MegaPrizeCarry = {
  snapshotId: number;
  /** The snapshot's creation — the paid stage's first period starts here. */
  sinceIso: string;
  amountGift: number;
  /** The row is in the Mega pot (claimed_amount covers amount). */
  deposited: boolean;
};

/** The activated snapshot's Mega Prize row, or null when there is none. Throws on a read error. */
async function readMegaPrizeCarry(supabase: SupabaseClient): Promise<MegaPrizeCarry | null> {
  if (!IS_PAID_STAGE) return null;
  const { data: snap, error: snapErr } = await supabase
    .from('unlock_snapshots')
    .select('id,created_at')
    .eq('network', unlockSnapshotNetwork())
    .eq('tranche', 0)
    .eq('status', 'activated')
    .maybeSingle();
  if (snapErr) throw new Error(`unlock_snapshots: ${snapErr.message}`);
  if (!snap) return null;

  const snapshotId = Number((snap as { id: number }).id);
  const { data: row, error: rowErr } = await supabase
    .from('unlock_snapshot_rows')
    .select('amount::text,claimed_amount::text')
    .eq('snapshot_id', snapshotId)
    .eq('kind', UNLOCK_KIND_MEGA)
    .order('seq', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (rowErr) throw new Error(`unlock_snapshot_rows: ${rowErr.message}`);

  const r = row as { amount: string; claimed_amount: string } | null;
  const amount = r ? BigInt(r.amount) : 0n;
  const claimed = r ? BigInt(r.claimed_amount || '0') : 0n;
  return {
    snapshotId,
    sinceIso: new Date(Date.parse(String((snap as { created_at: string }).created_at))).toISOString(),
    amountGift: Number(baseToGift(amount)),
    deposited: amount > 0n && claimed >= amount,
  };
}

type LastDraw = { megaDrawId: string; cutoffMs: number };

/**
 * The last completed draw and the instant it took the pot.
 *
 * `period_end` is that instant. Rows written before the schedule existed (a rehearsal, an early
 * manual run) have none, so `completed_at` stands in — the same moment to within seconds.
 * Throws on a query error: "could not read" must never be mistaken for "no draw yet", which
 * would reset the period start to the beginning of time and re-draw an already-paid pot.
 */
async function readLastCompletedMegaDraw(supabase: SupabaseClient): Promise<LastDraw | null> {
  const { data, error } = await supabase
    .from('mega_prize_draws')
    .select('mega_draw_id,period_end,completed_at')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const row = (data || [])[0] as
    | { mega_draw_id?: unknown; period_end?: unknown; completed_at?: unknown }
    | undefined;
  if (!row) return null;

  const cutoffMs = Date.parse(String(row.period_end ?? row.completed_at ?? ''));
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(`mega draw ${String(row.mega_draw_id)} has no usable period_end/completed_at`);
  }
  return { megaDrawId: String(row.mega_draw_id || '').trim(), cutoffMs };
}

/**
 * Cached per warm instance. The answer changes four times a year, and the personal entry count on
 * `?action=my-mega-entries` asks for it on every signed-in home-screen load. A minute keeps the
 * post-draw reset visible almost immediately while collapsing a traffic burst into one read.
 */
let scheduleCache: { value: MegaPrizeSchedule; at: number } | null = null;
const SCHEDULE_CACHE_MS = 60 * 1000;

/** Drop the cache after a draw, so this instance stops publishing the period that just ended. */
export function invalidateMegaPrizeSchedule(): void {
  scheduleCache = null;
}

/** When the next draw is due, what it covers, and what it will be called. */
export async function resolveMegaPrizeSchedule(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<MegaPrizeSchedule> {
  const cached = scheduleCache;
  // Re-resolved once the cached answer's own due date has passed, so `due` cannot be pinned false
  // by a read taken a minute before the boundary.
  if (cached && Date.now() - cached.at < SCHEDULE_CACHE_MS && !dueChanged(cached.value, now)) {
    return cached.value;
  }

  const last = await readLastCompletedMegaDraw(supabase);
  // The first paid-stage period starts at the snapshot: everything before it — the airdrop's
  // accrual included — is already inside the snapshot's Mega Prize row.
  const carry = last ? null : await readMegaPrizeCarry(supabase);
  const value: MegaPrizeSchedule = last
    ? scheduleAfter(last, now)
    : {
        first: true,
        periodStartIso: carry ? carry.sinceIso : null,
        dueAtIso: null,
        due: true,
        megaDrawId: megaDrawIdForDate(now),
        carry,
      };

  scheduleCache = { value, at: Date.now() };
  return value;
}

/** Would this cached answer flip from "not due" to "due" if it were recomputed now? */
function dueChanged(value: MegaPrizeSchedule, now: Date): boolean {
  if (value.due || !value.dueAtIso) return false;
  return now.getTime() >= Date.parse(value.dueAtIso);
}

function scheduleAfter(last: LastDraw, now: Date): MegaPrizeSchedule {
  const periodStart = new Date(last.cutoffMs);

  let boundary = nextQuarterBoundaryUtc(periodStart);
  // Roll a stub period into the next quarter (see MEGA_PRIZE_MIN_PERIOD_DAYS).
  while (boundary.getTime() - periodStart.getTime() < MEGA_PRIZE_MIN_PERIOD_DAYS * DAY_MS) {
    boundary = nextQuarterBoundaryUtc(boundary);
  }

  return {
    first: false,
    periodStartIso: periodStart.toISOString(),
    dueAtIso: boundary.toISOString(),
    due: now.getTime() >= boundary.getTime(),
    megaDrawId: megaDrawIdForBoundary(boundary),
    carry: null,
  };
}
