/**
 * Daily pool guarantee (free stage) — the whole daily draw's prize pool is held to a published floor.
 *
 * Decision 2026-10-25: below the floor the draw runs on the floor, not on what the tickets brought
 * in. The top-up is `floor − natural pool` and it goes through the normal settlement formula like
 * any other pool GIFT — every share (Grand Prize, Mega Prize, referral, company 10%, burn) is taken
 * from the topped-up pool, and `avgGift` rises with it, so prize tickets are worth more too. Those
 * tickets replay the next day, which is what shrinks the next day's top-up. Once the natural pool
 * reaches the floor the top-up is 0. Only the OPS network-fee charge stays on the natural pool: it
 * repays real SOL the sponsor spent on the players' own tickets, not on the guarantee.
 *
 * Where the money comes from: the airdrop allocation. Winners' rows grow by their share of the
 * top-up, and the snapshot takes it out of what nobody won and then out of unverified players'
 * winnings — never out of the ledger's Mega Prize pot (unlock-snapshot.ts). What is left of both
 * goes into the Mega Prize row, as before. A day costs at most the floor itself.
 *
 * Changing the floor (owner, 2026-10-25): every change — raise, decrease, switching it off — starts
 * with the NEXT draw. Today's draw keeps the number its players bought under, in both directions.
 * Stored as dated steps so a draw that settles late still reads the floor it ran under.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseService } from './cnft-tree.js';
import { cfgKey, IS_AIRDROP_STAGE, STAGE } from './stage.js';

const KEY = cfgKey('daily_pool_floor_steps');

export type PoolFloorStep = {
  /** First draw (YYYYMMDD) the floor applies to. */
  fromDrawId: string;
  gift: number;
};

const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

const dayOf = (drawId: string): string => String(drawId || '').trim().slice(0, 8);

const isDayId = (id: string): boolean => /^\d{8}$/.test(id);

export function parsePoolFloorSteps(raw: unknown): PoolFloorStep[] {
  let arr: unknown = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const steps: PoolFloorStep[] = [];
  for (const s of arr as { fromDrawId?: unknown; gift?: unknown }[]) {
    const fromDrawId = dayOf(String(s?.fromDrawId ?? ''));
    const gift = Number(s?.gift);
    if (!isDayId(fromDrawId) || !Number.isFinite(gift) || gift < 0) continue;
    steps.push({ fromDrawId, gift: round8(gift) });
  }
  return steps.sort((a, b) => a.fromDrawId.localeCompare(b.fromDrawId));
}

/** The floor in force for a draw: the latest step that started on or before it. */
export function poolFloorForDraw(steps: PoolFloorStep[], drawId: string): number {
  const day = dayOf(drawId);
  let gift = 0;
  for (const s of steps) {
    if (s.fromDrawId <= day) gift = s.gift;
  }
  return gift;
}

/** The day after a YYYYMMDD id, in the same shape. */
export function nextDayDrawId(drawId: string): string {
  const day = dayOf(drawId);
  if (!isDayId(day)) throw new Error(`Not a daily draw id: ${drawId}`);
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getPoolFloorSteps(supabase: SupabaseClient | null = getSupabaseService()): Promise<PoolFloorStep[]> {
  if (!IS_AIRDROP_STAGE || !supabase) return [];
  const { data, error } = await supabase.from('admin_runtime_config').select('value').eq('key', KEY).maybeSingle();
  if (error) throw new Error(`daily pool floor: ${error.message}`);
  return parsePoolFloorSteps((data as { value?: unknown } | null)?.value);
}

/**
 * Floor of one draw's pool. Free stage only — the paid draw vault caps payouts at what was really
 * deposited, so a paid guarantee needs its own funding path (not built). Throws on a read error:
 * a settlement must not quietly run without a floor it promised.
 */
export async function getDailyPoolFloorForDraw(drawId: string, supabase?: SupabaseClient | null): Promise<number> {
  if (!IS_AIRDROP_STAGE) return 0;
  return poolFloorForDraw(await getPoolFloorSteps(supabase ?? getSupabaseService()), drawId);
}

/** The same, for display: a read error shows no guarantee rather than failing the draw card. */
export async function getDailyPoolDisplayFloor(drawId: string, supabase?: SupabaseClient | null): Promise<number> {
  try {
    return await getDailyPoolFloorForDraw(drawId, supabase);
  } catch (e) {
    console.error('getDailyPoolDisplayFloor', e instanceof Error ? e.message : e);
    return 0;
  }
}

export type PoolFloorAdminView = {
  /** Floor of the draw running now. */
  currentGift: number;
  /** A change already set for a later draw (it waits for tomorrow), if any. */
  next: PoolFloorStep | null;
};

export function poolFloorAdminView(steps: PoolFloorStep[], currentDrawId: string): PoolFloorAdminView {
  const day = dayOf(currentDrawId);
  return {
    currentGift: poolFloorForDraw(steps, day),
    next: steps.find((s) => s.fromDrawId > day) ?? null,
  };
}

export async function setDailyPoolFloor(input: {
  gift: number;
  currentDrawId: string;
  updatedByTelegramId: string | number;
}): Promise<PoolFloorAdminView & { fromDrawId: string }> {
  if (!IS_AIRDROP_STAGE) throw new Error('The daily pool guarantee is free-stage only');
  const supabase = getSupabaseService();
  if (!supabase) throw new Error('Supabase service role is not configured');
  const gift = round8(Number(input.gift));
  if (!Number.isFinite(gift) || gift < 0) throw new Error('Guarantee must be a non-negative number');
  const current = dayOf(input.currentDrawId);
  if (!isDayId(current)) throw new Error(`Not a daily draw id: ${input.currentDrawId}`);

  // A floor makes settlement write pool_floor_gift / pool_topup_gift: without the columns every
  // guaranteed draw would fail to settle, so refuse here instead.
  if (gift > 0) {
    const probe = await supabase.from('draw_settlements').select('pool_topup_gift').limit(1);
    if (probe.error) throw new Error('Run database_daily_pool_floor.sql first: ' + probe.error.message);
  }

  const steps = await getPoolFloorSteps(supabase);
  const inForce = poolFloorForDraw(steps, current);
  const fromDrawId = nextDayDrawId(current);
  // The new step replaces anything set for the same day or later — one pending change at most.
  const kept = steps.filter((s) => s.fromDrawId < fromDrawId);
  const next = [...kept, { fromDrawId, gift }];

  const updatedBy = Number(input.updatedByTelegramId);
  const { error } = await supabase.from('admin_runtime_config').upsert(
    {
      key: KEY,
      value: JSON.stringify(next),
      updated_at: new Date().toISOString(),
      updated_by_telegram_id: Number.isFinite(updatedBy) ? Math.floor(updatedBy) : null,
    },
    { onConflict: 'key' }
  );
  if (error) throw new Error(`daily pool floor: ${error.message}`);

  await supabase.from('admin_audit_logs').insert({
    telegram_id: Number.isFinite(updatedBy) ? Math.floor(updatedBy) : null,
    action: 'daily_pool_floor_set',
    target: `daily_pool_floor:${STAGE}`,
    metadata: { gift, fromDrawId, previousGift: inForce },
  });

  return { ...poolFloorAdminView(next, current), fromDrawId };
}
