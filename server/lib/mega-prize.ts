/**
 * Mega Prize — one winner-takes-all pot, drawn at the end of the unlock stage and quarterly after.
 *
 * Money model:
 *   Every settled draw carves `MEGA_PRIZE_RATE` (5%) out of its prize pool into the pot,
 *   next to company 10% / burn 1% / referral 5% / ops. That 5% is deducted from the winner
 *   pool — the daily winners split slightly less so one participant eventually takes
 *   everything. Nothing is ever paid out of the pot per daily draw: it only grows until a Mega
 *   Prize draw empties it, and then it starts again from zero for the next quarter. Every figure
 *   below is therefore scoped to the CURRENT period — the accrual since the last draw's cutoff.
 *   The schedule that defines those cutoffs lives in mega-prize-schedule.ts.
 *
 * Why the total is NOT scoped to `stage`:
 *   Every other counter in this codebase is per-stage, because the free and paid versions
 *   are separate games sharing one database. The Mega Prize is the deliberate exception:
 *   the pot starts filling on the airdrop stage and keeps filling on the paid stage, and
 *   the single draw happens at the end of the unlock stage — after both. Scoping it per
 *   stage would tell airdrop players their contribution disappears at TGE, which is the
 *   opposite of the promise. See database_mega_prize.sql.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './tickets-paginated.js';
import { getMegaGuaranteeGift } from './announced-draws.js';
import { IS_PAID_STAGE } from './stage.js';
import { resolveMegaPrizeSchedule, type MegaPrizeSchedule } from './mega-prize-schedule.js';

/** Share of each draw's prize pool routed to the Mega Prize pot. */
export const MEGA_PRIZE_RATE = 0.05;

/**
 * Which purchases buy a place in the Mega Prize draw.
 *
 * One qualifying ticket = one entry, all entries equal. Free play does NOT enter: the pot is
 * funded by the airdrop, but only bought tickets play for it.
 *
 * USDC only for the first draw. GIFT-bought tickets join from the second draw on — after the
 * unlock stage, once GIFT is a liquid asset people paid for rather than one they were given.
 * `playdollar` never qualifies (it is not money). SOL is listed in the old
 * `chk_tickets_purchase_currency` constraint but has never been a way to buy a ticket.
 */
export const MEGA_PRIZE_ELIGIBLE_CURRENCIES: readonly string[] = ['usdc'];

/** Set used from the second draw on, once GIFT is something people bought rather than received. */
export const MEGA_PRIZE_ELIGIBLE_CURRENCIES_AFTER_UNLOCK: readonly string[] = ['usdc', 'gift'];

/**
 * Which currencies qualify right now — resolved from state, never toggled by hand.
 *
 * The switch is "has a Mega Prize draw already completed?". That is exactly the intended
 * condition: the first draw can only run once the unlock ledger is fully released, so a
 * completed draw existing IS the proof that unlock finished. No date, no flag, no env var
 * that someone has to remember to flip.
 *
 * Fails closed to USDC-only: if the check errors, the narrower rule applies rather than
 * silently admitting tickets that should not qualify yet.
 *
 * Memoised per warm instance: the answer flips exactly ONCE in the project's life (the first
 * Mega Prize draw completing), so re-counting it on every caller's request buys nothing. This
 * sits on the personal path (`?action=my-mega-entries`), which by definition cannot be cached
 * at the edge — cutting a query out of it here is the cheapest scaling win available.
 */
let currenciesCache: { value: readonly string[]; at: number } | null = null;
/** Short enough that the one-time flip lands within minutes, long enough to collapse a burst. */
const CURRENCIES_CACHE_MS = 5 * 60 * 1000;

export async function resolveMegaPrizeCurrencies(
  supabase: SupabaseClient
): Promise<readonly string[]> {
  const cached = currenciesCache;
  if (cached && Date.now() - cached.at < CURRENCIES_CACHE_MS) return cached.value;
  try {
    const { count, error } = await supabase
      .from('mega_prize_draws')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed');
    if (error) {
      // Not cached: a failed read must not pin the narrow rule in memory for five minutes.
      console.error('resolveMegaPrizeCurrencies', error.message);
      return MEGA_PRIZE_ELIGIBLE_CURRENCIES;
    }
    const value =
      num(count) > 0
        ? MEGA_PRIZE_ELIGIBLE_CURRENCIES_AFTER_UNLOCK
        : MEGA_PRIZE_ELIGIBLE_CURRENCIES;
    currenciesCache = { value, at: Date.now() };
    return value;
  } catch (e: unknown) {
    console.error('resolveMegaPrizeCurrencies', e instanceof Error ? e.message : e);
    return MEGA_PRIZE_ELIGIBLE_CURRENCIES;
  }
}

