/**
 * Mega Prize — one winner-takes-all pot, drawn once at the end of the unlock stage.
 *
 * Money model:
 *   Every settled draw carves `MEGA_PRIZE_RATE` (5%) out of its prize pool into the pot,
 *   next to company 10% / burn 1% / referral 5% / ops. That 5% is deducted from the winner
 *   pool — the daily winners split slightly less so one participant eventually takes
 *   everything. Nothing is ever paid out of the pot per draw; it only grows.
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
 */
export async function resolveMegaPrizeCurrencies(
  supabase: SupabaseClient
): Promise<readonly string[]> {
  try {
    const { count, error } = await supabase
      .from('mega_prize_draws')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed');
    if (error) {
      console.error('resolveMegaPrizeCurrencies', error.message);
      return MEGA_PRIZE_ELIGIBLE_CURRENCIES;
    }
    return num(count) > 0
      ? MEGA_PRIZE_ELIGIBLE_CURRENCIES_AFTER_UNLOCK
      : MEGA_PRIZE_ELIGIBLE_CURRENCIES;
  } catch (e: unknown) {
    console.error('resolveMegaPrizeCurrencies', e instanceof Error ? e.message : e);
    return MEGA_PRIZE_ELIGIBLE_CURRENCIES;
  }
}

export type MegaPrizeSnapshot = {
  /** GIFT accumulated across every completed settlement, both stages. */
  totalGift: number;
  /** Completed draws that have contributed to the pot. */
  draws: number;
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
  draws: 0,
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
  opts?: { currencies?: readonly string[] }
): Promise<number> {
  try {
    let q = supabase
      .from('tickets')
      .select('id', { count: 'exact', head: true })
      .eq('stage', 'paid')
      .eq('ticket_origin', 'purchase')
      .in('purchase_currency', [...(opts?.currencies ?? MEGA_PRIZE_ELIGIBLE_CURRENCIES)]);
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
 * Accumulated pot. Uses PostgREST aggregates (one row back) instead of paging every
 * settlement row — this is read on every home-screen load.
 *
 * Fail-soft: a missing `mega_prize_amount` column (migration pending) or a transient error
 * returns `available: false` instead of throwing, so the draw card still renders.
 */
export async function getMegaPrizeSnapshot(
  supabase: SupabaseClient,
  opts?: { anonId?: string | null }
): Promise<MegaPrizeSnapshot> {
  try {
    // Two independent queries on purpose: folding the count into the aggregate select would
    // make one malformed expression drop the sum too, and the emblem would vanish with no
    // visible error. The count is cosmetic — the pot total is not.
    const [sumRes, countRes] = await Promise.all([
      supabase
        .from('draw_settlements')
        .select('mega_prize_amount.sum()')
        .eq('status', 'completed')
        .maybeSingle(),
      supabase
        .from('draw_settlements')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'completed'),
    ]);

    if (sumRes.error) {
      console.error('getMegaPrizeSnapshot sum', sumRes.error.message);
      return emptySnapshot(false);
    }

    const row = (sumRes.data ?? {}) as Record<string, unknown>;
    const totalGift = Math.round(num(row.sum) * 1e8) / 1e8;
    // A failed count is survivable: show the pot, drop the "collected from N draws" line.
    const draws = countRes.error ? 0 : Math.max(0, Math.trunc(num(countRes.count)));

    // Entry counts are their own queries and each fails soft to 0 — a broken counter must not
    // take the pot down with it.
    const anonId = opts?.anonId ?? null;
    const currencies = await resolveMegaPrizeCurrencies(supabase);
    const [totalEntries, entries] = await Promise.all([
      countMegaPrizeEntries(supabase, null, { currencies }),
      anonId ? countMegaPrizeEntries(supabase, anonId, { currencies }) : Promise.resolve(null),
    ]);

    return {
      totalGift,
      draws,
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
 */
export async function getAirdropMegaPrizePot(supabase: SupabaseClient): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('draw_settlements')
      .select('mega_prize_amount.sum()')
      .eq('status', 'completed')
      .eq('stage', 'airdrop')
      .maybeSingle();
    if (error) {
      console.error('getAirdropMegaPrizePot', error.message);
      return null;
    }
    const row = (data ?? {}) as Record<string, unknown>;
    return Math.round(num(row.sum) * 1e8) / 1e8;
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
