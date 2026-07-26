import type { SupabaseClient } from '@supabase/supabase-js';

/** PostgREST default max rows per request (not a product limit). */
export const TICKETS_PAGE_SIZE = 1000;
/** Generic alias — the page size is a PostgREST limit, not ticket-specific. */
export const SUPABASE_PAGE_SIZE = TICKETS_PAGE_SIZE;

/**
 * Load every row a `.range()`-able query would return, paging until a short page.
 * Use for ANY multi-row read that is consumed in full — PostgREST caps a single
 * request at ~1000 rows and silently truncates, so an unpaged query drops data.
 *
 * The page callback must apply a stable `.order(...)` and `.range(from, to)` so
 * pages don't overlap or skip rows.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const from = offset;
    const to = offset + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    all.push(...chunk);
    if (chunk.length < SUPABASE_PAGE_SIZE) break;
    offset += SUPABASE_PAGE_SIZE;
  }
  return all;
}

/**
 * Load all matching ticket rows by paging `.range()` — required above 1000 entrants.
 * Thin wrapper around {@link fetchAllRows}; `supabase` is kept for call-site clarity.
 */
export async function fetchAllTicketRows<T>(
  _supabase: SupabaseClient,
  fetchPage: (from: number, to: number) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>
): Promise<T[]> {
  return fetchAllRows(fetchPage);
}
