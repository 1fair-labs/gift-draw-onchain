import type { SupabaseClient } from '@supabase/supabase-js';
import { merkleRootFromTicketIds } from './draw-settlement-seed.js';
import { fetchDrawSeed } from './gift-draw-registry-client.js';
import { fetchAllRowsByKey, SUPABASE_PAGE_SIZE } from './tickets-paginated.js';
import { STAGE, STAGE_ANCHORS_DRAWS_ON_CHAIN } from './stage.js';
import {
  drawEntrantExclusionReason,
  isCommittedDrawEntrant,
  type DrawEntrantVerdictFields,
} from './draw-entrant-rules.js';

const DAILY_DRAW_ID_RE = /^(\d{8})(_\d+)?$/;

export function isPublicDrawId(drawId: string): boolean {
  return DAILY_DRAW_ID_RE.test(String(drawId || '').trim());
}

/** Exactly the columns this endpoint may expose: the predicate's inputs, no owner columns. */
type PublicEntrantRow = DrawEntrantVerdictFields & {
  id: number;
  status: string;
  sync_error?: string | null;
};

const PUBLIC_ENTRANT_COLUMNS =
  'id,status,ticket_kind,ticket_origin,purchase_tx_sig,kind_roll_tx_sig,kind_roll_verified_at,sync_error';

/**
 * Tickets per response. A serverless response is capped at 4.5 MB and a ticket is ~160–210 bytes of
 * JSON here, so a whole draw fits one response only up to ~20k tickets: larger draws are read in
 * pages ({@link getPublicDrawEntrantsPage}), and the one-shot answer refuses them.
 */
export const PUBLIC_ENTRANTS_PAGE_SIZE = 10_000;

/** A draw too large for {@link getPublicDrawEntrants}' single response. */
export class PublicEntrantsTooLargeError extends Error {
  constructor(readonly ticketCount: number) {
    super(
      `This draw has ${ticketCount} tickets — too many for one response. Read it in pages: add &after=0 and follow nextAfter.`
    );
  }
}

export type PublicEntrantTicket = {
  id: number;
  ticket_kind: string | null;
  ticket_origin: string | null;
  has_purchase_tx: boolean;
  has_kind_roll: boolean;
  kind_roll_verified: boolean;
  excluded_reason: string | null;
};

/** Presence flags, not values: a signature would identify the payer, and presence is all the rule reads. */
function toPublicTicket(r: PublicEntrantRow): PublicEntrantTicket {
  return {
    id: Number(r.id),
    ticket_kind: r.ticket_kind ?? null,
    ticket_origin: r.ticket_origin ?? null,
    has_purchase_tx: Boolean(String(r.purchase_tx_sig || '').trim()),
    has_kind_roll: Boolean(String(r.kind_roll_tx_sig || '').trim()),
    kind_roll_verified: Boolean(String(r.kind_roll_verified_at || '').trim()),
    excluded_reason: isCommittedDrawEntrant(r)
      ? null
      : String(r.sync_error || '').trim() || drawEntrantExclusionReason(r),
  };
}

/**
 * Public entrant snapshot for draw verification.
 * Before settlement: `in_draw` only. After settlement: entrants are `used` (same ticket ids).
 *
 * Returns the raw fields the exclusion predicate reads, so anyone can re-derive `sortedTicketIds`
 * from `allTickets` instead of trusting this endpoint's filtering.
 *
 * Whole draws only up to {@link PUBLIC_ENTRANTS_PAGE_SIZE} tickets — beyond that it throws
 * {@link PublicEntrantsTooLargeError} and the caller reads {@link getPublicDrawEntrantsPage}.
 */
