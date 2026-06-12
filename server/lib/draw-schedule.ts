import { getISOWeek, getISOWeekYear } from 'date-fns';

export type DrawScheduleMode = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** Product lottery cadence: daily windows only; optional same-day `YYYYMMDD_N` ids after manual closes. */
export const EFFECTIVE_LOTTERY_SCHEDULE_MODE: DrawScheduleMode = 'daily';

const DAILY_DRAW_ID = /^(\d{8})(_\d+)?$/;

/** Calendar-day base `YYYYMMDD` for daily ids, including optional `_*` manual suffix. */
export const dailyDrawCalendarBase = (drawId: string): string | null => {
  const m = DAILY_DRAW_ID.exec(String(drawId || '').trim());
  return m ? m[1] : null;
};

/**
 * Total order for same-day manual ids: `YYYYMMDD` then `_N` (no suffix = 0).
 * Other ids fall back to `localeCompare` for non-daily shapes.
 */
export const compareDailyDrawIdChronological = (a: string, b: string): number => {
  const parse = (id: string): { base: string; seq: number } | null => {
    const m = /^(\d{8})(?:_(\d+))?$/.exec(String(id || '').trim());
    if (!m) return null;
    const seq = m[2] ? Number(m[2]) : 0;
    if (!Number.isFinite(seq) || seq < 0) return null;
    return { base: m[1], seq };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) {
    if (pa.base < pb.base) return -1;
    if (pa.base > pb.base) return 1;
    if (pa.seq < pb.seq) return -1;
    if (pa.seq > pb.seq) return 1;
    return 0;
  }
  return String(a).localeCompare(String(b));
};

export type DrawPendingTransition = {
  effective_at: string;
  next_mode: DrawScheduleMode;
};

export const normalizeDrawScheduleMode = (v: unknown): DrawScheduleMode => {
  const m = String(v || '').trim().toLowerCase();
  if (m === 'hourly' || m === 'daily' || m === 'weekly' || m === 'monthly') return m;
  return 'daily';
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Monday 00:00:00.000 UTC of the ISO week containing `d`. */
const utcMondayOfContainingWeek = (d: Date): Date => {
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  const utcDow = d.getUTCDay();
  const offsetToMonday = (utcDow + 6) % 7;
  return new Date(Date.UTC(year, month, day - offsetToMonday, 0, 0, 0, 0));
};

/**
 * Current draw window in UTC. `periodEnd` is the exclusive end instant (start of next period).
 */
export const computeDrawWindow = (
  now: Date,
  mode: DrawScheduleMode
): { drawId: string; periodStart: Date; periodEnd: Date } => {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const day = now.getUTCDate();
  const hour = now.getUTCHours();

  if (mode === 'hourly') {
    const periodStart = Date.UTC(y, mo, day, hour, 0, 0, 0);
    const periodEnd = periodStart + 60 * 60 * 1000;
    const H = hour + 1;
    const ymd = `${y}${pad2(mo + 1)}${pad2(day)}`;
    return { drawId: `${ymd}_${H}`, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) };
  }

  if (mode === 'daily') {
    const periodStart = Date.UTC(y, mo, day, 0, 0, 0, 0);
    const periodEnd = Date.UTC(y, mo, day + 1, 0, 0, 0, 0);
    const drawId = `${y}${pad2(mo + 1)}${pad2(day)}`;
    return { drawId, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) };
  }

  if (mode === 'weekly') {
    const monday = utcMondayOfContainingWeek(now);
    const periodStart = monday.getTime();
    const periodEnd = periodStart + 7 * 24 * 60 * 60 * 1000;
    const thursday = new Date(
      Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 3, 12, 0, 0, 0)
    );
    const isoY = getISOWeekYear(thursday);
    const isoW = getISOWeek(thursday);
    const drawId = `${isoY}W${pad2(isoW)}`;
    return { drawId, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) };
  }

  // monthly
  const periodStart = Date.UTC(y, mo, 1, 0, 0, 0, 0);
  const periodEnd = Date.UTC(y, mo + 1, 1, 0, 0, 0, 0);
  const drawId = `${y}${pad2(mo + 1)}`;
  return { drawId, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) };
};

