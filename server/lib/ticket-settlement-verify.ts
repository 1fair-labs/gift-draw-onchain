import type { SupabaseClient } from '@supabase/supabase-js';
import type { DrawAnchorApiPayload } from './gift-draw-registry-client.js';
import { isRegistryEnabled } from './gift-draw-registry-client.js';
import { SETTLEMENT_SPEC_VERSION } from './draw-settlement.js';
import {
  buildPrizeCommitRowsFromDb,
  findCommitRowForDbPrize,
  SETTLEMENT_SPEC_VERSION_PRIZES,
  settlementCommitHashHex,
} from './settlement-commit-hash.js';

export type TicketSettlementPrizeRow = {
  prizeBucket: string;
  rank: number;
  giftAmount: number | null;
  claimStatus: string | null;
  matchesOnChain: boolean;
};

export type TicketSettlementVerification = {
  drawId: string;
  specVersion: number | null;
  /** Whole-draw settlement_hash matches on-chain draw_commit (spec 17/18). */
  settlementHashVerified: boolean | null;
  isWinner: boolean;
  ticketPrizes: TicketSettlementPrizeRow[];
  notice?: string;
};

type DbPrizeRow = {
  ticket_id?: number | null;
  prize_bucket?: string | null;
  rank?: number | null;
  gift_amount?: number | string | null;
  claim_status?: string | null;
};

function mapTicketPrizeRows(
  ticketId: number,
  rows: DbPrizeRow[],
  prizeCommitRows: ReturnType<typeof buildPrizeCommitRowsFromDb>,
  hashVerified: boolean
): TicketSettlementPrizeRow[] {
  return rows.map((r) => ({
    prizeBucket: String(r.prize_bucket || ''),
    rank: Number(r.rank) || 0,
    giftAmount:
      r.gift_amount != null && Number.isFinite(Number(r.gift_amount)) ? Number(r.gift_amount) : null,
    claimStatus: r.claim_status != null ? String(r.claim_status) : null,
    matchesOnChain:
      hashVerified &&
      findCommitRowForDbPrize(prizeCommitRows, {
        ticket_id: r.ticket_id ?? ticketId,
        prize_bucket: r.prize_bucket,
        rank: r.rank,
        gift_amount: r.gift_amount,
      }) != null,
  }));
}

/**
 * Verify this ticket's draw prizes against on-chain draw_commit settlement_hash.
 * Per-ticket rank/bucket/amount are not stored in the chain account — only committed via hash (spec 18).
 */
export async function buildTicketSettlementVerification(
  supabase: SupabaseClient,
  ticketId: number,
  drawIdRaw: string | null | undefined,
  drawAnchor: DrawAnchorApiPayload
): Promise<TicketSettlementVerification | null> {
  const drawId = String(drawIdRaw || drawAnchor.drawId || '').trim();
  if (!drawId) return null;

  const { data: ticketPrizes, error: tpErr } = await supabase
    .from('draw_ticket_prizes')
    .select('ticket_id,prize_bucket,rank,gift_amount,claim_status')
    .eq('ticket_id', ticketId)
    .eq('draw_id', drawId);
  if (tpErr) throw new Error(tpErr.message);

  const rows = (ticketPrizes || []) as DbPrizeRow[];
  const isWinner = rows.length > 0;

  if (!isRegistryEnabled()) {
    return {
      drawId,
      specVersion: null,
      settlementHashVerified: null,
      isWinner,
      ticketPrizes: mapTicketPrizeRows(ticketId, rows, [], false),
      notice: 'On-chain registry is not enabled on this server.',
    };
  }

  if (!drawAnchor.drawCommit) {
    return {
      drawId,
      specVersion: null,
      settlementHashVerified: null,
      isWinner,
      ticketPrizes: mapTicketPrizeRows(ticketId, rows, [], false),
      notice: isWinner
        ? 'Draw result (draw_commit) is not on-chain yet.'
        : 'This ticket has no prize rows for this draw.',
    };
  }

  const { data: settlement, error: sErr } = await supabase
    .from('draw_settlements')
    .select('random_seed_hex,merkle_root_hex,spec_version')
    .eq('draw_id', drawId)
    .eq('status', 'completed')
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);

  if (!settlement?.random_seed_hex || !settlement?.merkle_root_hex) {
    return {
      drawId,
      specVersion: drawAnchor.drawCommit.specVersion,
      settlementHashVerified: null,
      isWinner,
      ticketPrizes: mapTicketPrizeRows(ticketId, rows, [], false),
      notice: 'No completed settlement ledger found for this draw.',
    };
  }

  const specVersion = Number(settlement.spec_version) || SETTLEMENT_SPEC_VERSION;
  const seedHex = String(settlement.random_seed_hex);
  const merkleHex = String(settlement.merkle_root_hex);

  const { data: allPrizes, error: apErr } = await supabase
    .from('draw_ticket_prizes')
    .select('ticket_id,prize_bucket,rank,gift_amount')
    .eq('draw_id', drawId);
  if (apErr) throw new Error(apErr.message);

  const prizeCommitRows = buildPrizeCommitRowsFromDb(allPrizes || []);
  const winnerTicketIds = [
    ...new Set(
      (allPrizes || [])
        .map((p) => Number((p as { ticket_id?: number }).ticket_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];

  let expectedHash: string;
  try {
    expectedHash =
      specVersion >= SETTLEMENT_SPEC_VERSION_PRIZES
        ? settlementCommitHashHex(drawId, specVersion, seedHex, merkleHex, {
            prizeCommitRows,
          })
        : settlementCommitHashHex(drawId, specVersion, seedHex, merkleHex, { winnerTicketIds });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'settlement hash failed';
    return {
      drawId,
      specVersion,
      settlementHashVerified: null,
      isWinner,
      ticketPrizes: mapTicketPrizeRows(ticketId, rows, prizeCommitRows, false),
      notice: msg,
    };
  }

  const onChainHash = drawAnchor.drawCommit.settlementHashHex;
  const hashVerified = onChainHash === expectedHash;

  let notice: string | undefined;
  if (!hashVerified) {
    notice = 'On-chain settlement_hash does not match database settlement.';
  } else if (!isWinner) {
    notice = 'Settlement verified on-chain. This ticket is not in the committed prize set.';
  } else if (rows.some((r) => !findCommitRowForDbPrize(prizeCommitRows, r))) {
    notice = 'Prize row does not match on-chain settlement (rank, bucket, or amount).';
  }

  return {
    drawId,
    specVersion,
    settlementHashVerified: hashVerified,
    isWinner,
    ticketPrizes: mapTicketPrizeRows(ticketId, rows, prizeCommitRows, hashVerified),
    notice,
  };
}