export async function getPublicDrawEntrants(
  supabase: SupabaseClient,
  drawId: string
): Promise<{
  drawId: string;
  entrantCount: number;
  excludedCount: number;
  /** False when no ticket rows remain for the draw — its on-chain root has nothing to check against. */
  entrantDataAvailable: boolean;
  sortedTicketIds: number[];
  allTickets: PublicEntrantTicket[];
  merkleRootHex: string;
  onChainMerkleHex: string | null;
  merkleMatchesOnChain: boolean | null;
}> {
  const trimmed = String(drawId || '').trim();
  if (!isPublicDrawId(trimmed)) throw new Error('Invalid drawId');

  // Count first: a draw too big for one response must not be read whole just to fail on the way out.
  const { count, error: countError } = await supabase
    .from('tickets')
    .select('id', { count: 'exact', head: true })
    .eq('stage', STAGE)
    .eq('draw_id', trimmed)
    .in('status', ['in_draw', 'used']);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) > PUBLIC_ENTRANTS_PAGE_SIZE) throw new PublicEntrantsTooLargeError(count ?? 0);

  const rows = await fetchAllRowsByKey<PublicEntrantRow>(() =>
    supabase
      .from('tickets')
      .select(PUBLIC_ENTRANT_COLUMNS)
      .eq('stage', STAGE)
      .eq('draw_id', trimmed)
      .in('status', ['in_draw', 'used']));

  const valid = rows.filter((r) => Number.isFinite(Number(r.id)) && Number(r.id) > 0);
  const sortedTicketIds = valid
    .filter(isCommittedDrawEntrant)
    .map((r) => Number(r.id))
    .sort((a, b) => a - b);

  const allTickets = valid.map(toPublicTicket).sort((a, b) => a.id - b.id);

  const merkleRootHex = merkleRootFromTicketIds(sortedTicketIds);
  // Only read the chain when this deployment's draws are the ones committed there — see
  // STAGE_ANCHORS_DRAWS_ON_CHAIN. Otherwise the accounts belong to the other stage and comparing
  // against them would report a mismatch for a draw this deployment never ran.
  const onChain = STAGE_ANCHORS_DRAWS_ON_CHAIN ? await fetchDrawSeed(trimmed) : null;
  const onChainMerkleHex = onChain ? Buffer.from(onChain.merkleRoot).toString('hex') : null;

  /**
   * Does this draw have any ticket rows to answer with?
   *
   * On-chain commitments are immutable, so a draw can have a root on chain while no rows remain to
   * reproduce it from. Reporting `merkleMatchesOnChain: false` there says "the operator's list
   * disagrees with the chain" — an accusation of tampering built out of missing data. The honest
   * answer is that there is nothing to compare.
   *
   * A draw that genuinely had zero entrants is not caught by this: it would have committed the
   * empty-list hash, so the roots match and the answer is a plain `true`.
   */
  const entrantDataAvailable = valid.length > 0;

  let merkleMatchesOnChain: boolean | null = null;
  if (onChainMerkleHex) {
    if (onChainMerkleHex === merkleRootHex) merkleMatchesOnChain = true;
    else if (entrantDataAvailable) merkleMatchesOnChain = false;
  }

  return {
    drawId: trimmed,
    entrantCount: sortedTicketIds.length,
    excludedCount: valid.length - sortedTicketIds.length,
    entrantDataAvailable,
    sortedTicketIds,
    allTickets,
    merkleRootHex,
    onChainMerkleHex,
    merkleMatchesOnChain,
  };
}

/**
 * One page of a draw's entrant snapshot: the tickets with id > `after`, in id order, at most
 * `pageSize`. `nextAfter` is the cursor for the next page, null on the last one. Each page is a
 * keyset read over (stage, draw_id, id), so page 1000 costs what page 1 does.
 *
 * Pages concatenate to exactly what {@link getPublicDrawEntrants} returns in one piece:
 * `sortedTicketIds` holds the committed entrants among this page's tickets, so joining the pages
 * gives the full sorted list. The first page (`after` = 0) also carries `merkleRootHex`, the entrant
 * list hash this deployment's settlement recorded — the site's claim, which the caller recomputes
 * and holds against the chain itself.
 */
export async function getPublicDrawEntrantsPage(
  supabase: SupabaseClient,
  drawId: string,
  after: number,
  pageSize: number = PUBLIC_ENTRANTS_PAGE_SIZE
): Promise<{
  drawId: string;
  after: number;
  nextAfter: number | null;
  pageSize: number;
  sortedTicketIds: number[];
  allTickets: PublicEntrantTicket[];
  merkleRootHex?: string | null;
}> {
  const trimmed = String(drawId || '').trim();
  if (!isPublicDrawId(trimmed)) throw new Error('Invalid drawId');
  const size = Math.max(1, Math.min(PUBLIC_ENTRANTS_PAGE_SIZE, Math.floor(pageSize)));
  const start = Math.max(0, Math.floor(after));

  const rows: PublicEntrantRow[] = [];
  let cursor = start;
  let exhausted = false;
  while (rows.length < size) {
    const take = Math.min(SUPABASE_PAGE_SIZE, size - rows.length);
    const { data, error } = await supabase
      .from('tickets')
      .select(PUBLIC_ENTRANT_COLUMNS)
      .eq('stage', STAGE)
      .eq('draw_id', trimmed)
      .in('status', ['in_draw', 'used'])
      .gt('id', cursor)
      .order('id', { ascending: true })
      .limit(take);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as PublicEntrantRow[];
    rows.push(...chunk);
    if (chunk.length < take) {
      exhausted = true;
      break;
    }
    cursor = Number(chunk[chunk.length - 1].id);
  }

  const valid = rows.filter((r) => Number.isFinite(Number(r.id)) && Number(r.id) > 0);
  const nextAfter = !exhausted && rows.length > 0 ? Number(rows[rows.length - 1].id) : null;

  let merkleRootHex: string | null | undefined;
  if (start === 0) {
    const { data: settlement } = await supabase
      .from('draw_settlements')
      .select('merkle_root_hex')
      .eq('stage', STAGE)
      .eq('draw_id', trimmed)
      .not('merkle_root_hex', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    merkleRootHex = (settlement as { merkle_root_hex?: string | null } | null)?.merkle_root_hex ?? null;
  }

  return {
    drawId: trimmed,
    after: start,
    nextAfter,
    pageSize: size,
    sortedTicketIds: valid.filter(isCommittedDrawEntrant).map((r) => Number(r.id)),
    allTickets: valid.map(toPublicTicket),
    ...(merkleRootHex !== undefined ? { merkleRootHex } : {}),
  };
}
