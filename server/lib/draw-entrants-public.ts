import type { SupabaseClient } from '@supabase/supabase-js';
import { merkleRootFromTicketIds } from './draw-settlement-seed.js';
import { fetchDrawSeed } from './gift-draw-registry-client.js';
import { fetchAllTicketRows } from './tickets-paginated.js';
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

/**
 * Public entrant snapshot for draw verification.
 * Before settlement: `in_draw` only. After settlement: entrants are `used` (same ticket ids).
 *
 * Returns the raw fields the exclusion predicate reads, so anyone can re-derive `sortedTicketIds`
 * from `allTickets` instead of trusting this endpoint's filtering.
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
  allTickets: Array<{
    id: number;
    ticket_kind: string | null;
    ticket_origin: string | null;
    has_purchase_tx: boolean;
    has_kind_roll: boolean;
    kind_roll_verified: boolean;
    excluded_reason: string | null;
  }>;
  merkleRootHex: string;
  onChainMerkleHex: string | null;
  merkleMatchesOnChain: boolean | null;
}> {
  const trimmed = String(drawId || '').trim();
  if (!isPublicDrawId(trimmed)) throw new Error('Invalid drawId');

  const rows = await fetchAllTicketRows<PublicEntrantRow>(supabase, (from, to) =>
    supabase
      .from('tickets')
      .select(
        'id,status,ticket_kind,ticket_origin,purchase_tx_sig,kind_roll_tx_sig,kind_roll_verified_at,sync_error'
      )
      .eq('draw_id', trimmed)
      .in('status', ['in_draw', 'used'])
      .order('id', { ascending: true })
      .range(from, to)
  );

  const valid = rows.filter((r) => Number.isFinite(Number(r.id)) && Number(r.id) > 0);
  const sortedTicketIds = valid
    .filter(isCommittedDrawEntrant)
    .map((r) => Number(r.id))
    .sort((a, b) => a - b);

  const allTickets = valid
    .map((r) => ({
      id: Number(r.id),
      ticket_kind: r.ticket_kind ?? null,
      ticket_origin: r.ticket_origin ?? null,
      has_purchase_tx: Boolean(String(r.purchase_tx_sig || '').trim()),
      has_kind_roll: Boolean(String(r.kind_roll_tx_sig || '').trim()),
      kind_roll_verified: Boolean(String(r.kind_roll_verified_at || '').trim()),
      excluded_reason: isCommittedDrawEntrant(r)
        ? null
        : String(r.sync_error || '').trim() || drawEntrantExclusionReason(r),
    }))
    .sort((a, b) => a.id - b.id);

  const merkleRootHex = merkleRootFromTicketIds(sortedTicketIds);
  const onChain = await fetchDrawSeed(trimmed);
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
