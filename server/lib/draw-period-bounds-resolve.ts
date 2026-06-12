import type { SupabaseClient } from '@supabase/supabase-js';
import { periodBoundsForDrawId, type DrawScheduleMode } from './draw-schedule.js';

const DAILY_ID = /^(\d{8})(?:_(\d+))?$/;

const parseSameDaySeq = (drawId: string, ymd: string): number => {
  const trimmed = String(drawId || '').trim();
  if (trimmed === ymd) return 0;
  const m = /^(\d{8})_(\d+)$/.exec(trimmed);
  if (!m || m[1] !== ymd) return -1;
  const seq = Number(m[2]);
  return Number.isFinite(seq) && seq > 0 ? seq : -1;
};

/**
 * When the strict prev-segment chain is missing (manual SQL draws), infer bounds from
 * any `draws` rows on the same calendar day and this row's `end_at`.
 */
async function fallbackDailyBoundsFromDrawRows(
  supabase: SupabaseClient,
  drawId: string,
  ymd: string,
  seq: number,
  dayStart: number,
  dayEnd: number,
  syncBounds: { periodStart: Date; periodEnd: Date }
): Promise<{ periodStart: Date; periodEnd: Date }> {
  const { data: selfRows } = await supabase
    .from('draws')
    .select('end_at')
    .eq('draw_id', drawId)
    .order('id', { ascending: false })
    .limit(1);
  const selfEndMs = selfRows?.[0]?.end_at != null ? Date.parse(String(selfRows[0].end_at)) : NaN;
  const periodEnd =
    Number.isFinite(selfEndMs) && selfEndMs > dayStart && selfEndMs <= dayEnd
      ? new Date(selfEndMs)
      : new Date(dayEnd);

  let periodStartMs = dayStart;

  if (seq > 0) {
    const { data: dayRows } = await supabase
      .from('draws')
      .select('draw_id,end_at')
      .or(`draw_id.eq.${ymd},draw_id.like.${ymd}_%`);

    let bestPrevEnd = dayStart;
    for (const row of dayRows || []) {
      const id = String((row as { draw_id?: string }).draw_id || '').trim();
      const s = parseSameDaySeq(id, ymd);
      if (s < 0 || s >= seq) continue;
      const endMs = (row as { end_at?: string | null }).end_at != null ? Date.parse(String(row.end_at)) : NaN;
      if (Number.isFinite(endMs) && endMs > bestPrevEnd && endMs < dayEnd) {
        bestPrevEnd = endMs;
      }
    }
    if (bestPrevEnd > dayStart && bestPrevEnd < periodEnd.getTime()) {
      periodStartMs = bestPrevEnd;
    }
  }

  if (periodStartMs < periodEnd.getTime()) {
    return { periodStart: new Date(periodStartMs), periodEnd };
  }
  return syncBounds;
}

/**
 * Resolves real collection window for daily ids, including same-day split (`YYYYMMDD` + `YYYYMMDD_1`)
 * using `draws.end_at` of the base / previous segment.
 */
export async function resolvePeriodBoundsForDrawId(
  supabase: SupabaseClient,
  drawId: string,
  mode: DrawScheduleMode
): Promise<{ periodStart: Date; periodEnd: Date } | null> {
  const syncBounds = periodBoundsForDrawId(drawId, mode);
  if (!syncBounds || mode !== 'daily') return syncBounds;

  const m = DAILY_ID.exec(String(drawId).trim());
  if (!m) return syncBounds;
  const ymd = m[1];
  const seq = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(seq) || seq < 0) return syncBounds;

  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6)) - 1;
  const d = Number(ymd.slice(6, 8));
  const dayStart = Date.UTC(y, mo, d, 0, 0, 0, 0);
  const dayEnd = Date.UTC(y, mo, d + 1, 0, 0, 0, 0);

  if (seq === 0) {
    const { data: rows } = await supabase
      .from('draws')
      .select('end_at')
      .eq('draw_id', ymd)
      .order('id', { ascending: false })
      .limit(1);
    const endRaw = rows?.[0]?.end_at != null ? String(rows[0].end_at) : '';
    const endMs = endRaw ? Date.parse(endRaw) : NaN;
    if (Number.isFinite(endMs) && endMs > dayStart && endMs < dayEnd) {
      return { periodStart: new Date(dayStart), periodEnd: new Date(endMs) };
    }
    return syncBounds;
  }

  const prevId = seq <= 1 ? ymd : `${ymd}_${seq - 1}`;
  const { data: prevRows } = await supabase
    .from('draws')
    .select('end_at')
    .eq('draw_id', prevId)
    .order('id', { ascending: false })
    .limit(1);
  const startRaw = prevRows?.[0]?.end_at != null ? String(prevRows[0].end_at) : '';
  const startMs = startRaw ? Date.parse(startRaw) : NaN;
  if (Number.isFinite(startMs) && startMs > dayStart && startMs < dayEnd) {
    return { periodStart: new Date(startMs), periodEnd: new Date(dayEnd) };
  }

  return fallbackDailyBoundsFromDrawRows(supabase, drawId, ymd, seq, dayStart, dayEnd, syncBounds);
}
