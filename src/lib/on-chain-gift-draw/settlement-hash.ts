import { createHash } from 'crypto';
import { SETTLEMENT_SPEC_VERSION_ON_CHAIN } from './program-id';

export const SETTLEMENT_SPEC_VERSION_LEGACY = 17;
export const SETTLEMENT_SPEC_VERSION_PRIZES = 18;
export const SETTLEMENT_SPEC_VERSION_WINNER_COUNT = 19;

export type PrizeBucketCommit = 'main_gift' | 'main_ticket' | 'jackpot_gift';

export type SettlementPrizeCommitRow = {
  ticketId: number;
  prizeBucket: PrizeBucketCommit;
  rank: number;
  giftAmountMicro: string;
};

const GIFT_AMOUNT_MICRO_SCALE = 1_000_000n;

function giftAmountToMicro(human: number): bigint {
  if (!Number.isFinite(human) || human < 0) return 0n;
  return BigInt(Math.round(human * Number(GIFT_AMOUNT_MICRO_SCALE)));
}

function sortPrizeCommitRows(rows: SettlementPrizeCommitRow[]): SettlementPrizeCommitRow[] {
  return [...rows].sort((a, b) => {
    if (a.ticketId !== b.ticketId) return a.ticketId - b.ticketId;
    if (a.prizeBucket !== b.prizeBucket) return a.prizeBucket.localeCompare(b.prizeBucket);
    return a.rank - b.rank;
  });
}

export function canonicalPrizeCommitBody(rows: SettlementPrizeCommitRow[]): string {
  return sortPrizeCommitRows(rows)
    .map((r) => `${r.ticketId}:${r.prizeBucket}:${r.rank}:${r.giftAmountMicro}`)
    .join('\n');
}

function settlementCommitHashHexV17(
  drawId: string,
  specVersion: number,
  seedHex: string,
  merkleRootHex: string,
  winnerTicketIds: number[]
): string {
  const sorted = [...new Set(winnerTicketIds.filter((id) => Number.isFinite(id) && id > 0))].sort(
    (a, b) => a - b
  );
  return createHash('sha256')
    .update(drawId, 'utf8')
    .update('|', 'utf8')
    .update(String(specVersion), 'utf8')
    .update('|', 'utf8')
    .update(seedHex, 'utf8')
    .update('|', 'utf8')
    .update(merkleRootHex, 'utf8')
    .update('|', 'utf8')
    .update(sorted.join(','), 'utf8')
    .digest('hex');
}

function settlementCommitHashHexV18(
  drawId: string,
  specVersion: number,
  seedHex: string,
  merkleRootHex: string,
  prizeCommitRows: SettlementPrizeCommitRow[]
): string {
  const body = canonicalPrizeCommitBody(prizeCommitRows);
  return createHash('sha256')
    .update(drawId, 'utf8')
    .update('|', 'utf8')
    .update(String(specVersion), 'utf8')
    .update('|', 'utf8')
    .update(seedHex, 'utf8')
    .update('|', 'utf8')
    .update(merkleRootHex, 'utf8')
    .update('|', 'utf8')
    .update(body, 'utf8')
    .digest('hex');
}

/**
 * v19: prize rows + winner_count (distinct ticket IDs) bound into hash.
 * Ensures DrawCommit.winner_count cannot differ from what the hash covers.
 */
function settlementCommitHashHexV19(
  drawId: string,
  specVersion: number,
  seedHex: string,
  merkleRootHex: string,
  prizeCommitRows: SettlementPrizeCommitRow[]
): string {
  const winnerCount = new Set(prizeCommitRows.map((r) => r.ticketId)).size;
  const body = canonicalPrizeCommitBody(prizeCommitRows);
  return createHash('sha256')
    .update(drawId, 'utf8')
    .update('|', 'utf8')
    .update(String(specVersion), 'utf8')
    .update('|', 'utf8')
    .update(seedHex, 'utf8')
    .update('|', 'utf8')
    .update(merkleRootHex, 'utf8')
    .update('|', 'utf8')
    .update(String(winnerCount), 'utf8')
    .update('|', 'utf8')
    .update(body, 'utf8')
    .digest('hex');
}

/**
 * Canonical hash committed on-chain after settlement.
 * v17: sorted winner ticket ids only.
 * v18: full prize rows (bucket, rank, amount_micro).
 * v19: prize rows + winner_count explicitly bound.
 */
export function settlementCommitHashHex(
  drawId: string,
  specVersion: number,
  seedHex: string,
  merkleRootHex: string,
  input: { winnerTicketIds?: number[]; prizeCommitRows?: SettlementPrizeCommitRow[] }
): string {
  if (specVersion >= SETTLEMENT_SPEC_VERSION_WINNER_COUNT) {
    const rows = input.prizeCommitRows;
    if (!rows?.length) throw new Error('prizeCommitRows required for settlement spec v19+');
    return settlementCommitHashHexV19(drawId, specVersion, seedHex, merkleRootHex, rows);
  }
  if (specVersion >= SETTLEMENT_SPEC_VERSION_PRIZES) {
    const rows = input.prizeCommitRows;
    if (!rows?.length) throw new Error('prizeCommitRows required for settlement spec v18+');
    return settlementCommitHashHexV18(drawId, specVersion, seedHex, merkleRootHex, rows);
  }
  return settlementCommitHashHexV17(
    drawId,
    specVersion,
    seedHex,
    merkleRootHex,
    input.winnerTicketIds ?? []
  );
}

export function settlementCommitHashBytes(
  drawId: string,
  seedHex: string,
  merkleRootHex: string,
  input: { winnerTicketIds?: number[]; prizeCommitRows?: SettlementPrizeCommitRow[] },
  specVersion = SETTLEMENT_SPEC_VERSION_ON_CHAIN
): Uint8Array {
  const hex = settlementCommitHashHex(drawId, specVersion, seedHex, merkleRootHex, input);
  return Buffer.from(hex, 'hex');
}

/** Build commit rows from DB/export prize lines (human gift_amount). */
export function buildPrizeCommitRowsFromExport(
  rows: Array<{
    ticket_id: number;
    prize_bucket: string;
    rank: number;
    gift_amount: number | null;
  }>
): SettlementPrizeCommitRow[] {
  const out: SettlementPrizeCommitRow[] = [];
  for (const row of rows) {
    const bucket = row.prize_bucket as PrizeBucketCommit;
    if (!['main_gift', 'main_ticket', 'jackpot_gift'].includes(bucket)) continue;
    const giftMicro = bucket === 'main_ticket' ? 0n : giftAmountToMicro(row.gift_amount ?? 0);
    out.push({
      ticketId: row.ticket_id,
      prizeBucket: bucket,
      rank: row.rank,
      giftAmountMicro: giftMicro.toString(),
    });
  }
  return sortPrizeCommitRows(out);
}
