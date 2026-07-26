import { createHash } from 'crypto';
import { giftAmountToMicro } from './gift-amount-micro.js';

/** Spec before prize-level settlement_hash (winner ticket ids only). */
export const SETTLEMENT_SPEC_VERSION_LEGACY = 17;

/** Prize-level commit: ticket_id, bucket, rank, gift_amount_micro per row. */
export const SETTLEMENT_SPEC_VERSION_PRIZES = 18;

/** v19: prize-level commit + winner_count bound into hash. */
export const SETTLEMENT_SPEC_VERSION_WINNER_COUNT = 19;

export type PrizeBucketCommit = 'main_gift' | 'main_ticket' | 'jackpot_gift';

export type SettlementPrizeCommitRow = {
  ticketId: number;
  prizeBucket: PrizeBucketCommit;
  rank: number;
  /** u64 string; 0 for main_ticket (no GIFT payout). */
  giftAmountMicro: string;
};

const VALID_BUCKETS = new Set<PrizeBucketCommit>(['main_gift', 'main_ticket', 'jackpot_gift']);

function parseBucket(raw: unknown): PrizeBucketCommit | null {
  const b = String(raw || '').trim() as PrizeBucketCommit;
  return VALID_BUCKETS.has(b) ? b : null;
}

export function sortPrizeCommitRows(rows: SettlementPrizeCommitRow[]): SettlementPrizeCommitRow[] {
  return [...rows].sort((a, b) => {
    if (a.ticketId !== b.ticketId) return a.ticketId - b.ticketId;
    if (a.prizeBucket !== b.prizeBucket) return a.prizeBucket.localeCompare(b.prizeBucket);
    return a.rank - b.rank;
  });
}

/** Canonical body hashed for spec v18 commit. */
export function canonicalPrizeCommitBody(rows: SettlementPrizeCommitRow[]): string {
  return sortPrizeCommitRows(rows)
    .map((r) => `${r.ticketId}:${r.prizeBucket}:${r.rank}:${r.giftAmountMicro}`)
    .join('\n');
}

export function buildPrizeCommitRowsFromInserts(
  rows: Array<Record<string, unknown>>
): SettlementPrizeCommitRow[] {
  const out: SettlementPrizeCommitRow[] = [];
  for (const row of rows) {
    const ticketId = Number(row.ticket_id);
    const bucket = parseBucket(row.prize_bucket);
    const rank = Number(row.rank);
    if (!Number.isFinite(ticketId) || ticketId <= 0 || !bucket || !Number.isFinite(rank) || rank <= 0) {
      continue;
    }
    const giftMicro =
      bucket === 'main_ticket'
        ? 0n
        : giftAmountToMicro(
            row.gift_amount != null && Number.isFinite(Number(row.gift_amount))
              ? Number(row.gift_amount)
              : 0
          );
    out.push({
      ticketId,
      prizeBucket: bucket,
      rank,
      giftAmountMicro: giftMicro.toString(),
    });
  }
  return sortPrizeCommitRows(out);
}

export function buildPrizeCommitRowsFromDb(
  rows: Array<{
    ticket_id?: number | null;
    prize_bucket?: string | null;
    rank?: number | null;
    gift_amount?: number | string | null;
  }>
): SettlementPrizeCommitRow[] {
  return buildPrizeCommitRowsFromInserts(rows as Array<Record<string, unknown>>);
}

export function settlementCommitHashHexV17(
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

export function settlementCommitHashHexV18(
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
 * v19: prize rows + winner_count (distinct ticket IDs) explicitly bound into hash.
 * Cryptographically ties the on-chain DrawCommit.winner_count to the prize set,
 * preventing a mismatched winner_count from being committed with a valid hash.
 */
export function settlementCommitHashHexV19(
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

export function settlementCommitHashHex(
  drawId: string,
  specVersion: number,
  seedHex: string,
  merkleRootHex: string,
  input: { winnerTicketIds?: number[]; prizeCommitRows?: SettlementPrizeCommitRow[] }
): string {
  if (specVersion >= SETTLEMENT_SPEC_VERSION_WINNER_COUNT) {
    const rows = input.prizeCommitRows;
    if (!rows?.length) {
      throw new Error('prizeCommitRows required for settlement spec v19+');
    }
    return settlementCommitHashHexV19(drawId, specVersion, seedHex, merkleRootHex, rows);
  }
  if (specVersion >= SETTLEMENT_SPEC_VERSION_PRIZES) {
    const rows = input.prizeCommitRows;
    if (!rows?.length) {
      throw new Error('prizeCommitRows required for settlement spec v18+');
    }
    return settlementCommitHashHexV18(drawId, specVersion, seedHex, merkleRootHex, rows);
  }
  const ids = input.winnerTicketIds ?? [];
  return settlementCommitHashHexV17(drawId, specVersion, seedHex, merkleRootHex, ids);
}

export function settlementCommitHashBytes(
  drawId: string,
  specVersion: number,
  seedHex: string,
  merkleRootHex: string,
  input: { winnerTicketIds?: number[]; prizeCommitRows?: SettlementPrizeCommitRow[] }
): Buffer {
  return Buffer.from(
    settlementCommitHashHex(drawId, specVersion, seedHex, merkleRootHex, input),
    'hex'
  );
}

/** Compare DB prize row to canonical commit row. */
export function dbPrizeRowMatchesCommit(
  db: {
    ticket_id?: number | null;
    prize_bucket?: string | null;
    rank?: number | null;
    gift_amount?: number | string | null;
  },
  commit: SettlementPrizeCommitRow
): boolean {
  const built = buildPrizeCommitRowsFromDb([db]);
  const one = built[0];
  if (!one) return false;
  return (
    one.ticketId === commit.ticketId &&
    one.prizeBucket === commit.prizeBucket &&
    one.rank === commit.rank &&
    one.giftAmountMicro === commit.giftAmountMicro
  );
}

/** Find commit row matching a DB prize row (by ticket, bucket, rank). */
export function findCommitRowForDbPrize(
  commitRows: SettlementPrizeCommitRow[],
  db: {
    ticket_id?: number | null;
    prize_bucket?: string | null;
    rank?: number | null;
    gift_amount?: number | string | null;
  }
): SettlementPrizeCommitRow | null {
  const built = buildPrizeCommitRowsFromDb([db]);
  const want = built[0];
  if (!want) return null;
  return (
    commitRows.find(
      (c) =>
        c.ticketId === want.ticketId &&
        c.prizeBucket === want.prizeBucket &&
        c.rank === want.rank &&
        c.giftAmountMicro === want.giftAmountMicro
    ) ?? null
  );
}
