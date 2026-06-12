import type { SupabaseClient } from '@supabase/supabase-js';

const ROW_ID = 1;

export async function readGlobalJackpotBalance(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from('lottery_jackpot_state')
    .select('balance_gift')
    .eq('id', ROW_ID)
    .maybeSingle();
  if (error) return 0;
  if (!data) return 0;
  const n = Number((data as { balance_gift?: unknown }).balance_gift);
  return Number.isFinite(n) ? n : 0;
}

export async function setGlobalJackpotBalance(
  supabase: SupabaseClient,
  balance: number,
  updatedAtIso?: string
): Promise<void> {
  const iso = updatedAtIso ?? new Date().toISOString();
  const { error } = await supabase.from('lottery_jackpot_state').upsert(
    { id: ROW_ID, balance_gift: balance, updated_at: iso },
    { onConflict: 'id' }
  );
  if (error) throw new Error(error.message);
}