export type MegaPrizeSnapshot = {
  /** GIFT accumulated since the last Mega Prize draw, across both stages. */
  totalGift: number;
  /**
   * Published floor for the next draw. The pot pays out `max(totalGift, guaranteeGift)`; the
   * difference is covered by the company (see announced-draws.ts). 0 = nothing guaranteed.
   *
   * Shipped to the client so the headline number has ONE source: the emblem, the dialog and the
   * server all take the same maximum instead of each deciding for itself.
   */
  guaranteeGift: number;
  /** Completed draws that have contributed to the CURRENT pot — reset with it after a draw. */
  draws: number;
  /**
   * When the next Mega Prize draw is due, ISO. This is the 00:00 UTC boundary that ENDS the
   * quarter, so the date players are given is the day before it — see `megaNextDrawLabel` on the
   * client, which is the only place that turns this into words.
   *
   * Null before the first draw: that one is gated on the unlock ledger closing, and no honest date
   * can be published for it.
   */
  nextDrawAt: string | null;
  /**
   * Where the current period began, ISO — the previous draw's cutoff. A bought ticket counts toward
   * the next draw only when created at or after it (countMegaPrizeEntries), so the ticket list uses
   * it to drop "Mega entry" from tickets whose draw has already happened. Null = no cutoff yet.
   */
  periodStartAt: string | null;
  /** The 5% headline, so clients never hardcode the rate. */
  rate: number;
  /** Qualifying tickets the signed-in user holds — their entry count. Null when signed out. */
  entries: number | null;
  /** Qualifying tickets across everyone, so the client can show "N of M". */
  totalEntries: number;
  /**
   * Purchase currencies that qualify right now. Sent to the client so the ticket list marks
   * exactly the tickets the server would count — one source of truth, not two.
   */
  eligibleCurrencies: string[];
  /**
   * False when the pot could not be read (migration not applied yet, transient DB error).
   * Clients hide the emblem rather than showing a wrong "0 GIFT" jackpot.
   */
  available: boolean;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const emptySnapshot = (available: boolean): MegaPrizeSnapshot => ({
  totalGift: 0,
  guaranteeGift: 0,
  draws: 0,
  nextDrawAt: null,
  periodStartAt: null,
  rate: MEGA_PRIZE_RATE,
  entries: null,
  totalEntries: 0,
  eligibleCurrencies: [...MEGA_PRIZE_ELIGIBLE_CURRENCIES],
  available,
});

/**
 * Count qualifying tickets — the entry count. One ticket, one entry, no weighting.
 *
 * `anonId = null` counts the whole field. Uses a head count rather than fetching rows: this
 * runs on every home-screen load and the field is the entire purchase history.
 */
export async function countMegaPrizeEntries(
  supabase: SupabaseClient,
  anonId: string | null,
  opts?: { currencies?: readonly string[]; sinceIso?: string | null }
): Promise<number> {
  try {
    let q = supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('stage', 'paid')
      .eq('ticket_origin', 'purchase')
      .in('purchase_currency', [...(opts?.currencies ?? MEGA_PRIZE_ELIGIBLE_CURRENCIES)]);
    // Only the current period plays. A ticket bought before the last Mega Prize draw already had
    // its shot at the pot that draw paid out — leaving it in would let the first quarter's buyers
    // out-weight every quarter after it, forever.
    if (opts?.sinceIso) q = q.gte('created_at', opts.sinceIso);
    if (anonId) q = q.eq('owner_user_id', anonId);

    const { count, error } = await q;
    if (error) {
      console.error('countMegaPrizeEntries', error.message);
      return 0;
    }
    return Math.max(0, Math.trunc(num(count)));
  } catch (e: unknown) {
    console.error('countMegaPrizeEntries', e instanceof Error ? e.message : e);
    return 0;
  }
}

/**
 * Sum `mega_prize_amount` over completed settlements — the pot for ONE period.
 *
 * `sinceIso` is the previous Mega Prize draw's cutoff, and it is what makes the pot reset: after a
 * draw takes the money, the next pot counts only what has accrued since. Without it the same GIFT
 * would be drawn again every time, growing forever and paying out a total the project never
 * carved. Null (no draw has completed yet) means the whole history, which is exactly right for the
 * first draw. Scoped on `completed_at`, not on the draw's own period: a settlement that completes
 * late belongs to the pot that had not been paid out yet when it landed, so every settlement falls
 * into exactly one period with no gap and no overlap.
 *
 * Reads the rows and sums them here rather than asking PostgREST for `mega_prize_amount.sum()`:
 * this project has aggregate functions disabled, so the aggregate select answers
 * `PGRST123 — Use of aggregate functions is not allowed` and the pot silently reads as
 * unavailable. One numeric column per settled draw is a cheap scan, and `fetchAllRows` keeps
 * it correct past the 1000-row page cap once the history grows.
 *
 * Throws on a query error so callers can tell "could not read" from "pot is empty".
 */
export async function sumMegaPrizePot(
  supabase: SupabaseClient,
  opts?: { stage?: 'airdrop' | 'paid'; sinceIso?: string | null }
): Promise<{ totalGift: number; draws: number }> {
  const rows = await fetchAllRows<{ mega_prize_amount: number | string | null }>((from, to) => {
    let q = supabase
      .from('draw_settlements')
      .select('id,mega_prize_amount')
      .eq('status', 'completed');
    if (opts?.stage) q = q.eq('stage', opts.stage);
    if (opts?.sinceIso) q = q.gte('completed_at', opts.sinceIso);
    return q.order('id', { ascending: true }).range(from, to);
  });

  const total = rows.reduce((s, r) => s + num(r.mega_prize_amount), 0);
  return { totalGift: Math.round(total * 1e8) / 1e8, draws: rows.length };
}

/**
 * The pot of the period the schedule names, as the draw will count it: paid settlements only on the
 * paid stage, plus — on the first paid-stage draw — the unlock snapshot's Mega Prize row, which
 * already holds the airdrop's accrual and the forfeited wins (mega-prize-schedule.ts).
 */
async function sumPeriodPot(
  supabase: SupabaseClient,
  schedule: MegaPrizeSchedule
): Promise<{ totalGift: number; draws: number }> {
  const pot = await sumMegaPrizePot(supabase, {
    sinceIso: schedule.periodStartIso,
    stage: IS_PAID_STAGE ? 'paid' : undefined,
  });
  const carry = schedule.carry ? schedule.carry.amountGift : 0;
  return { totalGift: Math.round((pot.totalGift + carry) * 1e8) / 1e8, draws: pot.draws };
}

/**
 * How stale the cached totals may get before this is worth complaining about in the logs.
 *
 * NOT a trigger to recompute. It used to be, and that is a stampede waiting to happen: the moment
 * the roll-flush cron falls three runs behind, EVERY reader starts summing every settlement and
 * counting the entire purchase history — the load spikes exactly when the system is already
 * unhealthy. A stale figure is also barely stale in practice: `total_gift` only moves when a draw
 * settles, and settlement rides the same cron, so a cron that is not running is a pot that is not
 * growing either.
 */
const MEGA_PRIZE_TOTALS_MAX_AGE_MS = 30 * 60 * 1000;

type MegaPrizeTotals = { totalGift: number; draws: number; totalEntries: number };

/**
 * Last full recompute, held per warm instance — written by both the cron refresh and the reader's
 * live fallback, since they compute the same three figures the same way.
 *
 * The fallback only runs while `mega_prize_totals` has never been written: a window that closes on
 * the first cron run, but which every single reader would otherwise spend scanning the settlement
 * history and the whole purchase history. This bounds it to one scan per instance per window,
 * whatever the traffic.
 */
let liveTotalsCache: { value: MegaPrizeTotals; at: number } | null = null;

/**
 * One cached row per deployment: 1 = airdrop (free), 2 = paid (database_mega_prize_totals_per_stage.sql).
 *
 * Both deployments run the roll-flush cron against the one shared database, and they count
 * different pots — the paid one adds the unlock snapshot's Mega row and reads paid settlements
 * only. On a single row each overwrote the other every five minutes, and the paid home screen
 * flipped between the two figures. Until the migration allows id 2, the paid refresh fails and its
 * readers take the live path, which is correct, only slower.
 */
const MEGA_PRIZE_TOTALS_ROW_ID = IS_PAID_STAGE ? 2 : 1;
const LIVE_TOTALS_CACHE_MS = 5 * 60 * 1000;

/**
 * Recompute the pot and the entry total from source and store them.
 *
 * Rides the roll-flush cron. Every call is a full recompute, never an increment, so this cannot
 * drift the way a counter would — see database_mega_prize_totals.sql for why that mattered enough
 * to pay for a periodic scan instead of a trigger on `tickets`.
 */
export async function refreshMegaPrizeTotals(supabase: SupabaseClient): Promise<MegaPrizeTotals> {
  const schedule = await resolveMegaPrizeSchedule(supabase);
  const { periodStartIso } = schedule;
  const { totalGift, draws } = await sumPeriodPot(supabase, schedule);
  const currencies = await resolveMegaPrizeCurrencies(supabase);
  const totalEntries = await countMegaPrizeEntries(supabase, null, {
    currencies,
    sinceIso: periodStartIso,
  });

  const { error } = await supabase.from('mega_prize_totals').upsert(
    {
      id: MEGA_PRIZE_TOTALS_ROW_ID,
      total_gift: totalGift,
      draws,
      total_entries: totalEntries,
      computed_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(error.message);

  // This instance just did the scan — hand the result to its own live path too, so a reader
  // sharing the process never repeats it.
  liveTotalsCache = { value: { totalGift, draws, totalEntries }, at: Date.now() };
  return { totalGift, draws, totalEntries };
}

/**
 * The cached totals with their age, or null when the row carries nothing usable — table missing
 * (migration not run yet), row absent, or never recomputed. Age is reported, not judged: what to
 * do about a stale row is `getMegaPrizeSnapshot`'s call, and the answer is "use it anyway".
 */
async function readMegaPrizeTotals(
  supabase: SupabaseClient
): Promise<(MegaPrizeTotals & { ageMs: number }) | null> {
  try {
    const { data, error } = await supabase
      .from('mega_prize_totals')
      .select('total_gift,draws,total_entries,computed_at')
      .eq('id', MEGA_PRIZE_TOTALS_ROW_ID)
      .maybeSingle();
    if (error || !data) return null;

    const totalGift = num(data.total_gift);
    const draws = Math.max(0, Math.trunc(num(data.draws)));
    const totalEntries = Math.max(0, Math.trunc(num(data.total_entries)));

    const computedAt = Date.parse(String(data.computed_at ?? ''));
    // The seeded row is all zeroes at `computed_at = 'epoch'` — it exists so the first read finds
    // something, but it has never been recomputed and publishing it would show an empty pot. Read
    // as "absent" so the live path fills in until the cron lands.
    //
    // The timestamp is what separates "never written" from "written and genuinely zero", and that
    // distinction became load-bearing when the pot started resetting: the hours right after a draw
    // are a real, recomputed, all-zero pot. Judging by the figures alone would send every reader
    // down the live-recompute path for the whole of that window.
    const neverWritten = !Number.isFinite(computedAt) || computedAt <= 0;
    if (neverWritten && totalGift === 0 && draws === 0 && totalEntries === 0) return null;
    return {
      totalGift,
      draws,
      totalEntries,
      // An unreadable timestamp is "unknown age", not "fresh" — it only affects the log line.
      ageMs: Number.isFinite(computedAt) ? Date.now() - computedAt : Number.POSITIVE_INFINITY,
    };
  } catch {
    return null;
  }
}

/** The reader's fallback for a `mega_prize_totals` row that has never been written. */
async function computeMegaPrizeTotalsLive(
  supabase: SupabaseClient,
  schedule: MegaPrizeSchedule
): Promise<MegaPrizeTotals> {
  const cached = liveTotalsCache;
  if (cached && Date.now() - cached.at < LIVE_TOTALS_CACHE_MS) return cached.value;

  const { totalGift, draws } = await sumPeriodPot(supabase, schedule);
  const currencies = await resolveMegaPrizeCurrencies(supabase);
  const totalEntries = await countMegaPrizeEntries(supabase, null, {
    currencies,
    sinceIso: schedule.periodStartIso,
  });
  const value = { totalGift, draws, totalEntries };
  liveTotalsCache = { value, at: Date.now() };
  return value;
}

/**
 * Accumulated pot, read on every home-screen load.
 *
 * The two figures that do not depend on the caller are a single-row lookup into `mega_prize_totals`
 * — used however old the row is, because the reader's job is to read (see
 * MEGA_PRIZE_TOTALS_MAX_AGE_MS). Only a row that has never been written falls back to computing
 * from source, and that path is memoised. `entries` is the caller's own count and is always live:
 * it is a single-user count on a covering index, and only the personal endpoint asks for it.
 *
 * Fail-soft: a missing `mega_prize_amount` column (migration pending) or a transient error
 * returns `available: false` instead of throwing, so the draw card still renders.
 */
export async function getMegaPrizeSnapshot(
  supabase: SupabaseClient,
  opts?: { anonId?: string | null }
): Promise<MegaPrizeSnapshot> {
  try {
    // One read, two answers: which period the pot belongs to, and when it is drawn. Both are
    // cached per instance — this is on the home-screen path.
    const schedule = await resolveMegaPrizeSchedule(supabase);
    const cached = await readMegaPrizeTotals(supabase);
    if (cached && cached.ageMs > MEGA_PRIZE_TOTALS_MAX_AGE_MS) {
      // Worth a line in the logs, not a recompute: at this age the roll-flush cron has missed
      // three runs, which is a cron problem to fix rather than a load to pile onto readers.
      console.warn(
        `getMegaPrizeSnapshot: mega_prize_totals is ${Math.round(cached.ageMs / 60000)}min old — is the roll-flush cron running?`
      );
    }
    const totals = cached ?? (await computeMegaPrizeTotalsLive(supabase, schedule));
    const { totalGift, draws } = totals;

    // Entry counts are their own queries and each fails soft to 0 — a broken counter must not
    // take the pot down with it.
    const anonId = opts?.anonId ?? null;
    const currencies = await resolveMegaPrizeCurrencies(supabase);
    const [totalEntries, entries, guaranteeGift] = await Promise.all([
      Promise.resolve(totals.totalEntries),
      // Same period bound as the global count above — otherwise a player would read their own
      // "47 entries" against a field counted since the last draw, and the two would disagree.
      anonId
        ? countMegaPrizeEntries(supabase, anonId, {
            currencies,
            sinceIso: schedule.periodStartIso,
          })
        : Promise.resolve(null),
      // Fails soft to 0 (no guarantee) rather than taking the pot down: showing the raw
      // accumulated total is the conservative direction — it never over-promises.
      getMegaGuaranteeGift(supabase).catch(() => 0),
    ]);

    return {
      totalGift,
      guaranteeGift,
      draws,
      nextDrawAt: schedule.dueAtIso,
      periodStartAt: schedule.periodStartIso,
      rate: MEGA_PRIZE_RATE,
      entries,
      totalEntries,
      eligibleCurrencies: [...currencies],
      available: true,
    };
  } catch (e: unknown) {
    console.error('getMegaPrizeSnapshot', e instanceof Error ? e.message : e);
    return emptySnapshot(false);
  }
}

/**
 * Airdrop-stage share of the pot — the only part that is ever locked.
 *
 * Paid-stage GIFT is claimable the moment it is settled, so it needs no unlock entry. The
 * airdrop share is GIFT the project still owes, exactly like a prize row, and it enters the
 * lock ledger as the third and last tier (see database_mega_prize_unlock.sql).
 *
 * Returns null (not 0) when the figure can't be read, so callers can skip the lock write
 * instead of shrinking the ledger row to zero on a transient error.
 *
 * Deliberately NOT period-scoped, unlike the pot the emblem shows: this runs during the airdrop
 * stage, before any Mega Prize draw has happened, and it is the whole airdrop-stage debt that
 * belongs in the ledger — not a slice of it.
 */
export async function getAirdropMegaPrizePot(supabase: SupabaseClient): Promise<number | null> {
  try {
    const { totalGift } = await sumMegaPrizePot(supabase, { stage: 'airdrop' });
    return totalGift;
  } catch (e: unknown) {
    console.error('getAirdropMegaPrizePot', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Mirror the airdrop-stage pot into the lock ledger.
 *
 * Cumulative, not additive — `set_lock_mega_prize` stores the passed total, so re-running a
 * settlement cannot double-count. Fail-soft: the Mega Prize is not drawn until every entry is
 * released anyway, so a skipped sync delays the draw rather than mispaying anyone.
 */
export async function syncMegaPrizeLock(
  supabase: SupabaseClient
): Promise<{ synced: boolean; amount: number | null }> {
  const amount = await getAirdropMegaPrizePot(supabase);
  if (amount == null) return { synced: false, amount: null };

  const { error } = await supabase.rpc('set_lock_mega_prize', { p_amount: amount });
  if (error) {
    console.error('set_lock_mega_prize', error.message);
    return { synced: false, amount };
  }
  return { synced: true, amount };
}
