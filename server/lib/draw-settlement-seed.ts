import { createHash } from 'crypto';

export const JACKPOT_HIT_N = 30;
/** 0..29 inclusive; exactly one value triggers hit for 1/30. */
export const JACKPOT_HIT_VALUE = 0;

/**
 * Computes the entrant list commitment: SHA-256 of sorted ticket IDs joined by commas.
 *
 * NOTE: Despite the name inherited from on-chain field naming, this is NOT a binary Merkle tree.
 * It is a flat hash of the full sorted ID list (e.g. "1,2,5,10"). There are no Merkle proofs
 * for individual membership — the full list must be published to verify any entry.
 * The on-chain DrawSeed stores this value as `merkle_root` for backward compatibility.
 */
export function merkleRootFromTicketIds(sortedTicketIds: number[]): string {
  const payload = sortedTicketIds.join(',');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function settlementSeedHex(
  drawId: string,
  periodEndIso: string,
  sortedTicketIds: number[]
): string {
  const merkleRoot = merkleRootFromTicketIds(sortedTicketIds);
  return createHash('sha256')
    .update(drawId, 'utf8')
    .update('|', 'utf8')
    .update(periodEndIso, 'utf8')
    .update('|', 'utf8')
    .update(merkleRoot, 'utf8')
    .digest('hex');
}

/** First PRNG draw used for jackpot (counter 0) — same as `SeedPrng` in draw-settlement. */
export function jackpotRollFromSeedHex(seedHex: string): number {
  const seedBuf = Buffer.from(seedHex, 'hex');
  const h = createHash('sha256')
    .update(seedBuf)
    .update(Buffer.from('|0|'))
    .digest();
  return h.readUInt32BE(0) % JACKPOT_HIT_N;
}

export function jackpotHitFromRoll(roll: number): boolean {
  return roll === JACKPOT_HIT_VALUE;
}

export function previewJackpotFromTicketIds(
  drawId: string,
  periodEndIso: string,
  ticketIds: number[]
): {
  sortedTicketIds: number[];
  merkleRootHex: string;
  seedHex: string;
  roll: number;
  hit: boolean;
  hitN: number;
} {
  const sortedTicketIds = [...ticketIds].sort((a, b) => a - b);
  const merkleRootHex = merkleRootFromTicketIds(sortedTicketIds);
  const seedHex = settlementSeedHex(drawId, periodEndIso, sortedTicketIds);
  const roll = jackpotRollFromSeedHex(seedHex);
  return {
    sortedTicketIds,
    merkleRootHex,
    seedHex,
    roll,
    hit: jackpotHitFromRoll(roll),
    hitN: JACKPOT_HIT_N,
  };
}
