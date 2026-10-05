import {
  settlementCommitHashHex,
  type SettlementPrizeCommitRow,
  SETTLEMENT_SPEC_VERSION_PRIZES,
} from './settlement-hash';
import { SETTLEMENT_SPEC_VERSION_ON_CHAIN } from './program-id';

export function verifySettlementCommitHash(params: {
  drawId: string;
  seedHex: string;
  merkleRootHex: string;
  onChainHashHex: string;
  specVersion?: number;
  winnerTicketIds?: number[];
  prizeCommitRows?: SettlementPrizeCommitRow[];
}): boolean {
  const spec = params.specVersion ?? SETTLEMENT_SPEC_VERSION_ON_CHAIN;
  const input =
    spec >= SETTLEMENT_SPEC_VERSION_PRIZES
      ? { prizeCommitRows: params.prizeCommitRows ?? [] }
      : { winnerTicketIds: params.winnerTicketIds ?? [] };
  const expected = settlementCommitHashHex(
    params.drawId,
    spec,
    params.seedHex,
    params.merkleRootHex,
    input
  );
  return expected.toLowerCase() === params.onChainHashHex.trim().toLowerCase();
}