/**
 * Daily window with optional admin `nextCloseIso` strictly inside the natural UTC calendar day:
 * first segment `YYYYMMDD`, second `YYYYMMDD_1` until natural midnight.
 */
export const computeDailyDrawWindowFromNextClose = (
  now: Date,
  nextCloseIso: string | null | undefined
): { drawId: string; periodStart: Date; periodEnd: Date } => {
  const natural = computeDrawWindow(now, 'daily');
  if (!nextCloseIso || !String(nextCloseIso).trim()) return natural;
  const closeMs = Date.parse(String(nextCloseIso).trim());
  if (!Number.isFinite(closeMs)) return natural;

  const ns = natural.periodStart.getTime();
  const ne = natural.periodEnd.getTime();
  const y = natural.periodStart.getUTCFullYear();
  const mo = natural.periodStart.getUTCMonth();
  const d = natural.periodStart.getUTCDate();
  const drawBase = `${y}${pad2(mo + 1)}${pad2(d)}`;

  const close = new Date(closeMs);
  if (close.getUTCFullYear() !== y || close.getUTCMonth() !== mo || close.getUTCDate() !== d) {
    return natural;
  }
  if (closeMs <= ns || closeMs >= ne) return natural;

  const nowMs = now.getTime();
  if (nowMs < closeMs) {
    return { drawId: drawBase, periodStart: new Date(ns), periodEnd: new Date(closeMs) };
  }
  return { drawId: `${drawBase}_1`, periodStart: new Date(closeMs), periodEnd: new Date(ne) };
};

export const parseDrawPending = (raw: string | null | undefined): DrawPendingTransition | null => {
  if (!raw || !String(raw).trim()) return null;
  try {
    const o = JSON.parse(String(raw)) as DrawPendingTransition;
    if (!o || typeof o.effective_at !== 'string' || typeof o.next_mode !== 'string') return null;
    const next_mode = normalizeDrawScheduleMode(o.next_mode);
    return { effective_at: o.effective_at, next_mode };
  } catch {
    return null;
  }
};

export type DrawSlot = { drawId: string; periodStart: Date; periodEnd: Date };

/** Current period and the next `count - 1` periods (UTC). */
export const listUpcomingDrawSlots = (now: Date, mode: DrawScheduleMode, count: number): DrawSlot[] => {
  const out: DrawSlot[] = [];
  let t = now;
  for (let i = 0; i < count; i++) {
    const w = computeDrawWindow(t, mode);
    out.push({ drawId: w.drawId, periodStart: w.periodStart, periodEnd: w.periodEnd });
    t = new Date(w.periodEnd.getTime());
  }
  return out;
};

/**
 * When admin set a one-shot next period close (UTC), reflect it on the matching daily slot's `periodEnd`
 * so schedules and slot pickers show the real collection end. Only applies if the instant lies strictly
 * inside that calendar day's natural window. If that day is not in `slots`, appends one sorted row.
 */
export const applyConfiguredNextCloseToDailySlots = (
  slots: DrawSlot[],
  nextCloseIso: string | null | undefined
): DrawSlot[] => {
  if (!nextCloseIso || !String(nextCloseIso).trim()) return slots;
  const t = Date.parse(String(nextCloseIso).trim());
  if (!Number.isFinite(t)) return slots;
  const close = new Date(t);
  const y = close.getUTCFullYear();
  const mo = close.getUTCMonth();
  const d = close.getUTCDate();
  const slotDrawId = `${y}${pad2(mo + 1)}${pad2(d)}`;

  let split = false;
  const expanded = slots.flatMap((s) => {
    if (s.drawId !== slotDrawId) return [s];
    const ps = s.periodStart.getTime();
    const pe = s.periodEnd.getTime();
    if (t <= ps || t >= pe) return [s];
    split = true;
    const first: DrawSlot = { drawId: s.drawId, periodStart: s.periodStart, periodEnd: new Date(t) };
    const second: DrawSlot = { drawId: `${slotDrawId}_1`, periodStart: new Date(t), periodEnd: s.periodEnd };
    return [first, second];
  });

  if (split) {
    return expanded.sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
  }

  const b = periodBoundsForDrawId(slotDrawId, 'daily');
  if (!b) return slots;
  const ps = b.periodStart.getTime();
  const natEnd = b.periodEnd.getTime();
  if (t <= ps || t >= natEnd) return slots;
  const extra: DrawSlot[] = [
    { drawId: slotDrawId, periodStart: b.periodStart, periodEnd: new Date(t) },
    { drawId: `${slotDrawId}_1`, periodStart: new Date(t), periodEnd: b.periodEnd },
  ];
  return [...slots, ...extra].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
};

