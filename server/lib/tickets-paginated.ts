import type { SupabaseClient } from '@supabase/supabase-js';

/** PostgREST default max rows per request (not a product limit). */
export const TICKETS_PAGE_SIZE = 1000;
/** Generic alias — the page size is a PostgREST limit, not ticket-specific. */
export const SUPABASE_PAGE_SIZE = TICKETS_PAGE_SIZE;

/**
 * Load every row a query returns, paging by key: each page asks for rows AFTER the last key seen
 * (`key > last ORDER BY key LIMIT 1000`), so every page costs the same. Prefer this for anything that
 * grows with users or tickets — {@link fetchAllRows} pages by offset, and page N makes the database
 * walk past N×1000 rows first, which turns a full read into quadratic work.
 *
 * `query` builds a FRESH filtered query each call (builders are single-use) WITHOUT order/range/limit;
 * `key` must be unique, non-null and present in the select.
 */
export async function fetchAllRowsByKey<T, R = T>(
  query: () => unknown,
  key = 'id',
  map?: (row: T) => R
): Promise<R[]> {
  type KeysetQuery = {
    gt(column: string, value: unknown): KeysetQuery;
    order(column: string, opts: { ascending: boolean }): KeysetQuery;
    limit(count: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  const all: R[] = [];
  let after: unknown = null;
  while (true) {
    let q = query() as KeysetQuery;
    if (after !== null) q = q.gt(key, after);
    const { data, error } = await q.order(key, { ascending: true }).limit(SUPABASE_PAGE_SIZE);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as T[];
    // `map` keeps only what the caller needs — a whole-draw read holds millions of rows.
    for (const row of chunk) all.push(map ? map(row) : (row as unknown as R));
    if (chunk.length < SUPABASE_PAGE_SIZE) break;
    const last = (chunk[chunk.length - 1] as Record<string, unknown>)[key];
    if (last == null) throw new Error(`fetchAllRowsByKey: rows lack "${key}" — add it to the select`);
    after = last;
  }
  return all;
}

/**
 * {@link fetchAllRowsByKey} over a numeric `id`, split into `lanes` id ranges read concurrently —
 * for one-shot reads of a whole draw (settlement), where sequential pages alone would spend the
 * function's time limit on round trips. Rows come back ordered by id.
 */
export async function fetchAllRowsByIdParallel<T, R = T>(
  query: () => unknown,
  lanes = 8,
  map?: (row: T) => R
): Promise<R[]> {
  type RangeQuery = {
    gt(column: string, value: unknown): RangeQuery;
    gte(column: string, value: unknown): RangeQuery;
    lte(column: string, value: unknown): RangeQuery;
    order(column: string, opts: { ascending: boolean }): RangeQuery;
    limit(count: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
  const edge = async (ascending: boolean): Promise<number | null> => {
    const { data, error } = await (query() as RangeQuery).order('id', { ascending }).limit(1);
    if (error) throw new Error(error.message);
    const id = Number((data?.[0] as { id?: unknown } | undefined)?.id);
    return Number.isSafeInteger(id) ? id : null;
  };
  const [minId, maxId] = await Promise.all([edge(true), edge(false)]);
  if (minId == null || maxId == null) return [];
  const span = maxId - minId + 1;
  const laneCount = Math.max(1, Math.min(lanes, Math.ceil(span / SUPABASE_PAGE_SIZE)));
  const width = Math.ceil(span / laneCount);
  const parts = await Promise.all(
    Array.from({ length: laneCount }, (_, i) => {
      const lo = minId + i * width;
      const hi = Math.min(maxId, lo + width - 1);
      return fetchAllRowsByKey<T, R>(() => (query() as RangeQuery).gte('id', lo).lte('id', hi), 'id', map);
    })
  );
  return parts.flat();
}

/**
 * Load every row a `.range()`-able query would return, paging until a short page.
 * Offset paging: fine for small or per-user sets; use {@link fetchAllRowsByKey} for anything that
 * grows with the user base.
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
