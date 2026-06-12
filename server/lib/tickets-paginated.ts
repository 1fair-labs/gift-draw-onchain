import type { SupabaseClient } from '@supabase/supabase-js';

/** PostgREST default max rows per request (not a product limit). */
export const TICKETS_PAGE_SIZE = 1000;

/**
 * Load all matching ticket rows by paging `.range()` — required above 1000 entrants.
 */
export async function fetchAllTicketRows<T>(
  supabase: SupabaseClient,
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const from = offset;
    const to = offset + TICKETS_PAGE_SIZE - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    all.push(...chunk);
    if (chunk.length < TICKETS_PAGE_SIZE) break;
    offset += TICKETS_PAGE_SIZE;
  }
  return all;
}
