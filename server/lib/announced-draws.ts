/**
 * Announced draws — the public record of "this draw pays out, and here is its floor".
 *
 * Two things live here, and they are the same thing seen from different angles:
 *
 *   1. A SCHEDULED payout. The daily Grand Prize normally fires on its own 1/30 roll. An announced
 *      draw fires unconditionally — we pick the date and say so in advance. That is only fair
 *      because it is published beforehand: *when* stops being derivable from the seed, so the
 *      announcement itself is what keeps it honest. *Who* wins is untouched — still drawn from the
 *      committed settlement seed.
 *
 *   2. A GUARANTEED minimum. If the accumulated pot is below the announced floor, the company tops
 *      it up to that floor. The top-up is funded from the company share, NOT out of the prize pool:
 *      the pool accumulates exactly as before and the shortfall is booked per draw as an obligation
 *      (see treasury-locks.ts). A guarantee only ever applies to an announced draw — announcing is
 *      what makes it a promise rather than a number chosen after the fact.
 *
 * Why the Mega Prize is stored differently:
 *   Its draw id cannot be known in advance. `MEGA-YYYYMMDD` is derived from the day the unlock
 *   ledger finishes releasing, so there is no slot to bind a guarantee to. Its announcement is a
 *   single row with draw_id '*' ("the next Mega Prize draw"), protected by a different rule: the
 *   amount may only ever be RAISED. With that rule the publication date stops mattering — whatever
 *   is in force at draw time is at least what was published on any earlier day.
 *
 * Migration safety: every read falls back to the legacy `airdrop_final_draw_id` config key when
 * `announced_draws` is missing, so deploying this before running database_announced_draws.sql
 * leaves the airdrop finale working exactly as it did. Writes fail loudly instead — a silently
 * dropped announcement is far worse than an error message in the admin panel.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseService } from './cnft-tree.js';
import { cfgKey, IS_AIRDROP_STAGE, STAGE } from './stage.js';

/**
 * Stand-in draw id for an announcement that has no date yet — "whichever draw comes next".
 *
 * Used by both prize types, for the same reason in slightly different shapes: the Mega Prize never
 * gets a date in advance, and the free stage's Grand Prize finale gets one only once the end of the
 * airdrop is fixed. In both cases the *amount* can be promised long before the *date* — and the
 * promise is what players plan around. A standing row is protected by the raise-only rule instead
 * of by being bound to a draw.
 */
export const STANDING_DRAW_ID = '*';

/** Back-compat alias — the Mega Prize announcement is always the standing one. */
export const MEGA_ANNOUNCEMENT_DRAW_ID = STANDING_DRAW_ID;

/** Legacy single-key storage for the airdrop finale, kept as a read fallback. */
const LEGACY_FINAL_DRAW_KEY = cfgKey('airdrop_final_draw_id');

export type AnnouncedScope = 'daily' | 'mega';

export type AnnouncedDraw = {
  scope: AnnouncedScope;
  drawId: string;
  /** Promised floor in GIFT. 0 means "announced, but nothing guaranteed". */
  guaranteeGift: number;
  /** Internal 0/1/2 → 1/2/3 jackpot winners. Null leaves the seed-rolled split alone. */
  jackpotSplitMode: number | null;
  /** Sweep every still-held ticket into this draw before it closes. */
  autoEnter: boolean;
  announcedAt: string | null;
};

