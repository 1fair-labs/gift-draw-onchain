import type { SupabaseClient } from '@supabase/supabase-js';

/** PostgREST `.in('id', …)` and large payloads break above ~few hundred ids. */
export const SUPABASE_IN_CLAUSE_CHUNK = 200;

export const SUPABASE_INSERT_CHUNK = 500;

export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  if (!items.length) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize) as T[]);
  }
  return out;
}

export async function updateTicketsByIdInChunks(
  supabase: SupabaseClient,
  ids: readonly number[],
  patch: Record<string, unknown>,
  chunkSize = SUPABASE_IN_CLAUSE_CHUNK
): Promise<void> {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  for (const batch of chunkArray(unique, chunkSize)) {
    const { error } = await supabase.from('tickets').update(patch).in('id', batch);
    if (error) throw new Error(error.message);
  }
}

export async function insertRowsInChunks<T extends Record<string, unknown>>(
  supabase: SupabaseClient,
  table: 'draw_ticket_prizes',
  rows: readonly T[],
  chunkSize = SUPABASE_INSERT_CHUNK
): Promise<void> {
  if (!rows.length) return;
  for (const batch of chunkArray(rows, chunkSize)) {
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(error.message);
  }
}

/** Remove incomplete settlement attempts so admin/cron can retry cleanly. */
export async function clearIncompleteSettlementsForDraw(
  supabase: SupabaseClient,
  drawId: string
): Promise<number> {
  const trimmed = String(drawId || '').trim();
  if (!trimmed) return 0;

  const { data, error: selErr } = await supabase
    .from('draw_settlements')
    .select('id,status')
    .eq('draw_id', trimmed)
    .in('status', ['failed', 'pending']);
  if (selErr) throw new Error(selErr.message);
  const rows = data || [];
  if (!rows.length) return 0;

  const { error: delErr } = await supabase
    .from('draw_settlements')
    .delete()
    .eq('draw_id', trimmed)
    .in('status', ['failed', 'pending']);
  if (delErr) throw new Error(delErr.message);
  return rows.length;
}