export const isDrawIdAllowed = (
  drawId: string,
  now: Date,
  mode: DrawScheduleMode,
  maxSlots = 64,
  nextCloseIso?: string | null
): boolean => {
  const slotsRaw = listUpcomingDrawSlots(now, mode, maxSlots);
  const slots =
    mode === 'daily' && nextCloseIso
      ? applyConfiguredNextCloseToDailySlots(slotsRaw, nextCloseIso)
      : slotsRaw;
  if (mode === 'daily') {
    const cur = computeDailyDrawWindowFromNextClose(now, nextCloseIso ?? null);
    if (drawId === cur.drawId) return true;
  }
  return slots.some((s) => s.drawId === drawId);
};

/**
 * Inverse of id generation for a given schedule mode. Used for `draws.end_at` on scheduled rows.
 */
export const periodBoundsForDrawId = (
  drawId: string,
  mode: DrawScheduleMode
): { periodStart: Date; periodEnd: Date } | null => {
  if (mode === 'hourly') {
    const m = /^(\d{8})_(\d{1,2})$/.exec(drawId);
    if (!m) return null;
    const ymd = m[1];
    const H = Number(m[2]);
    if (!Number.isFinite(H) || H < 1 || H > 24) return null;
    const y = Number(ymd.slice(0, 4));
    const mo = Number(ymd.slice(4, 6)) - 1;
    const d = Number(ymd.slice(6, 8));
    const periodStart = Date.UTC(y, mo, d, H - 1, 0, 0, 0);
    return { periodStart: new Date(periodStart), periodEnd: new Date(periodStart + 60 * 60 * 1000) };
  }

  if (mode === 'daily') {
    const m = DAILY_DRAW_ID.exec(drawId);
    if (!m) return null;
    const ymd = m[1];
    const y = Number(ymd.slice(0, 4));
    const mo = Number(ymd.slice(4, 6)) - 1;
    const d = Number(ymd.slice(6, 8));
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    const periodStart = Date.UTC(y, mo, d, 0, 0, 0, 0);
    const periodEnd = Date.UTC(y, mo, d + 1, 0, 0, 0, 0);
    return { periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) };
  }

  if (mode === 'weekly') {
    const m = /^(\d{4})W(\d{2})$/.exec(drawId);
    if (!m) return null;
    const isoY = Number(m[1]);
    const isoW = Number(m[2]);
    if (!Number.isFinite(isoY) || !Number.isFinite(isoW) || isoW < 1 || isoW > 53) return null;
    const startMs = Date.UTC(isoY - 1, 10, 1);
    const endMs = Date.UTC(isoY + 1, 2, 1);
    for (let t = startMs; t < endMs; t += 86400000) {
      const cand = new Date(t);
      const monday = utcMondayOfContainingWeek(cand);
      const th = new Date(
        Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 3, 12, 0, 0, 0)
      );
      if (getISOWeekYear(th) === isoY && getISOWeek(th) === isoW) {
        const p0 = monday.getTime();
        return { periodStart: new Date(p0), periodEnd: new Date(p0 + 7 * 24 * 60 * 60 * 1000) };
      }
    }
    return null;
  }

  if (mode === 'monthly') {
    const m = /^(\d{6})$/.exec(drawId);
    if (!m) return null;
    const y = Number(drawId.slice(0, 4));
    const mo = Number(drawId.slice(4, 6)) - 1;
    if (!Number.isFinite(y) || mo < 0 || mo > 11) return null;
    const periodStart = Date.UTC(y, mo, 1, 0, 0, 0, 0);
    const periodEnd = Date.UTC(y, mo + 1, 1, 0, 0, 0, 0);
    return { periodStart: new Date(periodStart), periodEnd: new Date(periodEnd) };
  }

  return null;
};