const isAuditEnabled = (): boolean => {
  const raw = String(process.env.ENABLE_ADMIN_AUDIT_LOG || 'true').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const round8 = (n: number): number => Math.round(n * 1e8) / 1e8;

/** Today in the same YYYYMMDD shape draw ids use, so a guarantee cannot be set on a past draw. */
const todayDrawId = (now: Date = new Date()): string => {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

type Row = {
  draw_id?: string | null;
  guarantee_gift?: number | string | null;
  jackpot_split_mode?: number | null;
  auto_enter?: boolean | null;
  announced_at?: string | null;
};

const toAnnounced = (scope: AnnouncedScope, r: Row): AnnouncedDraw => ({
  scope,
  drawId: String(r.draw_id ?? '').trim(),
  guaranteeGift: round8(num(r.guarantee_gift)),
  jackpotSplitMode:
    r.jackpot_split_mode == null || !Number.isFinite(Number(r.jackpot_split_mode))
      ? null
      : Math.trunc(Number(r.jackpot_split_mode)),
  autoEnter: r.auto_enter === true,
  announcedAt: r.announced_at != null ? String(r.announced_at) : null,
});

/**
 * Read this stage's announcements of one scope.
 *
 * Returns null — not [] — when the table cannot be read, so callers can tell "nothing announced"
 * from "the migration has not been run yet" and fall back instead of silently unscheduling a draw.
 */
async function readRows(
  db: SupabaseClient | null,
  scope: AnnouncedScope
): Promise<AnnouncedDraw[] | null> {
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('announced_draws')
      .select('draw_id,guarantee_gift,jackpot_split_mode,auto_enter,announced_at')
      .eq('stage', STAGE)
      .eq('scope', scope);
    if (error) return null;
    return (data as Row[] | null)?.map((r) => toAnnounced(scope, r)) ?? [];
  } catch {
    return null;
  }
}

/** The legacy key, read only where it ever existed (airdrop stage, bare name). */
async function legacyFinalDrawId(db: SupabaseClient | null): Promise<string | null> {
  if (!db || !IS_AIRDROP_STAGE) return null;
  try {
    const { data } = await db
      .from('admin_runtime_config')
      .select('value')
      .eq('key', LEGACY_FINAL_DRAW_KEY)
      .maybeSingle();
    const v = data?.value != null ? String(data.value).trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

/**
 * What the legacy finale looked like as an announcement: three-way split, auto-entry on, no
 * guarantee (guarantees did not exist when that key was written).
 */
const legacyAsAnnounced = (drawId: string): AnnouncedDraw => ({
  scope: 'daily',
  drawId,
  guaranteeGift: 0,
  jackpotSplitMode: 2,
  autoEnter: true,
  announcedAt: null,
});

/**
 * Every announced daily draw of this stage, newest id first.
 *
 * Excludes the standing row — it is a promised amount, not a scheduled draw, and listing it as one
 * would put a `*` in every date picker and history view.
 */
export async function listAnnouncedDailyDraws(
  supabase?: SupabaseClient | null
): Promise<AnnouncedDraw[]> {
  const db = supabase ?? getSupabaseService();
  const rows = await readRows(db, 'daily');
  if (rows) {
    return rows
      .filter((r) => r.drawId !== STANDING_DRAW_ID)
      .sort((a, b) => b.drawId.localeCompare(a.drawId));
  }
  const legacy = await legacyFinalDrawId(db);
  return legacy ? [legacyAsAnnounced(legacy)] : [];
}

/**
 * The Grand Prize floor promised without a date yet (free stage). 0 when none.
 *
 * The finale's date is announced when the end of the airdrop is fixed; the amount is promised
 * earlier, because that is the number players are deciding to play for.
 */
export async function getStandingGrandPrizeGuarantee(
  supabase?: SupabaseClient | null
): Promise<number> {
  const db = supabase ?? getSupabaseService();
  const rows = await readRows(db, 'daily');
  if (!rows) return 0;
  return rows.find((r) => r.drawId === STANDING_DRAW_ID)?.guaranteeGift ?? 0;
}

/**
 * The floor that applies when `drawId` settles.
 *
 * In the free stage the standing promise counts too: the pot pays out exactly once, in the
 * announced closing draw, so a floor promised before that date was picked still binds it. Taking
 * the larger of the two means naming a date can never quietly reduce what was already promised.
 */
export async function guaranteeForDraw(
  drawId: string,
  supabase?: SupabaseClient | null
): Promise<number> {
  const db = supabase ?? getSupabaseService();
  const announced = await getAnnouncedDailyDraw(drawId, db);
  const own = announced?.guaranteeGift ?? 0;
  if (!IS_AIRDROP_STAGE || !announced) return own;
  return Math.max(own, await getStandingGrandPrizeGuarantee(db));
}

/**
 * The announcement covering `drawId`, or null for an ordinary draw.
 *
 * A non-null result means the jackpot pays out in this draw regardless of the 1/30 roll.
 */
export async function getAnnouncedDailyDraw(
  drawId: string,
  supabase?: SupabaseClient | null
): Promise<AnnouncedDraw | null> {
  const id = String(drawId || '').trim();
  if (!id) return null;
  const db = supabase ?? getSupabaseService();
  const rows = await readRows(db, 'daily');
  if (rows) return rows.find((r) => r.drawId === id) ?? null;
  const legacy = await legacyFinalDrawId(db);
  return legacy && legacy === id ? legacyAsAnnounced(legacy) : null;
}

/**
 * The draw the auto-entry sweep fills, or null when none is announced.
 *
 * Only one draw can carry auto-entry at a time — sweeping tickets into two different draws would
 * make each of them consume the other's field.
 */
export async function getAutoEnterDrawId(
  supabase?: SupabaseClient | null
): Promise<string | null> {
  const db = supabase ?? getSupabaseService();
  const rows = await readRows(db, 'daily');
  if (rows) {
    const hit = rows.find((r) => r.autoEnter && r.drawId);
    return hit ? hit.drawId : null;
  }
  return legacyFinalDrawId(db);
}

/**
 * The Grand Prize floor to display against the pot right now. 0 when nothing is guaranteed.
 *
 * The two stages need different answers, because their counters mean different things:
 *
 *   - **airdrop**: the jackpot never fires on the roll. It accumulates all stage long and pays out
 *     once, in the announced closing draw — so the figure on the home screen already IS that
 *     draw's future payout. Its floor is therefore in force from the moment it is announced, which
 *     is the whole point of announcing it early.
 *   - **paid**: the pot can hit any day on its own 1/30. A floor announced for some later draw must
 *     not dress up today's counter, so only the active draw's own announcement counts.
 */
export async function getGrandPrizeDisplayGuarantee(
  activeDrawId: string,
  supabase?: SupabaseClient | null
): Promise<number> {
  const db = supabase ?? getSupabaseService();
  if (!IS_AIRDROP_STAGE) {
    const announced = await getAnnouncedDailyDraw(activeDrawId, db);
    return announced?.guaranteeGift ?? 0;
  }
  const [rows, standing] = await Promise.all([
    listAnnouncedDailyDraws(db),
    getStandingGrandPrizeGuarantee(db),
  ]);
  // The closing draw is the one carrying auto-entry; failing that, the soonest announced draw.
  // Either way the standing promise counts — it applies before any date has been picked.
  const closing =
    rows.find((r) => r.autoEnter) ?? [...rows].sort((a, b) => a.drawId.localeCompare(b.drawId))[0];
  return Math.max(standing, closing?.guaranteeGift ?? 0);
}

/** The floor in force for the next Mega Prize draw. 0 when nothing is guaranteed. */
export async function getMegaGuaranteeGift(
  supabase?: SupabaseClient | null
): Promise<number> {
  const db = supabase ?? getSupabaseService();
  const rows = await readRows(db, 'mega');
  if (!rows) return 0;
  const row = rows.find((r) => r.drawId === STANDING_DRAW_ID) ?? rows[0];
  return row ? row.guaranteeGift : 0;
}

const tableMissing = (msg: string): boolean =>
  /announced_draws/i.test(msg) && /(does not exist|not find|schema cache)/i.test(msg);

const writeError = (msg: string): Error =>
  new Error(
    tableMissing(msg)
      ? 'announced_draws is missing — run database_announced_draws.sql first'
      : msg
  );

const auditTelegramId = (raw: string | number): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

async function writeAudit(
  db: SupabaseClient,
  telegramId: number | null,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  if (!isAuditEnabled()) return;
  await db.from('admin_audit_logs').insert({
    telegram_id: telegramId,
    action,
    target: `announced_draws:${STAGE}`,
    metadata,
  });
}

/**
 * Announce a daily draw, with or without a guaranteed floor.
 *
 * Refuses dates in the past: a draw whose period has closed may already be settled, and moving its
 * guarantee afterwards is exactly the manipulation the public announcement exists to rule out.
 */
export async function setAnnouncedDailyDraw(input: {
  drawId: string;
  guaranteeGift?: number;
  jackpotSplitMode?: number | null;
  autoEnter?: boolean;
  updatedByTelegramId: string | number;
}): Promise<AnnouncedDraw> {
  const supabase = getSupabaseService();
  if (!supabase) throw new Error('Supabase service role is not configured');

  const drawId = String(input.drawId || '').trim();
  if (!/^\d{8}$/.test(drawId)) throw new Error('Draw id must be a YYYYMMDD day id');
  if (drawId < todayDrawId()) {
    throw new Error('That draw is in the past — announce a future draw');
  }

  const guaranteeGift = round8(num(input.guaranteeGift));
  // Same one-way rule the Mega Prize floor has: once a number is published for a draw it may be
  // raised but not quietly walked back. Withdrawing the announcement entirely is still possible
  // (and audit-logged) — this blocks the silent path, where the date stays and the promise shrinks.
  const existing = await getAnnouncedDailyDraw(drawId, supabase);
  if (existing && guaranteeGift < existing.guaranteeGift) {
    throw new Error(
      `A published guarantee can only be raised (currently ${existing.guaranteeGift} GIFT)`
    );
  }
  const splitMode =
    input.jackpotSplitMode == null || !Number.isFinite(Number(input.jackpotSplitMode))
      ? null
      : Math.min(2, Math.max(0, Math.trunc(Number(input.jackpotSplitMode))));
  const autoEnter = input.autoEnter === true;
  const updatedBy = auditTelegramId(input.updatedByTelegramId);

  // Auto-entry is exclusive: hand it to this draw and take it off any other.
  if (autoEnter) {
    const { error } = await supabase
      .from('announced_draws')
      .update({ auto_enter: false, updated_at: new Date().toISOString() })
      .eq('stage', STAGE)
      .eq('scope', 'daily')
      .eq('auto_enter', true)
      .neq('draw_id', drawId);
    if (error) throw writeError(error.message);
  }

  const { error } = await supabase.from('announced_draws').upsert(
    {
      stage: STAGE,
      scope: 'daily',
      draw_id: drawId,
      guarantee_gift: guaranteeGift,
      jackpot_split_mode: splitMode,
      auto_enter: autoEnter,
      updated_at: new Date().toISOString(),
      updated_by_telegram_id: updatedBy,
    },
    { onConflict: 'stage,scope,draw_id' }
  );
  if (error) throw writeError(error.message);

  // Drop the legacy key once the row exists, so the fallback can never resurrect an old date.
  if (IS_AIRDROP_STAGE) {
    await supabase.from('admin_runtime_config').delete().eq('key', LEGACY_FINAL_DRAW_KEY);
  }

  await writeAudit(supabase, updatedBy, 'announced_draw_set', {
    drawId,
    guaranteeGift,
    splitMode,
    autoEnter,
  });

  return {
    scope: 'daily',
    drawId,
    guaranteeGift,
    jackpotSplitMode: splitMode,
    autoEnter,
    announcedAt: new Date().toISOString(),
  };
}

/** Withdraw an announcement. The draw reverts to an ordinary one (1/30 roll, no floor). */
export async function clearAnnouncedDailyDraw(input: {
  drawId: string;
  updatedByTelegramId: string | number;
}): Promise<{ drawId: string }> {
  const supabase = getSupabaseService();
  if (!supabase) throw new Error('Supabase service role is not configured');

  const drawId = String(input.drawId || '').trim();
  if (!drawId) throw new Error('Draw id is required');
  const updatedBy = auditTelegramId(input.updatedByTelegramId);

  const { error } = await supabase
    .from('announced_draws')
    .delete()
    .eq('stage', STAGE)
    .eq('scope', 'daily')
    .eq('draw_id', drawId);
  if (error) throw writeError(error.message);

  if (IS_AIRDROP_STAGE) {
    await supabase.from('admin_runtime_config').delete().eq('key', LEGACY_FINAL_DRAW_KEY);
  }

  await writeAudit(supabase, updatedBy, 'announced_draw_clear', { drawId });
  return { drawId };
}

/**
 * Raise the Mega Prize floor.
 *
 * Only upwards, by design. The Mega Prize has no announceable draw id (see the module header), so
 * "you cannot lower it" is what replaces "you cannot change it after the draw is scheduled": a
 * player who saw a number on any day knows the draw will pay at least that much.
 */
export async function setMegaGuaranteeGift(input: {
  guaranteeGift: number;
  updatedByTelegramId: string | number;
}): Promise<{ guaranteeGift: number; previousGift: number }> {
  return raiseStandingGuarantee('mega', input, 'mega_guarantee_set');
}

/**
 * Raise the Grand Prize floor promised for the finale before its date is known (free stage).
 *
 * Once the date is picked, the announcement for that draw carries its own figure and the larger of
 * the two applies — so naming the date can never walk this promise back.
 */
export async function setStandingGrandPrizeGuarantee(input: {
  guaranteeGift: number;
  updatedByTelegramId: string | number;
}): Promise<{ guaranteeGift: number; previousGift: number }> {
  return raiseStandingGuarantee('daily', input, 'grand_prize_floor_set');
}

/** Shared raise-only write for the dateless announcements of either prize type. */
async function raiseStandingGuarantee(
  scope: AnnouncedScope,
  input: { guaranteeGift: number; updatedByTelegramId: string | number },
  auditAction: string
): Promise<{ guaranteeGift: number; previousGift: number }> {
  const supabase = getSupabaseService();
  if (!supabase) throw new Error('Supabase service role is not configured');

  const next = round8(num(input.guaranteeGift));
  const rows = await readRows(supabase, scope);
  if (!rows) {
    throw new Error('announced_draws is missing — run database_announced_draws.sql first');
  }
  const previousGift = rows.find((r) => r.drawId === STANDING_DRAW_ID)?.guaranteeGift ?? 0;
  if (next < previousGift) {
    throw new Error(`A published guarantee can only be raised (currently ${previousGift} GIFT)`);
  }

  const updatedBy = auditTelegramId(input.updatedByTelegramId);
  const { error } = await supabase.from('announced_draws').upsert(
    {
      stage: STAGE,
      scope,
      draw_id: STANDING_DRAW_ID,
      guarantee_gift: next,
      updated_at: new Date().toISOString(),
      updated_by_telegram_id: updatedBy,
    },
    { onConflict: 'stage,scope,draw_id' }
  );
  if (error) throw writeError(error.message);

  await writeAudit(supabase, updatedBy, auditAction, { guaranteeGift: next, previousGift });
  return { guaranteeGift: next, previousGift };
}

/**
 * Top-up owed on a payout: the part of the promised floor the pot could not cover.
 *
 * Shared by both prize types so "guaranteed" means one thing in this product.
 */
export function guaranteeTopUp(accrued: number, guarantee: number): number {
  const a = Number.isFinite(accrued) && accrued > 0 ? accrued : 0;
  const g = Number.isFinite(guarantee) && guarantee > 0 ? guarantee : 0;
  return round8(Math.max(0, g - a));
}
